/**
 * Context Status API Endpoint
 *
 * Returns the current context window status for a session.
 * Used by the UI to display context usage indicators.
 *
 * GET /api/sessions/[id]/context-status
 *
 * @returns {
 *   percentage: number;      // Usage percentage (0-100)
 *   status: string;          // "safe" | "warning" | "critical" | "exceeded"
 *   currentTokens: number;   // Current token count
 *   maxInputTokens: number;  // Provider-enforced input budget for request safety
 *   maxTokens: number;       // Maximum advertised context tokens for the model
 *   formatted: {
 *     current: string;       // e.g., "150.2K"
 *     max: string;           // e.g., "200K"
 *     percentage: string;    // e.g., "75.1%"
 *   };
 *   thresholds: {
 *     warning: number;
 *     critical: number;
 *     hardLimit: number;
 *   };
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { ContextWindowManager } from "@/lib/context-window";
import { getSession, getSessionMessagesFingerprint } from "@/lib/db/queries";
import { requireAuth } from "@/lib/auth/local-auth";
import { getSessionModelIdForSession, getSessionProviderForSession } from "@/lib/ai/session-model-resolver";
import type { LLMProvider } from "@/lib/ai/provider-types";

type RouteParams = {
  params: Promise<{ id: string }>;
};

// The UI polls this every few seconds during a run, and computing it parses
// and re-serializes every non-compacted message. Reuse the last result until
// the session's messages, summary or model change. The TTL bounds staleness
// for inputs outside the key (e.g. context-window settings).
const STATUS_CACHE_MAX_ENTRIES = 50;
const STATUS_CACHE_TTL_MS = 60_000;
const statusCache = new Map<
  string,
  { key: string; body: Record<string, unknown>; storedAt: number }
>();

function rememberStatus(sessionId: string, key: string, body: Record<string, unknown>): void {
  statusCache.delete(sessionId);
  statusCache.set(sessionId, { key, body, storedAt: Date.now() });
  if (statusCache.size > STATUS_CACHE_MAX_ENTRIES) {
    const oldest = statusCache.keys().next().value;
    if (oldest !== undefined) statusCache.delete(oldest);
  }
}

export async function GET(
  request: NextRequest,
  { params }: RouteParams
) {
  try {
    await requireAuth(request);
    const { id: sessionId } = await params;

    const session = await getSession(sessionId);
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sessionMetadata = (session.metadata as Record<string, unknown>) || {};

    const modelId = await getSessionModelIdForSession(sessionMetadata);
    const provider: LLMProvider = await getSessionProviderForSession(sessionMetadata);

    const cacheKey = [
      await getSessionMessagesFingerprint(sessionId),
      session.updatedAt,
      session.summary?.length ?? 0,
      modelId,
      provider,
    ].join("|");
    const cached = statusCache.get(sessionId);
    if (cached?.key === cacheKey && Date.now() - cached.storedAt < STATUS_CACHE_TTL_MS) {
      return NextResponse.json(cached.body);
    }

    // Estimate system prompt length (approximate)
    const estimatedSystemPromptLength = 5000;

    // Get context window status
    const status = await ContextWindowManager.checkContextWindow(
      sessionId,
      modelId,
      estimatedSystemPromptLength,
      provider,
      { includeProviderReportedUsageFloor: true }
    );

    const body = {
      percentage: status.usagePercentage * 100,
      status: status.status,
      currentTokens: status.currentTokens,
      maxInputTokens: status.maxInputTokens,
      maxTokens: status.maxTokens,
      maxOutputTokens: status.maxOutputTokens,
      formatted: status.formatted,
      thresholds: status.thresholds,
      shouldCompact: status.shouldCompact,
      mustCompact: status.mustCompact,
      recommendedAction: status.recommendedAction,
      model: {
        id: modelId,
        provider,
      },
    };
    rememberStatus(sessionId, cacheKey, body);
    return NextResponse.json(body);
  } catch (error) {
    console.error("[Context Status API] Error:", error);
    return NextResponse.json(
      { error: "Failed to get context status" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/sessions/[id]/context-status
 *
 * Trigger manual compaction for a session.
 */
export async function POST(
  request: NextRequest,
  { params }: RouteParams
) {
  try {
    await requireAuth(request);
    const { id: sessionId } = await params;

    const session = await getSession(sessionId);
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sessionMetadata = (session.metadata as Record<string, unknown>) || {};

    const modelId = await getSessionModelIdForSession(sessionMetadata);
    const provider: LLMProvider = await getSessionProviderForSession(sessionMetadata);

    // Estimate system prompt length
    const estimatedSystemPromptLength = 5000;

    // Force compaction (aggressive — used by /compact command and UI button)
    const result = await ContextWindowManager.forceCompact(
      sessionId,
      modelId,
      estimatedSystemPromptLength,
      provider
    );

    return NextResponse.json({
      success: result.success,
      compacted: result.success,
      tokensFreed: result.compactionResult.tokensFreed,
      messagesCompacted: result.compactionResult.messagesCompacted,
      before: {
        percentage: result.beforeStatus.usagePercentage * 100,
        status: result.beforeStatus.status,
        currentTokens: result.beforeStatus.currentTokens,
        maxInputTokens: result.beforeStatus.maxInputTokens,
        maxTokens: result.beforeStatus.maxTokens,
        maxOutputTokens: result.beforeStatus.maxOutputTokens,
        formatted: result.beforeStatus.formatted,
      },
      status: {
        percentage: result.afterStatus.usagePercentage * 100,
        status: result.afterStatus.status,
        currentTokens: result.afterStatus.currentTokens,
        maxInputTokens: result.afterStatus.maxInputTokens,
        maxTokens: result.afterStatus.maxTokens,
        maxOutputTokens: result.afterStatus.maxOutputTokens,
        formatted: result.afterStatus.formatted,
        thresholds: result.afterStatus.thresholds,
        shouldCompact: result.afterStatus.shouldCompact,
        mustCompact: result.afterStatus.mustCompact,
        recommendedAction: result.afterStatus.recommendedAction,
      },
    });
  } catch (error) {
    console.error("[Context Status API] Compaction error:", error);
    return NextResponse.json(
      { error: "Failed to compact session" },
      { status: 500 }
    );
  }
}
