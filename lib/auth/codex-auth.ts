/**
 * Codex auth state — backed by the CLIProxyAPI sidecar's credential dir.
 *
 * Selene no longer keeps its own OAuth token storage for Codex. The sidecar
 * runs `-codex-login`, persists `codex-<email>[-<plan>].json` files, and
 * refreshes them on demand. We read those files to derive the user-facing
 * auth status and persist a small cached snapshot in `settings.json` so the
 * UI doesn't flicker between page loads.
 *
 * Existing users who logged in via the old PKCE flow still have a
 * `settings.codexToken` blob — `ensureCodexCredentialBridged()` does a
 * one-time migration into the sidecar's auth-dir on first invocation.
 *
 * The OpenAI Codex CLI client id (`app_EMoamEEZ73f0CkXaXp7hrann`) is the
 * same identity the sidecar uses, so the OAuth bearer is interchangeable —
 * no re-login required when upgrading from the old flow.
 */

import { loadSettings, saveSettings } from "@/lib/settings/settings-manager";
import {
  deleteAllCodexCredentials,
  listCodexCredentials,
} from "@/lib/ai/providers/cliproxy/credentials";
import { ensureCodexCredentialBridged } from "@/lib/ai/providers/cliproxy/codex-bridge";
import { getCodexLoginState } from "@/lib/ai/providers/cliproxy/login";

const TOKEN_SOURCE = "cliproxyapi-oauth";

/** Path on the JWT where OpenAI namespaces its profile claims (email, name). */
const CODEX_JWT_PROFILE_CLAIM_PATH = "https://api.openai.com/profile";
/** Path on the JWT where OpenAI namespaces its auth/account claims. */
const CODEX_JWT_AUTH_CLAIM_PATH = "https://api.openai.com/auth";

export interface CodexAuthStatus {
  authenticated: boolean;
  email?: string;
  accountId?: string;
  plan?: string;
  tokenSource?: string;
  authUrl?: string;
  output?: string[];
  error?: string;
}

interface CodexAuthState {
  isAuthenticated: boolean;
  email?: string;
  accountId?: string;
  plan?: string;
  lastRefresh?: number;
  tokenSource?: string;
  authUrl?: string;
  output?: string[];
  error?: string;
}

let cachedAuthState: CodexAuthState | null = null;

function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

/**
 * Best-effort decode of a Codex OAuth JWT into the three surface fields we
 * care about: email (under namespaced profile claim), account id, and plan
 * type (under namespaced auth claim). Returns null on any parse failure.
 */
export function decodeCodexJWT(
  token: string,
): { accountId?: string; email?: string; planType?: string } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(decodeBase64Url(parts[1]));
    const auth = payload?.[CODEX_JWT_AUTH_CLAIM_PATH] ?? {};
    const profile = payload?.[CODEX_JWT_PROFILE_CLAIM_PATH] ?? {};
    const email =
      typeof profile?.email === "string"
        ? profile.email
        : typeof payload?.email === "string"
          ? payload.email
          : undefined;
    return {
      accountId: typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined,
      email,
      planType: typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined,
    };
  } catch {
    return null;
  }
}

function buildAuthStateFromStatus(status: CodexAuthStatus): CodexAuthState {
  return {
    isAuthenticated: status.authenticated,
    email: status.email,
    accountId: status.accountId,
    plan: status.plan,
    lastRefresh: Date.now(),
    tokenSource: status.tokenSource,
    authUrl: status.authUrl,
    output: status.output,
    error: status.error,
  };
}

function persistAuthState(status: CodexAuthStatus): CodexAuthState {
  const settings = loadSettings();
  const authState = buildAuthStateFromStatus(status);

  settings.codexAuth = authState;
  saveSettings(settings);
  cachedAuthState = authState;
  return authState;
}

export function getCodexAuthState(): CodexAuthState {
  if (cachedAuthState) return cachedAuthState;

  const settings = loadSettings();
  const state: CodexAuthState = {
    isAuthenticated: !!settings.codexAuth?.isAuthenticated,
    email: settings.codexAuth?.email,
    accountId: settings.codexAuth?.accountId,
    plan: settings.codexAuth?.plan,
    lastRefresh: settings.codexAuth?.lastRefresh,
    tokenSource: settings.codexAuth?.tokenSource,
    authUrl: settings.codexAuth?.authUrl,
    output: settings.codexAuth?.output,
    error: settings.codexAuth?.error,
  };
  cachedAuthState = state;
  return state;
}

export function invalidateCodexAuthCache(): void {
  cachedAuthState = null;
}

/**
 * Sync read of the cached snapshot. Used by `lib/ai/providers.ts` for fast
 * provider-availability checks during streamText setup — the snapshot is
 * refreshed by `getCodexAuthStatus()` on settings reload and after every
 * successful auth flow, so it stays in sync with the sidecar.
 */
export function isCodexAuthenticated(): boolean {
  return getCodexAuthState().isAuthenticated;
}

/**
 * Re-read sidecar credentials (and migrate any legacy settings.codexToken
 * into the auth-dir on the way past), then persist a fresh snapshot.
 */
export async function getCodexAuthStatus(): Promise<CodexAuthStatus> {
  // Migration shim: writes selene's legacy codexToken into the sidecar's
  // auth-dir if one isn't already there. No-op once the sidecar owns the
  // credential.
  try {
    await ensureCodexCredentialBridged();
  } catch (err) {
    console.warn("[codex-auth] credential bridge failed:", err);
  }

  let creds;
  try {
    creds = await listCodexCredentials();
  } catch (err) {
    const status: CodexAuthStatus = {
      authenticated: false,
      tokenSource: TOKEN_SOURCE,
      error: err instanceof Error ? err.message : String(err),
    };
    persistAuthState(status);
    return status;
  }

  const loginState = getCodexLoginState();

  if (creds.length === 0) {
    const status: CodexAuthStatus = {
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
  const status: CodexAuthStatus = {
    authenticated: true,
    email: primary.email,
    plan: primary.plan,
    tokenSource: TOKEN_SOURCE,
    output: loginState?.output,
  };
  persistAuthState(status);
  return status;
}

/**
 * Delete the sidecar's stored credentials and reset selene's cached snapshot.
 */
export async function clearCodexAuth(): Promise<void> {
  await deleteAllCodexCredentials().catch((err) => {
    console.error("[codex-auth] failed to delete credentials:", err);
  });

  const settings = loadSettings();
  settings.codexAuth = {
    isAuthenticated: false,
    lastRefresh: Date.now(),
  };
  // Drop the legacy token blob from older PKCE-era selene versions.
  delete settings.codexToken;
  saveSettings(settings);
  cachedAuthState = settings.codexAuth;
}
