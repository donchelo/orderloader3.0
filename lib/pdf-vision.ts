/**
 * Convierte un buffer PDF a un array de imágenes PNG usando pdftoppm (poppler-utils).
 * Cada página del PDF se convierte en un Buffer PNG independiente.
 *
 * Ventaja sobre extracción de texto: Claude ve la tabla visualmente, evitando
 * que columnas adyacentes se fusionen (ej. número de ítem + código de material).
 *
 * Requiere: apk add poppler-utils  (incluido en el Dockerfile del runner stage)
 */

import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";
import path from "path";
import fs from "fs";

const execFileAsync = promisify(execFile);

export interface PdfVisionResult {
  pages: Buffer[];   // Un Buffer PNG por página
  pageCount: number;
}

/**
 * Convierte cada página del PDF en un PNG.
 * @param pdfBuffer  Contenido del PDF como Buffer
 * @param dpi        Resolución de renderizado (150 es suficiente para Claude Vision)
 */
export async function pdfToImages(pdfBuffer: Buffer, dpi = 150): Promise<PdfVisionResult> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdftoppm-"));
  const tmpPdf = path.join(tmpDir, "input.pdf");
  const outPrefix = path.join(tmpDir, "pg");

  try {
    fs.writeFileSync(tmpPdf, pdfBuffer);

    await execFileAsync("pdftoppm", [
      "-r", String(dpi),
      "-png",
      tmpPdf,
      outPrefix,
    ]);

    const pages = fs.readdirSync(tmpDir)
      .filter(f => f.endsWith(".png"))
      .sort()
      .map(f => fs.readFileSync(path.join(tmpDir, f)));

    return { pages, pageCount: pages.length };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Construye el array de bloques de imagen para la API de Anthropic. */
export function buildVisionContent(pages: Buffer[]): Array<{
  type: "image";
  source: { type: "base64"; media_type: "image/png"; data: string };
}> {
  return pages.map(page => ({
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: "image/png" as const,
      data: page.toString("base64"),
    },
  }));
}
