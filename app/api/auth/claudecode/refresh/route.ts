import { NextResponse } from "next/server";
import { getClaudeCodeAuthStatus } from "@/lib/auth/claudecode-auth";
import { killClaudeLogin } from "@/lib/ai/providers/cliproxy/login";

/**
 * POST /api/auth/claudecode/refresh
 *
 * Cancels any pending login subprocess and re-reads the sidecar credential
 * dir to produce a fresh status snapshot.
 */
export async function POST() {
  try {
    killClaudeLogin();
    const status = await getClaudeCodeAuthStatus();

    return NextResponse.json({
      refreshed: status.authenticated,
      authenticated: status.authenticated,
      reason: status.authenticated ? "authenticated" : "not_authenticated",
      output: status.output,
      url: status.authUrl ?? null,
      error: status.error,
    });
  } catch (error) {
    console.error("[ClaudeCodeRefresh] Error:", error);
    return NextResponse.json(
      { refreshed: false, reason: "error" },
      { status: 500 },
    );
  }
}
