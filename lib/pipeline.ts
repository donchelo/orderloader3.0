import { backupDb, migrate, getDb, logPipeline } from "./db";
import { getLogger, setRunContext, clearRunContext } from "./logger";
import { sendAlertEmail } from "./mailer";
import { getConfig } from "./config";

const log = getLogger("pipeline");
import { run as step0, recoverPendingMoves } from "./steps/step0-download";
import { run as step1 } from "./steps/step1-parse";
import { run as step2 } from "./steps/step2-validate-parse";
import { run as step3 } from "./steps/step3-sap-query";
import { run as step4 } from "./steps/step4-upload";
import { run as step5 } from "./steps/step5-reconcile";
import { run as step6 } from "./steps/step6-notify";
import { run as step7 } from "./steps/step7-archive";
import { clearSapClient, logoutSapClient } from "./sap-client";

export interface StepResult {
  step: number;
  name: string;
  procesados: number;
  errores: number;
  saltados: number;
  detalles: string[];
  duracionMs: number;
}

export interface PipelineOptions {
  fromStep?: number;
  toStep?: number;
  onlyStep?: number;
  maxIterations?: number;   // límite de correos por run (seguridad)
  onStep?: (result: StepResult) => void;
}

// ── Lock global para evitar runs simultáneos ──────────────────────────────
let _running = false;
let _stopRequested = false;

export function isPipelineRunning(): boolean { return _running; }
export function requestPipelineStop(): void  { _stopRequested = true; _liveState.stopRequested = true; }

// ── Estado vivo de la corrida actual (en memoria, compartido en el proceso) ──────
// Permite que la UI muestre el progreso de CUALQUIER corrida en curso —
// disparada por el botón, por otra pestaña, o por un cron HTTP externo —
// y que sobreviva a recargas de página mientras el proceso siga vivo.
export interface PipelineLiveState {
  running: boolean;
  runId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  steps: StepResult[];
  stopRequested: boolean;
}
let _liveState: PipelineLiveState = {
  running: false, runId: null, startedAt: null, finishedAt: null, steps: [], stopRequested: false,
};
export function getPipelineLiveState(): PipelineLiveState { return _liveState; }

const STEPS = [
  { n: 0, name: "download",     fn: step0 },
  { n: 1, name: "parse",        fn: step1 },
  { n: 2, name: "validate",     fn: step2 },
  { n: 3, name: "sap-catalog",  fn: step3 },
  { n: 4, name: "upload",       fn: step4 },
  { n: 5, name: "reconcile",    fn: step5 },
  { n: 6, name: "notify",       fn: step6 },
  { n: 7, name: "archive",      fn: step7 },
];

