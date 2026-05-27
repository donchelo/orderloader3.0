"use client";

import { useState, useEffect, useCallback } from "react";
import { Text, Badge } from "@/design-system";

type ChangePrefix = "feat" | "fix" | "refactor" | "chore";

const PREFIX_CONFIG: Record<
  ChangePrefix,
  { dot: string; label: string | null; dim?: boolean; badge: "success" | "accent" | "blue" | "muted" }
> = {
  feat:     { dot: "#4ade80", label: "Nuevo",       badge: "success" },
  fix:      { dot: "#fbbf24", label: "Corrección",  badge: "accent"  },
  refactor: { dot: "#60a5fa", label: "Mejora",      badge: "blue"    },
  chore:    { dot: "#94a3b8", label: null, dim: true, badge: "muted" },
};

interface ParsedChange {
  prefix: ChangePrefix | null;
  text: string;
}

function parseChange(raw: string): ParsedChange | null {
  const cleaned = raw.replace(/\s*Co-Authored-By:[^\n]*/gi, "").trim();
  if (!cleaned) return null;
  const match = cleaned.match(/^(feat|fix|refactor|chore)(?:\([^)]*\))?:\s*/i);
  if (match) {
    const prefix = match[1].toLowerCase() as ChangePrefix;
    const rest = cleaned.slice(match[0].length).trim();
    return { prefix, text: rest.charAt(0).toUpperCase() + rest.slice(1) };
  }
  return { prefix: null, text: cleaned };
}

interface RemoteEntry {
  version: string;
  date: string;
  changes: string[];
}

export function VersionTag() {
  const [open, setOpen]       = useState(false);
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [loaded, setLoaded]   = useState(false);

  useEffect(() => {
    fetch("/api/changelog")
      .then((r) => r.json())
      .then((d: { ok: boolean; entries: RemoteEntry[] }) => {
        setEntries(d.entries ?? []);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const close = useCallback(() => setOpen(false), []);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, close]);

  const currentVersion = entries[0]?.version ?? "…";

  return (
    <>
      {/* Pill flotante */}
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-3 right-3 z-50 group cursor-pointer outline-none select-none"
      >
        <div className="flex items-center gap-1.5 rounded-full border border-erie-black/15 bg-white/70 px-2.5 py-1 backdrop-blur-md shadow-sm transition-all hover:bg-white hover:border-erie-black/30 hover:scale-105 active:scale-95">
          <div className="h-1.5 w-1.5 rounded-full bg-moderate-blue animate-pulse" />
          <span className="text-[10px] font-bold tracking-tight text-cadet-gray uppercase group-hover:text-erie-black transition-colors font-mono">
            v{currentVersion}
          </span>
        </div>
      </button>

      {/* Modal */}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          onClick={close}
        >
          {/* Backdrop */}
          <div className="absolute inset-0 bg-erie-black/30 backdrop-blur-sm" />

          {/* Panel */}
          <div
            className="relative w-full max-w-md rounded-2xl bg-white shadow-2xl flex flex-col max-h-[85vh]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-erie-black/10">
              <div className="flex items-center gap-2">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-moderate-blue">
                  <path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/>
                </svg>
                <Text variant="bodyBold" as="span">Historial de Versiones</Text>
              </div>
              <button
                onClick={close}
                className="rounded-full p-1 hover:bg-erie-black/8 transition-colors text-cadet-gray hover:text-erie-black"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>

            {/* Body */}
            <div className="overflow-y-auto px-5 py-5 flex-1">
              {!loaded ? (
                <Text variant="xs" className="opacity-50">Cargando historial…</Text>
              ) : entries.length === 0 ? (
                <Text variant="xs" className="opacity-50">Sin entradas disponibles.</Text>
              ) : (
                <div className="relative pl-8">
                  {/* Línea vertical */}
                  <div className="absolute left-[15px] top-2 bottom-2 w-px bg-erie-black/10" />

                  {entries.map((entry, i) => (
                    <div key={entry.version} className="relative mb-8 last:mb-0">
                      {/* Dot en la línea */}
                      <div
                        className={`absolute -left-[25px] top-0.5 w-5 h-5 rounded-full bg-white border-2 z-10 flex items-center justify-center text-[8px] font-bold font-mono ${
                          i === 0
                            ? "border-moderate-blue text-moderate-blue"
                            : "border-erie-black/20 text-cadet-gray"
                        }`}
                      >
                        {entry.version.split(".").pop()}
                      </div>

                      {/* Encabezado de versión */}
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <Text variant="bodyBold" as="span" className="text-sm">
                            v{entry.version}
                          </Text>
                          {i === 0 && (
                            <Badge variant="blue" size="sm">ACTUAL</Badge>
                          )}
                        </div>
                        <Text variant="xs" className="text-cadet-gray font-mono">{entry.date}</Text>
                      </div>

                      {/* Changes */}
                      <ul className="space-y-1.5">
                        {entry.changes.flatMap((raw, idx) => {
                          const parsed = parseChange(raw);
                          if (!parsed) return [];
                          const cfg = parsed.prefix ? PREFIX_CONFIG[parsed.prefix] : null;
                          return [
                            <li
                              key={idx}
                              className={`flex gap-2 text-xs leading-relaxed ${cfg?.dim ? "opacity-40" : "text-erie-black/70"}`}
                            >
                              <span
                                className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full"
                                style={{ backgroundColor: cfg?.dot ?? "#94a3b8", opacity: cfg?.dot ? 1 : 0.4 }}
                              />
                              <span>
                                {cfg?.label && !cfg.dim && (
                                  <Badge variant={cfg.badge} size="sm" className="mr-1.5 align-middle text-[8px] h-4 px-1.5">
                                    {cfg.label}
                                  </Badge>
                                )}
                                {parsed.text}
                              </span>
                            </li>,
                          ];
                        })}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="border-t border-erie-black/8 py-2 text-center">
              <Text variant="xs" className="text-[9px] font-bold tracking-widest uppercase opacity-30 font-mono">
                OrderLoader — SAP B1 Pipeline
              </Text>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
