/**
 * Step 7: Archivar correos originales en IMAP y cerrar pedidos.
 *
 * Los correos llegan a este step en "A A REVISAR IA" (destino inicial de step0).
 * Para cada pedido en estado NOTIFICADO:
 *   - Determina destino final según resultado:
 *       Limpio, sin archivos extra → "A B INGRESADO"   (mover desde REVISAR IA)
 *       Limpio + archivos extra    → "A A SANDRA"       (mover desde REVISAR IA)
 *       Con diferencias / error    → "A A REVISAR IA"   (ya está, no mover)
 *   - Marca el pedido como CERRADO
 *
 * Si step7 falla a mitad, los correos no movidos quedan en "A A REVISAR IA"
 * — estado seguro, visible para humanos, nunca se pierden.
 *
 * Además limpia huérfanos: cualquier email en staging cuya OC ya
 * está CERRADO se archiva al mismo destino.
 *
 * Usa Message-ID del email para encontrar el UID real en staging,
 * ya que el UID capturado en step0 puede ser el de INBOX (pre-move)
 * cuando el servidor no soporta UIDPLUS.
 *
 * NOTIFICADO → CERRADO
 */

import fs from "fs";
import path from "path";
import { ImapFlow } from "imapflow";
import { getConfig } from "../config";
import { getDb, logPipeline } from "../db";

export interface StepResult {
  procesados: number;
  errores: number;
  saltados: number;
  detalles: string[];
}

const SOURCE_FOLDER = "INBOX.A A REVISAR IA";  // fallback: step0 guarda imap_staging_folder en metadata
const DEST_OK       = "INBOX.A B INGRESADO";   // destino para pedidos limpios (mover desde REVISAR IA)
const DEST_REVISAR  = "INBOX.A A REVISAR IA";
const DEST_SANDRA   = "INBOX.A A SANDRA";

function isLimpio(row: Record<string, unknown>): boolean {
  if (row.error_msg) return false;
  try {
    const excluidos = JSON.parse(String(row.items_excluidos ?? "[]"));
    if (!Array.isArray(excluidos) || excluidos.length > 0) return false;
  } catch { return false; }
  try {
    const val = JSON.parse(String(row.validacion_resultado ?? "null"));
    if (val && typeof val === "object" && "ok" in val) return (val as { ok: boolean }).ok === true;
  } catch { /* sin reconciliación */ }
  return true;
}

type MoveJob = {
  uid: number;
  messageId?: string;
  source: string;
  dest: string;
  graphMessageId?: string;
  graphDestFolderName?: string;
};

/** Lee todos los correo_metadata.json bajo pedidosRawDir y agrupa UIDs por orden_compra.
 *
 * Vías para identificar la OC de una carpeta de email:
 *   1. Sub-carpetas nombradas con el número de OC (step1 procesó el PDF correctamente)
 *   2. Archivos *.done cuyo contenido es el número de OC (step1 saltó → OC en proceso)
 *   3. Archivos *.retries o *.error → OC en el nombre del archivo (ej: 4500288469.PDF.retries)
 */
