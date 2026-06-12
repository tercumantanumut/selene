/**
 * Claude Code auth state — backed by Dario's Claude subscription OAuth state.
 *
 * Selene no longer keeps its own OAuth token storage. Dario owns Claude Code
 * OAuth discovery/refresh and exposes a local /status endpoint; Selene mirrors
 * that state into settings.json so the UI doesn't flicker between page loads.
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

const TOKEN_SOURCE = "dario-oauth";

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

let cachedAuthState: ClaudeCodeAuthState | null = null;

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

function persistAuthState(status: ClaudeCodeAuthStatus): ClaudeCodeAuthState {
  const settings = loadSettings();
  const authState = buildAuthStateFromStatus(status);

  settings.claudecodeAuth = authState;

  // Drop legacy fields from older Agent-SDK-era versions.
  delete settings.claudecodeToken;
  delete settings.pendingClaudeCodeOAuth;

  saveSettings(settings);
  cachedAuthState = authState;
  return authState;
}

export function getClaudeCodeAuthState(): ClaudeCodeAuthState {
  if (cachedAuthState) return cachedAuthState;

  const settings = loadSettings();
  const state: ClaudeCodeAuthState = {
    isAuthenticated: !!settings.claudecodeAuth?.isAuthenticated,
    email: settings.claudecodeAuth?.email,
    expiresAt: settings.claudecodeAuth?.expiresAt,
    lastRefresh: settings.claudecodeAuth?.lastRefresh,
    tokenSource: settings.claudecodeAuth?.tokenSource,
    apiKeySource: settings.claudecodeAuth?.apiKeySource,
    authUrl: settings.claudecodeAuth?.authUrl,
    output: settings.claudecodeAuth?.output,
    error: settings.claudecodeAuth?.error,
  };
  cachedAuthState = state;
  return state;
}

export function invalidateClaudeCodeAuthCache(): void {
  cachedAuthState = null;
}

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

/** Re-read Dario status and refresh the persisted auth snapshot. */
export async function getClaudeCodeAuthStatus(): Promise<ClaudeCodeAuthStatus> {
  try {
    const dario = await fetchDarioStatus();
    const status = mapDarioStatus(dario);
    persistAuthState(status);
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
    persistAuthState(status);
    return status;
  }
}

export async function isClaudeCodeAuthenticated(): Promise<boolean> {
  const status = await getClaudeCodeAuthStatus();
  return status.authenticated;
}

export async function verifyClaudeCodeAuthenticatedAfterDarioLogin(output: string[] = []): Promise<ClaudeCodeAuthStatus> {
  try {
    const dario = await fetchDarioStatus({ ensureReady: true });
    const status = mapDarioStatus(dario, output);
    persistAuthState(status);
    return status;
  } catch (err) {
    const status: ClaudeCodeAuthStatus = {
      authenticated: false,
      tokenSource: TOKEN_SOURCE,
      apiKeySource: "dario-local-proxy",
      output,
      error: err instanceof Error ? err.message : String(err),
    };
    persistAuthState(status);
    return status;
  }
}

/** Clear Dario's stored credentials and reset Selene's cached snapshot. */
export async function clearClaudeCodeAuth(): Promise<void> {
  try {
    await logoutClaudeLogin();
  } catch (err) {
    console.error("[claudecode-auth] failed to clear dario credentials:", err);
    throw err;
  }

  const settings = loadSettings();
  settings.claudecodeAuth = {
    isAuthenticated: false,
    lastRefresh: Date.now(),
    tokenSource: TOKEN_SOURCE,
    apiKeySource: "dario-local-proxy",
  };
  delete settings.claudecodeToken;
  delete settings.pendingClaudeCodeOAuth;
  saveSettings(settings);
  cachedAuthState = settings.claudecodeAuth;
}
