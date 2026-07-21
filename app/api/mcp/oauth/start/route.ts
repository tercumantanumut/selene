import { NextRequest, NextResponse } from "next/server";
import { loadSettings } from "@/lib/settings/settings-manager";
import { MCPClientManager, resolveMCPConfig } from "@/lib/mcp/client-manager";
import {
  buildDefaultMCPOAuthRedirectUrl,
  getMCPOAuthStatus,
  markMCPOAuthAuthorizing,
} from "@/lib/mcp/oauth-provider";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { serverName, characterId } = body as {
      serverName?: string;
      characterId?: string;
    };

    if (!serverName) {
      return NextResponse.json({ error: "serverName is required" }, { status: 400 });
    }

    const settings = loadSettings();
    const config = settings.mcpServers?.mcpServers?.[serverName];

    if (!config) {
      return NextResponse.json({ error: "Server not configured" }, { status: 404 });
    }

    if (config.enabled === false) {
      return NextResponse.json({ error: "Server is disabled" }, { status: 400 });
    }

    if (config.command) {
      return NextResponse.json(
        { error: "OAuth browser sign-in is only available for URL-based MCP servers" },
        { status: 400 },
      );
    }

    if (!config.url) {
      return NextResponse.json({ error: "Server URL is required" }, { status: 400 });
    }

    const manager = MCPClientManager.getInstance();
    const resolved = await resolveMCPConfig(
      serverName,
      config,
      settings.mcpEnvironment || {},
      characterId,
    );

    resolved.auth = { type: "oauth" };
    resolved.oauthRedirectUrl = buildDefaultMCPOAuthRedirectUrl(request.url);

    if (manager.isConnected(serverName)) {
      await manager.disconnect(serverName);
    }

    const status = await manager.connect(serverName, resolved, characterId);
    const oauthStatus = resolved.url ? getMCPOAuthStatus(serverName, resolved.url) : undefined;
    const authorizationUrl = status.authorizationUrl ?? oauthStatus?.authorizationUrl;

    if (status.connected) {
      return NextResponse.json({
        success: true,
        connected: true,
        connectionState: status.connectionState,
        toolCount: status.toolCount,
      });
    }

    if (authorizationUrl && resolved.url) {
      const updatedOAuthStatus = markMCPOAuthAuthorizing(serverName, resolved.url);
      return NextResponse.json({
        success: true,
        connected: false,
        authRequired: true,
        authorizationUrl,
        connectionState: updatedOAuthStatus.authState,
        details: status.details,
        recovery: status.recovery,
      });
    }

    return NextResponse.json({
      success: false,
      connected: false,
      error: status.lastError || "Authorization could not be started",
      connectionState: status.connectionState,
      details: status.details,
      recovery: status.recovery,
    });
  } catch (error) {
    console.error("[MCP OAuth] Start error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to start MCP OAuth" },
      { status: 500 },
    );
  }
}
