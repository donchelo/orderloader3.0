import type Database from "better-sqlite3";
import { AI4U_PALETTE } from "@ai4u/design-system/tokens";

// ─── Brand Tokens ─────────────────────────────────────────────────────────────
const B = {
  mintCream:     AI4U_PALETTE.mintCream,
  erieBlack:     AI4U_PALETTE.erieBlack,
  hotOrange:     AI4U_PALETTE.hotOrange,
  moderateBlue:  AI4U_PALETTE.moderateBlue,
  cadetGray:     AI4U_PALETTE.cadetGray,
  white:         AI4U_PALETTE.white,
  // Email status colors (semantic, not brand palette)
  successBg:     "#dff4fb",
  successText:   "#0369a1",
  successBorder: AI4U_PALETTE.moderateBlue,
  warnBg:        "#fff7ed",
  warnText:      "#c2410c",
  warnBorder:    AI4U_PALETTE.hotOrange,
  errorBg:       "#fde8e8",
  errorText:     "#b91c1c",
  errorBorder:   "#fca5a5",
};

const FONT = `'Red Hat Display',Arial,Helvetica,sans-serif`;

// ─── Status helpers ───────────────────────────────────────────────────────────
function statusColors(estado: string, esParcial: boolean) {
  if (esParcial)
    return { bg: B.warnBg, text: B.warnText, border: B.warnBorder };
  if (estado === "VALIDADO" || estado === "SAP_MONTADO")
    return { bg: B.successBg, text: B.successText, border: B.successBorder };
  if (estado === "ERROR_VALIDACION")
    return { bg: B.warnBg, text: B.warnText, border: B.warnBorder };
  return { bg: B.errorBg, text: B.errorText, border: B.errorBorder };
}

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

