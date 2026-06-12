import { beforeEach, describe, expect, it, vi } from "vitest";

const { getClaudeCodeAuthStatus, startClaudeLogin, verifyClaudeCodeAuthenticatedAfterDarioLogin } = vi.hoisted(() => ({
  getClaudeCodeAuthStatus: vi.fn(),
  startClaudeLogin: vi.fn(),
  verifyClaudeCodeAuthenticatedAfterDarioLogin: vi.fn(),
}));

vi.mock("@/lib/auth/claudecode-auth", () => ({
  getClaudeCodeAuthStatus,
  verifyClaudeCodeAuthenticatedAfterDarioLogin,
}));

vi.mock("@/lib/ai/providers/dario/login", () => ({
  isSuccessfulClaudeLoginOutput: (output: string[] | undefined) => {
    if (!output || output.length === 0) return false;
    const hasSuccess = output.some((line) => [
      /^found valid credentials\b/i,
      /^refresh successful!/i,
      /^login successful!/i,
    ].some((pattern) => pattern.test(line.trim())));
    return hasSuccess && !output.some((line) => /\b(error|failed|failure|fatal|invalid_grant|rejected)\b/i.test(line));
  },
  startClaudeLogin,
}));

import { GET } from "@/app/api/auth/claudecode/authorize/route";

describe("GET /api/auth/claudecode/authorize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getClaudeCodeAuthStatus.mockResolvedValue({ authenticated: false });
    verifyClaudeCodeAuthenticatedAfterDarioLogin.mockResolvedValue({ authenticated: true });
    startClaudeLogin.mockResolvedValue({ url: "https://claude.ai/oauth", output: [] });
  });

  it("short-circuits when Dario already has usable Claude credentials", async () => {
    getClaudeCodeAuthStatus.mockResolvedValueOnce({ authenticated: true });

    const response = await GET();
    const body = await response.json();

    expect(body).toMatchObject({ success: true, authenticated: true });
    expect(startClaudeLogin).not.toHaveBeenCalled();
  });

  it("verifies a no-url Dario refresh before completing authentication", async () => {
    getClaudeCodeAuthStatus.mockResolvedValueOnce({ authenticated: false });
    startClaudeLogin.mockResolvedValueOnce({
      url: null,
      output: ["Existing credentials expired — attempting token refresh...", "Refresh successful!"],
    });

    const response = await GET();
    const body = await response.json();

    expect(startClaudeLogin).toHaveBeenCalledTimes(1);
    expect(getClaudeCodeAuthStatus).toHaveBeenCalledTimes(1);
    expect(verifyClaudeCodeAuthenticatedAfterDarioLogin).toHaveBeenCalledWith([
      "Existing credentials expired — attempting token refresh...",
      "Refresh successful!",
    ]);
    expect(body).toMatchObject({
      success: true,
      authenticated: true,
      message: "Claude Code credentials are available through Dario",
    });
    expect(body.output).toContain("Refresh successful!");
  });

  it("verifies Dario's no-url valid-credentials output before completing authentication", async () => {
    getClaudeCodeAuthStatus.mockResolvedValueOnce({ authenticated: false });
    startClaudeLogin.mockResolvedValueOnce({
      url: null,
      output: ["Found valid credentials. (--no-proxy / --manual: not starting proxy.)"],
    });

    const response = await GET();
    const body = await response.json();

    expect(getClaudeCodeAuthStatus).toHaveBeenCalledTimes(1);
    expect(verifyClaudeCodeAuthenticatedAfterDarioLogin).toHaveBeenCalledWith([
      "Found valid credentials. (--no-proxy / --manual: not starting proxy.)",
    ]);
    expect(body).toMatchObject({ success: true, authenticated: true });
  });

  it("does not complete authentication when Dario success output cannot be verified", async () => {
    getClaudeCodeAuthStatus.mockResolvedValueOnce({ authenticated: false });
    verifyClaudeCodeAuthenticatedAfterDarioLogin.mockResolvedValueOnce({
      authenticated: false,
      error: "Dario status endpoint returned HTTP 503",
    });
    startClaudeLogin.mockResolvedValueOnce({
      url: null,
      output: ["Found valid credentials. (--no-proxy / --manual: not starting proxy.)"],
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      success: false,
      authenticated: false,
      error: "Dario status endpoint returned HTTP 503",
    });
  });

  it("falls back to a fresh status read when Dario returns no URL and no success output", async () => {
    getClaudeCodeAuthStatus
      .mockResolvedValueOnce({ authenticated: false })
      .mockResolvedValueOnce({ authenticated: false });
    startClaudeLogin.mockResolvedValueOnce({
      url: null,
      output: ["some non-success message"],
    });

    const response = await GET();
    const body = await response.json();

    expect(getClaudeCodeAuthStatus).toHaveBeenCalledTimes(2);
    expect(verifyClaudeCodeAuthenticatedAfterDarioLogin).not.toHaveBeenCalled();
    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      success: false,
      authenticated: false,
      output: ["some non-success message"],
      error: "Dario did not return an authentication URL or verified credentials.",
    });
  });

  it("returns the OAuth URL when Dario starts a fresh manual login", async () => {
    startClaudeLogin.mockResolvedValueOnce({
      url: "https://claude.ai/oauth/start",
      output: ["Open this URL"],
    });

    const response = await GET();
    const body = await response.json();

    expect(body).toMatchObject({
      success: true,
      authenticated: false,
      url: "https://claude.ai/oauth/start",
    });
    expect(getClaudeCodeAuthStatus).toHaveBeenCalledTimes(1);
  });
});
