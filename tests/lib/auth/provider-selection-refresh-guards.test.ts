import { beforeEach, describe, expect, it, vi } from "vitest";

const settingsMocks = vi.hoisted(() => {
  const state = { settings: {} as Record<string, any> };
  return {
    state,
    loadSettings: vi.fn(() => state.settings),
    saveSettings: vi.fn((settings: Record<string, any>) => {
      state.settings = settings;
    }),
  };
});

vi.mock("@/lib/settings/settings-manager", () => ({
  loadSettings: settingsMocks.loadSettings,
  saveSettings: settingsMocks.saveSettings,
}));

import {
  invalidateAntigravityAuthCache,
  refreshAntigravityToken,
  saveAntigravityToken,
  type AntigravityOAuthToken,
} from "@/lib/auth/antigravity-auth";

// Codex no longer has selene-side refresh/save — the CLIProxyAPI sidecar
// owns the Codex OAuth lifecycle, so the codex guards moved to
// tests/lib/ai/providers/cliproxy/codex-bridge.test.ts.

describe("Auth Refresh Provider Selection Guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateAntigravityAuthCache();
    settingsMocks.state.settings = {};
  });

  it("does not switch to antigravity on token refresh", async () => {
    settingsMocks.state.settings = {
      llmProvider: "codex",
      antigravityAuth: { isAuthenticated: true, email: "user@example.com" },
      antigravityToken: {
        type: "oauth",
        access_token: "old-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() - 1_000,
      } satisfies AntigravityOAuthToken,
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "new-token",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    } as Response);

    const refreshed = await refreshAntigravityToken();

    expect(refreshed).toBe(true);
    expect(settingsMocks.state.settings.llmProvider).toBe("codex");
    expect(settingsMocks.state.settings.antigravityToken.access_token).toBe("new-token");
  });

  it("switches to antigravity only on explicit save", () => {
    settingsMocks.state.settings = {
      llmProvider: "codex",
      antigravityAuth: { isAuthenticated: false },
    };

    const token: AntigravityOAuthToken = {
      type: "oauth",
      access_token: "explicit-token",
      refresh_token: "explicit-refresh",
      expires_at: Date.now() + 3600_000,
    };

    saveAntigravityToken(token, "user@example.com", true);

    expect(settingsMocks.state.settings.llmProvider).toBe("antigravity");
  });
});
