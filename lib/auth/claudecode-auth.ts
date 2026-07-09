/**
 * Claude Code auth state — backend-aware.
 *
 * The "claudecode" provider can run on one of two backends, selected by
 * `settings.claudecodeBackend`:
 *  - "dario" (default): Dario owns Claude Code OAuth discovery/refresh and
 *    exposes a local /status endpoint; Selene mirrors that into
 *    `settings.claudecodeAuth`.
 *  - "sdk": the official @anthropic-ai/claude-agent-sdk owns credentials in
 *    ~/.claude; Selene mirrors its status into `settings.claudecodeSdkAuth`.
 *
 * Each backend uses a SEPARATE persisted slot so a stale "authenticated" from
 * one backend can never mask the other. Switching backends may require a
 * one-time re-login.
 */

import { loadSettings, saveSettings } from "@/lib/settings/settings-manager";
import {
  fetchDarioStatus,
  isDarioStatusUsable,
  type DarioStatus,
} from "@/lib/ai/providers/dario/status";
import {
  getClaudeLoginState,
  logoutClaudeLogin,
} from "@/lib/ai/providers/dario/login";
import {
  readClaudeAgentSdkAuthStatus,
  attemptClaudeAgentSdkLogout,
  type ClaudeAgentSdkAuthStatus,
} from "@/lib/ai/providers/claudecode-sdk/auth";

const TOKEN_SOURCE = "dario-oauth";
const SDK_TOKEN_SOURCE = "claude-agent-sdk";
const SDK_AUTH_TIMEOUT_MS = 15_000;

type ClaudeCodeBackend = "dario" | "sdk";

export interface ClaudeCodeAuthStatus {
  authenticated: boolean;
  email?: string;
  account?: string;
  tokenSource?: string;
  apiKeySource?: string;
  authUrl?: string;
  output?: string[];
  error?: string;
  expiresAt?: number;
  expiresIn?: string;
}

interface ClaudeCodeAuthState {
  isAuthenticated: boolean;
  email?: string;
  expiresAt?: number;
  lastRefresh?: number;
  tokenSource?: string;
  apiKeySource?: string;
  authUrl?: string;
  output?: string[];
  error?: string;
}

let cachedAuthState: (ClaudeCodeAuthState & { backend?: ClaudeCodeBackend }) | null = null;

/**
 * Active Claude Code backend. Read directly from settings (not from
 * lib/ai/providers) to avoid a circular import.
 */
function getBackend(): ClaudeCodeBackend {
  return loadSettings().claudecodeBackend === "sdk" ? "sdk" : "dario";
}

function authSlotKey(backend: ClaudeCodeBackend): "claudecodeAuth" | "claudecodeSdkAuth" {
  return backend === "sdk" ? "claudecodeSdkAuth" : "claudecodeAuth";
}

function buildAuthStateFromStatus(status: ClaudeCodeAuthStatus): ClaudeCodeAuthState {
  return {
    isAuthenticated: status.authenticated,
    email: status.email,
    expiresAt: status.expiresAt,
    lastRefresh: Date.now(),
    tokenSource: status.tokenSource,
    apiKeySource: status.apiKeySource,
    authUrl: status.authUrl,
    output: status.output,
    error: status.error,
  };
}

function persistAuthState(status: ClaudeCodeAuthStatus, backend: ClaudeCodeBackend): ClaudeCodeAuthState {
  const settings = loadSettings();
  const authState = buildAuthStateFromStatus(status);

  settings[authSlotKey(backend)] = authState;

  // Drop legacy fields from older Agent-SDK-era versions.
  delete settings.claudecodeToken;
  delete settings.pendingClaudeCodeOAuth;

  saveSettings(settings);
  cachedAuthState = { ...authState, backend };
  return authState;
}

export function getClaudeCodeAuthState(): ClaudeCodeAuthState {
  const backend = getBackend();
  if (cachedAuthState && cachedAuthState.backend === backend) return cachedAuthState;

  const settings = loadSettings();
  const slot = settings[authSlotKey(backend)];
  const state: ClaudeCodeAuthState & { backend: ClaudeCodeBackend } = {
    isAuthenticated: !!slot?.isAuthenticated,
    email: slot?.email,
    expiresAt: slot?.expiresAt,
    lastRefresh: slot?.lastRefresh,
    tokenSource: slot?.tokenSource,
    apiKeySource: slot?.apiKeySource,
    authUrl: slot?.authUrl,
    output: slot?.output,
    error: slot?.error,
    backend,
  };
  cachedAuthState = state;
  return state;
}

export function invalidateClaudeCodeAuthCache(): void {
  cachedAuthState = null;
}

// ─── Dario backend ──────────────────────────────────────────────────────────

function darioStatusError(status: DarioStatus): string | undefined {
  if (isDarioStatusUsable(status)) return undefined;
  if (status.status === "broken") {
    return status.lastRefreshError
      ? `Dario OAuth refresh is broken: ${status.lastRefreshError}`
      : "Dario OAuth refresh is broken. Retry Claude Code authentication through Dario.";
  }
  if (status.status === "expired" && status.canRefresh === false) {
    return "Dario OAuth credentials are expired and cannot be refreshed. Retry Claude Code authentication through Dario.";
  }
  return undefined;
}

