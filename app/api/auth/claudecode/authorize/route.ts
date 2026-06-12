import { NextResponse } from "next/server";
import {
  getClaudeCodeAuthStatus,
  verifyClaudeCodeAuthenticatedAfterDarioLogin,
} from "@/lib/auth/claudecode-auth";
import {
  isSuccessfulClaudeLoginOutput,
  startClaudeLogin,
} from "@/lib/ai/providers/dario/login";

/**
 * GET /api/auth/claudecode/authorize
 *
 * If Dario already has usable Claude credentials, short-circuits with
 * `authenticated: true`. Otherwise starts `dario login --manual --no-proxy`
 * and returns the OAuth URL for the UI to open. The UI posts the pasted code
 * to /exchange, which writes it to the active Dario login subprocess.
 */
export async function GET() {
  try {
    const status = await getClaudeCodeAuthStatus();
    if (status.authenticated) {
      return NextResponse.json({
        success: true,
        authenticated: true,
        message: "Claude Code is already authenticated through Dario",
      });
    }

    const { url, output } = await startClaudeLogin();

    // `dario login --manual --no-proxy` can complete without printing an OAuth
    // URL when existing credentials are valid or only needed a refresh. Treat
    // Dario's success output as a reason to verify the sidecar immediately, not
    // as a reason to ask the user for a nonexistent manual code.
    if (!url) {
      if (isSuccessfulClaudeLoginOutput(output)) {
        const verified = await verifyClaudeCodeAuthenticatedAfterDarioLogin(output);
        if (verified.authenticated) {
          return NextResponse.json({
            success: true,
            authenticated: true,
            output,
            message: "Claude Code credentials are available through Dario",
          });
        }

        return NextResponse.json(
          {
            success: false,
            authenticated: false,
            output,
            error: verified.error ?? "Dario credentials were found, but Selene could not verify the local Dario sidecar.",
          },
          { status: 502 },
        );
      }

      const refreshedStatus = await getClaudeCodeAuthStatus();
      if (refreshedStatus.authenticated) {
        return NextResponse.json({
          success: true,
          authenticated: true,
          output,
          message: "Claude Code credentials were refreshed through Dario",
        });
      }

      return NextResponse.json(
        {
          success: false,
          authenticated: false,
          output,
          error: "Dario did not return an authentication URL or verified credentials.",
        },
        { status: 502 },
      );
    }

    return NextResponse.json({
      success: true,
      authenticated: false,
      url: url ?? null,
      output,
      message: url
        ? "Open the provided URL to authenticate, then paste the Claude code shown by the browser."
        : "Dario did not print an OAuth URL. Check the diagnostic output and try again.",
    });
  } catch (error) {
    console.error("[ClaudeCodeAuthorize] Failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to prepare authentication" },
      { status: 500 },
    );
  }
}
