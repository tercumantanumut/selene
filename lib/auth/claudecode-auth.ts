/**
 * Claude Code auth state — backed by the CLIProxyAPI sidecar's credential
 * dir.
 *
 * Selene no longer keeps its own OAuth token storage. The sidecar runs the
 * OAuth flow and persists `claude-<email>.json` files; we read those to
 * derive the user-facing auth status and persist a small cached snapshot in
 * `settings.json` so the UI doesn't flicker between page loads.
 */

import { loadSettings, saveSettings } from "@/lib/settings/settings-manager";
import {
  deleteAllClaudeCredentials,
  listClaudeCredentials,
} from "@/lib/ai/providers/cliproxy/credentials";
import { getClaudeLoginState } from "@/lib/ai/providers/cliproxy/login";

const TOKEN_SOURCE = "cliproxyapi-oauth";

export interface ClaudeCodeAuthStatus {
  authenticated: boolean;
  email?: string;
  account?: string;
  tokenSource?: string;
  apiKeySource?: string;
  authUrl?: string;
  output?: string[];
  error?: string;
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
    expiresAt: undefined,
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

/**
 * Re-read upstream credential files and refresh the persisted snapshot.
 */
export async function getClaudeCodeAuthStatus(): Promise<ClaudeCodeAuthStatus> {
  let creds;
  try {
    creds = await listClaudeCredentials();
  } catch (err) {
    const status: ClaudeCodeAuthStatus = {
      authenticated: false,
      tokenSource: TOKEN_SOURCE,
      error: err instanceof Error ? err.message : String(err),
    };
    persistAuthState(status);
    return status;
  }

  const loginState = getClaudeLoginState();

  if (creds.length === 0) {
    const status: ClaudeCodeAuthStatus = {
      authenticated: false,
      tokenSource: TOKEN_SOURCE,
      authUrl: loginState?.url ?? undefined,
      output: loginState?.output,
      error: loginState?.errorMessage,
    };
    persistAuthState(status);
    return status;
  }

  const primary = creds[0];
  const status: ClaudeCodeAuthStatus = {
    authenticated: true,
    email: primary.email,
    account: primary.email,
    tokenSource: TOKEN_SOURCE,
    output: loginState?.output,
  };
  persistAuthState(status);
  return status;
}

export async function isClaudeCodeAuthenticated(): Promise<boolean> {
  const status = await getClaudeCodeAuthStatus();
  return status.authenticated;
}

/**
 * Delete the sidecar's stored credentials and reset selene's cached snapshot.
 */
export async function clearClaudeCodeAuth(): Promise<void> {
  await deleteAllClaudeCredentials().catch((err) => {
    console.error("[claudecode-auth] failed to delete credentials:", err);
  });

  const settings = loadSettings();
  settings.claudecodeAuth = {
    isAuthenticated: false,
    lastRefresh: Date.now(),
  };
  delete settings.claudecodeToken;
  delete settings.pendingClaudeCodeOAuth;
  saveSettings(settings);
  cachedAuthState = settings.claudecodeAuth;
}
