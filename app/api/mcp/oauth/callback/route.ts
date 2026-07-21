import { NextRequest, NextResponse } from "next/server";
import {
  buildDefaultMCPOAuthRedirectUrl,
  completeMCPOAuthCallback,
  failMCPOAuthCallback,
} from "@/lib/mcp/oauth-provider";
import { loadSettings } from "@/lib/settings/settings-manager";
import { MCPClientManager, resolveMCPConfig } from "@/lib/mcp/client-manager";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function callbackHtml(options: {
  title: string;
  message: string;
  success: boolean;
  detail?: string;
}): string {
  const color = options.success ? "#16a34a" : "#dc2626";
  const title = escapeHtml(options.title);
  const message = escapeHtml(options.message);
  const detail = options.detail ? escapeHtml(options.detail) : "";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${title}</title>
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f1115; color: #f5f1e8; }
    main { max-width: 560px; padding: 32px; border: 1px solid rgba(245,241,232,.16); border-radius: 16px; background: rgba(245,241,232,.06); }
    h1 { color: ${color}; margin: 0 0 12px; font-size: 20px; }
    p { line-height: 1.6; }
    code { display: block; white-space: pre-wrap; word-break: break-word; margin-top: 16px; padding: 12px; border-radius: 8px; background: rgba(0,0,0,.3); color: #fca5a5; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${message}</p>
    ${detail ? `<code>${detail}</code>` : ""}
  </main>
  ${options.success ? "<script>setTimeout(() => window.close(), 1200)</script>" : ""}
</body>
</html>`;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") || undefined;
  const oauthError = url.searchParams.get("error");
  const oauthErrorDescription = url.searchParams.get("error_description");

  if (oauthError) {
    const message = oauthErrorDescription || oauthError;
    failMCPOAuthCallback(state, message);
    return new NextResponse(
      callbackHtml({
        title: "MCP authorization failed",
        message: "Selene could not complete the MCP browser sign-in.",
        success: false,
        detail: message,
      }),
      { status: 400, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  if (!state || !code) {
    return new NextResponse(
      callbackHtml({
        title: "Invalid MCP authorization callback",
        message: "The callback did not include both state and authorization code parameters.",
        success: false,
      }),
      { status: 400, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  try {
    const status = await completeMCPOAuthCallback({ state, authorizationCode: code });
    let connected = false;
    let reconnectDetail: string | undefined;

    try {
      const settings = loadSettings();
      const config = settings.mcpServers?.mcpServers?.[status.serverName];
      if (config?.enabled !== false && config?.url && !config.command) {
        const resolved = await resolveMCPConfig(
          status.serverName,
          config,
          settings.mcpEnvironment || {},
        );
        resolved.auth = { type: "oauth" };
        resolved.oauthRedirectUrl = buildDefaultMCPOAuthRedirectUrl(request.url);
        const connection = await MCPClientManager.getInstance().connect(status.serverName, resolved);
        connected = connection.connected;
        reconnectDetail = connection.connected
          ? `${connection.toolCount} tools discovered.`
          : connection.lastError;
      }
    } catch (reconnectError) {
      reconnectDetail = reconnectError instanceof Error ? reconnectError.message : String(reconnectError);
    }

    return new NextResponse(
      callbackHtml({
        title: connected ? "MCP authorization complete" : "MCP authorization saved",
        message: connected
          ? `Authorization for ${status.serverName} is complete. Return to Selene; the server is connected.`
          : `Authorization for ${status.serverName} is saved. Return to Selene and reconnect this MCP server if tools are not visible yet.`,
        success: true,
        detail: reconnectDetail,
      }),
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failMCPOAuthCallback(state, message);
    return new NextResponse(
      callbackHtml({
        title: "MCP authorization failed",
        message: "Selene received the browser callback but could not exchange the authorization code.",
        success: false,
        detail: message,
      }),
      { status: 500, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
}
