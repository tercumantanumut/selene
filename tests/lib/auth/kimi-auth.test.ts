import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

vi.mock("@/lib/settings/settings-manager", () => ({
  loadSettings: vi.fn(() => settings.current),
  saveSettings: vi.fn((nextSettings: Record<string, unknown>) => {
    settings.current = { ...nextSettings };
  }),
}));

vi.mock("@/lib/ai/providers/kimi-client", () => ({
  invalidateKimiClient: vi.fn(),
}));

async function loadKimiAuth() {
  vi.resetModules();
  return import("@/lib/auth/kimi-auth");
}

describe("kimi auth refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-28T13:00:00.000Z"));
    settings.current = {
      kimiToken: {
        type: "oauth",
        access_token: "old-access-token",
        refresh_token: "old-refresh-token",
        expires_at: Date.now() + 5 * 60 * 1000,
      },
      kimiAuth: {
        isAuthenticated: true,
        expiresAt: Date.now() + 5 * 60 * 1000,
      },
      kimiDeviceId: "device-1",
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("refreshes when the token is inside the proactive threshold", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { ensureValidKimiToken, getKimiOAuthToken } = await loadKimiAuth();

    await expect(ensureValidKimiToken()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getKimiOAuthToken()?.access_token).toBe("new-access-token");
  });

  it("deduplicates concurrent refresh attempts", async () => {
    let resolveRefresh!: (response: Response) => void;
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { ensureValidKimiToken, getKimiOAuthToken } = await loadKimiAuth();

    const first = ensureValidKimiToken();
    const second = ensureValidKimiToken();

    resolveRefresh(
      new Response(
        JSON.stringify({
          access_token: "deduped-access-token",
          refresh_token: "deduped-refresh-token",
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    );

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getKimiOAuthToken()?.access_token).toBe("deduped-access-token");
  });

  it("uses current Kimi Code CLI identity headers", async () => {
    const { getKimiDeviceHeaders } = await loadKimiAuth();

    expect(getKimiDeviceHeaders()).toMatchObject({
      "User-Agent": "kimi-code-cli/0.19.2",
      "X-Msh-Platform": "kimi_code_cli",
      "X-Msh-Version": "0.19.2",
      "X-Msh-Device-Id": "device-1",
    });
  });
});
