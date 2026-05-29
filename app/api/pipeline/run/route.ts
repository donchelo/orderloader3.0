import { NextRequest } from "next/server";
import { runPipeline, isPipelineRunning, getPipelineLiveState } from "@/lib/pipeline";
import { getDb, logTrigger } from "@/lib/db";

function getClientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}

export async function GET() {
  // Devuelve el estado vivo de la corrida actual para que la UI pueda mostrar
  // el progreso aunque la corrida la haya disparado otra pestaña o un cron.
  const live = getPipelineLiveState();
  return new Response(JSON.stringify({ running: isPipelineRunning(), live }), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const source = req.headers.get("user-agent") ?? "unknown";

  if (isPipelineRunning()) {
    try { logTrigger(getDb(), source, ip, "ya_corriendo"); } catch { /* ignore */ }
    return new Response(JSON.stringify({ error: "Pipeline ya está en ejecución" }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    });
  }

  try { logTrigger(getDb(), source, ip, "iniciado"); } catch { /* ignore */ }

  const body = await req.json().catch(() => ({}));
  const { fromStep, toStep, onlyStep } = body as Record<string, number | undefined>;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (data: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        await runPipeline({
          fromStep, toStep, onlyStep,
          onStep: (result) => emit({ type: "step", result }),
        });
        emit({ type: "done" });
      } catch (e) {
        try { logTrigger(getDb(), source, ip, "error"); } catch { /* ignore */ }
        emit({ type: "error", error: String(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
