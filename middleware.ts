import { NextResponse } from "next/server";
import type { NextRequest } from "next/request";

export function middleware(req: NextRequest) {
  const basicAuth = req.headers.get("authorization");

  if (process.env.NODE_ENV === "production") {
    // Saltamos la protección para el health check si existe
    if (req.nextUrl.pathname === "/api/health") {
      return NextResponse.next();
    }

    if (basicAuth) {
      const authValue = basicAuth.split(" ")[1];
      const [user, pwd] = atob(authValue).split(":");

      // Según el README, usamos CRON_SECRET como contraseña (usuario cualquiera)
      if (pwd === process.env.CRON_SECRET) {
        return NextResponse.next();
      }
    }

    return new NextResponse("Autenticación requerida", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Basic realm="OrderLoader Secure Area"',
      },
    });
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
