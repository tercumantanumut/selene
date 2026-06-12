import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settingsStore = { current: {} as Record<string, any> };

const { fetchDarioStatus, getClaudeLoginState, logoutClaudeLogin } = vi.hoisted(() => ({
  fetchDarioStatus: vi.fn(),
  getClaudeLoginState: vi.fn(() => null),
  logoutClaudeLogin: vi.fn(async () => ({
    active: false,
    status: "success" as const,
    url: null,
    output: ["logged out"],
  })),
}));

vi.mock("@/lib/settings/settings-manager", () => ({
  loadSettings: vi.fn(() => settingsStore.current),
  saveSettings: vi.fn((s: Record<string, unknown>) => {
    settingsStore.current = s;
  }),
}));

vi.mock("@/lib/ai/providers/dario/status", () => ({
  fetchDarioStatus,
  isDarioStatusUsable: (status: { authenticated: boolean; status: string; canRefresh?: boolean }) =>
    status.authenticated || (status.status === "expired" && status.canRefresh === true),
}));

vi.mock("@/lib/ai/providers/dario/login", () => ({
  getClaudeLoginState,
  logoutClaudeLogin,
}));

import {
  clearClaudeCodeAuth,
  getClaudeCodeAuthState,
  getClaudeCodeAuthStatus,
  invalidateClaudeCodeAuthCache,
  isClaudeCodeAuthenticated,
  verifyClaudeCodeAuthenticatedAfterDarioLogin,
} from "@/lib/auth/claudecode-auth";

describe("claudecode-auth (Dario-backed)", () => {
  beforeEach(() => {
    settingsStore.current = {};
    invalidateClaudeCodeAuthCache();
    fetchDarioStatus.mockResolvedValue({ authenticated: false, status: "none" });
    getClaudeLoginState.mockReturnValue(null);
    logoutClaudeLogin.mockResolvedValue({
      active: false,
      status: "success",
      url: null,
      output: ["logged out"],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("reports unauthenticated when Dario has no OAuth credentials", async () => {
    const status = await getClaudeCodeAuthStatus();
    expect(status.authenticated).toBe(false);
    expect(status.email).toBeUndefined();
    expect(status.tokenSource).toBe("dario-oauth");
    expect(status.apiKeySource).toBe("dario-local-proxy");
  });

  it("returns authenticated when Dario reports healthy credentials", async () => {
    fetchDarioStatus.mockResolvedValue({
      authenticated: true,
      status: "healthy",
      expiresAt: 1900000000000,
      expiresIn: "2h 0m",
    });

    const status = await getClaudeCodeAuthStatus();
    expect(status.authenticated).toBe(true);
    expect(status.email).toBeUndefined();
    expect(status.expiresAt).toBe(1900000000000);
    expect(await isClaudeCodeAuthenticated()).toBe(true);
  });

  it("treats expired-but-refreshable Dario credentials as usable", async () => {
    fetchDarioStatus.mockResolvedValue({
      authenticated: false,
      status: "expired",
      canRefresh: true,
      expiresAt: 1,
    });

    const status = await getClaudeCodeAuthStatus();
    expect(status.authenticated).toBe(true);
    expect(status.error).toBeUndefined();
  });

  it("persists the snapshot so a sync read after refresh matches", async () => {
    fetchDarioStatus.mockResolvedValue({
      authenticated: true,
      status: "expiring",
      expiresAt: 1900000000000,
      expiresIn: "10m",
    });

    await getClaudeCodeAuthStatus();

    const state = getClaudeCodeAuthState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.email).toBeUndefined();
    expect(state.expiresAt).toBe(1900000000000);
    expect(state.tokenSource).toBe("dario-oauth");
  });

  it("does not trust successful Dario login output when /status is stale", async () => {
    fetchDarioStatus.mockResolvedValue({ authenticated: false, status: "none" });
    getClaudeLoginState.mockReturnValue({
      active: false,
      status: "success",
      url: null,
      output: ["Found valid credentials. (--no-proxy / --manual: not starting proxy.)"],
    });

    const status = await getClaudeCodeAuthStatus();
    expect(status.authenticated).toBe(false);
    expect(getClaudeCodeAuthState().isAuthenticated).toBe(false);
  });

  it("verifies the Dario sidecar after successful login output before marking authenticated", async () => {
    fetchDarioStatus.mockResolvedValue({ authenticated: true, status: "healthy" });

    const status = await verifyClaudeCodeAuthenticatedAfterDarioLogin(["Found valid credentials. (--no-proxy / --manual: not starting proxy.)"]);

    expect(fetchDarioStatus).toHaveBeenCalledWith({ ensureReady: true });
    expect(status.authenticated).toBe(true);
    expect(status.output).toEqual(["Found valid credentials. (--no-proxy / --manual: not starting proxy.)"]);
    expect(getClaudeCodeAuthState().isAuthenticated).toBe(true);
  });

  it("surfaces broken Dario refresh errors", async () => {
    fetchDarioStatus.mockResolvedValue({
      authenticated: false,
      status: "broken",
      refreshFailures: 3,
      lastRefreshError: "invalid_grant",
    });

    const status = await getClaudeCodeAuthStatus();
    expect(status.authenticated).toBe(false);
    expect(status.error).toContain("invalid_grant");
  });

  it("clearClaudeCodeAuth calls dario logout and resets the snapshot", async () => {
    fetchDarioStatus.mockResolvedValue({ authenticated: true, status: "healthy" });
    await getClaudeCodeAuthStatus();
    expect((await getClaudeCodeAuthStatus()).authenticated).toBe(true);

    await clearClaudeCodeAuth();

    expect(logoutClaudeLogin).toHaveBeenCalledTimes(1);
    const state = getClaudeCodeAuthState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.tokenSource).toBe("dario-oauth");
  });
});
