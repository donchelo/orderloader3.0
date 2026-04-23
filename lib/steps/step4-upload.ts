/**
 * Step 4: Verificar ítems y crear Sales Order en SAP B1.
 *
 * Primero valida que existan ítems en pedidos_detalle.
 * Luego sube la orden a SAP con lógica de retry: si SAP rechaza un artículo
 * específico lo excluye y reintenta con los restantes.
 *
 * SAP_NUEVO → SAP_MONTADO | ERROR_ITEMS | ERROR_SAP
 */

import fs from "fs";
import path from "path";
import { getDb, logPipeline } from "../db";
import { getSapClient, clearSapClient } from "../sap-client";
import type { SapB1Client } from "../sap-client";
import type { SapB1Order } from "./step1-parse";

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

/** Intenta identificar qué SupplierCatNum causó el error SAP.
 *  SAP B1 suele incluir el código del artículo (ItemCode o SupplierCatNum) o un índice de fila. */
function extractItemFromError(
  errorMsg: string,
  lines: Array<{ SupplierCatNum: string }>,
  mapping: Map<string, string>
): string | null {
  for (const line of lines) {
    // 1. Buscar por el código del cliente (SupplierCatNum)
    if (errorMsg.includes(line.SupplierCatNum)) return line.SupplierCatNum;

    // 2. Buscar por el código interno de SAP (ItemCode) usando el mapa
    const sapCode = mapping.get(line.SupplierCatNum);
    if (sapCode && errorMsg.includes(sapCode)) return line.SupplierCatNum;
  }

  // 3. Fallback: buscar por índice de fila [Row X]
  const rowMatch = errorMsg.match(/[Rr]ow\s*\[?(\d+)\]?/);
  if (rowMatch) {
    const idx = parseInt(rowMatch[1]);
    if (idx >= 0 && idx < lines.length) return lines[idx].SupplierCatNum;
  }
  return null;
}

/** Consulta AlternateCatNum para determinar qué SupplierCatNums existen
 *  y mapearlos a sus ItemCodes de SAP. */
