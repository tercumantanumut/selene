import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/local-auth";
import { listRunningRunsByCharacter } from "@/lib/observability/queries";
import { getOrCreateLocalUser } from "@/lib/db/queries";
import { loadSettings } from "@/lib/settings/settings-manager";
import { isStale } from "@/lib/utils/timestamp";
import { hasPendingInteractiveWait } from "@/lib/interactive-tool-bridge";

/**
 * GET /api/characters/active-status?ids=id1,id2,id3
 *
 * Batch active-status check. Returns a map of characterId → status.
 * Replaces N individual calls to /api/characters/[id]/active-status.
 */
export async function GET(req: Request) {
  try {
    const userId = await requireAuth(req);
    const settings = loadSettings();
    await getOrCreateLocalUser(userId, settings.localUserEmail);

    const { searchParams } = new URL(req.url);
    const idsParam = searchParams.get("ids") || "";
    const ids = idsParam.split(",").map((id) => id.trim()).filter(Boolean).slice(0, 100);

    if (ids.length === 0) {
      return NextResponse.json({ statuses: {} });
    }

    const THIRTY_MINUTES = 30 * 60 * 1000;
    const statuses: Record<string, { hasActiveSession: boolean; activeSessionId: string | null; health?: "running" | "stale_suspected" }> = {};

    // Check all characters in parallel
    await Promise.all(
      ids.map(async (characterId) => {
        try {
          const runs = await listRunningRunsByCharacter(characterId);
          const hasInteractiveWait = runs.some((run) => hasPendingInteractiveWait(run.sessionId));
          let hasRunning = false;
          let activeSessionId: string | null = null;
          let hasStaleSuspected = false;

          for (const run of runs) {
            if (!hasInteractiveWait && isStale(run.updatedAt ?? run.startedAt, THIRTY_MINUTES)) {
              hasStaleSuspected = true;
            }
            hasRunning = true;
            if (!activeSessionId) {
              activeSessionId = run.sessionId;
            }
          }

          statuses[characterId] = {
            hasActiveSession: hasRunning,
            activeSessionId,
            health: hasStaleSuspected ? "stale_suspected" : "running",
          };
        } catch {
          statuses[characterId] = { hasActiveSession: false, activeSessionId: null };
        }
      })
    );

    return NextResponse.json({ statuses });
  } catch (error) {
    console.error("Batch active status error:", error);
    return NextResponse.json({ statuses: {} }, { status: 500 });
  }
}
