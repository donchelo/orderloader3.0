/**
 * Verifica los clientes nuevos: parsea cada PDF y consulta cada SupplierCatNum en SAP B1.
 * Uso: npx tsx scripts/verify-new-clients.ts
 */

import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { getSapClient, logoutSapClient } from "../lib/sap-client";
import {
  PROMPT_EUROCORSETT,
  PROMPT_INDUSTRIASCORY,
  PROMPT_ESTUDIOMODA,
  PROMPT_PINTURAS_PRIME,
  PROMPT_MANUTEX,
  PROMPT_ELGLOBO,
  PROMPT_SERVICIO_COMPLETO,
  PROMPT_ICVO,
  PROMPT_PRODUEMPAK,
} from "../lib/prompts";

const pdfParseFn = require("pdf-parse/lib/pdf-parse") as (
  buf: Buffer
) => Promise<{ text: string }>;

const RAW_DIR = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, "pedidos", "raw")
  : path.join(process.cwd(), ".data", "pedidos", "raw");

const CLIENTES = [
  { carpeta: "Eurocorsett",     prompt: PROMPT_EUROCORSETT,       cardCode: "CN811032857" },
  { carpeta: "IndustriasCory",  prompt: PROMPT_INDUSTRIASCORY,    cardCode: "CN800131750" },
  { carpeta: "EstudioModa",     prompt: PROMPT_ESTUDIOMODA,       cardCode: "CN890926803" },
  { carpeta: "PinturasPrime",   prompt: PROMPT_PINTURAS_PRIME,    cardCode: "CN800194203" },
  { carpeta: "Manutex",         prompt: PROMPT_MANUTEX,           cardCode: "CN900426666" },
  { carpeta: "ElGlobo",         prompt: PROMPT_ELGLOBO,           cardCode: "CN800227956" },
  { carpeta: "ServicioCompleto",prompt: PROMPT_SERVICIO_COMPLETO, cardCode: "CN900690157" },
  { carpeta: "ICVO",            prompt: PROMPT_ICVO,             cardCode: "CN890932892" },
  { carpeta: "Produempak",      prompt: PROMPT_PRODUEMPAK,       cardCode: "CN900445797" },
];

const PASS = "✅";
const FAIL = "❌";
const WARN = "⚠️ ";

async function parseWithAI(pdfText: string, prompt: string): Promise<any> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    temperature: 0,
    system: prompt,
    messages: [{ role: "user", content: pdfText }],
  });
  const text = msg.content[0].type === "text" ? msg.content[0].text.trim() : "";
  const clean = text.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();
  return JSON.parse(clean);
}

async function checkItemInSap(
  sap: Awaited<ReturnType<typeof getSapClient>>,
  cardCode: string,
  supplierCatNum: string
): Promise<{ exists: boolean; itemCode?: string; error?: string }> {
  try {
    const escapedCard = cardCode.replace(/'/g, "''");
    const escapedCat  = supplierCatNum.replace(/'/g, "''");
    const res = await sap.get<{ value: Array<{ ItemCode: string }> }>("AlternateCatNum", {
      "$filter": `CardCode eq '${escapedCard}' and Substitute eq '${escapedCat}'`,
      "$select": "ItemCode",
      "$top": "1",
    });
    if (res.value?.length > 0) {
      return { exists: true, itemCode: res.value[0].ItemCode };
    }
    return { exists: false };
  } catch (e: any) {
    return { exists: false, error: String(e.message).slice(0, 80) };
  }
}

async function main() {
  console.log("\n══════════════════════════════════════════════════");
  console.log("  VERIFICACIÓN DE CLIENTES NUEVOS — OrderLoader");
  console.log("══════════════════════════════════════════════════\n");

  let sap: Awaited<ReturnType<typeof getSapClient>> | null = null;
  try {
    console.log("Conectando a SAP B1...");
    sap = await getSapClient();
    console.log("SAP: conectado.\n");
  } catch (e: any) {
    console.warn(`${WARN} No se pudo conectar a SAP: ${e.message}`);
    console.warn("Se mostrará el JSON parseado pero sin verificación de artículos.\n");
  }

  let totalOk = 0;
  let totalFail = 0;

  for (const { carpeta, prompt, cardCode } of CLIENTES) {
    const dir = path.join(RAW_DIR, carpeta);
    const pdfs = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf"))
      : [];

    console.log(`─── ${carpeta} (${cardCode}) ${"─".repeat(Math.max(0, 42 - carpeta.length))}`);

    if (pdfs.length === 0) {
      console.log(`  ${WARN} Sin PDFs en ${dir}\n`);
      continue;
    }

    for (const pdf of pdfs) {
      console.log(`  PDF: ${pdf}`);
      try {
        const buf = fs.readFileSync(path.join(dir, pdf));
        const { text } = await pdfParseFn(buf);
        const order = await parseWithAI(text, prompt);

        // Validaciones básicas del JSON
        const checks = [
          { label: "CardCode",  ok: order.CardCode === cardCode,           got: order.CardCode },
          { label: "NumAtCard", ok: !!order.NumAtCard,                     got: order.NumAtCard },
          { label: "TaxDate",   ok: /^\d{8}$/.test(order.TaxDate),         got: order.TaxDate },
          { label: "DocDueDate",ok: /^\d{8}$/.test(order.DocDueDate),      got: order.DocDueDate },
          { label: "Lines",     ok: order.DocumentLines?.length > 0,       got: `${order.DocumentLines?.length ?? 0} líneas` },
        ];

        for (const c of checks) {
          const icon = c.ok ? PASS : FAIL;
          if (!c.ok) totalFail++;
          console.log(`    ${icon} ${c.label.padEnd(10)}: ${c.got}`);
        }

        // Verificar cada artículo en SAP
        console.log(`    Artículos:`);
        for (const line of order.DocumentLines ?? []) {
          const code = line.SupplierCatNum;
          if (sap) {
            const { exists, itemCode, error } = await checkItemInSap(sap, order.CardCode, code);
            if (exists) {
              console.log(`      ${PASS} "${code}" → ItemCode SAP: ${itemCode}`);
              totalOk++;
            } else if (error) {
              console.log(`      ${WARN} "${code}" → error SAP: ${error}`);
            } else {
              console.log(`      ${FAIL} "${code}" → NO existe en AlternateCatNum`);
              totalFail++;
            }
          } else {
            console.log(`      ℹ️  "${code}" (qty: ${line.Quantity}, price: ${line.UnitPrice})`);
          }
        }
      } catch (e: any) {
        console.log(`  ${FAIL} Error procesando PDF: ${e.message}`);
        totalFail++;
      }
      console.log();
    }
  }

  if (sap) {
    await logoutSapClient();
    console.log(`\n══════════════════════════════════════════════════`);
    console.log(`  Resultado: ${totalOk} OK  |  ${totalFail} errores`);
    console.log(`══════════════════════════════════════════════════\n`);
  }
}

main().catch((e) => {
  console.error("Error fatal:", e.message);
  process.exit(1);
});
