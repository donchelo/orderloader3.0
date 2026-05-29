import { NextRequest, NextResponse } from "next/server"

// /api/health is intentionally public (uptime monitors, Docker healthcheck)
const PUBLIC_PATHS = ["/api/health"]

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) return NextResponse.next()

  const secret = process.env.CRON_SECRET ?? ""
  if (!secret) {
    return NextResponse.json(
      { error: "Servidor no configurado: CRON_SECRET no definido" },
      { status: 500 }
    )
  }

  const auth = req.headers.get("authorization") ?? ""
  const [scheme, token] = auth.split(" ")

  if (scheme !== "Bearer" || token !== secret) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 })
  }

  return NextResponse.next()
}

export const proxyConfig = {
  matcher: "/api/:path*",
}
