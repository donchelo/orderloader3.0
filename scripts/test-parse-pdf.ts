/**
 * Test rápido: parsea un PDF con el prompt de un cliente específico.
 * Uso: npx tsx scripts/test-parse-pdf.ts <ruta-al-pdf> <nombre-cliente>
 * Ejemplo: npx tsx scripts/test-parse-pdf.ts /ruta/EU-26-0248.pdf Eurocorsett
 */

import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { PROMPT_COMODIN, PROMPT_EXITO, PROMPT_HERMECO, PROMPT_EUROCORSETT, PROMPT_INDUSTRIASCORY, PROMPT_ESTUDIOMODA, PROMPT_PINTURAS_PRIME, PROMPT_MANUTEX, PROMPT_ELGLOBO, PROMPT_SERVICIO_COMPLETO, PROMPT_ICVO, PROMPT_PRODUEMPAK } from "../lib/prompts";

const PROMPTS: Record<string, string> = {
  Comodin:          PROMPT_COMODIN,
  Exito:            PROMPT_EXITO,
  Hermeco:          PROMPT_HERMECO,
  Eurocorsett:      PROMPT_EUROCORSETT,
  IndustriasCory:   PROMPT_INDUSTRIASCORY,
  EstudioModa:      PROMPT_ESTUDIOMODA,
  PinturasPrime:    PROMPT_PINTURAS_PRIME,
  Manutex:          PROMPT_MANUTEX,
  ElGlobo:          PROMPT_ELGLOBO,
  ServicioCompleto: PROMPT_SERVICIO_COMPLETO,
  ICVO:             PROMPT_ICVO,
  Produempak:       PROMPT_PRODUEMPAK,
};

async function main() {
  const [, , pdfArg, clienteArg] = process.argv;

  if (!pdfArg || !clienteArg) {
    console.error("Uso: npx tsx scripts/test-parse-pdf.ts <ruta-pdf> <cliente>");
    console.error("Clientes disponibles:", Object.keys(PROMPTS).join(", "));
    process.exit(1);
  }

  const pdfPath = path.resolve(pdfArg);
  if (!fs.existsSync(pdfPath)) {
    console.error("No se encontró el archivo:", pdfPath);
    process.exit(1);
  }

  const prompt = PROMPTS[clienteArg];
  if (!prompt) {
    console.error("Cliente desconocido:", clienteArg);
    console.error("Disponibles:", Object.keys(PROMPTS).join(", "));
    process.exit(1);
  }

  console.log(`\nParsando: ${path.basename(pdfPath)}`);
  console.log(`Cliente:  ${clienteArg}\n`);

  const pdfParseFn = require("pdf-parse/lib/pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;
  const buffer = fs.readFileSync(pdfPath);
  const { text } = await pdfParseFn(buffer);

  console.log("--- TEXTO EXTRAÍDO DEL PDF ---");
  console.log(text.slice(0, 800));
  console.log("...\n");

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Falta ANTHROPIC_API_KEY en el entorno");
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    temperature: 0,
    system: prompt,
    messages: [{ role: "user", content: text }],
  });

  const raw = msg.content[0].type === "text" ? msg.content[0].text.trim() : "";
  const clean = raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();

  console.log("--- RESULTADO JSON ---");
  try {
    const parsed = JSON.parse(clean);
    console.log(JSON.stringify(parsed, null, 2));

    const outPath = pdfPath.replace(/\.pdf$/i, "_test_resultado.json");
    fs.writeFileSync(outPath, JSON.stringify(parsed, null, 2));
    console.log(`\nGuardado en: ${outPath}`);
  } catch {
    console.error("Error parseando JSON. Respuesta cruda:");
    console.log(raw);
  }

  console.log(`\nTokens usados — input: ${msg.usage.input_tokens}, output: ${msg.usage.output_tokens}`);
}

main().catch(console.error);
