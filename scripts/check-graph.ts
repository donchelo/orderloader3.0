/**
 * Verifica la conexión con Microsoft Graph API.
 * Uso: npx tsx scripts/check-graph.ts [--env .env.flexoimpresos]
 *
 * Prueba:
 *  1. Obtiene token OAuth2 (client credentials)
 *  2. Lista carpetas del buzón
 *  3. Lista mensajes no leídos de Inbox
 */

import { readFileSync } from "fs";
import path from "path";

const envArg  = process.argv.indexOf("--env");
const envFile = envArg !== -1 ? process.argv[envArg + 1] : ".env";

// Carga manual del .env (sin dependencia dotenv)
try {
  const lines = readFileSync(path.resolve(envFile), "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && !process.env[key]) process.env[key] = val;
  }
} catch {
  console.error(`No se pudo leer ${envFile}`);
  process.exit(1);
}

const tenantId     = process.env.MS_TENANT_ID     ?? "";
const clientId     = process.env.MS_CLIENT_ID     ?? "";
const clientSecret = process.env.MS_CLIENT_SECRET ?? "";
const userEmail    = process.env.EMAIL_USER        ?? "";

if (!tenantId || !clientId || !clientSecret || !userEmail) {
  console.error("Faltan variables: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, EMAIL_USER");
  process.exit(1);
}

const BASE = "https://graph.microsoft.com/v1.0";

async function getToken(): Promise<string> {
  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
      }),
    }
  );
  if (!res.ok) throw new Error(`Token error ${res.status}: ${await res.text()}`);
  const data = await res.json() as { access_token: string; expires_in: number };
  console.log(`✓ Token obtenido (expira en ${data.expires_in}s)`);
  return data.access_token;
}

async function gGet(token: string, path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  console.log(`\n=== check-graph → ${userEmail} ===\n`);

  const token = await getToken();

  // Listar carpetas del buzón (bajo Inbox)
  console.log("\n--- Subcarpetas de Inbox ---");
  try {
    const folders = await gGet(token, `/users/${encodeURIComponent(userEmail)}/mailFolders/Inbox/childFolders?$select=id,displayName,totalItemCount,unreadItemCount`) as {
      value: Array<{ id: string; displayName: string; totalItemCount: number; unreadItemCount: number }>
    };
    if (folders.value.length === 0) {
      console.log("  (ninguna subcarpeta encontrada — se crearán al correr el pipeline)");
    }
    for (const f of folders.value) {
      console.log(`  📁 ${f.displayName.padEnd(25)} total=${f.totalItemCount} unread=${f.unreadItemCount}`);
    }
  } catch (e) {
    console.error(`  ERROR listando carpetas: ${e}`);
  }

  // Contar mensajes en Inbox
  console.log("\n--- Inbox ---");
  try {
    const inbox = await gGet(token, `/users/${encodeURIComponent(userEmail)}/mailFolders/Inbox?$select=displayName,totalItemCount,unreadItemCount`) as {
      displayName: string; totalItemCount: number; unreadItemCount: number
    };
    console.log(`  Total: ${inbox.totalItemCount}  No leídos: ${inbox.unreadItemCount}`);
  } catch (e) {
    console.error(`  ERROR leyendo Inbox: ${e}`);
  }

  // Listar últimos 5 mensajes no leídos
  console.log("\n--- Últimos mensajes no leídos (máx 5) ---");
  try {
    const msgs = await gGet(
      token,
      `/users/${encodeURIComponent(userEmail)}/mailFolders/Inbox/messages?$filter=isRead eq false&$select=subject,from,receivedDateTime,hasAttachments&$top=5&$orderby=receivedDateTime desc`
    ) as { value: Array<{ subject: string; from: { emailAddress: { address: string } }; receivedDateTime: string; hasAttachments: boolean }> };

    if (msgs.value.length === 0) {
      console.log("  (no hay mensajes no leídos en Inbox)");
    }
    for (const m of msgs.value) {
      const date = new Date(m.receivedDateTime).toLocaleString("es-CO");
      const att  = m.hasAttachments ? "📎" : "  ";
      console.log(`  ${att} [${date}] "${m.subject?.slice(0, 50) ?? ""}" — ${m.from?.emailAddress?.address ?? ""}`);
    }
  } catch (e) {
    console.error(`  ERROR listando mensajes: ${e}`);
  }

  console.log("\n✓ Conexión Graph API verificada\n");
}

main().catch(err => {
  console.error("\n✗ Error:", err);
  process.exit(1);
});
