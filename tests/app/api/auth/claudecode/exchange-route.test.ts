import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  awaitClaudeLoginCompletion,
  getClaudeCodeAuthStatus,
  getClaudeLoginState,
  submitClaudeLoginCode,
  verifyClaudeCodeAuthenticatedAfterDarioLogin,
} = vi.hoisted(() => ({
  awaitClaudeLoginCompletion: vi.fn(),
  getClaudeCodeAuthStatus: vi.fn(),
  getClaudeLoginState: vi.fn(),
  submitClaudeLoginCode: vi.fn(),
  verifyClaudeCodeAuthenticatedAfterDarioLogin: vi.fn(),
}));

vi.mock("@/lib/auth/claudecode-auth", () => ({
  getClaudeCodeAuthStatus,
  verifyClaudeCodeAuthenticatedAfterDarioLogin,
}));

vi.mock("@/lib/ai/providers/dario/login", () => ({
  awaitClaudeLoginCompletion,
  getClaudeLoginState,
  submitClaudeLoginCode,
}));

import { POST } from "@/app/api/auth/claudecode/exchange/route";

function request(code: string): Request {
  return new Request("http://localhost/api/auth/claudecode/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

describe("POST /api/auth/claudecode/exchange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getClaudeCodeAuthStatus.mockResolvedValue({ authenticated: false });
    getClaudeLoginState.mockReturnValue({
      active: true,
      status: "pending",
      url: "https://claude.ai/oauth",
      output: [],
    });
    submitClaudeLoginCode.mockImplementation(() => undefined);
    awaitClaudeLoginCompletion.mockResolvedValue({
      active: false,
      status: "success",
      url: null,
      output: ["Login successful!"],
    });
    verifyClaudeCodeAuthenticatedAfterDarioLogin.mockResolvedValue({
      authenticated: true,
      output: ["Login successful!"],
    });
  });

  it("short-circuits when already authenticated", async () => {
    getClaudeCodeAuthStatus.mockResolvedValueOnce({ authenticated: true, output: ["already authed"] });

    const response = await POST(request("ignored"));
    const body = await response.json();

    expect(body).toMatchObject({ success: true, authenticated: true, output: ["already authed"] });
    expect(getClaudeLoginState).not.toHaveBeenCalled();
    expect(submitClaudeLoginCode).not.toHaveBeenCalled();
  });

  it("returns 409 when no active Dario OAuth session exists", async () => {
    getClaudeLoginState.mockReturnValueOnce(null);

    const response = await POST(request("abc"));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({ success: false, authenticated: false });
    expect(submitClaudeLoginCode).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty authorization code", async () => {
    submitClaudeLoginCode.mockImplementationOnce(() => {
      throw new Error("Paste the authorization code from the Claude login page.");
    });

    const response = await POST(request(""));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      authenticated: false,
      error: "Paste the authorization code from the Claude login page.",
    });
    expect(awaitClaudeLoginCompletion).not.toHaveBeenCalled();
  });

  it("returns 409 when the login session expires before submit", async () => {
    submitClaudeLoginCode.mockImplementationOnce(() => {
      throw new Error("No active Dario OAuth login. Click 'Login with Claude' to start a new flow.");
    });

    const response = await POST(request("abc"));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      success: false,
      authenticated: false,
      error: "No active Dario OAuth login. Click 'Login with Claude' to start a new flow.",
    });
    expect(awaitClaudeLoginCompletion).not.toHaveBeenCalled();
  });

  it("verifies Dario sidecar readiness after login completion", async () => {
    const response = await POST(request("abc"));
    const body = await response.json();

    expect(awaitClaudeLoginCompletion).toHaveBeenCalledWith(30_000);
    expect(verifyClaudeCodeAuthenticatedAfterDarioLogin).toHaveBeenCalledWith(["Login successful!"]);
    expect(getClaudeCodeAuthStatus).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({
      success: true,
      authenticated: true,
      output: ["Login successful!"],
    });
  });

  it("returns the verified readiness error when sidecar verification fails", async () => {
    verifyClaudeCodeAuthenticatedAfterDarioLogin.mockResolvedValueOnce({
      authenticated: false,
      output: ["Login successful!"],
      error: "Dario status endpoint returned HTTP 503",
    });

    const response = await POST(request("abc"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: false,
      authenticated: false,
      error: "Dario status endpoint returned HTTP 503",
      output: ["Login successful!"],
    });
  });
});