function collectStagingUids(
  pedidosRawDir: string
): Map<string, { uid: number; messageId?: string; hasExtraFiles: boolean; source: string; graphMessageId?: string }[]> {
  const byOC = new Map<string, { uid: number; messageId?: string; hasExtraFiles: boolean; source: string; graphMessageId?: string }[]>();
  if (!fs.existsSync(pedidosRawDir)) return byOC;

  for (const cliente of fs.readdirSync(pedidosRawDir)) {
    const clienteDir = path.join(pedidosRawDir, cliente);
    if (!fs.statSync(clienteDir).isDirectory()) continue;
    for (const carpeta of fs.readdirSync(clienteDir)) {
      const carpetaPath = path.join(clienteDir, carpeta);
      if (!fs.statSync(carpetaPath).isDirectory()) continue;
      const metaPath = path.join(carpetaPath, "correo_metadata.json");
      if (!fs.existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        const isGraph = meta.graph_message_id && !meta.imap_uid;
        if (!meta.imap_uid && !meta.graph_message_id) continue;
        const uid           = Number(meta.imap_uid ?? 0);
        const source        = String(meta.imap_staging_folder ?? "A A REVISAR IA");
        const messageId     = meta.message_id as string | undefined;
        const hasExtraFiles = meta.has_extra_files === true;
        const graphMessageId = isGraph ? String(meta.graph_message_id) : undefined;
        const ocs           = new Set<string>();

        for (const entry of fs.readdirSync(carpetaPath)) {
          const entryPath = path.join(carpetaPath, entry);
          // Vía 1: sub-carpeta nombrada con la OC
          if (fs.statSync(entryPath).isDirectory()) {
            ocs.add(entry);
          }
          // Vía 2: archivo .done cuyo contenido es el número de OC
          else if (entry.endsWith(".done")) {
            try {
              const oc = fs.readFileSync(entryPath, "utf8").trim();
              if (oc) ocs.add(oc);
            } catch { /* skip */ }
          }
          // Vía 3: archivo .retries / .error → OC en el nombre (ej: 4500288469.PDF.retries)
          else if (entry.endsWith(".retries") || entry.endsWith(".error")) {
            const stem = entry.replace(/\.(retries|error)$/i, "").replace(/\.[^.]+$/, "");
            if (stem) ocs.add(stem);
          }
        }

        for (const oc of ocs) {
          const list = byOC.get(oc) ?? [];
          list.push({ uid, messageId, hasExtraFiles, source, graphMessageId });
          byOC.set(oc, list);
        }
      } catch { /* skip */ }
    }
  }
  return byOC;
}

async function moveInGraph(
  config: ReturnType<typeof getConfig>,
  moveJobs: MoveJob[],
  detalles: string[]
): Promise<void> {
  const jobsToMove = moveJobs.filter(j => j.graphMessageId && j.graphDestFolderName && j.graphDestFolderName !== "A A REVISAR IA");
  if (!jobsToMove.length) return;

  if (!config.msClientId || !config.msTenantId || !config.msClientSecret) {
    detalles.push("⚠ Faltan credenciales Microsoft Graph para archivar correos");
    return;
  }

  try {
    const { getAccessToken, getOrCreateInboxChildFolder, moveMessage } = await import("../microsoft-graph");
    const token = await getAccessToken(config.msTenantId, config.msClientId, config.msClientSecret);

    // Resolver IDs de carpetas de destino
    const folderIds = new Map<string, string>();
    const folderNames = [...new Set(jobsToMove.map(j => j.graphDestFolderName!))];
    for (const name of folderNames) {
      folderIds.set(name, await getOrCreateInboxChildFolder(token, config.emailUser, name));
    }

    for (const job of jobsToMove) {
      const destId = folderIds.get(job.graphDestFolderName!);
      if (!destId || !job.graphMessageId) continue;
      try {
        await moveMessage(token, config.emailUser, job.graphMessageId, destId);
        detalles.push(`✓ Correo Graph → ${job.graphDestFolderName}`);
      } catch (e) {
        detalles.push(`⚠ No se pudo mover Graph a ${job.graphDestFolderName}: ${String(e).slice(0, 100)}`);
      }
    }
  } catch (e) {
    detalles.push(`⚠ Error Graph archive: ${String(e).slice(0, 100)}`);
  }
}