async function fetchCatNumMappings(
  sap: SapB1Client,
  cardCode: string,
  catNums: string[]
): Promise<Map<string, string>> {
  const mapping = new Map<string, string>();
  await Promise.all(
    catNums.map(async (catNum) => {
      try {
        const escapedCard = cardCode.replace(/'/g, "''");
        const escapedCat  = catNum.replace(/'/g, "''");
        const res = await sap.get<{ value: Array<{ ItemCode: string }> }>("AlternateCatNum", {
          "$filter": `CardCode eq '${escapedCard}' and Substitute eq '${escapedCat}'`,
          "$select": "ItemCode",
          "$top": "1",
        });
        if (res.value?.length > 0) {
          mapping.set(catNum, res.value[0].ItemCode);
        }
      } catch {
        // Silencioso: si falla la consulta no agregamos al mapa
      }
    })
  );
  return mapping;
}

export async function run(): Promise<StepResult> {
  const result: StepResult = { procesados: 0, errores: 0, saltados: 0, detalles: [] };
  const db = getDb();

  const pendientes = db.prepare(
    "SELECT * FROM pedidos_maestro WHERE estado = 'SAP_NUEVO'"
  ).all() as Array<Record<string, unknown>>;

  if (!pendientes.length) {
    result.detalles.push("No hay pedidos en estado SAP_NUEVO");
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
      const msg = `data_extraida.json inválido: ${String(e).slice(0, 80)}`;
      db.prepare(`UPDATE pedidos_maestro SET estado='ERROR_SAP', error_msg=? WHERE orden_compra=?`).run(msg, oc);
      logPipeline(db, oc, 4, "upload", "ERROR", msg);
      result.errores++;
      result.detalles.push(`✗ OC ${oc}: ${msg}`);
      continue;
    }

    // ── Pre-validar artículos contra AlternateCatNum antes de subir ──────────
    let lineas = aiData.DocumentLines.map(l => ({ ...l }));
    const excluidos: typeof lineas = [];

    const allCatNums = [...new Set(lineas.map(l => l.SupplierCatNum))];
    const itemMappings = await fetchCatNumMappings(sap, aiData.CardCode, allCatNums);
    
    const missing = lineas.filter(l => !itemMappings.has(l.SupplierCatNum));
    if (missing.length > 0) {
      excluidos.push(...missing);
      lineas = lineas.filter(l => itemMappings.has(l.SupplierCatNum));
      for (const m of missing) {
        logPipeline(db, oc, 4, "upload", "WARN",
          `Artículo ${m.SupplierCatNum} no existe en AlternateCatNum de SAP — excluido`);
        result.detalles.push(`  ⚠ OC ${oc}: artículo ${m.SupplierCatNum} no existe en SAP — excluido`);
      }
    }

    if (lineas.length === 0) {
      const msg = `Todos los artículos fueron rechazados (no existen en SAP): ${excluidos.map(l => l.SupplierCatNum).join(", ")}`;
      db.prepare(`UPDATE pedidos_maestro SET estado='ERROR_SAP', error_msg=?, items_excluidos=? WHERE orden_compra=?`)
        .run(msg.slice(0, 250), JSON.stringify(excluidos.map(l => l.SupplierCatNum)), oc);
      logPipeline(db, oc, 4, "upload", "ERROR", msg.slice(0, 120));
      result.errores++;
      result.detalles.push(`✗ OC ${oc}: ${msg}`);
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
        Comments:   (aiData.Comments ?? "").slice(0, 250), // Truncar a 250 chars para SAP
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
        const itemCode = extractItemFromError(errorMsg, lineas, itemMappings);
        if (!itemCode) {
          db.prepare(`UPDATE pedidos_maestro SET estado='ERROR_SAP', error_msg=? WHERE orden_compra=?`)
            .run(errorMsg.slice(0, 1000), oc);
          logPipeline(db, oc, 4, "upload", "ERROR", errorMsg.slice(0, 120));
          result.errores++;
          result.detalles.push(`✗ OC ${oc}: ${errorMsg.slice(0, 120)}`);
          break;
        }
        const idx = lineas.findIndex(l => l.SupplierCatNum === itemCode);
        excluidos.push(...lineas.splice(idx, 1));
        logPipeline(db, oc, 4, "upload", "WARN",
          `Artículo ${itemCode} excluido por error SAP — reintentando`);
        result.detalles.push(`  ⚠ OC ${oc}: artículo ${itemCode} excluido — reintentando`);
      }
    }

    if (!uploaded) {
      if (lineas.length === 0 && excluidos.length > 0) {
        const msg = `Todos los artículos fueron rechazados por SAP: ${excluidos.map(l => l.SupplierCatNum).join(", ")}`;
        db.prepare(`UPDATE pedidos_maestro SET estado='ERROR_SAP', error_msg=? WHERE orden_compra=?`)
          .run(msg.slice(0, 250), oc);
        logPipeline(db, oc, 4, "upload", "ERROR", msg.slice(0, 120));
        result.errores++;
        result.detalles.push(`✗ OC ${oc}: ${msg}`);
      }
      continue;
    }

    db.prepare(`
      UPDATE pedidos_maestro SET
        estado='SAP_MONTADO', sap_doc_entry=?, sap_doc_num=?,
        ts_sap_upload=?, fase_actual=4, error_msg=NULL,
        items_excluidos=?
      WHERE orden_compra=?
    `).run(
      docEntry, docNum!, now,
      excluidos.length ? JSON.stringify(excluidos.map(l => l.SupplierCatNum)) : null,
      oc
    );

    const excMsg = excluidos.length ? ` — ${excluidos.length} artículo(s) excluido(s)` : "";
    logPipeline(db, oc, 4, "upload", "OK", `DocEntry=${docEntry} DocNum=${docNum!}${excMsg}`);
    result.procesados++;
    result.detalles.push(`✓ OC ${oc} → SAP_MONTADO (DocEntry ${docEntry})${excMsg}`);
  }

  return result;
}
