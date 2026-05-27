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
import { OrderStatus } from "../constants";
import { sendAlertEmail } from "../mailer";
import { SapB1OrderSchema, type SapB1Order } from "../schemas";
export type { SapB1Order };
import { detectClientFromPdf, esDirigidoAEmpresa, loadClientListsFromDb, CLIENT_NITS, CLIENT_TEXT_KEYWORDS } from "../pdf-classify";
import { getClientes } from "../db";
import { pdfToImages, buildVisionContent } from "../pdf-vision";
import { withAnthropicRetry } from "../anthropic-retry";

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

function todayYYYYMMDD(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

// ── AI Parser ─────────────────────────────────────────────────────────────────

async function parseWithAI(pdfBuffer: Buffer, prompt: string): Promise<[SapB1Order | null, string, { input?: number, output?: number }]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [null, "ANTHROPIC_API_KEY no configurado en .env", {}];

  const client = new Anthropic({ apiKey });

  // Convertir PDF a imágenes para que Claude vea la tabla visualmente,
  // evitando que pdf-parse fusione columnas adyacentes (ej. ítem + código).
  const { pages } = await pdfToImages(pdfBuffer);
  const visionContent = buildVisionContent(pages);

  const msg = await withAnthropicRetry(() => client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    temperature: 0,
    system: prompt,
    messages: [{ role: "user", content: visionContent }],
  }));

  const text = msg.content[0].type === "text" ? msg.content[0].text.trim() : "";
  const usage = { input: msg.usage?.input_tokens, output: msg.usage?.output_tokens };
  if (!text) return [null, "Respuesta vacía del modelo", usage];

  const clean = text.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();

  try {
    const rawOrder = JSON.parse(clean);

    // Fechas por defecto si el AI no pudo leerlas del PDF
    const isValidYYYYMMDD = (v: unknown) => typeof v === "string" && /^\d{8}$/.test(v);
    const thisYear = new Date().getFullYear();
    // TaxDate debe ser del año actual (período abierto en SAP); si el AI leyó una fecha antigua, usar hoy
    const isRecentYear = (v: unknown) => isValidYYYYMMDD(v) && parseInt(String(v).slice(0, 4)) >= thisYear;
    if (!isRecentYear(rawOrder.TaxDate))    rawOrder.TaxDate    = todayYYYYMMDD();
    if (!isValidYYYYMMDD(rawOrder.DocDueDate)) rawOrder.DocDueDate = todayYYYYMMDD(15);

    // Normalizar DeliveryDate en líneas: el AI a veces devuelve YYYY-MM-DD u otros formatos
    if (Array.isArray(rawOrder.DocumentLines)) {
      for (const line of rawOrder.DocumentLines) {
        if (!isValidYYYYMMDD(line.DeliveryDate)) {
          // Intentar convertir YYYY-MM-DD → YYYYMMDD
          if (typeof line.DeliveryDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(line.DeliveryDate)) {
            line.DeliveryDate = line.DeliveryDate.replace(/-/g, "");
          } else {
            line.DeliveryDate = rawOrder.DocDueDate;
          }
        }
      }
    }

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
  const prefix = getConfig().cardCodePrefix;
  const nit = order.CardCode.startsWith(prefix) ? order.CardCode.slice(prefix.length) : order.CardCode;
  const fechaP = yyyymmddToIso(order.DocDate);
  const fechaG = yyyymmddToIso(order.DocDueDate);

  // Calcular subtotal antes de insertar para poder escribir maestro primero (FK requiere maestro antes que detalle)
  let subtotalTotal = 0;
  const lineas = order.DocumentLines.map(line => {
    const precio = line.UnitPrice ?? 0;
    const subtotalLinea = precio * line.Quantity;
    subtotalTotal += subtotalLinea;
    return {
      oc: order.NumAtCard,
      sku: line.SupplierCatNum,
      desc: line.FreeText ?? "",
      qty: line.Quantity,
      precio,
      subtotalLinea,
      fechaLinea: line.DeliveryDate ? yyyymmddToIso(line.DeliveryDate) : fechaG,
    };
  });

  db.prepare(`
    INSERT OR REPLACE INTO pedidos_maestro
      (nit_cliente, orden_compra, fecha_solicitado, fecha_entrega_general,
       cliente_nombre, subtotal, notas, estado, ts_parsed, fase_actual, carpeta_origen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(nit, order.NumAtCard, fechaP, fechaG, clienteNombre, subtotalTotal, `TaxDate:${order.TaxDate}`, OrderStatus.PARSED, now, carpeta);

  db.prepare("DELETE FROM pedidos_detalle WHERE orden_compra = ?").run(order.NumAtCard);

  const ins = db.prepare(`
    INSERT INTO pedidos_detalle
      (orden_compra, codigo_producto, descripcion, cantidad, precio_unitario, subtotal_item, fecha_entrega)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const l of lineas) {
    ins.run(l.oc, l.sku, l.desc, l.qty, l.precio, l.subtotalLinea, l.fechaLinea);
  }
}

