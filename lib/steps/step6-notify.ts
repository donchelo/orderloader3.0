/**
 * Step 6: Enviar correo resumen de pedidos procesados.
 *
 * Recoge todos los pedidos en estado terminal (VALIDADO, ERROR_*…),
 * genera un email HTML con resumen + detalle de discrepancias y lo envía.
 * Transiciona los pedidos a NOTIFICADO para que step7 los archive.
 *
 * VALIDADO | ERROR_* | SAP_MONTADO → NOTIFICADO
 */

import nodemailer from "nodemailer";
import { getConfig } from "../config";
import { getDb, logPipeline } from "../db";

export interface StepResult {
  procesados: number;
  errores: number;
  saltados: number;
  detalles: string[];
}

const ESTADOS_A_NOTIFICAR = [
  "VALIDADO", "SAP_MONTADO",
  "ERROR_DUPLICADO", "ERROR_ITEMS", "ERROR_SAP", "ERROR_PARSE", "ERROR_VALIDACION",
] as const;

const ESTADO_COLOR: Record<string, string> = {
  VALIDADO:          "#d4edda",
  SAP_MONTADO:       "#d4edda",
  ERROR_DUPLICADO:   "#f8d7da",
  ERROR_ITEMS:       "#f8d7da",
  ERROR_SAP:         "#f8d7da",
  ERROR_PARSE:       "#f8d7da",
  ERROR_VALIDACION:  "#fff3cd",
};

const SAP_ERROR_CODES: Record<string, string> = {
  "-1116": "Artículo sin precio en la lista de precios de SAP — pedido NO creado",
  "-8112": "Error en datos del documento (serie de numeración o socio de negocio) — pedido NO creado",
  "-10":   "Sin autorización en SAP — pedido NO creado",
};

function parseSapError(errorMsg: string): string {
  const codeMatch = errorMsg.match(/"code"\s*:\s*"(-?\d+)"/);
  if (codeMatch) {
    const code = codeMatch[1];
    if (SAP_ERROR_CODES[code]) return SAP_ERROR_CODES[code];
    const msgMatch = errorMsg.match(/"message"\s*:\s*"([^"]{4,})"/);
    if (msgMatch) return `Error SAP (${code}): ${msgMatch[1].slice(0, 100)} — pedido NO creado`;
    return `Error SAP (código ${code}) — pedido NO creado`;
  }
  return errorMsg.replace(/Error: SAP \w+ https?:\/\/\S+ → \d+:\s*/i, "").slice(0, 120);
}

function parseExcluidos(row: Record<string, unknown>): string[] {
  try {
    if (row.items_excluidos) return JSON.parse(String(row.items_excluidos)) as string[];
  } catch { /* ignore */ }
  return [];
}

function buildDetalle(row: Record<string, unknown>): string {
  const estado = String(row.estado);
  const excluidos = parseExcluidos(row);
  const exclMsg = excluidos.length
    ? ` — ${excluidos.length} artículo(s) sin catálogo de cliente` : "";

  if ((estado === "VALIDADO" || estado === "SAP_MONTADO") && row.sap_doc_num) {
    return `DocNum SAP: ${row.sap_doc_num}${exclMsg}`;
  }

  if (estado === "ERROR_VALIDACION" && row.validacion_resultado) {
    try {
      const r = JSON.parse(String(row.validacion_resultado)) as { diferencias?: unknown[]; docNum?: string };
      const docPart = r.docNum ? ` (DocNum SAP: ${r.docNum})` : "";
      if (r.diferencias?.length) return `${r.diferencias.length} diferencia(s)${docPart} — ver detalle abajo${exclMsg}`;
    } catch { /* ignore */ }
  }

  if (row.error_msg) return parseSapError(String(row.error_msg));

  return "";
}

