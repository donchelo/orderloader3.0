import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getDb, getClienteByNit } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { detectClientFromPdf, loadClientListsFromDb } from "@/lib/pdf-classify";
import { pdfToImages, buildVisionContent } from "@/lib/pdf-vision";
import { withAnthropicRetry } from "@/lib/anthropic-retry";

function buildMetaPrompt(companyName: string, cardCodePrefix: string): string {
  return `You are an expert at creating purchase order extraction prompts for Claude AI.

Analyze the provided purchase order PDF from a Colombian company (supplier of ${companyName}, a Colombian printing company).

Extract the following information and generate a complete client configuration.

Return ONLY valid JSON in this exact format — no explanations, no markdown:
{
  "company_name": "Full company name as printed in the document",
  "carpeta": "PascalCase identifier (no spaces, no accents, e.g. NuevoCliente)",
  "nit": "Tax ID digits only, no dots, no verification digit (e.g. 800069933)",
  "keywords": ["3-6 unique identifiers: brand names, domain names, NIT with dots variant"],
  "number_format": "colombian or american",
  "card_code": "${cardCodePrefix} followed by the NIT (e.g. ${cardCodePrefix}800069933)",
  "prompt": "Complete extraction prompt — see template below"
}

NUMBER FORMAT GUIDE:
- "colombian": dot = thousands separator (never decimal), comma = decimal separator. Example: "1.321" → 1321, "1.321,50" → 1321.50
- "american": comma = thousands separator, dot = decimal separator. Example: "1,321" → 1321, "1,321.50" → 1321.50

For the "prompt" field, generate a complete extraction prompt following this exact template structure,
adapted to the specific field names, column headers, and formatting conventions of THIS document:

---TEMPLATE START---
# PURCHASE ORDER EXTRACTION AGENT

## ROLE
You are a Purchase Order Analyzer specialized in extracting structured information from purchase documents and converting it to JSON format with absolute precision.

## OBJECTIVE
Analyze the provided purchase order document and generate a JSON object that faithfully replicates all contained information, following the defined schema without errors or omissions.

## EXTRACTION PROCESS

### 1. INITIAL ANALYSIS
* Completely examine the purchase order document
* Identify and count the total number of unique items/products — DO NOT group or merge identical items
* Navigate to the last page to locate the summary totals
* Note the ORDER in which items appear — the output must preserve this exact order
* Mentally record item count for subsequent validation

### 2. DATA EXTRACTION
* **Order details**:
  * Order number (NumAtCard) → [IDENTIFY THE FIELD NAME IN THIS DOCUMENT] — extract as a plain string, number format rules do NOT apply to this field
  * General delivery date (DocDueDate) → [IDENTIFY THE FIELD NAME IN THIS DOCUMENT]
  * Document date (DocDate) → Today's date at time of processing (NOT from the document)
  * Tax date (TaxDate) → The emission/elaboration date printed on the PDF
  * Observations / remarks (Comments) → Verbatim text from observations section, "" if none
* **Individual items**: Extract in the SAME ORDER as they appear in the PDF — DO NOT group identical items:
  * Product code (SupplierCatNum) → [IDENTIFY THE COLUMN NAME IN THIS DOCUMENT]
  * Quantity (Quantity) → [IDENTIFY THE COLUMN NAME]
  * Unit price (UnitPrice) → [IDENTIFY THE COLUMN NAME]. Use 0 if not printed.
  * Line notes (FreeText) → verbatim descriptive text for this line, "" if none
  * Line delivery date (DeliveryDate) → line-specific date if present, otherwise DocDueDate. YYYYMMDD.

### 3. DATA TRANSFORMATION

**Dates**: Convert to YYYYMMDD format (e.g., March 25 2026 → "20260325")

**CardCode**: ALWAYS "[CARD_CODE_HERE]" — fixed, no exceptions

**DocType**: ALWAYS "dDocument_Items" — fixed constant

**DocDate**: ALWAYS today's processing date in YYYYMMDD (NOT any date from the document)

**[NUMBER FORMAT RULES — fill in ONE of the two blocks below based on the detected format, then delete the other]**

**IF COLOMBIAN FORMAT** (dot=thousands, comma=decimal):
* **Dot (.) = thousands separator ONLY — NEVER a decimal point in COP amounts**
  * "444.000" → 444000 (NOT 444.0) | "1.321" → 1321 (NOT 1.321, NOT 1.32)
* **Comma (,) = decimal separator**: "444.000,50" → 444000.50 | "222,00" → 222.00
* **CROSS-VALIDATION MANDATORY**: After extracting each line verify UnitPrice × Quantity ≈ Subtotal printed.
  If it does NOT match, you confused the Price column with the Subtotal column — re-read the document.
  Example: Qty=500, UnitPrice=444.000→444000, Subtotal=222.000.000→222000000. Check: 444000×500=222000000 ✓
  The Subtotal column is NEVER the price. If check fails, the price you extracted is wrong.

**IF AMERICAN FORMAT** (comma=thousands, dot=decimal):
* **Comma (,) = thousands separator**: "9,000" → 9000 | "2,016,000" → 2016000
* **Dot (.) = decimal separator**: "28.00" → 28 | "2,150.00" → 2150
* **CROSS-VALIDATION MANDATORY**: After extracting each line verify UnitPrice × Quantity ≈ Subtotal printed.
  If it does NOT match, you confused the Price column with the Subtotal column — re-read the document.
  The Subtotal column is NEVER the price. If check fails, the price you extracted is wrong.

**Missing fields**: Use empty string ""

### 4. FIELD MAPPING

| Source | JSON Field | Notes |
|--------|-----------|-------|
| Fixed constant | DocType | Always "dDocument_Items" |
| [order number field] | NumAtCard | Plain string — no number format rules |
| Fixed constant | CardCode | Always "[CARD_CODE_HERE]" |
| Today's date | DocDate | YYYYMMDD — NOT from document |
| [delivery date field] | DocDueDate | YYYYMMDD |
| [emission date field] | TaxDate | YYYYMMDD |
| [observations field] | Comments | Verbatim, "" if absent |
| [product code column] | DocumentLines[].SupplierCatNum | String, same order as PDF |
| [quantity column] | DocumentLines[].Quantity | Number |
| [unit price column] | DocumentLines[].UnitPrice | Decimal, 0 if absent |
| [delivery date column] | DocumentLines[].DeliveryDate | YYYYMMDD |

### 5. FINAL VALIDATION
Before generating the response, verify:
- ✅ DocType is exactly "dDocument_Items"
- ✅ CardCode is exactly "[CARD_CODE_HERE]"
- ✅ DocDate is today's processing date in YYYYMMDD (NOT from the document)
- ✅ All dates in YYYYMMDD format
- ✅ Numbers use correct format (no thousands separators, dot for decimal)
- ✅ UnitPrice × Quantity ≈ line subtotal for every row — if not, the price column is wrong
- ✅ DocumentLines preserves the same item order as the PDF — no grouping of identical items
- ✅ Valid JSON syntax — no trailing commas, no extra fields

## RESPONSE FORMAT
**CRITICAL**: Your response must contain ONLY the JSON object. No explanations, no comments, no markdown, no preamble.
---TEMPLATE END---

Fill in ALL placeholders [LIKE THIS] in the template based on what you see in this specific document.
Replace [CARD_CODE_HERE] with the actual card_code you identified.
In section 3: keep ONLY the number format block that matches this document (colombian or american), delete the other block entirely. Fill in with specific examples from THIS document.
The resulting prompt field must be complete, self-contained, and ready to use — no placeholders remaining.`;
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("pdf") as File | null;
    if (!file) return NextResponse.json({ ok: false, error: "Se requiere un archivo PDF" }, { status: 400 });
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      return NextResponse.json({ ok: false, error: "Solo se aceptan archivos PDF" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    // ── Extraer texto para detección de NIT ─────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParseFn = require("pdf-parse/lib/pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;
    let pdfText = "";
    try { pdfText = (await pdfParseFn(buffer)).text; } catch { /* continuar con texto vacío */ }

    const db = getDb();
    const { nits: clientNits, keywords: clientKeywords } = loadClientListsFromDb(db);

    // ── Verificar si ya existe el cliente por NIT ────────────────────────────
    const detectionResult = detectClientFromPdf(pdfText, clientNits, clientKeywords);
    if (detectionResult) {
      // Buscar en DB por carpeta
      const rows = db.prepare(
        "SELECT * FROM clientes_aprobados WHERE carpeta = ? AND activo = 1"
      ).all(detectionResult.carpeta) as Array<{ id: number; carpeta: string; nombre: string; nit_principal: string }>;

      if (rows.length > 0) {
        return NextResponse.json({
          ok: true,
          existente: {
            id:      rows[0].id,
            carpeta: rows[0].carpeta,
            nombre:  rows[0].nombre,
            nit:     rows[0].nit_principal,
            metodo:  detectionResult.metodo,
          },
        });
      }
    }

    // ── Nuevo cliente: analizar con IA ───────────────────────────────────────
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY no configurado" }, { status: 500 });

    const { pages } = await pdfToImages(buffer);
    // Para análisis de estructura basta con las primeras páginas — mandar todo el PDF
    // genera requests demasiado pesados que causan 529 (overloaded) en Anthropic.
    const visionContent = buildVisionContent(pages.slice(0, 4));

    const client = new Anthropic({ apiKey });
    const { tenantDisplayName, cardCodePrefix } = getConfig();
    const metaPrompt = buildMetaPrompt(tenantDisplayName, cardCodePrefix);

    // Intentar modelos en orden de preferencia — si uno está saturado (529), pasar al siguiente
    const MODELS_FALLBACK = ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"];

    let msg: Anthropic.Message | null = null;
    let lastError: unknown = null;
    for (const model of MODELS_FALLBACK) {
      try {
        msg = await withAnthropicRetry(() => client.messages.create({
          model,
          max_tokens: 8192,
          temperature: 0,
          system:   metaPrompt,
          messages: [{ role: "user", content: visionContent }],
        }));
        console.log(`[analizar-pdf] Modelo usado: ${model}`);
        break;
      } catch (e) {
        if (e instanceof Anthropic.APIError && e.status === 529) {
          console.warn(`[analizar-pdf] ${model} saturado (529), probando siguiente modelo...`);
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

    const raw   = msg.content[0].type === "text" ? msg.content[0].text.trim() : "";
    const clean = raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();

    let parsed: { company_name: string; carpeta: string; nit: string; keywords: string[]; number_format: string; card_code: string; prompt: string };
    try {
      parsed = JSON.parse(clean);
    } catch {
      console.error("[analizar-pdf] Respuesta inválida del modelo:", clean.slice(0, 300));
      return NextResponse.json(
        { ok: false, error: "El modelo devolvió una respuesta inválida. Intentá con otro PDF o volvé a intentarlo." },
        { status: 500 }
      );
    }

    // Verificar duplicado por NIT en DB
    const duplicate = getClienteByNit(db, parsed.nit);
    if (duplicate) {
      return NextResponse.json({
        ok: true,
        existente: {
          id:      duplicate.id,
          carpeta: duplicate.carpeta,
          nombre:  duplicate.nombre,
          nit:     duplicate.nit_principal,
          metodo:  "nit",
        },
      });
    }

    return NextResponse.json({
      ok:       true,
      propuesta: {
        company_name:  parsed.company_name,
        carpeta:       parsed.carpeta,
        nit:           parsed.nit,
        keywords:      parsed.keywords ?? [],
        number_format: parsed.number_format,
        card_code:     parsed.card_code,
        prompt:        parsed.prompt,
      },
    });
  } catch (e) {
    console.error("[analizar-pdf] Error inesperado:", e);
    return NextResponse.json({ ok: false, error: `Error inesperado: ${String(e)}` }, { status: 500 });
  }
}
