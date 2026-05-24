/**
 * One-time migration of selene's legacy Codex OAuth token into the
 * CLIProxyAPI sidecar's auth-dir.
 *
 * Before the Codex refactor, selene ran its own PKCE OAuth flow and stored
 * the bearer in `settings.codexToken`. After the refactor the sidecar owns
 * the OAuth flow and persists `codex-<email>[-<plan>].json` files itself.
 *
 * To avoid forcing existing users to re-authenticate, this shim runs on
 * every `getCodexAuthStatus()` call:
 *
 *   1. If a `codex-*.json` already exists in the auth-dir, do nothing —
 *      the sidecar is the source of truth.
 *   2. Else, if selene has a `settings.codexToken`, write it to disk in
 *      the upstream `CodexTokenStorage` shape (same OAuth client id, so
 *      the bearer is interchangeable).
 *   3. Else, do nothing — the user needs to log in via `cliproxyapi
 *      -codex-login` (driven from the auth route).
 *
 * Once the sidecar has the file, future refreshes happen inside the
 * sidecar and selene's `settings.codexToken` becomes stale — the
 * `clearCodexAuth()` path deletes it for hygiene but otherwise we leave
 * it in place so users can downgrade gracefully if needed.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadSettings } from "@/lib/settings/settings-manager";
import {
  decodeCodexJWT,
} from "@/lib/auth/codex-auth";
import { getCliproxyAuthDir } from "./config";
import { hasCodexCredential } from "./credentials";

export interface BridgedCodexCredential {
  filePath: string;
  email: string;
  accountId: string;
  plan?: string;
}

interface CodexCredentialFile {
  id_token: string;
  access_token: string;
  refresh_token: string;
  account_id: string;
  last_refresh: string;
  email: string;
  type: "codex";
  expired: string;
}

function formatRfc3339WithOffset(date: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
  const tzMinutes = -date.getTimezoneOffset();
  const sign = tzMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(tzMinutes);
  const tz = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${tz}`
  );
}

function sanitizeEmailForFilename(email: string): string {
  return email.replace(/[\\/\0]/g, "_");
}

function normalizePlanSuffix(planType: string | undefined): string {
  if (!planType) return "";
  return planType.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function buildCredentialFilename(email: string, planType: string | undefined): string {
  const safeEmail = sanitizeEmailForFilename(email);
  const plan = normalizePlanSuffix(planType);
  if (!plan) return `codex-${safeEmail}.json`;
  return `codex-${safeEmail}-${plan}.json`;
}

/**
 * Materialise selene's legacy Codex token into the sidecar's auth-dir if
 * needed. Returns descriptor of the credential (whether bridged or
 * pre-existing), or `null` if nothing is on disk and selene has no token.
 *
 * This call is the side-effect; callers that just want the credential
 * descriptor should use `listCodexCredentials()` from credentials.ts.
 */
export async function ensureCodexCredentialBridged(): Promise<BridgedCodexCredential | null> {
  // Fast path: sidecar already has a credential file → don't overwrite.
  if (await hasCodexCredential()) {
    return null;
  }

  const settings = loadSettings();
  const legacy = settings.codexToken;
  if (!legacy?.access_token || !legacy.refresh_token) {
    return null;
  }

  const decoded = decodeCodexJWT(legacy.access_token);
  const email = (decoded?.email || settings.codexAuth?.email || "").trim();
  const accountId = (decoded?.accountId || settings.codexAuth?.accountId || "").trim();
  const plan = decoded?.planType;

  if (!email) {
    console.warn("[cliproxy/codex-bridge] no email on legacy codex token; skipping migration");
    return null;
  }

  const authDir = getCliproxyAuthDir();
  const filePath = join(authDir, buildCredentialFilename(email, plan));

  const expiredAt = new Date(legacy.expires_at);
  const refreshedAt = new Date(settings.codexAuth?.lastRefresh ?? Date.now());

  const next: CodexCredentialFile = {
    id_token: "",
    access_token: legacy.access_token,
    refresh_token: legacy.refresh_token,
    account_id: accountId,
    last_refresh: formatRfc3339WithOffset(refreshedAt),
    email,
    type: "codex",
    expired: formatRfc3339WithOffset(expiredAt),
  };

  if (!existsSync(authDir)) mkdirSync(authDir, { recursive: true, mode: 0o700 });
  if (!existsSync(dirname(filePath))) mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });

  writeFileSync(filePath, JSON.stringify(next), { mode: 0o600 });
  console.log(`[cliproxy/codex-bridge] migrated legacy settings.codexToken → ${filePath}`);

  return { filePath, email, accountId, plan };
}

// Tiny helpers re-exported for tests that want to bypass selene's settings.
export const __testing = {
  formatRfc3339WithOffset,
  sanitizeEmailForFilename,
  buildCredentialFilename,
};
