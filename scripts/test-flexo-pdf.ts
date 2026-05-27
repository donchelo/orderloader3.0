/**
 * Test de parsing para un PDF de FlexoImpresos usando el prompt de la BD.
 * Uso: npx tsx scripts/test-flexo-pdf.ts <ruta-pdf> <carpeta-cliente>
 */
import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { getDb, getClientes } from "../lib/db";
import { pdfToImages, buildVisionContent } from "../lib/pdf-vision";

async function main() {
  const [, , pdfArg, carpetaArg] = process.argv;
  if (!pdfArg || !carpetaArg) {
    console.error("Uso: npx tsx scripts/test-flexo-pdf.ts <ruta-pdf> <carpeta>");
    process.exit(1);
  }

  const db = getDb();
  const clientes = getClientes(db);
  const cliente = clientes.find(c => c.carpeta === carpetaArg);
  if (!cliente) {
    console.error("Cliente no encontrado:", carpetaArg);
    console.log("Disponibles:", clientes.map(c => c.carpeta).join(", "));
    process.exit(1);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error("Falta ANTHROPIC_API_KEY"); process.exit(1); }

  const buffer = fs.readFileSync(path.resolve(pdfArg));
  console.log(`\nParsando: ${path.basename(pdfArg)}`);
  console.log(`Cliente:  ${cliente.nombre} (${carpetaArg})\n`);

  const { pages } = await pdfToImages(buffer);
  const visionContent = buildVisionContent(pages);
  console.log(`  ${pages.length} página(s)\n`);

  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    temperature: 0,
    system: cliente.prompt,
    messages: [{ role: "user", content: visionContent }],
  });

  const raw = msg.content[0].type === "text" ? msg.content[0].text.trim() : "";
  const clean = raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();

  try {
    const parsed = JSON.parse(clean);
    console.log(JSON.stringify(parsed, null, 2));
    const outPath = path.resolve(pdfArg).replace(/\.pdf$/i, "_flexo_test.json");
    fs.writeFileSync(outPath, JSON.stringify(parsed, null, 2));
    console.log(`\nGuardado: ${outPath}`);
  } catch {
    console.error("Error JSON. Crudo:");
    console.log(raw);
  }
  console.log(`\nTokens — input: ${msg.usage.input_tokens}, output: ${msg.usage.output_tokens}`);
}

main().catch(console.error);
