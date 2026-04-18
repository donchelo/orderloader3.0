import { backupDb, migrate } from "./db";
import { run as step0 } from "./steps/step0-download";
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
  { n: 0, name: "download",       fn: step0 },
  { n: 1, name: "parse",          fn: step1 },
  { n: 2, name: "validate-parse", fn: step2 },
  { n: 3, name: "sap-query",      fn: step3 },
  { n: 4, name: "upload",          fn: step4 },
  { n: 5, name: "reconcile",      fn: step5 },
  { n: 6, name: "notify",         fn: step6 },
  { n: 7, name: "archive",        fn: step7 },
];

async function runSteps(stepsToRun: typeof STEPS, onStep?: PipelineOptions["onStep"]): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const step of stepsToRun) {
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
    onStep?.(result);
  }
  return results;
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

  // Ensure DB schema exists (handles empty/new DB)
  try { migrate(); } catch { /* ignore */ }

  // Backup DB before running
  try { backupDb(); } catch { /* ignore */ }

  try {
    await logoutSapClient();

    // Modo onlyStep o fromStep > 0: ejecución directa sin loop
    if (onlyStep != null || fromStep > 0) {
      const stepsToRun = onlyStep != null
        ? STEPS.filter(s => s.n === onlyStep)
        : STEPS.filter(s => s.n >= fromStep && s.n <= toStep);
      return await runSteps(stepsToRun, onStep);
    }

  // Flujo completo (fromStep=0): loop unitario — 1 correo a la vez hasta vaciar bandeja
  // Steps 1-5 corren por cada correo; steps 6-7 (notify+archive) corren UNA VEZ al final
  const allResults: StepResult[] = [];
  const uploadSteps = STEPS.filter(s => s.n >= 1 && s.n <= Math.min(toStep, 5));
  const finalSteps  = STEPS.filter(s => s.n >= 6 && s.n <= toStep);
  let iteration = 0;

    while (true) {
      iteration++;
      await logoutSapClient();

      // Step 0: descargar 1 correo
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
      onStep?.(downloadResult);

      // Siempre correr steps 1-5: procesan tanto el correo recién descargado
      // como cualquier correo en disco pendiente de iteraciones anteriores.
      const stepResults = await runSteps(uploadSteps, onStep);
      allResults.push(...stepResults);

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

    // Pasos 6-7: notificar y archivar UNA SOLA VEZ al final (1 email por lote)
    if (finalSteps.length > 0) {
      await logoutSapClient();
      const finalResults = await runSteps(finalSteps, onStep);
      allResults.push(...finalResults);
    }

    return allResults;

  } finally {
    _running = false;
    _stopRequested = false;
    await logoutSapClient();
  }
}
