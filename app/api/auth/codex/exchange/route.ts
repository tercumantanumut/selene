import { NextResponse } from "next/server";
import { getCodexAuthStatus } from "@/lib/auth/codex-auth";
import {
  awaitCodexLoginCompletion,
  getCodexLoginState,
} from "@/lib/ai/providers/cliproxy/login";

/**
 * POST /api/auth/codex/exchange
 *
 * Blocks (up to ~30s) waiting for the OAuth browser callback to complete
 * into the active `cliproxyapi -codex-login` subprocess, then returns the
 * resulting auth status. Idempotent — if no login session is in flight and
 * a credential already exists, returns the cached state.
 *
 * Accepts (but ignores) the legacy `{ code }` body for backwards
 * compatibility with the old paste-the-code flow. CLIProxyAPI's local HTTP
 * callback server handles the OAuth round-trip on its own.
 */
export async function POST() {
  try {
    const before = await getCodexAuthStatus();
    if (before.authenticated) {
      return NextResponse.json({
        success: true,
        authenticated: true,
        output: before.output,
      });
    }

    const loginState = getCodexLoginState();
    if (!loginState || !loginState.active) {
      return NextResponse.json(
        {
          success: false,
          authenticated: false,
          error: "No active OAuth login. Click 'Login with Codex' to start a new flow.",
        },
        { status: 409 },
      );
    }

    const final = await awaitCodexLoginCompletion(30_000);
    const after = await getCodexAuthStatus();

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
    console.error("[CodexExchange] Error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to verify authentication status" },
      { status: 500 },
    );
  }
}
