import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const settingsStore = { current: {} as Record<string, unknown> };

vi.mock("@/lib/settings/settings-manager", () => ({
  loadSettings: vi.fn(() => settingsStore.current),
  saveSettings: vi.fn((s: Record<string, unknown>) => {
    settingsStore.current = s;
  }),
}));

const codexAuthMocks = vi.hoisted(() => ({
  decodeCodexJWT: vi.fn(() => ({
    email: "user@example.com",
    accountId: "acct-123",
    planType: "prolite",
  })),
}));

vi.mock("@/lib/auth/codex-auth", () => codexAuthMocks);

import {
  ensureCodexCredentialBridged,
  __testing,
} from "@/lib/ai/providers/cliproxy/codex-bridge";

const LEGACY_SETTINGS = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  codexToken: {
    type: "oauth",
    access_token: "sk-legacy-access",
    refresh_token: "sk-legacy-refresh",
    expires_at: Date.UTC(2030, 0, 1, 0, 0, 0),
  },
  codexAuth: {
    isAuthenticated: true,
    email: "user@example.com",
    accountId: "acct-123",
    lastRefresh: Date.UTC(2026, 0, 1, 0, 0, 0),
  },
  ...overrides,
});

describe("cliproxy/codex-bridge — legacy → sidecar migration", () => {
  let authDir: string;
  let prev: string | undefined;

  beforeEach(() => {
    authDir = mkdtempSync(join(tmpdir(), "selene-codex-bridge-"));
    prev = process.env.SELENE_CLIPROXY_AUTH_DIR;
    process.env.SELENE_CLIPROXY_AUTH_DIR = authDir;
    vi.clearAllMocks();
    settingsStore.current = LEGACY_SETTINGS();
    codexAuthMocks.decodeCodexJWT.mockReturnValue({
      email: "user@example.com",
      accountId: "acct-123",
      planType: "prolite",
    });
  });

  afterEach(() => {
    rmSync(authDir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.SELENE_CLIPROXY_AUTH_DIR;
    else process.env.SELENE_CLIPROXY_AUTH_DIR = prev;
  });

  it("migrates the legacy settings.codexToken into the sidecar auth-dir when no credential exists", async () => {
    const result = await ensureCodexCredentialBridged();

    expect(result).not.toBeNull();
    expect(result!.email).toBe("user@example.com");
    expect(result!.accountId).toBe("acct-123");
    expect(result!.plan).toBe("prolite");
    expect(result!.filePath).toBe(join(authDir, "codex-user@example.com-prolite.json"));

    const written = JSON.parse(readFileSync(result!.filePath, "utf8"));
    expect(written).toMatchObject({
      type: "codex",
      access_token: "sk-legacy-access",
      refresh_token: "sk-legacy-refresh",
      account_id: "acct-123",
      email: "user@example.com",
      id_token: "",
    });
    expect(written.expired).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });

  it("returns the existing sidecar credential without overwriting it when one already exists", async () => {
    const existing = join(authDir, "codex-user@example.com-prolite.json");
    writeFileSync(
      existing,
      JSON.stringify({
        id_token: "",
        access_token: "sk-sidecar-fresh",
        refresh_token: "sk-sidecar-refresh",
        account_id: "acct-123",
        last_refresh: "2026-05-24T20:43:15+03:00",
        email: "user@example.com",
        type: "codex",
        expired: "2030-01-01T03:00:00+03:00",
      }),
    );
    const before = readFileSync(existing, "utf8");

    const result = await ensureCodexCredentialBridged();

    expect(result).toEqual({
      filePath: existing,
      email: "user@example.com",
      accountId: "acct-123",
      plan: "prolite",
    });
    expect(readFileSync(existing, "utf8")).toBe(before);
  });

  it("returns null when there is no legacy settings.codexToken and no sidecar credential", async () => {
    settingsStore.current = { codexAuth: { isAuthenticated: false } };
    const result = await ensureCodexCredentialBridged();
    expect(result).toBeNull();
    expect(existsSync(join(authDir, "codex-user@example.com-prolite.json"))).toBe(false);
  });

  it("returns null when the legacy token decodes to no email (refuses to write a malformed filename)", async () => {
    codexAuthMocks.decodeCodexJWT.mockReturnValueOnce(null);
    settingsStore.current = LEGACY_SETTINGS({
      codexAuth: { isAuthenticated: true, accountId: "acct-123" },
    });
    const result = await ensureCodexCredentialBridged();
    expect(result).toBeNull();
  });

  it("creates the auth-dir on first migration if missing", async () => {
    rmSync(authDir, { recursive: true, force: true });
    expect(existsSync(authDir)).toBe(false);

    const result = await ensureCodexCredentialBridged();
    expect(result).not.toBeNull();
    expect(existsSync(authDir)).toBe(true);
  });

  it("writes a plan-less filename when the JWT has no plan claim", async () => {
    codexAuthMocks.decodeCodexJWT.mockReturnValueOnce({
      email: "user@example.com",
      accountId: "acct-123",
    });
    const result = await ensureCodexCredentialBridged();
    expect(result).not.toBeNull();
    expect(result!.filePath).toBe(join(authDir, "codex-user@example.com.json"));
  });

  it("sanitizes path separators / null bytes in the email before constructing the filename", () => {
    expect(__testing.sanitizeEmailForFilename("foo/bar@example.com")).toBe("foo_bar@example.com");
    expect(__testing.sanitizeEmailForFilename("foo\\bar@example.com")).toBe("foo_bar@example.com");
    expect(__testing.sanitizeEmailForFilename("foo\0bar@example.com")).toBe("foo_bar@example.com");
  });

  it("formats timestamps with a timezone offset like the upstream sidecar", () => {
    const fixed = new Date(2026, 4, 24, 20, 43, 15);
    const formatted = __testing.formatRfc3339WithOffset(fixed);
    expect(formatted).toMatch(/^2026-05-24T20:43:15[+-]\d{2}:\d{2}$/);
  });

  it("encodes plan suffix into the filename via buildCredentialFilename", () => {
    expect(__testing.buildCredentialFilename("foo@bar.com", "prolite")).toBe("codex-foo@bar.com-prolite.json");
    expect(__testing.buildCredentialFilename("foo@bar.com", undefined)).toBe("codex-foo@bar.com.json");
    expect(__testing.buildCredentialFilename("foo@bar.com", "Pro+")).toBe("codex-foo@bar.com-pro.json");
  });
});
