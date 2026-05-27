/**
 * Step 5: Reconciliar PDF vs Orden de Venta en SAP B1.
 *
 * Compara data_extraida.json (fuente: PDF) contra Orders(DocEntry) en SAP.
 * Registra todas las diferencias (artículos faltantes, cantidades, precios)
 * en validacion_resultado para que step6 las incluya en la notificación.
 *
 * SAP_MONTADO → VALIDADO | ERROR_VALIDACION
 */

import fs from "fs";
import path from "path";
import { getDb, logPipeline } from "../db";
import { getSapClient, clearSapClient } from "../sap-client";
import type { SapB1Order } from "./step1-parse";
import { OrderStatus } from "../constants";

export interface StepResult {
  procesados: number;
  errores: number;
  saltados: number;
  detalles: string[];
}

interface Diferencia {
  campo: string;
  pdf: string | number;
  sap: string | number;
}

function yyyymmddToIso(d: string): string {
  if (/^\d{8}$/.test(d)) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`;
  return d;
}

function normalizeDate(d: string): string {
  // SAP devuelve "2026-03-24T00:00:00Z" o "2026-03-24" — quedarnos solo con YYYY-MM-DD
  return String(d ?? "").slice(0, 10);
}

export async function run(): Promise<StepResult> {
  const result: StepResult = { procesados: 0, errores: 0, saltados: 0, detalles: [] };
  const db = getDb();

  const pendientes = db.prepare(
    "SELECT * FROM pedidos_maestro WHERE estado = ?"
  ).all(OrderStatus.SAP_MONTADO) as Array<Record<string, unknown>>;

  if (!pendientes.length) {
    result.detalles.push("No hay pedidos en estado SAP_MONTADO");
    return result;
  }

  let sap;
  try {
    sap = await getSapClient();
  } catch (e) {
    result.detalles.push(`SAP no configurado: ${String(e)}`);
    clearSapClient();
    return result;
  }

  for (const row of pendientes) {
    const oc = String(row.orden_compra);
    const docEntry = row.sap_doc_entry;
    const now = new Date().toISOString();

    // ── Cargar PDF (data_extraida.json) ──────────────────────────────────────
    const carpeta = row.carpeta_origen as string | null;
    const markerPath = carpeta ? path.join(carpeta, "data_extraida.json") : null;

    if (!markerPath || !fs.existsSync(markerPath)) {
      db.prepare(`UPDATE pedidos_maestro SET estado='ERROR_VALIDACION', error_msg=? WHERE orden_compra=?`)
        .run("data_extraida.json no encontrado para reconciliación", oc);
      logPipeline(db, oc, 5, "reconcile", "ERROR", "data_extraida.json no encontrado");
      result.errores++;
      result.detalles.push(`✗ OC ${oc}: data_extraida.json no encontrado`);
      continue;
    }

    let pdfData: SapB1Order;
    try {
      pdfData = JSON.parse(fs.readFileSync(markerPath, "utf8")) as SapB1Order;
    } catch (e) {
      db.prepare(`UPDATE pedidos_maestro SET estado='ERROR_VALIDACION', error_msg=? WHERE orden_compra=?`)
        .run(`data_extraida.json inválido: ${String(e).slice(0, 80)}`, oc);
      logPipeline(db, oc, 5, "reconcile", "ERROR", "JSON inválido");
      result.errores++;
      result.detalles.push(`✗ OC ${oc}: data_extraida.json inválido`);
      continue;
    }

    // ── Consultar orden en SAP ───────────────────────────────────────────────
    try {
      const sapOrder = await sap.get<Record<string, unknown>>(
        `Orders(${docEntry})`,
        { "$select": "DocEntry,DocNum,NumAtCard,CardCode,DocDate,DocDueDate,TaxDate,DocTotal,DocumentLines" }
      );
      // SAP devuelve todas las líneas (texto, servicio, packaging) — filtrar solo ítems reales
      const sapLines = ((sapOrder.DocumentLines as Array<Record<string, unknown>>) ?? [])
        .filter(l => String(l.SupplierCatNum ?? "").trim() !== "");

      const diferencias: Diferencia[] = [];

      // ── Artículos excluidos en step4 (upload) ───────────────────────────
      const itemsExcluidosCodes: string[] = row.items_excluidos
        ? JSON.parse(String(row.items_excluidos))
        : [];
      for (const code of itemsExcluidosCodes) {
        diferencias.push({
          campo: `Artículo no subido a SAP`,
          pdf: code,
          sap: "excluido — SAP lo rechazó en el upload",
        });
      }

      // Líneas del PDF sin los ítems que fueron excluidos en el upload
      const pdfLinesActivas = pdfData.DocumentLines.filter(
        l => !itemsExcluidosCodes.includes(String(l.SupplierCatNum))
      );

      // ── Comparar cabecera ────────────────────────────────────────────────
      const checks: [string, string, string][] = [
        ["NumAtCard",  String(pdfData.NumAtCard),               String(sapOrder.NumAtCard ?? "")],
        ["CardCode",   String(pdfData.CardCode),                String(sapOrder.CardCode ?? "")],
        ["DocDate",    yyyymmddToIso(pdfData.DocDate),          normalizeDate(String(sapOrder.DocDate ?? ""))],
        ["DocDueDate", yyyymmddToIso(pdfData.DocDueDate),       normalizeDate(String(sapOrder.DocDueDate ?? ""))],
        ["TaxDate",    yyyymmddToIso(pdfData.TaxDate),          normalizeDate(String(sapOrder.TaxDate ?? ""))],
      ];
      for (const [campo, pdf, sap_val] of checks) {
        if (pdf !== sap_val) diferencias.push({ campo, pdf, sap: sap_val });
      }

      // ── Comparar cantidad de líneas (sin excluidos, sin líneas de texto SAP) ──
      if (pdfLinesActivas.length !== sapLines.length) {
        diferencias.push({
          campo: "líneas totales",
          pdf: pdfLinesActivas.length,
          sap: sapLines.length,
        });
      }

      // ── Comparar cada línea por SupplierCatNum ───────────────────────────
      // Normalizar: quitar ceros iniciales para que "014007383" === "14007383"
      const normCat = (s: string) => String(s ?? "").replace(/^0+/, "") || "0";

      for (const pdfLine of pdfLinesActivas) {
        const sapLine = sapLines.find(
          l => normCat(String(l.SupplierCatNum ?? "")) === normCat(String(pdfLine.SupplierCatNum))
        );
        if (!sapLine) {
          diferencias.push({
            campo: `Artículo faltante en SAP`,
            pdf: pdfLine.SupplierCatNum,
            sap: "no encontrado",
          });
          continue;
        }

        // Cantidad
        if (Math.abs(Number(sapLine.Quantity ?? 0) - pdfLine.Quantity) > 0.001) {
          diferencias.push({
            campo: `Cantidad [${pdfLine.SupplierCatNum}]`,
            pdf: pdfLine.Quantity,
            sap: Number(sapLine.Quantity),
          });
        }

        // Precio — tolerancia 0%
        // UnitPrice = precio de lista antes de descuento; Price = precio neto post-descuento.
        const pdfPrice   = pdfLine.UnitPrice ?? 0;
        const sapUnit    = Number(sapLine.UnitPrice ?? 0);
        const sapNetPrice = Number(sapLine.Price ?? sapUnit);

        if (pdfPrice > 0) {
          // 1) Precio por unidad (antes de descuento) debe coincidir con la OC
          if (Math.round(pdfPrice * 100) !== Math.round(sapUnit * 100)) {
            diferencias.push({
              campo: `Precio unitario [${pdfLine.SupplierCatNum}]`,
              pdf: pdfPrice,
              sap: sapUnit,
            });
          }
          // 2) Precio neto (tras descuento) también debe coincidir — no manejamos descuentos
          if (Math.round(pdfPrice * 100) !== Math.round(sapNetPrice * 100)) {
            diferencias.push({
              campo: `Precio neto/descuento [${pdfLine.SupplierCatNum}]`,
              pdf: pdfPrice,
              sap: sapNetPrice,
            });
          }
        }
      }

      // ── Actualizar precios reales desde SAP ──────────────────────────────
      const docTotal = Number(sapOrder.DocTotal ?? 0);
      db.prepare(`UPDATE pedidos_maestro SET subtotal=? WHERE orden_compra=?`)
        .run(docTotal, oc);

      const updDetalle = db.prepare(`
        UPDATE pedidos_detalle SET precio_unitario=?, subtotal_item=?
        WHERE orden_compra=? AND LTRIM(codigo_producto, '0')=LTRIM(?, '0')
      `);
      for (const sapLine of sapLines) {
        const sapPrice = Number(sapLine.UnitPrice ?? sapLine.Price ?? 0);
        const qty      = Number(sapLine.Quantity ?? 0);
        if (sapPrice > 0) {
          updDetalle.run(sapPrice, sapPrice * qty, oc, String(sapLine.SupplierCatNum ?? ""));
        }
      }

      // ── Resultado ────────────────────────────────────────────────────────
      const ok = diferencias.length === 0;
      const nuevoEstado = ok ? "VALIDADO" : "ERROR_VALIDACION";
      const resultado = JSON.stringify({ ok, diferencias, docNum: sapOrder.DocNum });

      db.prepare(`
        UPDATE pedidos_maestro SET estado=?, validacion_resultado=?, ts_validated=?, fase_actual=5
        WHERE orden_compra=?
      `).run(nuevoEstado, resultado, now, oc);
      logPipeline(db, oc, 5, "reconcile", ok ? "OK" : "ERROR",
        ok ? `DocNum ${sapOrder.DocNum} — sin diferencias` : `${diferencias.length} diferencia(s)`);

      if (ok) {
        result.procesados++;
        result.detalles.push(`✓ OC ${oc} → VALIDADO (DocNum ${sapOrder.DocNum})`);
      } else {
        result.errores++;
        result.detalles.push(`⚠ OC ${oc} → ERROR_VALIDACION (${diferencias.length} diferencia(s)):`);
        for (const d of diferencias) {
          result.detalles.push(`    ${d.campo}: PDF='${d.pdf}' SAP='${d.sap}'`);
        }
      }
    } catch (e) {
      db.prepare(`UPDATE pedidos_maestro SET estado='ERROR_SAP', error_msg=? WHERE orden_compra=?`)
        .run(String(e).slice(0, 250), oc);
      logPipeline(db, oc, 5, "reconcile", "ERROR", String(e).slice(0, 120));
      result.errores++;
      result.detalles.push(`✗ OC ${oc}: ${String(e).slice(0, 120)}`);
    }
  }

  return result;
}
