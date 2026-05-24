import { NextResponse } from "next/server";
import { getCodexAuthStatus } from "@/lib/auth/codex-auth";
import { killCodexLogin } from "@/lib/ai/providers/cliproxy/login";

/**
 * POST /api/auth/codex/refresh
 *
 * Cancels any pending login subprocess and re-reads the sidecar credential
 * dir to produce a fresh status snapshot. Token refresh against OpenAI
 * itself is owned by the sidecar — selene no longer holds refresh tokens.
 */
export async function POST() {
  try {
    killCodexLogin();
    const status = await getCodexAuthStatus();

    return NextResponse.json({
      refreshed: status.authenticated,
      authenticated: status.authenticated,
      reason: status.authenticated ? "authenticated" : "not_authenticated",
      output: status.output,
      url: status.authUrl ?? null,
      error: status.error,
    });
  } catch (error) {
    console.error("[CodexRefresh] Error:", error);
    return NextResponse.json(
      { refreshed: false, reason: "error" },
      { status: 500 },
    );
  }
}
