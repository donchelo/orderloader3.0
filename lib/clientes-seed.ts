/**
 * Seed data for clientes_aprobados table.
 * Called once from the migrate API route when the table is empty.
 */
import type Database from "better-sqlite3";
import { CLIENT_NITS, CLIENT_TEXT_KEYWORDS } from "./pdf-classify";
import { getConfig } from "./config";
import {
  PROMPT_COMODIN, PROMPT_EXITO, PROMPT_HERMECO, PROMPT_EUROCORSETT,
  PROMPT_INDUSTRIASCORY, PROMPT_ESTUDIOMODA, PROMPT_PINTURAS_PRIME,
  PROMPT_MANUTEX, PROMPT_ELGLOBO, PROMPT_SERVICIO_COMPLETO,
  PROMPT_ICVO, PROMPT_PRODUEMPAK, PROMPT_PROINTIMO, PROMPT_TERMIMODA,
  PROMPT_BYSPRO, PROMPT_LAIMA,
} from "./prompts";

const PROMPTS_BY_CARPETA: Record<string, string> = {
  Comodin:          PROMPT_COMODIN,
  Exito:            PROMPT_EXITO,
  Hermeco:          PROMPT_HERMECO,
  Eurocorsett:      PROMPT_EUROCORSETT,
  IndustriasCory:   PROMPT_INDUSTRIASCORY,
  EstudioModa:      PROMPT_ESTUDIOMODA,
  PinturasPrime:    PROMPT_PINTURAS_PRIME,
  Manutex:          PROMPT_MANUTEX,
  ElGlobo:          PROMPT_ELGLOBO,
  ServicioCompleto: PROMPT_SERVICIO_COMPLETO,
  ICVO:             PROMPT_ICVO,
  Produempak:       PROMPT_PRODUEMPAK,
  Prointimo:        PROMPT_PROINTIMO,
  Termimoda:        PROMPT_TERMIMODA,
  Byspro:           PROMPT_BYSPRO,
  LaimaSas:         PROMPT_LAIMA,
};


const KEYWORDS_BY_CARPETA: Record<string, string[]> = Object.fromEntries(
  CLIENT_TEXT_KEYWORDS.map(({ carpeta, keywords }) => [carpeta, keywords])
);

export function seedClientes(db: Database.Database): { inserted: number } {
  const existing = (db.prepare("SELECT COUNT(*) as c FROM clientes_aprobados").get() as { c: number }).c;
  if (existing > 0) return { inserted: 0 };

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO clientes_aprobados
      (carpeta, nombre, nit_principal, nits_json, keywords_json, card_code, prompt)
    VALUES
      (@carpeta, @nombre, @nit_principal, @nits_json, @keywords_json, @card_code, @prompt)
  `);

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const { carpeta, nits } of CLIENT_NITS) {
      const nit_principal = nits[0];
      const result = stmt.run({
        carpeta,
        nombre:        carpeta.toUpperCase(),
        nit_principal,
        nits_json:     JSON.stringify(nits),
        keywords_json: JSON.stringify(KEYWORDS_BY_CARPETA[carpeta] ?? []),
        card_code:     `${getConfig().cardCodePrefix}${nit_principal}`,
        prompt:        PROMPTS_BY_CARPETA[carpeta] ?? "",
      });
      inserted += result.changes;
    }
  });
  tx();

  return { inserted };
}
