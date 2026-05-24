import { NextResponse } from "next/server";
import { getClaudeCodeAuthStatus } from "@/lib/auth/claudecode-auth";
import { awaitLoginCompletion, getLoginState } from "@/lib/ai/providers/cliproxy/login";

/**
 * POST /api/auth/claudecode/exchange
 *
 * Blocks (up to ~30s) waiting for the OAuth browser callback to complete
 * into the active `cliproxyapi -claude-login` subprocess, then returns the
 * resulting auth status. Idempotent — if no login session is in flight and a
 * credential already exists, returns the cached state.
 *
 * The body shape `{ code }` is accepted for backwards compatibility with the
 * old Agent-SDK paste flow but the field is ignored — CLIProxyAPI's local
 * HTTP callback collects the code itself.
 */
export async function POST() {
  try {
    const before = await getClaudeCodeAuthStatus();
    if (before.authenticated) {
      return NextResponse.json({
        success: true,
        authenticated: true,
        output: before.output,
      });
    }

    const loginState = getLoginState();
    if (!loginState || !loginState.active) {
      return NextResponse.json(
        {
          success: false,
          authenticated: false,
          error:
            "No active OAuth login. Click 'Login with Claude' to start a new flow.",
        },
        { status: 409 },
      );
    }

    const final = await awaitLoginCompletion(30_000);
    const after = await getClaudeCodeAuthStatus();

    return NextResponse.json({
      success: after.authenticated,
      authenticated: after.authenticated,
      error: after.authenticated
        ? undefined
        : final?.errorMessage ?? "OAuth flow did not complete in time. Try again.",
      output: final?.output ?? after.output,
      url: final?.url ?? after.authUrl ?? null,
    });
  } catch (error) {
    console.error("[ClaudeCodeExchange] Error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to verify authentication status" },
      { status: 500 },
    );
  }
}
