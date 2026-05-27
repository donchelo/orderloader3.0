/**
 * Genera prompts específicos por cliente de FlexoImpresos analizando un PDF real.
 *
 * Para cada PDF en scratch/flexoimpresos-oc/relistadeclientesconpdfflexoimpresos:
 *  - Convierte a imagen
 *  - Llama a Claude con un meta-prompt que pide un prompt de extracción específico
 *    siguiendo el patrón de los prompts de TamaPrint (con columnas reales del doc,
 *    formato numérico detectado, ejemplo de cross-validation, etc.)
 *  - Guarda el resultado en lib/flexo-prompts-generated.ts como Record<carpeta, prompt>
 */
import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { pdfToImages, buildVisionContent } from "../lib/pdf-vision";
import { getDb, getClientes } from "../lib/db";

const SCRATCH = "/home/ai_tamaprint/Software/clients/AI4U/experiments/orderloader/scratch/flexoimpresos-oc/relistadeclientesconpdfflexoimpresos";

// Mapeo manual: nombre de archivo → carpeta del cliente en DB
const PDF_TO_CARPETA: Record<string, string> = {
  "1_001OCN98954_ (NEW STETIC).pdf":                                  "NewStetic",
  "4320536155 (SUN CHEMICAL COLOMBIA S.A.S.).pdf":                    "SunChemical",
  "45007407 FLEXOIMPRESOS (MCM).pdf":                                 "McmCompany",
  "4503358220 (DORIA).pdf":                                           "Doria",
  "4503372688 (SETAS COLOMBIANAS S.A. SETAS S.A.).pdf":               "SetasColombianas",
  "70070735 (LABORATORIOS ECAR S.A).pdf":                             "LaboratoriosEcar",
  "986288 Cinta Promocional Gratis Este Producto - Flexo Impresos (YUPI).pdf": "Yupi",
  "O.C# 10451 FLEXOIMPRESOS (INDUSTRIAS FROTEX).pdf":                 "IndustriasFrotex",
  "OC 12322 FLEXOIMPRESO (INTERNACIONAL DE BELLEZA S.A.S.).pdf":      "InternacionalBelleza",
  "OC 12389 (INTERDOORS S.A.S).pdf":                                  "Interdoors",
  "OC 12820 FLEXO IMPRESOS (IMPROBELL SOCIEDAD POR ACCIONES SIMPLIFICADA).pdf": "Improbell",
  "OC- 251796- FUNDA KIA 30ML (POLIKEM S.A.S.).pdf":                  "Polikem",
  "OC 312- FLEXOIMPRESOS (KYMIA S.A.S).pdf":                          "Kymia",
  "OC C03 4500032777 FLEXO IMPRESOS S.A.S (MANE ANDINA S.A.S.).PDF":  "ManeAndina",
  "OC12787 FLEXO IMPRESOS (SAMARA COSMETICS S.A.S.).pdf":             "SamaraCosmetics",
  "OC2021 FLEXO IMPRESOS - FUNDAS TERMOGENICAS  (SOLUCIONES E INNOVACION EN ALIMENTOS COLOMBIA S.A.S.).pdf": "SolucionesInnovacion",
  "OC6494 FLEXO IMP (PLASTICOS Y CAUCHOS S.A. PLACA).pdf":            "Placa",
  "OC70813 (PRODIA S.A.S).pdf":                                       "Prodia",
  "OP 26000759 FLEXO (INCAMETAL S.A.S.).pdf":                         "Incametal",
  "OP 26000759 FLEXO (LANDERS Y CIA SAS).pdf":                        "LandersYCia",
  "ORCOM 9303 FLEXO IMPRESO (SELLO GLOBAL SAS).pdf":                  "SelloGlobal",
  "Orden de Compra # 1370 FLEXOIMPRESOS Marzo 31-2026 (TRAMAS LITOGRAFIA SAS).pdf": "TramasLitografia",
  "Orden de compra - P03987 (PROPLAS S.A.).pdf":                      "Proplas",
  "ORDEN DE COMPRA 7274 FLEXO IMPRESOS (MACROLAB ASOCIADOS S.A.S.).pdf": "Macrolab",
  "ORDEN_DE_COMPRA_RC2_PHARMA_RC-1565 (RC2 PHARMACEUTICAL S.A.S.).pdf": "Rc2Pharma",
};

