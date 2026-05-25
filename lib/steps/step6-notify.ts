/**
 * Step 6: Enviar correo resumen de pedidos procesados.
 *
 * Recoge todos los pedidos en estado terminal (VALIDADO, ERROR_*…),
 * genera un email HTML con resumen + detalle de discrepancias y lo envía.
 * Transiciona los pedidos a NOTIFICADO para que step7 los archive.
 *
 * VALIDADO | ERROR_* | SAP_MONTADO → NOTIFICADO
 */

import fs from "fs";
import path from "path";
import nodemailer from "nodemailer";
import { getConfig } from "../config";
import { getDb, logPipeline } from "../db";
import { buildSubjectForOrder, buildHtmlForOrder } from "./step6-templates";

const LOGO_PATH = path.resolve(process.cwd(), "public/brand/logos/Export/Logo V1 - Naranja.png");

export interface StepResult {
  procesados: number;
  errores: number;
  saltados: number;
  detalles: string[];
}

const ESTADOS_A_NOTIFICAR = [
  "VALIDADO", "SAP_MONTADO", "CATALOG_OK",
  "ERROR_DUPLICADO", "ERROR_ITEMS", "ERROR_SAP", "ERROR_PARSE", "ERROR_VALIDACION", "ERROR_CATALOG",
  "NOTIFICANDO",
] as const;

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

  const isMicrosoft = config.emailProvider === "microsoft";

  if (isMicrosoft) {
    if (!config.emailUser || !config.msClientId || !config.msTenantId || !config.msClientSecret) {
      for (const row of rows) {
        logPipeline(db, String(row.orden_compra), 6, "notify", "ERROR",
          "Faltan credenciales Microsoft Graph — pedido pendiente de notificación");
      }
      result.errores = rows.length;
      result.detalles.push(`✗ Faltan credenciales Microsoft Graph — ${rows.length} pedido(s) sin notificar`);
      return result;
    }
  } else {
    if (!config.emailUser || !config.emailPass || !config.smtpHost) {
      for (const row of rows) {
        logPipeline(db, String(row.orden_compra), 6, "notify", "ERROR",
          "Faltan credenciales SMTP — pedido pendiente de notificación");
      }
      result.errores = rows.length;
      result.detalles.push(`✗ Faltan credenciales SMTP — ${rows.length} pedido(s) sin notificar`);
      return result;
    }
  }

  const fecha = new Date().toISOString().split("T")[0];

  // Para IMAP/SMTP — se inicializa solo si no es Microsoft
  const transporter = isMicrosoft ? null : nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    requireTLS: config.smtpPort !== 465,
    auth: { user: config.emailUser, pass: config.emailPass },
  });

  // Para Microsoft Graph — token compartido por todos los envíos de este run
  let graphToken: string | null = null;
  if (isMicrosoft) {
    const { getAccessToken } = await import("../microsoft-graph");
    graphToken = await getAccessToken(config.msTenantId, config.msClientId, config.msClientSecret);
  }

  const now = new Date().toISOString();

  for (const row of rows) {
    const oc = String(row.orden_compra);
    try {
      // Recuperación: si el proceso se cayó después de enviar el email pero antes de
      // actualizar la DB, notificacion_enviada=1 indica que no hay que reenviar.
      if (row.estado === "NOTIFICANDO" && Number(row.notificacion_enviada) === 1) {
        db.prepare(`
          UPDATE pedidos_maestro SET estado='NOTIFICADO', ts_notified=?, fase_actual=6
          WHERE orden_compra=?
        `).run(now, oc);
        logPipeline(db, oc, 6, "notify", "OK", "Recuperado: email ya enviado en run anterior");
        result.procesados++;
        result.detalles.push(`↩ OC ${oc} → NOTIFICADO (recuperado, email ya enviado)`);
        continue;
      }

      // Registrar intención antes de enviar: transicionar a NOTIFICANDO
      db.prepare(`
        UPDATE pedidos_maestro SET estado='NOTIFICANDO', notificacion_enviada=0
        WHERE orden_compra=?
      `).run(oc);

      // Detectar si el correo original tenía archivos extra no aprobados
      let hasExtraFiles = false;
      let archivosExtra = "";
      try {
        const carpeta = String(row.carpeta_origen ?? "");
        if (carpeta) {
          const meta = JSON.parse(fs.readFileSync(path.join(carpeta, "correo_metadata.json"), "utf8"));
          hasExtraFiles = meta.has_extra_files === true;
          archivosExtra = meta.archivos_extra ?? "";
        }
      } catch { /* ignorar si no hay metadata */ }

      let html = buildHtmlForOrder(db, row, fecha);
      if (hasExtraFiles) {
        const nota = `
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0">
  <tr>
    <td style="background:#fff7ed;border:1px solid #ff6e00;border-radius:6px;padding:12px 16px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#c2410c">
      <b>⚠ Este correo contiene más PDFs</b><br>
      <span style="color:#78350f;font-size:12px">Archivos no procesados: ${archivosExtra || "ver correo original en A A SANDRA"}</span>
    </td>
  </tr>
</table>`;
        html = html.replace("</body>", `${nota}</body>`);
      }

      if (isMicrosoft && graphToken) {
        const { sendMailGraph } = await import("../microsoft-graph");
        let logoBytes = "";
        try { logoBytes = fs.readFileSync(LOGO_PATH).toString("base64"); } catch { /* sin logo */ }
        await sendMailGraph(
          graphToken,
          config.emailUser,
          config.notifyEmail,
          config.notifyCcEmail || undefined,
          buildSubjectForOrder(row, hasExtraFiles),
          html,
          logoBytes ? [{ name: "logo.png", contentType: "image/png", contentBytes: logoBytes, contentId: "logo" }] : []
        );
      } else {
        await transporter!.sendMail({
          from: config.emailUser,
          to: config.notifyEmail,
          ...(config.notifyCcEmail ? { cc: config.notifyCcEmail } : {}),
          subject: buildSubjectForOrder(row, hasExtraFiles),
          html,
          attachments: [
            { filename: "logo.png", path: LOGO_PATH, cid: "logo" },
          ],
        });
      }

      // Marcar que el email fue enviado ANTES de actualizar el estado final.
      // Si el proceso se cae aquí, el próximo run detecta notificacion_enviada=1
      // y no reenvía.
      db.prepare(`
        UPDATE pedidos_maestro SET notificacion_enviada=1, estado='NOTIFICADO', ts_notified=?, fase_actual=6
        WHERE orden_compra=?
      `).run(now, oc);
      logPipeline(db, oc, 6, "notify", "OK", `Email → ${config.notifyEmail}`);
      result.procesados++;
      result.detalles.push(`✓ OC ${oc} → NOTIFICADO`);
    } catch (e) {
      logPipeline(db, oc, 6, "notify", "ERROR", String(e).slice(0, 120));
      result.errores++;
      result.detalles.push(`✗ OC ${oc}: ${String(e).slice(0, 80)}`);
    }
  }

  return result;
}
