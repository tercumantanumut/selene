import { db } from "./sqlite-client";
import { sessions, messages, toolRuns } from "./sqlite-schema";
import type { NewMessage, NewToolRun } from "./sqlite-schema";
import { eq, desc, asc, and, sql, or, inArray } from "drizzle-orm";
import { parseMessageMetadata } from "@/lib/messages/parse-metadata";

function countsTowardVisibleConversation(message: Pick<NewMessage, "role" | "metadata">): boolean {
  if (message.role !== "user" && message.role !== "assistant") return false;
  if (message.role === "assistant") return true;
  return parseMessageMetadata(message.metadata)?.livePromptInjected !== true;
}

function visibleConversationCountSql(sessionId: string) {
  return sql<number>`COALESCE((
    SELECT COUNT(*)
    FROM ${messages}
    WHERE ${messages.sessionId} = ${sessionId}
      AND ${messages.role} IN ('user', 'assistant')
      AND (
        ${messages.role} != 'user'
        OR json_extract(${messages.metadata}, '$.livePromptInjected') IS NULL
        OR json_extract(${messages.metadata}, '$.livePromptInjected') = 0
      )
  ), 0)`;
}

// Messages
export async function createMessage(data: NewMessage) {
  try {
    const countsAsVisibleConversation = countsTowardVisibleConversation(data);
    const [message] = await db
      .insert(messages)
      .values(data)
      .returning();

    if (message) {
      const tokenCount = typeof message.tokenCount === "number" ? message.tokenCount : 0;
      const nowIso = new Date().toISOString();
      await db
        .update(sessions)
        .set({
          updatedAt: countsAsVisibleConversation ? nowIso : sessions.updatedAt,
          lastMessageAt: countsAsVisibleConversation ? nowIso : sessions.lastMessageAt,
          // Recompute from persisted rows to avoid incremental drift in mixed
          // visibility flows (e.g. livePromptInjected reconciliation).
          messageCount: visibleConversationCountSql(data.sessionId),
          totalTokenCount: sql`${sessions.totalTokenCount} + ${tokenCount}`,
        })
        .where(eq(sessions.id, data.sessionId));
    }

    return message;
  } catch (error) {
    // Handle unique constraint violation (message already exists)
    if ((error as Error).message?.includes('UNIQUE constraint failed')) {
      return undefined;
    }
    throw error;
  }
}

export async function getMessageById(id: string) {
  return db.query.messages.findFirst({
    where: eq(messages.id, id),
  });
}

export async function getMessages(sessionId: string) {
  return db.query.messages.findMany({
    where: eq(messages.sessionId, sessionId),
    orderBy: [
      // Push NULL orderingIndex values to the end for backward compatibility
      asc(sql`case when ${messages.orderingIndex} is null then 1 else 0 end`),
      asc(messages.orderingIndex),
      // Fallback to creation time for legacy/NULL rows
      asc(messages.createdAt),
    ],
  });
}

export async function getObserveMessageSummary(sessionId: string, previewAssistantCount: number) {
  const normalizedPreviewCount = Math.max(0, Math.trunc(previewAssistantCount));
  const recentAssistantMessages = normalizedPreviewCount > 0
    ? await db.query.messages.findMany({
        where: and(
          eq(messages.sessionId, sessionId),
          eq(messages.role, "assistant"),
        ),
        orderBy: [desc(messages.orderingIndex), desc(messages.createdAt)],
        limit: normalizedPreviewCount,
      })
    : [];

  const [assistantCountRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.role, "assistant")));

  const [messageCountRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(messages)
    .where(eq(messages.sessionId, sessionId));

  const [toolCountRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.role, "tool")));

  return {
    recentAssistantMessages: recentAssistantMessages.reverse(),
    assistantMessageCount: assistantCountRow?.count ?? 0,
    messageCount: messageCountRow?.count ?? 0,
    toolMessageCount: toolCountRow?.count ?? 0,
  };
}

/**
 * Get compact step descriptions for tool activity since a watermark.
 * Returns tool name + brief arg summary for each tool message after `afterOrderingIndex`.
 * Used by observe() to provide incremental progress visibility.
 */
export async function getObserveStepsSince(
  sessionId: string,
  afterOrderingIndex: number,
  limit = 50,
): Promise<{ steps: Array<{ toolName: string; summary: string; orderingIndex: number }>; maxOrderingIndex: number }> {
  const rows = await db.query.messages.findMany({
    where: and(
      eq(messages.sessionId, sessionId),
      or(eq(messages.role, "tool"), eq(messages.role, "assistant")),
      sql`${messages.orderingIndex} > ${afterOrderingIndex}`,
    ),
    orderBy: [asc(messages.orderingIndex), asc(messages.createdAt)],
    limit,
    columns: {
      role: true,
      toolName: true,
      content: true,
      orderingIndex: true,
    },
  });

  const steps: Array<{ toolName: string; summary: string; orderingIndex: number }> = [];
  let maxOrderingIndex = afterOrderingIndex;

  for (const row of rows) {
    const idx = row.orderingIndex ?? 0;
    if (idx > maxOrderingIndex) maxOrderingIndex = idx;

    // Extract tool invocations from assistant messages (AI SDK format)
    if (row.role === "assistant" && Array.isArray(row.content)) {
      for (const part of row.content as Array<Record<string, unknown>>) {
        if (part.type === "tool-call" && typeof part.toolName === "string") {
          steps.push({
            toolName: part.toolName as string,
            summary: extractToolCallSummary(part.toolName as string, part.args),
            orderingIndex: idx,
          });
        }
      }
    }
    // tool-role messages have toolName at message level
    else if (row.role === "tool" && row.toolName) {
      // Skip tool result messages — we already captured the call from the assistant message
      // Only include if we didn't already have a step for this tool (handles edge cases)
    }
  }

  return { steps, maxOrderingIndex };
}

