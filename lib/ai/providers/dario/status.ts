import { darioAuthHeaders, ensureDarioConfig, getDarioOrigin } from "./config";
import { ensureDarioSidecarReady } from "./sidecar";

export type DarioOAuthStatus = "healthy" | "expiring" | "expired" | "broken" | "none";

export interface DarioStatus {
  authenticated: boolean;
  status: DarioOAuthStatus;
  expiresAt?: number;
  expiresIn?: string;
  canRefresh?: boolean;
  refreshFailures?: number;
  lastRefreshError?: string;
}

export class DarioStatusError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "DarioStatusError";
  }
}

export function isDarioStatus(value: unknown): value is DarioStatus {
  if (!value || typeof value !== "object") return false;
  const obj = value as Partial<DarioStatus>;
  return typeof obj.authenticated === "boolean"
    && typeof obj.status === "string"
    && ["healthy", "expiring", "expired", "broken", "none"].includes(obj.status);
}

async function fetchDirectDarioStatus(): Promise<DarioStatus> {
  const dario = await import("@askalf/dario");
  const status = await dario.getStatus();
  if (!isDarioStatus(status)) {
    throw new DarioStatusError("Dario getStatus() returned an unexpected response shape");
  }
  return status;
}

async function fetchProxyDarioStatus(): Promise<DarioStatus> {
  await ensureDarioSidecarReady();

  const { apiKey, port, host } = ensureDarioConfig();
  const res = await fetch(`${getDarioOrigin(port, host)}/status`, {
    headers: darioAuthHeaders(apiKey),
    signal: AbortSignal.timeout(5_000),
  });

  if (res.status === 401) {
    throw new DarioStatusError(
      "Dario rejected Selene's API key. Another Dario instance may already be using the configured port.",
      401,
    );
  }

  if (!res.ok) {
    throw new DarioStatusError(`Dario status endpoint returned HTTP ${res.status}`, res.status);
  }

  const json = await res.json();
  if (!isDarioStatus(json)) {
    throw new DarioStatusError("Dario status endpoint returned an unexpected response shape");
  }

  return json;
}

export async function fetchDarioStatus(options: { ensureReady?: boolean } = {}): Promise<DarioStatus> {
  const shouldEnsureReady = options.ensureReady ?? false;
  return shouldEnsureReady ? fetchProxyDarioStatus() : fetchDirectDarioStatus();
}

/**
 * Dario can refresh expired credentials on proxy startup/request when a refresh
 * token exists, so expired+canRefresh should remain usable in Selene UI state.
 */
export function isDarioStatusUsable(status: DarioStatus): boolean {
  if (status.authenticated) return true;
  return status.status === "expired" && status.canRefresh === true;
}
