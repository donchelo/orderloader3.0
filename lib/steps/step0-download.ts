/**
 * Step 0: Descarga correos de pedidos desde IMAP y organiza archivos.
 *
 * Protocolo de clasificación (fuente de verdad: contenido del PDF):
 *   1. Asunto contiene "[OrderLoader]"  → notificación propia, se deja en INBOX
 *   2. Ningún adjunto PDF               → A A SANDRA
 *   3. Ningún PDF es OC de cliente aprobado dirigido a Tamaprint → A A SANDRA
 *   4. Hay PDFs aprobados + otros archivos → procesa los aprobados, correo a A A SANDRA
 *   5. Solo PDFs aprobados              → pipeline normal (A A REVISAR IA → step7 decide final)
 *
 * Default pesimista: todo correo con OC va primero a "A A REVISAR IA".
 * Step7 lo mueve a "A B INGRESADO" solo si el proceso termina limpio.
 * Si el sistema falla en cualquier punto, el correo permanece visible en REVISAR IA.
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
import { detectClientFromPdf, esDirigidoAEmpresa, loadClientListsFromDb, CLIENT_NITS, CLIENT_TEXT_KEYWORDS } from "../pdf-classify";
import { triageEmailAttachments, prepareImageForTriage, TRIAGE_MODEL, type AttachmentForTriage, type TriageResult } from "../ai-triage";

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
  client: string | null;
  isDirigidoAEmpresa: boolean;
  isApprovedOC: boolean;
  detectionMethod: 'nit' | 'keyword' | null;
}

async function clasificarPdfs(
  pdfs: AttachmentInfo[],
  clientNits: Array<{ carpeta: string; nits: string[] }>,
  clientKeywords: Array<{ carpeta: string; keywords: string[] }>,
  receptorKeywords: string[],
  textsOut?: Map<string, string>
): Promise<PdfClassification[]> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParseFn = require("pdf-parse/lib/pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;
  const results: PdfClassification[] = [];
  for (const pdf of pdfs) {
    try {
      const { text } = await pdfParseFn(pdf.content);
      if (textsOut) textsOut.set(pdf.filename, text);
      const detection          = detectClientFromPdf(text, clientNits, clientKeywords);
      const isDirigidoAEmpresa = esDirigidoAEmpresa(text, receptorKeywords);
      results.push({
        filename: pdf.filename,
        content:  pdf.content,
        client:   detection?.carpeta ?? null,
        isDirigidoAEmpresa,
        isApprovedOC: detection !== null && isDirigidoAEmpresa,
        detectionMethod: detection?.metodo ?? null,
      });
    } catch {
      results.push({ filename: pdf.filename, content: pdf.content, client: null, isDirigidoAEmpresa: false, isApprovedOC: false, detectionMethod: null });
    }
  }
  return results;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

function esImagen(filename: string): boolean {
  const ext = '.' + filename.toLowerCase().split('.').pop();
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * Ejecuta triage IA sobre todos los adjuntos del correo.
 * Devuelve los resultados, o null si la IA no está disponible.
 */
async function ejecutarTriageIA(
  clasificados: PdfClassification[],
  otherAttachments: AttachmentInfo[],
  pdfTexts: Map<string, string>,
  clientNits: Array<{ carpeta: string; nits: string[] }> = CLIENT_NITS,
  emailSubject?: string,
  companyName = "Tamaprint",
): Promise<{ results: TriageResult[]; inputTokens: number; outputTokens: number } | null> {
  const attachments: AttachmentForTriage[] = [];

  for (const pdf of clasificados) {
    const fullText = pdfTexts.get(pdf.filename) ?? '';
    attachments.push({
      filename: pdf.filename,
      tipoArchivo: 'pdf',
      textoCabecera: fullText.slice(0, 800),
      textoPie: fullText.length > 800 ? fullText.slice(-400) : undefined,
      deteccionInicial: pdf.client ? { carpeta: pdf.client, metodo: pdf.detectionMethod! } : null,
    });
  }

  for (const att of otherAttachments) {
    if (esImagen(att.filename)) {
      const imgData = prepareImageForTriage(att.content, att.filename);
      attachments.push({
        filename: att.filename,
        tipoArchivo: 'imagen',
        ...imgData,
      });
    } else {
      attachments.push({ filename: att.filename, tipoArchivo: 'otro' });
    }
  }

  return triageEmailAttachments(attachments, clientNits, emailSubject, companyName);
}


