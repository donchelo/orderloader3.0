import { getDb } from "../lib/db";

const PRICING: Record<string, { inputPer1M: number; outputPer1M: number; label: string }> = {
  "claude-sonnet-4-6": { inputPer1M: 3.00,  outputPer1M: 15.00, label: "Sonnet 4.6 (extracción PDF)" },
  "claude-haiku-4-5-20251001": { inputPer1M: 0.80, outputPer1M: 4.00,  label: "Haiku 4.5 (triage adjuntos)" },
};

const TRM = 4200;

function usdToCop(usd: number): string {
  return `$${Math.round(usd * TRM).toLocaleString("es-CO")} COP`;
}

function formatUsd(usd: number): string {
  return `$${usd.toFixed(5)} USD`;
}

async function calculate() {
  const db = getDb();

  // Totales globales (incluye filas sin modelo — datos históricos de Sonnet)
  const global = db.prepare(`
    SELECT
      SUM(input_tokens)  AS total_input,
      SUM(output_tokens) AS total_output,
      COUNT(*)           AS total_registros
    FROM pipeline_log
    WHERE input_tokens IS NOT NULL
  `).get() as { total_input: number; total_output: number; total_registros: number };

  // Desglose por modelo
  const porModelo = db.prepare(`
    SELECT
      COALESCE(model, 'claude-sonnet-4-6') AS modelo,
      SUM(input_tokens)  AS input,
      SUM(output_tokens) AS output,
      COUNT(*)           AS registros
    FROM pipeline_log
    WHERE input_tokens IS NOT NULL
    GROUP BY modelo
    ORDER BY input DESC
  `).all() as { modelo: string; input: number; output: number; registros: number }[];

  // OCs procesadas (fase 1 parse OK con tokens)
  const ocsRow = db.prepare(`
    SELECT COUNT(*) AS n
    FROM pipeline_log
    WHERE fase_nombre = 'parse' AND estado_resultado = 'OK' AND input_tokens IS NOT NULL
  `).get() as { n: number };
  const totalOCs = ocsRow.n || 1;

  if (!global?.total_input) {
    console.log("No hay datos de consumo registrados todavía.");
    return;
  }

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║        Reporte de Costos de IA — OrderLoader                 ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log(`║  OCs procesadas: ${String(totalOCs).padEnd(44)}║`);
  console.log("╠══════════════════════════════════════════════════════════════╣");

  let totalUsd = 0;

  for (const row of porModelo) {
    const p = PRICING[row.modelo] ?? { inputPer1M: 3.0, outputPer1M: 15.0, label: row.modelo };
    const costInput  = (row.input  / 1_000_000) * p.inputPer1M;
    const costOutput = (row.output / 1_000_000) * p.outputPer1M;
    const costTotal  = costInput + costOutput;
    totalUsd += costTotal;

    console.log(`║  ${p.label}`);
    console.log(`║    Registros: ${row.registros}  |  Input: ${row.input.toLocaleString()} tok  |  Output: ${row.output.toLocaleString()} tok`);
    console.log(`║    Costo: ${formatUsd(costTotal).padEnd(14)} ${usdToCop(costTotal)}`);
    console.log("║  ─────────────────────────────────────────────────────────");
  }

  const totalCop = totalUsd * TRM;
  const promUsd  = totalUsd / totalOCs;

  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log(`║  TOTAL  ${formatUsd(totalUsd).padEnd(16)} ${usdToCop(totalUsd).padEnd(19)}║`);
  console.log(`║  Por OC ${formatUsd(promUsd).padEnd(16)} ${usdToCop(promUsd).padEnd(19)}║`);
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`\n  TRM utilizada: $${TRM.toLocaleString("es-CO")}`);
  console.log(`  Total COP: $${Math.round(totalCop).toLocaleString("es-CO")}`);
}

calculate().catch(console.error);