async function moveInImap(
  config: ReturnType<typeof getConfig>,
  moveJobs: MoveJob[],
  detalles: string[]
): Promise<void> {
  if (!moveJobs.length || !config.emailUser || !config.emailPass || !config.emailHost) return;

  // Filtrar jobs donde src == dest (DEST_REVISAR = REVISAR IA = staging, ya están ahí)
  const jobsToMove = moveJobs.filter(j => j.dest !== j.source);
  if (!jobsToMove.length) return;

  // Agrupar por carpeta fuente
  const bySrc = new Map<string, MoveJob[]>();
  for (const job of jobsToMove) {
    const list = bySrc.get(job.source) ?? [];
    list.push(job);
    bySrc.set(job.source, list);
  }

  for (const [srcFolder, jobs] of bySrc.entries()) {
    try {
      const imap = new ImapFlow({
        host: config.emailHost, port: config.emailPort, secure: true,
        auth: { user: config.emailUser, pass: config.emailPass },
        logger: false,
      });
      await imap.connect();
      const lock = await imap.getMailboxLock(srcFolder);
      try {
        try { await imap.mailboxCreate(DEST_REVISAR); } catch { /* ya existe */ }
        try { await imap.mailboxCreate(DEST_SANDRA); } catch { /* ya existe */ }

        // ── Construir mapa: messageId → UIDs actuales en la carpeta fuente ──
        // Usa el envelope IMAP que incluye messageId directamente.
        const byMsgId = new Map<string, number[]>();
        try {
          for await (const msg of imap.fetch("1:*", { uid: true, envelope: true }, { uid: true })) {
            const mid = msg.envelope?.messageId;
            if (mid) {
              const list = byMsgId.get(mid) ?? [];
              list.push(msg.uid);
              byMsgId.set(mid, list);
            }
          }
        } catch { /* si falla el scan, usamos UIDs almacenados como fallback */ }

        // ── Agrupar por destino, resolviendo UIDs via Message-ID ──
        const byDest = new Map<string, Set<number>>();
        for (const job of jobs) {
          const s = byDest.get(job.dest) ?? new Set<number>();
          let resolved = false;
          if (job.messageId) {
            const found = byMsgId.get(job.messageId) ?? [];
            for (const u of found) s.add(u);
            if (found.length > 0) resolved = true;
          }
          if (!resolved) s.add(job.uid); // fallback: UID almacenado en correo_metadata.json
          byDest.set(job.dest, s);
        }

        for (const [dest, uidSet] of byDest.entries()) {
          if (uidSet.size === 0) continue;
          const uids = [...uidSet].map(String).join(",");
          await imap.messageMove(uids, dest, { uid: true });
          detalles.push(`✓ ${uidSet.size} correo(s) ${srcFolder} → ${dest}`);
        }
      } finally {
        lock.release();
      }
      await imap.logout();
    } catch (e) {
      detalles.push(`⚠ No se pudo mover desde ${srcFolder}: ${String(e).slice(0, 100)}`);
    }
  }
}

