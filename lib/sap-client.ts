import https from "node:https";
import fs from "node:fs";
import { getConfig } from "./config";
import { getLogger } from "./logger";

const log = getLogger("sap-client");

const SAP_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [1_000, 3_000];

interface FetchOptions {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

interface SapResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export class SapB1Client {
  private baseUrl: string;
  private user: string;
  private password: string;
  private company: string;
  private cookies: string = "";
  private agent: https.Agent;

  constructor(baseUrl: string, user: string, password: string, company: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.user = user;
    this.password = password;
    this.company = company;
    this.agent = SapB1Client._buildAgent();
  }

  private static _buildAgent(): https.Agent {
    const caPath = process.env.SAP_B1_CA_CERT;
    const disableVerify = process.env.SAP_B1_DISABLE_TLS_VERIFY === "true";

    if (disableVerify) {
      log.warn("SAP_B1_DISABLE_TLS_VERIFY=true — verificación TLS desactivada (solo para desarrollo)");
      return new https.Agent({ rejectUnauthorized: false });
    }
    if (caPath) {
      const ca = fs.readFileSync(caPath);
      log.info({ caPath }, "SAP TLS: usando CA cert personalizado");
      return new https.Agent({ ca });
    }
    return new https.Agent();
  }

  async login(): Promise<void> {
    const res = await this._fetch(`${this.baseUrl}/Login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        UserName: this.user,
        Password: this.password,
        CompanyDB: this.company,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`SAP login failed ${res.status}: ${text}`);
    }
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      this.cookies = setCookie
        .split(",")
        .map((c) => c.split(";")[0].trim())
        .join("; ");
    }
  }

  async logout(): Promise<void> {
    try {
      log.info("SAP logout iniciado");
      await this._fetch(`${this.baseUrl}/Logout`, {
        method: "POST",
        headers: this._headers(),
      });
      log.info("SAP logout exitoso");
    } catch (e) {
      log.warn({ err: String(e) }, "SAP logout falló (ignorado)");
    }
    this.cookies = "";
  }

  async get<T = unknown>(endpoint: string, params?: Record<string, string>): Promise<T> {
    let url = `${this.baseUrl}/${endpoint.replace(/^\//, "")}`;
    if (params) url += "?" + new URLSearchParams(params).toString();
    return this._request<T>("GET", url);
  }

  async post<T = unknown>(endpoint: string, data: unknown): Promise<T> {
    const url = `${this.baseUrl}/${endpoint.replace(/^\//, "")}`;
    return this._request<T>("POST", url, data);
  }

  async patch(endpoint: string, data: unknown): Promise<void> {
    const url = `${this.baseUrl}/${endpoint.replace(/^\//, "")}`;
    await this._request("PATCH", url, data);
  }

  private async _request<T>(method: string, url: string, body?: unknown): Promise<T> {
    return this._withRetry(() => this._requestOnce<T>(method, url, body), `${method} ${url}`);
  }

  private async _requestOnce<T>(method: string, url: string, body?: unknown): Promise<T> {
    const opts: FetchOptions = {
      method,
      headers: this._headers(),
      ...(body ? { body: JSON.stringify(body) } : {}),
    };

    let res = await this._fetch(url, opts);

    // Auto-reconnect on 401
    if (res.status === 401) {
      await this.login();
      opts.headers = this._headers();
      res = await this._fetch(url, opts);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`SAP ${method} ${url} → ${res.status}: ${text}`);
    }

    // PATCH returns 204 No Content
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  private async _withRetry<T>(fn: () => Promise<T>, context: string): Promise<T> {
    let lastError!: Error;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        return await fn();
      } catch (e: any) {
        lastError = e;
        const retryable =
          e.message?.includes("Error de red") ||
          e.message?.includes("timeout") ||
          /→ 5\d\d:/.test(e.message ?? "");
        if (attempt < RETRY_DELAYS_MS.length && retryable) {
          const delay = RETRY_DELAYS_MS[attempt];
          log.warn({ attempt: attempt + 1, delay, context }, "SAP request falló, reintentando");
          await new Promise((r) => setTimeout(r, delay));
        } else {
          throw lastError;
        }
      }
    }
    throw lastError;
  }

  private _headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(this.cookies ? { Cookie: this.cookies } : {}),
    };
  }

  private _fetch(url: string, opts: FetchOptions): Promise<SapResponse> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);

      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error(`SAP timeout (${SAP_TIMEOUT_MS}ms) calling ${url}`));
      }, SAP_TIMEOUT_MS);

      const req = https.request(
        {
          hostname: parsedUrl.hostname,
          port: parseInt(parsedUrl.port || "443"),
          path: parsedUrl.pathname + parsedUrl.search,
          method: opts.method,
          headers: opts.headers,
          agent: this.agent,
        },
        (res) => {
          clearTimeout(timer);
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf-8");
            const status = res.statusCode ?? 0;
            resolve({
              ok: status >= 200 && status < 300,
              status,
              headers: {
                get(name: string): string | null {
                  const val = res.headers[name.toLowerCase()];
                  if (Array.isArray(val)) return val.join(", ");
                  return val ?? null;
                },
              },
              text: async () => body,
              json: async () => JSON.parse(body),
            });
          });
          res.on("error", (e: any) => {
            clearTimeout(timer);
            reject(new Error(`Error de red conectando a SAP (${url}): ${e.message}`));
          });
        }
      );

      req.on("error", (e: any) => {
        clearTimeout(timer);
        const isCertError =
          e.code === "CERT_HAS_EXPIRED" ||
          e.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
          e.code === "SELF_SIGNED_CERT_IN_CHAIN" ||
          e.message?.includes("certificate");
        if (isCertError) {
          reject(
            new Error(
              `SSL error con SAP (${url}): ${e.message}. ` +
              `Configura SAP_B1_CA_CERT=/ruta/al/cert.pem o SAP_B1_DISABLE_TLS_VERIFY=true en .env`
            )
          );
        } else {
          reject(new Error(`Error de red conectando a SAP (${url}): ${e.message}`));
        }
      });

      if (opts.body) req.write(opts.body);
      req.end();
    });
  }
}

let _sapClient: SapB1Client | null = null;

export async function getSapClient(): Promise<SapB1Client> {
  const config = getConfig();
  const missing = (["sapUrl", "sapUser", "sapPass", "sapCompany"] as const)
    .filter((k) => !config[k] || String(config[k]).startsWith("{"))
    .map((k) => k.toUpperCase().replace("SAP", "SAP_B1_"));

  if (missing.length) {
    throw new Error(
      `SAP B1 no configurado. Faltan en .env.local: ${missing.join(", ")}`
    );
  }

  if (!_sapClient) {
    _sapClient = new SapB1Client(
      config.sapUrl,
      config.sapUser,
      config.sapPass,
      config.sapCompany
    );
    await _sapClient.login();
  }
  return _sapClient;
}

export async function logoutSapClient(): Promise<void> {
  if (_sapClient) {
    await _sapClient.logout();
    _sapClient = null;
  }
}

export function clearSapClient(): void {
  _sapClient = null;
}
