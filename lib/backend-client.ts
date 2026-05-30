import { getConfig } from "./config";
import { getLogger } from "./logger";

const log = getLogger("backend-client");

const BACKEND_TIMEOUT_MS = 30_000;

// Maps SAP entity names used in steps → backend URL paths
const ENTITY_MAP: Record<string, string> = {
  AlternateCatNum: "catalogo/alternates",
  Orders: "orderloader/pedidos",
};

function resolveEndpoint(endpoint: string): { urlPath: string; isSingle: boolean } {
  // "Orders(123)" → single resource
  const singleMatch = endpoint.match(/^(\w+)\((\d+)\)$/);
  if (singleMatch) {
    const [, entity, id] = singleMatch;
    const mapped = ENTITY_MAP[entity];
    if (!mapped) throw new Error(`Backend: entidad SAP '${entity}' no mapeada al backend`);
    return { urlPath: `${mapped}/${id}`, isSingle: true };
  }
  const mapped = ENTITY_MAP[endpoint];
  if (!mapped) throw new Error(`Backend: entidad SAP '${endpoint}' no mapeada al backend`);
  return { urlPath: mapped, isSingle: false };
}

export class SapBackendClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly tenant: string,
  ) {}

  /**
   * Compatible con SapB1Client.get().
   * Listas: el backend devuelve {data:[...]} → se normaliza a {value:[...]} para que
   * los steps no cambien su lógica.
   * Singles: el backend devuelve el objeto SAP directo (igual que SAP Service Layer).
   */
  async get<T = unknown>(endpoint: string, params?: Record<string, string>): Promise<T> {
    const { urlPath, isSingle } = resolveEndpoint(endpoint);
    const url = new URL(`${this.baseUrl}/api/v1/${this.tenant}/${urlPath}`);

    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    const json = await this._request<unknown>("GET", url.toString());

    // Normalize list response: {data: [...]} → {value: [...]}
    if (!isSingle && json && typeof json === "object" && "data" in (json as object)) {
      return { value: (json as { data: unknown[] }).data } as T;
    }
    return json as T;
  }

  /** Compatible con SapB1Client.post(). Devuelve el objeto SAP creado. */
  async post<T = unknown>(endpoint: string, data: unknown): Promise<T> {
    const { urlPath } = resolveEndpoint(endpoint);
    const url = `${this.baseUrl}/api/v1/${this.tenant}/${urlPath}`;
    return this._request<T>("POST", url, data);
  }

  // No-ops: la auth es por API key, no hay sesión que gestionar
  async login(): Promise<void> {}
  async logout(): Promise<void> {}

  private async _request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-API-Key": this.apiKey,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Backend ${method} ${url} → ${res.status}: ${text}`);
      }

      return res.json() as Promise<T>;
    } catch (e: any) {
      if (e.name === "AbortError") {
        throw new Error(`Backend timeout (${BACKEND_TIMEOUT_MS}ms): ${url}`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

let _client: SapBackendClient | null = null;

export function getBackendClient(): SapBackendClient | null {
  const cfg = getConfig();
  if (!cfg.sapBackendUrl || !cfg.sapBackendApiKey) return null;

  if (!_client) {
    _client = new SapBackendClient(cfg.sapBackendUrl, cfg.sapBackendApiKey, cfg.tenant);
    log.info({ tenant: cfg.tenant, url: cfg.sapBackendUrl }, "SAP backend client iniciado");
  }
  return _client;
}

export function clearBackendClient(): void {
  _client = null;
}
