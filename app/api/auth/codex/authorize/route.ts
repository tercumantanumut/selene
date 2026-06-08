import { NextResponse } from "next/server";
import { getCodexAuthStatus } from "@/lib/auth/codex-auth";
import { startCodexLogin } from "@/lib/ai/providers/cliproxy/login";

/**
 * GET /api/auth/codex/authorize
 *
 * If the sidecar already has a Codex credential, short-circuits with
 * `authenticated: true`. Otherwise spawns `cliproxyapi -codex-login` and
 * returns the OAuth URL for the UI to open in a browser. The OAuth callback
 * fires automatically into the sidecar's local server — there's no
 * code-paste step in the new flow.
 */
export async function GET() {
  try {
    const status = await getCodexAuthStatus();
    if (status.authenticated) {
      return NextResponse.json({
        success: true,
        authenticated: true,
        message: "Codex is already authenticated",
      });
    }

    const { url, output } = await startCodexLogin();

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
    console.error("[CodexAuthorize] Failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to prepare authentication" },
      { status: 500 },
    );
  }
}
