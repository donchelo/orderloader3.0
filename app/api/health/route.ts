import { NextResponse, NextRequest } from "next/server";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { getActiveSap, clearActiveSap } from "@/lib/sap-gateway";
import packageJson from "@/package.json";

export async function GET(req: NextRequest) {
  const { searchParams } = await Promise.resolve(new URL(req.url));
  const checkSap   = searchParams.get("check_sap")   === "true";
  const checkDeep  = searchParams.get("check_deep")  === "true"; // AI + email live test
  const config = getConfig();

  // ── DB ───────────────────────────────────────────────────────────────────────
  let dbStatus = "ok";
  let dbCount = 0;
  let lastPipelineRun: string | null = null;
  let lastPipelineHoursAgo: number | null = null;
  try {
    const db = getDb();
    dbCount = (db.prepare("SELECT COUNT(*) as c FROM pedidos_maestro").get() as { c: number }).c;
    const row = db
      .prepare(`SELECT MAX(ts) as last FROM pipeline_log WHERE fase_nombre = 'pipeline'`)
      .get() as { last: string | null };
    lastPipelineRun = row?.last ?? null;
    if (lastPipelineRun) {
      lastPipelineHoursAgo = Math.round((Date.now() - new Date(lastPipelineRun).getTime()) / 3_600_000 * 10) / 10;
    }
  } catch (e) {
    dbStatus = String(e);
  }

  // ── SAP ──────────────────────────────────────────────────────────────────────
  const usingBackend = !!(config.sapBackendUrl && config.sapBackendApiKey);
  const sapConfigured = usingBackend || !!(config.sapUrl && config.sapUser && config.sapPass && config.sapCompany);
  let sapStatus = sapConfigured ? "configured" : "missing_vars";
  let sapError: string | null = null;

  if (checkSap && sapConfigured) {
    try {
      clearActiveSap();
      await getActiveSap();
      sapStatus = "ok";
    } catch (e) {
      sapStatus = "error";
      sapError = String(e);
    }
  }

  // ── Email ────────────────────────────────────────────────────────────────────
  const emailConfigured = config.emailProvider === "microsoft"
    ? !!(config.msClientId && config.msTenantId && config.msClientSecret)
    : !!(config.emailUser && config.emailPass && config.emailHost);

  let emailStatus = emailConfigured ? "configured" : "missing_vars";

  if (checkDeep && emailConfigured) {
    try {
      if (config.emailProvider === "microsoft") {
        const { getAccessToken } = await import("@/lib/microsoft-graph");
        await getAccessToken(config.msTenantId, config.msClientId, config.msClientSecret);
        emailStatus = "ok";
      } else {
        const nodemailer = (await import("nodemailer")).default;
        const t = nodemailer.createTransport({
          host: config.smtpHost,
          port: config.smtpPort,
          secure: config.smtpPort === 465,
          requireTLS: config.smtpPort !== 465,
          auth: { user: config.emailUser, pass: config.emailPass },
        });
        await t.verify();
        emailStatus = "ok";
      }
    } catch (e) {
      emailStatus = `error: ${String(e).slice(0, 120)}`;
    }
  }

  // ── AI ───────────────────────────────────────────────────────────────────────
  const aiConfigured = !!process.env.ANTHROPIC_API_KEY;
  let aiStatus = aiConfigured ? "configured" : "missing_vars";

  if (checkDeep && aiConfigured) {
    try {
      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      });
      aiStatus = "ok";
    } catch (e) {
      aiStatus = `error: ${String(e).slice(0, 120)}`;
    }
  }

  // ── Missed cron warning (informacional — no afecta el HTTP status) ───────────
  // No usar para decidir allOk: un deploy post-fin-de-semana haría rollback innecesario.
  const missedCron = lastPipelineHoursAgo !== null && lastPipelineHoursAgo > 25;

  const allOk =
    dbStatus === "ok" &&
    (!checkSap || sapStatus === "ok") &&
    (!checkDeep || (emailStatus === "ok" && aiStatus === "ok"));

  return NextResponse.json(
    {
      ok: allOk,
      version: packageJson.version,
      tenant: config.tenant,
      db: { status: dbStatus, pedidos: dbCount },
      pipeline: {
        last_run: lastPipelineRun,
        hours_ago: lastPipelineHoursAgo,
        missed_cron: missedCron,
      },
      sap: {
        status: sapStatus,
        configured: sapConfigured,
        mode: usingBackend ? "backend" : "direct",
        url: usingBackend ? config.sapBackendUrl : (config.sapUrl || "(no configurado)"),
        error: sapError,
      },
      email: {
        status: emailStatus,
        configured: emailConfigured,
        provider: config.emailProvider,
        user: config.emailUser || "(no configurado)",
      },
      ai: {
        status: aiStatus,
        configured: aiConfigured,
      },
    },
    { status: allOk ? 200 : 503 },
  );
}
