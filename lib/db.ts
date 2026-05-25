import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { getConfig } from "./config";
import { getLogger } from "./logger";

const log = getLogger("db");

export interface PedidoMaestro {
  id: number;
  nit_cliente: string;
  orden_compra: string;
  fecha_recepcion: string;
  fecha_solicitado: string;
  fecha_entrega_general: string;
  cliente_nombre: string;
  subtotal: number;
  estado: string;
  notas: string;
  fase_actual: number;
  ts_parsed: string | null;
  ts_sap_query: string | null;
  ts_sap_upload: string | null;
  ts_validated: string | null;
  ts_notified: string | null;
  sap_doc_entry: number | null;
  sap_doc_num: string | null;
  sap_existe: number | null;
  sap_query_resultado: string | null;
  validacion_resultado: string | null;
  items_excluidos: string | null;
  error_msg: string | null;
  carpeta_origen: string | null;
  notificacion_enviada: number | null;
}

export interface ImapPendingMove {
  id: number;
  message_id: string;
  uid_origen: number | null;
  carpeta_origen: string;
  carpeta_destino: string;
  carpeta_email: string | null;
  estado: "PENDIENTE" | "COMPLETADO" | "FALLIDO";
  ts_creado: string;
  ts_completado: string | null;
}

export interface PedidoDetalle {
  id: number;
  orden_compra: string;
  codigo_producto: string;
  descripcion: string;
  cantidad: number;
  precio_unitario: number;
  subtotal_item: number;
  fecha_entrega: string | null;
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  const config = getConfig();
  if (!fs.existsSync(config.dbPath)) {
    throw new Error(
      `orderloader.db no encontrado en ${config.dbPath}. Ejecuta migrate primero.`
    );
  }
  _db = new Database(config.dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  // Migración incremental: crear tabla si no existe en DBs anteriores al feature de clientes
  _db.exec(`
    CREATE TABLE IF NOT EXISTS clientes_aprobados (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      carpeta          TEXT NOT NULL UNIQUE,
      nombre           TEXT NOT NULL,
      nit_principal    TEXT NOT NULL,
      nits_json        TEXT NOT NULL DEFAULT '[]',
      keywords_json    TEXT NOT NULL DEFAULT '[]',
      card_code        TEXT NOT NULL,
      prompt           TEXT NOT NULL DEFAULT '',
      activo           INTEGER NOT NULL DEFAULT 1,
      ts_creado        TEXT DEFAULT (datetime('now')),
      ts_modificado    TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_clientes_nit ON clientes_aprobados(nit_principal);
  `);
  return _db;
}

export function migrate(): void {
  const config = getConfig();
  const db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS pedidos_maestro (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      nit_cliente           TEXT NOT NULL,
      orden_compra          TEXT NOT NULL UNIQUE,
      fecha_recepcion       TEXT DEFAULT (datetime('now')),
      fecha_solicitado      TEXT,
      fecha_entrega_general TEXT,
      cliente_nombre        TEXT,
      subtotal              REAL,
      estado                TEXT NOT NULL DEFAULT 'NUEVO',
      notas                 TEXT,
      fase_actual           INTEGER DEFAULT 0,
      ts_parsed             TEXT,
      ts_sap_query          TEXT,
      ts_sap_upload         TEXT,
      ts_validated          TEXT,
      ts_notified           TEXT,
      sap_doc_entry         INTEGER,
      sap_doc_num           TEXT,
      sap_existe            INTEGER,
      sap_query_resultado   TEXT,
      validacion_resultado  TEXT,
      items_excluidos       TEXT,
      error_msg             TEXT,
      carpeta_origen        TEXT
    );

    CREATE TABLE IF NOT EXISTS pedidos_detalle (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      orden_compra     TEXT NOT NULL REFERENCES pedidos_maestro(orden_compra),
      codigo_producto  TEXT NOT NULL,
      descripcion      TEXT,
      cantidad         REAL NOT NULL,
      precio_unitario  REAL NOT NULL,
      subtotal_item    REAL,
      fecha_entrega    TEXT
    );

    CREATE TABLE IF NOT EXISTS pipeline_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      orden_compra    TEXT,
      fase            INTEGER,
      fase_nombre     TEXT,
      estado_resultado TEXT,
      mensaje         TEXT,
      input_tokens    INTEGER,
      output_tokens   INTEGER,
      ts              TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS imap_pending_moves (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id       TEXT NOT NULL,
      uid_origen       INTEGER,
      carpeta_origen   TEXT NOT NULL,
      carpeta_destino  TEXT NOT NULL,
      carpeta_email    TEXT,
      estado           TEXT NOT NULL DEFAULT 'PENDIENTE',
      ts_creado        TEXT DEFAULT (datetime('now')),
      ts_completado    TEXT
    );

    CREATE TABLE IF NOT EXISTS clientes_aprobados (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      carpeta          TEXT NOT NULL UNIQUE,
      nombre           TEXT NOT NULL,
      nit_principal    TEXT NOT NULL,
      nits_json        TEXT NOT NULL DEFAULT '[]',
      keywords_json    TEXT NOT NULL DEFAULT '[]',
      card_code        TEXT NOT NULL,
      prompt           TEXT NOT NULL DEFAULT '',
      activo           INTEGER NOT NULL DEFAULT 1,
      ts_creado        TEXT DEFAULT (datetime('now')),
      ts_modificado    TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_maestro_estado ON pedidos_maestro(estado);
    CREATE INDEX IF NOT EXISTS idx_maestro_fecha  ON pedidos_maestro(fecha_recepcion);
    CREATE INDEX IF NOT EXISTS idx_detalle_oc     ON pedidos_detalle(orden_compra);
    CREATE INDEX IF NOT EXISTS idx_log_oc         ON pipeline_log(orden_compra);
    CREATE INDEX IF NOT EXISTS idx_pending_moves  ON imap_pending_moves(estado);
    CREATE INDEX IF NOT EXISTS idx_clientes_nit   ON clientes_aprobados(nit_principal);
  `);

  // Migraciones para columnas agregadas después de la creación inicial
  try { db.exec(`ALTER TABLE pedidos_maestro ADD COLUMN items_excluidos TEXT`); } catch { /* ya existe */ }
  try { db.exec(`ALTER TABLE pipeline_log ADD COLUMN input_tokens INTEGER`); } catch { /* ya existe */ }
  try { db.exec(`ALTER TABLE pipeline_log ADD COLUMN output_tokens INTEGER`); } catch { /* ya existe */ }
  try { db.exec(`ALTER TABLE pipeline_log ADD COLUMN model TEXT`); } catch { /* ya existe */ }
  try { db.exec(`ALTER TABLE pedidos_maestro ADD COLUMN notificacion_enviada INTEGER DEFAULT 0`); } catch { /* ya existe */ }
  try { db.exec(`ALTER TABLE pedidos_maestro ADD COLUMN costo_ia_usd REAL`); } catch { /* ya existe */ }

  db.close();
  log.info({ path: config.dbPath }, "DB migrada correctamente");
}

export function logPipeline(
  db: Database.Database,
  oc: string | null,
  fase: number,
  faseNombre: string,
  estado: "OK" | "ERROR" | "WARN",
  mensaje: string,
  inputTokens?: number,
  outputTokens?: number,
  model?: string
): void {
  db.prepare(
    `INSERT INTO pipeline_log (orden_compra, fase, fase_nombre, estado_resultado, mensaje, input_tokens, output_tokens, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(oc, fase, faseNombre, estado, mensaje, inputTokens ?? null, outputTokens ?? null, model ?? null);
}

export function backupDb(): string | null {
  const config = getConfig();
  if (!fs.existsSync(config.dbPath)) return null;

  try {
    const db = new Database(config.dbPath, { readonly: true });
    const count = (
      db.prepare("SELECT COUNT(*) as c FROM pedidos_maestro").get() as {
        c: number;
      }
    ).c;
    db.close();
    if (count === 0) return null;
  } catch {
    return null;
  }

  const ts = new Date()
    .toISOString()
    .replace(/[-:T]/g, (c) => (c === "T" ? "_" : c))
    .split(".")[0];
  fs.mkdirSync(config.pedidosBackupsDir, { recursive: true });
  const dest = path.join(config.pedidosBackupsDir, `orderloader_${ts}.db`);
  fs.copyFileSync(config.dbPath, dest);

  // Keep only the 7 most recent backups
  const backups = fs
    .readdirSync(config.pedidosBackupsDir)
    .filter((f) => f.startsWith("orderloader_") && f.endsWith(".db"))
    .sort();
  for (const old of backups.slice(0, -7)) {
    try {
      fs.unlinkSync(path.join(config.pedidosBackupsDir, old));
    } catch {
      /* ignore */
    }
  }

  return dest;
}

export function insertPendingMove(
  db: Database.Database,
  messageId: string,
  uidOrigen: number | null,
  carpetaOrigen: string,
  carpetaDestino: string,
  carpetaEmail?: string
): number {
  const result = db.prepare(
    `INSERT INTO imap_pending_moves (message_id, uid_origen, carpeta_origen, carpeta_destino, carpeta_email)
     VALUES (?, ?, ?, ?, ?)`
  ).run(messageId, uidOrigen ?? null, carpetaOrigen, carpetaDestino, carpetaEmail ?? null);
  return result.lastInsertRowid as number;
}

export function completePendingMove(db: Database.Database, id: number): void {
  db.prepare(
    `UPDATE imap_pending_moves SET estado='COMPLETADO', ts_completado=datetime('now') WHERE id=?`
  ).run(id);
}

export function failPendingMove(db: Database.Database, id: number): void {
  db.prepare(
    `UPDATE imap_pending_moves SET estado='FALLIDO', ts_completado=datetime('now') WHERE id=?`
  ).run(id);
}

export function getPendingMoves(db: Database.Database): ImapPendingMove[] {
  return db.prepare(
    `SELECT * FROM imap_pending_moves WHERE estado='PENDIENTE' ORDER BY ts_creado ASC`
  ).all() as ImapPendingMove[];
}

export interface ClienteAprobado {
  id: number;
  carpeta: string;
  nombre: string;
  nit_principal: string;
  nits_json: string;
  keywords_json: string;
  card_code: string;
  prompt: string;
  activo: number;
  ts_creado: string;
  ts_modificado: string;
}

export function getClientes(db: Database.Database): ClienteAprobado[] {
  return db.prepare(
    "SELECT * FROM clientes_aprobados ORDER BY nombre ASC"
  ).all() as ClienteAprobado[];
}

export function getClienteByCarpeta(db: Database.Database, carpeta: string): ClienteAprobado | null {
  return (db.prepare("SELECT * FROM clientes_aprobados WHERE carpeta = ?").get(carpeta) ?? null) as ClienteAprobado | null;
}

export function getClienteById(db: Database.Database, id: number): ClienteAprobado | null {
  return (db.prepare("SELECT * FROM clientes_aprobados WHERE id = ?").get(id) ?? null) as ClienteAprobado | null;
}

export function getClienteByNit(db: Database.Database, nit: string): ClienteAprobado | null {
  return (db.prepare(
    "SELECT * FROM clientes_aprobados WHERE nit_principal = ? OR nits_json LIKE ?"
  ).get(nit, `%"${nit}"%`) ?? null) as ClienteAprobado | null;
}

export function upsertCliente(db: Database.Database, data: {
  carpeta: string; nombre: string; nit_principal: string;
  nits_json: string; keywords_json: string; card_code: string; prompt: string; activo?: number;
}): number {
  const result = db.prepare(`
    INSERT INTO clientes_aprobados (carpeta, nombre, nit_principal, nits_json, keywords_json, card_code, prompt, activo)
    VALUES (@carpeta, @nombre, @nit_principal, @nits_json, @keywords_json, @card_code, @prompt, @activo)
    ON CONFLICT(carpeta) DO UPDATE SET
      nombre = excluded.nombre, nit_principal = excluded.nit_principal,
      nits_json = excluded.nits_json, keywords_json = excluded.keywords_json,
      card_code = excluded.card_code, prompt = excluded.prompt,
      activo = excluded.activo, ts_modificado = datetime('now')
  `).run({ ...data, activo: data.activo ?? 1 });
  return result.lastInsertRowid as number;
}

export function updateCliente(db: Database.Database, id: number, data: {
  nombre?: string; nit_principal?: string; nits_json?: string;
  keywords_json?: string; card_code?: string; prompt?: string; activo?: number;
}): void {
  const fields = Object.keys(data).filter(k => data[k as keyof typeof data] !== undefined);
  if (fields.length === 0) return;
  const sets = [...fields.map(f => `${f} = @${f}`), "ts_modificado = datetime('now')"].join(", ");
  db.prepare(`UPDATE clientes_aprobados SET ${sets} WHERE id = @id`).run({ ...data, id });
}

export function ensureWorkspaceDirs(): void {
  const config = getConfig();
  fs.mkdirSync(config.pedidosRawDir, { recursive: true });
  fs.mkdirSync(config.pedidosBackupsDir, { recursive: true });
  fs.mkdirSync(config.pedidosReportsDir, { recursive: true });
}
