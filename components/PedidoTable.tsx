"use client";

import { useState } from "react";
import PipelineStatus from "./PipelineStatus";
import { Button, Badge, cn } from "@/design-system";

export interface Pedido {
  id: number;
  orden_compra: string;
  cliente_nombre: string;
  nit_cliente: string;
  fecha_solicitado: string;
  fecha_entrega_general: string;
  subtotal: number;
  estado: string;
  fase_actual: number;
  error_msg: string | null;
  sap_doc_num: string | null;
  ts_sap_upload: string | null;
  validacion_resultado: string | null;
}

interface Props {
  pedidos: Pedido[];
  filtroEstado: string;
  onFiltroChange: (estado: string) => void;
  onSelect: (pedido: Pedido) => void;
  onDelete: (ordenes: string[]) => void;
}

function formatCOP(value: number): string {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(value);
}

function formatDate(d: string | null): string {
  if (!d) return "—";
  return d.split("T")[0];
}

interface Diferencia { campo: string; pdf: string | number; sap: string | number; }

const MSG_PREVIEW_LEN = 120;

function NotaCell({ msg, validacion }: { msg: string | null; validacion: string | null }) {
  const [expanded, setExpanded] = useState(false);

  const diferencias: Diferencia[] = (() => {
    if (!validacion) return [];
    try {
      const v = JSON.parse(validacion) as { ok: boolean; diferencias: Diferencia[] };
      return v.diferencias ?? [];
    } catch { return []; }
  })();

  const hasDifs  = diferencias.length > 0;
  const msgLong  = !!msg && msg.length > MSG_PREVIEW_LEN;

  if (!msg && !hasDifs) return null;

  return (
    <span className="text-xs">
      {msg && (
        <span>
          {msgLong && !expanded ? msg.slice(0, MSG_PREVIEW_LEN) + "… " : msg + " "}
          {msgLong && (
            <button
              onClick={() => setExpanded(v => !v)}
              className="text-moderate-blue underline cursor-pointer bg-transparent border-none p-0 text-xs"
            >
              {expanded ? "menos" : "ver más"}
            </button>
          )}
        </span>
      )}
      {hasDifs && (
        <>
          <span className="text-hot-orange font-semibold">
            {diferencias.length} diferencia(s):{" "}
            {expanded
              ? diferencias.map((d, i) => (
                  <span key={i} className="block font-normal text-[10px]">
                    {d.campo}: PDF={d.pdf} / SAP={d.sap}
                  </span>
                ))
              : diferencias.map(d => d.campo).join(", ")}
          </span>
          <button
            onClick={() => setExpanded(v => !v)}
            className="ml-1.5 text-erie-black underline cursor-pointer bg-transparent border-none p-0 text-xs"
          >
            {expanded ? "menos" : "más"}
          </button>
        </>
      )}
    </span>
  );
}

