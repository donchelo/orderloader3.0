"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Logo, Text, Button, Card, Badge } from "@/design-system";

interface Cliente {
  id: number;
  carpeta: string;
  nombre: string;
  nit_principal: string;
  nits: string[];
  keywords: string[];
  card_code: string;
  prompt: string;
  activo: number;
  ts_creado: string;
  ts_modificado: string;
}

export default function ClienteDetailPage() {
  const { id }   = useParams<{ id: string }>();
  const router   = useRouter();
  const [cliente, setCliente]   = useState<Cliente | null>(null);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [saveMsg, setSaveMsg]   = useState<string | null>(null);

  // Form state (editable)
  const [nombre,   setNombre]   = useState("");
  const [nit,      setNit]      = useState("");
  const [nits,     setNits]     = useState("");
  const [keywords, setKeywords] = useState("");
  const [cardCode, setCardCode] = useState("");
  const [prompt,   setPrompt]   = useState("");
  const [activo,   setActivo]   = useState(1);

  // AI iteration state (ephemeral, not saved to DB)
  const [notes,          setNotes]          = useState("");
  const [improving,      setImproving]      = useState(false);
  const [improvedPrompt, setImprovedPrompt] = useState<string | null>(null);
  const [iterError,      setIterError]      = useState<string | null>(null);

  const fetchCliente = useCallback(async () => {
    try {
      const res  = await fetch(`/api/clientes/${id}`);
      const data = await res.json() as { ok: boolean; cliente?: Cliente; error?: string };
      if (!data.ok || !data.cliente) { setError(data.error ?? "No encontrado"); return; }
      const c = data.cliente;
      setCliente(c);
      setNombre(c.nombre);
      setNit(c.nit_principal);
      setNits(c.nits.join(", "));
      setKeywords(c.keywords.join(", "));
      setCardCode(c.card_code);
      setPrompt(c.prompt);
      setActivo(c.activo);
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }, [id]);

  useEffect(() => { fetchCliente(); }, [fetchCliente]);

  async function handleSave() {
    setSaving(true);
    setSaveMsg(null);
    setError(null);
    try {
      const res  = await fetch(`/api/clientes/${id}`, {
        method:  "PUT",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          nombre,
          nit_principal: nit,
          nits:     nits.split(",").map(s => s.trim()).filter(Boolean),
          keywords: keywords.split(",").map(s => s.trim()).filter(Boolean),
          card_code: cardCode,
          prompt,
          activo,
        }),
      });
      const data = await res.json() as { ok: boolean; error?: string };
      if (data.ok) { setSaveMsg("Guardado correctamente"); await fetchCliente(); }
      else setError(data.error ?? "Error al guardar");
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  }

  async function handleMejorar() {
    setImproving(true);
    setImprovedPrompt(null);
    setIterError(null);
    try {
      const res = await fetch(`/api/clientes/${id}/mejorar-prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, notes }),
      });
      const data = await res.json() as { ok: boolean; improved_prompt?: string; error?: string };
      if (data.ok && data.improved_prompt) {
        setImprovedPrompt(data.improved_prompt);
      } else {
        setIterError(data.error ?? "Error al mejorar el prompt");
      }
    } catch (e) {
      setIterError(String(e));
    } finally {
      setImproving(false);
    }
  }

  function handleNitChange(v: string) {
    setNit(v);
    setCardCode(`CN${v}`);
  }

  const isDirty = cliente ? (
    nombre !== cliente.nombre ||
    nit !== cliente.nit_principal ||
    nits !== cliente.nits.join(", ") ||
    keywords !== cliente.keywords.join(", ") ||
    cardCode !== cliente.card_code ||
    prompt !== cliente.prompt ||
    activo !== cliente.activo
  ) : false;

  return (
    <div className="min-h-screen bg-mint-cream text-erie-black">
      {/* Header */}
      <header className="border-b border-erie-black/10 bg-mint-cream/80 backdrop-blur-sm sticky top-0 z-30">
        <div className="max-w-[1400px] mx-auto px-6 py-4 flex items-center gap-4">
          <Link href="/">
            <Logo version="v1" color="negro" height={28} />
          </Link>
          <div className="w-px h-6 bg-erie-black/15" />
          <div className="flex-1 min-w-0">
            <Text variant="bodyBold" as="span" className="text-sm leading-none">
              {loading ? "Cargando…" : (cliente?.nombre ?? "Cliente")}
            </Text>
            <Text variant="xs" as="div" className="mt-0.5 text-cadet-gray">
              {cliente?.carpeta ?? ""}
            </Text>
          </div>
          <Link href="/clientes" className="text-xs text-cadet-gray hover:text-erie-black transition-colors">
            ← Clientes
          </Link>
        </div>
      </header>

      <main className="max-w-[900px] mx-auto px-6 py-8 flex flex-col gap-6">
        {loading ? (
          <div className="py-16 text-center text-cadet-gray text-sm">Cargando…</div>
        ) : error && !cliente ? (
          <Card variant="elevated" padding="lg">
            <div className="text-hot-orange text-sm">{error}</div>
            <Button variant="secondary" size="md" className="mt-4" onClick={() => router.push("/clientes")}>
              ← Volver
            </Button>
          </Card>
        ) : (
          <>
            {/* Mensajes */}
            {error   && <div className="rounded-xl border border-hot-orange/30 bg-hot-orange/5 px-4 py-3 text-sm text-hot-orange">{error}</div>}
            {saveMsg && <div className="rounded-xl border border-green-500/30 bg-green-500/5 px-4 py-3 text-sm text-green-700">{saveMsg}</div>}

            {/* Datos básicos */}
            <Card variant="elevated" padding="lg">
              <div className="flex items-center justify-between mb-5">
                <Text variant="h3">Datos del cliente</Text>
                <div className="flex items-center gap-3">
                  <Badge variant={activo === 1 ? "success" : "muted"} size="sm">
                    {activo === 1 ? "Activo" : "Inactivo"}
                  </Badge>
                  <button
                    className="text-xs text-cadet-gray hover:text-erie-black underline underline-offset-2 transition-colors"
                    onClick={() => setActivo(a => a === 1 ? 0 : 1)}
                  >
                    {activo === 1 ? "Desactivar" : "Activar"}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-semibold text-cadet-gray uppercase tracking-wide">Nombre</span>
                  <input
                    className="border border-erie-black/20 rounded-lg px-3 py-2 text-sm font-mono bg-white focus:outline-none focus:ring-2 focus:ring-moderate-blue/30"
                    value={nombre}
                    onChange={e => setNombre(e.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-semibold text-cadet-gray uppercase tracking-wide">Carpeta (ID)</span>
                  <input
                    className="border border-erie-black/20 rounded-lg px-3 py-2 text-sm font-mono bg-white/50 cursor-not-allowed"
                    value={cliente?.carpeta ?? ""}
                    disabled
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-semibold text-cadet-gray uppercase tracking-wide">NIT principal</span>
                  <input
                    className="border border-erie-black/20 rounded-lg px-3 py-2 text-sm font-mono bg-white focus:outline-none focus:ring-2 focus:ring-moderate-blue/30"
                    value={nit}
                    onChange={e => handleNitChange(e.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-semibold text-cadet-gray uppercase tracking-wide">CardCode SAP</span>
                  <input
                    className="border border-erie-black/20 rounded-lg px-3 py-2 text-sm font-mono bg-white focus:outline-none focus:ring-2 focus:ring-moderate-blue/30"
                    value={cardCode}
                    onChange={e => setCardCode(e.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1.5 sm:col-span-2">
                  <span className="text-xs font-semibold text-cadet-gray uppercase tracking-wide">NITs adicionales (separados por coma)</span>
                  <input
                    className="border border-erie-black/20 rounded-lg px-3 py-2 text-sm font-mono bg-white focus:outline-none focus:ring-2 focus:ring-moderate-blue/30"
                    value={nits}
                    onChange={e => setNits(e.target.value)}
                    placeholder="800069933, 8000699330"
                  />
                </label>
                <label className="flex flex-col gap-1.5 sm:col-span-2">
                  <span className="text-xs font-semibold text-cadet-gray uppercase tracking-wide">Keywords (separadas por coma)</span>
                  <input
                    className="border border-erie-black/20 rounded-lg px-3 py-2 text-sm font-mono bg-white focus:outline-none focus:ring-2 focus:ring-moderate-blue/30"
                    value={keywords}
                    onChange={e => setKeywords(e.target.value)}
                    placeholder="gco, comodin, americanino, gco.com.co"
                  />
                  <span className="text-xs text-cadet-gray">Palabras clave para detectar este cliente en PDFs cuando no se encuentra el NIT.</span>
                </label>
              </div>

              {cliente && (
                <div className="mt-4 pt-4 border-t border-erie-black/5 flex gap-6 text-xs text-cadet-gray font-mono">
                  <span>Creado: {new Date(cliente.ts_creado + "Z").toLocaleDateString("es-CO")}</span>
                  <span>Modificado: {new Date(cliente.ts_modificado + "Z").toLocaleDateString("es-CO")}</span>
                </div>
              )}
            </Card>

            {/* Prompt */}
            <Card variant="elevated" padding="lg">
              <div className="flex items-center justify-between mb-4">
                <Text variant="h3">Prompt de extracción</Text>
                <span className="text-xs text-cadet-gray font-mono">{prompt.length} caracteres</span>
              </div>
              <Text variant="xs" className="text-cadet-gray mb-3">
                Este prompt se le pasa a Claude cuando procesa un PDF de este cliente. Define cómo extraer el JSON para SAP B1.
              </Text>
              <textarea
                className="w-full border border-erie-black/20 rounded-lg px-3 py-3 text-xs font-mono bg-white focus:outline-none focus:ring-2 focus:ring-moderate-blue/30 resize-y leading-relaxed"
                rows={28}
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                spellCheck={false}
              />
            </Card>

            {/* Mejorar con IA */}
            <Card variant="elevated" padding="lg">
              <div className="flex items-center justify-between mb-3">
                <Text variant="h3">Mejorar con IA</Text>
                <Badge variant="muted" size="sm">Experimental</Badge>
              </div>
              <Text variant="xs" className="text-cadet-gray mb-4">
                Describí correcciones o aclaraciones para este prompt. La IA lo reescribirá incorporando tus notas sin alterar la estructura general.
              </Text>

              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-semibold text-cadet-gray uppercase tracking-wide">Notas / temas a corregir</span>
                <textarea
                  className="w-full border border-erie-black/20 rounded-lg px-3 py-3 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-moderate-blue/30 resize-y leading-relaxed"
                  rows={5}
                  placeholder={'Ej: la columna de precio se llama "Valor Unit", no "Precio". Las líneas duplicadas deben procesarse por separado, no agrupadas.'}
                  value={notes}
                  onChange={e => { setNotes(e.target.value); setImprovedPrompt(null); setIterError(null); }}
                  spellCheck={false}
                />
              </label>

              <div className="flex justify-end mt-3">
                <Button
                  variant="primary"
                  size="md"
                  onClick={handleMejorar}
                  disabled={notes.trim() === "" || improving}
                >
                  {improving ? "Analizando…" : "Mejorar con IA"}
                </Button>
              </div>

              {iterError && (
                <div className="rounded-xl border border-hot-orange/30 bg-hot-orange/5 px-4 py-3 text-sm text-hot-orange mt-3">
                  {iterError}
                </div>
              )}

              {improvedPrompt !== null && (
                <div className="mt-4 border-t border-erie-black/10 pt-4">
                  <div className="flex items-center justify-between mb-2">
                    <Text variant="bodyBold" className="text-sm text-moderate-blue">Prompt mejorado — previsualización</Text>
                    <span className="text-xs text-cadet-gray font-mono">{improvedPrompt.length} caracteres</span>
                  </div>
                  <textarea
                    className="w-full border border-moderate-blue/30 rounded-lg px-3 py-3 text-xs font-mono bg-white/60 leading-relaxed resize-y"
                    rows={14}
                    value={improvedPrompt}
                    readOnly
                    spellCheck={false}
                  />
                  <div className="flex gap-3 justify-end mt-3">
                    <Button
                      variant="secondary"
                      size="md"
                      onClick={() => { setImprovedPrompt(null); setNotes(""); }}
                    >
                      Descartar
                    </Button>
                    <Button
                      variant="primary"
                      size="md"
                      onClick={() => { setPrompt(improvedPrompt); setImprovedPrompt(null); setNotes(""); }}
                    >
                      Aplicar mejora
                    </Button>
                  </div>
                </div>
              )}
            </Card>

            {/* Guardar */}
            <div className="flex gap-3 justify-end pb-8">
              <Button
                variant="secondary"
                size="md"
                onClick={() => {
                  if (cliente) {
                    setNombre(cliente.nombre); setNit(cliente.nit_principal);
                    setNits(cliente.nits.join(", ")); setKeywords(cliente.keywords.join(", "));
                    setCardCode(cliente.card_code); setPrompt(cliente.prompt);
                    setActivo(cliente.activo);
                  }
                  setSaveMsg(null); setError(null);
                }}
                disabled={!isDirty || saving}
              >
                Descartar cambios
              </Button>
              <Button
                variant="primary"
                size="md"
                onClick={handleSave}
                disabled={!isDirty || saving}
              >
                {saving ? "Guardando…" : "Guardar cambios"}
              </Button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
