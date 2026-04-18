/**
 * Step 1: PDF → DB (estado PARSED).
 *
 * Comodin + Exito: Claude AI extrae directamente el JSON SAP B1.
 * Es idempotente: carpetas con data_extraida.json se saltan.
 */

import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../config";
import { getDb, logPipeline } from "../db";
import { sendAlertEmail } from "../mailer";
import { SapB1OrderSchema, type SapB1Order } from "../schemas";
export type { SapB1Order };
import { PROMPT_COMODIN, PROMPT_EXITO, PROMPT_HERMECO } from "../prompts";

export interface StepResult {
  procesados: number;
  errores: number;
  saltados: number;
  detalles: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function yyyymmddToIso(d: string): string {
  if (/^\d{8}$/.test(d)) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`;
  return d;
}

// ── AI Parser ─────────────────────────────────────────────────────────────────

async function parseWithAI(pdfText: string, prompt: string): Promise<[SapB1Order | null, string, { input?: number, output?: number }]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [null, "ANTHROPIC_API_KEY no configurado en .env", {}];

  const client = new Anthropic({ apiKey });

  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    temperature: 0,
    system: prompt,
    messages: [{ role: "user", content: pdfText }],
  });

  const text = msg.content[0].type === "text" ? msg.content[0].text.trim() : "";
  const usage = { input: msg.usage?.input_tokens, output: msg.usage?.output_tokens };
  if (!text) return [null, "Respuesta vacía del modelo", usage];

  const clean = text.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();

  try {
    const rawOrder = JSON.parse(clean);

    // Validación estricta con Zod
    const result = SapB1OrderSchema.safeParse(rawOrder);

    if (!result.success) {
      const issues = result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join(" | ");
      return [null, `Error de validación AI: ${issues}`, usage];
    }

    return [result.data, "OK", usage];
  } catch (e) {
    return [null, `JSON parse error: ${String(e).slice(0, 80)} | Respuesta: ${clean.slice(0, 200)}`, usage];
  }
}

// ── DB helpers ───────────────────────────────────────────────────────────────

function insertSapOrder(
  db: ReturnType<typeof getDb>,
  order: SapB1Order,
  carpeta: string,
  clienteNombre: string
): void {
  const now = new Date().toISOString();
  const nit = order.CardCode.replace(/^CN/, "");
  const fechaP = yyyymmddToIso(order.DocDate);
  const fechaG = yyyymmddToIso(order.DocDueDate);

  db.prepare(`
    INSERT OR REPLACE INTO pedidos_maestro
      (nit_cliente, orden_compra, fecha_solicitado, fecha_entrega_general,
       cliente_nombre, subtotal, notas, estado, ts_parsed, fase_actual, carpeta_origen)
    VALUES (?, ?, ?, ?, ?, 0, ?, 'PARSED', ?, 1, ?)
  `).run(nit, order.NumAtCard, fechaP, fechaG, clienteNombre, `TaxDate:${order.TaxDate}`, now, carpeta);

  db.prepare("DELETE FROM pedidos_detalle WHERE orden_compra = ?").run(order.NumAtCard);

  const ins = db.prepare(`
    INSERT INTO pedidos_detalle
      (orden_compra, codigo_producto, descripcion, cantidad, precio_unitario, subtotal_item, fecha_entrega)
    VALUES (?, ?, '', ?, ?, ?, ?)
  `);
  for (const line of order.DocumentLines) {
    const precio = line.UnitPrice ?? 0;
    const subtotal = precio * line.Quantity;
    const fechaLinea = line.DeliveryDate ? yyyymmddToIso(line.DeliveryDate) : fechaG;
    ins.run(order.NumAtCard, line.SupplierCatNum, line.Quantity, precio, subtotal, fechaLinea);
  }
}

// ── Identificación Tamaprint ──────────────────────────────────────────────────
// Cualquier variante del NIT o nombre que aparezca en un PDF dirigido a nosotros.
const TAMAPRINT_KEYWORDS = [
  "tamaprint",
  "tama print",
  "900851655",   // NIT sin dígito de verificación
  "9008516551",  // NIT con dígito de verificación
  "900.851.655", // NIT con puntos
];

function esDirigidoATamaprint(pdfText: string): boolean {
  const lower = pdfText.toLowerCase();
  return TAMAPRINT_KEYWORDS.some(kw => lower.includes(kw));
}

async function notificarPDFNoTamaprint(
  cliente: string,
  carpeta: string,
  pdfNombre: string,
): Promise<void> {
  const fecha = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });
  await sendAlertEmail(
    `[OrderLoader] ⚠ PDF no dirigido a Tamaprint — ${cliente}/${carpeta}`,
    `<html><body style="font-family:Arial,sans-serif;font-size:13px">
      <h3 style="color:#856404;background:#fff3cd;padding:10px;border-radius:4px">
        ⚠ PDF recibido no está dirigido a Tamaprint
      </h3>
      <table style="border-collapse:collapse">
        <tr><td style="padding:4px 12px 4px 0"><b>Cliente:</b></td><td>${cliente}</td></tr>
        <tr><td style="padding:4px 12px 4px 0"><b>Carpeta:</b></td><td>${carpeta}</td></tr>
        <tr><td style="padding:4px 12px 4px 0"><b>Archivo:</b></td><td>${pdfNombre}</td></tr>
        <tr><td style="padding:4px 12px 4px 0"><b>Fecha:</b></td><td>${fecha}</td></tr>
      </table>
      <p style="margin-top:16px">
        El PDF fue recibido pero <b>no contiene el NIT ni el nombre de Tamaprint</b> como proveedor.<br>
        Verificar manualmente si corresponde a otro proveedor.
      </p>
      <p style="color:#888;font-size:11px;margin-top:16px">Generado automáticamente por OrderLoader Pipeline</p>
    </body></html>`,
  );
}

// ── Clientes soportados ───────────────────────────────────────────────────────

const CLIENTES: Array<{ carpeta: string; nombre: string; prompt: string }> = [
  { carpeta: "Comodin", nombre: "COMODIN", prompt: PROMPT_COMODIN },
  { carpeta: "Exito",   nombre: "EXITO",   prompt: PROMPT_EXITO   },
  { carpeta: "Hermeco", nombre: "HERMECO", prompt: PROMPT_HERMECO },
];

// Todas las carpetas a escanear (incluye "Otros" para PDFs mal clasificados en step0)
const CARPETAS_A_ESCANEAR = [...CLIENTES.map(c => c.carpeta), "Otros"];

// ── Detección de cliente desde el PDF (fuente de verdad) ─────────────────────
// Los NITs son la señal más confiable: aparecen en toda OC como identificador del comprador.
// Se normalizan quitando puntos para matchear "800.069.933" y "800069933" por igual.

const CLIENT_NITS: Array<{ carpeta: string; nits: string[] }> = [
  { carpeta: "Comodin", nits: ["800069933"] },
  { carpeta: "Hermeco", nits: ["890924167"] },
  { carpeta: "Exito",   nits: ["890900608"] },
];

// Keywords de texto como fallback (evitar falsos positivos — se usan solo si no hay NIT)
const CLIENT_TEXT_KEYWORDS: Array<{ carpeta: string; keywords: string[] }> = [
  { carpeta: "Comodin", keywords: ["gco", "comodin", "americanino", "gco.com.co"] },
  { carpeta: "Hermeco", keywords: ["hermeco", "offcorss", "offcorss.com"] },
  { carpeta: "Exito",   keywords: ["grupoexito", "grupo-exito", "grupo exito", "grupo éxito"] },
];

function detectClientFromPdf(pdfText: string): string | null {
  // Paso 1: buscar NIT (se quitan puntos para normalizar formato colombiano)
  const normalized = pdfText.replace(/\./g, "");
  for (const { carpeta, nits } of CLIENT_NITS) {
    if (nits.some(nit => normalized.includes(nit))) return carpeta;
  }

  // Paso 2: keywords de marca como fallback
  const lower = pdfText.toLowerCase();
  for (const { carpeta, keywords } of CLIENT_TEXT_KEYWORDS) {
    if (keywords.some(kw => lower.includes(kw))) return carpeta;
  }

  return null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function run(): Promise<StepResult> {
  const config = getConfig();
  const result: StepResult = { procesados: 0, errores: 0, saltados: 0, detalles: [] };

  if (!fs.existsSync(config.pedidosRawDir)) {
    result.detalles.push("No existe pedidos/raw. Ejecuta step0 primero.");
    return result;
  }

  const db = getDb();
  const ESTADOS_AVANZADOS = new Set([
    "PARSE_VALIDO", "SAP_NUEVO", "SAP_MONTADO",
    "VALIDADO", "ERROR_VALIDACION",
    "NOTIFICADO", "CERRADO",
    "ERROR_DUPLICADO", "ERROR_ITEMS", "ERROR_SAP",
  ]);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParseFn = require("pdf-parse/lib/pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;

  for (const carpeta of CARPETAS_A_ESCANEAR) {
    const clienteDir = path.join(config.pedidosRawDir, carpeta);
    if (!fs.existsSync(clienteDir)) continue;

    for (const carpetaNombre of fs.readdirSync(clienteDir).sort()) {
      const carpetaPath = path.join(clienteDir, carpetaNombre);
      if (!fs.statSync(carpetaPath).isDirectory()) continue;

      // Solo carpetas de correo (tienen EML). Los sub-folders de OC no lo tienen.
      if (!fs.existsSync(path.join(carpetaPath, "correo_original.eml"))) continue;

      const pdfs = fs.readdirSync(carpetaPath).filter(f => f.toLowerCase().endsWith(".pdf"));
      if (!pdfs.length) continue;

      // Procesar TODOS los PDFs del correo — cada uno puede ser una OC distinta
      for (const pdfFile of pdfs) {
        const skipMarker = path.join(carpetaPath, `${pdfFile}.skip`);
        const doneMarker = path.join(carpetaPath, `${pdfFile}.done`);

        // Idempotencia por PDF: ya fue procesado o descartado explícitamente
        if (fs.existsSync(skipMarker) || fs.existsSync(doneMarker)) {
          result.saltados++;
          continue;
        }

        const retriesPath = path.join(carpetaPath, `${pdfFile}.retries`);
        const errorPath   = path.join(carpetaPath, `${pdfFile}.error`);

        if (fs.existsSync(errorPath)) {
          result.saltados++;
          result.detalles.push(`⚠ ${pdfFile}: omitido (max reintentos AI alcanzados)`);
          continue;
        }

        result.detalles.push(`Procesando: ${carpeta}/${carpetaNombre}/${pdfFile}`);

        try {
          const buffer = fs.readFileSync(path.join(carpetaPath, pdfFile));
          const parsed = await pdfParseFn(buffer);

          // PDF no dirigido a Tamaprint → silencio + marker de skip + alerta
          if (!esDirigidoATamaprint(parsed.text)) {
            result.saltados++;
            result.detalles.push(`  → No dirigido a Tamaprint — omitido`);
            logPipeline(db, carpetaNombre, 1, "parse", "OK", `${pdfFile}: no es pedido Tamaprint`);
            fs.writeFileSync(skipMarker, "");
            await notificarPDFNoTamaprint(carpeta, carpetaNombre, pdfFile).catch(() => {});
            continue;
          }

          // ── Detectar cliente desde el PDF (fuente de verdad) ──────────────
          const detectedCarpeta = detectClientFromPdf(parsed.text);
          const clienteInfo = CLIENTES.find(c => c.carpeta === detectedCarpeta);

          if (!clienteInfo) {
            result.saltados++;
            result.detalles.push(`  ⚠ No se identificó cliente en el PDF — omitido (carpeta email: ${carpeta})`);
            logPipeline(db, carpetaNombre, 1, "parse", "WARN", `${pdfFile}: cliente no detectado en PDF`);
            fs.writeFileSync(skipMarker, "no-client-detected");
            await sendAlertEmail(
              `[OrderLoader] ⚠ Cliente no identificado en PDF — ${carpeta}/${carpetaNombre}`,
              `<html><body style="font-family:Arial,sans-serif;font-size:13px">
                <h3 style="color:#856404;background:#fff3cd;padding:10px;border-radius:4px">
                  ⚠ No se pudo identificar el cliente desde el PDF
                </h3>
                <p>El PDF <b>${pdfFile}</b> está dirigido a Tamaprint pero no contiene
                el NIT ni keywords de ningún cliente registrado.</p>
                <p><b>Carpeta:</b> ${carpeta}/${carpetaNombre}</p>
                <p>Verificar manualmente si corresponde a un cliente nuevo.</p>
              </body></html>`
            ).catch(() => {});
            continue;
          }

          if (detectedCarpeta !== carpeta) {
            result.detalles.push(`  ⚠ Mismatch: correo en carpeta "${carpeta}", PDF identifica cliente "${detectedCarpeta}" — usando prompt correcto`);
            logPipeline(db, carpetaNombre, 1, "parse", "WARN", `${pdfFile}: carpeta=${carpeta} pdf_cliente=${detectedCarpeta}`);
          }

          const [order, status, usage] = await parseWithAI(parsed.text, clienteInfo.prompt);

          if (!order) {
            result.errores++;
            result.detalles.push(`  ✗ ${status}`);
            logPipeline(db, carpetaNombre, 1, "parse", "ERROR", `AI parse fallido: ${status}`, usage.input, usage.output);
            const retries = fs.existsSync(retriesPath)
              ? parseInt(fs.readFileSync(retriesPath, "utf8") || "0") + 1 : 1;
            if (retries >= 3) {
              fs.writeFileSync(errorPath, status);
              fs.rmSync(retriesPath, { force: true });
              await sendAlertEmail(
                `[ERROR OrderLoader] PDF ${pdfFile} — fallo de parseo repetido`,
                `<p>El archivo <b>${pdfFile}</b> falló ${retries} veces. Último error:</p><pre>${status}</pre>`
              ).catch(() => {});
            } else {
              fs.writeFileSync(retriesPath, String(retries));
            }
            continue;
          }

          // DocDate siempre es la fecha de hoy — no depender del AI
          const hoy = new Date();
          order.DocDate = `${hoy.getFullYear()}${String(hoy.getMonth()+1).padStart(2,"0")}${String(hoy.getDate()).padStart(2,"0")}`;

          const existente = db.prepare(
            "SELECT estado FROM pedidos_maestro WHERE orden_compra = ?"
          ).get(order.NumAtCard) as { estado: string } | undefined;

          if (existente && ESTADOS_AVANZADOS.has(existente.estado)) {
            result.saltados++;
            result.detalles.push(`  [skip] OC ${order.NumAtCard} ya en ${existente.estado}`);
            fs.writeFileSync(doneMarker, order.NumAtCard);
            continue;
          }

          // Sub-folder por OC: carpeta_origen independiente para cada pedido del correo
          const ocFolder = path.join(carpetaPath, order.NumAtCard);
          fs.mkdirSync(ocFolder, { recursive: true });

          // Copiar correo_metadata.json al sub-folder (step7 lo necesita para IMAP)
          const metaSrc = path.join(carpetaPath, "correo_metadata.json");
          if (fs.existsSync(metaSrc)) {
            fs.copyFileSync(metaSrc, path.join(ocFolder, "correo_metadata.json"));
          }

          const tx = db.transaction(() => {
            insertSapOrder(db, order, ocFolder, clienteInfo.nombre); // carpeta_origen = sub-folder de la OC
            logPipeline(db, order.NumAtCard, 1, "parse", "OK", `PDF: ${pdfFile}`, usage.input, usage.output);
          });
          tx();

          fs.writeFileSync(
            path.join(ocFolder, "data_extraida.json"),
            JSON.stringify({ ...order, pdf: pdfFile, ts: new Date().toISOString() }, null, 2)
          );

          // Marker de éxito en la carpeta del correo (referencia la OC)
          fs.writeFileSync(doneMarker, order.NumAtCard);
          fs.rmSync(retriesPath, { force: true });

          result.procesados++;
          result.detalles.push(`  ✓ OC ${order.NumAtCard} → PARSED (${order.DocumentLines.length} items)`);
        } catch (e) {
          result.errores++;
          result.detalles.push(`  ✗ Error en ${pdfFile}: ${String(e)}`);
          const retries = fs.existsSync(retriesPath)
            ? parseInt(fs.readFileSync(retriesPath, "utf8") || "0") + 1 : 1;
          if (retries >= 3) {
            fs.writeFileSync(errorPath, String(e));
            fs.rmSync(retriesPath, { force: true });
            await sendAlertEmail(
              `[ERROR OrderLoader] PDF ${pdfFile} — fallo repetido`,
              `<p>El archivo <b>${pdfFile}</b> falló ${retries} veces. Último error:</p><pre>${String(e)}</pre>`
            ).catch(() => {});
          } else {
            fs.writeFileSync(retriesPath, String(retries));
          }
        }
      }
    }
  }

  return result;
}
