import { db } from "./sqlite-client";
import { sessions, agentRuns, messages } from "./sqlite-schema";
import type { NewSession, Session } from "./sqlite-schema";
import { eq, desc, asc, and, lt, sql, inArray, type SQL } from "drizzle-orm";

type SessionMetadataShape = {
  characterId?: string;
  channelType?: "whatsapp" | "telegram" | "slack" | "discord";
};

interface ListSessionsPaginatedParams {
  userId: string;
  characterId?: string;
  characterName?: string;
  cursor?: string;
  limit?: number;
  search?: string;
  searchInMessages?: boolean;
  channelType?: "app" | "whatsapp" | "telegram" | "slack" | "discord";
  dateRange?: "today" | "week" | "month" | "all";
  status?: "active" | "archived";
}

interface ListSessionsPaginatedResult {
  sessions: (Session & { hasActiveRun?: boolean })[];
  nextCursor: string | null;
  totalCount: number;
}

function extractSessionMetadataColumns(metadata: unknown) {
  const meta = (metadata ?? {}) as SessionMetadataShape;
  return {
    characterId: meta.characterId ?? null,
    channelType: meta.channelType ?? null,
  };
}

export async function createSession(data: NewSession) {
  const metaColumns = extractSessionMetadataColumns(data.metadata);
  const [session] = await db.insert(sessions).values({
    ...data,
    ...metaColumns,
  }).returning();
  return session;
}

export async function getSession(id: string) {
  return db.query.sessions.findFirst({
    where: eq(sessions.id, id),
  });
}

export async function getSessionWithMessages(id: string) {
  const session = await db.query.sessions.findFirst({
    where: eq(sessions.id, id),
  });

  if (!session) return null;

  const msgs = await db.query.messages.findMany({
    where: eq(messages.sessionId, id),
    orderBy: [
      // Keep message history stable even when multiple rows share createdAt.
      asc(sql`case when ${messages.orderingIndex} is null then 1 else 0 end`),
      asc(messages.orderingIndex),
      asc(messages.createdAt),
    ],
  });

  return { session, messages: msgs };
}

export async function listSessions(userId?: string, limit = 100) {
  const conditions = userId ? eq(sessions.userId, userId) : undefined;

  return db.query.sessions.findMany({
    where: conditions ? and(conditions, eq(sessions.status, "active")) : eq(sessions.status, "active"),
    orderBy: desc(sessions.updatedAt),
    limit,
  });
}

export async function getSessionByCharacterId(userId: string, characterId: string): Promise<Session | null> {
  const result = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        eq(sessions.status, "active"),
        eq(sessions.characterId, characterId)
      )
    )
    .orderBy(desc(sessions.updatedAt))
    .limit(1);

  return result[0] || null;
}

export async function getSessionByMetadataKey(
  userId: string,
  type: string,
  key: string
): Promise<Session | null> {
  const result = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        eq(sessions.status, "active"),
        sql`json_extract(${sessions.metadata}, '$.type') = ${type}`,
        sql`json_extract(${sessions.metadata}, '$.key') = ${key}`
      )
    )
    .orderBy(desc(sessions.updatedAt))
    .limit(1);

  return result[0] || null;
}

/**
 * List all sessions for a specific character
 */
export async function listSessionsByCharacterId(
  userId: string,
  characterId: string,
  limit = 100
): Promise<Session[]> {
  const result = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        eq(sessions.status, "active"),
        eq(sessions.characterId, characterId)
      )
    )
    .orderBy(desc(sessions.updatedAt))
    .limit(limit);

  return result;
}

/**
 * Get session count for a character
 */
async function getCharacterSessionCount(
  userId: string,
  characterId: string
): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        eq(sessions.status, "active"),
        eq(sessions.characterId, characterId)
      )
    );

  return result[0]?.count || 0;
}

export async function getOrCreateCharacterSession(
  userId: string,
  characterId: string,
  characterName: string
): Promise<{ session: Session; isNew: boolean }> {
  const existingSession = await getSessionByCharacterId(userId, characterId);

  if (existingSession) {
    return { session: existingSession, isNew: false };
  }

  const newSession = await createSession({
    title: `Chat with ${characterName}`,
    userId,
    metadata: { characterId, characterName },
  });

  return { session: newSession, isNew: true };
}

