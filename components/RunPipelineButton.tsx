"use client";

import { useState } from "react";
import { Button, cn } from "@/design-system";

interface StepResult {
  step: number;
  name: string;
  procesados: number;
  errores: number;
  saltados: number;
  detalles: string[];
  duracionMs: number;
}

const STEP_LABELS: Record<string, string> = {
  "download":       "Descargar correos",
  "parse":          "Extraer pedidos",
  "validate-parse": "Validar extracción",
  "sap-query":      "Consultar SAP",
  "upload":         "Subir a SAP",
  "reconcile":      "Reconciliar",
  "notify":         "Notificar clientes",
  "archive":        "Archivar",
};

interface Props {
  onComplete?: () => void;
}

export default function RunPipelineButton({ onComplete }: Props) {
  const [running, setRunning]             = useState(false);
  const [stopping, setStopping]           = useState(false);
  const [results, setResults]             = useState<StepResult[]>([]);
  const [currentStep, setCurrentStep]     = useState<string | null>(null);
  const [error, setError]                 = useState<string | null>(null);
  const [done, setDone]                   = useState(false);
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set());

  async function handleRun() {
    setRunning(true);
    setResults([]);
    setCurrentStep("download");
    setError(null);
    setDone(false);
    setExpandedSteps(new Set());

    try {
      const res = await fetch("/api/pipeline/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      if (res.status === 409) {
        setError("El pipeline ya está en ejecución. Espera a que termine.");
        setRunning(false);
        setCurrentStep(null);
        return;
      }

      if (!res.body) throw new Error("Sin stream");

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer    = "";

      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const json = JSON.parse(line.slice(6));

          if (json.type === "step") {
            const r: StepResult = json.result;
            setResults(prev => [...prev, r]);
            setCurrentStep(r.step < 7 ? Object.keys(STEP_LABELS)[r.step + 1] : null);
          } else if (json.type === "done") {
            setCurrentStep(null);
            setDone(true);
            onComplete?.();
          } else if (json.type === "error") {
            setError(json.error);
          }
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
      setCurrentStep(null);
    }
  }

  async function handleStop() {
    setStopping(true);
    try {
      await fetch("/api/pipeline/stop", { method: "POST" });
    } finally {
      setStopping(false);
    }
  }

  function toggleExpand(step: number) {
    setExpandedSteps(prev => {
      const next = new Set(prev);
      next.has(step) ? next.delete(step) : next.add(step);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Buttons */}
      <div className="flex gap-3 items-center">
        <Button
          onClick={handleRun}
          disabled={running}
          variant="primary"
          size="md"
        >
          {running ? "Ejecutando…" : "▶ Correr Pipeline"}
        </Button>

        {running && (
          <Button
            onClick={handleStop}
            disabled={stopping}
            variant="secondary"
            size="md"
          >
            {stopping ? "Deteniendo…" : "⏹ Pausar"}
          </Button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="text-sm px-4 py-3 rounded-[0.5rem] border border-hot-orange/40 bg-hot-orange/8 text-erie-black">
          {error}
        </div>
      )}

      {/* Progress panel */}
      {(results.length > 0 || running) && (
        <div className="border border-erie-black/10 rounded-[1rem] overflow-hidden">
          <div className="px-4 py-2.5 bg-erie-black/4 border-b border-erie-black/10 text-sm font-semibold">
            {done
              ? "Pipeline completado"
              : stopping
              ? "Deteniendo tras correo actual…"
              : "Ejecutando pipeline…"}
          </div>

          {results.map((r) => (
            <div key={`${r.step}-${r.name}`} className="border-b border-erie-black/5 last:border-0">
              <div
                className={cn(
                  "flex items-center gap-3 px-4 py-2 text-sm",
                  r.errores > 0 ? "bg-hot-orange/5" : "bg-moderate-blue/4",
                  r.detalles.length > 0 && "cursor-pointer"
                )}
                onClick={() => r.detalles.length > 0 && toggleExpand(r.step)}
              >
                <span className="font-mono text-xs text-cadet-gray min-w-[1.25rem]">{r.step}</span>
                <span className="flex-1">{STEP_LABELS[r.name] ?? r.name}</span>
                <span className="text-moderate-blue text-xs">✓ {r.procesados}</span>
                {r.errores > 0 && <span className="text-hot-orange text-xs">✗ {r.errores}</span>}
                {r.saltados > 0 && <span className="text-cadet-gray text-xs">— {r.saltados}</span>}
                <span className="font-mono text-xs text-cadet-gray">{r.duracionMs}ms</span>
                {r.detalles.length > 0 && (
                  <span className="text-cadet-gray text-xs">{expandedSteps.has(r.step) ? "▲" : "▼"}</span>
                )}
              </div>
              {expandedSteps.has(r.step) && (
                <pre className="m-0 pl-10 pr-4 py-2 text-xs bg-mint-cream/60 text-erie-black/70 overflow-x-auto">
                  {r.detalles.join("\n")}
                </pre>
              )}
            </div>
          ))}

          {running && currentStep && (
            <div className="flex gap-3 items-center px-4 py-2 text-sm text-cadet-gray">
              <span className="font-mono text-xs min-w-[1.25rem]">…</span>
              <span>{STEP_LABELS[currentStep] ?? currentStep}…</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
