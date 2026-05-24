import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const codexAuthMocks = vi.hoisted(() => ({
  ensureValidCodexToken: vi.fn(async () => true),
  getCodexToken: vi.fn(() => ({
    type: "oauth" as const,
    access_token: "sk-test-access",
    refresh_token: "sk-test-refresh",
    expires_at: Date.UTC(2030, 0, 1, 0, 0, 0),
  })),
  getCodexAuthState: vi.fn(() => ({
    isAuthenticated: true,
    email: "user@example.com",
    accountId: "acct-123",
    expiresAt: Date.UTC(2030, 0, 1, 0, 0, 0),
    lastRefresh: Date.UTC(2026, 0, 1, 0, 0, 0),
  })),
  decodeCodexJWT: vi.fn(() => ({ email: "user@example.com", accountId: "acct-123" })),
  CODEX_CONFIG: { API_BASE_URL: "https://chatgpt.com/backend-api" },
}));

vi.mock("@/lib/auth/codex-auth", () => codexAuthMocks);

import {
  ensureCodexCredentialBridged,
  __testing,
} from "@/lib/ai/providers/cliproxy/codex-bridge";

describe("cliproxy/codex-bridge", () => {
  let authDir: string;
  let prev: string | undefined;

  beforeEach(() => {
    authDir = mkdtempSync(join(tmpdir(), "selene-codex-bridge-"));
    prev = process.env.SELENE_CLIPROXY_AUTH_DIR;
    process.env.SELENE_CLIPROXY_AUTH_DIR = authDir;
    vi.clearAllMocks();
    codexAuthMocks.ensureValidCodexToken.mockResolvedValue(true);
    codexAuthMocks.getCodexToken.mockReturnValue({
      type: "oauth",
      access_token: "sk-test-access",
      refresh_token: "sk-test-refresh",
      expires_at: Date.UTC(2030, 0, 1, 0, 0, 0),
    });
    codexAuthMocks.getCodexAuthState.mockReturnValue({
      isAuthenticated: true,
      email: "user@example.com",
      accountId: "acct-123",
      expiresAt: Date.UTC(2030, 0, 1, 0, 0, 0),
      lastRefresh: Date.UTC(2026, 0, 1, 0, 0, 0),
    });
    codexAuthMocks.decodeCodexJWT.mockReturnValue({ email: "user@example.com", accountId: "acct-123" });
  });

  afterEach(() => {
    rmSync(authDir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.SELENE_CLIPROXY_AUTH_DIR;
    else process.env.SELENE_CLIPROXY_AUTH_DIR = prev;
  });

  it("writes a codex-<email>.json file in the upstream CodexTokenStorage shape", async () => {
    const result = await ensureCodexCredentialBridged();

    expect(result).not.toBeNull();
    expect(result!.email).toBe("user@example.com");
    expect(result!.accountId).toBe("acct-123");
    expect(result!.filePath).toBe(join(authDir, "codex-user@example.com.json"));

    const written = JSON.parse(readFileSync(result!.filePath, "utf8"));
    expect(written).toMatchObject({
      type: "codex",
      access_token: "sk-test-access",
      refresh_token: "sk-test-refresh",
      account_id: "acct-123",
      email: "user@example.com",
      id_token: "",
    });
    expect(typeof written.expired).toBe("string");
    expect(typeof written.last_refresh).toBe("string");
    // Match upstream's RFC3339-with-offset format (e.g. 2030-01-01T03:00:00+03:00).
    expect(written.expired).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });

  it("returns null when selene has no valid codex token", async () => {
    codexAuthMocks.ensureValidCodexToken.mockResolvedValueOnce(false);
    const result = await ensureCodexCredentialBridged();
    expect(result).toBeNull();
    expect(existsSync(join(authDir, "codex-user@example.com.json"))).toBe(false);
  });

  it("returns null when the codex token decodes to no email", async () => {
    codexAuthMocks.getCodexAuthState.mockReturnValueOnce({
      isAuthenticated: true,
      email: undefined,
      accountId: undefined,
    });
    codexAuthMocks.decodeCodexJWT.mockReturnValueOnce(null);
    const result = await ensureCodexCredentialBridged();
    expect(result).toBeNull();
  });

  it("does not rewrite the credential file when nothing changed (idempotent)", async () => {
    const first = await ensureCodexCredentialBridged();
    expect(first).not.toBeNull();
    const initialMtime = readFileSync(first!.filePath, "utf8");

    const second = await ensureCodexCredentialBridged();
    expect(second).not.toBeNull();
    expect(readFileSync(second!.filePath, "utf8")).toBe(initialMtime);
  });

  it("overwrites the credential file when the access token rotates", async () => {
    const first = await ensureCodexCredentialBridged();
    expect(first).not.toBeNull();
    const initial = JSON.parse(readFileSync(first!.filePath, "utf8"));
    expect(initial.access_token).toBe("sk-test-access");

    codexAuthMocks.getCodexToken.mockReturnValueOnce({
      type: "oauth",
      access_token: "sk-test-access-ROTATED",
      refresh_token: "sk-test-refresh",
      expires_at: Date.UTC(2030, 0, 1, 0, 0, 0),
    });
    await ensureCodexCredentialBridged();

    const second = JSON.parse(readFileSync(first!.filePath, "utf8"));
    expect(second.access_token).toBe("sk-test-access-ROTATED");
  });

  it("creates the auth-dir on first run if missing", async () => {
    rmSync(authDir, { recursive: true, force: true });
    expect(existsSync(authDir)).toBe(false);

    const result = await ensureCodexCredentialBridged();
    expect(result).not.toBeNull();
    expect(existsSync(authDir)).toBe(true);
  });

  it("sanitizes path separators / null bytes in the email before constructing the filename", () => {
    expect(__testing.sanitizeEmailForFilename("foo/bar@example.com")).toBe("foo_bar@example.com");
    expect(__testing.sanitizeEmailForFilename("foo\\bar@example.com")).toBe("foo_bar@example.com");
    expect(__testing.sanitizeEmailForFilename("foo\0bar@example.com")).toBe("foo_bar@example.com");
  });

  it("formats timestamps with a timezone offset like the upstream sidecar", () => {
    const fixed = new Date(2026, 4, 24, 20, 43, 15); // local-time constructor
    const formatted = __testing.formatRfc3339WithOffset(fixed);
    expect(formatted).toMatch(/^2026-05-24T20:43:15[+-]\d{2}:\d{2}$/);
  });

  it("treats an existing credential file with same fields as up-to-date", async () => {
    const filePath = join(authDir, "codex-user@example.com.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        id_token: "",
        access_token: "sk-test-access",
        refresh_token: "sk-test-refresh",
        account_id: "acct-123",
        last_refresh: __testing.formatRfc3339WithOffset(new Date(Date.UTC(2026, 0, 1, 0, 0, 0))),
        email: "user@example.com",
        type: "codex",
        expired: __testing.formatRfc3339WithOffset(new Date(Date.UTC(2030, 0, 1, 0, 0, 0))),
      }),
    );
    const before = readFileSync(filePath, "utf8");
    await ensureCodexCredentialBridged();
    expect(readFileSync(filePath, "utf8")).toBe(before);
  });
});
