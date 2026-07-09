import { NextResponse } from "next/server";
import { getClaudeCodeAuthStatus } from "@/lib/auth/claudecode-auth";
import { killClaudeLogin, refreshClaudeLogin } from "@/lib/ai/providers/dario/login";
import { getClaudeCodeBackend } from "@/lib/ai/providers";
import { killLoginProcess as killSdkLoginProcess } from "@/lib/ai/providers/claudecode-sdk/login-process";

/**
 * POST /api/auth/claudecode/refresh
 *
 * Cancels any pending login subprocess, then re-reads the active backend's
 * status for a fresh UI snapshot. For Dario this also asks the sidecar to
 * refresh OAuth; the Agent SDK refreshes tokens internally on its next query.
 */
export async function POST() {
  try {
    // ── Agent SDK backend ───────────────────────────────────────────────────
    if (getClaudeCodeBackend() === "sdk") {
      killSdkLoginProcess();
      const status = await getClaudeCodeAuthStatus();
      return NextResponse.json({
        refreshed: status.authenticated,
        authenticated: status.authenticated,
        reason: status.authenticated ? "authenticated" : "not_authenticated",
        output: status.output,
        url: status.authUrl ?? null,
        error: status.error,
      });
    }

    // ── Dario backend (default) ─────────────────────────────────────────────
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
