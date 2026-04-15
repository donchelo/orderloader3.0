"use client";

import { useState } from "react";

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
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [results, setResults] = useState<StepResult[]>([]);
  const [currentStep, setCurrentStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
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

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

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
            // Hint at next step
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
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          onClick={handleRun}
          disabled={running}
          style={{
            background: running ? "#e9ecef" : "#f8f9fa",
            color: "#000",
            border: "1px solid #000",
            borderRadius: "6px",
            padding: "10px 24px",
            fontSize: "14px",
            fontWeight: 600,
            cursor: running ? "not-allowed" : "pointer",
          }}
        >
          {running ? "⏳ Ejecutando…" : "▶ Correr Pipeline"}
        </button>

        {running && (
          <button
            onClick={handleStop}
            disabled={stopping}
            style={{
              background: stopping ? "#e9ecef" : "#fff3cd",
              color: "#000",
              border: "1px solid #856404",
              borderRadius: "6px",
              padding: "10px 20px",
              fontSize: "14px",
              fontWeight: 600,
              cursor: stopping ? "not-allowed" : "pointer",
            }}
          >
            {stopping ? "Deteniendo…" : "⏹ Pausar"}
          </button>
        )}
      </div>

      {error && (
        <div style={{ marginTop: 12, background: "#f8d7da", color: "#000", padding: "10px 14px", borderRadius: 6 }}>
          Error: {error}
        </div>
      )}

      {(results.length > 0 || running) && (
        <div style={{ marginTop: 16, border: "1px solid #dee2e6", borderRadius: 8, overflow: "hidden" }}>
          <div style={{ background: "#f8fafc", padding: "10px 16px", borderBottom: "1px solid #dee2e6", fontSize: 13, fontWeight: 600 }}>
            {done ? "✅ Pipeline completado" : stopping ? "⏹ Deteniendo tras correo actual…" : "⏳ Ejecutando pipeline…"}
          </div>

          {/* Steps completados */}
          {results.map((r) => (
            <div key={`${r.step}-${r.name}`} style={{ borderBottom: "1px solid #f1f5f9" }}>
              <div
                style={{
                  display: "flex", alignItems: "center", gap: 12,
                  padding: "8px 16px", fontSize: 13,
                  background: r.errores > 0 ? "#fff1f2" : "#f0fdf4",
                  cursor: r.detalles.length > 0 ? "pointer" : "default",
                }}
                onClick={() => r.detalles.length > 0 && toggleExpand(r.step)}
              >
                <span style={{ fontWeight: 600, minWidth: 20, color: "#64748b" }}>{r.step}</span>
                <span style={{ flex: 1 }}>{STEP_LABELS[r.name] ?? r.name}</span>
                <span style={{ color: "#16a34a", fontSize: 12 }}>✓ {r.procesados}</span>
                {r.errores > 0 && <span style={{ color: "#dc2626", fontSize: 12 }}>✗ {r.errores}</span>}
                {r.saltados > 0 && <span style={{ color: "#94a3b8", fontSize: 12 }}>— {r.saltados}</span>}
                <span style={{ color: "#94a3b8", fontSize: 11 }}>{r.duracionMs}ms</span>
                {r.detalles.length > 0 && (
                  <span style={{ color: "#94a3b8", fontSize: 11 }}>{expandedSteps.has(r.step) ? "▲" : "▼"}</span>
                )}
              </div>
              {expandedSteps.has(r.step) && (
                <pre style={{ margin: 0, padding: "8px 16px 8px 48px", fontSize: 11, background: "#f8fafc", color: "#374151", overflowX: "auto" }}>
                  {r.detalles.join("\n")}
                </pre>
              )}
            </div>
          ))}

          {/* Step en curso */}
          {running && currentStep && (
            <div style={{ padding: "8px 16px", fontSize: 13, color: "#64748b", display: "flex", gap: 12, alignItems: "center" }}>
              <span style={{ minWidth: 20 }}>⏳</span>
              <span>{STEP_LABELS[currentStep] ?? currentStep}…</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