// ── Logging helpers ───────────────────────────────────────────────────────────

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function logStepResult(result: StepResult): void {
  const label  = `step:${result.step} ${result.name.padEnd(10)}`;
  const counts = `ok=${result.procesados}  err=${result.errores}  skip=${result.saltados}  (${fmtMs(result.duracionMs)})`;

  if (result.errores > 0) {
    log.error(`✗ ${label}  ${counts}`);
  } else {
    log.info(`✓ ${label}  ${counts}`);
  }

  for (const line of result.detalles) {
    const d = line.trim();
    if (!d) continue;
    if (d.includes("✗") || /^Error/i.test(d))     log.error(`  ${d}`);
    else if (d.includes("⚠") || d.startsWith("↩")) log.warn(`  ${d}`);
    else                                             log.info(`  ${d}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function runSteps(stepsToRun: typeof STEPS, onStep?: PipelineOptions["onStep"]): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const step of stepsToRun) {
    log.info(`▶ step:${step.n} ${step.name}`);
    const t0 = Date.now();
    let result: StepResult;
    try {
      const r = await step.fn();
      result = {
        step: step.n, name: step.name,
        procesados: r.procesados, errores: r.errores,
        saltados: r.saltados, detalles: r.detalles,
        duracionMs: Date.now() - t0,
      };
    } catch (e) {
      result = {
        step: step.n, name: step.name,
        procesados: 0, errores: 1, saltados: 0,
        detalles: [`Error inesperado en step ${step.n}: ${String(e)}`],
        duracionMs: Date.now() - t0,
      };
    }
    results.push(result);
    logStepResult(result);
    onStep?.(result);
  }
  return results;
}

// ── Alerta: cron perdido ──────────────────────────────────────────────────────
async function checkMissedCron(): Promise<void> {
  try {
    const db = getDb();
    // 'download' es el primera fase_nombre que se loguea en cada corrida de step0.
    // 'pipeline' nunca se loguea — la query anterior nunca retornaba resultado.
    const row = db
      .prepare(`SELECT MAX(ts) as last FROM pipeline_log WHERE fase_nombre = 'download'`)
      .get() as { last: string | null };
    if (!row?.last) return;
    const lastMs = new Date(row.last).getTime();
    const hoursAgo = (Date.now() - lastMs) / 3_600_000;
    if (hoursAgo > 25) {
      const h = hoursAgo.toFixed(1);
      const { tenantDisplayName } = getConfig();
      await sendAlertEmail(
        `[OrderLoader/${tenantDisplayName}] ⚠ Cron perdido — sin actividad hace ${h}h`,
        `<p>El pipeline no registra actividad desde hace <strong>${h} horas</strong>.</p>
         <p>Última ejecución: <code>${row.last}</code></p>
         <p>Verificar que el cron de GitHub Actions está corriendo.</p>`,
      ).catch(() => {});
    }
  } catch { /* no bloquear el pipeline por esto */ }
}

// ── Alerta: pedidos atascados en estados intermedios ──────────────────────────
async function checkStuckPipelineStates(): Promise<void> {
  try {
    const db = getDb();

    // NOTIFICANDO con notificacion_enviada=0 por más de 2h → fallo de SMTP/Graph
    const stuckNotificando = db.prepare(`
      SELECT pm.orden_compra, pm.cliente_nombre,
             MAX(pl.ts) AS ultimo_intento
      FROM pedidos_maestro pm
      LEFT JOIN pipeline_log pl
        ON pl.orden_compra = pm.orden_compra AND pl.fase = 6
      WHERE pm.estado = 'NOTIFICANDO' AND (pm.notificacion_enviada = 0 OR pm.notificacion_enviada IS NULL)
      GROUP BY pm.orden_compra
      HAVING ultimo_intento < datetime('now', '-2 hours') OR ultimo_intento IS NULL
    `).all() as Array<{ orden_compra: string; cliente_nombre: string | null; ultimo_intento: string | null }>;

    // CATALOG_OK por más de 3h → step4 no pudo subir a SAP (SAP caído o credenciales malas)
    const stuckCatalogOk = db.prepare(`
      SELECT pm.orden_compra, pm.cliente_nombre,
             MAX(pl.ts) AS ultimo_intento
      FROM pedidos_maestro pm
      LEFT JOIN pipeline_log pl
        ON pl.orden_compra = pm.orden_compra AND pl.fase = 3
      WHERE pm.estado = 'CATALOG_OK'
      GROUP BY pm.orden_compra
      HAVING ultimo_intento < datetime('now', '-3 hours') OR ultimo_intento IS NULL
    `).all() as Array<{ orden_compra: string; cliente_nombre: string | null; ultimo_intento: string | null }>;

    // PARSE_VALIDO por más de 3h → SAP caído desde step2/step3 (verificación de duplicados o catálogo diferida)
    const stuckParseValido = db.prepare(`
      SELECT pm.orden_compra, pm.cliente_nombre,
             MAX(pl.ts) AS ultimo_intento
      FROM pedidos_maestro pm
      LEFT JOIN pipeline_log pl
        ON pl.orden_compra = pm.orden_compra AND pl.fase = 2
      WHERE pm.estado = 'PARSE_VALIDO'
      GROUP BY pm.orden_compra
      HAVING ultimo_intento < datetime('now', '-3 hours') OR ultimo_intento IS NULL
    `).all() as Array<{ orden_compra: string; cliente_nombre: string | null; ultimo_intento: string | null }>;

    // SAP_NUEVO por más de 3h → estado de compatibilidad hacia atrás, step4 no pudo procesar
    const stuckSapNuevo = db.prepare(`
      SELECT pm.orden_compra, pm.cliente_nombre,
             MAX(pl.ts) AS ultimo_intento
      FROM pedidos_maestro pm
      LEFT JOIN pipeline_log pl
        ON pl.orden_compra = pm.orden_compra AND pl.fase = 4
      WHERE pm.estado = 'SAP_NUEVO'
      GROUP BY pm.orden_compra
      HAVING ultimo_intento < datetime('now', '-3 hours') OR ultimo_intento IS NULL
    `).all() as Array<{ orden_compra: string; cliente_nombre: string | null; ultimo_intento: string | null }>;

    const allStuck = [
      ...stuckNotificando, ...stuckCatalogOk, ...stuckParseValido, ...stuckSapNuevo,
    ];
    if (!allStuck.length) return;

    // Cooldown 6h: no re-alertar pedidos que ya fueron notificados recientemente
    const recentlyAlerted = new Set(
      (db.prepare(`
        SELECT DISTINCT orden_compra FROM pipeline_log
        WHERE fase_nombre = 'stuck_alert' AND ts > datetime('now', '-6 hours')
      `).all() as Array<{ orden_compra: string }>).map(r => r.orden_compra)
    );

    const newNotificando  = stuckNotificando.filter(r => !recentlyAlerted.has(r.orden_compra));
    const newCatalogOk    = stuckCatalogOk.filter(r => !recentlyAlerted.has(r.orden_compra));
    const newParseValido  = stuckParseValido.filter(r => !recentlyAlerted.has(r.orden_compra));
    const newSapNuevo     = stuckSapNuevo.filter(r => !recentlyAlerted.has(r.orden_compra));

    const newStuck = [...newNotificando, ...newCatalogOk, ...newParseValido, ...newSapNuevo];
    if (!newStuck.length) return;

    const { tenantDisplayName } = getConfig();
    let html = "";

    if (newNotificando.length) {
      const items = newNotificando
        .map(r => `<li><strong>OC ${r.orden_compra}</strong> — ${r.cliente_nombre || "—"} (último intento step6: ${r.ultimo_intento ?? "desconocido"})</li>`)
        .join("");
      html += `<h3 style="color:#b91c1c">🔴 ${newNotificando.length} pedido(s) atascados en NOTIFICANDO</h3>
               <p>No se pudo enviar el correo de notificación en las últimas 2h. Verificar credenciales SMTP/Graph.</p>
               <ul>${items}</ul>`;
    }

    if (newCatalogOk.length) {
      const items = newCatalogOk
        .map(r => `<li><strong>OC ${r.orden_compra}</strong> — ${r.cliente_nombre || "—"} (en catálogo desde: ${r.ultimo_intento ?? "desconocido"})</li>`)
        .join("");
      html += `<h3 style="color:#c2410c">🟡 ${newCatalogOk.length} pedido(s) atascados en CATALOG_OK</h3>
               <p>Artículos verificados en catálogo SAP pero no subidos en las últimas 3h. Causa probable: SAP no disponible.</p>
               <ul>${items}</ul>
               <p style="font-size:12px;color:#666">Se reintentarán automáticamente cuando SAP esté disponible.</p>`;
    }

    if (newParseValido.length) {
      const items = newParseValido
        .map(r => `<li><strong>OC ${r.orden_compra}</strong> — ${r.cliente_nombre || "—"} (validado desde: ${r.ultimo_intento ?? "desconocido"})</li>`)
        .join("");
      html += `<h3 style="color:#c2410c">🟡 ${newParseValido.length} pedido(s) atascados en PARSE_VALIDO</h3>
               <p>JSON validado pero SAP no disponible para verificar duplicados o catálogo en las últimas 3h.</p>
               <ul>${items}</ul>`;
    }

    if (newSapNuevo.length) {
      const items = newSapNuevo
        .map(r => `<li><strong>OC ${r.orden_compra}</strong> — ${r.cliente_nombre || "—"} (último intento: ${r.ultimo_intento ?? "desconocido"})</li>`)
        .join("");
      html += `<h3 style="color:#c2410c">🟡 ${newSapNuevo.length} pedido(s) atascados en SAP_NUEVO</h3>
               <p>Estado de compatibilidad — step4 no pudo procesar en las últimas 3h. Verificar SAP.</p>
               <ul>${items}</ul>`;
    }

    const subjects: string[] = [];
    if (newNotificando.length) subjects.push(`${newNotificando.length} en NOTIFICANDO`);
    if (newCatalogOk.length)   subjects.push(`${newCatalogOk.length} en CATALOG_OK`);
    if (newParseValido.length) subjects.push(`${newParseValido.length} en PARSE_VALIDO`);
    if (newSapNuevo.length)    subjects.push(`${newSapNuevo.length} en SAP_NUEVO`);

    await sendAlertEmail(
      `[OrderLoader/${tenantDisplayName}] ⚠ Pedidos atascados: ${subjects.join(", ")}`,
      html,
    ).catch(() => {});

    // Registrar cooldown: no re-alertar estos pedidos por 6h
    for (const r of newStuck) {
      logPipeline(db, r.orden_compra, 0, "stuck_alert", "WARN", "Alerta de pedido atascado enviada");
    }
  } catch { /* no bloquear el pipeline */ }
}

// ── Alerta: tasa de errores alta ─────────────────────────────────────────────
async function alertIfHighErrorRate(results: StepResult[]): Promise<void> {
  const totals = results.reduce(
    (acc, r) => ({ ok: acc.ok + r.procesados, err: acc.err + r.errores }),
    { ok: 0, err: 0 },
  );
  const total = totals.ok + totals.err;
  if (total === 0 || totals.err / total < 0.5) return;

  const lines = results
    .filter(r => r.errores > 0)
    .map(r => `<li>step:${r.step} ${r.name} — ${r.errores} error(s): ${r.detalles.filter(d => d.includes("✗") || /error/i.test(d)).slice(0, 3).join("; ")}</li>`)
    .join("");

  const { tenantDisplayName } = getConfig();
  await sendAlertEmail(
    `[OrderLoader/${tenantDisplayName}] ✗ Alta tasa de errores — ${totals.err}/${total} órdenes fallaron`,
    `<p>El pipeline terminó con <strong>${totals.err} de ${total}</strong> órdenes en error (>${Math.round(totals.err / total * 100)}%).</p>
     <ul>${lines}</ul>
     <p>Revisar logs para más detalle.</p>`,
  ).catch(() => {});
}

export async function runPipeline(opts: PipelineOptions = {}): Promise<StepResult[]> {
  const { fromStep = 0, toStep = 7, onlyStep, maxIterations = 50, onStep } = opts;

  // Evitar runs simultáneos
  if (_running) {
    const blocked: StepResult = {
      step: -1, name: "pipeline",
      procesados: 0, errores: 0, saltados: 0,
      detalles: ["Pipeline ya está en ejecución — intento ignorado"],
      duracionMs: 0,
    };
    onStep?.(blocked);
    return [blocked];
  }

  _running = true;
  _stopRequested = false;
  const runStart = Date.now();
  const runId = `run_${runStart}`;
  let _finalResults: StepResult[] = [];

  // Inicializar estado vivo para que la UI lo refleje en tiempo real.
  _liveState = {
    running: true, runId, startedAt: runStart, finishedAt: null, steps: [], stopRequested: false,
  };
  // Envuelve el onStep del caller para acumular cada paso en el estado vivo,
  // sin importar quién disparó la corrida (botón, cron, otra pestaña).
  const trackedOnStep = (result: StepResult) => {
    _liveState.steps.push(result);
    onStep?.(result);
  };

  setRunContext({ pipeline_run_id: runId });
  log.info("─────────────────────────────────── pipeline start ───────────────────────────────────");

  // Alertar si el cron no corrió en las últimas 25h
  await checkMissedCron();

  // Alertar si hay pedidos atascados en NOTIFICANDO (fallo email) o CATALOG_OK (SAP caído)
  await checkStuckPipelineStates();

  // Ensure DB schema exists (handles empty/new DB)
  try { migrate(); } catch (e) { log.error({ err: e }, "migrate falló"); }

  // Backup DB before running
  try { backupDb(); } catch (e) { log.error({ err: e }, "backup falló"); }

  // Recuperar movimientos IMAP que quedaron pendientes de un run anterior interrumpido
  try {
    const recoveryLogs = await recoverPendingMoves();
    if (recoveryLogs.length > 0) {
      log.info(`recovery: ${recoveryLogs.length} movimiento(s) IMAP pendiente(s)`);
      for (const l of recoveryLogs) log.info(`  ${l}`);
    }
  } catch (e) { log.error({ err: e }, "recoverPendingMoves falló"); }

  try {
    await logoutSapClient();

    // Modo onlyStep o fromStep > 0: ejecución directa sin loop
    if (onlyStep != null || fromStep > 0) {
      const stepsToRun = onlyStep != null
        ? STEPS.filter(s => s.n === onlyStep)
        : STEPS.filter(s => s.n >= fromStep && s.n <= toStep);
      _finalResults = await runSteps(stepsToRun, trackedOnStep);
      return _finalResults;
    }

  // Flujo completo (fromStep=0): loop unitario — 1 correo a la vez, ciclo completo 0→7
  const allResults: StepResult[] = [];
  const uploadSteps = STEPS.filter(s => s.n >= 1 && s.n <= Math.min(toStep, 5));
  const finalSteps  = STEPS.filter(s => s.n >= 6 && s.n <= toStep);
  let iteration = 0;

    while (true) {
      iteration++;
      await logoutSapClient();
      log.info(`─── correo ${iteration} ${"─".repeat(Math.max(0, 70 - String(iteration).length))}`);

      // Step 0: descargar 1 correo
      log.info(`▶ step:0 download`);
      const t0 = Date.now();
      let downloadResult: StepResult;
      try {
        const r = await step0();
        downloadResult = {
          step: 0, name: "download",
          procesados: r.procesados, errores: r.errores,
          saltados: r.saltados, detalles: r.detalles,
          duracionMs: Date.now() - t0,
        };
      } catch (e) {
        downloadResult = {
          step: 0, name: "download",
          procesados: 0, errores: 1, saltados: 0,
          detalles: [`Error en download: ${String(e)}`],
          duracionMs: Date.now() - t0,
        };
      }

      allResults.push(downloadResult);
      logStepResult(downloadResult);
      trackedOnStep(downloadResult);

      // Steps 1-5: procesar el correo recién descargado (idempotentes: saltan los ya procesados)
      const stepResults = await runSteps(uploadSteps, trackedOnStep);
      allResults.push(...stepResults);

      // Steps 6-7: notificar y archivar el correo actual antes de pasar al siguiente
      if (finalSteps.length > 0) {
        await logoutSapClient();
        const finalResults = await runSteps(finalSteps, trackedOnStep);
        allResults.push(...finalResults);
      }

      // Terminar loop si no hubo correos nuevos (bandeja vacía o error IMAP)
      if (downloadResult.procesados === 0) break;

      // Pausa solicitada por el usuario
      if (_stopRequested) {
        allResults.push({
          step: 0, name: "download",
          procesados: 0, errores: 0, saltados: 0,
          detalles: ["⏹ Pipeline detenido por el usuario"],
          duracionMs: 0,
        });
        break;
      }

      // Límite de seguridad: máximo N correos por run
      if (iteration >= maxIterations) {
        allResults.push({
          step: 0, name: "download",
          procesados: 0, errores: 0, saltados: 0,
          detalles: [`⚠ Límite de ${maxIterations} correos por run alcanzado — deteniendo`],
          duracionMs: 0,
        });
        break;
      }
    }

    _finalResults = allResults;
    return allResults;

  } finally {
    _running = false;
    _stopRequested = false;
    _liveState.running = false;
    _liveState.finishedAt = Date.now();
    await logoutSapClient();
    log.info(`──────────────────────────── pipeline done (${fmtMs(Date.now() - runStart)}) ────────────────────────────`);
    await alertIfHighErrorRate(_finalResults);
    clearRunContext();
  }
}
