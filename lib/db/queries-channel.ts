import { db } from "./sqlite-client";
import {
  channelConnections,
  channelConversations,
  channelMessages,
  channelOutbox,
} from "./sqlite-schema";
import type {
  ChannelConnection,
  NewChannelConnection,
  ChannelConversation,
  NewChannelConversation,
  ChannelMessage,
  NewChannelMessage,
  ChannelOutboxEntry,
  NewChannelOutboxEntry,
} from "./sqlite-schema";
import { eq, desc, asc, and, or, isNull, lte, lt, inArray, sql } from "drizzle-orm";

// ============================================================================
// CHANNEL CONNECTIONS
// ============================================================================

export async function createChannelConnection(data: NewChannelConnection): Promise<ChannelConnection> {
  const [connection] = await db.insert(channelConnections).values(data).returning();
  return connection;
}

export async function updateChannelConnection(
  id: string,
  data: Partial<NewChannelConnection>
): Promise<ChannelConnection | undefined> {
  const [connection] = await db
    .update(channelConnections)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(channelConnections.id, id))
    .returning();
  return connection;
}

export async function getChannelConnection(id: string): Promise<ChannelConnection | undefined> {
  return db.query.channelConnections.findFirst({
    where: eq(channelConnections.id, id),
  });
}

export async function listChannelConnections(params: {
  userId: string;
  characterId?: string;
}): Promise<ChannelConnection[]> {
  const conditions = params.characterId
    ? and(eq(channelConnections.userId, params.userId), eq(channelConnections.characterId, params.characterId))
    : eq(channelConnections.userId, params.userId);

  return db.query.channelConnections.findMany({
    where: conditions,
    orderBy: desc(channelConnections.updatedAt),
  });
}

export async function deleteChannelConnection(id: string): Promise<void> {
  await db.delete(channelConnections).where(eq(channelConnections.id, id));
}

/**
 * Find an active (connected) channel connection for a user by channel type.
 * Used by scheduleTask to resolve delivery channel when user explicitly
 * requests a specific channel (e.g., "telegram") but the schedule isn't
 * being created from that channel's session.
 */
export async function findActiveChannelConnection(
  userId: string,
  channelType: string
): Promise<ChannelConnection | undefined> {
  return db.query.channelConnections.findFirst({
    where: and(
      eq(channelConnections.userId, userId),
      eq(channelConnections.channelType, channelType as any),
      eq(channelConnections.status, "connected")
    ),
    orderBy: desc(channelConnections.updatedAt),
  });
}

// ============================================================================
// CHANNEL CONVERSATIONS
// ============================================================================

function buildThreadCondition(threadId?: string | null) {
  return threadId ? eq(channelConversations.threadId, threadId) : isNull(channelConversations.threadId);
}

export async function findChannelConversation(params: {
  connectionId: string;
  peerId: string;
  threadId?: string | null;
}): Promise<ChannelConversation | undefined> {
  return db.query.channelConversations.findFirst({
    where: and(
      eq(channelConversations.connectionId, params.connectionId),
      eq(channelConversations.peerId, params.peerId),
      buildThreadCondition(params.threadId ?? null)
    ),
  });
}

export async function getChannelConversation(id: string): Promise<ChannelConversation | undefined> {
  return db.query.channelConversations.findFirst({
    where: eq(channelConversations.id, id),
  });
}

export async function findChannelConversationBySessionId(
  sessionId: string,
): Promise<ChannelConversation | undefined> {
  return db.query.channelConversations.findFirst({
    where: eq(channelConversations.sessionId, sessionId),
  });
}

async function listChannelConversationsByCharacter(
  characterId: string
): Promise<ChannelConversation[]> {
  return db.query.channelConversations.findMany({
    where: eq(channelConversations.characterId, characterId),
    orderBy: desc(channelConversations.updatedAt),
  });
}

export async function createChannelConversation(
  data: NewChannelConversation
): Promise<ChannelConversation> {
  const [conversation] = await db.insert(channelConversations).values(data).returning();
  return conversation;
}

export async function updateChannelConversation(
  id: string,
  data: Partial<NewChannelConversation>
): Promise<ChannelConversation | undefined> {
  const [conversation] = await db
    .update(channelConversations)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(channelConversations.id, id))
    .returning();
  return conversation;
}

