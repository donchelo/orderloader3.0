"use client";

import { useEffect, useState } from "react";
import PipelineStatus from "./PipelineStatus";
import { Button, cn } from "@/design-system";
import type { Pedido } from "./PedidoTable";

interface Item {
  id: number;
  codigo_producto: string;
  descripcion: string;
  cantidad: number;
  precio_unitario: number;
  subtotal_item: number;
  fecha_entrega: string | null;
}

interface LogEntry {
  id: number;
  fase: number;
  fase_nombre: string;
  estado_resultado: string;
  mensaje: string;
  ts: string;
}

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
  "download": "Descargar", "parse": "Extraer", "validate-parse": "Validar",
  "sap-query": "Consultar SAP", "upload": "Subir a SAP",
  "reconcile": "Reconciliar", "notify": "Notificar", "archive": "Archivar",
};

function formatCOP(v: number) {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(v);
}

interface Props {
  pedido: Pedido | null;
  onClose: () => void;
  onRetryDone: () => void;
}

export default function PedidoDetail({ pedido, onClose, onRetryDone }: Props) {
  const [items, setItems]           = useState<Item[]>([]);
  const [logs, setLogs]             = useState<LogEntry[]>([]);
  const [loading, setLoading]       = useState(false);
  const [retrying, setRetrying]     = useState(false);
  const [retrySteps, setRetrySteps] = useState<StepResult[]>([]);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retryDone, setRetryDone]   = useState(false);

  useEffect(() => {
    if (!pedido) return;
    setItems([]);
    setLogs([]);
    setRetrying(false);
    setRetrySteps([]);
    setRetryError(null);
    setRetryDone(false);
    setLoading(true);

    fetch(`/api/pedidos/${pedido.id}`)
      .then(r => r.json())
      .then(data => { if (data.ok) { setItems(data.items); setLogs(data.logs); } })
      .finally(() => setLoading(false));
  }, [pedido]);

  async function handleRetry() {
    if (!pedido) return;
    setRetrying(true);
    setRetrySteps([]);
    setRetryError(null);
    setRetryDone(false);

    try {
      const res = await fetch(`/api/pedidos/${pedido.id}/retry`, { method: "POST" });
      if (!res.body) throw new Error("Sin stream");

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer    = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const json = JSON.parse(line.slice(6));
          if (json.type === "step")  setRetrySteps(prev => [...prev, json.result]);
          else if (json.type === "done")  { setRetryDone(true); onRetryDone(); }
          else if (json.type === "error") setRetryError(json.error);
        }
      }
    } catch (e) {
      setRetryError(String(e));
    } finally {
      setRetrying(false);
    }
  }

  const isError = pedido?.estado.startsWith("ERROR");

  if (!pedido) return null;

  return (
    <>
      {/* Overlay */}
      <div
        onClick={onClose}
        className="fixed inset-0 bg-erie-black/30 z-40 backdrop-blur-[2px]"
      />

      {/* Drawer */}
      <div className="fixed top-0 right-0 bottom-0 w-[560px] bg-white z-50 flex flex-col shadow-[-4px_0_24px_rgba(0,0,0,0.12)]">

        {/* Header */}
        <div className="px-5 py-4 border-b border-erie-black/10 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-base font-bold tracking-[0.04em]">OC {pedido.orden_compra}</div>
            <div className="text-xs text-cadet-gray mt-0.5 truncate">{pedido.cliente_nombre}</div>
          </div>
          <PipelineStatus estado={pedido.estado} />
          <button
            onClick={onClose}
            className="text-cadet-gray hover:text-erie-black transition-colors text-lg leading-none px-1 cursor-pointer bg-transparent border-none"
          >
            ✕
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">
          {loading ? (
            <div className="py-8 text-center text-cadet-gray text-sm">Cargando…</div>
          ) : (
            <>
              {/* Error msg */}
              {pedido.error_msg && (
                <div className="rounded-[0.75rem] border border-hot-orange/30 bg-hot-orange/5 px-4 py-3 text-sm">
                  <div className="font-semibold mb-1 text-hot-orange text-xs uppercase tracking-[0.06em]">Error</div>
                  <div className="whitespace-pre-wrap break-words text-erie-black/80">{pedido.error_msg}</div>
                </div>
              )}

              {/* Retry */}
              {isError && !retryDone && (
                <Button
                  onClick={handleRetry}
                  disabled={retrying}
                  variant="primary"
                  size="md"
                  className="w-full"
                >
                  {retrying ? "Reintentando…" : "↺ Reintentar pedido"}
                </Button>
              )}

              {/* Retry progress */}
              {(retrySteps.length > 0 || retrying) && (
                <div className="border border-erie-black/10 rounded-[0.75rem] overflow-hidden">
                  {retrySteps.map(r => (
                    <div
                      key={`${r.step}-${r.name}`}
                      className={cn(
                        "flex gap-3 px-4 py-2 text-xs border-b border-erie-black/5 last:border-0",
                        r.errores > 0 ? "bg-hot-orange/5" : "bg-moderate-blue/4"
                      )}
                    >
                      <span className="font-mono text-cadet-gray min-w-[1rem]">{r.step}</span>
                      <span className="flex-1">{STEP_LABELS[r.name] ?? r.name}</span>
                      <span className="text-moderate-blue">✓{r.procesados}</span>
                      {r.errores > 0 && <span className="text-hot-orange">✗{r.errores}</span>}
                      <span className="font-mono text-cadet-gray">{r.duracionMs}ms</span>
                    </div>
                  ))}
                  {retrying && (
                    <div className="px-4 py-2 text-xs text-cadet-gray">Procesando…</div>
                  )}
                  {retryDone && (
                    <div className="px-4 py-2 text-xs font-semibold text-moderate-blue">Completado</div>
                  )}
                </div>
              )}

              {retryError && (
                <div className="rounded-[0.75rem] border border-hot-orange/30 bg-hot-orange/5 px-4 py-3 text-xs text-erie-black/80">
                  {retryError}
                </div>
              )}

              {/* Items */}
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.06em] text-cadet-gray mb-2">
                  Ítems ({items.length})
                </div>
                {items.length === 0 ? (
                  <div className="text-xs text-cadet-gray">Sin ítems registrados</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs border-collapse">
                      <thead>
                        <tr className="border-b border-erie-black/10 bg-erie-black/3">
                          {["Código", "Descripción", "Cant.", "Precio", "Subtotal"].map(h => (
                            <th key={h} className={cn(
                              "px-2 py-2 font-semibold text-cadet-gray",
                              ["Cant.", "Precio", "Subtotal"].includes(h) ? "text-right" : "text-left"
                            )}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {items.map(item => (
                          <tr key={item.id} className="border-b border-erie-black/5 last:border-0">
                            <td className="px-2 py-1.5 font-mono">{item.codigo_producto}</td>
                            <td className="px-2 py-1.5 text-erie-black/70">{item.descripcion || "—"}</td>
                            <td className="px-2 py-1.5 text-right font-mono">{item.cantidad}</td>
                            <td className="px-2 py-1.5 text-right font-mono">{formatCOP(item.precio_unitario)}</td>
                            <td className="px-2 py-1.5 text-right font-mono font-semibold">{formatCOP(item.subtotal_item)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Log */}
              {logs.length > 0 && (
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.06em] text-cadet-gray mb-2">Historial</div>
                  <div className="flex flex-col gap-1">
                    {logs.map(l => (
                      <div key={l.id} className={cn(
                        "flex gap-2 text-xs",
                        l.estado_resultado === "ERROR" ? "text-hot-orange" : "text-erie-black/70"
                      )}>
                        <span className="font-mono text-cadet-gray whitespace-nowrap">{l.ts.slice(5, 16)}</span>
                        <span className="font-mono text-cadet-gray">f{l.fase}</span>
                        <span className="flex-1">{l.mensaje}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
