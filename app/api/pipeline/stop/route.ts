import { requestPipelineStop, isPipelineRunning } from "@/lib/pipeline";

export async function POST() {
  if (!isPipelineRunning()) {
    return new Response(JSON.stringify({ ok: false, message: "No hay pipeline en ejecución" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  requestPipelineStop();
  return new Response(JSON.stringify({ ok: true, message: "Detención solicitada" }), {
    headers: { "Content-Type": "application/json" },
  });
}
