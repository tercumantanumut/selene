import { db } from "@/lib/db/sqlite-client";
import {
  agentRunEvents,
  agentRuns,
} from "@/lib/db/sqlite-observability-schema";
import { lobbies } from "@/lib/db/sqlite-lobbies-schema";
import type { AgentRun } from "@/lib/db/sqlite-observability-schema";
import { INTERNAL_API_SECRET } from "@/lib/config/internal-api-secret";
import { getInternalApiBaseUrl } from "@/lib/utils/environment";
import { durationMs as durationMsFrom, nowISO } from "@/lib/utils/timestamp";
import { eq, sql } from "drizzle-orm";

/**
 * Kick off a Solo Story agent run through the existing Chat API path so
 * run-stream metadata, permission-scope injection, and SSE stay aligned.
 */
export function queueSoloStoryAgentRun(runId: string): { queued: true } {
  void launchSoloStoryAgentRun(runId).catch((error) => {
    console.error(`[solo-story] Failed to launch agent run ${runId}:`, error);
  });

  return { queued: true };
}

async function launchSoloStoryAgentRun(runId: string): Promise<void> {
  const [run] = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1)
    .all();
  if (!run || run.status !== "running") return;

  try {
    await launchChatRun(run);
  } catch (error) {
    await markRunLaunchFailed(run, error);
    throw error;
  }
}

async function markRunLaunchFailed(run: AgentRun, error: unknown): Promise<void> {
  const completedAt = nowISO();
  const metadata = (run.metadata ?? {}) as Record<string, unknown>;
  const message = error instanceof Error ? error.message : String(error);

  await db.transaction((tx) => {
    tx.update(agentRuns)
      .set({
        status: "failed",
        completedAt,
        durationMs: durationMsFrom(run.startedAt, completedAt),
        updatedAt: completedAt,
        metadata: {
          ...metadata,
          launchError: message,
          launchFailedAt: completedAt,
        },
      })
      .where(eq(agentRuns.id, run.id))
      .run();
    tx.insert(agentRunEvents)
      .values({
        runId: run.id,
        eventType: "run_completed",
        level: "error",
        pipelineName: run.pipelineName,
        data: { status: "failed", phase: "launch", error: message },
        timestamp: completedAt,
        durationMs: durationMsFrom(run.startedAt, completedAt),
      })
      .run();

    const soloStory = metadata.soloStory as { lobbyId?: string; role?: string } | undefined;
    if (soloStory?.role === "synthesizer" && soloStory.lobbyId) {
      tx.update(lobbies)
        .set({
          synthesisRunId: null,
          lockVersion: sql`${lobbies.lockVersion} + 1`,
          updatedAt: completedAt,
        })
        .where(eq(lobbies.synthesisRunId, run.id))
        .run();
    }
  });
}

async function launchChatRun(run: AgentRun): Promise<void> {
  const body = {
    messages: [
      {
        role: "user",
        content: buildPromptForRun(run),
      },
    ],
  };

  const response = await fetch(`${getInternalApiBaseUrl()}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Auth": INTERNAL_API_SECRET,
      "X-Session-Id": run.sessionId,
      "X-Agent-Run-Id": run.id,
      ...(run.characterId ? { "X-Character-Id": run.characterId } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Chat API returned ${response.status}: ${await response.text()}`);
  }

  const reader = response.body?.getReader();
  if (!reader) return;
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

function buildPromptForRun(run: AgentRun): string {
  const metadata = (run.metadata ?? {}) as Record<string, unknown>;
  const soloStory = metadata.soloStory as
    | { lobbyId?: string; cardId?: string; role?: string }
    | undefined;
  if (soloStory?.role === "synthesizer") {
    return [
      "You are the synthesizer for this Solo Story lobby.",
      `Lobby id: ${soloStory.lobbyId ?? "unknown"}`,
      "Read the approved cards and produce the final artifact for the captain.",
      "When finished, persist the artifact through the Solo Story synthesis completion path.",
    ].join("\n");
  }
  if (soloStory?.role === "planner") {
    return [
      "You are the planner for this Solo Story lobby.",
      `Lobby id: ${soloStory.lobbyId ?? "unknown"}`,
      "Create the execution card plan and dependencies for the captain to review.",
    ].join("\n");
  }
  return [
    "You are executing a Solo Story card.",
    `Lobby id: ${soloStory?.lobbyId ?? "unknown"}`,
    `Card id: ${soloStory?.cardId ?? "unknown"}`,
    "Complete the assigned card and report the result.",
  ].join("\n");
}
