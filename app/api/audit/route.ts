import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const limit  = Math.min(parseInt(searchParams.get("limit")  ?? "100"), 500);
    const offset = parseInt(searchParams.get("offset") ?? "0");
    const oc     = searchParams.get("oc"); // filtrar por orden de compra

    const db = getDb();

    const logQuery = oc
      ? `SELECT * FROM pipeline_log WHERE orden_compra = ? ORDER BY ts DESC LIMIT ? OFFSET ?`
      : `SELECT * FROM pipeline_log ORDER BY ts DESC LIMIT ? OFFSET ?`;
    const logRows = oc
      ? db.prepare(logQuery).all(oc, limit, offset)
      : db.prepare(logQuery).all(limit, offset);

    const triggers = db.prepare(
      `SELECT * FROM pipeline_triggers ORDER BY ts DESC LIMIT 50`
    ).all();

    const summary = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN estado_resultado = 'OK'    THEN 1 ELSE 0 END) as ok,
        SUM(CASE WHEN estado_resultado = 'ERROR' THEN 1 ELSE 0 END) as errores,
        SUM(CASE WHEN estado_resultado = 'WARN'  THEN 1 ELSE 0 END) as warnings,
        SUM(COALESCE(input_tokens, 0))  as total_input_tokens,
        SUM(COALESCE(output_tokens, 0)) as total_output_tokens
      FROM pipeline_log
    `).get();

    return NextResponse.json({ ok: true, log: logRows, triggers, summary });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
