import { NextResponse } from "next/server";
import {
  clearCodexAuth,
  getCodexAuthState,
  getCodexAuthStatus,
  invalidateCodexAuthCache,
} from "@/lib/auth/codex-auth";
import { CODEX_MODEL_IDS } from "@/lib/auth/codex-models";
import { invalidateProviderCacheFor } from "@/lib/ai/providers";
import { invalidateSettingsCache } from "@/lib/settings/settings-manager";
import { authRouteErrorResponse } from "@/lib/api/shared-handlers";

export async function GET(request: Request) {
  try {
    invalidateSettingsCache();
    invalidateCodexAuthCache();

    const url = new URL(request.url);
    const forceRefresh = url.searchParams.get("refresh") === "1";

    if (forceRefresh) {
      const status = await getCodexAuthStatus();
      return NextResponse.json({
        success: true,
        authenticated: status.authenticated,
        email: status.email,
        accountId: status.accountId,
        plan: status.plan,
        tokenSource: status.tokenSource,
        authUrl: status.authUrl,
        output: status.output,
        error: status.error,
        availableModels: status.authenticated ? CODEX_MODEL_IDS : [],
      });
    }

    const state = getCodexAuthState();
    return NextResponse.json({
      success: true,
      authenticated: state.isAuthenticated,
      email: state.email,
      accountId: state.accountId,
      plan: state.plan,
      tokenSource: state.tokenSource,
      authUrl: state.authUrl,
      output: state.output,
      error: state.error,
      availableModels: state.isAuthenticated ? CODEX_MODEL_IDS : [],
    });
  } catch (error) {
    console.error("[CodexAuth] Failed to get auth status:", error);
    return authRouteErrorResponse("Failed to get authentication status");
  }
}

export async function POST() {
  return NextResponse.json(
    {
      success: false,
      error:
        "Manual token submission is disabled. Start OAuth via /api/auth/codex/authorize.",
    },
    { status: 410 },
  );
}

export async function DELETE() {
  try {
    await clearCodexAuth();
    invalidateProviderCacheFor("codex");
    return NextResponse.json({
      success: true,
      message: "Codex authentication cleared",
    });
  } catch (error) {
    console.error("[CodexAuth] Failed to clear auth:", error);
    return authRouteErrorResponse("Failed to clear authentication");
  }
}
