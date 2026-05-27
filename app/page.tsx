"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import PedidoTable, { Pedido } from "@/components/PedidoTable";
import RunPipelineButton from "@/components/RunPipelineButton";
import PedidoDetail from "@/components/PedidoDetail";
import { Logo, Text, Button, Card } from "@/design-system";

const STAT_CARDS = [
  { key: "total",    label: "Total",      color: "text-erie-black"    },
  { key: "proceso",  label: "En proceso", color: "text-moderate-blue" },
  { key: "cerrados", label: "Cerrados",   color: "text-moderate-blue" },
  { key: "errores",  label: "Con errores",color: "text-hot-orange"    },
] as const;

export default function Home() {
  const [pedidos, setPedidos]             = useState<Pedido[]>([]);
  const [filtroEstado, setFiltroEstado]   = useState("todos");
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState<string | null>(null);
  const [lastRefresh, setLastRefresh]     = useState<Date | null>(null);
  const [selectedPedido, setSelectedPedido] = useState<Pedido | null>(null);

  const fetchPedidos = useCallback(async () => {
    try {
      const res  = await fetch("/api/pedidos");
      const data = await res.json();
      if (data.ok) {
        setPedidos(data.pedidos);
        setLastRefresh(new Date());
        setError(null);
      } else {
        setError(data.error);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchPedidos(); }, [fetchPedidos]);

  const handleDelete = useCallback(async (ordenes: string[]) => {
    const res  = await fetch("/api/pedidos", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ordenes_compra: ordenes }),
    });
    const data = await res.json();
    if (data.ok) fetchPedidos();
    else alert(`Error al eliminar: ${data.error}`);
  }, [fetchPedidos]);

  useEffect(() => {
    const hasPending = pedidos.some(p =>
      !["CERRADO", "ERROR_DUPLICADO", "ERROR_ITEMS", "ERROR_SAP", "ERROR_PARSE", "ERROR_VALIDACION"].includes(p.estado)
    );
    if (!hasPending) return;
    const id = setInterval(fetchPedidos, 15_000);
    return () => clearInterval(id);
  }, [pedidos, fetchPedidos]);

  const total    = pedidos.length;
  const cerrados = pedidos.filter(p => p.estado === "CERRADO").length;
  const errores  = pedidos.filter(p => p.estado.startsWith("ERROR")).length;
  const enProceso = total - cerrados - errores;

  const statValues: Record<typeof STAT_CARDS[number]["key"], number> = {
    total, proceso: enProceso, cerrados, errores,
  };

  return (
    <div className="min-h-screen bg-mint-cream text-erie-black">

      {/* Header */}
      <header className="border-b border-erie-black/10 bg-mint-cream/80 backdrop-blur-sm sticky top-0 z-30">
        <div className="max-w-[1400px] mx-auto px-6 py-4 flex items-center gap-4">
          <Logo version="v1" color="negro" height={28} />
          <div className="w-px h-6 bg-erie-black/15" />
          <div>
            <Text variant="bodyBold" as="span" className="text-sm leading-none">
              SAP B1 Order Pipeline
            </Text>
            <Text variant="xs" as="div" className="mt-0.5">
              Automatización Email → SAP B1
            </Text>
          </div>
          <div className="ml-auto flex items-center gap-4">
            <Link href="/clientes" className="text-xs text-cadet-gray hover:text-erie-black transition-colors font-mono">
              Clientes →
            </Link>
            <Link href="/changelog" className="text-xs text-cadet-gray hover:text-erie-black transition-colors font-mono">
              Changelog →
            </Link>
            {lastRefresh && (
              <time className="text-xs text-cadet-gray font-mono" dateTime={lastRefresh.toISOString()}>
                {lastRefresh.toLocaleTimeString("es-CO")}
              </time>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-6 py-8 flex flex-col gap-6">

        {/* Stats row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {STAT_CARDS.map(({ key, label, color }) => (
            <Card key={key} variant="elevated" padding="md">
              <div className={`text-3xl font-black font-mono leading-none mb-1 ${color}`}>
                {statValues[key]}
              </div>
              <Text variant="xs">{label}</Text>
            </Card>
          ))}
        </div>

        {/* Actions */}
        <Card variant="light" padding="lg">
          <div className="flex gap-4 items-start flex-wrap">
            <RunPipelineButton onComplete={fetchPedidos} />
            <Button variant="secondary" size="md" onClick={fetchPedidos}>
              Actualizar
            </Button>
          </div>
        </Card>

        {/* Table */}
        <Card variant="elevated" padding="lg">
          <Text variant="h3" as="h2" className="mb-5">Pedidos</Text>

          {loading ? (
            <div className="py-10 text-center text-cadet-gray text-sm">Cargando…</div>
          ) : error ? (
            <div className="rounded-[0.75rem] border border-hot-orange/30 bg-hot-orange/5 px-4 py-3 text-sm">
              <span className="font-semibold">Error:</span> {error}
              <br />
              <span className="text-xs text-cadet-gray">¿La base de datos fue inicializada? Ejecuta migrate primero.</span>
            </div>
          ) : (
            <PedidoTable
              pedidos={pedidos}
              filtroEstado={filtroEstado}
              onFiltroChange={setFiltroEstado}
              onSelect={setSelectedPedido}
              onDelete={handleDelete}
            />
          )}
        </Card>
      </main>

      <PedidoDetail
        pedido={selectedPedido}
        onClose={() => setSelectedPedido(null)}
        onRetryDone={() => { fetchPedidos(); setSelectedPedido(null); }}
      />
    </div>
  );
}
