import { loadSettings, saveSettings } from "@/lib/settings/settings-manager";

export interface CodexOAuthToken {
  type: "oauth";
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

interface CodexAuthState {
  isAuthenticated: boolean;
  email?: string;
  accountId?: string;
  expiresAt?: number;
  lastRefresh?: number;
}

export const CODEX_OAUTH = {
  CLIENT_ID: "app_EMoamEEZ73f0CkXaXp7hrann",
  AUTH_URL: "https://auth.openai.com/oauth/authorize",
  TOKEN_URL: "https://auth.openai.com/oauth/token",
  REDIRECT_URI: "http://localhost:1455/auth/callback",
  SCOPES: "openid profile email offline_access",
} as const;

export const CODEX_CONFIG = {
  API_BASE_URL: "https://chatgpt.com/backend-api",
  API_PATH: "/codex/responses",
  REFRESH_THRESHOLD_MS: 15 * 60 * 1000,
  HEADERS: {
    originator: "codex_cli_rs",
  } as const,
  JWT_CLAIM_PATH: "https://api.openai.com/auth",
  /** OpenAI namespaces profile claims (email, name) under this URI. */
  JWT_PROFILE_CLAIM_PATH: "https://api.openai.com/profile",
} as const;

let cachedAuthState: CodexAuthState | null = null;
let cachedToken: CodexOAuthToken | null = null;

function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

export function decodeCodexJWT(
  token: string,
): { accountId?: string; email?: string; planType?: string } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(decodeBase64Url(parts[1]));
    const auth = payload?.[CODEX_CONFIG.JWT_CLAIM_PATH] ?? {};
    const profile = payload?.[CODEX_CONFIG.JWT_PROFILE_CLAIM_PATH] ?? {};
    // OpenAI puts email under the namespaced profile claim; tolerate the
    // top-level `email` field too for older issuer behaviour.
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

export function getCodexAuthState(): CodexAuthState {
  if (cachedAuthState) return cachedAuthState;

  const settings = loadSettings();
  const state: CodexAuthState = {
    isAuthenticated: !!settings.codexAuth?.isAuthenticated,
    email: settings.codexAuth?.email,
    accountId: settings.codexAuth?.accountId,
    expiresAt: settings.codexAuth?.expiresAt,
    lastRefresh: settings.codexAuth?.lastRefresh,
  };

  cachedAuthState = state;
  return state;
}

export function getCodexToken(): CodexOAuthToken | null {
  if (cachedToken) return cachedToken;

  const settings = loadSettings();
  if (!settings.codexToken) return null;

  cachedToken = settings.codexToken;
  return cachedToken;
}

function isCodexTokenValid(): boolean {
  const token = getCodexToken();
  if (!token) return false;

  const now = Date.now();
  return token.expires_at > (now + CODEX_CONFIG.REFRESH_THRESHOLD_MS);
}

export function needsCodexTokenRefresh(): boolean {
  const token = getCodexToken();
  if (!token) return false;

  const now = Date.now();
  const expiresAt = token.expires_at;
  return expiresAt <= (now + CODEX_CONFIG.REFRESH_THRESHOLD_MS) && expiresAt > now;
}

export function saveCodexToken(
  token: CodexOAuthToken,
  email?: string,
  accountId?: string,
  setAsActiveProvider = false
): void {
  const settings = loadSettings();

  settings.codexToken = token;

  settings.codexAuth = {
    isAuthenticated: true,
    email: email || settings.codexAuth?.email,
    accountId: accountId || settings.codexAuth?.accountId,
    expiresAt: token.expires_at,
    lastRefresh: Date.now(),
  };

  // Only switch active provider during explicit user-driven auth flows.
  // Token refresh must not mutate provider selection.
  if (setAsActiveProvider) {
    settings.llmProvider = "codex";
  }

  saveSettings(settings);

  cachedToken = token;
  cachedAuthState = settings.codexAuth;
}

export function clearCodexAuth(): void {
  const settings = loadSettings();
  delete settings.codexToken;
  settings.codexAuth = { isAuthenticated: false };
  saveSettings(settings);

  cachedToken = null;
  cachedAuthState = { isAuthenticated: false };
}

export function invalidateCodexAuthCache(): void {
  cachedToken = null;
  cachedAuthState = null;
}

export function getCodexAccessToken(): string | null {
  const token = getCodexToken();
  if (!token) return null;

  if (token.expires_at <= Date.now()) {
    return null;
  }

  return token.access_token;
}

export function isCodexAuthenticated(): boolean {
  const state = getCodexAuthState();
  if (!state.isAuthenticated) return false;
  return isCodexTokenValid();
}

export async function refreshCodexToken(): Promise<boolean> {
  const token = getCodexToken();
  if (!token?.refresh_token) {
    return false;
  }

  try {
    const response = await fetch(CODEX_OAUTH.TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        client_id: CODEX_OAUTH.CLIENT_ID,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[CodexAuth] Token refresh failed:", response.status, errorText);
      return false;
    }

    const data = await response.json() as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (!data.access_token || !data.refresh_token || typeof data.expires_in !== "number") {
      console.error("[CodexAuth] Token refresh response missing fields:", data);
      return false;
    }

    const decoded = decodeCodexJWT(data.access_token);
    const newToken: CodexOAuthToken = {
      type: "oauth",
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };

    saveCodexToken(newToken, decoded?.email, decoded?.accountId);
    return true;
  } catch (error) {
    console.error("[CodexAuth] Token refresh error:", error);
    return false;
  }
}

export async function ensureValidCodexToken(): Promise<boolean> {
  if (isCodexTokenValid()) return true;
  if (needsCodexTokenRefresh()) {
    return refreshCodexToken();
  }
  return false;
}

export async function exchangeCodexAuthorizationCode(
  code: string,
  verifier: string,
  redirectUri: string = CODEX_OAUTH.REDIRECT_URI,
): Promise<{ access_token: string; refresh_token: string; expires_in: number } | null> {
  const response = await fetch(CODEX_OAUTH.TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CODEX_OAUTH.CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error("[CodexAuth] Code exchange failed:", response.status, text);
    return null;
  }

  const data = await response.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!data.access_token || !data.refresh_token || typeof data.expires_in !== "number") {
    console.error("[CodexAuth] Code exchange response missing fields:", data);
    return null;
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
  };
}