function buildDiscrepanciasHtml(rows: Array<Record<string, unknown>>): string {
  const conDifs = rows.filter(r => r.estado === "ERROR_VALIDACION" && r.validacion_resultado);
  if (!conDifs.length) return "";

  const secciones = conDifs.map(row => {
    let diferencias: Array<{ campo: string; pdf: string | number; sap: string | number }> = [];
    let docNum = row.sap_doc_num ?? "";
    try {
      const r = JSON.parse(String(row.validacion_resultado)) as {
        diferencias?: typeof diferencias;
        docNum?: string;
      };
      diferencias = r.diferencias ?? [];
      if (r.docNum) docNum = r.docNum;
    } catch { /* ignore */ }

    if (!diferencias.length) return "";

    const filas = diferencias.map(d => {
      const esPrecio = String(d.campo).startsWith("Precio");
      const esExcluido = String(d.campo).startsWith("Artículo no subido");
      const rowColor = esPrecio ? "#f8d7da" : esExcluido ? "#f8d7da" : "#fff3cd";

      const fmtNum = (v: string | number) =>
        typeof v === "number"
          ? v.toLocaleString("es-CO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          : String(v);

      let deltaCel = `<td style="padding:4px 10px"></td>`;
      if (esPrecio && typeof d.pdf === "number" && typeof d.sap === "number") {
        const delta = d.sap - d.pdf;
        const pct   = d.pdf !== 0 ? ((delta / d.pdf) * 100).toFixed(1) : "—";
        const sign  = delta > 0 ? "+" : "";
        const color = delta !== 0 ? "#721c24" : "inherit";
        deltaCel = `<td style="padding:4px 10px;color:${color};font-weight:bold">${sign}${fmtNum(delta)} (${sign}${pct}%)</td>`;
      }

      return `<tr style="background:${rowColor}">
        <td style="padding:4px 10px">${d.campo}</td>
        <td style="padding:4px 10px">${fmtNum(d.pdf)}</td>
        <td style="padding:4px 10px">${fmtNum(d.sap)}</td>
        ${deltaCel}
      </tr>`;
    }).join("");

    return `
    <div style="margin:16px 0;border:1px solid #dc3545;border-radius:4px;overflow:hidden">
      <div style="background:#dc3545;color:#fff;padding:6px 12px;font-weight:bold">
        ⚠ OC ${row.orden_compra}${docNum ? ` — DocNum SAP: ${docNum}` : ""} — Discrepancias
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead style="background:#343a40;color:#fff">
          <tr>
            <th style="padding:6px 10px;text-align:left">Campo</th>
            <th style="padding:6px 10px;text-align:left">PDF</th>
            <th style="padding:6px 10px;text-align:left">SAP</th>
            <th style="padding:6px 10px;text-align:left">Diferencia</th>
          </tr>
        </thead>
        <tbody>${filas}</tbody>
      </table>
    </div>`;
  }).join("");

  return `<h3 style="margin-top:24px;margin-bottom:8px">Detalle de discrepancias</h3>${secciones}`;
}

function buildPreciosHtml(db: any, rows: Array<Record<string, unknown>>): string {
  const relevantes = rows.filter(r =>
    r.estado === "VALIDADO" || r.estado === "SAP_MONTADO" || r.estado === "ERROR_VALIDACION"
  );
  if (!relevantes.length) return "";

  const fmtCOP = (v: number) =>
    v > 0
      ? v.toLocaleString("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 })
      : `<span style="color:#dc3545;font-weight:bold">$0 ⚠</span>`;

  const secciones = relevantes.map(row => {
    const lineas = db.prepare(
      "SELECT codigo_producto, cantidad, precio_unitario, subtotal_item FROM pedidos_detalle WHERE orden_compra = ? ORDER BY id"
    ).all(row.orden_compra) as Array<{ codigo_producto: string; cantidad: number; precio_unitario: number; subtotal_item: number }>;

    if (!lineas.length) return "";

    // Índice de precios con error por SupplierCatNum
    const preciosMalos = new Map<string, number>();
    try {
      const v = JSON.parse(String(row.validacion_resultado ?? "{}")) as { diferencias?: Array<{ campo: string; sap: number }> };
      for (const d of v.diferencias ?? []) {
        const m = d.campo.match(/^Precio \[(.+)\]$/);
        if (m) preciosMalos.set(m[1], Number(d.sap));
      }
    } catch { /* ignore */ }

    const filas = lineas.map(l => {
      const tieneMalo = preciosMalos.has(l.codigo_producto);
      const sapPrice = preciosMalos.get(l.codigo_producto) ?? l.precio_unitario;
      const bg = tieneMalo ? "#fff3cd" : "#f6fff6";
      const icono = tieneMalo ? "⚠" : "✓";
      const colorIcono = tieneMalo ? "#856404" : "#198754";

      return `<tr style="background:${bg}">
        <td style="padding:5px 10px;font-family:monospace;font-size:11px">${l.codigo_producto}</td>
        <td style="padding:5px 10px;text-align:right">${l.cantidad}</td>
        <td style="padding:5px 10px;text-align:right">${fmtCOP(l.precio_unitario)}</td>
        <td style="padding:5px 10px;text-align:right">${tieneMalo ? fmtCOP(sapPrice) : "—"}</td>
        <td style="padding:5px 10px;text-align:right">${fmtCOP(l.subtotal_item)}</td>
        <td style="padding:5px 10px;text-align:center;color:${colorIcono};font-weight:bold">${icono}</td>
      </tr>`;
    }).join("");

    const tituloColor = preciosMalos.size > 0 ? "#856404" : "#155724";
    const tituloBg    = preciosMalos.size > 0 ? "#fff3cd" : "#d4edda";

    return `
    <div style="margin:16px 0;border:1px solid #dee2e6;border-radius:4px;overflow:hidden">
      <div style="background:${tituloBg};color:${tituloColor};padding:6px 12px;font-weight:bold">
        OC ${row.orden_compra} — ${row.cliente_nombre}${row.sap_doc_num ? ` (DocNum SAP: ${row.sap_doc_num})` : ""}
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead style="background:#343a40;color:#fff">
          <tr>
            <th style="padding:6px 10px;text-align:left">Artículo</th>
            <th style="padding:6px 10px;text-align:right">Cant.</th>
            <th style="padding:6px 10px;text-align:right">Precio Unit. PDF</th>
            <th style="padding:6px 10px;text-align:right">Precio Unit. SAP</th>
            <th style="padding:6px 10px;text-align:right">Subtotal PDF</th>
            <th style="padding:6px 10px;text-align:center">OK</th>
          </tr>
        </thead>
        <tbody>${filas}</tbody>
      </table>
    </div>`;
  }).join("");

  return `<h3 style="margin-top:24px;margin-bottom:8px">Detalle de precios por línea</h3>${secciones}`;
}

function buildExcluidosHtml(rows: Array<Record<string, unknown>>): string {
  const parciales = rows.filter(r =>
    (r.estado === "SAP_MONTADO" || r.estado === "VALIDADO") && parseExcluidos(r).length > 0
  );
  if (!parciales.length) return "";

  const secciones = parciales.map(row => {
    const excluidos = parseExcluidos(row);
    const filas = excluidos.map(cat =>
      `<tr style="background:#f8d7da">
        <td style="padding:5px 12px">⛔</td>
        <td style="padding:5px 12px;font-family:monospace">${cat}</td>
        <td style="padding:5px 12px;color:#721c24">Catálogo de cliente no existe</td>
      </tr>`
    ).join("");

    return `
    <div style="margin:16px 0;border:1px solid #f5c6cb;border-radius:4px;overflow:hidden">
      <div style="background:#f5c6cb;padding:6px 12px;font-weight:bold;color:#721c24">
        ⛔ OC ${row.orden_compra} — ${row.cliente_nombre}${row.sap_doc_num ? ` (DocNum SAP: ${row.sap_doc_num})` : ""} — Artículos sin catálogo de cliente
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead style="background:#343a40;color:#fff">
          <tr>
            <th style="padding:6px 10px"></th>
            <th style="padding:6px 10px;text-align:left">SupplierCatNum</th>
            <th style="padding:6px 10px;text-align:left">Motivo</th>
          </tr>
        </thead>
        <tbody>${filas}</tbody>
      </table>
    </div>`;
  }).join("");

  return `<h3 style="margin-top:24px;margin-bottom:8px;color:#721c24">⛔ Artículos no subidos a SAP — Sin catálogo de cliente</h3>${secciones}`;
}

function buildCostHtml(db: any, rows: Array<Record<string, unknown>>): string {
  const ocs = rows.map(r => r.orden_compra);
  if (!ocs.length) return "";

  const placeholders = ocs.map(() => "?").join(",");
  const usage = db.prepare(`
    SELECT SUM(input_tokens) as input, SUM(output_tokens) as output
    FROM pipeline_log
    WHERE orden_compra IN (${placeholders}) AND fase_nombre = 'parse'
  `).get(...ocs) as { input: number | null, output: number | null };

  if (!usage || (usage.input === null && usage.output === null)) return "";

  const PRICING = { input: 3.0, output: 15.0, trm: 4000 };
  const inTokens = usage.input || 0;
  const outTokens = usage.output || 0;
  const inUsd = (inTokens / 1000000) * PRICING.input;
  const outUsd = (outTokens / 1000000) * PRICING.output;
  const totalCop = (inUsd + outUsd) * PRICING.trm;

  return `
  <div style="margin-top:24px;padding:12px;background:#f8f9fa;border:1px solid #dee2e6;border-radius:4px">
    <h4 style="margin:0 0 8px 0;color:#495057">📊 Resumen de Consumo IA (Anthropic)</h4>
    <table style="font-size:12px;color:#6c757d">
      <tr><td>Tokens Entrada:</td><td style="padding-left:12px">${inTokens.toLocaleString()}</td></tr>
      <tr><td>Tokens Salida:</td><td style="padding-left:12px">${outTokens.toLocaleString()}</td></tr>
      <tr><td><b>Inversión Est. (COP):</b></td><td style="padding-left:12px"><b>$${totalCop.toFixed(0)} COP</b></td></tr>
    </table>
    <p style="font-size:10px;margin:8px 0 0 0;color:#adb5bd">* Calculado con TRM $${PRICING.trm} y precios oficiales Claude 3.5 Sonnet</p>
  </div>`;
}

function buildHtml(db: any, rows: Array<Record<string, unknown>>, fecha: string): string {
  const filas = rows.map(row => {
    const estado = String(row.estado);
    const esParcial = (estado === "SAP_MONTADO" || estado === "VALIDADO") && parseExcluidos(row).length > 0;
    const color = esParcial ? "#fff3cd" : (ESTADO_COLOR[estado] ?? "#ffffff");
    const estadoLabel = esParcial ? `${estado} ⚠ PARCIAL` : estado;
    return `<tr style="background:${color}">
      <td style="padding:6px 12px">${row.orden_compra}</td>
      <td style="padding:6px 12px">${row.cliente_nombre}</td>
      <td style="padding:6px 12px"><b>${estadoLabel}</b></td>
      <td style="padding:6px 12px">${buildDetalle(row)}</td>
    </tr>`;
  }).join("");

  return `<html><body style="font-family:Arial,sans-serif;font-size:13px">
  <h2 style="margin-bottom:4px">Resumen OrderLoader — ${fecha}</h2>
  <table border="1" cellspacing="0" style="border-collapse:collapse;width:100%;margin-top:12px">
    <thead style="background:#343a40;color:#fff">
      <tr>
        <th style="padding:8px">OC</th>
        <th style="padding:8px">Cliente</th>
        <th style="padding:8px">Estado</th>
        <th style="padding:8px;text-align:left">Detalle</th>
      </tr>
    </thead>
    <tbody>${filas}</tbody>
  </table>
  ${buildPreciosHtml(db, rows)}
  ${buildExcluidosHtml(rows)}
  ${buildDiscrepanciasHtml(rows)}
  ${buildCostHtml(db, rows)}
  <p style="color:#888;font-size:11px;margin-top:16px">
    Generado automáticamente por OrderLoader Pipeline · ${fecha}
  </p>
  </body></html>`;
}

export async function run(): Promise<StepResult> {
  const config = getConfig();
  const result: StepResult = { procesados: 0, errores: 0, saltados: 0, detalles: [] };
  const db = getDb();

  const placeholders = ESTADOS_A_NOTIFICAR.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT * FROM pedidos_maestro WHERE estado IN (${placeholders})`
  ).all(...ESTADOS_A_NOTIFICAR) as Array<Record<string, unknown>>;

  if (!rows.length) {
    result.detalles.push("No hay pedidos pendientes de notificación");
    return result;
  }

  if (!config.emailUser || !config.emailPass || !config.smtpHost) {
    for (const row of rows) {
      logPipeline(db, String(row.orden_compra), 6, "notify", "ERROR",
        "Faltan credenciales SMTP — pedido pendiente de notificación");
    }
    result.errores = rows.length;
    result.detalles.push(`✗ Faltan credenciales SMTP — ${rows.length} pedido(s) sin notificar`);
    return result;
  }

  const fecha = new Date().toISOString().split("T")[0];
  const nOk = rows.filter(r =>
    (r.estado === "VALIDADO" || r.estado === "SAP_MONTADO") && !parseExcluidos(r).length
  ).length;
  const nParcial = rows.filter(r =>
    (r.estado === "VALIDADO" || r.estado === "SAP_MONTADO") && parseExcluidos(r).length > 0
  ).length;
  const nErr = rows.filter(r => String(r.estado).startsWith("ERROR_")).length;

  const ocs = [...new Set(rows.map(r => String(r.orden_compra)))];
  const clientes = [...new Set(rows.map(r => String(r.cliente_nombre || "")).filter(Boolean))];
  const ocPart = ocs.length === 1 ? `OC ${ocs[0]}` : `${ocs.length} OC(s): ${ocs.join(", ")}`;
  const clientePart = clientes.length <= 2 ? clientes.join(" / ") : `${clientes.length} clientes`;
  const estadoPart = nErr > 0
    ? `${nErr} error(es)${nOk + nParcial > 0 ? ` · ${nOk + nParcial} OK` : ""}`
    : `${nOk} OK${nParcial > 0 ? ` · ${nParcial} parcial(es)` : ""}`;
  const subject = `[OrderLoader] ${ocPart} | ${clientePart} | ${estadoPart}`;
  const html = buildHtml(db, rows, fecha);

  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: false,
    auth: { user: config.emailUser, pass: config.emailPass },
  });

  try {
    await transporter.sendMail({
      from: config.emailUser,
      to: config.notifyEmail,
      cc: "pedidos@tamaprint.com",
      subject,
      html,
    });

    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      for (const row of rows) {
        db.prepare(`
          UPDATE pedidos_maestro SET estado='NOTIFICADO', ts_notified=?, fase_actual=6
          WHERE orden_compra=?
        `).run(now, row.orden_compra);
        logPipeline(db, String(row.orden_compra), 6, "notify", "OK", `Email → ${config.notifyEmail}`);
      }
    });
    tx();

    result.procesados = rows.length;
    result.detalles.push(`✓ Email enviado a ${config.notifyEmail}: ${rows.length} pedido(s) → NOTIFICADO`);
  } catch (e) {
    result.errores = rows.length;
    result.detalles.push(`✗ Error enviando email: ${String(e)}`);
    for (const row of rows) {
      logPipeline(db, String(row.orden_compra), 6, "notify", "ERROR", String(e).slice(0, 120));
    }
  }

  return result;
}