export function parseExcluidos(row: Record<string, unknown>): string[] {
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

  if ((estado === "VALIDADO" || estado === "SAP_MONTADO") && row.sap_doc_num)
    return `DocNum SAP: ${row.sap_doc_num}${exclMsg}`;

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

// ─── Section builders ─────────────────────────────────────────────────────────

function sectionTitle(text: string, color: string = B.erieBlack): string {
  return `<tr><td style="padding:24px 0 8px 0;font-family:${FONT};font-size:14px;font-weight:700;color:${color};letter-spacing:0.05em">${text}</td></tr>`;
}

function theadRow(...cols: string[]): string {
  const cells = cols.map(c =>
    `<th style="padding:8px 12px;text-align:left;font-family:${FONT};font-size:12px;font-weight:600;color:${B.white};letter-spacing:0.05em;white-space:nowrap">${c}</th>`
  ).join("");
  return `<thead><tr style="background:${B.erieBlack}">${cells}</tr></thead>`;
}

function buildDiscrepanciasHtml(rows: Array<Record<string, unknown>>): string {
  const conDifs = rows.filter(r => r.estado === "ERROR_VALIDACION" && r.validacion_resultado);
  if (!conDifs.length) return "";

  const secciones = conDifs.map(row => {
    let diferencias: Array<{ campo: string; pdf: string | number; sap: string | number }> = [];
    let docNum = row.sap_doc_num ?? "";
    try {
      const r = JSON.parse(String(row.validacion_resultado)) as { diferencias?: typeof diferencias; docNum?: string };
      diferencias = r.diferencias ?? [];
      if (r.docNum) docNum = r.docNum;
    } catch { /* ignore */ }
    if (!diferencias.length) return "";

    const fmtNum = (v: string | number) =>
      typeof v === "number"
        ? v.toLocaleString("es-CO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : String(v);

    const filas = diferencias.map(d => {
      const esPrecio   = String(d.campo).startsWith("Precio");
      const esExcluido = String(d.campo).startsWith("Artículo no subido");
      const rowBg      = esPrecio || esExcluido ? B.errorBg : B.warnBg;

      let deltaCel = `<td style="padding:6px 12px"></td>`;
      if (esPrecio && typeof d.pdf === "number" && typeof d.sap === "number") {
        const delta = d.sap - d.pdf;
        const pct   = d.pdf !== 0 ? ((delta / d.pdf) * 100).toFixed(1) : "—";
        const sign  = delta > 0 ? "+" : "";
        deltaCel = `<td style="padding:6px 12px;color:${B.errorText};font-weight:700;font-family:${FONT}">${sign}${fmtNum(delta)} (${sign}${pct}%)</td>`;
      }

      return `<tr style="background:${rowBg}">
        <td style="padding:6px 12px;font-family:${FONT};font-size:12px;color:${B.erieBlack}">${d.campo}</td>
        <td style="padding:6px 12px;font-family:${FONT};font-size:12px">${fmtNum(d.pdf)}</td>
        <td style="padding:6px 12px;font-family:${FONT};font-size:12px">${fmtNum(d.sap)}</td>
        ${deltaCel}
      </tr>`;
    }).join("");

    const headerLabel = `OC ${row.orden_compra}${docNum ? ` — DocNum SAP: ${docNum}` : ""} — Discrepancias`;

    return `
    <tr><td style="padding-bottom:12px">
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${B.errorBorder};border-radius:8px;overflow:hidden">
        <thead>
          <tr>
            <td colspan="4" style="background:${B.errorBg};padding:10px 12px;border-bottom:2px solid ${B.errorBorder}">
              <span style="font-family:${FONT};font-size:13px;font-weight:700;color:${B.errorText}">⚠ ${headerLabel}</span>
            </td>
          </tr>
          ${theadRow("Campo", "PDF", "SAP", "Diferencia").replace("<thead>", "").replace("</thead>", "")}
        </thead>
        <tbody>${filas}</tbody>
      </table>
    </td></tr>`;
  }).join("");

  return `<table width="100%" cellpadding="0" cellspacing="0">
    ${sectionTitle("Detalle de discrepancias", B.warnText)}
    ${secciones}
  </table>`;
}

function buildPreciosHtml(db: Database.Database, rows: Array<Record<string, unknown>>): string {
  const relevantes = rows.filter(r =>
    r.estado === "VALIDADO" || r.estado === "SAP_MONTADO" || r.estado === "ERROR_VALIDACION"
  );
  if (!relevantes.length) return "";

  const fmtCOP = (v: number) =>
    v > 0
      ? v.toLocaleString("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 })
      : `<span style="color:${B.errorText};font-weight:700">$0 ⚠</span>`;

  const secciones = relevantes.map(row => {
    const excluidos = parseExcluidos(row);
    const todasLineas = db.prepare(
      "SELECT codigo_producto, descripcion, cantidad, precio_unitario, subtotal_item FROM pedidos_detalle WHERE orden_compra = ? ORDER BY id"
    ).all(row.orden_compra) as Array<{ codigo_producto: string; descripcion: string; cantidad: number; precio_unitario: number; subtotal_item: number }>;
    const lineas = excluidos.length
      ? todasLineas.filter(l => !excluidos.includes(l.codigo_producto))
      : todasLineas;
    if (!lineas.length) return "";

    const preciosMalos = new Map<string, number>();
    try {
      const v = JSON.parse(String(row.validacion_resultado ?? "{}")) as { diferencias?: Array<{ campo: string; sap: number }> };
      for (const d of v.diferencias ?? []) {
        const m = d.campo.match(/^Precio \[(.+)\]$/);
        if (m) preciosMalos.set(m[1], Number(d.sap));
      }
    } catch { /* ignore */ }

    const filas = lineas.map(l => {
      const tieneMalo  = preciosMalos.has(l.codigo_producto);
      const sapPrice   = preciosMalos.get(l.codigo_producto) ?? l.precio_unitario;
      const rowBg      = tieneMalo ? B.warnBg : B.mintCream;
      const icono      = tieneMalo ? "⚠" : "✓";
      const iconColor  = tieneMalo ? B.warnText : B.successText;

      return `<tr style="background:${rowBg}">
        <td style="padding:6px 12px;font-family:monospace,${FONT};font-size:11px;color:${B.erieBlack}">${l.codigo_producto}</td>
        <td style="padding:6px 12px;font-family:${FONT};font-size:11px;color:${B.cadetGray}">${l.descripcion}</td>
        <td style="padding:6px 12px;text-align:right;font-family:${FONT};font-size:12px">${l.cantidad}</td>
        <td style="padding:6px 12px;text-align:right;font-family:${FONT};font-size:12px">${fmtCOP(l.precio_unitario)}</td>
        <td style="padding:6px 12px;text-align:right;font-family:${FONT};font-size:12px">${fmtCOP(sapPrice)}</td>
        <td style="padding:6px 12px;text-align:right;font-family:${FONT};font-size:12px">${fmtCOP(l.subtotal_item)}</td>
        <td style="padding:6px 12px;text-align:center;color:${iconColor};font-weight:700">${icono}</td>
      </tr>`;
    }).join("");

    const hasMalos     = preciosMalos.size > 0;
    const headerBg     = hasMalos ? B.warnBg : B.successBg;
    const headerText   = hasMalos ? B.warnText : B.successText;
    const headerBorder = hasMalos ? B.warnBorder : B.successBorder;
    const ocLabel      = `OC ${row.orden_compra} — ${row.cliente_nombre}${row.sap_doc_num ? ` (DocNum SAP: ${row.sap_doc_num})` : ""}`;

    return `
    <tr><td style="padding-bottom:12px">
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${headerBorder};border-radius:8px;overflow:hidden">
        <thead>
          <tr>
            <td colspan="6" style="background:${headerBg};padding:10px 12px;border-bottom:2px solid ${headerBorder}">
              <span style="font-family:${FONT};font-size:13px;font-weight:700;color:${headerText}">${ocLabel}</span>
            </td>
          </tr>
          ${theadRow("Artículo", "Descripción/Notas", "Cant.", "Precio PDF", "Precio SAP", "Subtotal PDF", "").replace("<thead>", "").replace("</thead>", "")}
        </thead>
        <tbody>${filas}</tbody>
      </table>
    </td></tr>`;
  }).join("");

  return `<table width="100%" cellpadding="0" cellspacing="0">
    ${sectionTitle("Detalle de precios por línea")}
    ${secciones}
  </table>`;
}

function buildExcluidosHtml(rows: Array<Record<string, unknown>>): string {
  const parciales = rows.filter(r =>
    (r.estado === "SAP_MONTADO" || r.estado === "VALIDADO") && parseExcluidos(r).length > 0
  );
  if (!parciales.length) return "";

  const secciones = parciales.map(row => {
    const excluidos = parseExcluidos(row);
    const filas = excluidos.map(cat =>
      `<tr style="background:${B.errorBg}">
        <td style="padding:6px 12px;color:${B.errorText}">⛔</td>
        <td style="padding:6px 12px;font-family:monospace,${FONT};font-size:11px;color:${B.erieBlack}">${cat}</td>
        <td style="padding:6px 12px;font-family:${FONT};font-size:12px;color:${B.errorText}">Catálogo de cliente no existe</td>
      </tr>`
    ).join("");

    const ocLabel = `OC ${row.orden_compra} — ${row.cliente_nombre}${row.sap_doc_num ? ` (DocNum SAP: ${row.sap_doc_num})` : ""} — Artículos sin catálogo`;

    return `
    <tr><td style="padding-bottom:12px">
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${B.errorBorder};border-radius:8px;overflow:hidden">
        <thead>
          <tr>
            <td colspan="3" style="background:${B.errorBg};padding:10px 12px;border-bottom:2px solid ${B.errorBorder}">
              <span style="font-family:${FONT};font-size:13px;font-weight:700;color:${B.errorText}">⛔ ${ocLabel}</span>
            </td>
          </tr>
          ${theadRow("", "SupplierCatNum", "Motivo").replace("<thead>", "").replace("</thead>", "")}
        </thead>
        <tbody>${filas}</tbody>
      </table>
    </td></tr>`;
  }).join("");

  return `<table width="100%" cellpadding="0" cellspacing="0">
    ${sectionTitle("⛔ Artículos no subidos a SAP — Sin catálogo de cliente", B.errorText)}
    ${secciones}
  </table>`;
}

// ─── Public exports ───────────────────────────────────────────────────────────

export function buildSubjectForOrder(row: Record<string, unknown>, hasExtraFiles = false, tenant = ""): string {
  const estado = String(row.estado);
  const esParcial = (estado === "SAP_MONTADO" || estado === "VALIDADO") && parseExcluidos(row).length > 0;
  const estadoLabel = esParcial ? `${estado} ⚠ PARCIAL` : estado;
  const extraSuffix = hasExtraFiles ? " | ⚠ Contiene más documentos" : "";
  const prefix = tenant ? `[OrderLoader/${tenant}]` : "[OrderLoader]";
  return `${prefix} OC ${row.orden_compra} | ${row.cliente_nombre || "—"} | ${estadoLabel}${extraSuffix}`;
}

export function buildHtmlForOrder(db: Database.Database, row: Record<string, unknown>, fecha: string): string {
  const estado    = String(row.estado);
  const esParcial = (estado === "SAP_MONTADO" || estado === "VALIDADO") && parseExcluidos(row).length > 0;
  const sc        = statusColors(estado, esParcial);
  const estadoLabel = esParcial ? `${estado} ⚠ PARCIAL` : estado;
  const detalle   = buildDetalle(row);

  const body = [
    buildPreciosHtml(db, [row]),
    buildExcluidosHtml([row]),
    buildDiscrepanciasHtml([row]),
  ].filter(Boolean).join("\n");

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link href="https://fonts.googleapis.com/css2?family=Red+Hat+Display:wght@400;500;600;700&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background:${B.mintCream};font-family:${FONT}">

<!-- Outer wrapper -->
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${B.mintCream}">
<tr><td align="center" style="padding:40px 16px">

  <!-- Card -->
  <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%">

    <!-- ── Header: erie-black ── -->
    <tr>
      <td style="background:${B.erieBlack};border-radius:16px 16px 0 0;padding:0">
        <!-- Orange accent bar -->
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td height="4" style="background:${B.hotOrange};font-size:0;line-height:0">&nbsp;</td>
        </tr></table>
        <!-- Logo + date row -->
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="padding:20px 32px 0 32px">
            <img src="cid:logo" alt="Ai4U OrderLoader" height="28" style="display:block;border:0;outline:0">
          </td>
          <td style="padding:20px 32px 0 0;text-align:right;font-family:${FONT};font-size:12px;color:${B.cadetGray};white-space:nowrap;letter-spacing:0.05em">
            ${fecha}
          </td>
        </tr></table>
        <!-- OC title -->
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="padding:12px 32px 24px 32px">
            <div style="font-family:${FONT};font-size:22px;font-weight:700;color:${B.white};letter-spacing:0.05em;line-height:1.2">
              OC ${row.orden_compra}
            </div>
            <div style="font-family:${FONT};font-size:13px;color:${B.cadetGray};margin-top:4px;letter-spacing:0.05em">
              ${row.cliente_nombre || "—"}
            </div>
          </td>
        </tr></table>
      </td>
    </tr>

    <!-- ── Status banner ── -->
    <tr>
      <td style="background:${sc.bg};border-left:4px solid ${sc.border};padding:14px 28px">
        <span style="font-family:${FONT};font-size:13px;font-weight:700;color:${sc.text};letter-spacing:0.05em">${estadoLabel}</span>
        ${detalle ? `<span style="font-family:${FONT};font-size:12px;color:${sc.text};margin-left:12px;opacity:0.85">${detalle}</span>` : ""}
      </td>
    </tr>

    <!-- ── Body: white ── -->
    <tr>
      <td style="background:${B.white};padding:24px 32px">
        ${body || `<p style="font-family:${FONT};font-size:13px;color:${B.cadetGray};margin:0">Sin detalles adicionales.</p>`}
      </td>
    </tr>

    <!-- ── Footer ── -->
    <tr>
      <td style="background:${B.mintCream};border-radius:0 0 16px 16px;padding:20px 32px;text-align:center;border-top:1px solid #c8e6cb">
        <span style="font-family:${FONT};font-size:11px;color:${B.cadetGray};letter-spacing:0.05em">
          Generado automáticamente por <strong style="color:${B.erieBlack}">OrderLoader Pipeline</strong> &middot; ${fecha}
        </span>
      </td>
    </tr>

  </table>
</td></tr>
</table>

</body>
</html>`;
}
