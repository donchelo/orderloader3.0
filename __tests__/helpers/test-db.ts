/**
 * In-memory SQLite with full OrderLoader schema for integration tests.
 * Each test suite should call createTestDb() in beforeEach and close in afterEach.
 */
import Database from "better-sqlite3";

export function createTestDb(): Database.Database {
  const db = new Database(":memory:");
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
      carpeta_origen        TEXT,
      notificacion_enviada  INTEGER DEFAULT 0,
      costo_ia_usd          REAL
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
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      orden_compra     TEXT,
      fase             INTEGER,
      fase_nombre      TEXT,
      estado_resultado TEXT,
      mensaje          TEXT,
      input_tokens     INTEGER,
      output_tokens    INTEGER,
      model            TEXT,
      ts               TEXT DEFAULT (datetime('now'))
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
    CREATE INDEX IF NOT EXISTS idx_maestro_estado ON pedidos_maestro(estado);
    CREATE INDEX IF NOT EXISTS idx_detalle_oc ON pedidos_detalle(orden_compra);
    CREATE INDEX IF NOT EXISTS idx_log_oc ON pipeline_log(orden_compra);
  `);

  return db;
}

/** Insert a pedido_maestro row for testing. Returns the inserted orden_compra. */
export function insertTestPedido(
  db: Database.Database,
  overrides: Partial<{
    nit_cliente: string;
    orden_compra: string;
    estado: string;
    carpeta_origen: string;
    cliente_nombre: string;
  }> = {}
): string {
  const oc = overrides.orden_compra ?? `OC-TEST-${Date.now()}`;
  db.prepare(`
    INSERT INTO pedidos_maestro (nit_cliente, orden_compra, estado, carpeta_origen, cliente_nombre, fecha_entrega_general)
    VALUES (?, ?, ?, ?, ?, '20250630')
  `).run(
    overrides.nit_cliente ?? "123456789",
    oc,
    overrides.estado ?? "PARSE_VALIDO",
    overrides.carpeta_origen ?? null,
    overrides.cliente_nombre ?? "Cliente Test",
  );
  return oc;
}

/** Insert a pedido_detalle row for testing. */
export function insertTestDetalle(
  db: Database.Database,
  orden_compra: string,
  items: Array<{ codigo_producto: string; cantidad: number; precio_unitario: number }>,
): void {
  const ins = db.prepare(`
    INSERT INTO pedidos_detalle (orden_compra, codigo_producto, descripcion, cantidad, precio_unitario, subtotal_item)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const item of items) {
    ins.run(orden_compra, item.codigo_producto, "Descripción test", item.cantidad, item.precio_unitario, item.cantidad * item.precio_unitario);
  }
}

/** Build a minimal SapB1Order JSON fixture for use as data_extraida.json */
export function buildSapOrderFixture(oc: string, cardCode = "CN123456789", items: string[] = ["SKU-001", "SKU-002"]) {
  const today = new Date();
  const yyyymmdd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  return {
    CardCode: cardCode,
    NumAtCard: oc,
    DocDate: yyyymmdd,
    TaxDate: yyyymmdd,
    DocDueDate: yyyymmdd,
    DocumentLines: items.map((sku, i) => ({
      SupplierCatNum: sku,
      FreeText: `Producto ${i + 1}`,
      Quantity: 10,
      UnitPrice: 1000,
      DeliveryDate: yyyymmdd,
    })),
  };
}
