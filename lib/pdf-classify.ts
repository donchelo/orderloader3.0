/**
 * Clasificación de PDFs por contenido: identificación de cliente aprobado
 * y verificación de que el documento está dirigido a Tamaprint.
 *
 * Fuente de verdad compartida entre step0 (pre-triage) y step1 (parse).
 */

// ── Tamaprint ─────────────────────────────────────────────────────────────────

const TAMAPRINT_KEYWORDS = [
  "tamaprint",
  "tama print",
  "900851655",   // NIT sin dígito de verificación
  "9008516551",  // NIT con dígito de verificación
  "900.851.655", // NIT con puntos
];

export function esDirigidoATamaprint(pdfText: string): boolean {
  const lower = pdfText.toLowerCase();
  return TAMAPRINT_KEYWORDS.some(kw => lower.includes(kw));
}

// ── Clientes aprobados — NITs (señal principal) ────────────────────────────────

export const CLIENT_NITS: Array<{ carpeta: string; nits: string[] }> = [
  { carpeta: "Comodin",          nits: ["800069933"] },
  { carpeta: "Hermeco",          nits: ["890924167"] },
  { carpeta: "Exito",            nits: ["890900608"] },
  { carpeta: "Eurocorsett",      nits: ["811032857"] },
  { carpeta: "IndustriasCory",   nits: ["800131750"] },
  { carpeta: "EstudioModa",      nits: ["890926803"] },
  { carpeta: "PinturasPrime",    nits: ["800194203"] },
  { carpeta: "Manutex",          nits: ["900426666"] },
  { carpeta: "ElGlobo",          nits: ["800227956"] },
  { carpeta: "ServicioCompleto", nits: ["900690157"] },
  { carpeta: "ICVO",             nits: ["890932892"] },
  { carpeta: "Produempak",       nits: ["900445797"] },
  { carpeta: "Prointimo",        nits: ["811042428"] },
  { carpeta: "Termimoda",        nits: ["900447263"] },
];

// ── Clientes aprobados — keywords de marca (fallback) ─────────────────────────

export const CLIENT_TEXT_KEYWORDS: Array<{ carpeta: string; keywords: string[] }> = [
  { carpeta: "Comodin",          keywords: ["gco", "comodin", "americanino", "gco.com.co"] },
  { carpeta: "Hermeco",          keywords: ["hermeco", "offcorss", "offcorss.com"] },
  { carpeta: "Exito",            keywords: ["grupoexito", "grupo-exito", "grupo exito", "grupo éxito"] },
  { carpeta: "Eurocorsett",      keywords: ["eurocorsett", "eurocorsett.com"] },
  { carpeta: "IndustriasCory",   keywords: ["industrias cory", "industriascory", "cory s.a.s"] },
  { carpeta: "EstudioModa",      keywords: ["estudio de moda", "estudiomoda", "890926803"] },
  { carpeta: "PinturasPrime",    keywords: ["pinturas prime", "pinturasprime", "800194203", "pinturasprime.com"] },
  { carpeta: "Manutex",          keywords: ["manutex", "comercializadora manutex", "900426666"] },
  { carpeta: "ElGlobo",          keywords: ["el globo", "elglobo", "c.i. el globo", "800227956"] },
  { carpeta: "ServicioCompleto", keywords: ["servicio completo", "serviciocompleto", "900690157"] },
  { carpeta: "ICVO",             keywords: ["icvo", "icvo.com.co", "890932892"] },
  { carpeta: "Produempak",       keywords: ["produempak", "900445797"] },
  { carpeta: "Prointimo",        keywords: ["prointimo", "811042428"] },
  { carpeta: "Termimoda",        keywords: ["termimoda", "900447263"] },
];

export interface ClientDetection {
  carpeta: string;
  metodo: 'nit' | 'keyword';
}

/**
 * Detecta el cliente aprobado a partir del texto extraído de un PDF.
 *
 * Paso 1: busca NIT normalizado (quita puntos para matchear "800.069.933" = "800069933").
 * Paso 2: keywords de marca como fallback (solo si no hay NIT).
 *
 * Retorna { carpeta, metodo } o null si no se reconoce.
 */
export function detectClientFromPdf(pdfText: string): ClientDetection | null {
  const normalized = pdfText.replace(/\./g, "");
  for (const { carpeta, nits } of CLIENT_NITS) {
    if (nits.some(nit => normalized.includes(nit))) return { carpeta, metodo: 'nit' };
  }

  const lower = pdfText.toLowerCase();
  for (const { carpeta, keywords } of CLIENT_TEXT_KEYWORDS) {
    if (keywords.some(kw => lower.includes(kw))) return { carpeta, metodo: 'keyword' };
  }

  return null;
}
