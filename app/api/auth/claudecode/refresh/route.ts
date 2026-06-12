import { NextResponse } from "next/server";
import { getClaudeCodeAuthStatus } from "@/lib/auth/claudecode-auth";
import { killClaudeLogin, refreshClaudeLogin } from "@/lib/ai/providers/dario/login";

/**
 * POST /api/auth/claudecode/refresh
 *
 * Cancels any pending Dario login subprocess, asks Dario to refresh OAuth if it
 * can, then re-reads the Dario status endpoint for a fresh UI snapshot.
 */
export async function POST() {
  try {
    killClaudeLogin();
    const refresh = await refreshClaudeLogin();
    const status = await getClaudeCodeAuthStatus();

    return NextResponse.json({
      refreshed: status.authenticated,
      authenticated: status.authenticated,
      reason: status.authenticated ? "authenticated" : "not_authenticated",
      output: status.output ?? refresh.output,
      url: status.authUrl ?? null,
      error: status.error ?? refresh.errorMessage,
    });
  } catch (error) {
    console.error("[ClaudeCodeRefresh] Error:", error);
    return NextResponse.json(
      { refreshed: false, reason: "error" },
      { status: 500 },
    );
  }
}
