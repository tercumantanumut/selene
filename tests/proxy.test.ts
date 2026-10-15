import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

function request(path: string) {
  return new NextRequest(`http://127.0.0.1:3457${path}`);
}

describe("proxy MCP OAuth callback auth bypass", () => {
  it("allows the browser OAuth callback without a Selene session cookie", async () => {
    const response = await proxy(
      request("/api/mcp/oauth/callback?code=oauth-code&state=oauth-state"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-next-intl-locale")).toBe("en");
    expect(response.headers.get("location")).toBeNull();
  });

  it("keeps the rest of the MCP API protected", async () => {
    const response = await proxy(request("/api/mcp"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("does not treat callback-looking sibling paths as public", async () => {
    const response = await proxy(request("/api/mcp/oauth/callback-extra?code=x&state=y"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });
});