function mapDarioStatus(status: DarioStatus, output?: string[]): ClaudeCodeAuthStatus {
  const loginState = getClaudeLoginState();
  return {
    authenticated: isDarioStatusUsable(status),
    tokenSource: TOKEN_SOURCE,
    apiKeySource: "dario-local-proxy",
    authUrl: loginState?.url ?? undefined,
    output: output ?? loginState?.output,
    error: darioStatusError(status) ?? loginState?.errorMessage,
    expiresAt: status.expiresAt,
    expiresIn: status.expiresIn,
  };
}

async function getDarioAuthStatus(): Promise<ClaudeCodeAuthStatus> {
  try {
    const dario = await fetchDarioStatus();
    const status = mapDarioStatus(dario);
    persistAuthState(status, "dario");
    return status;
  } catch (err) {
    const loginState = getClaudeLoginState();
    const status: ClaudeCodeAuthStatus = {
      authenticated: false,
      tokenSource: TOKEN_SOURCE,
      apiKeySource: "dario-local-proxy",
      authUrl: loginState?.url ?? undefined,
      output: loginState?.output,
      error: err instanceof Error ? err.message : String(err),
    };
    persistAuthState(status, "dario");
    return status;
  }
}

// ─── Agent SDK backend ────────────────────────────────────────────────────────

function mapSdkStatus(sdk: ClaudeAgentSdkAuthStatus, output?: string[]): ClaudeCodeAuthStatus {
  return {
    authenticated: sdk.authenticated,
    email: sdk.email,
    account: sdk.subscriptionType,
    tokenSource: sdk.tokenSource ?? SDK_TOKEN_SOURCE,
    apiKeySource: sdk.apiKeySource ?? SDK_TOKEN_SOURCE,
    authUrl: sdk.authUrl,
    output: output ?? sdk.output,
    error: sdk.error,
  };
}

async function getSdkAuthStatus(): Promise<ClaudeCodeAuthStatus> {
  try {
    const sdk = await readClaudeAgentSdkAuthStatus({ timeoutMs: SDK_AUTH_TIMEOUT_MS });
    const status = mapSdkStatus(sdk);
    persistAuthState(status, "sdk");
    return status;
  } catch (err) {
    const status: ClaudeCodeAuthStatus = {
      authenticated: false,
      tokenSource: SDK_TOKEN_SOURCE,
      apiKeySource: SDK_TOKEN_SOURCE,
      error: err instanceof Error ? err.message : String(err),
    };
    persistAuthState(status, "sdk");
    return status;
  }
}

// ─── Public, backend-aware API ────────────────────────────────────────────────

/** Re-read the active backend's status and refresh the persisted snapshot. */
export async function getClaudeCodeAuthStatus(): Promise<ClaudeCodeAuthStatus> {
  return getBackend() === "sdk" ? getSdkAuthStatus() : getDarioAuthStatus();
}

export async function isClaudeCodeAuthenticated(): Promise<boolean> {
  const status = await getClaudeCodeAuthStatus();
  return status.authenticated;
}

/** Verify Dario auth after a login subprocess completes (Dario backend). */
export async function verifyClaudeCodeAuthenticatedAfterDarioLogin(output: string[] = []): Promise<ClaudeCodeAuthStatus> {
  try {
    const dario = await fetchDarioStatus({ ensureReady: true });
    const status = mapDarioStatus(dario, output);
    persistAuthState(status, "dario");
    return status;
  } catch (err) {
    const status: ClaudeCodeAuthStatus = {
      authenticated: false,
      tokenSource: TOKEN_SOURCE,
      apiKeySource: "dario-local-proxy",
      output,
      error: err instanceof Error ? err.message : String(err),
    };
    persistAuthState(status, "dario");
    return status;
  }
}

/** Verify SDK auth after the SDK login subprocess completes (SDK backend). */
export async function verifyClaudeCodeAuthenticatedAfterSdkLogin(output: string[] = []): Promise<ClaudeCodeAuthStatus> {
  try {
    const sdk = await readClaudeAgentSdkAuthStatus({ timeoutMs: SDK_AUTH_TIMEOUT_MS });
    const status = mapSdkStatus(sdk, output);
    persistAuthState(status, "sdk");
    return status;
  } catch (err) {
    const status: ClaudeCodeAuthStatus = {
      authenticated: false,
      tokenSource: SDK_TOKEN_SOURCE,
      apiKeySource: SDK_TOKEN_SOURCE,
      output,
      error: err instanceof Error ? err.message : String(err),
    };
    persistAuthState(status, "sdk");
    return status;
  }
}

/** Clear the active backend's stored credentials and reset Selene's snapshot. */
export async function clearClaudeCodeAuth(): Promise<void> {
  const backend = getBackend();

  try {
    if (backend === "sdk") {
      await attemptClaudeAgentSdkLogout();
    } else {
      await logoutClaudeLogin();
    }
  } catch (err) {
    console.error(`[claudecode-auth] failed to clear ${backend} credentials:`, err);
    throw err;
  }

  const settings = loadSettings();
  const clearedState: ClaudeCodeAuthState = {
    isAuthenticated: false,
    lastRefresh: Date.now(),
    tokenSource: backend === "sdk" ? SDK_TOKEN_SOURCE : TOKEN_SOURCE,
    apiKeySource: backend === "sdk" ? SDK_TOKEN_SOURCE : "dario-local-proxy",
  };
  settings[authSlotKey(backend)] = clearedState;
  delete settings.claudecodeToken;
  delete settings.pendingClaudeCodeOAuth;
  saveSettings(settings);
  cachedAuthState = { ...clearedState, backend };
}