// esDirigidoAEmpresa y detectClientFromPdf importados desde lib/pdf-classify.ts

async function notificarPDFNoEmpresa(
  cliente: string,
  carpeta: string,
  pdfNombre: string,
): Promise<void> {
  const empresa = getConfig().tenantDisplayName;
  const fecha = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });
  await sendAlertEmail(
    `[OrderLoader] ⚠ PDF no dirigido a ${empresa} — ${cliente}/${carpeta}`,
    `<html><body style="font-family:Arial,sans-serif;font-size:13px">
      <h3 style="color:#856404;background:#fff3cd;padding:10px;border-radius:4px">
        ⚠ PDF recibido no está dirigido a ${empresa}
      </h3>
      <table style="border-collapse:collapse">
        <tr><td style="padding:4px 12px 4px 0"><b>Cliente:</b></td><td>${cliente}</td></tr>
        <tr><td style="padding:4px 12px 4px 0"><b>Carpeta:</b></td><td>${carpeta}</td></tr>
        <tr><td style="padding:4px 12px 4px 0"><b>Archivo:</b></td><td>${pdfNombre}</td></tr>
        <tr><td style="padding:4px 12px 4px 0"><b>Fecha:</b></td><td>${fecha}</td></tr>
      </table>
      <p style="margin-top:16px">
        El PDF fue recibido pero <b>no contiene el NIT ni el nombre de ${empresa}</b> como proveedor.<br>
        Verificar manualmente si corresponde a otro proveedor.
      </p>
      <p style="color:#888;font-size:11px;margin-top:16px">Generado automáticamente por OrderLoader Pipeline</p>
    </body></html>`,
  );
}

// CLIENT_NITS, CLIENT_TEXT_KEYWORDS, detectClientFromPdf importados desde lib/pdf-classify.ts

// CLIENT_NITS, CLIENT_TEXT_KEYWORDS, detectClientFromPdf importados desde lib/pdf-classify.ts

// ── Main ─────────────────────────────────────────────────────────────────────

