import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settingsStore = { current: {} as Record<string, any> };

const { fetchDarioStatus, getClaudeLoginState, logoutClaudeLogin } = vi.hoisted(() => ({
  fetchDarioStatus: vi.fn(),
  getClaudeLoginState: vi.fn(() => null),
  logoutClaudeLogin: vi.fn(async () => ({ active: false, status: "success" as const, url: null, output: [] })),
}));

const { readClaudeAgentSdkAuthStatus, attemptClaudeAgentSdkLogout } = vi.hoisted(() => ({
  readClaudeAgentSdkAuthStatus: vi.fn(),
  attemptClaudeAgentSdkLogout: vi.fn(async () => true),
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

vi.mock("@/lib/ai/providers/claudecode-sdk/auth", () => ({
  readClaudeAgentSdkAuthStatus,
  attemptClaudeAgentSdkLogout,
}));

import {
  clearClaudeCodeAuth,
  getClaudeCodeAuthStatus,
  invalidateClaudeCodeAuthCache,
} from "@/lib/auth/claudecode-auth";

describe("claudecode-auth backend branching", () => {
  beforeEach(() => {
    settingsStore.current = {};
    invalidateClaudeCodeAuthCache();
    fetchDarioStatus.mockResolvedValue({ authenticated: false, status: "none" });
    readClaudeAgentSdkAuthStatus.mockResolvedValue({ authenticated: false, isAuthenticating: false, output: [] });
  });

  afterEach(() => vi.clearAllMocks());

  it("uses the Dario status path when backend is dario (default)", async () => {
    fetchDarioStatus.mockResolvedValue({ authenticated: true, status: "healthy" });
    const status = await getClaudeCodeAuthStatus();

    expect(fetchDarioStatus).toHaveBeenCalled();
    expect(readClaudeAgentSdkAuthStatus).not.toHaveBeenCalled();
    expect(status.authenticated).toBe(true);
    expect(status.tokenSource).toBe("dario-oauth");
    // Persisted into the Dario slot, not the SDK slot.
    expect(settingsStore.current.claudecodeAuth?.isAuthenticated).toBe(true);
    expect(settingsStore.current.claudecodeSdkAuth).toBeUndefined();
  });

  it("uses the SDK status path when backend is sdk", async () => {
    settingsStore.current = { claudecodeBackend: "sdk" };
    readClaudeAgentSdkAuthStatus.mockResolvedValue({
      authenticated: true,
      isAuthenticating: false,
      output: [],
      email: "user@example.com",
      subscriptionType: "max",
    });

    const status = await getClaudeCodeAuthStatus();

    expect(readClaudeAgentSdkAuthStatus).toHaveBeenCalled();
    expect(fetchDarioStatus).not.toHaveBeenCalled();
    expect(status.authenticated).toBe(true);
    expect(status.email).toBe("user@example.com");
    expect(status.tokenSource).toBe("claude-agent-sdk");
    // Persisted into the SDK slot, not the Dario slot.
    expect(settingsStore.current.claudecodeSdkAuth?.isAuthenticated).toBe(true);
    expect(settingsStore.current.claudecodeAuth).toBeUndefined();
  });

  it("does not let a stale Dario 'authenticated' mask an unauthenticated SDK", async () => {
    // Dario slot says authenticated, but the active backend is the SDK and it is not.
    settingsStore.current = {
      claudecodeBackend: "sdk",
      claudecodeAuth: { isAuthenticated: true },
    };
    readClaudeAgentSdkAuthStatus.mockResolvedValue({ authenticated: false, isAuthenticating: false, output: [] });

    const status = await getClaudeCodeAuthStatus();
    expect(status.authenticated).toBe(false);
  });

  it("clearClaudeCodeAuth logs out the SDK backend when selected", async () => {
    settingsStore.current = { claudecodeBackend: "sdk" };
    await clearClaudeCodeAuth();
    expect(attemptClaudeAgentSdkLogout).toHaveBeenCalled();
    expect(logoutClaudeLogin).not.toHaveBeenCalled();
    expect(settingsStore.current.claudecodeSdkAuth?.isAuthenticated).toBe(false);
  });

  it("clearClaudeCodeAuth logs out Dario when selected", async () => {
    settingsStore.current = { claudecodeBackend: "dario" };
    await clearClaudeCodeAuth();
    expect(logoutClaudeLogin).toHaveBeenCalled();
    expect(attemptClaudeAgentSdkLogout).not.toHaveBeenCalled();
    expect(settingsStore.current.claudecodeAuth?.isAuthenticated).toBe(false);
  });
});