/**
 * Build a one-line summary of a tool call from its name and args.
 * Keeps it very compact — e.g. "readFile → lib/db/queries.ts"
 */
function extractToolCallSummary(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return toolName;
  const a = args as Record<string, unknown>;

  // Common tool patterns — extract the most informative arg
  const fileArg = a.file_path ?? a.filePath ?? a.path ?? a.file;
  if (typeof fileArg === "string") return `${shortenPath(fileArg)}`;

  const patternArg = a.pattern ?? a.query ?? a.search ?? a.regex;
  if (typeof patternArg === "string") return `"${truncate(patternArg, 60)}"`;

  const commandArg = a.command ?? a.cmd;
  if (typeof commandArg === "string") return `$ ${truncate(commandArg, 60)}`;

  const urlArg = a.url;
  if (typeof urlArg === "string") return truncate(urlArg, 60);

  // Fallback: first string arg value
  for (const val of Object.values(a)) {
    if (typeof val === "string" && val.length > 0) return truncate(val, 60);
  }

  return "";
}

function shortenPath(p: string): string {
  // Keep last 3 segments: "lib/db/queries.ts" from "/Users/foo/project/lib/db/queries.ts"
  const parts = p.split("/").filter(Boolean);
  return parts.length > 3 ? parts.slice(-3).join("/") : p;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export async function updateMessage(
  messageId: string,
  data: Partial<Pick<NewMessage, "content" | "metadata" | "model" | "tokenCount">>
) {
  const existing = await db.query.messages.findFirst({
    where: eq(messages.id, messageId),
  });
  const [updated] = await db
    .update(messages)
    .set(data)
    .where(eq(messages.id, messageId))
    .returning();

  if (updated) {
    const previousTokenCount = existing?.tokenCount ?? 0;
    const nextTokenCount = updated.tokenCount ?? 0;
    const delta = nextTokenCount - previousTokenCount;
    const visibilityChanged = existing
      ? countsTowardVisibleConversation(existing) !== countsTowardVisibleConversation({
          ...existing,
          ...data,
        })
      : false;
    await db
      .update(sessions)
      .set({
        updatedAt: new Date().toISOString(),
        totalTokenCount: sql`${sessions.totalTokenCount} + ${delta}`,
        ...(visibilityChanged ? { messageCount: visibleConversationCountSql(updated.sessionId) } : {}),
      })
      .where(eq(sessions.id, updated.sessionId));
  }

  return updated;
}

/**
 * Get all tool results for a session, indexed by toolCallId.
 * This fetches results from both:
 * 1. role="tool" messages (separate tool result messages)
 * 2. role="assistant" messages with inline tool-result parts
 *
 * Used by the hybrid message approach to enhance frontend messages with DB tool results.
 */
export async function getToolResultsForSession(sessionId: string): Promise<Map<string, unknown>> {
  const toolResults = new Map<string, unknown>();

  // Fetch all messages that might contain tool results
  const allMessages = await db.query.messages.findMany({
    where: and(
      eq(messages.sessionId, sessionId),
      or(
        eq(messages.role, "tool"),
        eq(messages.role, "assistant")
      )
    ),
    orderBy: asc(messages.createdAt),
  });

  for (const msg of allMessages) {
    const content = msg.content as Array<{ type: string; toolCallId?: string; result?: unknown }> | null;
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      // Handle tool-result parts (from both tool and assistant messages)
      if (part.type === "tool-result" && part.toolCallId) {
        toolResults.set(part.toolCallId, part.result);
      }
    }

    // Also check message-level toolCallId (alternative storage pattern)
    if (msg.role === "tool" && msg.toolCallId && content.length > 0) {
      const firstPart = content[0] as { result?: unknown };
      if (firstPart.result !== undefined) {
        toolResults.set(msg.toolCallId, firstPart.result);
      }
    }
  }

  return toolResults;
}

export async function getNonCompactedMessages(sessionId: string) {
  return db.query.messages.findMany({
    where: and(
      eq(messages.sessionId, sessionId),
      eq(messages.isCompacted, false)
    ),
    orderBy: [
      // Push NULL orderingIndex values to the end for backward compatibility
      asc(sql`case when ${messages.orderingIndex} is null then 1 else 0 end`),
      asc(messages.orderingIndex),
      // Fallback to creation time for legacy/NULL rows
      asc(messages.createdAt),
    ],
  });
}

