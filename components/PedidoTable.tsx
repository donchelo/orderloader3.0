"use client";

import { useState } from "react";
import PipelineStatus from "./PipelineStatus";

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

  const hasDifs = diferencias.length > 0;
  const msgLong = !!msg && msg.length > MSG_PREVIEW_LEN;

  if (!msg && !hasDifs) return null;

  return (
    <span>
      {msg && (
        <span>
          {msgLong && !expanded ? msg.slice(0, MSG_PREVIEW_LEN) + "… " : msg + " "}
          {msgLong && (
            <button
              onClick={() => setExpanded(v => !v)}
              style={{ background: "none", border: "none", color: "#2563eb", textDecoration: "underline", cursor: "pointer", fontSize: 11, padding: 0 }}
            >
              {expanded ? "menos" : "ver más"}
            </button>
          )}
        </span>
      )}
      {hasDifs && (
        <>
          <span style={{ color: "#dc2626", fontWeight: 600 }}>
            {diferencias.length} diferencia(s):{" "}
            {expanded
              ? diferencias.map((d, i) => (
                  <span key={i} style={{ display: "block", fontWeight: 400, fontSize: 11 }}>
                    {d.campo}: PDF={d.pdf} / SAP={d.sap}
                  </span>
                ))
              : diferencias.map(d => d.campo).join(", ")}
          </span>
          <button
            onClick={() => setExpanded(v => !v)}
            style={{ marginLeft: 6, background: "none", border: "none", color: "#000", textDecoration: "underline", cursor: "pointer", fontSize: 11, padding: 0 }}
          >
            {expanded ? "menos" : "más"}
          </button>
        </>
      )}
    </span>
  );
}

