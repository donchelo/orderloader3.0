/**
 * Test de extracción AI sobre PDFs de FlexoImpresos.
 * Corre: npx tsx scratch/test-flexo-extraction.ts
 */

import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { pdfToImages, buildVisionContent } from "../lib/pdf-vision";
import { SapB1OrderSchema } from "../lib/schemas";
// API key inyectada via variable de entorno al correr el script

// ---------- Función makePrompt (copiada de clientes-seed-flexo.ts) ----------
function makePrompt(cardCode: string, nombreCliente: string): string {
  return `# PURCHASE ORDER EXTRACTION AGENT — FLEXO IMPRESOS

## ROLE
You are a Purchase Order Analyzer specialized in extracting structured information from purchase documents directed to FLEXO IMPRESOS S.A.S. (NIT 900528680) and converting it to JSON format with absolute precision.

## OBJECTIVE
Analyze the provided purchase order document from ${nombreCliente} and generate a JSON object following the SAP B1 schema exactly.

## EXTRACTION PROCESS

### 1. INITIAL ANALYSIS
* Examine the purchase order document completely
* Identify and count the total number of unique items/products
* Mentally record this for validation

### 2. DATA EXTRACTION
* **Order number (NumAtCard)**: The client's purchase order number as printed — copy it exactly, including any prefixes (OC, OCN, OR, OP, ORCOM, etc.)
* **Document date (DocDate)**: Always use today's processing date in YYYYMMDD format (NOT from the document)
* **Due date (DocDueDate)**: The requested delivery date from the document. If not found, use DocDate + 15 days.
* **Tax date (TaxDate)**: The document creation date printed on the PDF, in YYYYMMDD format. If not found, use DocDate.
* **Observations (Comments)**: Copy verbatim any text in "Observaciones", "Comentarios", "Notas", or similar sections. Use "" if none.
* **Items**: For each product line in the SAME ORDER as they appear:
  * Code (SupplierCatNum): The item/article code or reference as printed. Remove leading zeros.
  * Quantity (Quantity): Integer number of units requested.
  * Unit price (UnitPrice): Price per unit as printed in the document.
  * Line delivery date (DeliveryDate): Specific delivery date for this line in YYYYMMDD. If absent, use DocDueDate.
  * Line notes (FreeText): Any description, color, size, or special instructions for this line. Use "" if none.

### 3. MANDATORY TRANSFORMATIONS

**CardCode**: Always use "${cardCode}" regardless of any value in the document.

**Dates**: Convert ALL dates to YYYYMMDD format.
* "13/05/2026" → "20260513"
* "9/05/2026" → "20260509"
* "2026/04/21" → "20260421"
* "30/01/2026" → "20260130"

**Numbers — CRITICAL (Colombian format)**:
* Dot "." = thousands separator (NEVER decimal)
* Comma "," = decimal separator
* "1.260.000" → 1260000
* "504,00" → 504.00
* "1.260,50" → 1260.50
* "2.500" → 2500 (NOT 2.5)
* Quantities: always integers (2500, not 2500.00)

**SupplierCatNum**: Remove leading zeros ("00021446" → "21446"). If only a description exists (no code), use the first 20 characters of the description.

### 4. OUTPUT FORMAT
Return ONLY the JSON object, no explanations:

\`\`\`json
{
  "DocType": "dDocument_Items",
  "NumAtCard": "<OC number exactly as printed>",
  "CardCode": "${cardCode}",
  "DocDate": "<today YYYYMMDD>",
  "DocDueDate": "<delivery date YYYYMMDD>",
  "TaxDate": "<document date YYYYMMDD>",
  "Comments": "<observations or empty string>",
  "DocumentLines": [
    {
      "SupplierCatNum": "<item code>",
      "Quantity": <integer>,
      "UnitPrice": <decimal>,
      "DeliveryDate": "<YYYYMMDD>",
      "FreeText": "<line description or empty string>"
    }
  ]
}
\`\`\`

### 5. VALIDATION
Before outputting, verify:
* Number of lines matches the document
* All dates are in YYYYMMDD format
* CardCode is exactly "${cardCode}"
* All quantities are positive integers
* NumAtCard is present and non-empty`;
}

// ---------- Casos de prueba ----------
const BASE_LIST = "/home/ai_tamaprint/Software/clients/AI4U/experiments/orderloader/scratch/flexoimpresos-oc/listadeclientesconpdfflexoimpresos";
const BASE_RELIST = "/home/ai_tamaprint/Software/clients/AI4U/experiments/orderloader/scratch/flexoimpresos-oc/relistadeclientesconpdfflexoimpresos";