export async function touchChannelConversation(
  id: string,
  lastMessageAt?: string
): Promise<ChannelConversation | undefined> {
  const [conversation] = await db
    .update(channelConversations)
    .set({
      lastMessageAt: lastMessageAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(channelConversations.id, id))
    .returning();
  return conversation;
}

/**
 * Find the most recent channel conversation for a given connection.
 * Used by scheduleTask to resolve peerId/threadId when the user
 * explicitly requests delivery to a specific channel type.
 */
export async function findRecentChannelConversation(
  connectionId: string
): Promise<ChannelConversation | undefined> {
  return db.query.channelConversations.findFirst({
    where: eq(channelConversations.connectionId, connectionId),
    orderBy: desc(channelConversations.updatedAt),
  });
}

// ============================================================================
// CHANNEL MESSAGE MAP
// ============================================================================

export async function createChannelMessage(data: NewChannelMessage): Promise<ChannelMessage> {
  const [entry] = await db.insert(channelMessages).values(data).returning();
  return entry;
}

/**
 * Find an outbound channel message record for an internal message ID.
 * Used by the outbox worker to detect that a delivery already succeeded
 * (e.g. a timed-out send that actually landed) and avoid duplicate sends.
 */
export async function findOutboundChannelMessageByMessageId(
  messageId: string
): Promise<ChannelMessage | undefined> {
  return db.query.channelMessages.findFirst({
    where: and(
      eq(channelMessages.messageId, messageId),
      eq(channelMessages.direction, "outbound")
    ),
  });
}

export async function findChannelMessageByExternalId(params: {
  connectionId: string;
  channelType: ChannelMessage["channelType"];
  externalMessageId: string;
  direction: ChannelMessage["direction"];
}): Promise<ChannelMessage | undefined> {
  return db.query.channelMessages.findFirst({
    where: and(
      eq(channelMessages.connectionId, params.connectionId),
      eq(channelMessages.channelType, params.channelType),
      eq(channelMessages.externalMessageId, params.externalMessageId),
      eq(channelMessages.direction, params.direction)
    ),
  });
}

// ============================================================================
// CHANNEL OUTBOX (durable delivery queue)
// ============================================================================

/**
 * Idempotent enqueue: `message_id` is unique, so a concurrent/duplicate
 * enqueue for the same final message returns the existing entry instead of
 * creating a second delivery.
 */
export async function createChannelOutboxEntry(
  data: NewChannelOutboxEntry
): Promise<ChannelOutboxEntry> {
  const [entry] = await db
    .insert(channelOutbox)
    .values(data)
    .onConflictDoNothing({ target: channelOutbox.messageId })
    .returning();
  if (entry) return entry;
  const existing = await db.query.channelOutbox.findFirst({
    where: eq(channelOutbox.messageId, data.messageId),
  });
  if (!existing) {
    throw new Error(`Failed to enqueue outbox entry for message ${data.messageId}`);
  }
  return existing;
}

/**
 * Atomically claim a pending outbox entry for delivery. Returns the updated
 * entry if this caller won the claim, or undefined if the entry was already
 * claimed/delivered by a concurrent worker (the caller must then skip it).
 */
export async function claimChannelOutboxEntry(
  id: string
): Promise<ChannelOutboxEntry | undefined> {
  const [entry] = await db
    .update(channelOutbox)
    .set({
      status: "delivering",
      // Increment in SQL so a stale in-memory row can never reset the count.
      attempts: sql`${channelOutbox.attempts} + 1`,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(channelOutbox.id, id), eq(channelOutbox.status, "pending")))
    .returning();
  return entry;
}

/**
 * Guarded terminal/retry transition: only applies if the entry is still in
 * 'delivering' state at the expected attempt count, so a stale racer can
 * never overwrite a newer delivered/failed/pending state. Returns the updated
 * entry, or undefined if the guard did not match.
 */
export async function finalizeChannelOutboxEntry(
  id: string,
  expectedAttempts: number,
  data: Partial<NewChannelOutboxEntry>
): Promise<ChannelOutboxEntry | undefined> {
  const [entry] = await db
    .update(channelOutbox)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(channelOutbox.id, id),
        eq(channelOutbox.status, "delivering"),
        eq(channelOutbox.attempts, expectedAttempts)
      )
    )
    .returning();
  return entry;
}

export async function updateChannelOutboxEntry(
  id: string,
  data: Partial<NewChannelOutboxEntry>
): Promise<ChannelOutboxEntry | undefined> {
  const [entry] = await db
    .update(channelOutbox)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(channelOutbox.id, id))
    .returning();
  return entry;
}

/**
 * List outbox entries that are due for a delivery attempt: pending entries
 * whose next_attempt_at is unset or in the past.
 */
export async function listDueChannelOutboxEntries(limit = 20): Promise<ChannelOutboxEntry[]> {
  const now = new Date().toISOString();
  return db.query.channelOutbox.findMany({
    where: and(
      eq(channelOutbox.status, "pending"),
      or(isNull(channelOutbox.nextAttemptAt), lte(channelOutbox.nextAttemptAt, now))
    ),
    orderBy: asc(channelOutbox.createdAt),
    limit,
  });
}

/**
 * Reset entries stuck in 'delivering' (e.g. process crashed mid-send) back to
 * 'pending' so the worker can retry them. Only touches entries older than the
 * provided threshold to avoid clobbering an in-flight attempt.
 */
export async function resetStaleChannelOutboxEntries(staleBeforeIso: string): Promise<number> {
  const stale = await db.query.channelOutbox.findMany({
    where: and(
      eq(channelOutbox.status, "delivering"),
      lt(channelOutbox.updatedAt, staleBeforeIso)
    ),
    columns: { id: true },
  });
  if (stale.length === 0) return 0;
  await db
    .update(channelOutbox)
    .set({ status: "pending", updatedAt: new Date().toISOString() })
    .where(inArray(channelOutbox.id, stale.map((s) => s.id)));
  return stale.length;
}
