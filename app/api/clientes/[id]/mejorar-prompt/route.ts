import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getDb, getClienteById } from "@/lib/db";
import { withAnthropicRetry } from "@/lib/anthropic-retry";

export const maxDuration = 60;

const IMPROVEMENT_PROMPT = `You are an expert prompt engineer specializing in document data extraction systems.

You will receive:
1. An existing extraction prompt that instructs an AI to parse purchase order PDFs and return JSON for SAP B1.
2. A set of correction notes written by the operator after observing real errors or missing rules.

Your task: rewrite the extraction prompt incorporating ALL the corrections described in the notes.

Rules you MUST follow:
- Preserve the complete structure, section headings, field mapping table, validation checklist, and overall format of the original prompt.
- Preserve every rule that the notes do not explicitly contradict or supersede.
- Translate the notes into precise, unambiguous instructions placed in the most logical section of the prompt.
- If a note adds a new field-name alias, add it to the relevant DATA EXTRACTION step and the FIELD MAPPING table.
- If a note corrects a number format rule or adds a cross-validation example, update section 3 (DATA TRANSFORMATION) in place.
- If a note describes a structural edge case (e.g. duplicate lines, multi-page headers), add a clearly labelled sub-rule in the EXTRACTION PROCESS section.
- Do NOT add sections that were not present in the original unless absolutely necessary for clarity.
- Do NOT change the CardCode value, DocType constant, or any fixed values unless explicitly instructed in the notes.
- Do NOT include markdown fences, preamble, or commentary in your response.
- Your response must be ONLY the complete rewritten prompt — nothing else.`;

const MODELS_FALLBACK = ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"];

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    const db = getDb();
    const existing = getClienteById(db, Number(id));
    if (!existing) return NextResponse.json({ ok: false, error: "Cliente no encontrado" }, { status: 404 });

    const body = await req.json() as { prompt?: string; notes?: string };
    if (!body.prompt?.trim() || !body.notes?.trim()) {
      return NextResponse.json({ ok: false, error: "Se requieren prompt y notas" }, { status: 400 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY no configurado" }, { status: 500 });

    const client = new Anthropic({ apiKey });

    const userMessage = `<original_prompt>\n${body.prompt}\n</original_prompt>\n\n<correction_notes>\n${body.notes}\n</correction_notes>`;

    let msg: Anthropic.Message | null = null;
    let lastError: unknown = null;

    for (const model of MODELS_FALLBACK) {
      try {
        msg = await withAnthropicRetry(() => client.messages.create({
          model,
          max_tokens: 8192,
          temperature: 0,
          system: IMPROVEMENT_PROMPT,
          messages: [{ role: "user", content: userMessage }],
        }));
        console.log(`[mejorar-prompt] Modelo usado: ${model}`);
        break;
      } catch (e) {
        if (e instanceof Anthropic.APIError && e.status === 529) {
          console.warn(`[mejorar-prompt] ${model} saturado (529), probando siguiente modelo...`);
          lastError = e;
          continue;
        }
        lastError = e;
        break;
      }
    }

    if (!msg) {
      if (lastError instanceof Anthropic.APIError && lastError.status === 529) {
        return NextResponse.json(
          { ok: false, error: "Todos los modelos de IA están saturados en este momento. Intentá en unos minutos." },
          { status: 503 }
        );
      }
      if (lastError instanceof Anthropic.APIError) {
        return NextResponse.json(
          { ok: false, error: `Error de la API de IA (${lastError.status}): ${lastError.message}` },
          { status: 502 }
        );
      }
      throw lastError;
    }

    const improved = msg.content[0].type === "text" ? msg.content[0].text.trim() : "";
    if (!improved) {
      return NextResponse.json({ ok: false, error: "El modelo no devolvió un prompt mejorado." }, { status: 500 });
    }

    return NextResponse.json({ ok: true, improved_prompt: improved });
  } catch (e) {
    console.error("[mejorar-prompt] Error inesperado:", e);
    return NextResponse.json({ ok: false, error: `Error inesperado: ${String(e)}` }, { status: 500 });
  }
}
