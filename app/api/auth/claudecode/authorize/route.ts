import { NextResponse } from "next/server";
import { getClaudeCodeAuthStatus } from "@/lib/auth/claudecode-auth";
import { startClaudeLogin } from "@/lib/ai/providers/cliproxy/login";

/**
 * GET /api/auth/claudecode/authorize
 *
 * If the sidecar already has a credential on file, short-circuits with
 * `authenticated: true`. Otherwise spawns `cliproxyapi -claude-login` and
 * returns the OAuth URL for the UI to open in a browser. The OAuth callback
 * fires automatically into the sidecar — there's no code-paste step.
 */
export async function GET() {
  try {
    const status = await getClaudeCodeAuthStatus();
    if (status.authenticated) {
      return NextResponse.json({
        success: true,
        authenticated: true,
        message: "Claude Code is already authenticated",
      });
    }

    const { url, output } = await startClaudeLogin();

    return NextResponse.json({
      success: true,
      authenticated: false,
      url: url ?? null,
      output,
      message: url
        ? "Open the provided URL to authenticate; this dialog will refresh when the OAuth callback completes."
        : "Could not detect the OAuth URL — check that the CLIProxyAPI sidecar is installed.",
    });
  } catch (error) {
    console.error("[ClaudeCodeAuthorize] Failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to prepare authentication" },
      { status: 500 },
    );
  }
}
