import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// ── Rate limiting (in-process Map, válido para despliegue Docker persistente) ─
const RATE_LIMIT_MS = 5 * 60 * 1000; // 1 trigger de pipeline cada 5 minutos por IP
const _lastTrigger = new Map<string, number>();

function isPipelineTrigger(pathname: string): boolean {
  return pathname === "/api/pipeline/run";
}

function getClientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}

export function proxy(req: NextRequest) {
  // Rutas públicas: sin auth requerida
  const PUBLIC_PATHS = ["/api/health", "/api/changelog"];
  if (PUBLIC_PATHS.includes(req.nextUrl.pathname)) {
    return NextResponse.next();
  }

  if (process.env.NODE_ENV === "production") {
    // ── Autenticación Basic Auth ─────────────────────────────────────────────
    const basicAuth = req.headers.get("authorization");
    if (!basicAuth) {
      return new NextResponse("Autenticación requerida", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="OrderLoader Secure Area"' },
      });
    }

    const authValue = basicAuth.split(" ")[1];
    const [, pwd] = atob(authValue).split(":");
    if (pwd !== process.env.CRON_SECRET) {
      return new NextResponse("Credenciales inválidas", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="OrderLoader Secure Area"' },
      });
    }

    // ── Rate limiting para trigger de pipeline ───────────────────────────────
    if (isPipelineTrigger(req.nextUrl.pathname)) {
      const ip = getClientIp(req);
      const last = _lastTrigger.get(ip) ?? 0;
      const elapsed = Date.now() - last;
      if (elapsed < RATE_LIMIT_MS) {
        const retryAfter = Math.ceil((RATE_LIMIT_MS - elapsed) / 1000);
        return new NextResponse(
          `Rate limit: espera ${retryAfter}s antes de volver a disparar el pipeline`,
          { status: 429, headers: { "Retry-After": String(retryAfter) } },
        );
      }
      _lastTrigger.set(ip, Date.now());
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
