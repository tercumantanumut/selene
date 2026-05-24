/**
 * Mirror selene's Codex OAuth token into the CLIProxyAPI sidecar's auth-dir.
 *
 * Selene's existing Codex login (lib/auth/codex-auth.ts) stores the OAuth
 * token under `settings.codexToken`. The sidecar discovers credentials by
 * scanning `auth-dir` for `codex-<email>.json` files matching the upstream
 * `CodexTokenStorage` struct (internal/auth/codex/token.go).
 *
 * Both flows use the same OpenAI OAuth client (`app_EMoamEEZ73f0CkXaXp7hrann`,
 * the Codex CLI app) so the token bytes are interchangeable — we just need
 * to materialise the file in the sidecar's expected layout.
 *
 * Called on every image-gen request (cheap atomic write). Idempotent: if the
 * existing file already carries the current access token, nothing is written.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CODEX_CONFIG,
  decodeCodexJWT,
  ensureValidCodexToken,
  getCodexAuthState,
  getCodexToken,
} from "@/lib/auth/codex-auth";
import { getCliproxyAuthDir } from "./config";

/**
 * Shape of `codex-<email>.json` as read by the sidecar
 * (matches upstream `internal/auth/codex/token.go::CodexTokenStorage`).
 */
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

export interface BridgedCodexCredential {
  filePath: string;
  email: string;
  accountId: string;
}

/**
 * Format a Date as the same RFC3339-with-timezone-offset string CLIProxyAPI
 * uses (e.g. `2026-05-24T20:43:15+03:00`). We deliberately match the upstream
 * format byte-for-byte so the sidecar's auth-watcher recognises the file.
 */
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
  // Upstream `CredentialFileName` keeps the email intact (no escaping); we
  // do the same but defensively guard against path separators / null bytes.
  return email.replace(/[\\/\0]/g, "_");
}

/**
 * Normalize the JWT-reported plan into the suffix upstream uses for filenames.
 * Mirrors `normalizePlanTypeForFilename` in internal/auth/codex/filename.go —
 * lowercased, alphanumeric only. Returns "" when no plan is provided.
 */
function normalizePlanSuffix(planType: string | undefined): string {
  if (!planType) return "";
  const cleaned = planType.toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleaned;
}

function buildCredentialFilename(email: string, planType: string | undefined): string {
  const safeEmail = sanitizeEmailForFilename(email);
  const plan = normalizePlanSuffix(planType);
  if (!plan) return `codex-${safeEmail}.json`;
  // Upstream uses `codex-<email>-<plan>.json` for everything except plan
  // "team" (which adds a hashed account-id prefix); selene only logs into
  // personal accounts so we don't need the team branch yet.
  return `codex-${safeEmail}-${plan}.json`;
}

/** Read the bridged credential file if present. */
function readExistingBridge(filePath: string): CodexCredentialFile | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw) as CodexCredentialFile;
  } catch {
    return null;
  }
}

/**
 * Materialise selene's current Codex token into the sidecar's auth-dir.
 *
 * Returns descriptor of the bridged file, or `null` if selene has no valid
 * Codex token (i.e. the user hasn't logged in / their token can't refresh).
 */
export async function ensureCodexCredentialBridged(): Promise<BridgedCodexCredential | null> {
  const refreshed = await ensureValidCodexToken();
  if (!refreshed) return null;

  const token = getCodexToken();
  if (!token) return null;

  const authState = getCodexAuthState();
  const decoded = decodeCodexJWT(token.access_token);
  const email = (decoded?.email || authState.email || "").trim();
  const accountId = (authState.accountId || decoded?.accountId || "").trim();
  const planType = decoded?.planType;

  if (!email) {
    // Without an email we can't construct the upstream file name.
    console.warn("[cliproxy/codex-bridge] no email on codex token; skipping bridge");
    return null;
  }

  const authDir = getCliproxyAuthDir();
  const filePath = join(authDir, buildCredentialFilename(email, planType));

  const expiredAt = new Date(token.expires_at);
  const refreshedAt = new Date(authState.lastRefresh ?? Date.now());

  const next: CodexCredentialFile = {
    id_token: "",
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    account_id: accountId,
    last_refresh: formatRfc3339WithOffset(refreshedAt),
    email,
    type: "codex",
    expired: formatRfc3339WithOffset(expiredAt),
  };

  const existing = readExistingBridge(filePath);
  if (
    existing
    && existing.access_token === next.access_token
    && existing.refresh_token === next.refresh_token
    && existing.expired === next.expired
  ) {
    return { filePath, email, accountId };
  }

  if (!existsSync(authDir)) mkdirSync(authDir, { recursive: true, mode: 0o700 });
  if (!existsSync(dirname(filePath))) mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });

  writeFileSync(filePath, JSON.stringify(next), { mode: 0o600 });
  return { filePath, email, accountId };
}

// Tiny helpers re-exported for tests that want to bypass selene's settings.
export const __testing = {
  formatRfc3339WithOffset,
  sanitizeEmailForFilename,
  buildCredentialFilename,
  CODEX_BASE_URL: CODEX_CONFIG.API_BASE_URL,
};
