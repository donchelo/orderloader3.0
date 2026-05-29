/**
 * Step 2: Validar el JSON SAP B1 extraído y verificar que no sea duplicado en SAP.
 *
 * 1. Valida formato y reglas de negocio del JSON extraído por el AI.
 * 2. Consulta SAP B1 para detectar órdenes duplicadas.
 *
 * PARSED → PARSE_VALIDO | ERROR_PARSE | ERROR_DUPLICADO
 */

import fs from "fs";
import path from "path";
import { getDb, logPipeline } from "../db";
import { sendAlertEmail } from "../mailer";
import { getSapClient, clearSapClient } from "../sap-client";
import type { SapB1Order } from "./step1-parse";
import { OrderStatus } from "../constants";

export interface StepResult {
  procesados: number;
  errores: number;
  saltados: number;
  detalles: string[];
}

// ── Validaciones de formato ──────────────────────────────────────────────────

export function validarSapB1Json(order: SapB1Order, clienteNombre: string): string[] {
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
      const y = parseInt(valor.slice(0, 4));
      const m = parseInt(valor.slice(4, 6)) - 1;
      const d = parseInt(valor.slice(6, 8));
      const fecha = new Date(y, m, d);
      if (fecha.getFullYear() !== y || fecha.getMonth() !== m || fecha.getDate() !== d)
        errores.push(`${campo} '${valor}' no es una fecha real`);
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

    // SupplierCatNum: no vacío; sin cero inicial solo para ciertos clientes
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
    "SELECT * FROM pedidos_maestro WHERE estado = ?"
  ).all(OrderStatus.PARSED) as Array<Record<string, unknown>>;

  if (!pendientes.length) {
    result.detalles.push("No hay pedidos en estado PARSED");
    return result;
  }

  // Intentar conexión SAP para verificación de duplicados.
  // Si SAP no está disponible, se valida solo el formato y se deja en PARSE_VALIDO
  // para que step3 lo procese cuando SAP vuelva.
  let sap: Awaited<ReturnType<typeof getSapClient>> | null = null;
  try {
    sap = await getSapClient();
  } catch {
    result.detalles.push("⚠ SAP no disponible — solo se validará formato; verificación de duplicados diferida a step3");
    clearSapClient();
  }

  const now = new Date().toISOString();

  for (const row of pendientes) {
    const oc = String(row.orden_compra);
    const cliente = String(row.cliente_nombre || "—");

    // ── 1. Cargar data_extraida.json ─────────────────────────────────────────
    const carpeta = row.carpeta_origen as string | null;
    const markerPath = carpeta ? path.join(carpeta, "data_extraida.json") : null;

    if (!markerPath || !fs.existsSync(markerPath)) {
      db.prepare(`UPDATE pedidos_maestro SET estado='ERROR_PARSE', error_msg=? WHERE orden_compra=?`)
        .run("data_extraida.json no encontrado", oc);
      logPipeline(db, oc, 2, "validate", "ERROR", "data_extraida.json no encontrado");
      result.errores++;
      result.detalles.push(`✗ OC ${oc} → ERROR_PARSE: data_extraida.json no encontrado`);
      continue;
    }

    let order: SapB1Order;
    try {
      order = JSON.parse(fs.readFileSync(markerPath, "utf8")) as SapB1Order;
    } catch (e) {
      db.prepare(`UPDATE pedidos_maestro SET estado='ERROR_PARSE', error_msg=? WHERE orden_compra=?`)
        .run(`data_extraida.json no es JSON válido: ${String(e).slice(0, 500)}`, oc);
      logPipeline(db, oc, 2, "validate", "ERROR", "JSON inválido");
      result.errores++;
      result.detalles.push(`✗ OC ${oc} → ERROR_PARSE: JSON inválido`);
      continue;
    }

    // ── 2. Validación de formato ─────────────────────────────────────────────
    const erroresFormato = validarSapB1Json(order, cliente);
    const n = order.DocumentLines?.length ?? 0;

    if (erroresFormato.length) {
      const resultado = JSON.stringify({ errores: erroresFormato, n_items: n });
      db.prepare(`
        UPDATE pedidos_maestro SET estado='ERROR_PARSE', fase_actual=2, error_msg=?, validacion_resultado=?
        WHERE orden_compra=?
      `).run(`${erroresFormato.length} error(es): ${erroresFormato[0].slice(0, 500)}`, resultado, oc);
      logPipeline(db, oc, 2, "validate", "ERROR", erroresFormato[0].slice(0, 1000));
      result.errores++;
      result.detalles.push(`✗ OC ${oc} → ERROR_PARSE: ${erroresFormato[0]}`);
      try { await sendAlertEmail(`[ERROR OrderLoader] OC ${oc} — Validación fallida`, buildErrorHtml(oc, cliente, erroresFormato)); } catch { /* ignore */ }
      continue;
    }

    // ── 3. Verificar duplicado en SAP ────────────────────────────────────────
    if (!sap) {
      // SAP no disponible: validación de formato OK, diferir check de duplicados
      const resultado = JSON.stringify({ errores: [], n_items: n });
      db.prepare(`
        UPDATE pedidos_maestro SET estado='PARSE_VALIDO', fase_actual=2, error_msg=NULL, validacion_resultado=?
        WHERE orden_compra=?
      `).run(resultado, oc);
      logPipeline(db, oc, 2, "validate", "OK", `${n} ítem(s) OK — SAP sin check (no disponible)`);
      result.procesados++;
      result.detalles.push(`✓ OC ${oc} → PARSE_VALIDO (${n} ítems, sin check SAP)`);
      continue;
    }

    try {
      const res = await sap.get<{ value: Array<Record<string, unknown>> }>(
        "Orders",
        { "$filter": `NumAtCard eq '${oc}' and CardCode eq '${order.CardCode}'`, "$select": "DocEntry,DocNum,DocTotal,CardCode" }
      );
      const encontrados = res.value ?? [];

      if (encontrados.length) {
        const doc = encontrados[0];
        const errorMsg = `OC duplicada en SAP para ${order.CardCode}: DocEntry=${doc.DocEntry}, DocNum=${doc.DocNum}`;
        db.prepare(`
          UPDATE pedidos_maestro SET
            estado='ERROR_DUPLICADO', sap_existe=1, sap_doc_entry=?, sap_doc_num=?,
            sap_query_resultado=?, ts_sap_query=?, fase_actual=2, error_msg=?
          WHERE orden_compra=?
        `).run(doc.DocEntry, String(doc.DocNum), JSON.stringify(doc), now, errorMsg, oc);
        logPipeline(db, oc, 2, "validate", "ERROR", `Duplicado: DocEntry=${doc.DocEntry}`);
        result.errores++;
        result.detalles.push(`✗ OC ${oc} → ERROR_DUPLICADO (DocEntry ${doc.DocEntry})`);

        // No se envía alerta inmediata aquí: step6 ya notifica ERROR_DUPLICADO
        // con el template completo (DocNum, cliente, precios). Dos emails por el mismo
        // evento generan ruido sin agregar información adicional.

      } else {
        const resultado = JSON.stringify({ errores: [], n_items: n });
        db.prepare(`
          UPDATE pedidos_maestro SET
            estado='PARSE_VALIDO', sap_existe=0, sap_query_resultado='[]', ts_sap_query=?,
            fase_actual=2, error_msg=NULL, validacion_resultado=?
          WHERE orden_compra=?
        `).run(now, resultado, oc);
        logPipeline(db, oc, 2, "validate", "OK", `${n} ítem(s) OK — no duplicado en SAP`);
        result.procesados++;
        result.detalles.push(`✓ OC ${oc} → PARSE_VALIDO (${n} ítems)`);
      }
    } catch (e) {
      // Error de consulta SAP: dejar en PARSE_VALIDO para retry en próxima corrida
      const resultado = JSON.stringify({ errores: [], n_items: n });
      db.prepare(`
        UPDATE pedidos_maestro SET estado='PARSE_VALIDO', fase_actual=2, error_msg=NULL, validacion_resultado=?
        WHERE orden_compra=?
      `).run(resultado, oc);
      logPipeline(db, oc, 2, "validate", "WARN", `Error SAP en check duplicado: ${String(e).slice(0, 500)}`);
      result.procesados++;
      result.detalles.push(`⚠ OC ${oc} → PARSE_VALIDO (formato OK; error SAP al verificar duplicado: ${String(e).slice(0, 60)})`);
    }
  }

  return result;
}
