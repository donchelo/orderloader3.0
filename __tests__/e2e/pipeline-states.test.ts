/**
 * E2E: verifica las transiciones de estado del pipeline sin dependencias externas.
 * No corre step0 (descarga de email) ni step1 (AI parse) — ambos tocan servicios reales.
 * Cubre el flujo central: PARSE_VALIDO → CATALOG_OK → SAP_MONTADO.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createTestDb, insertTestPedido, insertTestDetalle, buildSapOrderFixture } from "../helpers/test-db";
import type Database from "better-sqlite3";

// ── Mocks globales ────────────────────────────────────────────────────────────

const mockSapGet  = vi.fn();
const mockSapPost = vi.fn();

vi.mock("@/lib/sap-client", () => ({
  getSapClient:   vi.fn().mockResolvedValue({ get: mockSapGet, post: mockSapPost }),
  clearSapClient: vi.fn(),
  logoutSapClient: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/mailer",     () => ({ sendAlertEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  return { ...original, getDb: () => _db, logPipeline: vi.fn(), backupDb: vi.fn(), migrate: vi.fn() };
});
vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    pedidosRawDir: "/tmp/e2e-raw",
    cardCodePrefix: "CN",
    tenant: "tamaprint",
    tenantDisplayName: "Tamaprint",
    notifyAlertasEmail: "alertas@test.com",
    notifyEmail: "notify@test.com",
    notifyCcEmail: "",
  }),
}));

// Steps que tocan servicios externos — mockeados con comportamiento mínimo
vi.mock("@/lib/steps/step0-download", () => ({
  run: vi.fn().mockResolvedValue({ procesados: 0, errores: 0, saltados: 0, detalles: ["Bandeja vacía (mock)"] }),
  recoverPendingMoves: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/steps/step2-validate-parse", () => ({
  run: vi.fn().mockResolvedValue({ procesados: 1, errores: 0, saltados: 0, detalles: ["✓ OC validada"] }),
}));
vi.mock("@/lib/steps/step5-reconcile", () => ({
  run: vi.fn().mockResolvedValue({ procesados: 0, errores: 0, saltados: 0, detalles: [] }),
}));
vi.mock("@/lib/steps/step6-notify", () => ({
  run: vi.fn().mockResolvedValue({ procesados: 0, errores: 0, saltados: 0, detalles: [] }),
}));
vi.mock("@/lib/steps/step7-archive", () => ({
  run: vi.fn().mockResolvedValue({ procesados: 0, errores: 0, saltados: 0, detalles: [] }),
}));

// ─────────────────────────────────────────────────────────────────────────────

let _db: Database.Database;
let tmpDir: string;

function setupPedidoParseValido(oc: string, items = ["SKU-001", "SKU-002"]) {
  const carpeta = path.join(tmpDir, oc);
  fs.mkdirSync(carpeta, { recursive: true });
  const fixture = buildSapOrderFixture(oc, "CN123456789", items);
  fs.writeFileSync(path.join(carpeta, "data_extraida.json"), JSON.stringify(fixture));
  insertTestPedido(_db, { orden_compra: oc, estado: "PARSE_VALIDO", carpeta_origen: carpeta });
  insertTestDetalle(_db, oc, items.map(sku => ({ codigo_producto: sku, cantidad: 5, precio_unitario: 500 })));
  return carpeta;
}

describe("E2E: flujo completo PARSE_VALIDO → SAP_MONTADO", () => {
  beforeEach(() => {
    _db = createTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-pipeline-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    _db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("una orden válida llega a SAP_MONTADO al correr steps 3 y 4", async () => {
    const oc = "OC-E2E-001";
    setupPedidoParseValido(oc, ["SKU-A"]);

    // AlternateCatNum lookup (step3) → artículo existe
    // Orders idempotency check (step4) → orden NO existe aún
    mockSapGet.mockImplementation((_endpoint: string, params: Record<string, string>) => {
      if (params["$filter"]?.includes("NumAtCard")) {
        return Promise.resolve({ value: [] }); // orden no existe → proceder con POST
      }
      return Promise.resolve({ value: [{ ItemCode: "SAP-ITEM-A" }] }); // catalog lookup
    });
    // SAP upload: OK
    mockSapPost.mockResolvedValue({ DocEntry: 5001, DocNum: "E2E-1" });

    const { run: step3 } = await import("@/lib/steps/step3-sap-query");
    const { run: step4 } = await import("@/lib/steps/step4-upload");

    const r3 = await step3();
    expect(r3.procesados).toBe(1);
    expect(r3.errores).toBe(0);

    const r4 = await step4();
    expect(r4.procesados).toBe(1);
    expect(r4.errores).toBe(0);

    const row = _db.prepare("SELECT estado, sap_doc_entry FROM pedidos_maestro WHERE orden_compra = ?").get(oc) as { estado: string; sap_doc_entry: number };
    expect(row.estado).toBe("SAP_MONTADO");
    expect(row.sap_doc_entry).toBe(5001);
  });

  it("una orden con artículos faltantes en catálogo queda en ERROR_CATALOG y no llega a SAP", async () => {
    const oc = "OC-E2E-002";
    setupPedidoParseValido(oc, ["SKU-NOBODY"]);

    mockSapGet.mockResolvedValue({ value: [] });

    const { run: step3 } = await import("@/lib/steps/step3-sap-query");
    const { run: step4 } = await import("@/lib/steps/step4-upload");

    await step3();
    await step4();

    const row = _db.prepare("SELECT estado FROM pedidos_maestro WHERE orden_compra = ?").get(oc) as { estado: string };
    expect(row.estado).toBe("ERROR_CATALOG");
    expect(mockSapPost).not.toHaveBeenCalled();
  });

  it("múltiples órdenes: algunas pasan, otras fallan en catálogo — no hay cross-contaminación", async () => {
    setupPedidoParseValido("OC-OK-1",   ["SKU-EXISTS"]);
    setupPedidoParseValido("OC-FAIL-1", ["SKU-MISSING"]);
    setupPedidoParseValido("OC-OK-2",   ["SKU-EXISTS"]);

    mockSapGet.mockImplementation((_: string, params: Record<string, string>) => {
      // Orders idempotency check (step4): NumAtCard filter → orden no existe aún
      if (params["$filter"]?.includes("NumAtCard")) return Promise.resolve({ value: [] });
      // AlternateCatNum lookup (step3)
      if (params["$filter"]?.includes("SKU-EXISTS")) return Promise.resolve({ value: [{ ItemCode: "ITEM-X" }] });
      return Promise.resolve({ value: [] });
    });
    mockSapPost.mockResolvedValue({ DocEntry: 9000, DocNum: "BATCH" });

    const { run: step3 } = await import("@/lib/steps/step3-sap-query");
    const { run: step4 } = await import("@/lib/steps/step4-upload");

    const r3 = await step3();
    expect(r3.procesados).toBe(2); // OC-OK-1 y OC-OK-2
    expect(r3.errores).toBe(1);    // OC-FAIL-1

    const r4 = await step4();
    expect(r4.procesados).toBe(2);
    expect(r4.errores).toBe(0);

    const ok1  = _db.prepare("SELECT estado FROM pedidos_maestro WHERE orden_compra = ?").get("OC-OK-1")  as { estado: string };
    const fail = _db.prepare("SELECT estado FROM pedidos_maestro WHERE orden_compra = ?").get("OC-FAIL-1") as { estado: string };
    const ok2  = _db.prepare("SELECT estado FROM pedidos_maestro WHERE orden_compra = ?").get("OC-OK-2")  as { estado: string };
    expect(ok1.estado).toBe("SAP_MONTADO");
    expect(fail.estado).toBe("ERROR_CATALOG");
    expect(ok2.estado).toBe("SAP_MONTADO");
  });
});
