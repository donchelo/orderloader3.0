/**
 * Step 3: Verificar existencia de artículos en el catálogo de SAP B1.
 *
 * Consulta AlternateCatNum para cada SupplierCatNum del pedido.
 * Artículos que no existen en el catálogo se excluyen del pedido y se
 * guardan en items_excluidos para que step4 los omita al subir.
 * Si ningún artículo existe → ERROR_CATALOG (no se puede subir nada).
 *
 * PARSE_VALIDO → CATALOG_OK | ERROR_CATALOG
 */

import fs from "fs";
import path from "path";
import { getDb, logPipeline } from "../db";
import { getActiveSap, clearActiveSap } from "../sap-gateway";
import type { SapGateway } from "../sap-gateway";
import type { SapB1Order } from "./step1-parse";
import { OrderStatus } from "../constants";

export interface StepResult {
  procesados: number;
  errores: number;
  saltados: number;
  detalles: string[];
}

/** Consulta AlternateCatNum y mapea SupplierCatNum → ItemCode de SAP. */
async function fetchCatNumMappings(
  sap: SapGateway,
  cardCode: string,
  catNums: string[]
): Promise<Map<string, string>> {
  const mapping = new Map<string, string>();
  await Promise.all(
    catNums.map(async (catNum) => {
      try {
        const escapedCard = cardCode.replace(/'/g, "''");
        const escapedCat  = catNum.replace(/'/g, "''");
        const res = await sap.get<{ value: Array<{ ItemCode: string }> }>("AlternateCatNum", {
          "$filter": `CardCode eq '${escapedCard}' and Substitute eq '${escapedCat}'`,
          "$select": "ItemCode",
          "$top": "1",
        });
        if (res.value?.length > 0) {
          mapping.set(catNum, res.value[0].ItemCode);
        }
      } catch {
        // Fallo silencioso: artículo no se agrega al mapa → será excluido
      }
    })
  );
  return mapping;
}

export async function run(): Promise<StepResult> {
  const result: StepResult = { procesados: 0, errores: 0, saltados: 0, detalles: [] };
  const db = getDb();

  const pendientes = db.prepare(
    "SELECT * FROM pedidos_maestro WHERE estado = ?"
  ).all(OrderStatus.PARSE_VALIDO) as Array<Record<string, unknown>>;

  if (!pendientes.length) {
    result.detalles.push("No hay pedidos en estado PARSE_VALIDO");
    return result;
  }

  let sap;
  try {
    sap = await getActiveSap();
  } catch (e) {
    result.detalles.push(`SAP no configurado: ${String(e)}`);
    clearActiveSap();
    return result;
  }

  for (const row of pendientes) {
    const oc = String(row.orden_compra);
    const now = new Date().toISOString();

    // Cargar data_extraida.json
    const carpeta = row.carpeta_origen as string | null;
    const markerPath = carpeta ? path.join(carpeta, "data_extraida.json") : null;
    if (!markerPath || !fs.existsSync(markerPath)) {
      const msg = "data_extraida.json no encontrado en step3";
      db.prepare(`UPDATE pedidos_maestro SET estado='ERROR_CATALOG', error_msg=? WHERE orden_compra=?`).run(msg, oc);
      logPipeline(db, oc, 3, "sap_catalog", "ERROR", msg);
      result.errores++;
      result.detalles.push(`✗ OC ${oc}: ${msg}`);
      continue;
    }

    let aiData: SapB1Order;
    try {
      aiData = JSON.parse(fs.readFileSync(markerPath, "utf8")) as SapB1Order;
    } catch (e) {
      const msg = `data_extraida.json inválido: ${String(e).slice(0, 500)}`;
      db.prepare(`UPDATE pedidos_maestro SET estado='ERROR_CATALOG', error_msg=? WHERE orden_compra=?`).run(msg, oc);
      logPipeline(db, oc, 3, "sap_catalog", "ERROR", msg);
      result.errores++;
      result.detalles.push(`✗ OC ${oc}: ${msg}`);
      continue;
    }

    try {
      const allCatNums = [...new Set(aiData.DocumentLines.map(l => l.SupplierCatNum))];
      const itemMappings = await fetchCatNumMappings(sap, aiData.CardCode, allCatNums);

      const missing = aiData.DocumentLines.filter(l => !itemMappings.has(l.SupplierCatNum));
      const present = aiData.DocumentLines.filter(l =>  itemMappings.has(l.SupplierCatNum));

      for (const m of missing) {
        logPipeline(db, oc, 3, "sap_catalog", "WARN",
          `Artículo ${m.SupplierCatNum} no existe en AlternateCatNum — excluido`);
        result.detalles.push(`  ⚠ OC ${oc}: artículo ${m.SupplierCatNum} no existe en catálogo SAP — excluido`);
      }

      if (present.length === 0) {
        const missingList = missing.map(l => l.SupplierCatNum).join(", ");
        const msg = `Ningún artículo existe en catálogo SAP: ${missingList}`;
        db.prepare(`
          UPDATE pedidos_maestro SET estado='ERROR_CATALOG', error_msg=?, items_excluidos=?, fase_actual=3
          WHERE orden_compra=?
        `).run(msg.slice(0, 1000), JSON.stringify(missing.map(l => l.SupplierCatNum)), oc);
        logPipeline(db, oc, 3, "sap_catalog", "ERROR", msg.slice(0, 1000));
        result.errores++;
        result.detalles.push(`✗ OC ${oc} → ERROR_CATALOG: ${msg}`);
        continue;
      }

      // Algunos o todos los artículos existen → CATALOG_OK
      const excludedNames = missing.map(l => l.SupplierCatNum);
      db.prepare(`
        UPDATE pedidos_maestro SET
          estado='CATALOG_OK', fase_actual=3, ts_sap_query=?,
          items_excluidos=?, error_msg=NULL
        WHERE orden_compra=?
      `).run(
        now,
        excludedNames.length ? JSON.stringify(excludedNames) : null,
        oc
      );

      const excMsg = missing.length ? ` — ${missing.length} artículo(s) excluido(s) del catálogo` : "";
      logPipeline(db, oc, 3, "sap_catalog", "OK",
        `${present.length} artículo(s) en catálogo${excMsg}`);
      result.procesados++;
      result.detalles.push(`✓ OC ${oc} → CATALOG_OK (${present.length}/${allCatNums.length} artículos)${excMsg}`);

    } catch (e) {
      db.prepare(`UPDATE pedidos_maestro SET estado='ERROR_CATALOG', error_msg=? WHERE orden_compra=?`)
        .run(String(e).slice(0, 1000), oc);
      logPipeline(db, oc, 3, "sap_catalog", "ERROR", String(e).slice(0, 1000));
      result.errores++;
      result.detalles.push(`✗ OC ${oc}: ${String(e).slice(0, 500)}`);
    }
  }

  return result;
}
