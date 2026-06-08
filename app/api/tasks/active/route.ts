/**
 * Active Tasks Endpoint
 *
 * Returns active tasks for the authenticated user.
 */

import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/local-auth";
import { taskRegistry } from "@/lib/background-tasks/registry";
import { isTaskSuppressedFromUI, type UnifiedTask } from "@/lib/background-tasks/types";
import { db } from "@/lib/db/sqlite-client";
import { characters, sessions } from "@/lib/db/sqlite-schema";
import { and, eq, inArray } from "drizzle-orm";

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

async function enrichTasksWithDisplayContext(tasks: UnifiedTask[], userId: string): Promise<UnifiedTask[]> {
  const characterIds = uniqueStrings(tasks.map((task) => task.characterId));
  const sessionIds = uniqueStrings(tasks.map((task) => task.sessionId));

  const [characterRows, sessionRows] = await Promise.all([
    characterIds.length > 0
      ? db
        .select({ id: characters.id, name: characters.name, displayName: characters.displayName })
        .from(characters)
        .where(and(eq(characters.userId, userId), inArray(characters.id, characterIds)))
      : Promise.resolve([]),
    sessionIds.length > 0
      ? db
        .select({ id: sessions.id, title: sessions.title })
        .from(sessions)
        .where(and(eq(sessions.userId, userId), inArray(sessions.id, sessionIds)))
      : Promise.resolve([]),
  ]);

  const characterNameById = new Map(
    characterRows.map((character) => [character.id, character.displayName || character.name])
  );
  const sessionTitleById = new Map(
    sessionRows.map((session) => [session.id, session.title])
  );

  return tasks.map((task) => {
    const metadata = task.metadata && typeof task.metadata === "object" ? task.metadata : {};
    const activeTaskAgentName = task.characterId ? characterNameById.get(task.characterId) : undefined;
    const activeTaskSessionTitle = task.sessionId ? sessionTitleById.get(task.sessionId) : undefined;

    if (!activeTaskAgentName && !activeTaskSessionTitle) {
      return task;
    }

    return {
      ...task,
      metadata: {
        ...metadata,
        ...(activeTaskAgentName ? { activeTaskAgentName } : {}),
        ...(activeTaskSessionTitle ? { activeTaskSessionTitle } : {}),
      },
    } as UnifiedTask;
  });
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  let userId: string;
  try {
    userId = await requireAuth(request);
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const { tasks } = taskRegistry.list({ userId });
  const visibleTasks = tasks.filter((task) => !isTaskSuppressedFromUI(task));
  const recentlyCompleted = taskRegistry.listRecentlyCompleted({ userId })
    .filter((task) => !isTaskSuppressedFromUI(task));
  const [enrichedTasks, enrichedRecentlyCompleted] = await Promise.all([
    enrichTasksWithDisplayContext(visibleTasks, userId),
    enrichTasksWithDisplayContext(recentlyCompleted, userId),
  ]);

  return Response.json({
    tasks: enrichedTasks,
    recentlyCompleted: enrichedRecentlyCompleted,
    timestamp: new Date().toISOString(),
  });
}
