import { backupDb, migrate, getDb } from "./db";
import { getLogger, setRunContext, clearRunContext } from "./logger";
import { sendAlertEmail } from "./mailer";

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
export function requestPipelineStop(): void  { _stopRequested = true; }

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
    const row = db
      .prepare(`SELECT MAX(ts) as last FROM pipeline_log WHERE fase_nombre = 'pipeline'`)
      .get() as { last: string | null };
    if (!row?.last) return;
    const lastMs = new Date(row.last).getTime();
    const hoursAgo = (Date.now() - lastMs) / 3_600_000;
    if (hoursAgo > 25) {
      const h = hoursAgo.toFixed(1);
      await sendAlertEmail(
        `[OrderLoader] ⚠ Cron perdido — sin actividad hace ${h}h`,
        `<p>El pipeline no registra actividad desde hace <strong>${h} horas</strong>.</p>
         <p>Última ejecución: <code>${row.last}</code></p>
         <p>Verificar que el cron de GitHub Actions está corriendo.</p>`,
      ).catch(() => {});
    }
  } catch { /* no bloquear el pipeline por esto */ }
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

  await sendAlertEmail(
    `[OrderLoader] ✗ Alta tasa de errores — ${totals.err}/${total} órdenes fallaron`,
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
  setRunContext({ pipeline_run_id: runId });
  log.info("─────────────────────────────────── pipeline start ───────────────────────────────────");

  // Alertar si el cron no corrió en las últimas 25h
  await checkMissedCron();

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
      _finalResults = await runSteps(stepsToRun, onStep);
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
      onStep?.(downloadResult);

      // Steps 1-5: procesar el correo recién descargado (idempotentes: saltan los ya procesados)
      const stepResults = await runSteps(uploadSteps, onStep);
      allResults.push(...stepResults);

      // Steps 6-7: notificar y archivar el correo actual antes de pasar al siguiente
      if (finalSteps.length > 0) {
        await logoutSapClient();
        const finalResults = await runSteps(finalSteps, onStep);
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
    await logoutSapClient();
    log.info(`──────────────────────────── pipeline done (${fmtMs(Date.now() - runStart)}) ────────────────────────────`);
    await alertIfHighErrorRate(_finalResults);
    clearRunContext();
  }
}
