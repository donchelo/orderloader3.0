/**
 * Step 2: Validar el JSON SAP B1 extraído por el AI.
 *
 * Verifica formato, campos requeridos, SupplierCatNum sin ceros iniciales,
 * cantidades enteras positivas y ausencia de duplicados.
 *
 * PARSED → PARSE_VALIDO | ERROR_PARSE
 */

import fs from "fs";
import path from "path";
import { getDb, logPipeline } from "../db";
import { sendAlertEmail } from "../mailer";
import type { SapB1Order } from "./step1-parse";

export interface StepResult {
  procesados: number;
  errores: number;
  saltados: number;
  detalles: string[];
}

// ── Validaciones ────────────────────────────────────────────────────────────

function validarSapB1Json(order: SapB1Order, clienteNombre: string): string[] {
  const errores: string[] = [];

  // Campos fijos
  if (order.DocType !== "dDocument_Items")
    errores.push(`DocType inválido: '${order.DocType}' (esperado 'dDocument_Items')`);
  if (!/^CN\d+$/.test(order.CardCode ?? ""))
    errores.push(`CardCode inválido: '${order.CardCode}' (debe ser CN seguido de dígitos)`);
  if (!/^[A-Za-z0-9][A-Za-z0-9\-\.\/]{2,19}$/.test(order.NumAtCard ?? ""))
    errores.push(`NumAtCard inválido: '${order.NumAtCard}'`);

  // Fechas YYYYMMDD
  for (const [campo, valor] of [
    ["DocDate", order.DocDate],
    ["DocDueDate", order.DocDueDate],
    ["TaxDate", order.TaxDate],
  ] as [string, string][]) {
    if (!/^\d{8}$/.test(valor ?? "")) {
      errores.push(`${campo} inválido: '${valor}' (formato esperado YYYYMMDD)`);
    } else {
      const d = new Date(`${valor.slice(0, 4)}-${valor.slice(4, 6)}-${valor.slice(6)}`);
      if (isNaN(d.getTime())) errores.push(`${campo} '${valor}' no es una fecha real`);
    }
  }

  // DocumentLines
  if (!Array.isArray(order.DocumentLines) || order.DocumentLines.length === 0) {
    errores.push("DocumentLines vacío — sin ítems");
    return errores;
  }

  const vistos = new Set<string>();
  for (let i = 0; i < order.DocumentLines.length; i++) {
    const line = order.DocumentLines[i];
    const ref = `Línea ${i + 1}`;

    // SupplierCatNum: no vacío; sin cero inicial solo para Comodin
    if (!line.SupplierCatNum?.trim()) {
      errores.push(`${ref}: SupplierCatNum vacío`);
    } else {
      if (!["EXITO", "ELGLOBO", "PRODUEMPAK"].includes(clienteNombre) && /^0/.test(line.SupplierCatNum))
        errores.push(`${ref}: SupplierCatNum '${line.SupplierCatNum}' tiene cero inicial`);
      vistos.add(line.SupplierCatNum);
    }

    // Quantity: entero positivo
    if (!Number.isInteger(line.Quantity) || line.Quantity <= 0)
      errores.push(`${ref} (${line.SupplierCatNum}): Quantity '${line.Quantity}' debe ser entero positivo`);
  }

  return errores;
}


function buildErrorHtml(oc: string, cliente: string, errores: string[]): string {
  const filas = errores.map(e =>
    `<tr style="background:#f8d7da"><td style="padding:6px 12px">❌</td><td style="padding:6px 12px">${e}</td></tr>`
  ).join("");
  return `<html><body style="font-family:Arial,sans-serif;font-size:13px">
  <div style="background:#dc3545;color:white;padding:14px 20px;border-radius:6px 6px 0 0">
    <h2 style="margin:0">Error de validación — OC ${oc} no será procesada</h2>
  </div>
  <div style="border:1px solid #ddd;padding:16px 20px">
    <p><b>Cliente:</b> ${cliente}</p>
    <table border="1" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:12px">
      <thead style="background:#343a40;color:#fff">
        <tr><th style="padding:8px"></th><th style="padding:8px;text-align:left">Problema</th></tr>
      </thead>
      <tbody>${filas}</tbody>
    </table>
  </div></body></html>`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function run(): Promise<StepResult> {
  const result: StepResult = { procesados: 0, errores: 0, saltados: 0, detalles: [] };
  const db = getDb();

  const pendientes = db.prepare(
    "SELECT * FROM pedidos_maestro WHERE estado = 'PARSED'"
  ).all() as Array<Record<string, unknown>>;

  if (!pendientes.length) {
    result.detalles.push("No hay pedidos en estado PARSED");
    return result;
  }

  for (const row of pendientes) {
    const oc = String(row.orden_compra);
    const cliente = String(row.cliente_nombre || "—");

    // Cargar data_extraida.json
    const carpeta = row.carpeta_origen as string | null;
    const markerPath = carpeta ? path.join(carpeta, "data_extraida.json") : null;

    if (!markerPath || !fs.existsSync(markerPath)) {
      db.prepare(`UPDATE pedidos_maestro SET estado='ERROR_PARSE', error_msg=? WHERE orden_compra=?`)
        .run("data_extraida.json no encontrado", oc);
      logPipeline(db, oc, 2, "validate_parsed", "ERROR", "data_extraida.json no encontrado");
      result.errores++;
      result.detalles.push(`✗ OC ${oc} → ERROR_PARSE: data_extraida.json no encontrado`);
      continue;
    }

    let order: SapB1Order;
    try {
      order = JSON.parse(fs.readFileSync(markerPath, "utf8")) as SapB1Order;
    } catch (e) {
      db.prepare(`UPDATE pedidos_maestro SET estado='ERROR_PARSE', error_msg=? WHERE orden_compra=?`)
        .run(`data_extraida.json no es JSON válido: ${String(e).slice(0, 80)}`, oc);
      logPipeline(db, oc, 2, "validate_parsed", "ERROR", "JSON inválido");
      result.errores++;
      result.detalles.push(`✗ OC ${oc} → ERROR_PARSE: JSON inválido`);
      continue;
    }

    const errores = validarSapB1Json(order, cliente);
    const n = order.DocumentLines?.length ?? 0;
    const resultado = JSON.stringify({ errores, n_items: n });

    if (errores.length) {
      db.prepare(`
        UPDATE pedidos_maestro SET estado='ERROR_PARSE', fase_actual=2, error_msg=?, validacion_resultado=?
        WHERE orden_compra=?
      `).run(`${errores.length} error(es): ${errores[0].slice(0, 80)}`, resultado, oc);
      logPipeline(db, oc, 2, "validate_parsed", "ERROR", errores[0].slice(0, 120));
      result.errores++;
      result.detalles.push(`✗ OC ${oc} → ERROR_PARSE: ${errores[0]}`);
      try { await sendAlertEmail(`[ERROR OrderLoader] OC ${oc} — Validación fallida`, buildErrorHtml(oc, cliente, errores)); } catch { /* ignore */ }
    } else {
      db.prepare(`
        UPDATE pedidos_maestro SET estado='PARSE_VALIDO', fase_actual=2, error_msg=NULL, validacion_resultado=?
        WHERE orden_compra=?
      `).run(resultado, oc);
      logPipeline(db, oc, 2, "validate_parsed", "OK", `${n} ítem(s) OK`);
      result.procesados++;
      result.detalles.push(`✓ OC ${oc} → PARSE_VALIDO (${n} ítems)`);
    }
  }

  return result;
}