interface TestCase {
  label: string;
  pdfPath: string;
  cardCode: string;
  nombreCliente: string;
}

const TESTS: TestCase[] = [
  {
    label: "1. CLINICA CARDIO VID",
    pdfPath: path.join(BASE_LIST, "03-189466 (CLINICA CARDIO VID).PDF"),
    cardCode: "C811046900",
    nombreCliente: "CLINICA CARDIO VID",
  },
  {
    label: "2. CARNICOS Y ALIMENTOS S.A.S.",
    pdfPath: path.join(BASE_LIST, "13_001OC19714_952026_093941 (CARNICOS Y ALIMENTOS S.A.S.).pdf"),
    cardCode: "C900134841",
    nombreCliente: "CARNICOS Y ALIMENTOS S.A.S.",
  },
  {
    label: "3. AUTECO MOBILITY S.A.S.",
    pdfPath: path.join(BASE_LIST, "OC FLEXO IMPRESOS 4700112434 (AUTECO MOBILITY S.A.S.).pdf"),
    cardCode: "C901249413",
    nombreCliente: "AUTECO MOBILITY S.A.S.",
  },
  {
    label: "4. GROUPE SEB COLOMBIA S.A.",
    pdfPath: path.join(BASE_LIST, "GROUPE SEB - OC 9850230662, CONFIRMAR FECHA DE ENT (GROUPE SEB COLOMBIA S.A.).pdf"),
    cardCode: "C890900307",
    nombreCliente: "GROUPE SEB COLOMBIA S.A.",
  },
  {
    label: "5. SUN CHEMICAL COLOMBIA S.A.S.",
    pdfPath: path.join(BASE_RELIST, "4320536155 (SUN CHEMICAL COLOMBIA S.A.S.).pdf"),
    cardCode: "C890908649",
    nombreCliente: "SUN CHEMICAL COLOMBIA S.A.S.",
  },
];

// ---------- Utilidades de parsing ----------
function extractJson(text: string): string | null {
  // Try fenced code block first
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  // Try bare JSON object
  const bare = text.match(/\{[\s\S]*\}/);
  if (bare) return bare[0].trim();
  return null;
}

