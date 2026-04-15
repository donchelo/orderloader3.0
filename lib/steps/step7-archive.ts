/**
 * Step 7: Archivar correos originales en IMAP y cerrar pedidos.
 *
 * Para cada pedido en estado NOTIFICADO:
 *   - Determina destino según resultado:
 *       Sin diferencias ni excluidos → "A A INGRESADO"
 *       Con diferencias, excluidos o error → "A A REVISAR IA"
 *   - Marca el pedido como CERRADO
 *
 * Además limpia huérfanos: cualquier email en staging cuya OC ya
 * está CERRADO (duplicados del loop bug) se archiva al mismo destino.
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

const SOURCE_FOLDER = "A A EN PROCESO IA";
const DEST_OK       = "A A INGRESADO";
const DEST_REVISAR  = "A A REVISAR IA";

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

type MoveJob = { uid: number; source: string; dest: string };

/** Lee todos los correo_metadata.json bajo pedidosRawDir y agrupa UIDs por orden_compra.
 *
 * Dos vías para identificar la OC de una carpeta de email:
 *   1. Sub-carpetas nombradas con el número de OC (caso normal: step1 procesó el PDF)
 *   2. Archivos *.done cuyo contenido es el número de OC (caso: step1 saltó la OC porque
 *      ya estaba CERRADA, escribe el .done pero no crea sub-carpeta)
 */
function collectStagingUids(pedidosRawDir: string): Map<string, { uid: number; source: string }[]> {
  const byOC = new Map<string, { uid: number; source: string }[]>();
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
        if (!meta.imap_uid || !meta.imap_staging_folder) continue;
        const uid    = Number(meta.imap_uid);
        const source = String(meta.imap_staging_folder);
        const ocs    = new Set<string>();

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
        }

        for (const oc of ocs) {
          const list = byOC.get(oc) ?? [];
          list.push({ uid, source });
          byOC.set(oc, list);
        }
      } catch { /* skip */ }
    }
  }
  return byOC;
}

async function moveInImap(
  config: ReturnType<typeof getConfig>,
  moveJobs: MoveJob[],
  detalles: string[]
): Promise<void> {
  if (!moveJobs.length || !config.emailUser || !config.emailPass || !config.emailHost) return;

  // Agrupa por carpeta fuente
  const bySrc = new Map<string, MoveJob[]>();
  for (const job of moveJobs) {
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
        try { await imap.mailboxCreate(DEST_OK); } catch { /* ya existe */ }
        try { await imap.mailboxCreate(DEST_REVISAR); } catch { /* ya existe */ }

        // Agrupar por destino; deduplicar UIDs
        const byDest = new Map<string, Set<number>>();
        for (const job of jobs) {
          const s = byDest.get(job.dest) ?? new Set();
          s.add(job.uid);
          byDest.set(job.dest, s);
        }
        for (const [dest, uidSet] of byDest.entries()) {
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
      const meta = JSON.parse(fs.readFileSync(path.join(carpeta, "correo_metadata.json"), "utf8"));
      if (!meta.imap_uid) continue;
      const uid  = Number(meta.imap_uid);
      const src  = meta.imap_staging_folder ?? SOURCE_FOLDER;
      const dest = isLimpio(row) ? DEST_OK : DEST_REVISAR;
      moveJobs.push({ uid, source: src, dest });
      destByOrden[String(row.orden_compra)] = dest;
    } catch { /* metadata no disponible */ }
  }

  await moveInImap(config, moveJobs, result.detalles);

  // Marcar CERRADO en DB
  if (pendientes.length > 0) {
    db.transaction(() => {
      for (const row of pendientes) {
        const oc = String(row.orden_compra);
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
  // Sucede cuando el mismo email se descargó varias veces (loop bug) o
  // cuando el pipeline descargó un email cuya OC ya fue procesada antes.
  try {
    const stagingByOC = collectStagingUids(config.pedidosRawDir);
    if (stagingByOC.size > 0) {
      // Consultar cuáles de esas OCs están CERRADO
      const cerrados = db.prepare(
        "SELECT * FROM pedidos_maestro WHERE estado = 'CERRADO'"
      ).all() as Array<Record<string, unknown>>;

      const cerradoMap = new Map(cerrados.map(r => [String(r.orden_compra), r]));

      const orphanJobs: MoveJob[] = [];
      for (const [oc, entries] of stagingByOC.entries()) {
        const row = cerradoMap.get(oc);
        if (!row) continue;
        const dest = isLimpio(row) ? DEST_OK : DEST_REVISAR;
        for (const { uid, source } of entries) {
          orphanJobs.push({ uid, source, dest });
        }
      }

      if (orphanJobs.length > 0) {
        await moveInImap(config, orphanJobs, result.detalles);
        result.detalles.push(`✓ ${orphanJobs.length} correo(s) huérfano(s) archivados`);
        result.saltados += orphanJobs.length;
      }
    }
  } catch (e) {
    result.detalles.push(`⚠ Error limpiando huérfanos: ${String(e).slice(0, 100)}`);
  }

  return result;
}