export async function listSessionsPaginated(
  params: ListSessionsPaginatedParams
): Promise<ListSessionsPaginatedResult> {
  const pageSize = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const statusFilter = params.status ?? "active";
  const baseConditions: SQL[] = [eq(sessions.userId, params.userId), eq(sessions.status, statusFilter)];

  if (params.characterId) {
    baseConditions.push(eq(sessions.characterId, params.characterId));
  }
  if (params.characterName) {
    const escapedCharacterName = params.characterName.replace(/[\\%_]/g, "\\$&");
    baseConditions.push(sql`json_extract(${sessions.metadata}, '$.characterName') LIKE ${`%${escapedCharacterName}%`} ESCAPE '\\'`);
  }
  if (params.search) {
    const escapedSearch = params.search.replace(/[\\%_]/g, "\\$&");
    const likePattern = `%${escapedSearch}%`;
    const titleSearch = sql`${sessions.title} LIKE ${likePattern} ESCAPE '\\'`;
    const messageSearch = sql`EXISTS (
      SELECT 1
      FROM ${messages}
      WHERE ${messages.sessionId} = ${sessions.id}
        AND (${messages.isCompacted} IS NULL OR ${messages.isCompacted} = 0)
        AND ${messages.role} IN ('user', 'assistant')
        AND CAST(${messages.content} AS TEXT) LIKE ${likePattern} ESCAPE '\\'
    )`;

    baseConditions.push(
      params.searchInMessages
        ? sql`(${titleSearch}) OR (${messageSearch})`
        : titleSearch
    );
  }
  if (params.channelType === "app") {
    baseConditions.push(
      sql`(${sessions.channelType} IS NULL OR json_extract(${sessions.metadata}, '$.channelType') = 'app')`
    );
  } else if (params.channelType === "discord") {
    baseConditions.push(
      sql`json_extract(${sessions.metadata}, '$.channelType') = 'discord'`
    );
  } else if (params.channelType) {
    baseConditions.push(eq(sessions.channelType, params.channelType as "whatsapp" | "telegram" | "slack"));
  }

  if (params.dateRange && params.dateRange !== "all") {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const threshold =
      params.dateRange === "today"
        ? new Date(now - dayMs).toISOString()
        : params.dateRange === "week"
          ? new Date(now - 7 * dayMs).toISOString()
          : new Date(now - 30 * dayMs).toISOString();
    baseConditions.push(sql`${sessions.updatedAt} >= ${threshold}`);
  }

  const pageConditions = [...baseConditions];
  if (params.cursor) {
    pageConditions.push(lt(sessions.updatedAt, params.cursor));
  }

  const rows = await db
    .select()
    .from(sessions)
    .where(and(...pageConditions))
    .orderBy(desc(sessions.updatedAt))
    .limit(pageSize + 1);

  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  const nextCursor = hasMore ? page[page.length - 1]?.updatedAt ?? null : null;

  // Check for active runs
  let sessionsWithStatus = page;
  if (page.length > 0) {
    const sessionIds = page.map((s) => s.id);
    const activeRuns = await db
      .select({ sessionId: agentRuns.sessionId })
      .from(agentRuns)
      .where(and(inArray(agentRuns.sessionId, sessionIds), eq(agentRuns.status, "running")));

    const activeSessionIds = new Set(activeRuns.map((r) => r.sessionId));
    sessionsWithStatus = page.map((s) => ({
      ...s,
      hasActiveRun: activeSessionIds.has(s.id),
    }));
  }

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(sessions)
    .where(and(...baseConditions));

  return {
    sessions: sessionsWithStatus,
    nextCursor,
    totalCount: countResult[0]?.count ?? page.length,
  };
}

export async function updateSession(id: string, data: Partial<NewSession>) {
  const metadataColumns = data.metadata !== undefined
    ? extractSessionMetadataColumns(data.metadata)
    : {};
  const [session] = await db
    .update(sessions)
    .set({ ...data, ...metadataColumns, updatedAt: new Date().toISOString() })
    .where(eq(sessions.id, id))
    .returning();
  return session;
}

export async function updateSessionSummary(
  id: string,
  summary: string,
  summaryUpToMessageId: string | null
) {
  return updateSession(id, { summary, summaryUpToMessageId });
}
