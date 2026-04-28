import { db } from "@/lib/db/sqlite-client";
import { agentRuns } from "@/lib/db/sqlite-observability-schema";
import type { AgentRun } from "@/lib/db/sqlite-observability-schema";
import { INTERNAL_API_SECRET } from "@/lib/config/internal-api-secret";
import { getInternalApiBaseUrl } from "@/lib/utils/environment";
import { eq } from "drizzle-orm";

/**
 * Kick off a Solo Story agent run through the existing Chat API path so
 * run-stream metadata, permission-scope injection, and SSE stay aligned.
 */
export async function queueSoloStoryAgentRun(runId: string): Promise<{ queued: boolean }> {
  const [run] = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1)
    .all();
  if (!run || run.status !== "running") return { queued: false };
  await launchChatRun(run);
  return { queued: true };

  /*
  void launchChatRun(run).catch((error) => {
    console.error(`[solo-story] Failed to launch agent run ${run.id}:`, error);
  });

  return { queued: true };
  */
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
