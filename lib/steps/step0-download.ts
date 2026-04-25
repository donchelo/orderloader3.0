/**
 * Step 0: Descarga correos de pedidos desde IMAP y organiza archivos.
 *
 * Protocolo de clasificación (fuente de verdad: contenido del PDF):
 *   1. Asunto contiene "[OrderLoader]"  → notificación propia, se deja en INBOX
 *   2. Ningún adjunto PDF               → A A SANDRA
 *   3. Ningún PDF es OC de cliente aprobado dirigido a Tamaprint → A A SANDRA
 *   4. Hay PDFs aprobados + otros archivos → procesa los aprobados, correo a A A SANDRA
 *   5. Solo PDFs aprobados              → pipeline normal (A B INGRESADO → step7 decide final)
 *
 * El campo has_extra_files en correo_metadata.json indica a step7 si el correo
 * debe ir a A A SANDRA al final, independientemente del resultado del pipeline.
 */

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import fs from "fs";
import path from "path";
import { getConfig } from "../config";
import {
  getDb, logPipeline, ensureWorkspaceDirs,
  insertPendingMove, completePendingMove, failPendingMove, getPendingMoves,
} from "../db";
import { detectClientFromPdf, esDirigidoATamaprint } from "../pdf-classify";

export interface StepResult {
  procesados: number;
  errores: number;
  saltados: number;
  detalles: string[];
}

function clean(text: string): string {
  return text.replace(/[^a-zA-Z0-9\-_.]/g, "_");
}

interface AttachmentInfo {
  filename: string;
  content: Buffer;
}

interface PdfClassification {
  filename: string;
  content: Buffer;
  client: string | null;   // carpeta del cliente aprobado, o null
  isTamaprint: boolean;
  isApprovedOC: boolean;   // client !== null AND isTamaprint
}

async function clasificarPdfs(pdfs: AttachmentInfo[]): Promise<PdfClassification[]> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParseFn = require("pdf-parse/lib/pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;
  const results: PdfClassification[] = [];
  for (const pdf of pdfs) {
    try {
      const { text } = await pdfParseFn(pdf.content);
      const client      = detectClientFromPdf(text);
      const isTamaprint = esDirigidoATamaprint(text);
      results.push({
        filename: pdf.filename,
        content:  pdf.content,
        client,
        isTamaprint,
        isApprovedOC: client !== null && isTamaprint,
      });
    } catch {
      // PDF corrupto o no legible: tratar como archivo no reconocido
      results.push({ filename: pdf.filename, content: pdf.content, client: null, isTamaprint: false, isApprovedOC: false });
    }
  }
  return results;
}

const STAGING_FOLDER = "INBOX.A B INGRESADO";
const SANDRA_FOLDER  = "INBOX.A A SANDRA";

async function moveToSandra(imapClient: ImapFlow, uid: number): Promise<void> {
  try {
    await imapClient.messageMove(String(uid), SANDRA_FOLDER, { uid: true });
  } catch {
    try { await imapClient.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true }); } catch { /* ignorar */ }
  }
}

/**
 * Recupera movimientos de email que quedaron a medias si el proceso se cayó.
 * Se llama al inicio de cada corrida del pipeline, antes de step0.
 *
 * Casos:
 * - Archivos en disco con correo_metadata.json: marcar COMPLETADO (step1 procesa)
 * - Email aún en INBOX: reintentar el move a STAGING
 * - No encontrado en ningún lado: marcar FALLIDO y logear alerta
 */
