/**
 * Step 0: Descarga correos de pedidos desde IMAP y organiza archivos.
 *
 * Por cada correo no leído en INBOX:
 *   - Identifica el cliente (Hermeco / Comodin / Exito / Otros)
 *   - Guarda en pedidos/raw/CLIENTE/YYYYMMDD_HHMMSS_ASUNTO/:
 *       correo_original.txt, correo_original.eml, correo_metadata.json,
 *       estado_pipeline.json, adjuntos PDF
 *   - Mueve el correo en el servidor a Pedidos/Procesados/CLIENTE
 */

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import fs from "fs";
import path from "path";
import { getConfig } from "../config";
import { getDb, logPipeline, ensureWorkspaceDirs } from "../db";
import type { Config } from "../config";

export interface StepResult {
  procesados: number;
  errores: number;
  saltados: number;
  detalles: string[];
}

function clean(text: string): string {
  return text.replace(/[^a-zA-Z0-9\-_.]/g, "_");
}

function getClientFolder(sender: string, subject: string, body: string, config: Config): string {
  // 1. Prioridad: buscar en asunto (más confiable, evita falsos positivos del cuerpo)
  const subjectLower = `${sender} ${subject}`.toLowerCase();
  for (const [cliente, keywords] of Object.entries(config.clientKeywords)) {
    if (keywords.some(kw => subjectLower.includes(kw.toLowerCase()))) {
      return cliente;
    }
  }

  // 2. Fallback: buscar en cuerpo completo del correo
  const bodyLower = body.toLowerCase();
  for (const [cliente, keywords] of Object.entries(config.clientKeywords)) {
    if (keywords.some(kw => bodyLower.includes(kw.toLowerCase()))) {
      return cliente;
    }
  }

  return "Otros";
}

export async function run(): Promise<StepResult> {
  const config = getConfig();
  ensureWorkspaceDirs();

  const result: StepResult = { procesados: 0, errores: 0, saltados: 0, detalles: [] };

  if (!config.emailUser || !config.emailPass || !config.emailHost) {
    result.detalles.push("Faltan credenciales de email en .env.local");
    return result;
  }

  const client = new ImapFlow({
    host: config.emailHost,
    port: config.emailPort,
    secure: true,
    auth: { user: config.emailUser, pass: config.emailPass },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX.A A INGRESAR IA");
    const createdFolders = new Set<string>();

    try {
      const messages = [];
      for await (const msg of client.fetch("1:*", {
        uid: true,
        flags: true,
        envelope: true,
        source: true,
      })) {
        messages.push(msg);
      }

      if (messages.length === 0) {
        result.detalles.push("No hay correos en A A INGRESAR IA");
        return result;
      }

      result.detalles.push(`Encontrados ${messages.length} correo(s) en A A INGRESAR IA — procesando 1`);

      // Flujo unitario: procesar solo el primer correo; el pipeline llama step0 en loop
      for (const msg of messages.slice(0, 1)) {
        try {
          const envelope = msg.envelope;
          const subject = envelope?.subject ?? "Sin asunto";
          const sender = envelope?.from?.[0]?.address ?? "";
          const dateHeader = envelope?.date?.toISOString() ?? new Date().toISOString();

          // Usar el raw EML completo para clasificación (incluye headers de forwards y HTML codificado)
          const rawEmail = msg.source ? msg.source.toString("utf8") : "";

          const client_folder = getClientFolder(sender, subject, rawEmail, config);
          const ts = new Date()
            .toISOString()
            .replace(/[-:T]/g, (c) => (c === "T" ? "_" : c))
            .split(".")[0];
          let folderName = `${ts}_${clean(subject).slice(0, 50) || "sin_asunto"}`;

          let idx = 1;
          while (createdFolders.has(folderName)) {
            folderName = `${ts}_${clean(subject).slice(0, 50)}_${String(idx).padStart(2, "0")}`;
            idx++;
          }
          createdFolders.add(folderName);

          const pedidoPath = path.join(config.pedidosRawDir, client_folder, folderName);
          fs.mkdirSync(pedidoPath, { recursive: true });

          // Save raw source as EML
          if (msg.source) {
            fs.writeFileSync(path.join(pedidoPath, "correo_original.eml"), msg.source);
          }

          // Parse EML with mailparser (handles nested forwards, Apple Mail, etc.)
          let bodyText = `De: ${sender}\nAsunto: ${subject}\nFecha: ${dateHeader}\n\n`;
          let pdfCount = 0;

          if (msg.source) {
            const parsed = await simpleParser(msg.source);

            // Extract text body
            if (parsed.text) bodyText += parsed.text;
            fs.writeFileSync(path.join(pedidoPath, "correo_original.txt"), bodyText, "utf8");

            // Extract all attachments (including those inside forwarded message/rfc822)
            for (const att of parsed.attachments) {
              if (!att.filename) continue;
              const safeName = clean(att.filename) || "adjunto";
              fs.writeFileSync(path.join(pedidoPath, safeName), att.content);
              if (safeName.toLowerCase().endsWith(".pdf")) pdfCount++;
            }
          } else {
            fs.writeFileSync(path.join(pedidoPath, "correo_original.txt"), bodyText, "utf8");
          }

          const STAGING_FOLDER = "INBOX.A A INGRESADO";

          // Mover inmediatamente — esto evita el reloop. Capturar el nuevo UID via uidMap
          // (IMAP asigna un UID distinto en la carpeta destino; guardamos el nuevo para step7)
          let storedUid = msg.uid;
          try {
            const moveResult = await client.messageMove(String(msg.uid), STAGING_FOLDER, { uid: true });
            const newUid = (moveResult as { uidMap?: Map<number, number> })?.uidMap?.get(msg.uid);
            if (newUid) storedUid = newUid;
          } catch {
            try { await client.messageFlagsAdd(String(msg.uid), ["\\Seen"], { uid: true }); } catch { /* ignorar */ }
          }

          // Write metadata — usa el UID válido en staging para que step7 pueda moverlo
          const metadata = {
            from: sender,
            subject,
            date: dateHeader,
            client: client_folder,
            folder_local: `pedidos/raw/${client_folder}/${folderName}`,
            imap_uid: storedUid,
            imap_staging_folder: STAGING_FOLDER,
            n_adjuntos_pdf: pdfCount,
            ts_download: new Date().toISOString(),
          };
          fs.writeFileSync(
            path.join(pedidoPath, "correo_metadata.json"),
            JSON.stringify(metadata, null, 2),
            "utf8"
          );

          fs.writeFileSync(
            path.join(pedidoPath, "estado_pipeline.json"),
            JSON.stringify({ fase: 0, estado: "DESCARGADO", ts: new Date().toISOString() }, null, 2),
            "utf8"
          );

          // Log to DB
          try {
            const db = getDb();
            logPipeline(db, folderName, 0, "download", "OK",
              `UID=${storedUid} cliente=${client_folder} PDFs=${pdfCount}`);
          } catch {
            /* DB might not exist yet */
          }

          result.procesados++;
          result.detalles.push(`OK: pedidos/raw/${client_folder}/${folderName} (${pdfCount} PDF)`);
        } catch (e) {
          result.errores++;
          result.detalles.push(`ERROR en mensaje: ${String(e)}`);
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    result.errores++;
    result.detalles.push(`Error de conexión IMAP: ${String(e)}`);
  }

  return result;
}
