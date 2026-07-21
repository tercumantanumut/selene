import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildDefaultMCPOAuthRedirectUrl,
  clearMCPOAuthForServer,
  createMCPOAuthProvider,
  getMCPOAuthStatus,
  markMCPOAuthAuthorizing,
} from "@/lib/mcp/oauth-provider";

describe("MCP OAuth provider", () => {
  let dataDir: string;
  let previousLocalDataPath: string | undefined;

  beforeEach(() => {
    previousLocalDataPath = process.env.LOCAL_DATA_PATH;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "selene-mcp-oauth-"));
    process.env.LOCAL_DATA_PATH = dataDir;
  });

  afterEach(() => {
    if (previousLocalDataPath === undefined) {
      delete process.env.LOCAL_DATA_PATH;
    } else {
      process.env.LOCAL_DATA_PATH = previousLocalDataPath;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("persists authorization state and tokens per server", async () => {
    const provider = createMCPOAuthProvider({
      serverName: "mobbin",
      serverUrl: "https://api.mobbin.com/mcp",
      redirectUrl: "http://127.0.0.1:3000/api/mcp/oauth/callback",
    });

    const state = provider.state();
    provider.saveCodeVerifier("verifier");
    await provider.redirectToAuthorization(new URL(`https://auth.example.com/oauth?state=${state}`));

    let status = getMCPOAuthStatus("mobbin", "https://api.mobbin.com/mcp");
    expect(status.authState).toBe("authorization_required");
    expect(status.authorizationUrl).toContain("auth.example.com");
    expect(status.hasTokens).toBe(false);

    status = markMCPOAuthAuthorizing("mobbin", "https://api.mobbin.com/mcp");
    expect(status.authState).toBe("authorizing");

    expect(provider.codeVerifier()).toBe("verifier");
    provider.saveTokens({ access_token: "access", token_type: "Bearer", expires_in: 3600 });

    status = getMCPOAuthStatus("mobbin", "https://api.mobbin.com/mcp");
    expect(status.authState).toBe("connected");
    expect(status.hasTokens).toBe(true);
    expect(status.authorizationUrl).toBeUndefined();

    clearMCPOAuthForServer("mobbin", "https://api.mobbin.com/mcp");
    status = getMCPOAuthStatus("mobbin", "https://api.mobbin.com/mcp");
    expect(status.authState).toBe("unauthenticated");
    expect(status.hasTokens).toBe(false);
  });

  it("builds loopback callback URLs from incoming requests", () => {
    expect(buildDefaultMCPOAuthRedirectUrl("http://localhost:3000/api/mcp/oauth/start"))
      .toBe("http://127.0.0.1:3000/api/mcp/oauth/callback");
    expect(buildDefaultMCPOAuthRedirectUrl("https://127.0.0.1:3456/api/mcp/oauth/start"))
      .toBe("http://127.0.0.1:3456/api/mcp/oauth/callback");
  });
});
