import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/local-auth";
import {
  getSessionMessagesSince,
  getSessionWithMessages,
  updateMessage,
  getOrCreateLocalUser,
} from "@/lib/db/queries";
import type { DBToolCallPart } from "@/lib/messages/converter";
import { loadSettings } from "@/lib/settings/settings-manager";
import { listAgentRunsBySession } from "@/lib/observability/queries";
import { isStale } from "@/lib/utils/timestamp";
import { shouldKeepDelegatedToolCallPending } from "@/app/api/chat/streaming-state";

type RouteParams = { params: Promise<{ id: string }> };

export function sealDanglingToolCallsInContent(
  content: unknown
): { content: unknown; changed: boolean } {
  if (!Array.isArray(content) || content.length === 0) {
    return { content, changed: false };
  }

  const parts = content as Array<Record<string, unknown>>;
  const toolResultIds = new Set<string>();

  for (const part of parts) {
    if (part.type === "tool-result" && typeof part.toolCallId === "string") {
      toolResultIds.add(part.toolCallId);
    }
  }

  let changed = false;
  const nextParts: Array<Record<string, unknown>> = [];

  for (const part of parts) {
    nextParts.push(part);
    if (part.type !== "tool-call") continue;

    const toolCallId = typeof part.toolCallId === "string" ? part.toolCallId : "";
    if (!toolCallId || toolResultIds.has(toolCallId)) continue;

    const state = typeof part.state === "string" ? part.state : undefined;
    if (state !== "input-available" && state !== "input-streaming") continue;

    if (shouldKeepDelegatedToolCallPending(part as unknown as DBToolCallPart)) continue;

    part.state = "output-error";
    if (part.args === undefined) {
      part.args = {};
    }

    nextParts.push({
      type: "tool-result",
      toolCallId,
      toolName: typeof part.toolName === "string" ? part.toolName : "tool",
      result: {
        status: "error",
        error: "Tool execution ended before a final result was persisted.",
        reconstructed: true,
      },
      status: "error",
      state: "output-error",
      timestamp: new Date().toISOString(),
    });

    toolResultIds.add(toolCallId);
    changed = true;
  }

  return changed ? { content: nextParts, changed: true } : { content, changed: false };
}

// The next cursor trails the server clock so a row written while a response
// is in flight is still returned by the following poll. Re-sending the few
// rows updated in this window is cheap and the client merges them by id.
const CURSOR_OVERLAP_MS = 2000;

type SessionMessageRow = NonNullable<
  Awaited<ReturnType<typeof getSessionWithMessages>>
>["messages"][number];

async function sealDanglingToolCalls(rows: SessionMessageRow[]): Promise<SessionMessageRow[]> {
  return Promise.all(
    rows.map(async (message) => {
      if (message.role !== "assistant") return message;
      const metadata = (message.metadata ?? {}) as Record<string, unknown>;
      if (metadata.isStreaming === true) return message;

      const repaired = sealDanglingToolCallsInContent(message.content);
      if (!repaired.changed) return message;

      await updateMessage(message.id, { content: repaired.content as any });
      return { ...message, content: repaired.content };
    })
  );
}

/**
 * GET - Fetch messages for a session
 * Used to refresh messages after background processing completes.
 *
 * With `?since=<cursor>` only rows updated at or after the cursor are returned,
 * together with `ids` (every message id, in order) so the client can apply
 * inserts, deletes and reordering. Every response carries the next `cursor`.
 */
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const userId = await requireAuth(req);
    const settings = loadSettings();
    const dbUser = await getOrCreateLocalUser(userId, settings.localUserEmail);
    const { id: sessionId } = await params;
    const since = new URL(req.url).searchParams.get("since");
    const cursor = new Date(Date.now() - CURSOR_OVERLAP_MS).toISOString();

    if (since) {
      const delta = await getSessionMessagesSince(sessionId, since);
      if (!delta || delta.session.userId !== dbUser.id) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }

      return NextResponse.json({
        messages: await sealDanglingToolCalls(delta.messages),
        ids: delta.ids,
        cursor,
        incremental: true,
      });
    }

    const sessionWithMessages = await getSessionWithMessages(sessionId);

    if (!sessionWithMessages || sessionWithMessages.session.userId !== dbUser.id) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    return NextResponse.json({
      messages: await sealDanglingToolCalls(sessionWithMessages.messages),
      cursor,
    });
  } catch (error) {
    console.error("Fetch session messages error:", error);
    return NextResponse.json({ error: "Failed to fetch messages" }, { status: 500 });
  }
}
