import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/local-auth";
import { getAgentRun } from "@/lib/observability/queries";
import { getOrCreateLocalUser } from "@/lib/db/queries";
import { loadSettings } from "@/lib/settings/settings-manager";
import { isStale } from "@/lib/utils/timestamp";
import { taskRegistry } from "@/lib/background-tasks/registry";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * GET - Get status of a specific agent run
 * Used for polling to detect when run completes
 */
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const userId = await requireAuth(req);
    const settings = loadSettings();
    const dbUser = await getOrCreateLocalUser(userId, settings.localUserEmail);
    const { id: runId } = await params;

    const run = await getAgentRun(runId);

    if (!run || run.userId !== dbUser.id) {
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    }

    const registryTask = taskRegistry.get(runId);
    const isStaleSuspected = run.status === "running" &&
      isStale(run.updatedAt ?? run.startedAt, 30 * 60 * 1000);
    const isZombie = isStaleSuspected && !registryTask;

    const metadata = (run.metadata && typeof run.metadata === "object")
      ? run.metadata as Record<string, unknown>
      : {};
    const deepResearchState = run.pipelineName === "deep-research"
      ? (metadata.deepResearchState ?? null)
      : null;

    return NextResponse.json({
      status: run.status,
      pipelineName: run.pipelineName,
      completedAt: run.completedAt,
      durationMs: run.durationMs,
      updatedAt: run.updatedAt,
      isZombie,
      health: isStaleSuspected ? "stale_suspected" : "running",
      hasRegistryTask: Boolean(registryTask),
      canForceCancel: isZombie,
      deepResearchState,
    });
  } catch (error) {
    console.error("Get run status error:", error);
    return NextResponse.json({ error: "Failed to get run status" }, { status: 500 });
  }
}