export async function recoverPendingMoves(): Promise<string[]> {
  const logs: string[] = [];
  let db;
  try { db = getDb(); } catch { return logs; }

  const pending = getPendingMoves(db);
  if (pending.length === 0) return logs;

  const config = getConfig();
  logs.push(`Recovery: ${pending.length} movimiento(s) IMAP pendiente(s) encontrado(s)`);

  const imapClient = new ImapFlow({
    host: config.emailHost,
    port: config.emailPort,
    secure: true,
    auth: { user: config.emailUser, pass: config.emailPass },
    logger: false,
  });

  try {
    await imapClient.connect();

    for (const pm of pending) {
      // Caso 1: los archivos en disco están completos → el move ya ocurrió, solo completar
      if (pm.carpeta_email) {
        const metaPath = path.join(pm.carpeta_email, "correo_metadata.json");
        if (fs.existsSync(metaPath)) {
          completePendingMove(db, pm.id);
          logs.push(`↩ Recovery OK (archivos presentes): ${pm.carpeta_email}`);
          continue;
        }
      }

      // Caso 2: buscar el email en INBOX por Message-ID → el move no ocurrió, reintentar
      let foundInInbox = false;
      try {
        const lock = await imapClient.getMailboxLock("INBOX");
        try {
          for await (const msg of imapClient.fetch("1:*", { uid: true, envelope: true })) {
            const mid = msg.envelope?.messageId ?? "";
            if (mid === pm.message_id) {
              foundInInbox = true;
              try {
                await imapClient.messageMove(String(msg.uid), pm.carpeta_destino, { uid: true });
                completePendingMove(db, pm.id);
                logs.push(`↩ Recovery OK (re-movido desde INBOX): Message-ID=${pm.message_id}`);
              } catch (moveErr) {
                logs.push(`⚠ Recovery: no se pudo mover desde INBOX: ${String(moveErr)}`);
              }
              break;
            }
          }
        } finally {
          lock.release();
        }
      } catch { /* INBOX no accesible */ }

      if (foundInInbox) continue;

      // Caso 3: buscar en STAGING → el move sí ocurrió pero los archivos están incompletos
      let foundInStaging = false;
      try {
        const lock = await imapClient.getMailboxLock(pm.carpeta_destino);
        try {
          for await (const msg of imapClient.fetch("1:*", { uid: true, envelope: true })) {
            if ((msg.envelope?.messageId ?? "") === pm.message_id) {
              foundInStaging = true;
              break;
            }
          }
        } finally {
          lock.release();
        }
      } catch { /* STAGING no accesible */ }

      if (foundInStaging) {
        // El email llegó a staging pero los archivos quedaron incompletos.
        // Marcar FALLIDO: requiere revisión manual.
        failPendingMove(db, pm.id);
        logs.push(`⚠ Recovery FALLIDO (email en staging sin archivos): Message-ID=${pm.message_id} — revisar manualmente`);
      } else {
        // No encontrado en ningún lado
        failPendingMove(db, pm.id);
        logs.push(`⚠ Recovery FALLIDO (email no encontrado en INBOX ni staging): Message-ID=${pm.message_id}`);
      }
    }

    await imapClient.logout();
  } catch (e) {
    logs.push(`⚠ Recovery: error de conexión IMAP: ${String(e)}`);
  }

  return logs;
}

