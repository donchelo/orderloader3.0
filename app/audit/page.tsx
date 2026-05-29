"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";

interface LogEntry {
  id: number;
  orden_compra: string | null;
  fase: number;
  fase_nombre: string;
  estado_resultado: "OK" | "ERROR" | "WARN";
  mensaje: string;
  input_tokens: number | null;
  output_tokens: number | null;
  model: string | null;
  ts: string;
}

interface TriggerEntry {
  id: number;
  ts: string;
  source: string;
  ip: string;
  resultado: string;
}

interface Summary {
  total: number;
  ok: number;
  errores: number;
  warnings: number;
  total_input_tokens: number;
  total_output_tokens: number;
}

const ESTADO_STYLES: Record<string, string> = {
  OK:    "bg-green-50 text-green-700 border border-green-200",
  ERROR: "bg-orange-50 text-orange-700 border border-orange-200",
  WARN:  "bg-yellow-50 text-yellow-700 border border-yellow-200",
};

function fmt(ts: string) {
  return new Date(ts + "Z").toLocaleString("es-CO", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

export default function AuditPage() {
  const [log, setLog]           = useState<LogEntry[]>([]);
  const [triggers, setTriggers] = useState<TriggerEntry[]>([]);
  const [summary, setSummary]   = useState<Summary | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [tab, setTab]           = useState<"log" | "triggers">("log");
  const [filterOC, setFilterOC] = useState("");

  const load = useCallback(async (oc?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "200" });
      if (oc) params.set("oc", oc);
      const res  = await fetch(`/api/audit?${params}`);
      const data = await res.json();
      if (data.ok) {
        setLog(data.log);
        setTriggers(data.triggers);
        setSummary(data.summary);
      } else {
        setError(data.error);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleFilter = (e: React.FormEvent) => {
    e.preventDefault();
    load(filterOC.trim() || undefined);
  };

  const totalTokens = summary
    ? ((summary.total_input_tokens + summary.total_output_tokens) / 1000).toFixed(1)
    : "—";

  return (
    <div className="min-h-screen bg-mint-cream text-erie-black">
      <header className="sticky top-0 z-30 border-b border-erie-black/10 bg-mint-cream/80 backdrop-blur-sm">
        <div className="mx-auto max-w-[1400px] px-6 py-4 flex items-center gap-4">
          <Link href="/" className="text-cadet-gray hover:text-erie-black text-sm">← Dashboard</Link>
          <h1 className="font-semibold text-base">Audit Trail — Pipeline</h1>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-6 py-8 space-y-6">

        {/* Summary cards */}
        {summary && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {[
              { label: "Total entradas", value: summary.total,    color: "text-erie-black"    },
              { label: "OK",             value: summary.ok,        color: "text-moderate-blue" },
              { label: "Errores",        value: summary.errores,   color: "text-hot-orange"    },
              { label: "Warnings",       value: summary.warnings,  color: "text-yellow-600"    },
              { label: "Tokens (k)",     value: totalTokens,       color: "text-cadet-gray"    },
            ].map(({ label, value, color }) => (
              <div key={label} className="rounded-xl bg-white border border-erie-black/10 p-4 shadow-sm">
                <p className="text-xs text-cadet-gray mb-1">{label}</p>
                <p className={`text-2xl font-bold ${color}`}>{value}</p>
              </div>
            ))}
          </div>
        )}

        {/* Filter */}
        <form onSubmit={handleFilter} className="flex gap-2 items-center">
          <input
            value={filterOC}
            onChange={e => setFilterOC(e.target.value)}
            placeholder="Filtrar por orden de compra…"
            className="border border-erie-black/15 rounded-full px-4 py-2 text-sm bg-white w-72 focus:outline-none focus:border-erie-black/40"
          />
          <button type="submit" className="rounded-full bg-erie-black text-white px-4 py-2 text-sm">Filtrar</button>
          {filterOC && (
            <button type="button" onClick={() => { setFilterOC(""); load(); }}
              className="text-sm text-cadet-gray hover:text-erie-black">Limpiar</button>
          )}
        </form>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-erie-black/10">
          {(["log", "triggers"] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                tab === t
                  ? "border-erie-black text-erie-black"
                  : "border-transparent text-cadet-gray hover:text-erie-black"
              }`}>
              {t === "log" ? `Pipeline Log (${log.length})` : `Triggers (${triggers.length})`}
            </button>
          ))}
        </div>

        {error && (
          <div className="rounded-xl border border-hot-orange/30 bg-hot-orange/5 px-4 py-3 text-sm text-hot-orange">
            {error}
          </div>
        )}

        {loading ? (
          <div className="text-sm text-cadet-gray py-8 text-center">Cargando…</div>
        ) : tab === "log" ? (
          <div className="overflow-x-auto rounded-xl border border-erie-black/10 bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead className="border-b border-erie-black/10 text-xs text-cadet-gray uppercase tracking-wider">
                <tr>
                  {["Timestamp", "OC", "Fase", "Estado", "Mensaje", "Tokens", "Modelo"].map(h => (
                    <th key={h} className="text-left px-4 py-3 font-medium whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-erie-black/5">
                {log.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-cadet-gray">Sin entradas</td></tr>
                ) : log.map(row => (
                  <tr key={row.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-2.5 font-mono text-xs text-cadet-gray whitespace-nowrap">{fmt(row.ts)}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">{row.orden_compra ?? "—"}</td>
                    <td className="px-4 py-2.5 text-xs whitespace-nowrap">
                      <span className="text-cadet-gray">{row.fase} · </span>{row.fase_nombre}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${ESTADO_STYLES[row.estado_resultado] ?? ""}`}>
                        {row.estado_resultado}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs max-w-xs truncate" title={row.mensaje}>{row.mensaje}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-cadet-gray whitespace-nowrap">
                      {row.input_tokens != null ? `${row.input_tokens}↑ ${row.output_tokens}↓` : "—"}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-cadet-gray">{row.model ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-erie-black/10 bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead className="border-b border-erie-black/10 text-xs text-cadet-gray uppercase tracking-wider">
                <tr>
                  {["Timestamp", "Fuente", "IP", "Resultado"].map(h => (
                    <th key={h} className="text-left px-4 py-3 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-erie-black/5">
                {triggers.length === 0 ? (
                  <tr><td colSpan={4} className="px-4 py-8 text-center text-cadet-gray">Sin triggers</td></tr>
                ) : triggers.map(row => (
                  <tr key={row.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-2.5 font-mono text-xs text-cadet-gray whitespace-nowrap">{fmt(row.ts)}</td>
                    <td className="px-4 py-2.5 text-xs">{row.source}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-cadet-gray">{row.ip}</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                        row.resultado === "iniciado"
                          ? "bg-green-50 text-green-700 border border-green-200"
                          : "bg-gray-50 text-gray-600 border border-gray-200"
                      }`}>{row.resultado}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