export async function run(): Promise<StepResult> {
  const config = getConfig();
  const result: StepResult = { procesados: 0, errores: 0, saltados: 0, detalles: [] };

  if (!fs.existsSync(config.pedidosRawDir)) {
    result.detalles.push("No existe pedidos/raw. Ejecuta step0 primero.");
    return result;
  }

  const db = getDb();

  // Cargar clientes y prompts desde DB; fallback a hardcoded si tabla vacía
  let clientesDb: Array<{ carpeta: string; nombre: string; prompt: string }> = [];
  let clientNits = CLIENT_NITS;
  let clientKeywords = CLIENT_TEXT_KEYWORDS;
  try {
    const rows = getClientes(db);
    if (rows.length > 0) {
      clientesDb = rows.filter(r => r.activo === 1).map(r => ({
        carpeta: r.carpeta,
        nombre:  r.nombre,
        prompt:  r.prompt,
      }));
      const lists = loadClientListsFromDb(db);
      clientNits     = lists.nits;
      clientKeywords = lists.keywords;
    }
  } catch { /* DB podría no tener tabla aún */ }

  const CLIENTES = clientesDb.length > 0 ? clientesDb : [];
  const CARPETAS_A_ESCANEAR = [...CLIENTES.map(c => c.carpeta), "Otros"];

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
          fs.writeFileSync(doneMarker, "error");  // siguiente corrida usa el check silencioso de línea 260
          continue;
        }

        result.detalles.push(`Procesando: ${carpeta}/${carpetaNombre}/${pdfFile}`);

        try {
          const buffer = fs.readFileSync(path.join(carpetaPath, pdfFile));
          const parsed = await pdfParseFn(buffer);
          const pdfText = parsed.text ?? '';
          const textIsEmpty = pdfText.trim().length < 50;

          // PDF no dirigido a la empresa receptora → alerta solo si hay texto extraíble.
          // Si el texto está vacío (PDF con fuentes vectoriales), confiar en la
          // carpeta asignada por step0 que ya validó el correo.
          if (!textIsEmpty && !esDirigidoAEmpresa(pdfText, config.receptorKeywords)) {
            result.saltados++;
            result.detalles.push(`  → No dirigido a ${config.tenant} — omitido`);
            logPipeline(db, carpetaNombre, 1, "parse", "OK", `${pdfFile}: no dirigido a ${config.tenant}`);
            fs.writeFileSync(skipMarker, "");
            await notificarPDFNoEmpresa(carpeta, carpetaNombre, pdfFile).catch(() => {});
            continue;
          }

          // ── Detectar cliente desde el PDF; si texto vacío usar carpeta del correo ──
          const detectedCarpeta = !textIsEmpty
            ? detectClientFromPdf(pdfText, clientNits, clientKeywords)?.carpeta ?? null
            : carpeta;
          const clienteInfo = CLIENTES.find(c => c.carpeta === (detectedCarpeta ?? carpeta));

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
                <p>El PDF <b>${pdfFile}</b> está dirigido a ${config.tenantDisplayName} pero no contiene
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

          const [order, status, usage] = await parseWithAI(buffer, clienteInfo.prompt);

          if (!order) {
            result.errores++;
            result.detalles.push(`  ✗ ${status}`);
            logPipeline(db, carpetaNombre, 1, "parse", "ERROR", `AI parse fallido: ${status}`, usage.input, usage.output, "claude-sonnet-4-6");
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

          // Sub-folder por OC: carpeta_origen independiente para cada pedido del correo
          const ocFolder = path.join(carpetaPath, order.NumAtCard);
          fs.mkdirSync(ocFolder, { recursive: true });

          // Copiar correo_metadata.json al sub-folder (step7 lo necesita para IMAP)
          const metaSrc = path.join(carpetaPath, "correo_metadata.json");
          if (fs.existsSync(metaSrc)) {
            fs.copyFileSync(metaSrc, path.join(ocFolder, "correo_metadata.json"));
          }

          const costoIaUsd = ((usage.input ?? 0) / 1e6) * 3.0 + ((usage.output ?? 0) / 1e6) * 15.0;

          const tx = db.transaction(() => {
            insertSapOrder(db, order, ocFolder, clienteInfo.nombre);
            db.prepare(`UPDATE pedidos_maestro SET costo_ia_usd=? WHERE orden_compra=?`)
              .run(costoIaUsd, order.NumAtCard);
            logPipeline(db, order.NumAtCard, 1, "parse", "OK", `PDF: ${pdfFile}`, usage.input, usage.output, "claude-sonnet-4-6");
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
