import { NextResponse } from "next/server";
import {
  getClaudeCodeAuthStatus,
  verifyClaudeCodeAuthenticatedAfterDarioLogin,
  verifyClaudeCodeAuthenticatedAfterSdkLogin,
} from "@/lib/auth/claudecode-auth";
import {
  awaitClaudeLoginCompletion,
  getClaudeLoginState,
  submitClaudeLoginCode,
} from "@/lib/ai/providers/dario/login";
import { getClaudeCodeBackend } from "@/lib/ai/providers";
import {
  hasActiveLogin as hasActiveSdkLogin,
  submitClaudeLoginCode as submitSdkLoginCode,
} from "@/lib/ai/providers/claudecode-sdk/login-process";

/**
 * POST /api/auth/claudecode/exchange
 *
 * Writes the pasted Claude OAuth code to the active `dario login --manual`
 * subprocess, waits briefly for Dario to persist credentials, then returns the
 * refreshed Dario auth status. Idempotent when already authenticated.
 */
function claudeCodeExchangeErrorStatus(message: string): number {
  if (/No active Dario OAuth login/i.test(message)) return 409;
  if (/Paste the authorization code/i.test(message)) return 400;
  return 500;
}

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

    // ── Agent SDK backend ───────────────────────────────────────────────────
    if (getClaudeCodeBackend() === "sdk") {
      if (!hasActiveSdkLogin()) {
        return NextResponse.json(
          {
            success: false,
            authenticated: false,
            error: "No active Claude Agent SDK login. Click 'Login with Claude' to start a new flow.",
          },
          { status: 409 },
        );
      }

      const sdkBody = await request.json().catch(() => ({}));
      const sdkCode = typeof sdkBody?.code === "string" ? sdkBody.code : "";
      const submit = await submitSdkLoginCode(sdkCode);
      const after = await verifyClaudeCodeAuthenticatedAfterSdkLogin();

      return NextResponse.json({
        success: after.authenticated,
        authenticated: after.authenticated,
        error: after.authenticated
          ? undefined
          : after.error ?? submit.error ?? "OAuth flow did not complete in time. Try again.",
        output: after.output,
        url: after.authUrl ?? null,
      });
    }

    // ── Dario backend (default) ─────────────────────────────────────────────
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
    const after = await verifyClaudeCodeAuthenticatedAfterDarioLogin(final?.output ?? []);

    return NextResponse.json({
      success: after.authenticated,
      authenticated: after.authenticated,
      error: after.authenticated
        ? undefined
        : after.error ?? final?.errorMessage ?? "OAuth flow did not complete in time. Try again.",
      output: after.output ?? final?.output,
      url: final?.url ?? after.authUrl ?? null,
    });
  } catch (error) {
    console.error("[ClaudeCodeExchange] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to verify authentication status";
    return NextResponse.json(
      { success: false, authenticated: false, error: message },
      { status: claudeCodeExchangeErrorStatus(message) },
    );
  }
}
