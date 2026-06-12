/**
 * Dario sidecar config management for the Claude Code provider.
 *
 * Dario exposes an Anthropic-compatible local proxy. Selene owns the local
 * bind port and API key so it never has to rely on user-global DARIO_* env.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";

// Must not collide with packaged Electron's Next internal port (3457).
export const DARIO_DEFAULT_PORT = 8575;
export const DARIO_HOST = "127.0.0.1";
const DARIO_BASE_URL_PATH = "/v1";

export interface DarioConfigFile {
  /** Directory for Selene-owned Dario runtime metadata. */
  dir: string;
  /** Bearer token clients must send to the local Dario proxy. */
  apiKey: string;
  /** Bind port for the Selene-managed Dario proxy. */
  port: number;
  /** Bind host. Always loopback unless code is explicitly changed. */
  host: string;
}

/**
 * Return the directory Selene uses for Dario-owned local runtime metadata.
 * Honors the same LOCAL_DATA_PATH env used by the rest of Selene storage.
 */
export function getSeleneDarioDir(): string {
  const base = process.env.LOCAL_DATA_PATH
    ? resolve(process.env.LOCAL_DATA_PATH)
    : resolve(process.cwd(), ".local-data");
  return join(base, "dario");
}

function generateApiKey(): string {
  return `selene-dario-${randomBytes(24).toString("hex")}`;
}

function loadOrGenerateApiKey(dir: string): string {
  const keyFile = join(dir, "api-key");
  if (existsSync(keyFile)) {
    const existing = readFileSync(keyFile, "utf8").trim();
    if (existing.length > 0) return existing;
  }

  const fresh = generateApiKey();
  writeFileSync(keyFile, fresh, { mode: 0o600 });
  return fresh;
}

function resolvePort(): number {
  const fromEnv = process.env.SELENE_DARIO_PORT;
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv, 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 65536) {
      return parsed;
    }
  }
  return DARIO_DEFAULT_PORT;
}

/** Materialize Selene's Dario config and return values needed by callers. */
export function ensureDarioConfig(): DarioConfigFile {
  const dir = getSeleneDarioDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  return {
    dir,
    apiKey: loadOrGenerateApiKey(dir),
    port: resolvePort(),
    host: DARIO_HOST,
  };
}

export function getDarioOrigin(port = resolvePort(), host = DARIO_HOST): string {
  return `http://${host}:${port}`;
}

export function getDarioBaseUrl(port = resolvePort(), host = DARIO_HOST): string {
  return `${getDarioOrigin(port, host)}${DARIO_BASE_URL_PATH}`;
}

export function darioAuthHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}
