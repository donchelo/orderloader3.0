/**
 * Step 4: Crear Sales Order en SAP B1.
 *
 * Lee los artículos excluidos del catálogo (puestos por step3) y sube
 * solo los artículos válidos. Si SAP rechaza un artículo durante el upload,
 * lo excluye y reintenta con los restantes.
 *
 * CATALOG_OK → SAP_MONTADO | ERROR_ITEMS | ERROR_SAP
 * SAP_NUEVO  → SAP_MONTADO | ERROR_ITEMS | ERROR_SAP  (compatibilidad backward)
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

function yyyymmddToIso(d: string): string {
  if (/^\d{8}$/.test(d)) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`;
  return d;
}

function maxFechaLineas(lines: { DeliveryDate?: string }[], fallback: string): string {
  const fechas = lines.map(l => l.DeliveryDate ?? fallback).filter(f => /^\d{8}$/.test(f));
  return fechas.length ? fechas.reduce((max, f) => (f > max ? f : max), fechas[0]) : fallback;
}

/** Intenta identificar qué SupplierCatNum causó el error SAP. */
function extractItemFromError(
  errorMsg: string,
  lines: Array<{ SupplierCatNum: string }>
): string | null {
  for (const line of lines) {
    if (errorMsg.includes(line.SupplierCatNum)) return line.SupplierCatNum;
  }
  // Fallback: buscar por índice de fila [Row X]
  const rowMatch = errorMsg.match(/[Rr]ow\s*\[?(\d+)\]?/);
  if (rowMatch) {
    const idx = parseInt(rowMatch[1]);
    if (idx >= 0 && idx < lines.length) return lines[idx].SupplierCatNum;
  }
  return null;
}

