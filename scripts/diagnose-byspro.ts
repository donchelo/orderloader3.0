/**
 * Diagnóstico: busca el email de BYSPRO en SANDRA, extrae el PDF y muestra
 * exactamente qué texto ve el sistema y por qué falla la detección.
 */

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
// Load env manually since dotenv may not be installed
import fs from "fs";
const envContent = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf-8") : fs.existsSync(".env") ? fs.readFileSync(".env", "utf-8") : "";
for (const line of envContent.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const pdfParse = require("pdf-parse/lib/pdf-parse");

const SANDRA_FOLDER = "INBOX.A A SANDRA";

async function main() {
  const imapClient = new ImapFlow({
    host: process.env.EMAIL_HOST!,
    port: Number(process.env.EMAIL_PORT ?? 993),
    secure: true,
    auth: { user: process.env.EMAIL_USER!, pass: process.env.EMAIL_PASS! },
    logger: false,
  });

  await imapClient.connect();
  const lock = await imapClient.getMailboxLock(SANDRA_FOLDER);

  try {
    const messages = [];
    for await (const msg of imapClient.fetch("1:*", {
      uid: true, envelope: true, source: true,
    })) {
      const subject = msg.envelope?.subject ?? "";
      if (subject.toLowerCase().includes("byspro")) {
        messages.push(msg);
      }
    }

    if (messages.length === 0) {
      console.log("No se encontraron emails de BYSPRO en SANDRA.");
      return;
    }

    console.log(`Encontrados ${messages.length} email(s) con 'byspro' en asunto:\n`);

    for (const msg of messages) {
      const subject = msg.envelope?.subject ?? "";
      const sender = msg.envelope?.from?.[0]?.address ?? "";
      console.log(`=== Email: "${subject}" de ${sender} ===`);

      if (!msg.source) { console.log("Sin source\n"); continue; }

      const parsed = await simpleParser(msg.source);
      const pdfs = parsed.attachments.filter(a => a.filename?.toLowerCase().endsWith(".pdf"));

      if (pdfs.length === 0) {
        console.log("Sin adjuntos PDF\n");
        continue;
      }

      for (const att of pdfs) {
        console.log(`\n--- PDF: ${att.filename} ---`);
        try {
          const result = await pdfParse(att.content as Buffer);
          const text = result.text as string;

          console.log(`\nTexto extraído (primeros 1500 chars):\n${"─".repeat(60)}`);
          console.log(text.slice(0, 1500));
          console.log("─".repeat(60));

          // Detección manual
          const lower = text.toLowerCase();
          const normalized = text.replace(/\./g, "");

          const tamaprintKws = ["tamaprint", "tama print", "900851655", "9008516551", "900.851.655"];
          const isTamaprint = tamaprintKws.some(kw => lower.includes(kw));
          console.log(`\nisTamaprint: ${isTamaprint}`);
          if (isTamaprint) {
            const found = tamaprintKws.find(kw => lower.includes(kw));
            console.log(`  → keyword encontrado: "${found}"`);
          } else {
            console.log("  → NINGÚN keyword de Tamaprint encontrado en el texto");
          }

          const bysproNit = "805018724";
          const nitFound = normalized.includes(bysproNit);
          console.log(`\nNIT BYSPRO (${bysproNit}) encontrado: ${nitFound}`);
          if (nitFound) {
            const idx = normalized.indexOf(bysproNit);
            console.log(`  → en posición ${idx}: "...${normalized.slice(Math.max(0, idx-10), idx+20)}..."`);
          }

          const bysprKws = ["byspro", "byspro s.a.s", "byspro.net"];
          for (const kw of bysprKws) {
            console.log(`Keyword "${kw}" encontrado: ${lower.includes(kw)}`);
          }

        } catch (e) {
          console.log(`Error parseando PDF: ${e}`);
        }
      }
      console.log("\n");
    }
  } finally {
    lock.release();
    await imapClient.logout();
  }
}

main().catch(console.error);
