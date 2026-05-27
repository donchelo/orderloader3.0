/**
 * Aplica los prompts específicos generados a la BD de FlexoImpresos.
 * Solo actualiza los 25 clientes para los que existe un prompt en flexo-prompts-generated.ts.
 * Los demás 23 clientes mantienen la plantilla genérica original.
 */
import { getDb } from "../lib/db";
import { FLEXO_SPECIFIC_PROMPTS } from "../lib/flexo-prompts-generated";

const db = getDb();
const stmt = db.prepare("UPDATE clientes_aprobados SET prompt = ? WHERE carpeta = ?");

let updated = 0;
const skipped: string[] = [];

for (const [carpeta, prompt] of Object.entries(FLEXO_SPECIFIC_PROMPTS)) {
  const res = stmt.run(prompt, carpeta);
  if (res.changes === 1) {
    updated++;
    console.log(`  ✓ ${carpeta}`);
  } else {
    skipped.push(carpeta);
  }
}

console.log(`\n${updated} clientes actualizados con prompt específico`);
if (skipped.length) console.log("Saltados (carpeta no encontrada):", skipped.join(", "));

const total = db.prepare("SELECT COUNT(*) as n FROM clientes_aprobados WHERE activo = 1").get() as { n: number };
console.log(`\nTotal clientes activos: ${total.n}`);
console.log(`Con prompt específico:  ${updated}`);
console.log(`Con prompt genérico:    ${total.n - updated}`);
