"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Logo, Text, Card } from "@/design-system";

type Entry = {
  id: string | number;
  version: string;
  date: string;
  changes: string[];
  created_at?: string;
};

export default function ChangelogPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/changelog")
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setEntries(d.entries);
        else setError(d.error || "No se pudo cargar el changelog");
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-platinum">
      <header className="border-b border-erie-black/10 bg-white">
        <div className="max-w-[1400px] mx-auto px-6 py-4 flex items-center gap-4">
          <Logo version="v1" color="negro" height={28} />
          <div className="w-px h-6 bg-erie-black/15" />
          <Text variant="bodyBold" as="span" className="text-sm leading-none">
            Changelog
          </Text>
          <div className="ml-auto">
            <Link
              href="/"
              className="text-xs text-cadet-gray hover:text-erie-black transition-colors font-mono"
            >
              ← Volver
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-[900px] mx-auto px-6 py-8 flex flex-col gap-4">
        {loading && <Text variant="xs">Cargando...</Text>}
        {error && (
          <Card variant="elevated" padding="md">
            <Text variant="xs" className="text-hot-orange">
              {error}
            </Text>
          </Card>
        )}
        {!loading && !error && entries.length === 0 && (
          <Text variant="xs">Aún no hay entradas publicadas.</Text>
        )}
        {entries.map((e) => (
          <Card key={e.id} variant="elevated" padding="md">
            <div className="flex items-baseline gap-3 mb-3">
              <Text variant="bodyBold" as="span" className="text-lg">
                v{e.version}
              </Text>
              <time
                className="text-xs text-cadet-gray font-mono"
                dateTime={e.date}
              >
                {e.date}
              </time>
            </div>
            <ul className="list-disc pl-5 space-y-1">
              {e.changes.map((c, i) => (
                <li key={i}>
                  <Text variant="xs" as="span">
                    {c}
                  </Text>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </main>
    </div>
  );
}
