import { NextRequest } from "next/server";
import { runPipeline, isPipelineRunning } from "@/lib/pipeline";

export async function GET() {
  return new Response(JSON.stringify({ running: isPipelineRunning() }), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(req: NextRequest) {
  if (isPipelineRunning()) {
    return new Response(JSON.stringify({ error: "Pipeline ya está en ejecución" }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    });
  }

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