async function markMessagesAsCompacted(
  sessionId: string,
  beforeMessageId: string
) {
  const sessionMessages = await getNonCompactedMessages(sessionId);
  const targetIndex = sessionMessages.findIndex((message) => message.id === beforeMessageId);
  if (targetIndex < 0) return;

  // Keep backward compatibility: compact up to and including the boundary message.
  const idsToCompact = sessionMessages.slice(0, targetIndex + 1).map((message) => message.id);
  await markMessagesAsCompactedByIds(sessionId, idsToCompact);
}

/**
 * Mark specific messages as compacted by their IDs.
 * Used by auto-prune strategies to compact individual messages.
 *
 * @returns The number of messages actually marked as compacted.
 */
export async function markMessagesAsCompactedByIds(
  sessionId: string,
  messageIds: string[]
): Promise<number> {
  if (messageIds.length === 0) return 0;

  const result = await db
    .update(messages)
    .set({ isCompacted: true })
    .where(
      and(
        eq(messages.sessionId, sessionId),
        inArray(messages.id, messageIds)
      )
    );

  // Drizzle returns { changes } for SQLite updates
  return (result as unknown as { changes?: number })?.changes ?? messageIds.length;
}

/**
 * Delete all user/assistant messages in a session whose IDs are NOT in the
 * given keep-set. System and tool messages are always preserved (the frontend
 * never tracks those).
 *
 * Used when the frontend performs an edit/reload that truncates the conversation:
 * assistant-ui sends a shortened message list, so any DB messages beyond that
 * list must be cleaned up to prevent duplicates on next load.
 *
 * @returns The number of deleted messages.
 */
export async function deleteMessagesNotIn(
  sessionId: string,
  keepIds: Set<string>
): Promise<number> {
  if (keepIds.size === 0) return 0;

  const allMessages = await db.query.messages.findMany({
    where: eq(messages.sessionId, sessionId),
    columns: { id: true, role: true, orderingIndex: true, createdAt: true },
    orderBy: [
      asc(sql`case when ${messages.orderingIndex} is null then 1 else 0 end`),
      asc(messages.orderingIndex),
      asc(messages.createdAt),
    ],
  });

  const deleteByIds = async (idsToDelete: string[]): Promise<number> => {
    if (idsToDelete.length === 0) return 0;

    const BATCH_SIZE = 100;
    let totalDeleted = 0;
    for (let i = 0; i < idsToDelete.length; i += BATCH_SIZE) {
      const batch = idsToDelete.slice(i, i + BATCH_SIZE);
      const result = await db
        .delete(messages)
        .where(
          and(
            eq(messages.sessionId, sessionId),
            inArray(messages.id, batch)
          )
        );
      totalDeleted += (result as unknown as { changes?: number })?.changes ?? batch.length;
    }

    if (totalDeleted > 0) {
      await db
        .update(sessions)
        .set({
          updatedAt: new Date().toISOString(),
          messageCount: visibleConversationCountSql(sessionId),
        })
        .where(eq(sessions.id, sessionId));
    }

    return totalDeleted;
  };

  // Only trim a stale suffix by default (edit/reload semantics).
  // This avoids deleting older history when the frontend sends a partial list.
  let maxKeptPosition = -1;
  for (let i = 0; i < allMessages.length; i += 1) {
    if (keepIds.has(allMessages[i].id)) {
      maxKeptPosition = i;
    }
  }

  if (maxKeptPosition < 0) {
    // First-message edit path: assistant-ui sends only the edited user message
    // with a brand-new ID, so none of the DB rows match keepIds. In this case
    // we should clear prior conversational history so the new branch replaces it.
    if (keepIds.size === 1) {
      const allConversationalIds = allMessages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => m.id);
      return deleteByIds(allConversationalIds);
    }
    return 0;
  }

  const idsToDelete = allMessages
    .filter((m, idx) =>
      idx > maxKeptPosition &&
      !keepIds.has(m.id) &&
      (m.role === "user" || m.role === "assistant")
    )
    .map(m => m.id);

  return deleteByIds(idsToDelete);
}

// Returns IDs of all messages in a session that were injected via the live-prompt
// queue (i.e. persisted server-side during prepareStep, unknown to the frontend).
export async function getInjectedMessageIds(sessionId: string): Promise<string[]> {
  const rows = await db.query.messages.findMany({
    where: and(
      eq(messages.sessionId, sessionId),
      sql`json_extract(${messages.metadata}, '$.livePromptInjected') IS NOT NULL`
    ),
    columns: { id: true },
  });
  return rows.map(r => r.id);
}

// Tool Runs
export async function createToolRun(data: NewToolRun) {
  const [toolRun] = await db.insert(toolRuns).values(data).returning();
  return toolRun;
}

export async function updateToolRun(
  id: string,
  data: Partial<Omit<NewToolRun, "id" | "sessionId">>
) {
  const [toolRun] = await db
    .update(toolRuns)
    .set(data)
    .where(eq(toolRuns.id, id))
    .returning();
  return toolRun;
}

async function getToolRun(id: string) {
  return db.query.toolRuns.findFirst({
    where: eq(toolRuns.id, id),
  });
}
