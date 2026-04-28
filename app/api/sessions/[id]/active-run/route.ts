import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/local-auth";
import { listAgentRunsBySession } from "@/lib/observability/queries";
import { getOrCreateLocalUser } from "@/lib/db/queries";
import { loadSettings } from "@/lib/settings/settings-manager";
import { isStale } from "@/lib/utils/timestamp";
import { hasPendingInteractiveWait } from "@/lib/interactive-tool-bridge";

function isBackgroundChatRun(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const meta = metadata as Record<string, unknown>;

  return (
    meta.deepResearch === true ||
    meta.suppressFromUI === true ||
    meta.isDelegation === true ||
    meta.taskSource === "channel" ||
    typeof meta.scheduledRunId === "string" ||
    typeof meta.scheduledTaskId === "string"
  );
}

type RouteParams = { params: Promise<{ id: string }> };

/**
 * GET - Check if a session has an active agent run
 * Returns hasActiveRun, runId, and run details if any run is "running"
 */
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const userId = await requireAuth(req);
    const settings = loadSettings();
    const dbUser = await getOrCreateLocalUser(userId, settings.localUserEmail);
    const { id: sessionId } = await params;

    // Get all runs for this session. Read endpoints must not finalize stale-looking
    // runs; long-running providers can be silent while still healthy.
    const runs = await listAgentRunsBySession(sessionId);
    const THIRTY_MINUTES = 30 * 60 * 1000;
    const hasInteractiveWait = hasPendingInteractiveWait(sessionId);

    const activeForegroundChatRun = runs.find((run) =>
      run.status === "running" &&
      run.pipelineName === "chat" &&
      !isBackgroundChatRun(run.metadata)
    );
    const activeRunHealth = activeForegroundChatRun &&
      !hasInteractiveWait &&
      isStale(activeForegroundChatRun.updatedAt ?? activeForegroundChatRun.startedAt, THIRTY_MINUTES)
        ? "stale_suspected"
        : "running";

    const latestDeepResearchRun = runs.find((run) => run.pipelineName === "deep-research");
    const latestDeepResearchMetadata = (
      latestDeepResearchRun?.metadata && typeof latestDeepResearchRun.metadata === "object"
    )
      ? latestDeepResearchRun.metadata as Record<string, unknown>
      : {};

    if (!activeForegroundChatRun) {
      return NextResponse.json({
        hasActiveRun: false,
        runId: null,
        pipelineName: null,
        startedAt: null,
        hasInteractiveWait,
        health: null,
        shouldResumeBackgroundRun: false,
        latestDeepResearchRunId: latestDeepResearchRun?.id ?? null,
        latestDeepResearchStatus: latestDeepResearchRun?.status ?? null,
        latestDeepResearchState: latestDeepResearchMetadata.deepResearchState ?? null,
      });
    }

    return NextResponse.json({
      hasActiveRun: true,
      runId: activeForegroundChatRun.id,
      pipelineName: activeForegroundChatRun.pipelineName,
      startedAt: activeForegroundChatRun.startedAt,
      health: activeRunHealth,
      hasInteractiveWait,
      shouldResumeBackgroundRun: hasInteractiveWait !== true,
      latestDeepResearchRunId: latestDeepResearchRun?.id ?? null,
      latestDeepResearchStatus: latestDeepResearchRun?.status ?? null,
      latestDeepResearchState: latestDeepResearchMetadata.deepResearchState ?? null,
    });
  } catch (error) {
    console.error("Check active run error:", error);
    return NextResponse.json({
      hasActiveRun: false,
      runId: null,
    }, { status: 500 });
  }
}
