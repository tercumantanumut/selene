import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/local-auth";
import { getOrCreateLocalUser } from "@/lib/db/queries";
import { loadSettings } from "@/lib/settings/settings-manager";
import {
  appendToLivePromptQueueBySession,
} from "@/lib/background-tasks/live-prompt-queue-registry";
import {
  hasStopIntent,
  sanitizeLivePromptContent,
} from "@/lib/background-tasks/live-prompt-helpers";
import { sanitizeInspectMessageContext } from "@/lib/design/workspace/inspect-context";
import { sanitizeDesignContext } from "@/lib/design/workspace/design-context";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * POST - Enqueue a user message into the live prompt queue for an active run.
 *
 * Body: { content: string }
 *
 * Returns 200 { queued: true, stopIntent } if successfully enqueued.
 * Returns 409 { queued: false, reason: "no_active_run" } if no active run for this session.
 * Returns 400 if the body is malformed.
 */
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const userId = await requireAuth(req);
    const settings = loadSettings();
    const dbUser = await getOrCreateLocalUser(userId, settings.localUserEmail);
    const { id: sessionId } = await params;

    // Suppress unused variable warning — dbUser validates the user exists
    void dbUser;

    let body: { content?: unknown; inspectContext?: unknown; designContext?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { content } = body;
    // Prefer the unified `designContext` (carries inspect + measurements +
    // colours). Legacy clients may still post `inspectContext`; sanitize that
    // and drop it on the metadata too so old replays don't lose context.
    const designContext = sanitizeDesignContext(body.designContext);
    const inspectContext = designContext
      ? null
      : sanitizeInspectMessageContext(body.inspectContext);

    if (!content || typeof content !== "string" || !content.trim()) {
      return NextResponse.json({ error: "content is required" }, { status: 400 });
    }

    const sanitized = sanitizeLivePromptContent(content);
    const stopIntent = hasStopIntent(sanitized);
    const entryId = `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const metadata = designContext
      ? { designContext }
      : inspectContext
        ? { inspectContext }
        : undefined;

    // appendToLivePromptQueueBySession resolves the active runId from the session index.
    // Returns false when no active run exists for this session — O(1), no DB round-trip.
    const queued = appendToLivePromptQueueBySession(sessionId, {
      id: entryId,
      content: sanitized,
      stopIntent,
      metadata,
    });

    if (!queued) {
      return NextResponse.json(
        { queued: false, reason: "no_active_run" },
        { status: 409 }
      );
    }

    // NOTE: The user message is NOT persisted here.
    // It is saved in prepareStep (route.ts) at the correct ordering position —
    // after the pre-injection streaming assistant message is flushed and sealed,
    // ensuring the injected message appears in the right place in chat history.

    console.log(
      `[LivePromptQueue] Enqueued for session ${sessionId} ` +
      `(stopIntent=${stopIntent}, length=${sanitized.length})`
    );

    return NextResponse.json({ queued: true, stopIntent });
  } catch (error) {
    console.error("[LivePromptQueue] Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
