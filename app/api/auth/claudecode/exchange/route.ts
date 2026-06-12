import { NextResponse } from "next/server";
import { getClaudeCodeAuthStatus } from "@/lib/auth/claudecode-auth";
import {
  awaitClaudeLoginCompletion,
  getClaudeLoginState,
  submitClaudeLoginCode,
} from "@/lib/ai/providers/dario/login";

/**
 * POST /api/auth/claudecode/exchange
 *
 * Writes the pasted Claude OAuth code to the active `dario login --manual`
 * subprocess, waits briefly for Dario to persist credentials, then returns the
 * refreshed Dario auth status. Idempotent when already authenticated.
 */
export async function POST(request: Request) {
  try {
    const before = await getClaudeCodeAuthStatus();
    if (before.authenticated) {
      return NextResponse.json({
        success: true,
        authenticated: true,
        output: before.output,
      });
    }

    const loginState = getClaudeLoginState();
    if (!loginState || !loginState.active) {
      return NextResponse.json(
        {
          success: false,
          authenticated: false,
          error:
            "No active Dario OAuth login. Click 'Login with Claude' to start a new flow.",
        },
        { status: 409 },
      );
    }

    const body = await request.json().catch(() => ({}));
    const code = typeof body?.code === "string" ? body.code : "";
    submitClaudeLoginCode(code);

    const final = await awaitClaudeLoginCompletion(30_000);
    const after = await getClaudeCodeAuthStatus();

    return NextResponse.json({
      success: after.authenticated,
      authenticated: after.authenticated,
      error: after.authenticated
        ? undefined
        : final?.errorMessage ?? after.error ?? "OAuth flow did not complete in time. Try again.",
      output: final?.output ?? after.output,
      url: final?.url ?? after.authUrl ?? null,
    });
  } catch (error) {
    console.error("[ClaudeCodeExchange] Error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to verify authentication status" },
      { status: 500 },
    );
  }
}