async function recoverPendingMovesMicrosoft(
  config: ReturnType<typeof getConfig>,
  db: ReturnType<typeof getDb>,
  pending: ReturnType<typeof getPendingMoves>
): Promise<string[]> {
  const logs: string[] = [];
  logs.push(`Recovery Microsoft: ${pending.length} movimiento(s) Graph pendiente(s) encontrado(s)`);

  if (!config.msClientId || !config.msTenantId || !config.msClientSecret) {
    logs.push("⚠ Recovery Microsoft: faltan credenciales MS_CLIENT_ID/MS_TENANT_ID/MS_CLIENT_SECRET");
    return logs;
  }

  try {
    const { getAccessToken, findMessageInInbox, moveMessage } = await import("../microsoft-graph");
    const token = await getAccessToken(config.msTenantId, config.msClientId, config.msClientSecret);

    for (const pm of pending) {
      // Caso 1: archivos en disco con move_complete → solo actualizar DB
      if (pm.carpeta_email) {
        const metaPath = path.join(pm.carpeta_email, "correo_metadata.json");
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
            if (meta.graph_move_complete === true || meta.imap_move_complete === true) {
              completePendingMove(db, pm.id);
              logs.push(`↩ Recovery OK (move confirmado en metadata): ${pm.carpeta_email}`);
              continue;
            }
          } catch { /* metadata ilegible */ }
        }
      }

      // Caso 2: buscar mensaje en Inbox por internetMessageId y reintentar move
      if (!pm.message_id) {
        failPendingMove(db, pm.id);
        logs.push(`⚠ Recovery FALLIDO (sin message_id): ${pm.carpeta_email ?? pm.id}`);
        continue;
      }

      const found = await findMessageInInbox(token, config.emailUser, pm.message_id);
      if (found) {
        try {
          await moveMessage(token, config.emailUser, found.id, pm.carpeta_destino);
          completePendingMove(db, pm.id);
          logs.push(`↩ Recovery OK (re-movido desde Inbox): Message-ID=${pm.message_id}`);
        } catch (e) {
          logs.push(`⚠ Recovery: no se pudo mover desde Inbox: ${String(e)}`);
        }
      } else {
        // No encontrado en Inbox → asumimos que llegó a staging o se perdió
        failPendingMove(db, pm.id);
        logs.push(`⚠ Recovery FALLIDO (no encontrado en Inbox): Message-ID=${pm.message_id}`);
      }
    }
  } catch (e) {
    logs.push(`⚠ Recovery Microsoft: error de conexión: ${String(e)}`);
  }

  return logs;
}

