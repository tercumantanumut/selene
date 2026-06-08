import { loadSettings, saveSettings } from "@/lib/settings/settings-manager";

export interface KimiOAuthToken {
  type: "oauth";
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

interface KimiAuthState {
  isAuthenticated: boolean;
  email?: string;
  expiresAt?: number;
  lastRefresh?: number;
}

export const KIMI_OAUTH = {
  CLIENT_ID: "17e5f671-d194-4dfb-9706-5516cb48c098",
  DEVICE_AUTH_URL: "https://auth.kimi.com/api/oauth/device_authorization",
  TOKEN_URL: "https://auth.kimi.com/api/oauth/token",
  GRANT_TYPE_DEVICE: "urn:ietf:params:oauth:grant-type:device_code",
} as const;

export const KIMI_OAUTH_CONFIG = {
  API_BASE_URL: "https://api.kimi.com/coding/v1",
  REFRESH_THRESHOLD_MS: 15 * 60 * 1000,
  POLL_INTERVAL_MS: 5000,
  POLL_TIMEOUT_MS: 5 * 60 * 1000,
  VERSION: "1.12.0",
  PLATFORM: "kimi_cli",
} as const;

let cachedAuthState: KimiAuthState | null = null;
let cachedToken: KimiOAuthToken | null = null;
let refreshInFlight: Promise<boolean> | null = null;

export function getKimiAuthState(): KimiAuthState {
  if (cachedAuthState) return cachedAuthState;

  const settings = loadSettings();
  const state: KimiAuthState = {
    isAuthenticated: !!settings.kimiAuth?.isAuthenticated,
    email: settings.kimiAuth?.email,
    expiresAt: settings.kimiAuth?.expiresAt,
    lastRefresh: settings.kimiAuth?.lastRefresh,
  };

  cachedAuthState = state;
  return state;
}

export function getKimiOAuthToken(): KimiOAuthToken | null {
  if (cachedToken) return cachedToken;

  const settings = loadSettings();
  if (!settings.kimiToken) return null;

  cachedToken = settings.kimiToken;
  return cachedToken;
}

function isKimiTokenValid(): boolean {
  const token = getKimiOAuthToken();
  if (!token) return false;

  // Token is valid if not fully expired. The 15-min refresh threshold
  // is only used by needsKimiTokenRefresh() to trigger background refresh,
  // not to deny authentication status.
  return token.expires_at > Date.now();
}

export function needsKimiTokenRefresh(): boolean {
  const token = getKimiOAuthToken();
  if (!token) return false;

  const now = Date.now();
  const expiresAt = token.expires_at;
  return expiresAt <= (now + KIMI_OAUTH_CONFIG.REFRESH_THRESHOLD_MS) && expiresAt > now;
}

export function saveKimiOAuthToken(
  token: KimiOAuthToken,
  email?: string,
  setAsActiveProvider = false
): void {
  const settings = loadSettings();

  settings.kimiToken = token;

  settings.kimiAuth = {
    isAuthenticated: true,
    email: email || settings.kimiAuth?.email,
    expiresAt: token.expires_at,
    lastRefresh: Date.now(),
  };

  // Only switch active provider during explicit user-driven auth flows.
  // Token refresh must not mutate provider selection.
  if (setAsActiveProvider) {
    settings.llmProvider = "kimi";
  }

  saveSettings(settings);

  cachedToken = token;
  cachedAuthState = settings.kimiAuth;
}

export function clearKimiAuth(): void {
  const settings = loadSettings();
  delete settings.kimiToken;
  settings.kimiAuth = { isAuthenticated: false };
  saveSettings(settings);

  cachedToken = null;
  cachedAuthState = { isAuthenticated: false };
}

export function invalidateKimiAuthCache(): void {
  cachedToken = null;
  cachedAuthState = null;
}

export function getKimiAccessToken(): string | null {
  const token = getKimiOAuthToken();
  if (!token) return null;

  if (token.expires_at <= Date.now()) {
    return null;
  }

  return token.access_token;
}

export function isKimiOAuthAuthenticated(): boolean {
  const state = getKimiAuthState();
  if (!state.isAuthenticated) return false;
  return isKimiTokenValid();
}

/**
 * Force-expire the local token so the next availability check sees it as
 * invalid and triggers a refresh.  This is used when the Kimi API rejects
 * the access token mid-stream (server-side revocation / early expiry).
 */
export function forceExpireKimiToken(): void {
  const token = getKimiOAuthToken();
  if (!token) return;

  // Preserve the refresh_token so the next request can still refresh.
  const expired: KimiOAuthToken = { ...token, expires_at: 0 };
  saveKimiOAuthToken(expired);

  console.warn("[KimiAuth] Local token force-expired for proactive refresh on next request");
}

export async function refreshKimiToken(): Promise<boolean> {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = refreshKimiTokenInternal().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

async function refreshKimiTokenInternal(): Promise<boolean> {
  const token = getKimiOAuthToken();
  if (!token?.refresh_token) {
    return false;
  }

  try {
    // Include the same device headers used during the initial device-code
    // grant — Kimi's OAuth server may require them for refresh requests too.
    const deviceHeaders = getKimiDeviceHeaders();
    const response = await fetch(KIMI_OAUTH.TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...deviceHeaders,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        client_id: KIMI_OAUTH.CLIENT_ID,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[KimiAuth] Token refresh failed:", response.status, errorText);
      // 401/403 means the refresh token is revoked/invalid — clear stale auth
      if (response.status === 401 || response.status === 403) {
        clearKimiAuth();
      }
      return false;
    }

    const data = await response.json() as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (!data.access_token || !data.refresh_token || typeof data.expires_in !== "number") {
      console.error("[KimiAuth] Token refresh response missing fields:", Object.keys(data));
      return false;
    }

    const newToken: KimiOAuthToken = {
      type: "oauth",
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };

    saveKimiOAuthToken(newToken);

    // Invalidate the cached client so it picks up the new token.
    try {
      const { invalidateKimiClient } = await import("@/lib/ai/providers/kimi-client");
      invalidateKimiClient();
    } catch {
      // Non-fatal — client will be recreated on next use regardless.
    }

    return true;
  } catch (error) {
    console.error("[KimiAuth] Token refresh error:", error);
    return false;
  }
}

export async function ensureValidKimiToken(): Promise<boolean> {
  if (needsKimiTokenRefresh()) {
    return refreshKimiToken();
  }

  if (isKimiTokenValid()) return true;

  // Token is fully expired but we still have a refresh_token — attempt refresh.
  const token = getKimiOAuthToken();
  if (token?.refresh_token) {
    return refreshKimiToken();
  }

  return false;
}

export function getOrCreateKimiDeviceId(): string {
  const settings = loadSettings();

  if (settings.kimiDeviceId) {
    return settings.kimiDeviceId;
  }

  const deviceId = crypto.randomUUID();
  settings.kimiDeviceId = deviceId;
  saveSettings(settings);

  return deviceId;
}

export function getKimiDeviceHeaders(): Record<string, string> {
  const os = require("os");
  const deviceId = getOrCreateKimiDeviceId();
  return {
    "User-Agent": `KimiCLI/${KIMI_OAUTH_CONFIG.VERSION}`,
    "X-Msh-Platform": KIMI_OAUTH_CONFIG.PLATFORM,
    "X-Msh-Device-Id": deviceId,
    "X-Msh-Version": KIMI_OAUTH_CONFIG.VERSION,
    "X-Msh-Device-Name": os.hostname(),
    "X-Msh-Device-Model": `${process.platform} ${process.arch}`,
    "X-Msh-Os-Version": os.release(),
  };
}

export async function initiateKimiDeviceAuth(): Promise<{
  user_code: string;
  device_code: string;
  verification_uri_complete: string;
  interval: number;
  expires_in: number;
} | null> {
  try {
    const deviceHeaders = getKimiDeviceHeaders();
    const response = await fetch(KIMI_OAUTH.DEVICE_AUTH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...deviceHeaders,
      },
      body: new URLSearchParams({
        client_id: KIMI_OAUTH.CLIENT_ID,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[KimiAuth] Device authorization failed:", response.status, errorText);
      return null;
    }

    const data = await response.json() as {
      user_code?: string;
      device_code?: string;
      verification_uri_complete?: string;
      interval?: number;
      expires_in?: number;
    };

    if (!data.user_code || !data.device_code || !data.verification_uri_complete) {
      console.error("[KimiAuth] Device authorization response missing fields:", Object.keys(data));
      return null;
    }

    return {
      user_code: data.user_code,
      device_code: data.device_code,
      verification_uri_complete: data.verification_uri_complete,
      interval: data.interval ?? 5,
      expires_in: data.expires_in ?? 300,
    };
  } catch (error) {
    console.error("[KimiAuth] Device authorization error:", error);
    return null;
  }
}

export async function pollKimiDeviceToken(
  deviceCode: string
): Promise<{ status: "pending" | "slow_down" | "success" | "error"; token?: KimiOAuthToken; error?: string }> {
  try {
    const deviceHeaders = getKimiDeviceHeaders();
    const response = await fetch(KIMI_OAUTH.TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...deviceHeaders,
      },
      body: new URLSearchParams({
        grant_type: KIMI_OAUTH.GRANT_TYPE_DEVICE,
        client_id: KIMI_OAUTH.CLIENT_ID,
        device_code: deviceCode,
      }),
    });

    if (response.status === 400) {
      const errorData = await response.json() as { error?: string };
      if (errorData.error === "authorization_pending") {
        return { status: "pending" };
      }
      if (errorData.error === "slow_down") {
        return { status: "slow_down" };
      }
      return { status: "error", error: errorData.error || "Unknown error" };
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[KimiAuth] Device token poll failed:", response.status, errorText);
      return { status: "error", error: `HTTP ${response.status}: ${errorText}` };
    }

    const data = await response.json() as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (!data.access_token || !data.refresh_token || typeof data.expires_in !== "number") {
      console.error("[KimiAuth] Device token poll response missing fields:", Object.keys(data));
      return { status: "error", error: "Response missing required fields" };
    }

    const token: KimiOAuthToken = {
      type: "oauth",
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };

    return { status: "success", token };
  } catch (error) {
    console.error("[KimiAuth] Device token poll error:", error);
    return { status: "error", error: String(error) };
  }
}
