/**
 * Unified SAP access layer.
 * Returns the backend HTTP client when SAP_BACKEND_URL is configured,
 * otherwise falls back to the direct SAP B1 Service Layer client.
 * Steps import from here instead of sap-client directly.
 */
import { getSapClient, clearSapClient } from "./sap-client";
import { getBackendClient, clearBackendClient } from "./backend-client";

export interface SapGateway {
  get<T>(endpoint: string, params?: Record<string, string>): Promise<T>;
  post<T>(endpoint: string, data: unknown): Promise<T>;
}

export async function getActiveSap(): Promise<SapGateway> {
  const backend = getBackendClient();
  if (backend) return backend;
  return getSapClient();
}

export function clearActiveSap(): void {
  clearBackendClient();
  clearSapClient();
}
