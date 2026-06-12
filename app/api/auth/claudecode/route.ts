import { NextResponse } from "next/server";
import {
  clearClaudeCodeAuth,
  getClaudeCodeAuthState,
  getClaudeCodeAuthStatus,
  invalidateClaudeCodeAuthCache,
} from "@/lib/auth/claudecode-auth";
import { CLAUDECODE_MODEL_IDS } from "@/lib/auth/claudecode-models";
import { invalidateProviderCacheFor } from "@/lib/ai/providers";
import { invalidateSettingsCache } from "@/lib/settings/settings-manager";

export async function GET(request: Request) {
  try {
    invalidateSettingsCache();
    invalidateClaudeCodeAuthCache();

    const url = new URL(request.url);
    const forceRefresh = url.searchParams.get("refresh") === "1";

    if (forceRefresh) {
      const status = await getClaudeCodeAuthStatus();
      return NextResponse.json({
        success: true,
        authenticated: status.authenticated,
        email: status.email,
        tokenSource: status.tokenSource,
        apiKeySource: status.apiKeySource,
        authUrl: status.authUrl,
        output: status.output,
        error: status.error,
        availableModels: status.authenticated ? [...CLAUDECODE_MODEL_IDS] : [],
      });
    }

    const state = getClaudeCodeAuthState();
    return NextResponse.json({
      success: true,
      authenticated: state.isAuthenticated,
      email: state.email,
      tokenSource: state.tokenSource,
      apiKeySource: state.apiKeySource,
      authUrl: state.authUrl,
      output: state.output,
      error: state.error,
      availableModels: state.isAuthenticated ? [...CLAUDECODE_MODEL_IDS] : [],
    });
  } catch (error) {
    console.error("[ClaudeCodeAuth] Failed to get auth status:", error);
    return NextResponse.json(
      { success: false, error: "Failed to get authentication status" },
      { status: 500 },
    );
  }
}

export async function POST() {
  return NextResponse.json(
    {
      success: false,
      error:
        "Direct token submission is disabled. Start Dario OAuth via /api/auth/claudecode/authorize.",
    },
    { status: 410 },
  );
}

export async function DELETE() {
  try {
    await clearClaudeCodeAuth();
    invalidateProviderCacheFor("claudecode");
    return NextResponse.json({
      success: true,
      message: "Claude Code authentication cleared",
    });
  } catch (error) {
    console.error("[ClaudeCodeAuth] Failed to clear auth:", error);
    return NextResponse.json(
      { success: false, error: "Failed to clear authentication" },
      { status: 500 },
    );
  }
}
