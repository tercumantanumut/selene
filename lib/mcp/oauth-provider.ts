/**
 * File-backed OAuth provider for Streamable HTTP MCP servers.
 *
 * The MCP SDK owns OAuth discovery, dynamic client registration, PKCE, token
 * exchange, and refresh. This module supplies the persistent provider that the
 * SDK needs so browser sign-in can span separate HTTP requests and app restarts.
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export type MCPOAuthConnectionState =
  | "unauthenticated"
  | "authorization_required"
  | "authorizing"
  | "connected"
  | "expired"
  | "failed";

export interface MCPOAuthStatus {
  serverName: string;
  serverUrl: string;
  authState: MCPOAuthConnectionState;
  hasTokens: boolean;
  authorizationUrl?: string;
  lastError?: string;
  tokenExpiresAt?: number;
  updatedAt?: number;
}

interface StoredMCPOAuthRecord {
  serverName: string;
  serverUrl: string;
  redirectUrl: string;
  createdAt: number;
  updatedAt: number;
  state?: string;
  stateCreatedAt?: number;
  codeVerifier?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  tokenSavedAt?: number;
  tokenExpiresAt?: number;
  authorizationUrl?: string;
  authorizationStartedAt?: number;
  authState?: MCPOAuthConnectionState;
  lastError?: string;
  discoveryState?: OAuthDiscoveryState;
}

const OAUTH_DIR_NAME = "mcp-oauth";
const PENDING_STATE_MAX_AGE_MS = 15 * 60 * 1000;
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;

function getDataDir(): string {
  if (process.env.LOCAL_DATA_PATH) return process.env.LOCAL_DATA_PATH;
  if (process.env.ELECTRON_USER_DATA_PATH) {
    return path.join(process.env.ELECTRON_USER_DATA_PATH, "data");
  }
  return path.join(os.homedir(), ".selene", "data");
}

function getOAuthDir(): string {
  return path.join(getDataDir(), OAUTH_DIR_NAME);
}

function ensureOAuthDir(): string {
  const dir = getOAuthDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Non-POSIX platforms may ignore chmod. Directory still lives in user data.
  }
  return dir;
}

function hashServer(serverName: string, serverUrl: string): string {
  return crypto
    .createHash("sha256")
    .update(`${serverName}\0${serverUrl}`)
    .digest("hex")
    .slice(0, 32);
}

function recordPath(serverName: string, serverUrl: string): string {
  return path.join(ensureOAuthDir(), `${hashServer(serverName, serverUrl)}.json`);
}

function readJsonFile<T>(filePath: string): T | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    console.warn(`[MCP OAuth] Failed to read ${filePath}:`, error);
    return undefined;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  ensureOAuthDir();
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(tmpPath, 0o600);
  } catch {
    // Best effort only on non-POSIX platforms.
  }
  fs.renameSync(tmpPath, filePath);
}

function defaultRecord(serverName: string, serverUrl: string, redirectUrl: string): StoredMCPOAuthRecord {
  const now = Date.now();
  return {
    serverName,
    serverUrl,
    redirectUrl,
    createdAt: now,
    updatedAt: now,
    authState: "unauthenticated",
  };
}

function readRecord(serverName: string, serverUrl: string): StoredMCPOAuthRecord | undefined {
  return readJsonFile<StoredMCPOAuthRecord>(recordPath(serverName, serverUrl));
}

function saveRecord(record: StoredMCPOAuthRecord): void {
  writeJsonFile(recordPath(record.serverName, record.serverUrl), {
    ...record,
    updatedAt: Date.now(),
  });
}

function updateRecord(
  serverName: string,
  serverUrl: string,
  redirectUrl: string,
  patch: Partial<StoredMCPOAuthRecord>,
): StoredMCPOAuthRecord {
  const existing = readRecord(serverName, serverUrl) ?? defaultRecord(serverName, serverUrl, redirectUrl);
  const next: StoredMCPOAuthRecord = {
    ...existing,
    serverName,
    serverUrl,
    redirectUrl: patch.redirectUrl ?? existing.redirectUrl ?? redirectUrl,
    ...patch,
    updatedAt: Date.now(),
  };
  saveRecord(next);
  return next;
}

function isExpired(record?: StoredMCPOAuthRecord): boolean {
  if (!record?.tokens || !record.tokenExpiresAt) return false;
  return Date.now() >= record.tokenExpiresAt - TOKEN_EXPIRY_SKEW_MS;
}

function inferStatus(record: StoredMCPOAuthRecord | undefined, serverName: string, serverUrl: string): MCPOAuthStatus {
  if (!record) {
    return { serverName, serverUrl, authState: "unauthenticated", hasTokens: false };
  }

  const hasTokens = Boolean(record.tokens?.access_token);
  let authState: MCPOAuthConnectionState = record.authState ?? "unauthenticated";

  if (hasTokens) {
    authState = isExpired(record) ? "expired" : "connected";
  } else if (record.authorizationUrl) {
    authState = record.authState === "authorizing" ? "authorizing" : "authorization_required";
  } else if (record.lastError) {
    authState = "failed";
  }

  return {
    serverName,
    serverUrl,
    authState,
    hasTokens,
    authorizationUrl: record.authorizationUrl,
    lastError: record.lastError,
    tokenExpiresAt: record.tokenExpiresAt,
    updatedAt: record.updatedAt,
  };
}

function shouldLogOAuthEvent(serverName: string, serverUrl: string): boolean {
  const target = `${serverName} ${serverUrl}`.toLowerCase();
  return process.env.MCP_OAUTH_DEBUG === "1" || target.includes("mobbin");
}

function summarizeRecord(record: StoredMCPOAuthRecord | undefined) {
  const clientAuthMethod = record?.clientInformation && "token_endpoint_auth_method" in record.clientInformation
    ? record.clientInformation.token_endpoint_auth_method
    : undefined;

  return {
    authState: record?.authState ?? "unauthenticated",
    authorizationUrlPresent: Boolean(record?.authorizationUrl),
    codeVerifierPresent: Boolean(record?.codeVerifier),
    clientInformationPresent: Boolean(record?.clientInformation?.client_id),
    clientSecretPresent: Boolean(record?.clientInformation?.client_secret),
    clientAuthMethod,
    hasAccessToken: Boolean(record?.tokens?.access_token),
    hasRefreshToken: Boolean(record?.tokens?.refresh_token),
    tokenType: record?.tokens?.token_type,
    tokenExpiresAt: record?.tokenExpiresAt,
    updatedAt: record?.updatedAt,
    lastError: record?.lastError,
  };
}

function logOAuthEvent(
  event: string,
  serverName: string,
  serverUrl: string,
  record?: StoredMCPOAuthRecord,
  extra?: Record<string, unknown>,
): void {
  if (!shouldLogOAuthEvent(serverName, serverUrl)) return;
  console.info(`[MCP OAuth] ${event}`, {
    serverName,
    serverUrl,
    ...summarizeRecord(record),
    ...extra,
  });
}

function listRecords(): StoredMCPOAuthRecord[] {
  try {
    const dir = ensureOAuthDir();
    return fs
      .readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => readJsonFile<StoredMCPOAuthRecord>(path.join(dir, file)))
      .filter((record): record is StoredMCPOAuthRecord => Boolean(record?.serverName && record.serverUrl));
  } catch {
    return [];
  }
}

function findRecordByState(state: string): StoredMCPOAuthRecord | undefined {
  const now = Date.now();
  return listRecords().find(
    (record) =>
      record.state === state &&
      Boolean(record.stateCreatedAt) &&
      now - (record.stateCreatedAt ?? 0) <= PENDING_STATE_MAX_AGE_MS,
  );
}

export function buildDefaultMCPOAuthRedirectUrl(requestUrl?: string): string {
  const productionPort = process.env.SELENE_PRODUCTION_BUILD === "1" ? process.env.PORT : undefined;
  if (productionPort) {
    return `http://127.0.0.1:${productionPort}/api/mcp/oauth/callback`;
  }

  if (requestUrl) {
    const parsed = new URL(requestUrl);
    const protocol = parsed.protocol === "https:" && parsed.hostname === "127.0.0.1" ? "http:" : parsed.protocol;
    const hostname = parsed.hostname === "localhost" ? "127.0.0.1" : parsed.hostname;
    return `${protocol}//${hostname}${parsed.port ? `:${parsed.port}` : ""}/api/mcp/oauth/callback`;
  }

  const port = process.env.PORT || "3000";
  return `http://127.0.0.1:${port}/api/mcp/oauth/callback`;
}

export class FileBackedMCPOAuthProvider implements OAuthClientProvider {
  readonly clientMetadataUrl?: string;

  private readonly serverName: string;
  private readonly serverUrl: string;
  private readonly _redirectUrl: string;
  private readonly onAuthorizationUrl?: (authorizationUrl: URL) => void | Promise<void>;

  constructor(options: {
    serverName: string;
    serverUrl: string;
    redirectUrl: string;
    clientMetadataUrl?: string;
    onAuthorizationUrl?: (authorizationUrl: URL) => void | Promise<void>;
  }) {
    this.serverName = options.serverName;
    this.serverUrl = options.serverUrl;
    this._redirectUrl = options.redirectUrl;
    this.clientMetadataUrl = options.clientMetadataUrl;
    this.onAuthorizationUrl = options.onAuthorizationUrl;
  }

  get redirectUrl(): string {
    return this._redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Selene MCP Client",
      redirect_uris: [this._redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    };
  }

  state(): string {
    const state = crypto.randomBytes(24).toString("base64url");
    updateRecord(this.serverName, this.serverUrl, this._redirectUrl, {
      state,
      stateCreatedAt: Date.now(),
      authState: "authorization_required",
      lastError: undefined,
    });
    return state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return readRecord(this.serverName, this.serverUrl)?.clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    const record = updateRecord(this.serverName, this.serverUrl, this._redirectUrl, { clientInformation });
    logOAuthEvent("client_information_saved", this.serverName, this.serverUrl, record);
  }

  tokens(): OAuthTokens | undefined {
    const record = readRecord(this.serverName, this.serverUrl);
    logOAuthEvent("tokens_loaded_for_transport", this.serverName, this.serverUrl, record);
    return record?.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    const now = Date.now();
    const record = updateRecord(this.serverName, this.serverUrl, this._redirectUrl, {
      tokens,
      tokenSavedAt: now,
      tokenExpiresAt: typeof tokens.expires_in === "number" ? now + tokens.expires_in * 1000 : undefined,
      authorizationUrl: undefined,
      authorizationStartedAt: undefined,
      codeVerifier: undefined,
      state: undefined,
      stateCreatedAt: undefined,
      authState: "connected",
      lastError: undefined,
    });
    logOAuthEvent("tokens_saved", this.serverName, this.serverUrl, record);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const record = updateRecord(this.serverName, this.serverUrl, this._redirectUrl, {
      authorizationUrl: authorizationUrl.toString(),
      authorizationStartedAt: Date.now(),
      authState: "authorization_required",
      lastError: undefined,
    });
    logOAuthEvent("authorization_url_saved", this.serverName, this.serverUrl, record);
    await this.onAuthorizationUrl?.(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    updateRecord(this.serverName, this.serverUrl, this._redirectUrl, { codeVerifier });
  }

  codeVerifier(): string {
    const codeVerifier = readRecord(this.serverName, this.serverUrl)?.codeVerifier;
    if (!codeVerifier) {
      throw new Error(`No OAuth code verifier saved for MCP server "${this.serverName}"`);
    }
    return codeVerifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    const patch: Partial<StoredMCPOAuthRecord> = {
      lastError: undefined,
    };

    if (scope === "all" || scope === "client") patch.clientInformation = undefined;
    if (scope === "all" || scope === "tokens") {
      patch.tokens = undefined;
      patch.tokenSavedAt = undefined;
      patch.tokenExpiresAt = undefined;
      patch.authState = "unauthenticated";
    }
    if (scope === "all" || scope === "verifier") {
      patch.codeVerifier = undefined;
      patch.authorizationUrl = undefined;
      patch.authorizationStartedAt = undefined;
      patch.state = undefined;
      patch.stateCreatedAt = undefined;
    }
    if (scope === "all" || scope === "discovery") patch.discoveryState = undefined;

    updateRecord(this.serverName, this.serverUrl, this._redirectUrl, patch);
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    updateRecord(this.serverName, this.serverUrl, this._redirectUrl, { discoveryState: state });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return readRecord(this.serverName, this.serverUrl)?.discoveryState;
  }
}

export function createMCPOAuthProvider(options: {
  serverName: string;
  serverUrl: string;
  redirectUrl?: string;
  requestUrl?: string;
  onAuthorizationUrl?: (authorizationUrl: URL) => void | Promise<void>;
}): FileBackedMCPOAuthProvider {
  return new FileBackedMCPOAuthProvider({
    serverName: options.serverName,
    serverUrl: options.serverUrl,
    redirectUrl: options.redirectUrl ?? buildDefaultMCPOAuthRedirectUrl(options.requestUrl),
    onAuthorizationUrl: options.onAuthorizationUrl,
  });
}

export function getMCPOAuthStatus(serverName: string, serverUrl: string): MCPOAuthStatus {
  return inferStatus(readRecord(serverName, serverUrl), serverName, serverUrl);
}

export function markMCPOAuthAuthorizing(serverName: string, serverUrl: string): MCPOAuthStatus {
  const existing = readRecord(serverName, serverUrl);
  if (!existing) return getMCPOAuthStatus(serverName, serverUrl);
  const next = { ...existing, authState: "authorizing" as const, updatedAt: Date.now() };
  saveRecord(next);
  logOAuthEvent("authorization_marked_authorizing", serverName, serverUrl, next);
  return getMCPOAuthStatus(serverName, serverUrl);
}

export function clearMCPOAuthForServer(serverName: string, serverUrl: string): void {
  try {
    const filePath = recordPath(serverName, serverUrl);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (error) {
    console.warn(`[MCP OAuth] Failed to clear OAuth record for ${serverName}:`, error);
  }
}

export function clearMCPOAuthForUrl(serverUrl: string): number {
  let deleted = 0;
  for (const record of listRecords()) {
    if (record.serverUrl !== serverUrl) continue;
    try {
      const filePath = recordPath(record.serverName, record.serverUrl);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        deleted += 1;
      }
    } catch (error) {
      console.warn(`[MCP OAuth] Failed to clear OAuth record for ${record.serverName}:`, error);
    }
  }
  return deleted;
}

export function clearAllMCPOAuth(): number {
  let deleted = 0;
  for (const record of listRecords()) {
    try {
      const filePath = recordPath(record.serverName, record.serverUrl);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        deleted += 1;
      }
    } catch (error) {
      console.warn(`[MCP OAuth] Failed to clear OAuth record for ${record.serverName}:`, error);
    }
  }
  return deleted;
}

export async function completeMCPOAuthCallback(options: {
  state: string;
  authorizationCode: string;
}): Promise<MCPOAuthStatus> {
  const record = findRecordByState(options.state);
  if (!record) {
    throw new Error("OAuth callback state is unknown or expired. Start authorization again from Settings → MCP.");
  }

  const provider = new FileBackedMCPOAuthProvider({
    serverName: record.serverName,
    serverUrl: record.serverUrl,
    redirectUrl: record.redirectUrl,
  });

  try {
    logOAuthEvent("callback_exchange_started", record.serverName, record.serverUrl, record);
    const result = await auth(provider, {
      serverUrl: record.serverUrl,
      authorizationCode: options.authorizationCode,
    });

    if (result !== "AUTHORIZED") {
      throw new Error("OAuth authorization did not complete.");
    }

    const updatedRecord = readRecord(record.serverName, record.serverUrl);
    logOAuthEvent("callback_exchange_completed", record.serverName, record.serverUrl, updatedRecord);
    return getMCPOAuthStatus(record.serverName, record.serverUrl);
  } catch (error) {
    const failedRecord = updateRecord(record.serverName, record.serverUrl, record.redirectUrl, {
      authState: "failed",
      lastError: error instanceof Error ? error.message : String(error),
    });
    logOAuthEvent("callback_exchange_failed", record.serverName, record.serverUrl, failedRecord);
    throw error;
  }
}

export function failMCPOAuthCallback(state: string | undefined, errorMessage: string): void {
  if (!state) return;
  const record = findRecordByState(state);
  if (!record) return;
  const failedRecord = updateRecord(record.serverName, record.serverUrl, record.redirectUrl, {
    authState: "failed",
    lastError: errorMessage,
  });
  logOAuthEvent("callback_failed", record.serverName, record.serverUrl, failedRecord);
}
