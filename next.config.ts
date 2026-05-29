import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // better-sqlite3 and imapflow use native modules — keep them server-side only
  serverExternalPackages: ["better-sqlite3", "imapflow"],
  output: "standalone",
  // Fija el root de Turbopack a este directorio para evitar que detecte el
  // package-lock.json del directorio padre y resuelva rutas incorrectamente.
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