export async function run(): Promise<StepResult> {
  const result: StepResult = { procesados: 0, errores: 0, saltados: 0, detalles: [] };
  const db = getDb();

  // Procesar CATALOG_OK (nuevo flujo) y SAP_NUEVO (compatibilidad con runs anteriores)
  const pendientes = db.prepare(
    "SELECT * FROM pedidos_maestro WHERE estado IN (?, ?)"
  ).all(OrderStatus.CATALOG_OK, OrderStatus.SAP_NUEVO) as Array<Record<string, unknown>>;

  if (!pendientes.length) {
    result.detalles.push("No hay pedidos en estado CATALOG_OK o SAP_NUEVO");
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
    const now = new Date().toISOString();

    // ── Verificar que existan ítems ──────────────────────────────────────────
    const itemCount = (
      db.prepare("SELECT COUNT(*) as c FROM pedidos_detalle WHERE orden_compra = ?").get(oc) as { c: number }
    ).c;

    if (!itemCount) {
      db.prepare(`UPDATE pedidos_maestro SET estado='ERROR_ITEMS', error_msg=? WHERE orden_compra=?`)
        .run("Sin ítems en pedidos_detalle", oc);
      logPipeline(db, oc, 4, "upload", "ERROR", "Sin ítems en pedidos_detalle");
      result.errores++;
      result.detalles.push(`✗ OC ${oc} → ERROR_ITEMS (sin ítems)`);
      continue;
    }

    // ── Leer data_extraida.json ──────────────────────────────────────────────
    const carpeta = row.carpeta_origen as string | null;
    const markerPath = carpeta ? path.join(carpeta, "data_extraida.json") : null;

    if (!markerPath || !fs.existsSync(markerPath)) {
      const msg = "data_extraida.json no encontrado";
      db.prepare(`UPDATE pedidos_maestro SET estado='ERROR_SAP', error_msg=? WHERE orden_compra=?`).run(msg, oc);
      logPipeline(db, oc, 4, "upload", "ERROR", msg);
      result.errores++;
      result.detalles.push(`✗ OC ${oc}: ${msg}`);
      continue;
    }

    let aiData: SapB1Order;
    try {
      aiData = JSON.parse(fs.readFileSync(markerPath, "utf8")) as SapB1Order;
    } catch (e) {
      const msg = `data_extraida.json inválido: ${String(e).slice(0, 500)}`;
      db.prepare(`UPDATE pedidos_maestro SET estado='ERROR_SAP', error_msg=? WHERE orden_compra=?`).run(msg, oc);
      logPipeline(db, oc, 4, "upload", "ERROR", msg);
      result.errores++;
      result.detalles.push(`✗ OC ${oc}: ${msg}`);
      continue;
    }

    // ── Verificación de idempotencia: ¿ya fue subida a SAP en un run anterior? ─
    try {
      const check = await sap.get<{ value: Array<Record<string, unknown>> }>(
        "Orders",
        { "$filter": `NumAtCard eq '${oc}' and CardCode eq '${aiData.CardCode}'`, "$select": "DocEntry,DocNum" }
      );
      if (check.value?.length > 0) {
        const existing = check.value[0];
        db.prepare(`
          UPDATE pedidos_maestro SET
            estado='SAP_MONTADO', sap_doc_entry=?, sap_doc_num=?,
            ts_sap_upload=?, fase_actual=4, error_msg=NULL
          WHERE orden_compra=?
        `).run(existing.DocEntry, String(existing.DocNum ?? ""), now, oc);
        logPipeline(db, oc, 4, "upload", "OK",
          `Recuperado: orden ya existía en SAP DocEntry=${existing.DocEntry}`);
        result.procesados++;
        result.detalles.push(`↩ OC ${oc} → SAP_MONTADO (recuperado, ya existía DocEntry ${existing.DocEntry})`);
        continue;
      }
    } catch {
      // Si la verificación falla, continuar con el flujo normal de upload
    }

    // ── Leer artículos excluidos por step3 (catálogo) ───────────────────────
    const catalogExcluded: string[] = JSON.parse(String(row.items_excluidos || "[]"));

    let lineas = aiData.DocumentLines
      .filter(l => !catalogExcluded.includes(l.SupplierCatNum))
      .map(l => ({ ...l }));
    const excluidos = aiData.DocumentLines
      .filter(l => catalogExcluded.includes(l.SupplierCatNum))
      .map(l => ({ ...l }));

    if (lineas.length === 0) {
      const msg = `Todos los artículos excluidos por catálogo: ${catalogExcluded.join(", ")}`;
      db.prepare(`UPDATE pedidos_maestro SET estado='ERROR_ITEMS', error_msg=? WHERE orden_compra=?`)
        .run(msg.slice(0, 1000), oc);
      logPipeline(db, oc, 4, "upload", "ERROR", msg.slice(0, 1000));
      result.errores++;
      result.detalles.push(`✗ OC ${oc} → ERROR_ITEMS: ${msg}`);
      continue;
    }

    // ── Retry loop: excluir artículos rechazados por SAP y reintentar ────────
    let uploaded = false;
    let docEntry: unknown, docNum: string;

    while (lineas.length > 0) {
      const payload = {
        CardCode:   aiData.CardCode,
        NumAtCard:  aiData.NumAtCard,
        DocDate:    yyyymmddToIso(aiData.DocDate),
        DocDueDate: yyyymmddToIso(maxFechaLineas(lineas, aiData.DocDueDate)),
        TaxDate:    yyyymmddToIso(aiData.TaxDate),
        Comments:   (aiData.Comments ?? "").slice(0, 250),
        DocumentLines: lineas.map(l => ({
          SupplierCatNum: l.SupplierCatNum,
          Quantity: l.Quantity,
          FreeText: l.FreeText,
          ShipDate: yyyymmddToIso(l.DeliveryDate ?? aiData.DocDueDate),
        })),
      };

      try {
        const response = await sap.post<Record<string, unknown>>("Orders", payload);
        docEntry = response.DocEntry;
        docNum = String(response.DocNum ?? "");
        uploaded = true;
        break;
      } catch (e) {
        const errorMsg = String(e);
        const itemCode = extractItemFromError(errorMsg, lineas);
        if (!itemCode) {
          db.prepare(`UPDATE pedidos_maestro SET estado='ERROR_SAP', error_msg=? WHERE orden_compra=?`)
            .run(errorMsg.slice(0, 1000), oc);
          logPipeline(db, oc, 4, "upload", "ERROR", errorMsg.slice(0, 1000));
          result.errores++;
          result.detalles.push(`✗ OC ${oc}: ${errorMsg.slice(0, 500)}`);
          break;
        }
        const idx = lineas.findIndex(l => l.SupplierCatNum === itemCode);
        excluidos.push(...lineas.splice(idx, 1));
        logPipeline(db, oc, 4, "upload", "WARN",
          `Artículo ${itemCode} excluido por error SAP — reintentando`);
        result.detalles.push(`  ⚠ OC ${oc}: artículo ${itemCode} excluido por SAP — reintentando`);
      }
    }

    if (!uploaded) {
      if (lineas.length === 0 && excluidos.length > 0) {
        const msg = `Todos los artículos fueron rechazados por SAP: ${excluidos.map(l => l.SupplierCatNum).join(", ")}`;
        db.prepare(`UPDATE pedidos_maestro SET estado='ERROR_SAP', error_msg=? WHERE orden_compra=?`)
          .run(msg.slice(0, 1000), oc);
        logPipeline(db, oc, 4, "upload", "ERROR", msg.slice(0, 1000));
        result.errores++;
        result.detalles.push(`✗ OC ${oc}: ${msg}`);
      }
      continue;
    }

    // Todos los excluidos: catálogo (step3) + rechazados por SAP (retry loop)
    const allExcluded = excluidos.map(l => l.SupplierCatNum);

    db.prepare(`
      UPDATE pedidos_maestro SET
        estado='SAP_MONTADO', sap_doc_entry=?, sap_doc_num=?,
        ts_sap_upload=?, fase_actual=4, error_msg=NULL,
        items_excluidos=?
      WHERE orden_compra=?
    `).run(
      docEntry, docNum!, now,
      allExcluded.length ? JSON.stringify(allExcluded) : null,
      oc
    );

    const excMsg = allExcluded.length ? ` — ${allExcluded.length} artículo(s) excluido(s)` : "";
    logPipeline(db, oc, 4, "upload", "OK", `DocEntry=${docEntry} DocNum=${docNum!}${excMsg}`);
    result.procesados++;
    result.detalles.push(`✓ OC ${oc} → SAP_MONTADO (DocEntry ${docEntry})${excMsg}`);
  }

  return result;
}
