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
  getClaudeLoginState: vi.fn(() => null),
}));

import {
  clearClaudeCodeAuth,
  getClaudeCodeAuthState,
  getClaudeCodeAuthStatus,
  invalidateClaudeCodeAuthCache,
  isClaudeCodeAuthenticated,
} from "@/lib/auth/claudecode-auth";

describe("claudecode-auth (CLIProxyAPI-backed)", () => {
  let authDir: string;
  let prev: string | undefined;

  beforeEach(() => {
    settingsStore.current = {};
    invalidateClaudeCodeAuthCache();
    authDir = mkdtempSync(join(tmpdir(), "selene-ccauth-"));
    prev = process.env.SELENE_CLIPROXY_AUTH_DIR;
    process.env.SELENE_CLIPROXY_AUTH_DIR = authDir;
  });

  afterEach(() => {
    rmSync(authDir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.SELENE_CLIPROXY_AUTH_DIR;
    else process.env.SELENE_CLIPROXY_AUTH_DIR = prev;
  });

  it("reports unauthenticated when no credential file is present", async () => {
    const status = await getClaudeCodeAuthStatus();
    expect(status.authenticated).toBe(false);
    expect(status.email).toBeUndefined();
    expect(status.tokenSource).toBe("cliproxyapi-oauth");
  });

  it("returns authenticated with email when a claude-*.json exists", async () => {
    writeFileSync(join(authDir, "claude-umut@rltm.ai.json"), "{}");

    const status = await getClaudeCodeAuthStatus();
    expect(status.authenticated).toBe(true);
    expect(status.email).toBe("umut@rltm.ai");
    expect(status.account).toBe("umut@rltm.ai");

    expect(await isClaudeCodeAuthenticated()).toBe(true);
  });

  it("persists the snapshot so a sync read after refresh matches", async () => {
    writeFileSync(join(authDir, "claude-foo@bar.com.json"), "{}");
    await getClaudeCodeAuthStatus();

    const state = getClaudeCodeAuthState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.email).toBe("foo@bar.com");
    expect(state.tokenSource).toBe("cliproxyapi-oauth");
  });

  it("clearClaudeCodeAuth deletes credentials and resets the snapshot", async () => {
    writeFileSync(join(authDir, "claude-x@y.com.json"), "{}");
    await getClaudeCodeAuthStatus(); // populate cache
    expect((await getClaudeCodeAuthStatus()).authenticated).toBe(true);

    await clearClaudeCodeAuth();

    expect((await getClaudeCodeAuthStatus()).authenticated).toBe(false);
    const state = getClaudeCodeAuthState();
    expect(state.isAuthenticated).toBe(false);
  });
});