const META_PROMPT = `Eres un experto en diseñar prompts para extracción estructurada de órdenes de compra a JSON.

Te muestro UN PDF real de una orden de compra dirigida a FLEXO IMPRESOS S.A.S. Analízalo cuidadosamente y genera un prompt de extracción ALTAMENTE ESPECÍFICO para este cliente, siguiendo este formato exacto:

\`\`\`
# PURCHASE ORDER EXTRACTION AGENT — {NOMBRE_CLIENTE}

## ROLE
You are a Purchase Order Analyzer specialized in extracting structured information from {NOMBRE_CLIENTE} purchase documents directed to FLEXO IMPRESOS S.A.S. and converting it to JSON format with absolute precision for SAP Business One integration.

## EXTRACTION PROCESS

### 1. INITIAL ANALYSIS
- Identify: <nombres reales de campos clave del PDF: OC number, dates, line items>

### 2. DATA EXTRACTION
- **Order number** (NumAtCard): <CAMPO REAL del PDF, e.g. "OC No.", "Orden de compra #", incluyendo cómo limpiar prefijos si aplica>
- **Document date** (TaxDate): <CAMPO REAL del PDF, e.g. "Fecha:", "Fecha de emisión">
- **Delivery date** (DocDueDate): <CAMPO REAL del PDF, e.g. "Fecha de entrega", "Llegada esperada", o columna por línea>
- **Today's date** (DocDate): The current date at time of processing — NOT from the document
- **Observations** (Comments): <Indicar la sección REAL, e.g. "Notas", "Observaciones específicas". Si el doc no tiene → "Use \"\"">
- **Line items**: For each product row extract:
  - Product code (SupplierCatNum): <CAMPO REAL: nombre de la columna del código, con instrucciones específicas si hay que extraer parte del código>
  - Quantity (Quantity): <CAMPO REAL>
  - Unit price (UnitPrice): <CAMPO REAL — explicitamente columna de PRECIO UNITARIO, NO subtotal>
  - Line delivery date (DeliveryDate): <CAMPO REAL o DocDueDate si no existe per-line>

### 3. DATA TRANSFORMATION

**Dates**: Convert ALL dates to YYYYMMDD format. <Dar 1-2 ejemplos reales con el formato del PDF>

**CardCode**: ALWAYS "{CARDCODE}" — fixed, no exceptions.

**DocType**: ALWAYS "dDocument_Items" — fixed constant.

**NÚMERO FORMAT — {COLOMBIAN/AMERICAN}**:
<Identifica el formato REAL del documento mirando los valores. Da reglas con ejemplos:>
- **Dot/Comma = thousands separator**: ...
- **Comma/Dot = decimal separator**: ...

**Quantities**: <reglas con ejemplos REALES del documento>

**UnitPrice**: <reglas con ejemplos REALES>
- **CROSS-VALIDATION MANDATORY**: Verify UnitPrice × Quantity ≈ <COLUMNA_SUBTOTAL_REAL>.
  <Da un ejemplo REAL de una línea del documento>: Price=X, Qty=Y, Subtotal=Z. Check: X×Y=Z ✓
  <ADVERTENCIA específica sobre qué columna NO confundir>

### 4. FIELD MAPPING

| Source                          | JSON Field          | Notes                          |
|---------------------------------|---------------------|--------------------------------|
| Fixed constant                  | DocType           | Always "dDocument_Items"     |
| <CAMPO REAL del NumAtCard>      | NumAtCard         | <notas>                       |
| Fixed constant                  | CardCode          | Always "{CARDCODE}"          |
| Today's date                    | DocDate           | YYYYMMDD — NOT from document   |
| <CAMPO REAL>                    | DocDueDate        | YYYYMMDD                       |
| <CAMPO REAL>                    | TaxDate           | YYYYMMDD                       |
| <SECCIÓN REAL or "(none)">      | Comments          | <notas>                        |
| <COLUMNA REAL>                  | DocumentLines[].SupplierCatNum | <notas>             |
| <COLUMNA REAL>                  | DocumentLines[].Quantity       | Integer              |
| <COLUMNA REAL>                  | DocumentLines[].UnitPrice      | Decimal, 0 if absent |
| <COLUMNA REAL>                  | DocumentLines[].DeliveryDate   | YYYYMMDD             |

### 5. FINAL VALIDATION
Before generating the response, verify:
- ✅ DocType is exactly "dDocument_Items"
- ✅ CardCode is exactly "{CARDCODE}"
- ✅ DocDate is today's processing date in YYYYMMDD (NOT from the document)
- ✅ <validaciones específicas del documento>
- ✅ UnitPrice × Quantity ≈ <SUBTOTAL_COLUMN_REAL> for every row
- ✅ Valid JSON syntax — no trailing commas, no extra fields

## RESPONSE FORMAT
**CRITICAL**: Your response must contain ONLY the JSON object. No explanations, no comments, no markdown, no preamble.
\`\`\`

REGLAS ESTRICTAS al generar el prompt:
1. Reemplaza TODOS los placeholders <> con valores REALES observados en el PDF.
2. NUNCA dejes placeholders genéricos.
3. Identifica el formato numérico CORRECTO analizando muestras del documento. Si ves "98.44" probablemente es americano (decimal); si ves "1.260.000" es colombiano (miles). Si ves "1.260.000,00" definitivamente colombiano.
4. Para cross-validation, calcula UN ejemplo REAL del documento (qty × price = subtotal) y verifica que cuadre.
5. Identifica el nombre EXACTO de la columna de subtotal/total pre-IVA en este documento.
6. Mantén CardCode = "{CARDCODE}" y el nombre del cliente en {NOMBRE_CLIENTE} tal como te los doy.
7. Si el documento tiene patrones especiales en NumAtCard (prefijos "OC", "OCN", "ORCOM", "OP", "P", etc. o números con guiones), explicítalos en las instrucciones.
8. Salida: SOLO el prompt completo, sin explicación adicional, sin bloques de código markdown alrededor.

Estos son los datos del cliente:
- NOMBRE_CLIENTE: {{NOMBRE}}
- CARDCODE: {{CARDCODE}}`;

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error("Falta ANTHROPIC_API_KEY"); process.exit(1); }
  const client = new Anthropic({ apiKey });

  const db = getDb();
  const clientes = getClientes(db);

  const results: Record<string, string> = {};
  const errors: string[] = [];

  const entries = Object.entries(PDF_TO_CARPETA);
  console.log(`Generando prompts para ${entries.length} clientes con PDF disponible\n`);

  for (const [pdfFile, carpeta] of entries) {
    const cliente = clientes.find(c => c.carpeta === carpeta);
    if (!cliente) {
      errors.push(`${carpeta}: cliente no encontrado en DB`);
      continue;
    }

    const cardCodeMatch = cliente.prompt?.match(/"(C\d+)"/);
    const cardCode = cardCodeMatch?.[1];
    if (!cardCode) {
      errors.push(`${carpeta}: CardCode no extraído del prompt actual`);
      continue;
    }

    const pdfPath = path.join(SCRATCH, pdfFile);
    if (!fs.existsSync(pdfPath)) {
      errors.push(`${carpeta}: PDF no encontrado en ${pdfPath}`);
      continue;
    }

    console.log(`→ ${carpeta} (${cliente.nombre}) ...`);
    try {
      const buffer = fs.readFileSync(pdfPath);
      const { pages } = await pdfToImages(buffer);
      const visionContent = buildVisionContent(pages);

      const meta = META_PROMPT
        .replace("{{NOMBRE}}", cliente.nombre)
        .replace("{{CARDCODE}}", cardCode);

      const msg = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        temperature: 0,
        system: meta,
        messages: [{ role: "user", content: visionContent }],
      });

      const prompt = msg.content[0].type === "text" ? msg.content[0].text.trim() : "";
      if (!prompt.includes("PURCHASE ORDER EXTRACTION AGENT")) {
        errors.push(`${carpeta}: respuesta del modelo no parece un prompt válido`);
        continue;
      }

      // Remover wrapping ``` si Claude lo añadió a pesar de las instrucciones
      const clean = prompt.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();
      results[carpeta] = clean;
      console.log(`  ✓ ${clean.length} chars, input=${msg.usage.input_tokens}, output=${msg.usage.output_tokens}`);
    } catch (e) {
      errors.push(`${carpeta}: ${String(e).slice(0, 200)}`);
      console.log(`  ✗ ${String(e).slice(0, 100)}`);
    }
  }

  // Generar archivo TS
  const outPath = "/home/ai_tamaprint/Software/clients/AI4U/experiments/orderloader/lib/flexo-prompts-generated.ts";
  const tsContent = `/**
 * Prompts específicos por cliente de FlexoImpresos, generados a partir
 * de PDFs reales mediante scripts/generate-flexo-prompts.ts.
 *
 * Clientes sin entrada aquí seguirán usando la plantilla genérica de clientes-seed-flexo.ts.
 */

export const FLEXO_SPECIFIC_PROMPTS: Record<string, string> = ${JSON.stringify(results, null, 2)};
`;
  fs.writeFileSync(outPath, tsContent);
  console.log(`\n✓ Generados ${Object.keys(results).length} prompts → ${outPath}`);

  if (errors.length > 0) {
    console.log(`\n⚠ Errores (${errors.length}):`);
    errors.forEach(e => console.log("  " + e));
  }
}

main().catch(console.error);