export async function run(): Promise<StepResult> {
  const config = getConfig();
  ensureWorkspaceDirs();

  const result: StepResult = { procesados: 0, errores: 0, saltados: 0, detalles: [] };

  if (!config.emailUser || !config.emailPass || !config.emailHost) {
    result.detalles.push("Faltan credenciales de email en .env.local");
    return result;
  }

  const imapClient = new ImapFlow({
    host: config.emailHost,
    port: config.emailPort,
    secure: true,
    auth: { user: config.emailUser, pass: config.emailPass },
    logger: false,
  });

  try {
    await imapClient.connect();
    await imapClient.mailboxCreate(SANDRA_FOLDER).catch(() => {});

    const lock = await imapClient.getMailboxLock("INBOX");
    const createdFolders = new Set<string>();

    try {
      const messages = [];
      for await (const msg of imapClient.fetch("1:*", {
        uid: true, flags: true, envelope: true, source: true,
      })) {
        messages.push(msg);
      }

      if (messages.length === 0) {
        result.detalles.push("No hay correos en INBOX");
        return result;
      }

      result.detalles.push(`Revisando INBOX: ${messages.length} correo(s)`);

      for (const msg of messages) {
        try {
          const envelope   = msg.envelope;
          const subject    = envelope?.subject ?? "Sin asunto";
          const sender     = envelope?.from?.[0]?.address ?? "";
          const dateHeader = envelope?.date?.toISOString() ?? new Date().toISOString();

          // ── 1. Notificación propia de OrderLoader → dejar en INBOX ────────────
          if (subject.includes("[OrderLoader]")) {
            result.detalles.push(`INBOX (notif OrderLoader): "${subject}"`);
            continue;
          }

          // ── 2. Parsear EML para obtener todos los adjuntos ─────────────────────
          let parsedText = "";
          let messageId  = "";
          const pdfAttachments: AttachmentInfo[]   = [];
          const otherAttachments: AttachmentInfo[] = [];

          if (msg.source) {
            const parsed = await simpleParser(msg.source);
            if (parsed.text) parsedText = parsed.text;
            messageId = parsed.messageId ?? "";

            for (const att of parsed.attachments) {
              if (!att.filename) continue;
              const safeName = clean(att.filename) || "adjunto";
              const info: AttachmentInfo = { filename: safeName, content: att.content as Buffer };
              if (safeName.toLowerCase().endsWith(".pdf")) {
                pdfAttachments.push(info);
              } else {
                otherAttachments.push(info);
              }
            }
          }

          // ── 3. Sin PDFs → Sandra ───────────────────────────────────────────────
          if (pdfAttachments.length === 0) {
            await moveToSandra(imapClient, msg.uid);
            result.saltados++;
            result.detalles.push(`SANDRA (sin PDF): "${subject}" de ${sender}`);
            continue;
          }

          // ── 4. Clasificar cada PDF por su contenido interno ───────────────────
          const clasificados = await clasificarPdfs(pdfAttachments);
          const approvedPdfs = clasificados.filter(p => p.isApprovedOC);

          if (approvedPdfs.length === 0) {
            await moveToSandra(imapClient, msg.uid);
            result.saltados++;
            result.detalles.push(`SANDRA (ningún PDF es OC aprobada): "${subject}" de ${sender}`);
            continue;
          }

          // ── 5. Hay PDFs aprobados: determinar si hay "extras" ─────────────────
          // Extra = cualquier adjunto que no sea una OC de cliente aprobado
          const hasExtraFiles = (approvedPdfs.length < pdfAttachments.length) || otherAttachments.length > 0;

          // Carpeta de almacenamiento: primer cliente detectado (step1 re-detecta de todos modos)
          const client_folder = approvedPdfs[0].client!;

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

          // Guardar EML original
          if (msg.source) {
            fs.writeFileSync(path.join(pedidoPath, "correo_original.eml"), msg.source);
          }

          // Guardar texto plano
          const bodyText = `De: ${sender}\nAsunto: ${subject}\nFecha: ${dateHeader}\n\n${parsedText}`;
          fs.writeFileSync(path.join(pedidoPath, "correo_original.txt"), bodyText, "utf8");

          // Guardar todos los adjuntos — step1 ignora los no aprobados con su propio detectClientFromPdf
          for (const att of [...pdfAttachments, ...otherAttachments]) {
            fs.writeFileSync(path.join(pedidoPath, att.filename), att.content);
          }

          // Registrar intención de mover ANTES de ejecutar el move.
          // Si el proceso se cae después del move pero antes de guardar archivos,
          // recoverPendingMoves() encontrará este registro y resolverá el estado.
          let pendingMoveId: number | null = null;
          try {
            const db = getDb();
            pendingMoveId = insertPendingMove(db, messageId, msg.uid, "INBOX", STAGING_FOLDER, pedidoPath);
          } catch { /* DB podría no estar disponible aún */ }

          // Mover a staging — capturar nuevo UID para que step7 lo mueva al final
          let storedUid = msg.uid;
          try {
            const moveResult = await imapClient.messageMove(String(msg.uid), STAGING_FOLDER, { uid: true });
            const newUid = (moveResult as { uidMap?: Map<number, number> })?.uidMap?.get(msg.uid);
            if (newUid) storedUid = newUid;
          } catch {
            try { await imapClient.messageFlagsAdd(String(msg.uid), ["\\Seen"], { uid: true }); } catch { /* ignorar */ }
          }

          const approvedNames = approvedPdfs.map(p => p.filename).join(", ");
          const extraNames    = [
            ...clasificados.filter(p => !p.isApprovedOC).map(p => p.filename),
            ...otherAttachments.map(a => a.filename),
          ].join(", ");

          fs.writeFileSync(
            path.join(pedidoPath, "correo_metadata.json"),
            JSON.stringify({
              from: sender,
              subject,
              date: dateHeader,
              client: client_folder,
              folder_local: `pedidos/raw/${client_folder}/${folderName}`,
              imap_uid: storedUid,
              message_id: messageId,
              imap_staging_folder: STAGING_FOLDER,
              n_adjuntos_pdf: approvedPdfs.length,
              has_extra_files: hasExtraFiles,
              pdfs_aprobados: approvedNames,
              ...(hasExtraFiles ? { archivos_extra: extraNames } : {}),
              ts_download: new Date().toISOString(),
            }, null, 2),
            "utf8"
          );

          fs.writeFileSync(
            path.join(pedidoPath, "estado_pipeline.json"),
            JSON.stringify({ fase: 0, estado: "DESCARGADO", ts: new Date().toISOString() }, null, 2),
            "utf8"
          );

          try {
            const db = getDb();
            logPipeline(db, folderName, 0, "download", "OK",
              `UID=${storedUid} cliente=${client_folder} PDFs_OC=${approvedPdfs.length} extras=${hasExtraFiles}`);
            // Marcar el pending_move como completado: archivos en disco y DB actualizados
            if (pendingMoveId !== null) completePendingMove(db, pendingMoveId);
          } catch { /* DB might not exist yet */ }

          result.procesados++;
          const extraMsg = hasExtraFiles ? ` ⚠ archivos extras: ${extraNames}` : "";
          result.detalles.push(`OK: pedidos/raw/${client_folder}/${folderName} (${approvedPdfs.length} OC PDF)${extraMsg}`);

          // Un solo pedido por llamada; el pipeline llama step0 en loop
          break;

        } catch (e) {
          result.errores++;
          result.detalles.push(`ERROR en mensaje: ${String(e)}`);
        }
      }

      if (result.procesados === 0 && result.saltados === 0 && result.errores === 0) {
        result.detalles.push("No hay pedidos pendientes en INBOX (solo notificaciones OrderLoader)");
      }

    } finally {
      lock.release();
    }
    await imapClient.logout();
  } catch (e) {
    result.errores++;
    result.detalles.push(`Error de conexión IMAP: ${String(e)}`);
  }

  return result;
}
