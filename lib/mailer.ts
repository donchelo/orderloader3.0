/**
 * Utilidad compartida para envío de emails de alerta.
 * Usada por step1, step2 y step3 para notificar errores tempranos.
 */

import nodemailer from "nodemailer";
import { getConfig } from "./config";

export async function sendAlertEmail(subject: string, html: string): Promise<void> {
  const config = getConfig();
  if (!config.emailUser) return;

  if (config.emailProvider === "microsoft") {
    if (!config.msClientId || !config.msTenantId || !config.msClientSecret) return;
    const { getAccessToken, sendMailGraph } = await import("./microsoft-graph");
    const token = await getAccessToken(config.msTenantId, config.msClientId, config.msClientSecret);
    await sendMailGraph(token, config.emailUser, config.notifyAlertasEmail, undefined, subject, html);
    return;
  }

  if (!config.emailPass || !config.smtpHost) return;
  const t = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    requireTLS: config.smtpPort !== 465,
    auth: { user: config.emailUser, pass: config.emailPass },
  });
  await t.sendMail({ from: config.emailUser, to: config.notifyAlertasEmail, subject, html });
}