export default function PedidoTable({ pedidos, filtroEstado, onFiltroChange, onSelect, onDelete }: Props) {
  const [busqueda, setBusqueda] = useState("");
  const [seleccionados, setSeleccionados] = useState<Set<string>>(new Set());

  const filtered = (filtroEstado === "todos" ? pedidos : pedidos.filter(p => p.estado === filtroEstado))
    .filter(p => !busqueda || p.cliente_nombre.toLowerCase().includes(busqueda.toLowerCase()));

  const allFilteredSelected = filtered.length > 0 && filtered.every(p => seleccionados.has(p.orden_compra));

  function toggleAll() {
    if (allFilteredSelected) {
      setSeleccionados(prev => {
        const next = new Set(prev);
        filtered.forEach(p => next.delete(p.orden_compra));
        return next;
      });
    } else {
      setSeleccionados(prev => {
        const next = new Set(prev);
        filtered.forEach(p => next.add(p.orden_compra));
        return next;
      });
    }
  }

  function toggleOne(oc: string) {
    setSeleccionados(prev => {
      const next = new Set(prev);
      next.has(oc) ? next.delete(oc) : next.add(oc);
      return next;
    });
  }

  function handleDelete() {
    const lista = [...seleccionados];
    if (!confirm(`¿Eliminar ${lista.length} pedido(s) de la base de datos? Esta acción no se puede deshacer.`)) return;
    onDelete(lista);
    setSeleccionados(new Set());
  }

  // Derive available states from data
  const stateCounts = pedidos.reduce((acc, p) => {
    acc[p.estado] = (acc[p.estado] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const activeStates = Object.keys(stateCounts).sort((a, b) => {
    // Sort logic: Errors at the end, CERRADO near the end, others by frequency or name
    if (a.startsWith("ERROR") && !b.startsWith("ERROR")) return 1;
    if (!a.startsWith("ERROR") && b.startsWith("ERROR")) return -1;
    if (a === "CERRADO") return 1;
    if (b === "CERRADO") return -1;
    return a.localeCompare(b);
  });

  return (
    <div>
      {/* Búsqueda + Eliminar */}
      <div style={{ marginBottom: 12, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <input
            type="text"
            placeholder="Buscar por cliente…"
            value={busqueda}
            onChange={e => setBusqueda(e.target.value)}
            style={{
              padding: "7px 12px", fontSize: 13, border: "1px solid #dee2e6",
              borderRadius: 6, width: 240, outline: "none", color: "#000",
            }}
          />
          {busqueda && (
            <button
              onClick={() => setBusqueda("")}
              style={{ marginLeft: 8, background: "none", border: "none", cursor: "pointer", fontSize: 13, color: "#000" }}
            >
              ✕
            </button>
          )}
        </div>
        {seleccionados.size > 0 && (
          <button
            onClick={handleDelete}
            style={{
              background: "#dc2626", color: "#fff", border: "none",
              borderRadius: 6, padding: "7px 16px", fontSize: 13, cursor: "pointer", fontWeight: 600,
            }}
          >
            Eliminar {seleccionados.size} seleccionado(s)
          </button>
        )}
      </div>

      {/* Filtro */}
      <div style={{ marginBottom: 20, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 13, fontWeight: 600, marginRight: 4, color: "#000" }}>Filtrar por estado:</span>
        
        {/* 'Todos' button */}
        <button
          onClick={() => onFiltroChange("todos")}
          style={{
            padding: "5px 14px",
            borderRadius: 8,
            border: "1px solid",
            borderColor: filtroEstado === "todos" ? "#000" : "#e2e8f0",
            background: filtroEstado === "todos" ? "#f1f5f9" : "#fff",
            color: "#000",
            fontSize: 12,
            fontWeight: filtroEstado === "todos" ? 700 : 500,
            cursor: "pointer",
            transition: "all 0.2s",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span>Todos</span>
          <span style={{ 
            background: "#e2e8f0", 
            padding: "1px 6px", 
            borderRadius: 10, 
            fontSize: 10,
            fontWeight: 700
          }}>
            {pedidos.length}
          </span>
        </button>

        {/* Dynamic State buttons */}
        {activeStates.map(e => (
          <button
            key={e}
            onClick={() => onFiltroChange(e)}
            style={{
              padding: "5px 14px",
              borderRadius: 8,
              border: "1px solid",
              borderColor: filtroEstado === e ? "#000" : "#e2e8f0",
              background: filtroEstado === e ? "#f1f5f9" : "#fff",
              color: "#000",
              fontSize: 12,
              fontWeight: filtroEstado === e ? 700 : 500,
              cursor: "pointer",
              transition: "all 0.2s",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span>{e}</span>
            <span style={{ 
              background: filtroEstado === e ? "#cbd5e1" : "#f1f5f9", 
              padding: "1px 6px", 
              borderRadius: 10, 
              fontSize: 10,
              fontWeight: 700
            }}>
              {stateCounts[e]}
            </span>
          </button>
        ))}
      </div>

      {/* Tabla */}
      {filtered.length === 0 ? (
        <div style={{ padding: "48px 0", textAlign: "center", color: "#000", background: "#f8fafc", borderRadius: 8, border: "1px dashed #e2e8f0" }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>🔍</div>
          <div style={{ fontWeight: 600 }}>No hay pedidos{filtroEstado !== "todos" ? ` en estado ${filtroEstado}` : ""}.</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Intenta cambiar el filtro para ver otros resultados.</div>
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13, color: "#000" }}>
            <thead>
              <tr style={{ background: "#f8fafc", color: "#000", borderBottom: "2px solid #e2e8f0" }}>
                <th style={{ padding: "12px 16px", textAlign: "center", width: 40 }}>
                  <input type="checkbox" checked={allFilteredSelected} onChange={toggleAll} />
                </th>
                <th style={{ padding: "12px 16px", textAlign: "left", fontWeight: 700 }}>OC</th>
                <th style={{ padding: "12px 16px", textAlign: "left", fontWeight: 700 }}>Cliente</th>
                <th style={{ padding: "12px 16px", textAlign: "left", fontWeight: 700 }}>Solicitado</th>
                <th style={{ padding: "12px 16px", textAlign: "left", fontWeight: 700 }}>Entrega</th>
                <th style={{ padding: "12px 16px", textAlign: "right", fontWeight: 700 }}>Subtotal</th>
                <th style={{ padding: "12px 16px", textAlign: "center", fontWeight: 700 }}>Estado</th>
                <th style={{ padding: "12px 16px", textAlign: "left", fontWeight: 700 }}>SAP Doc</th>
                <th style={{ padding: "12px 16px", textAlign: "left", fontWeight: 700 }}>Nota</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr
                  key={p.orden_compra}
                  onClick={() => onSelect(p)}
                  style={{
                    borderBottom: "1px solid #f1f5f9",
                    background: seleccionados.has(p.orden_compra) ? "#eff6ff" : p.estado.startsWith("ERROR") ? "#fff1f2" : undefined,
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = seleccionados.has(p.orden_compra) ? "#dbeafe" : p.estado.startsWith("ERROR") ? "#ffe4e6" : "#f8fafc"}
                  onMouseLeave={(e) => e.currentTarget.style.background = seleccionados.has(p.orden_compra) ? "#eff6ff" : p.estado.startsWith("ERROR") ? "#fff1f2" : "transparent"}
                >
                  <td style={{ padding: "10px 16px", textAlign: "center" }} onClick={e => { e.stopPropagation(); toggleOne(p.orden_compra); }}>
                    <input type="checkbox" checked={seleccionados.has(p.orden_compra)} onChange={() => toggleOne(p.orden_compra)} />
                  </td>
                  <td style={{ padding: "10px 16px", fontWeight: 600 }}>{p.orden_compra}</td>
                  <td style={{ padding: "10px 16px" }}>{p.cliente_nombre}</td>
                  <td style={{ padding: "10px 16px" }}>{formatDate(p.fecha_solicitado)}</td>
                  <td style={{ padding: "10px 16px" }}>{formatDate(p.fecha_entrega_general)}</td>
                  <td style={{ padding: "10px 16px", textAlign: "right" }}>{formatCOP(p.subtotal)}</td>
                  <td style={{ padding: "10px 16px", textAlign: "center" }}>
                    <PipelineStatus estado={p.estado} />
                  </td>
                  <td style={{ padding: "10px 16px", color: "#000", fontSize: 12 }}>{p.sap_doc_num ?? "—"}</td>
                  <td style={{ padding: "10px 16px", color: "#000", fontSize: 12, maxWidth: 240 }}>
                    <NotaCell msg={p.error_msg} validacion={p.validacion_resultado} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 12, fontSize: 12, color: "#64748b", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Mostrando {filtered.length} de {pedidos.length} pedido(s)</span>
            {filtroEstado !== "todos" && (
              <button 
                onClick={() => onFiltroChange("todos")}
                style={{ background: "none", border: "none", color: "#000", textDecoration: "underline", cursor: "pointer", fontSize: 12 }}
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