export async function run(): Promise<StepResult> {
  const config = getConfig();
  const result: StepResult = { procesados: 0, errores: 0, saltados: 0, detalles: [] };
  const db = getDb();

  // ── 1. Pedidos NOTIFICADO: archivar y cerrar ─────────────────────────────
  const pendientes = db.prepare(
    "SELECT * FROM pedidos_maestro WHERE estado = 'NOTIFICADO'"
  ).all() as Array<Record<string, unknown>>;

  const destByOrden: Record<string, string> = {};
  const moveJobs: MoveJob[] = [];

  for (const row of pendientes) {
    const carpeta = row.carpeta_origen as string | null;
    if (!carpeta) continue;
    try {
      const meta           = JSON.parse(fs.readFileSync(path.join(carpeta, "correo_metadata.json"), "utf8"));
      const isGraph        = meta.graph_message_id && !meta.imap_uid;
      if (!meta.imap_uid && !meta.graph_message_id) continue;
      const uid            = Number(meta.imap_uid ?? 0);
      const messageId      = meta.message_id as string | undefined;
      const graphMessageId = isGraph ? String(meta.graph_message_id) : undefined;
      const src            = meta.imap_staging_folder ?? SOURCE_FOLDER;
      const destImap       = isLimpio(row)
        ? (meta.has_extra_files === true ? DEST_SANDRA : DEST_OK)
        : DEST_REVISAR;
      // Para Graph, solo los nombres "cortos" sin prefijo INBOX.
      const destName       = isLimpio(row)
        ? (meta.has_extra_files === true ? "A A SANDRA" : "A B INGRESADO")
        : "A A REVISAR IA";
      moveJobs.push({ uid, messageId, source: src, dest: destImap, graphMessageId, graphDestFolderName: destName });
      destByOrden[String(row.orden_compra)] = destImap;
    } catch { /* metadata no disponible */ }
  }

  // Deduplicar por messageId: varios pedidos pueden venir del mismo correo.
  // Si un correo tiene múltiples OCs, se mueve UNA sola vez al destino más restrictivo
  // (REVISAR_IA > SANDRA > INGRESADO) para no intentar mover el mismo UID dos veces.
  const DEST_PRIORITY: Record<string, number> = { [DEST_REVISAR]: 2, [DEST_SANDRA]: 1, [DEST_OK]: 0 };
  const byMessageId = new Map<string, MoveJob>();
  for (const job of moveJobs) {
    const key = job.messageId ?? `uid:${job.uid}`;
    const existing = byMessageId.get(key);
    if (!existing || (DEST_PRIORITY[job.dest] ?? 0) > (DEST_PRIORITY[existing.dest] ?? 0)) {
      byMessageId.set(key, job);
    }
  }
  const dedupedMoveJobs = [...byMessageId.values()];

  if (config.emailProvider === "microsoft") {
    await moveInGraph(config, dedupedMoveJobs, result.detalles);
  } else {
    await moveInImap(config, dedupedMoveJobs, result.detalles);
  }

  // Marcar CERRADO en DB
  if (pendientes.length > 0) {
    db.transaction(() => {
      for (const row of pendientes) {
        const oc   = String(row.orden_compra);
        const dest = destByOrden[oc] ?? DEST_REVISAR;
        db.prepare("UPDATE pedidos_maestro SET estado='CERRADO', fase_actual=7 WHERE orden_compra=?").run(oc);
        logPipeline(db, oc, 7, "archive", "OK", `CERRADO → ${dest}`);
      }
    })();
    result.procesados = pendientes.length;
    result.detalles.push(`✓ ${pendientes.length} pedido(s) → CERRADO`);
  } else {
    result.detalles.push("No hay pedidos en estado NOTIFICADO");
  }

  // ── 2. Huérfanos: emails en staging cuya OC ya está CERRADO ─────────────
  try {
    const stagingByOC = collectStagingUids(config.pedidosRawDir);
    if (stagingByOC.size > 0) {
      const cerrados = db.prepare(
        "SELECT * FROM pedidos_maestro WHERE estado = 'CERRADO'"
      ).all() as Array<Record<string, unknown>>;

      const cerradoMap = new Map(cerrados.map(r => [String(r.orden_compra), r]));

      const orphanJobsRaw: MoveJob[] = [];
      for (const [oc, entries] of stagingByOC.entries()) {
        const row = cerradoMap.get(oc);
        if (!row) continue;
        for (const { uid, messageId, hasExtraFiles, source, graphMessageId } of entries) {
          const dest     = isLimpio(row) ? (hasExtraFiles ? DEST_SANDRA : DEST_OK) : DEST_REVISAR;
          const destName = isLimpio(row) ? (hasExtraFiles ? "A A SANDRA" : "A B INGRESADO") : "A A REVISAR IA";
          orphanJobsRaw.push({ uid, messageId, source, dest, graphMessageId, graphDestFolderName: destName });
        }
      }

      // Deduplicar huérfanos por messageId: mismo correo puede aparecer en múltiples OCs
      const orphanByMsgId = new Map<string, MoveJob>();
      for (const job of orphanJobsRaw) {
        const key = job.messageId ?? `uid:${job.uid}`;
        const existing = orphanByMsgId.get(key);
        if (!existing || (DEST_PRIORITY[job.dest] ?? 0) > (DEST_PRIORITY[existing.dest] ?? 0)) {
          orphanByMsgId.set(key, job);
        }
      }
      const orphanJobs = [...orphanByMsgId.values()];

      if (orphanJobs.length > 0) {
        if (config.emailProvider === "microsoft") {
          await moveInGraph(config, orphanJobs, result.detalles);
        } else {
          await moveInImap(config, orphanJobs, result.detalles);
        }
        result.detalles.push(`✓ ${orphanJobs.length} correo(s) huérfano(s) archivados`);
        result.saltados += orphanJobs.length;
      }
    }
  } catch (e) {
    result.detalles.push(`⚠ Error limpiando huérfanos: ${String(e).slice(0, 100)}`);
  }

  return result;
}
