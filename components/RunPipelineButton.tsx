"use client";

import { useState, useEffect, useRef, useCallback } from "react";
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

// Las claves DEBEN coincidir con `name` en lib/pipeline.ts STEPS.
const STEP_LABELS: Record<string, string> = {
  "download":     "Descargar correos",
  "parse":        "Extraer pedidos",
  "validate":     "Validar extracción",
  "sap-catalog":  "Consultar catálogo SAP",
  "upload":       "Subir a SAP",
  "reconcile":    "Reconciliar",
  "notify":       "Notificar clientes",
  "archive":      "Archivar",
};

const STEP_ORDER = [
  "download", "parse", "validate", "sap-catalog", "upload", "reconcile", "notify", "archive",
] as const;

function labelFor(name: string): string {
  return STEP_LABELS[name] ?? name;
}

/** Estima el siguiente paso a partir del último completado (el pipeline cicla 0→7 por correo). */
function nextStepName(results: StepResult[]): string {
  if (!results.length) return "download";
  const last = results[results.length - 1].name;
  const idx = STEP_ORDER.indexOf(last as (typeof STEP_ORDER)[number]);
  if (idx < 0) return "download";
  return STEP_ORDER[(idx + 1) % STEP_ORDER.length];
}

interface Props {
  onComplete?: () => void;
}

export default function RunPipelineButton({ onComplete }: Props) {
  const [running, setRunning]             = useState(false);
  const [stopping, setStopping]           = useState(false);
  const [attached, setAttached]           = useState(false); // viendo una corrida que no iniciamos por SSE
  const [results, setResults]             = useState<StepResult[]>([]);
  const [error, setError]                 = useState<string | null>(null);
  const [done, setDone]                   = useState(false);
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set());

  const streamingRef = useRef(false);
  const pollRef      = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  // Engancharse a una corrida ya en curso: sondea el estado vivo del servidor
  // y renderiza el progreso hasta que termine. Cubre cron, otra pestaña o recarga.
  const attachToRun = useCallback(() => {
    if (pollRef.current) return; // ya estamos sondeando
    setAttached(true);
    setRunning(true);
    setError(null);
    setDone(false);

    const poll = async () => {
      try {
        const res  = await fetch("/api/pipeline/run");
        const data = await res.json();
        if (Array.isArray(data.live?.steps)) setResults(data.live.steps);
        if (!data.running) {
          stopPolling();
          setRunning(false);
          setAttached(false);
          setDone(true);
          onComplete?.();
        }
      } catch { /* reintentar en el próximo tick */ }
    };

    poll();
    pollRef.current = setInterval(poll, 1500);
  }, [onComplete, stopPolling]);

  // Al montar: si ya hay una corrida en curso, mostrar su progreso.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res  = await fetch("/api/pipeline/run");
        const data = await res.json();
        if (!cancelled && data.running && !streamingRef.current) attachToRun();
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; stopPolling(); };
  }, [attachToRun, stopPolling]);

  async function handleRun() {
    streamingRef.current = true;
    setRunning(true);
    setResults([]);
    setError(null);
    setDone(false);
    setExpandedSteps(new Set());
    setAttached(false);

    try {
      const res = await fetch("/api/pipeline/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      if (res.status === 409) {
        // Ya hay una corrida en ejecución → engancharse para mostrar su progreso
        // en vez de dejar al usuario con un error sin contexto.
        streamingRef.current = false;
        attachToRun();
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
            setResults(prev => [...prev, json.result as StepResult]);
          } else if (json.type === "done") {
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
      streamingRef.current = false;
      // Si nos enganchamos (409), el polling controla `running`; no lo apaguemos aquí.
      if (!pollRef.current) setRunning(false);
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

  const showPanel = results.length > 0 || running;

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
          {running ? (attached ? "Pipeline en ejecución…" : "Ejecutando…") : "▶ Correr Pipeline"}
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
      {showPanel && (
        <div className="border border-erie-black/10 rounded-[1rem] overflow-hidden">
          <div className="px-4 py-2.5 bg-erie-black/4 border-b border-erie-black/10 text-sm font-semibold flex items-center gap-2">
            {!running && !done && results.length > 0 ? (
              "Resultado de la última corrida"
            ) : done ? (
              "Pipeline completado"
            ) : stopping ? (
              "Deteniendo tras correo actual…"
            ) : (
              <>
                <span className="inline-block w-2 h-2 rounded-full bg-moderate-blue animate-pulse" />
                {attached ? "Pipeline en ejecución (en curso)…" : "Ejecutando pipeline…"}
              </>
            )}
          </div>

          {results.map((r, i) => (
            <div key={`${r.step}-${r.name}-${i}`} className="border-b border-erie-black/5 last:border-0">
              <div
                className={cn(
                  "flex items-center gap-3 px-4 py-2 text-sm",
                  r.errores > 0 ? "bg-hot-orange/5" : "bg-moderate-blue/4",
                  r.detalles.length > 0 && "cursor-pointer"
                )}
                onClick={() => r.detalles.length > 0 && toggleExpand(r.step)}
              >
                <span className="font-mono text-xs text-cadet-gray min-w-[1.25rem]">{r.step}</span>
                <span className="flex-1">{labelFor(r.name)}</span>
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

          {running && !done && (
            <div className="flex gap-3 items-center px-4 py-2 text-sm text-cadet-gray">
              <span className="font-mono text-xs min-w-[1.25rem]">…</span>
              <span>{labelFor(nextStepName(results))}…</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
