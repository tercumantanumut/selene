import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const settingsStore = { current: {} as Record<string, unknown> };

vi.mock("@/lib/settings/settings-manager", () => ({
  loadSettings: vi.fn(() => settingsStore.current),
  saveSettings: vi.fn((s: Record<string, unknown>) => {
    settingsStore.current = s;
  }),
}));

vi.mock("@/lib/ai/providers/cliproxy/login", () => ({
  getCodexLoginState: vi.fn(() => null),
}));

// The bridge is exercised separately in codex-bridge.test.ts — stub it here
// so the auth facade tests don't touch the migration shim.
vi.mock("@/lib/ai/providers/cliproxy/codex-bridge", () => ({
  ensureCodexCredentialBridged: vi.fn(async () => null),
}));

import {
  clearCodexAuth,
  decodeCodexJWT,
  getCodexAuthState,
  getCodexAuthStatus,
  invalidateCodexAuthCache,
  isCodexAuthenticated,
} from "@/lib/auth/codex-auth";

describe("codex-auth (CLIProxyAPI-backed)", () => {
  let authDir: string;
  let prev: string | undefined;

  beforeEach(() => {
    settingsStore.current = {};
    invalidateCodexAuthCache();
    authDir = mkdtempSync(join(tmpdir(), "selene-codex-auth-"));
    prev = process.env.SELENE_CLIPROXY_AUTH_DIR;
    process.env.SELENE_CLIPROXY_AUTH_DIR = authDir;
  });

  afterEach(() => {
    rmSync(authDir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.SELENE_CLIPROXY_AUTH_DIR;
    else process.env.SELENE_CLIPROXY_AUTH_DIR = prev;
  });

  it("reports unauthenticated when no codex credential file is present", async () => {
    const status = await getCodexAuthStatus();
    expect(status.authenticated).toBe(false);
    expect(status.email).toBeUndefined();
    expect(status.tokenSource).toBe("cliproxyapi-oauth");
  });

  it("returns authenticated when a codex-<email>.json exists", async () => {
    writeFileSync(join(authDir, "codex-foo@bar.com.json"), "{}");

    const status = await getCodexAuthStatus();
    expect(status.authenticated).toBe(true);
    expect(status.email).toBe("foo@bar.com");
    expect(status.plan).toBeUndefined();
    expect(isCodexAuthenticated()).toBe(true);
  });

  it("captures the plan suffix from codex-<email>-<plan>.json filenames", async () => {
    writeFileSync(join(authDir, "codex-foo@bar.com-prolite.json"), "{}");

    const status = await getCodexAuthStatus();
    expect(status.authenticated).toBe(true);
    expect(status.email).toBe("foo@bar.com");
    expect(status.plan).toBe("prolite");
  });

  it("persists the snapshot so a sync read after refresh matches", async () => {
    writeFileSync(join(authDir, "codex-x@y.com-pro.json"), "{}");
    await getCodexAuthStatus();

    const state = getCodexAuthState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.email).toBe("x@y.com");
    expect(state.plan).toBe("pro");
    expect(state.tokenSource).toBe("cliproxyapi-oauth");
  });

  it("clearCodexAuth deletes credentials and resets the snapshot", async () => {
    writeFileSync(join(authDir, "codex-x@y.com.json"), "{}");
    await getCodexAuthStatus();
    expect((await getCodexAuthStatus()).authenticated).toBe(true);

    await clearCodexAuth();

    expect((await getCodexAuthStatus()).authenticated).toBe(false);
    expect(getCodexAuthState().isAuthenticated).toBe(false);
  });

  it("clearCodexAuth wipes the legacy settings.codexToken too", async () => {
    settingsStore.current = {
      codexToken: {
        type: "oauth",
        access_token: "legacy",
        refresh_token: "legacy-refresh",
        expires_at: Date.now() + 3600_000,
      },
    };

    await clearCodexAuth();

    expect(settingsStore.current.codexToken).toBeUndefined();
  });

  // ── decodeCodexJWT ──────────────────────────────────────────────────────

  it("decodeCodexJWT pulls email from the namespaced profile claim", () => {
    // Hand-rolled JWT with the OpenAI claim shape OpenAI actually issues.
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/profile": { email: "foo@bar.com", email_verified: true },
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-123",
          chatgpt_plan_type: "prolite",
        },
      }),
    ).toString("base64url");
    const token = `${header}.${payload}.sig`;

    const decoded = decodeCodexJWT(token);
    expect(decoded).toEqual({
      email: "foo@bar.com",
      accountId: "acct-123",
      planType: "prolite",
    });
  });

  it("decodeCodexJWT falls back to top-level email when profile claim is absent", () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ email: "legacy@example.com" }),
    ).toString("base64url");
    const token = `${header}.${payload}.sig`;

    expect(decodeCodexJWT(token)?.email).toBe("legacy@example.com");
  });

  it("decodeCodexJWT returns null on malformed tokens", () => {
    expect(decodeCodexJWT("not.a.jwt")).toBeNull();
    expect(decodeCodexJWT("only.two")).toBeNull();
    expect(decodeCodexJWT("")).toBeNull();
  });
});
