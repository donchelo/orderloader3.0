/**
 * Triage IA de adjuntos: clasifica cada archivo de un email antes de que el
 * pipeline decida si es una OC aprobada o un "archivo extra".
 *
 * Una sola llamada a Claude por email (todos los adjuntos en batch).
 * Modelo: claude-haiku-4-5-20251001 (rápido y barato para clasificación).
 *
 * Fallback: si la API falla, devuelve null y step0 usa las heurísticas originales.
 */

import Anthropic from "@anthropic-ai/sdk";
import { CLIENT_NITS } from "./pdf-classify";
import { withAnthropicRetry } from "./anthropic-retry";

export type AttachmentTipo = 'orden_compra' | 'firma_logo' | 'documento_relevante' | 'desconocido';

export type ClientNitList = Array<{ carpeta: string; nits: string[]; nombre?: string }>;

export interface AttachmentForTriage {
  filename: string;
  tipoArchivo: 'pdf' | 'imagen' | 'otro';
  // PDFs:
  textoCabecera?: string;
  textoPie?: string;
  deteccionInicial?: { carpeta: string; metodo: 'nit' | 'keyword' } | null;
  // Imágenes (vision):
  base64?: string;
  mimeType?: string;
}

export interface TriageResult {
  filename: string;
  tipo: AttachmentTipo;
  cliente: string | null;
  razon: string;
}

function buildSystemPrompt(clientNits: ClientNitList, companyName: string): string {
  return `Eres un agente de triage para ${companyName}, empresa colombiana de impresión.
Tu tarea: clasificar cada adjunto de un correo de pedidos.

CLIENTES APROBADOS (NIT | nombre | carpeta):
${clientNits.map(c => `  ${c.nits[0]} | ${c.nombre ?? c.carpeta} | ${c.carpeta}`).join('\n')}

TIPOS DE CLASIFICACIÓN:
- "orden_compra": orden de compra dirigida a ${companyName}, de un cliente aprobado
- "firma_logo": firma de email, logo corporativo, imagen decorativa — NO es un documento
- "documento_relevante": documento real que NO es una OC (cotización, especificación, nota)
- "desconocido": no se puede determinar

REGLAS:
1. El NIT del emisor en el documento es la señal más confiable de identidad del cliente.
2. Si el PDF no tiene texto (escaneado), usa el asunto del correo y el nombre del archivo como señales.
3. El campo "cliente" debe ser el valor de la columna "carpeta" del cliente identificado (ej: "BysproPO"), o null.
4. Imágenes pequeñas (logos, firmas) son "firma_logo". Imágenes de documentos escaneados son "documento_relevante".
5. Si hay duda, usar "desconocido".

Responde SOLO con JSON array (sin explicaciones, sin markdown):
[{"filename":"...","tipo":"...","cliente":"Carpeta o null","razon":"una línea breve"}]`;
}

export const TRIAGE_MODEL = 'claude-haiku-4-5-20251001';

export interface TriageResponse {
  results: TriageResult[];
  inputTokens: number;
  outputTokens: number;
}

export async function triageEmailAttachments(
  attachments: AttachmentForTriage[],
  clientNits: ClientNitList = CLIENT_NITS,
  emailSubject?: string,
  companyName = "Tamaprint",
): Promise<TriageResponse | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (attachments.length === 0) return { results: [], inputTokens: 0, outputTokens: 0 };

  const client = new Anthropic({ apiKey });

  // Construir el contenido del mensaje (puede mezclar texto e imágenes)
  const contentBlocks: Anthropic.MessageParam['content'] = [];

  let attachmentDescriptions = '';
  const imageBlocks: Array<{ index: number; block: Anthropic.ImageBlockParam }> = [];

  attachments.forEach((att, i) => {
    const num = i + 1;

    if (att.tipoArchivo === 'pdf') {
      const metodoPrev = att.deteccionInicial
        ? `${att.deteccionInicial.carpeta} (${att.deteccionInicial.metodo === 'nit' ? 'NIT confirmado' : 'solo keyword'})`
        : 'ninguno';
      attachmentDescriptions += `\n[${num}] PDF: ${att.filename}\n`;
      attachmentDescriptions += `  Detección previa: ${metodoPrev}\n`;
      if (att.textoCabecera) {
        attachmentDescriptions += `  Cabecera del documento:\n---\n${att.textoCabecera}\n---\n`;
      }
      if (att.textoPie) {
        attachmentDescriptions += `  Pie del documento:\n---\n${att.textoPie}\n---\n`;
      }
    } else if (att.tipoArchivo === 'imagen' && att.base64 && att.mimeType) {
      attachmentDescriptions += `\n[${num}] Imagen: ${att.filename}\n`;
      attachmentDescriptions += `  (imagen adjunta a continuación)\n`;
      imageBlocks.push({
        index: num,
        block: {
          type: 'image',
          source: {
            type: 'base64',
            media_type: att.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
            data: att.base64,
          },
        },
      });
    } else {
      attachmentDescriptions += `\n[${num}] Otro: ${att.filename} (extensión no PDF ni imagen)\n`;
    }
  });

  // Si hay imágenes, intercalar texto e imágenes en el contenido
  if (imageBlocks.length > 0) {
    // Dividir la descripción por bloques de imagen
    let currentText = `${emailSubject ? `Asunto del correo: "${emailSubject}"\n\n` : ''}Adjuntos del correo a clasificar:\n`;
    const lines = attachmentDescriptions.split('\n');

    for (const line of lines) {
      const match = line.match(/^\[(\d+)\] Imagen:/);
      if (match) {
        const idx = parseInt(match[1]);
        if (currentText.trim()) {
          contentBlocks.push({ type: 'text', text: currentText });
          currentText = '';
        }
        const imgBlock = imageBlocks.find(b => b.index === idx);
        if (imgBlock) {
          contentBlocks.push(imgBlock.block);
        }
        currentText += line + '\n';
      } else {
        currentText += line + '\n';
      }
    }
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }
  } else {
    contentBlocks.push({
      type: 'text',
      text: `${emailSubject ? `Asunto del correo: "${emailSubject}"\n\n` : ''}Adjuntos del correo a clasificar:\n${attachmentDescriptions}`,
    });
  }

  try {
    const msg = await withAnthropicRetry(() => client.messages.create({
      model: TRIAGE_MODEL,
      max_tokens: 1024,
      temperature: 0,
      system: buildSystemPrompt(clientNits, companyName),
      messages: [{ role: 'user', content: contentBlocks }],
    }));

    const inputTokens = msg.usage?.input_tokens ?? 0;
    const outputTokens = msg.usage?.output_tokens ?? 0;

    const raw = msg.content[0].type === 'text' ? msg.content[0].text.trim() : '';
    const clean = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();

    const parsed = JSON.parse(clean);
    if (!Array.isArray(parsed)) return null;

    const results: TriageResult[] = parsed.map((item: Record<string, unknown>) => ({
      filename: String(item.filename ?? ''),
      tipo: (item.tipo as AttachmentTipo) ?? 'desconocido',
      cliente: item.cliente ? String(item.cliente) : null,
      razon: String(item.razon ?? ''),
    }));

    return { results, inputTokens, outputTokens };
  } catch {
    return null;
  }
}

/** Prepara un buffer de imagen para enviarlo a la vision API. */
export function prepareImageForTriage(content: Buffer, filename: string): Pick<AttachmentForTriage, 'base64' | 'mimeType'> {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  const mimeMap: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
  };
  return {
    base64: content.toString('base64'),
    mimeType: mimeMap[ext] ?? 'image/png',
  };
}