// ---------- Main ----------
async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ERROR: ANTHROPIC_API_KEY no encontrado en .env");
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });

  const results: Array<{
    label: string;
    success: boolean;
    numAtCard?: string;
    cardCode?: string;
    lineCount?: number;
    firstItem?: { SupplierCatNum: string; Quantity: number; UnitPrice?: number };
    validSchema: boolean;
    schemaErrors?: string[];
    error?: string;
    rawResponse?: string;
  }> = [];

  for (const tc of TESTS) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Procesando: ${tc.label}`);
    console.log(`PDF: ${tc.pdfPath}`);

    try {
      // 1. Leer PDF
      if (!fs.existsSync(tc.pdfPath)) {
        throw new Error(`Archivo no encontrado: ${tc.pdfPath}`);
      }
      const pdfBuffer = fs.readFileSync(tc.pdfPath);
      console.log(`  PDF leído: ${(pdfBuffer.length / 1024).toFixed(0)} KB`);

      // 2. Convertir a imágenes
      const { pages, pageCount } = await pdfToImages(pdfBuffer, 150);
      console.log(`  Páginas renderizadas: ${pageCount}`);

      // 3. Construir content (imágenes + texto del prompt)
      const imageBlocks = buildVisionContent(pages);
      const prompt = makePrompt(tc.cardCode, tc.nombreCliente);

      // 4. Llamar a Anthropic
      console.log(`  Llamando a Anthropic (claude-opus-4-5)...`);
      const response = await client.messages.create({
        model: "claude-opus-4-5",
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: [
              ...imageBlocks,
              { type: "text", text: prompt },
            ],
          },
        ],
      });

      const rawText = response.content
        .filter(b => b.type === "text")
        .map(b => (b as { type: "text"; text: string }).text)
        .join("\n");

      console.log(`  Tokens usados: input=${response.usage.input_tokens}, output=${response.usage.output_tokens}`);

      // 5. Parsear JSON
      const jsonStr = extractJson(rawText);
      if (!jsonStr) {
        throw new Error(`No se encontró JSON en la respuesta:\n${rawText.slice(0, 500)}`);
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(jsonStr);
      } catch (e) {
        throw new Error(`JSON inválido: ${(e as Error).message}\nTexto: ${jsonStr.slice(0, 500)}`);
      }

      // 6. Validar con Zod
      const zodResult = SapB1OrderSchema.safeParse(parsed);
      const schemaErrors: string[] = [];
      if (!zodResult.success) {
        zodResult.error.errors.forEach(e => {
          schemaErrors.push(`${e.path.join(".")}: ${e.message}`);
        });
      }

      const lines = (parsed.DocumentLines as unknown[]) || [];
      const firstLine = lines[0] as { SupplierCatNum: string; Quantity: number; UnitPrice?: number } | undefined;

      const result = {
        label: tc.label,
        success: true,
        numAtCard: parsed.NumAtCard as string,
        cardCode: parsed.CardCode as string,
        lineCount: lines.length,
        firstItem: firstLine,
        validSchema: zodResult.success,
        schemaErrors: schemaErrors.length ? schemaErrors : undefined,
        rawResponse: rawText,
      };

      results.push(result);

      // Mostrar resumen
      console.log(`\n  --- RESULTADO ---`);
      console.log(`  NumAtCard  : ${result.numAtCard}`);
      console.log(`  CardCode   : ${result.cardCode}`);
      console.log(`  Líneas     : ${result.lineCount}`);
      if (firstLine) {
        console.log(`  Primer ítem: SupplierCatNum=${firstLine.SupplierCatNum} | Qty=${firstLine.Quantity} | UnitPrice=${firstLine.UnitPrice}`);
      }
      console.log(`  Schema OK  : ${result.validSchema}`);
      if (schemaErrors.length) {
        console.log(`  Errores Zod: ${schemaErrors.join("; ")}`);
      }

    } catch (err) {
      const errMsg = (err as Error).message;
      console.error(`  ERROR: ${errMsg}`);
      results.push({
        label: tc.label,
        success: false,
        validSchema: false,
        error: errMsg,
      });
    }
  }

  // ---------- Veredicto final ----------
  console.log(`\n${"=".repeat(60)}`);
  console.log("VEREDICTO FINAL");
  console.log("=".repeat(60));

  const successful = results.filter(r => r.success);
  const schemaValid = results.filter(r => r.validSchema);
  const failed = results.filter(r => !r.success);

  console.log(`\nResumen: ${successful.length}/${results.length} extracciones exitosas, ${schemaValid.length}/${results.length} con schema válido\n`);

  for (const r of results) {
    const statusIcon = r.success ? (r.validSchema ? "✓" : "~") : "✗";
    console.log(`[${statusIcon}] ${r.label}`);
    if (r.success) {
      console.log(`    NumAtCard=${r.numAtCard} | Lines=${r.lineCount} | SchemaOK=${r.validSchema}`);
      if (r.schemaErrors?.length) {
        console.log(`    Schema errors: ${r.schemaErrors.join(" | ")}`);
      }
    } else {
      console.log(`    FALLO: ${r.error?.slice(0, 200)}`);
    }
  }

  // Análisis de problemas
  console.log("\n--- Análisis ---");
  const withSchemaErrors = results.filter(r => r.success && !r.validSchema);
  if (withSchemaErrors.length === 0 && failed.length === 0) {
    console.log("Todo OK: el prompt genérico funciona correctamente para todos los PDFs probados.");
  } else {
    if (failed.length) {
      console.log(`FALLOS TOTALES (${failed.length}):`);
      failed.forEach(r => console.log(`  - ${r.label}: ${r.error?.slice(0, 150)}`));
    }
    if (withSchemaErrors.length) {
      console.log(`\nExtracciones con errores de schema (${withSchemaErrors.length}):`);
      withSchemaErrors.forEach(r => {
        console.log(`  - ${r.label}:`);
        r.schemaErrors?.forEach(e => console.log(`    · ${e}`));
      });
    }
    console.log("\nSugerencias de ajuste al prompt:");
    const allErrors = results.flatMap(r => r.schemaErrors || []);
    if (allErrors.some(e => e.includes("SupplierCatNum"))) {
      console.log("  · SupplierCatNum: verificar casos sin código de artículo explícito");
    }
    if (allErrors.some(e => e.includes("Quantity"))) {
      console.log("  · Quantity: revisar parsing de números con formato colombiano");
    }
    if (allErrors.some(e => e.includes("Date"))) {
      console.log("  · Fechas: revisar conversión de formatos de fecha");
    }
  }
}

main().catch(err => {
  console.error("ERROR FATAL:", err);
  process.exit(1);
});
