import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createTestDb, insertTestPedido, insertTestDetalle, buildSapOrderFixture } from "../helpers/test-db";
import type Database from "better-sqlite3";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockSapPost = vi.fn();
const mockSapGet  = vi.fn();
vi.mock("@/lib/sap-client", () => ({
  getSapClient: vi.fn().mockResolvedValue({ post: mockSapPost, get: mockSapGet }),
  clearSapClient: vi.fn(),
}));

vi.mock("@/lib/mailer", () => ({ sendAlertEmail: vi.fn().mockResolvedValue(undefined) }));

let _db: Database.Database;
vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...original,
    getDb: () => _db,
    logPipeline: vi.fn(),
  };
});

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    pedidosRawDir: "/tmp/test-raw",
    cardCodePrefix: "CN",
    tenant: "tamaprint",
    tenantDisplayName: "Tamaprint",
    notifyAlertasEmail: "alertas@test.com",
  }),
}));

// ─────────────────────────────────────────────────────────────────────────────

describe("step4-upload", () => {
  let tmpDir: string;

  beforeEach(() => {
    _db = createTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "step4-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    _db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupPedidoCatalogOk(oc: string, items = ["SKU-001", "SKU-002"]) {
    const carpeta = path.join(tmpDir, oc);
    fs.mkdirSync(carpeta, { recursive: true });
    const fixture = buildSapOrderFixture(oc, "CN123456789", items);
    fs.writeFileSync(path.join(carpeta, "data_extraida.json"), JSON.stringify(fixture));
    insertTestPedido(_db, { orden_compra: oc, estado: "CATALOG_OK", carpeta_origen: carpeta });
    insertTestDetalle(_db, oc, items.map(sku => ({ codigo_producto: sku, cantidad: 10, precio_unitario: 1000 })));
    return carpeta;
  }

  it("sube la orden a SAP y marca SAP_MONTADO cuando SAP responde OK", async () => {
    const oc = "OC-UP-001";
    setupPedidoCatalogOk(oc);

    mockSapPost.mockResolvedValue({ DocEntry: 9999, DocNum: "42" });

    const { run } = await import("@/lib/steps/step4-upload");
    const result = await run();

    expect(result.procesados).toBe(1);
    expect(result.errores).toBe(0);

    const row = _db.prepare("SELECT estado, sap_doc_entry, sap_doc_num FROM pedidos_maestro WHERE orden_compra = ?").get(oc) as { estado: string; sap_doc_entry: number; sap_doc_num: string };
    expect(row.estado).toBe("SAP_MONTADO");
    expect(row.sap_doc_entry).toBe(9999);
    expect(row.sap_doc_num).toBe("42");
  });

  it("marca ERROR_SAP cuando SAP rechaza la orden", async () => {
    const oc = "OC-UP-002";
    setupPedidoCatalogOk(oc);

    mockSapPost.mockRejectedValue(new Error("SAP: Business partner not found"));

    const { run } = await import("@/lib/steps/step4-upload");
    const result = await run();

    expect(result.errores).toBe(1);
    expect(result.procesados).toBe(0);

    const row = _db.prepare("SELECT estado, error_msg FROM pedidos_maestro WHERE orden_compra = ?").get(oc) as { estado: string; error_msg: string };
    expect(row.estado).toBe("ERROR_SAP");
    expect(row.error_msg).toContain("Business partner not found");
  });

  it("excluye el artículo problemático y reintenta cuando SAP rechaza un ítem específico", async () => {
    const oc = "OC-UP-003";
    setupPedidoCatalogOk(oc, ["SKU-GOOD", "SKU-BAD"]);

    // Primer intento falla mencionando SKU-BAD; segundo intento con solo SKU-GOOD pasa
    let callCount = 0;
    mockSapPost.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error("Item SKU-BAD not found in warehouse"));
      return Promise.resolve({ DocEntry: 1234, DocNum: "99" });
    });

    const { run } = await import("@/lib/steps/step4-upload");
    const result = await run();

    // La orden se sube con el artículo válido
    expect(result.procesados).toBe(1);
    expect(result.errores).toBe(0);
    const row = _db.prepare("SELECT estado FROM pedidos_maestro WHERE orden_compra = ?").get(oc) as { estado: string };
    expect(row.estado).toBe("SAP_MONTADO");
  });

  it("sale limpiamente cuando no hay pedidos en CATALOG_OK", async () => {
    const { run } = await import("@/lib/steps/step4-upload");
    const result = await run();
    expect(result.procesados).toBe(0);
    expect(result.errores).toBe(0);
    expect(result.detalles[0]).toContain("No hay pedidos en estado CATALOG_OK");
  });

  it("procesa múltiples órdenes en un mismo run", async () => {
    setupPedidoCatalogOk("OC-MULTI-1");
    setupPedidoCatalogOk("OC-MULTI-2");
    setupPedidoCatalogOk("OC-MULTI-3");

    mockSapPost.mockResolvedValue({ DocEntry: 100, DocNum: "1" });

    const { run } = await import("@/lib/steps/step4-upload");
    const result = await run();

    expect(result.procesados).toBe(3);
    expect(result.errores).toBe(0);
  });
});