async function moveToSandra(imapClient: ImapFlow, uid: number, sandraFolder: string): Promise<void> {
  try {
    await imapClient.messageMove(String(uid), sandraFolder, { uid: true });
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

  if (config.emailProvider === "microsoft") {
    return recoverPendingMovesMicrosoft(config, db, pending);
  }

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
      // Caso 1: archivos completos en disco Y move IMAP confirmado → solo completar en DB
      if (pm.carpeta_email) {
        const metaPath = path.join(pm.carpeta_email, "correo_metadata.json");
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
            if (meta.imap_move_complete === true) {
              completePendingMove(db, pm.id);
              logs.push(`↩ Recovery OK (archivos presentes, move confirmado): ${pm.carpeta_email}`);
              continue;
            }
            // imap_move_complete=false o ausente: archivos en disco pero move no ocurrió aún.
            // Caer a caso 2 para re-intentar el move desde INBOX.
          } catch { /* metadata ilegible — caer a caso 2 */ }
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

async function runMicrosoft(config: ReturnType<typeof getConfig>): Promise<StepResult> {
  const result: StepResult = { procesados: 0, errores: 0, saltados: 0, detalles: [] };

  if (!config.emailUser || !config.msClientId || !config.msTenantId || !config.msClientSecret) {
    result.detalles.push("Faltan credenciales Microsoft Graph (MS_CLIENT_ID, MS_TENANT_ID, MS_CLIENT_SECRET)");
    return result;
  }

  let clientNits = CLIENT_NITS;
  let clientKeywords = CLIENT_TEXT_KEYWORDS;
  try {
    const lists = loadClientListsFromDb(getDb());
    if (lists.nits.length > 0) { clientNits = lists.nits; clientKeywords = lists.keywords; }
  } catch { /* DB podría no existir aún */ }

  try {
    const {
      getAccessToken, getOrCreateInboxChildFolder,
      listInboxMessages, getMessageWithAttachments,
      moveMessage: graphMove, markAsRead,
    } = await import("../microsoft-graph");

    const token = await getAccessToken(config.msTenantId, config.msClientId, config.msClientSecret);
    const stagingFolderId = await getOrCreateInboxChildFolder(token, config.emailUser, config.stagingFolderName);
    const sandraFolderId  = await getOrCreateInboxChildFolder(token, config.emailUser, config.manualReviewFolderName);

    const messages = await listInboxMessages(token, config.emailUser, config.processUnreadOnly);
    if (messages.length === 0) {
      result.detalles.push(`No hay ${config.processUnreadOnly ? "no leídos en INBOX" : "correos en INBOX"}`);
      return result;
    }
    result.detalles.push(`Revisando INBOX: ${messages.length} ${config.processUnreadOnly ? "no leído(s)" : "correo(s)"}`);

    const createdFolders = new Set<string>();

    for (const msg of messages) {
      try {
        const subject    = msg.subject ?? "Sin asunto";
        const sender     = msg.from?.emailAddress?.address ?? "";
        const dateHeader = msg.receivedDateTime ?? new Date().toISOString();

        if (subject.includes("[OrderLoader]")) {
          result.detalles.push(`INBOX (notif OrderLoader): "${subject}"`);
          continue;
        }

        const fullMsg          = await getMessageWithAttachments(token, config.emailUser, msg.id);
        const internetMsgId    = fullMsg.internetMessageId ?? "";
        const parsedText       = fullMsg.body?.contentType === "text"
          ? (fullMsg.body.content ?? "")
          : (fullMsg.body?.content?.replace(/<[^>]+>/g, " ") ?? "");

        const pdfAttachments:   AttachmentInfo[] = [];
        const otherAttachments: AttachmentInfo[] = [];

        for (const att of fullMsg.attachments ?? []) {
          if (att["@odata.type"] !== "#microsoft.graph.fileAttachment" || !att.name || !att.contentBytes) continue;
          const safeName = clean(att.name) || "adjunto";
          const content  = Buffer.from(att.contentBytes, "base64");
          const info: AttachmentInfo = { filename: safeName, content };
          if (safeName.toLowerCase().endsWith(".pdf")) pdfAttachments.push(info);
          else otherAttachments.push(info);
        }

        if (pdfAttachments.length === 0) {
          await graphMove(token, config.emailUser, msg.id, sandraFolderId);
          result.saltados++;
          result.detalles.push(`SANDRA (sin PDF): "${subject}" de ${sender}`);
          continue;
        }

        const pdfTexts    = new Map<string, string>();
        const clasificados = await clasificarPdfs(pdfAttachments, clientNits, clientKeywords, config.receptorKeywords, pdfTexts);

        const triageResponse = await ejecutarTriageIA(clasificados, otherAttachments, pdfTexts, clientNits, subject, config.tenantDisplayName);
        const triageResults  = triageResponse?.results ?? null;

        const finalClasificados = clasificados.map(pdf => {
          const ia = triageResults?.find(r => r.filename === pdf.filename);
          if (!ia) return pdf;
          if (pdf.detectionMethod === "nit") {
            if (!pdf.isApprovedOC && ia.tipo === "orden_compra") return { ...pdf, isApprovedOC: true };
            return pdf;
          }
          if (pdf.detectionMethod === "keyword") {
            if (ia.tipo !== "orden_compra") return { ...pdf, isApprovedOC: false };
            if (ia.cliente && ia.cliente !== pdf.client) return { ...pdf, client: ia.cliente, isApprovedOC: pdf.isDirigidoAEmpresa };
          }
          if (pdf.detectionMethod === null && ia.tipo === "orden_compra" && ia.cliente) {
            const clientExists = clientNits.some(c => c.carpeta === ia.cliente);
            if (clientExists) return { ...pdf, client: ia.cliente, isApprovedOC: true };
          }
          return pdf;
        });

        const approvedPdfs = finalClasificados.filter(p => p.isApprovedOC);
        if (approvedPdfs.length === 0) {
          await graphMove(token, config.emailUser, msg.id, sandraFolderId);
          result.saltados++;
          result.detalles.push(`SANDRA (ningún PDF es OC aprobada): "${subject}" de ${sender}`);
          continue;
        }

        const nonSignatureOthers = otherAttachments.filter(att => {
          const ia = triageResults?.find(r => r.filename === att.filename);
          return ia ? ia.tipo !== "firma_logo" : true;
        });
        const hasExtraFiles = (approvedPdfs.length < pdfAttachments.length) || nonSignatureOthers.length > 0;

        const client_folder = approvedPdfs[0].client!;
        const ts = new Date().toISOString().replace(/[-:T]/g, c => c === "T" ? "_" : c).split(".")[0];
        let folderName = `${ts}_${clean(subject).slice(0, 50) || "sin_asunto"}`;
        let idx = 1;
        while (createdFolders.has(folderName)) {
          folderName = `${ts}_${clean(subject).slice(0, 50)}_${String(idx).padStart(2, "0")}`;
          idx++;
        }
        createdFolders.add(folderName);

        const pedidoPath = path.join(config.pedidosRawDir, client_folder, folderName);
        fs.mkdirSync(pedidoPath, { recursive: true });

        const bodyText = `De: ${sender}\nAsunto: ${subject}\nFecha: ${dateHeader}\n\n${parsedText}`;
        fs.writeFileSync(path.join(pedidoPath, "correo_original.txt"), bodyText, "utf8");

        for (const att of [...pdfAttachments, ...otherAttachments]) {
          fs.writeFileSync(path.join(pedidoPath, att.filename), att.content);
        }

        const approvedNames = approvedPdfs.map(p => p.filename).join(", ");
        const extraNames    = [
          ...finalClasificados.filter(p => !p.isApprovedOC).map(p => p.filename),
          ...nonSignatureOthers.map(a => a.filename),
        ].join(", ");

        const metadataBase = {
          from: sender, subject, date: dateHeader, client: client_folder,
          folder_local: `pedidos/raw/${client_folder}/${folderName}`,
          // IMAP fields null para provider microsoft
          imap_uid: null,
          imap_staging_folder: null,
          imap_move_complete: false,
          // Graph fields
          message_id: internetMsgId,
          graph_message_id: msg.id,
          graph_staging_folder_id: stagingFolderId,
          graph_move_complete: false,
          n_adjuntos_pdf: approvedPdfs.length,
          has_extra_files: hasExtraFiles,
          pdfs_aprobados: approvedNames,
          ...(hasExtraFiles ? { archivos_extra: extraNames } : {}),
          ...(triageResults ? { triage_ia: triageResults } : {}),
          ts_download: new Date().toISOString(),
        };
        fs.writeFileSync(path.join(pedidoPath, "correo_metadata.json"), JSON.stringify(metadataBase, null, 2), "utf8");
        fs.writeFileSync(path.join(pedidoPath, "estado_pipeline.json"), JSON.stringify({ fase: 0, estado: "DESCARGADO", ts: new Date().toISOString() }, null, 2), "utf8");

        let pendingMoveId: number | null = null;
        try {
          pendingMoveId = insertPendingMove(getDb(), internetMsgId, 0, "Inbox", stagingFolderId, pedidoPath);
        } catch { /* DB podría no estar disponible aún */ }

        let newGraphMessageId = msg.id;
        let graphMoveOk = false;
        try {
          const moved = await graphMove(token, config.emailUser, msg.id, stagingFolderId);
          newGraphMessageId = moved.id;
          graphMoveOk = true;
        } catch {
          try { await markAsRead(token, config.emailUser, msg.id); } catch { /* ignorar */ }
        }

        fs.writeFileSync(
          path.join(pedidoPath, "correo_metadata.json"),
          JSON.stringify({ ...metadataBase, graph_message_id: newGraphMessageId, graph_move_complete: graphMoveOk, imap_move_complete: graphMoveOk }, null, 2),
          "utf8"
        );

        try {
          const db = getDb();
          logPipeline(db, folderName, 0, "download", "OK",
            `Graph cliente=${client_folder} PDFs_OC=${approvedPdfs.length} extras=${hasExtraFiles}`);
          if (triageResponse) {
            logPipeline(db, folderName, 0, "triage", "OK",
              `adjuntos=${clasificados.length + otherAttachments.length}`,
              triageResponse.inputTokens, triageResponse.outputTokens, TRIAGE_MODEL);
          }
          if (pendingMoveId !== null && graphMoveOk) completePendingMove(db, pendingMoveId);
        } catch { /* DB might not exist yet */ }

        result.procesados++;
        const triageMsg = triageResults
          ? ` [triage IA: ${triageResults.map(r => `${r.filename}→${r.tipo}`).join(", ")}]`
          : " [triage IA: no disponible]";
        const extraMsg = hasExtraFiles ? ` ⚠ archivos extras: ${extraNames}` : "";
        result.detalles.push(`OK: pedidos/raw/${client_folder}/${folderName} (${approvedPdfs.length} OC PDF)${extraMsg}${triageMsg}`);

        break; // un solo pedido por llamada
      } catch (e) {
        result.errores++;
        result.detalles.push(`ERROR en mensaje: ${String(e)}`);
      }
    }

    if (result.procesados === 0 && result.saltados === 0 && result.errores === 0) {
      result.detalles.push("No hay pedidos pendientes en INBOX (solo notificaciones OrderLoader)");
    }
  } catch (e) {
    result.errores++;
    result.detalles.push(`Error de conexión Microsoft Graph: ${String(e)}`);
  }

  return result;
}

export async function run(): Promise<StepResult> {
  const config = getConfig();
  ensureWorkspaceDirs();

  if (config.emailProvider === "microsoft") return runMicrosoft(config);

  const result: StepResult = { procesados: 0, errores: 0, saltados: 0, detalles: [] };

  if (!config.emailUser || !config.emailPass || !config.emailHost) {
    result.detalles.push("Faltan credenciales de email en .env.local");
    return result;
  }

  // Cargar clientes desde DB; fallback a hardcoded si DB no disponible
  let clientNits = CLIENT_NITS;
  let clientKeywords = CLIENT_TEXT_KEYWORDS;
  try {
    const lists = loadClientListsFromDb(getDb());
    if (lists.nits.length > 0) { clientNits = lists.nits; clientKeywords = lists.keywords; }
  } catch { /* DB podría no existir aún en primer arranque */ }

  const imapClient = new ImapFlow({
    host: config.emailHost,
    port: config.emailPort,
    secure: true,
    auth: { user: config.emailUser, pass: config.emailPass },
    logger: false,
  });

  try {
    await imapClient.connect();
    const imapSandraFolder  = `INBOX.${config.manualReviewFolderName}`;
    const imapStagingFolder = `INBOX.${config.stagingFolderName}`;
    await imapClient.mailboxCreate(imapSandraFolder).catch(() => {});
    await imapClient.mailboxCreate(imapStagingFolder).catch(() => {});

    const lock = await imapClient.getMailboxLock("INBOX");
    const createdFolders = new Set<string>();

    try {
      const messages = [];
      for await (const msg of imapClient.fetch("1:*", {
        uid: true, flags: true, envelope: true, source: true,
      })) {
        if (config.processUnreadOnly && msg.flags?.has("\\Seen")) continue;
        messages.push(msg);
      }

      if (messages.length === 0) {
        const motive = config.processUnreadOnly ? "no leídos en INBOX" : "correos en INBOX";
        result.detalles.push(`No hay ${motive}`);
        return result;
      }

      const modeLabel = config.processUnreadOnly ? "no leído(s)" : "correo(s)";
      result.detalles.push(`Revisando INBOX: ${messages.length} ${modeLabel}`);

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
            await moveToSandra(imapClient, msg.uid, imapSandraFolder);
            result.saltados++;
            result.detalles.push(`SANDRA (sin PDF): "${subject}" de ${sender}`);
            continue;
          }

          // ── 4. Clasificar cada PDF por su contenido interno ───────────────────
          const pdfTexts = new Map<string, string>();
          const clasificados = await clasificarPdfs(pdfAttachments, clientNits, clientKeywords, config.receptorKeywords, pdfTexts);

          // ── 5. Triage IA: confirma cliente y filtra firmas/logos ──────────────
          const triageResponse = await ejecutarTriageIA(clasificados, otherAttachments, pdfTexts, clientNits, subject, config.tenantDisplayName);
          const triageResults: TriageResult[] | null = triageResponse?.results ?? null;

          // Ajustar clasificación de PDFs según IA
          const finalClasificados = clasificados.map(pdf => {
            const ia = triageResults?.find(r => r.filename === pdf.filename);
            if (!ia) return pdf;

            // NIT match: la IA puede ELEVAR isApprovedOC si isTamaprint fue false
            // (ej. PDF escaneado o que no menciona "Tamaprint" explícitamente en el texto).
            // La IA no puede revocar un NIT confirmado.
            if (pdf.detectionMethod === 'nit') {
              if (!pdf.isApprovedOC && ia.tipo === 'orden_compra') {
                return { ...pdf, isApprovedOC: true };
              }
              return pdf;
            }

            // keyword match: la IA decide
            if (pdf.detectionMethod === 'keyword') {
              if (ia.tipo !== 'orden_compra') {
                return { ...pdf, isApprovedOC: false };
              }
              // Si la IA identifica un cliente diferente, usar el de la IA si existe en lista aprobada
              if (ia.cliente && ia.cliente !== pdf.client) {
                return { ...pdf, client: ia.cliente, isApprovedOC: pdf.isDirigidoAEmpresa };
              }
            }

            // Sin detección heurística → la IA es el único detector disponible
            if (pdf.detectionMethod === null && ia.tipo === 'orden_compra' && ia.cliente) {
              const clientExists = clientNits.some(c => c.carpeta === ia.cliente);
              if (clientExists) {
                return { ...pdf, client: ia.cliente, isApprovedOC: true };
              }
            }

            return pdf;
          });

          const approvedPdfs = finalClasificados.filter(p => p.isApprovedOC);

          if (approvedPdfs.length === 0) {
            await moveToSandra(imapClient, msg.uid, imapSandraFolder);
            result.saltados++;
            result.detalles.push(`SANDRA (ningún PDF es OC aprobada): "${subject}" de ${sender}`);
            continue;
          }

          // ── 6. Determinar si hay "extras" (excluir firmas/logos identificados por IA) ──
          const nonSignatureOthers = otherAttachments.filter(att => {
            const ia = triageResults?.find(r => r.filename === att.filename);
            return ia ? ia.tipo !== 'firma_logo' : true;
          });
          const hasExtraFiles = (approvedPdfs.length < pdfAttachments.length) || nonSignatureOthers.length > 0;

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

          const approvedNames = approvedPdfs.map(p => p.filename).join(", ");
          const extraNames    = [
            ...finalClasificados.filter(p => !p.isApprovedOC).map(p => p.filename),
            ...nonSignatureOthers.map(a => a.filename),
          ].join(", ");

          // Escribir metadata ANTES del move IMAP: si el proceso cae entre aquí y el
          // messageMove, recoverPendingMoves encuentra los archivos completos en disco y
          // puede re-intentar el move desde INBOX sin perder el correo.
          // imap_move_complete=false indica que el move aún no ocurrió.
          const metadataBase = {
            from: sender,
            subject,
            date: dateHeader,
            client: client_folder,
            folder_local: `pedidos/raw/${client_folder}/${folderName}`,
            imap_uid: msg.uid,
            message_id: messageId,
            imap_staging_folder: imapStagingFolder,
            n_adjuntos_pdf: approvedPdfs.length,
            has_extra_files: hasExtraFiles,
            pdfs_aprobados: approvedNames,
            ...(hasExtraFiles ? { archivos_extra: extraNames } : {}),
            ...(triageResults ? { triage_ia: triageResults } : {}),
            ts_download: new Date().toISOString(),
            imap_move_complete: false,
          };
          fs.writeFileSync(
            path.join(pedidoPath, "correo_metadata.json"),
            JSON.stringify(metadataBase, null, 2),
            "utf8"
          );

          fs.writeFileSync(
            path.join(pedidoPath, "estado_pipeline.json"),
            JSON.stringify({ fase: 0, estado: "DESCARGADO", ts: new Date().toISOString() }, null, 2),
            "utf8"
          );

          // Registrar intención de mover ANTES de ejecutar el move.
          let pendingMoveId: number | null = null;
          try {
            const db = getDb();
            pendingMoveId = insertPendingMove(db, messageId, msg.uid, "INBOX", imapStagingFolder, pedidoPath);
          } catch { /* DB podría no estar disponible aún */ }

          // Mover a staging — capturar nuevo UID para que step7 lo mueva al final
          let storedUid = msg.uid;
          let imapMoveOk = false;
          try {
            const moveResult = await imapClient.messageMove(String(msg.uid), imapStagingFolder, { uid: true });
            const newUid = (moveResult as { uidMap?: Map<number, number> })?.uidMap?.get(msg.uid);
            if (newUid) storedUid = newUid;
            imapMoveOk = true;
          } catch {
            try { await imapClient.messageFlagsAdd(String(msg.uid), ["\\Seen"], { uid: true }); } catch { /* ignorar */ }
          }

          // Actualizar metadata con el UID final y el estado real del move.
          // imap_move_complete=false significa que recoverPendingMoves debe reintentar el move.
          fs.writeFileSync(
            path.join(pedidoPath, "correo_metadata.json"),
            JSON.stringify({ ...metadataBase, imap_uid: storedUid, imap_move_complete: imapMoveOk }, null, 2),
            "utf8"
          );

          try {
            const db = getDb();
            logPipeline(db, folderName, 0, "download", "OK",
              `UID=${storedUid} cliente=${client_folder} PDFs_OC=${approvedPdfs.length} extras=${hasExtraFiles}`);
            if (triageResponse) {
              logPipeline(db, folderName, 0, "triage", "OK",
                `adjuntos=${clasificados.length + otherAttachments.length}`,
                triageResponse.inputTokens, triageResponse.outputTokens, TRIAGE_MODEL);
            }
            // Solo completar el pending_move si el move IMAP ocurrió realmente.
            // Si falló, queda PENDING para que recoverPendingMoves lo reintente.
            if (pendingMoveId !== null && imapMoveOk) completePendingMove(db, pendingMoveId);
          } catch { /* DB might not exist yet */ }

          result.procesados++;
          const triageMsg = triageResults ? ` [triage IA: ${triageResults.map(r => `${r.filename}→${r.tipo}`).join(', ')}]` : ' [triage IA: no disponible]';
          const extraMsg  = hasExtraFiles ? ` ⚠ archivos extras: ${extraNames}` : "";
          result.detalles.push(`OK: pedidos/raw/${client_folder}/${folderName} (${approvedPdfs.length} OC PDF)${extraMsg}${triageMsg}`);

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
