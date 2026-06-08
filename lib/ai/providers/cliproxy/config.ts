/**
 * CLIProxyAPI sidecar config management.
 *
 * The sidecar reads a YAML config file at startup. We keep a selene-owned
 * config under the writable user-data dir so the bundled Homebrew default
 * (which lives in /opt/homebrew/etc) isn't mutated, and so the host port and
 * generated API key survive restarts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

export const CLIPROXY_DEFAULT_PORT = 8317;
export const CLIPROXY_HOST = "127.0.0.1";
export const CLIPROXY_BASE_URL_PATH = "/v1";

interface CliproxyConfigFile {
  /** Absolute path to the YAML config the sidecar should be launched with. */
  configPath: string;
  /** Bearer token clients must send to the sidecar. */
  apiKey: string;
  /** Bind port. */
  port: number;
  /** Filesystem dir where OAuth tokens for Claude/Codex/etc. are persisted. */
  authDir: string;
}

/**
 * Return the directory selene uses for sidecar-owned files (config + key cache).
 * Honors the same `LOCAL_DATA_PATH` env that the rest of selene's storage layer
 * uses; falls back to `<cwd>/.local-data` in dev.
 */
function getSeleneCliproxyDir(): string {
  const base = process.env.LOCAL_DATA_PATH
    ? resolve(process.env.LOCAL_DATA_PATH)
    : resolve(process.cwd(), ".local-data");
  return join(base, "cliproxy");
}

/**
 * Where CLIProxyAPI saves OAuth tokens.
 * Default to the upstream-shared `~/.cli-proxy-api` so other CLIProxyAPI-aware
 * tools on the machine reuse the same credential set. Override with
 * `SELENE_CLIPROXY_AUTH_DIR` to isolate per-app.
 */
export function getCliproxyAuthDir(): string {
  const override = process.env.SELENE_CLIPROXY_AUTH_DIR?.trim();
  if (override) return resolve(override);
  return join(homedir(), ".cli-proxy-api");
}

function generateApiKey(): string {
  return `selene-${randomBytes(24).toString("hex")}`;
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
  const fromEnv = process.env.SELENE_CLIPROXY_PORT;
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv, 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 65536) {
      return parsed;
    }
  }
  return CLIPROXY_DEFAULT_PORT;
}

function buildConfigYaml(apiKey: string, port: number, authDir: string): string {
  // Minimal config — only the keys we set explicitly. Everything else is
  // upstream default. Localhost-only bind for safety.
  //
  // Debug + file logging default ON so the dev-logs viewer and the
  // rotating files under `auth-dir/logs/` both capture the request/response
  // stream when a user reports "the model is acting weird". Override both
  // with `SELENE_CLIPROXY_DEBUG=0` in production builds if needed.
  const debugEnabled = process.env.SELENE_CLIPROXY_DEBUG !== "0";
  return [
    `# selene-managed CLIProxyAPI config — do not edit by hand`,
    `host: "${CLIPROXY_HOST}"`,
    `port: ${port}`,
    `auth-dir: "${authDir}"`,
    `api-keys:`,
    `  - "${apiKey}"`,
    `usage-statistics-enabled: false`,
    `logging-to-file: ${debugEnabled ? "true" : "false"}`,
    `debug: ${debugEnabled ? "true" : "false"}`,
    ``,
  ].join("\n");
}

/**
 * Materialize the sidecar config on disk and return everything callers need
 * to spawn the sidecar and talk to it.
 *
 * Idempotent: a stable API key is generated once on first call and reused.
 */
export function ensureCliproxyConfig(): CliproxyConfigFile {
  const dir = getSeleneCliproxyDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const apiKey = loadOrGenerateApiKey(dir);
  const port = resolvePort();
  const authDir = getCliproxyAuthDir();
  const configPath = join(dir, "config.yaml");

  writeFileSync(configPath, buildConfigYaml(apiKey, port, authDir), { mode: 0o600 });

  return { configPath, apiKey, port, authDir };
}

export function getCliproxyBaseUrl(port = resolvePort()): string {
  return `http://${CLIPROXY_HOST}:${port}${CLIPROXY_BASE_URL_PATH}`;
}
