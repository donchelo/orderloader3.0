import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createTestDb, insertTestPedido, buildSapOrderFixture } from "../helpers/test-db";
import type Database from "better-sqlite3";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockSapGet = vi.fn();
vi.mock("@/lib/sap-client", () => ({
  getSapClient: vi.fn().mockResolvedValue({ get: mockSapGet }),
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
  }),
}));

// ─────────────────────────────────────────────────────────────────────────────

describe("step3-sap-query", () => {
  let tmpDir: string;

  beforeEach(() => {
    _db = createTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "step3-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    _db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupPedidoWithFile(oc: string, items: string[]) {
    const carpeta = path.join(tmpDir, oc);
    fs.mkdirSync(carpeta, { recursive: true });
    const fixture = buildSapOrderFixture(oc, "CN123456789", items);
    fs.writeFileSync(path.join(carpeta, "data_extraida.json"), JSON.stringify(fixture));
    insertTestPedido(_db, { orden_compra: oc, estado: "PARSE_VALIDO", carpeta_origen: carpeta });
    return carpeta;
  }

  it("marca CATALOG_OK cuando todos los artículos existen en SAP", async () => {
    const oc = "OC-CAT-001";
    setupPedidoWithFile(oc, ["SKU-A", "SKU-B"]);

    // SAP devuelve mapping para todos los SKUs
    mockSapGet.mockResolvedValue({ value: [{ ItemCode: "ITEM-SAP-X" }] });

    const { run } = await import("@/lib/steps/step3-sap-query");
    const result = await run();

    expect(result.procesados).toBe(1);
    expect(result.errores).toBe(0);

    const row = _db.prepare("SELECT estado FROM pedidos_maestro WHERE orden_compra = ?").get(oc) as { estado: string };
    expect(row.estado).toBe("CATALOG_OK");
  });

  it("marca ERROR_CATALOG cuando ningún artículo existe en SAP", async () => {
    const oc = "OC-CAT-002";
    setupPedidoWithFile(oc, ["SKU-MISSING-1", "SKU-MISSING-2"]);

    // SAP no encuentra ningún artículo
    mockSapGet.mockResolvedValue({ value: [] });

    const { run } = await import("@/lib/steps/step3-sap-query");
    const result = await run();

    expect(result.errores).toBe(1);
    expect(result.procesados).toBe(0);

    const row = _db.prepare("SELECT estado, error_msg FROM pedidos_maestro WHERE orden_compra = ?").get(oc) as { estado: string; error_msg: string };
    expect(row.estado).toBe("ERROR_CATALOG");
    expect(row.error_msg).toContain("Ningún artículo existe en catálogo SAP");
  });

  it("marca CATALOG_OK con items_excluidos cuando solo algunos artículos existen", async () => {
    const oc = "OC-CAT-003";
    setupPedidoWithFile(oc, ["SKU-EXISTS", "SKU-MISSING"]);

    // Solo SKU-EXISTS existe en SAP
    mockSapGet.mockImplementation((_: string, params: Record<string, string>) => {
      if (params["$filter"]?.includes("SKU-EXISTS")) {
        return Promise.resolve({ value: [{ ItemCode: "ITEM-001" }] });
      }
      return Promise.resolve({ value: [] });
    });

    const { run } = await import("@/lib/steps/step3-sap-query");
    const result = await run();

    expect(result.procesados).toBe(1);
    expect(result.errores).toBe(0);

    const row = _db.prepare("SELECT estado, items_excluidos FROM pedidos_maestro WHERE orden_compra = ?").get(oc) as { estado: string; items_excluidos: string };
    expect(row.estado).toBe("CATALOG_OK");
    expect(JSON.parse(row.items_excluidos)).toContain("SKU-MISSING");
  });

  it("no falla cuando SAP lanza un error HTTP en un artículo — lo excluye silenciosamente", async () => {
    const oc = "OC-CAT-004";
    setupPedidoWithFile(oc, ["SKU-OK", "SKU-ERROR"]);

    mockSapGet.mockImplementation((_: string, params: Record<string, string>) => {
      if (params["$filter"]?.includes("SKU-OK")) {
        return Promise.resolve({ value: [{ ItemCode: "ITEM-OK" }] });
      }
      return Promise.reject(new Error("SAP 500 Internal Server Error"));
    });

    const { run } = await import("@/lib/steps/step3-sap-query");
    const result = await run();

    // SKU-ERROR excluido por error → CATALOG_OK con items_excluidos
    expect(result.errores).toBe(0);
    expect(result.procesados).toBe(1);
  });

  it("sale limpiamente cuando no hay pedidos en PARSE_VALIDO", async () => {
    const { run } = await import("@/lib/steps/step3-sap-query");
    const result = await run();
    expect(result.procesados).toBe(0);
    expect(result.errores).toBe(0);
    expect(result.detalles[0]).toContain("No hay pedidos en estado PARSE_VALIDO");
  });

  it("retorna error limpio cuando SAP no está disponible", async () => {
    insertTestPedido(_db, { orden_compra: "OC-SAP-DOWN", estado: "PARSE_VALIDO" });

    const { getSapClient } = await import("@/lib/sap-client");
    vi.mocked(getSapClient).mockRejectedValueOnce(new Error("Connection refused"));

    const { run } = await import("@/lib/steps/step3-sap-query");
    const result = await run();

    expect(result.procesados).toBe(0);
    // El step maneja la falla de conexión SAP sin lanzar
    expect(result.detalles.some(d => /SAP no configurado|Connection refused/i.test(d))).toBe(true);
  });
});
