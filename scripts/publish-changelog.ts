/**
 * Publica el changelog al servicio remoto de Tamaprint.
 *
 * Lee la version de package.json y arma `changes` desde los commits desde el
 * último tag (o los últimos 50 commits si no hay tags). Si la versión ya está
 * publicada el servicio devuelve 4xx — eso es esperado en redeploys sin bump.
 *
 * Env requeridas: CHANGELOG_URL, CHANGELOG_CLIENT_ID, CHANGELOG_APP_ID, CHANGELOG_API_KEY
 * Uso: npm run publish:changelog
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta env var: ${name}`);
  return v;
}

function gitChanges(): string[] {
  let range = "";
  try {
    const lastTag = execSync("git describe --tags --abbrev=0", {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (lastTag) range = `${lastTag}..HEAD`;
  } catch {
    // sin tags previos → tomar últimos commits
  }

  const cmd = range
    ? `git log ${range} --pretty=%s --no-merges`
    : `git log -50 --pretty=%s --no-merges`;

  const out = execSync(cmd, { cwd: root }).toString().trim();
  if (!out) return [];

  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    // descarta commits de bump/chore-version triviales
    .filter((s) => !/^chore\(release\)|^v?\d+\.\d+\.\d+$/i.test(s));
}

async function main() {
  const url = env("CHANGELOG_URL").replace(/\/$/, "");
  const clientId = env("CHANGELOG_CLIENT_ID");
  const appId = env("CHANGELOG_APP_ID");
  const apiKey = env("CHANGELOG_API_KEY");

  const pkg = JSON.parse(
    readFileSync(join(root, "package.json"), "utf-8")
  ) as { version: string; name: string };

  const changes = gitChanges();
  if (changes.length === 0) {
    console.log("Sin cambios para publicar — saliendo.");
    return;
  }

  const body = {
    version: pkg.version,
    date: new Date().toISOString().slice(0, 10),
    changes,
    appName: "OrderLoader",
  };

  const endpoint = `${url}/api/changelog/${clientId}/${appId}`;
  console.log(`POST ${endpoint}  (v${body.version}, ${changes.length} cambios)`);

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`Error ${res.status}: ${text}`);
    process.exit(1);
  }
  console.log(`OK: ${text}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
