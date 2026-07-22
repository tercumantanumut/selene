/**
 * POST /api/browser/[sessionId]/replay
 *
 * Triggers a server-side replay of a recorded browser session.
 * Re-executes each action sequentially using the chromium session manager.
 * The screencast is live, so the dedicated viewer window shows the replay
 * in real time.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  buildReplayPlan,
  initHistory,
  peekHistory,
  recordAction,
  type SessionHistory,
} from "@/lib/browser/action-history";
import {
  executeAction,
  type ActionType,
  type ChromiumWorkspaceInput,
} from "@/lib/ai/tools/chromium-workspace-tool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  // Get the recorded history for this session
  const liveHistory = peekHistory(sessionId);
  let historyToReplay: SessionHistory | null = liveHistory;

  // If no live history, check if the request body contains a history
  if (!historyToReplay) {
    try {
      const body = await req.json() as { history?: SessionHistory };
      if (body.history) {
        historyToReplay = body.history;
      }
    } catch {
      // No body or invalid JSON
    }
  }

  if (!historyToReplay || historyToReplay.actions.length === 0) {
    return NextResponse.json(
      { error: "No history available for replay", sessionId },
      { status: 404 }
    );
  }

  const plan = buildReplayPlan(historyToReplay);

  if (plan.length === 0) {
    return NextResponse.json(
      { error: "No successful actions to replay", sessionId },
      { status: 400 }
    );
  }

  // Execute replay in the background — don't block the HTTP response.
  // The viewer polls /history and receives the screencast via SSE.
  const replaySessionId = `replay-${sessionId}-${Date.now()}`;

  void (async () => {
    initHistory(replaySessionId);

    for (const step of plan) {
      if (step.action === "close" || step.action === "replay") continue;

      const sanitizedStepInput = { ...step.input };
      delete sanitizedStepInput.action;
      const replayInput = {
        ...sanitizedStepInput,
        action: step.action as ActionType,
      } as ChromiumWorkspaceInput;
      const startTime = Date.now();

      try {
        const result = await executeAction(replaySessionId, replayInput, 30_000);
        recordAction(replaySessionId, step.action, replayInput as unknown as Record<string, unknown>, {
          success: true,
          durationMs: Date.now() - startTime,
          output: result.data,
          viewport: result.viewport,
          pageUrl: result.pageUrl,
          pageTitle: result.pageTitle,
          domSnapshot: result.domSnapshot,
          source: "agent",
        });
        // Small delay between actions for visual clarity
        await new Promise((r) => setTimeout(r, 500));
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        recordAction(replaySessionId, step.action, replayInput as unknown as Record<string, unknown>, {
          success: false,
          durationMs: Date.now() - startTime,
          error: errorMsg,
          source: "agent",
        });
        console.error(`[Replay] Action ${step.action} failed:`, err);
        // Continue — best effort replay
      }
    }
  })();

  return NextResponse.json({
    sessionId: replaySessionId,
    originalSessionId: sessionId,
    totalActions: plan.length,
    message: "Replay started. Connect to the screencast stream to observe.",
  });
}