export default function PedidoTable({ pedidos, filtroEstado, onFiltroChange, onSelect, onDelete }: Props) {
  const [busqueda, setBusqueda]         = useState("");
  const [seleccionados, setSeleccionados] = useState<Set<string>>(new Set());

  const filtered = (filtroEstado === "todos" ? pedidos : pedidos.filter(p => p.estado === filtroEstado))
    .filter(p => !busqueda || p.cliente_nombre.toLowerCase().includes(busqueda.toLowerCase()));

  const allFilteredSelected = filtered.length > 0 && filtered.every(p => seleccionados.has(p.orden_compra));

  function toggleAll() {
    if (allFilteredSelected) {
      setSeleccionados(prev => { const n = new Set(prev); filtered.forEach(p => n.delete(p.orden_compra)); return n; });
    } else {
      setSeleccionados(prev => { const n = new Set(prev); filtered.forEach(p => n.add(p.orden_compra)); return n; });
    }
  }

  function toggleOne(oc: string) {
    setSeleccionados(prev => {
      const n = new Set(prev);
      n.has(oc) ? n.delete(oc) : n.add(oc);
      return n;
    });
  }

  function handleDelete() {
    const lista = [...seleccionados];
    if (!confirm(`¿Eliminar ${lista.length} pedido(s) de la base de datos? Esta acción no se puede deshacer.`)) return;
    onDelete(lista);
    setSeleccionados(new Set());
  }

  const stateCounts = pedidos.reduce((acc, p) => {
    acc[p.estado] = (acc[p.estado] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const activeStates = Object.keys(stateCounts).sort((a, b) => {
    if (a.startsWith("ERROR") && !b.startsWith("ERROR")) return 1;
    if (!a.startsWith("ERROR") && b.startsWith("ERROR")) return -1;
    if (a === "CERRADO") return 1;
    if (b === "CERRADO") return -1;
    return a.localeCompare(b);
  });

  return (
    <div className="flex flex-col gap-4">
      {/* Search + Delete */}
      <div className="flex gap-3 items-center flex-wrap">
        <div className="relative flex items-center">
          <input
            type="text"
            placeholder="Buscar por cliente…"
            value={busqueda}
            onChange={e => setBusqueda(e.target.value)}
            className="pl-4 pr-9 py-2 text-sm border border-erie-black/20 rounded-[9999px] w-60 outline-none focus:border-erie-black bg-white/60 placeholder:text-cadet-gray transition-colors"
          />
          {busqueda && (
            <button
              onClick={() => setBusqueda("")}
              className="absolute right-3 text-cadet-gray hover:text-erie-black transition-colors text-sm"
            >
              ✕
            </button>
          )}
        </div>

        {seleccionados.size > 0 && (
          <Button variant="accent" size="sm" onClick={handleDelete}>
            Eliminar {seleccionados.size} seleccionado(s)
          </Button>
        )}
      </div>

      {/* State filters */}
      <div className="flex gap-2 flex-wrap items-center">
        <span className="text-xs font-semibold text-cadet-gray mr-1 tracking-[0.06em] uppercase">Estado:</span>

        <button
          onClick={() => onFiltroChange("todos")}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-[9999px] px-3 h-7 text-xs font-semibold tracking-[0.04em] transition-all",
            filtroEstado === "todos"
              ? "bg-erie-black text-white"
              : "border border-erie-black/20 text-erie-black hover:border-erie-black"
          )}
        >
          Todos
          <span className={cn(
            "text-[10px] font-bold px-1.5 py-0.5 rounded-[9999px]",
            filtroEstado === "todos" ? "bg-white/20 text-white" : "bg-erie-black/8 text-cadet-gray"
          )}>
            {pedidos.length}
          </span>
        </button>

        {activeStates.map(e => (
          <button
            key={e}
            onClick={() => onFiltroChange(e)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-[9999px] px-3 h-7 text-xs font-semibold tracking-[0.04em] transition-all",
              filtroEstado === e
                ? "bg-erie-black text-white"
                : "border border-erie-black/20 text-erie-black hover:border-erie-black"
            )}
          >
            {e}
            <span className={cn(
              "text-[10px] font-bold px-1.5 py-0.5 rounded-[9999px]",
              filtroEstado === e ? "bg-white/20 text-white" : "bg-erie-black/8 text-cadet-gray"
            )}>
              {stateCounts[e]}
            </span>
          </button>
        ))}
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="py-12 text-center border border-dashed border-erie-black/15 rounded-[1rem] bg-white/40">
          <div className="text-2xl mb-2">—</div>
          <div className="font-semibold text-sm">No hay pedidos{filtroEstado !== "todos" ? ` en estado ${filtroEstado}` : ""}.</div>
          <div className="text-xs text-cadet-gray mt-1">Cambia el filtro para ver otros resultados.</div>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b-2 border-erie-black/10 bg-erie-black/3">
                <th className="py-3 px-4 text-center w-10">
                  <input type="checkbox" checked={allFilteredSelected} onChange={toggleAll} className="cursor-pointer" />
                </th>
                {["OC", "Cliente", "Solicitado", "Entrega", "Subtotal", "Estado", "SAP Doc", "Nota"].map(h => (
                  <th key={h} className={cn(
                    "py-3 px-4 font-semibold tracking-[0.04em] text-xs uppercase text-cadet-gray",
                    h === "Subtotal" ? "text-right" : h === "Estado" ? "text-center" : "text-left"
                  )}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const isErr  = p.estado.startsWith("ERROR");
                const isSel  = seleccionados.has(p.orden_compra);
                return (
                  <tr
                    key={p.orden_compra}
                    onClick={() => onSelect(p)}
                    className={cn(
                      "border-b border-erie-black/5 cursor-pointer transition-colors",
                      isSel  ? "bg-moderate-blue/8 hover:bg-moderate-blue/12" :
                      isErr  ? "bg-hot-orange/5 hover:bg-hot-orange/10" :
                               "hover:bg-erie-black/3"
                    )}
                  >
                    <td
                      className="py-2.5 px-4 text-center"
                      onClick={e => { e.stopPropagation(); toggleOne(p.orden_compra); }}
                    >
                      <input type="checkbox" checked={isSel} onChange={() => toggleOne(p.orden_compra)} className="cursor-pointer" />
                    </td>
                    <td className="py-2.5 px-4 font-semibold font-mono text-xs">{p.orden_compra}</td>
                    <td className="py-2.5 px-4">{p.cliente_nombre}</td>
                    <td className="py-2.5 px-4 font-mono text-xs" data-mono>{formatDate(p.fecha_solicitado)}</td>
                    <td className="py-2.5 px-4 font-mono text-xs" data-mono>{formatDate(p.fecha_entrega_general)}</td>
                    <td className="py-2.5 px-4 text-right font-mono text-xs" data-mono>{formatCOP(p.subtotal)}</td>
                    <td className="py-2.5 px-4 text-center">
                      <PipelineStatus estado={p.estado} />
                    </td>
                    <td className="py-2.5 px-4 font-mono text-xs text-cadet-gray">{p.sap_doc_num ?? "—"}</td>
                    <td className="py-2.5 px-4 max-w-[240px]">
                      <NotaCell msg={p.error_msg} validacion={p.validacion_resultado} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="mt-3 flex justify-between items-center text-xs text-cadet-gray">
            <span className="font-mono">{filtered.length} / {pedidos.length} pedido(s)</span>
            {filtroEstado !== "todos" && (
              <button
                onClick={() => onFiltroChange("todos")}
                className="text-erie-black underline cursor-pointer bg-transparent border-none p-0 text-xs"
              >
                Limpiar filtros
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
