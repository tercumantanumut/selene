/**
 * Observability Queries - Database operations for agent runs, events, and prompt versioning
 */

import { db } from "@/lib/db/sqlite-client";
import {
  agentRuns,
  agentRunEvents,
  promptTemplates,
  promptVersions,
  type NewAgentRun,
  type AgentRun,
  type AgentRunEvent,
  type PromptTemplate,
  type PromptVersion,
} from "@/lib/db/sqlite-schema";
import type { AgentRunEventType, AgentRunStatus, EventLevel } from "@/lib/db/sqlite-schema";
import { eq, desc, and, lte, gte, or, count, asc, like } from "drizzle-orm";
import { durationMs as calculateDurationMs, isStale, nowISO, parseTimestampMs } from "@/lib/utils/timestamp";
import { createHash } from "crypto";

// ============================================================================
// Agent Runs
// ============================================================================

interface CreateAgentRunOptions {
  sessionId: string;
  pipelineName: string;
  userId?: string;
  characterId?: string;
  triggerType?: NewAgentRun["triggerType"];
  traceId?: string;
  spanId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Create a new agent run record
 */
export async function createAgentRun(options: CreateAgentRunOptions): Promise<AgentRun> {
  const [run] = await db
    .insert(agentRuns)
    .values({
      sessionId: options.sessionId,
      pipelineName: options.pipelineName,
      userId: options.userId,
      characterId: options.characterId,
      triggerType: options.triggerType ?? "api",
      traceId: options.traceId,
      spanId: options.spanId,
      status: "running",
      startedAt: nowISO(),
      updatedAt: nowISO(),
      metadata: options.metadata ?? {},
    })
    .returning();

  return run;
}

/**
 * Complete an agent run with success or failure status
 */
export async function completeAgentRun(
  runId: string,
  status: AgentRunStatus,
  metadata?: Record<string, unknown>
): Promise<AgentRun | undefined> {
  const completedAt = nowISO();

  // Calculate duration from startedAt
  const run = await db.query.agentRuns.findFirst({
    where: eq(agentRuns.id, runId),
  });

  if (!run) return undefined;

  const runDurationMs = calculateDurationMs(run.startedAt, completedAt);

  const [updated] = await db
    .update(agentRuns)
    .set({
      status,
      completedAt,
      durationMs: runDurationMs,
      updatedAt: completedAt,
      metadata: metadata ? { ...((run.metadata as object) || {}), ...metadata } : run.metadata,
    })
    .where(eq(agentRuns.id, runId))
    .returning();

  return updated;
}

/**
 * Merge metadata into an existing run while it is still active.
 */
export async function updateAgentRunMetadata(
  runId: string,
  metadata: Record<string, unknown>
): Promise<AgentRun | undefined> {
  const run = await db.query.agentRuns.findFirst({
    where: eq(agentRuns.id, runId),
  });

  if (!run) {
    return undefined;
  }

  const updatedAt = nowISO();
  const [updated] = await db
    .update(agentRuns)
    .set({
      metadata: { ...((run.metadata as object) || {}), ...metadata },
      updatedAt,
    })
    .where(eq(agentRuns.id, runId))
    .returning();

  return updated;
}

/**
 * Refresh durable liveness without writing a full event row.
 * Long-running providers may be silent for extended periods while still healthy.
 */
export async function touchAgentRun(
  runId: string,
  metadata?: Record<string, unknown>
): Promise<AgentRun | undefined> {
  const run = await db.query.agentRuns.findFirst({
    where: eq(agentRuns.id, runId),
  });

  if (!run) {
    return undefined;
  }

  const updatedAt = nowISO();
  const existingMetadata = (run.metadata && typeof run.metadata === "object")
    ? run.metadata as Record<string, unknown>
    : {};

  const [updated] = await db
    .update(agentRuns)
    .set({
      updatedAt,
      ...(metadata ? { metadata: { ...existingMetadata, ...metadata } } : {}),
    })
    .where(eq(agentRuns.id, runId))
    .returning();

  return updated;
}

/**
 * Get an agent run by ID
 */
export async function getAgentRun(runId: string): Promise<AgentRun | undefined> {
  return db.query.agentRuns.findFirst({
    where: eq(agentRuns.id, runId),
  });
}

/**
 * List agent runs for a session
 */
export async function listAgentRunsBySession(
  sessionId: string,
  limit = 50
): Promise<AgentRun[]> {
  return db.query.agentRuns.findMany({
    where: eq(agentRuns.sessionId, sessionId),
    orderBy: desc(agentRuns.startedAt),
    limit,
  });
}

/**
 * Find running agent runs for a character across all sessions
 */
export async function listRunningRunsByCharacter(
  characterId: string
): Promise<AgentRun[]> {
  return db.query.agentRuns.findMany({
    where: and(
      eq(agentRuns.characterId, characterId),
      eq(agentRuns.status, "running")
    ),
    orderBy: desc(agentRuns.startedAt),
    limit: 10,
  });
}

// ============================================================================
// Agent Run Events
// ============================================================================

interface AppendRunEventOptions {
  runId: string;
  eventType: AgentRunEventType;
  level?: EventLevel;
  durationMs?: number;
  messageId?: string;
  toolRunId?: string;
  promptVersionId?: string;
  pipelineName?: string;
  stepName?: string;
  toolName?: string;
  llmOperation?: string;
  data?: Record<string, unknown>;
}

/**
 * Append an event to an agent run's timeline
 */
export async function appendRunEvent(options: AppendRunEventOptions): Promise<AgentRunEvent> {
  const updatedAt = nowISO();
  const [event] = await db
    .insert(agentRunEvents)
    .values({
      runId: options.runId,
      timestamp: updatedAt,
      eventType: options.eventType,
      level: options.level ?? "info",
      durationMs: options.durationMs,
      messageId: options.messageId,
      toolRunId: options.toolRunId,
      promptVersionId: options.promptVersionId,
      pipelineName: options.pipelineName,
      stepName: options.stepName,
      toolName: options.toolName,
      llmOperation: options.llmOperation,
      data: options.data ?? {},
    })
    .returning();

  await db
    .update(agentRuns)
    .set({ updatedAt })
    .where(eq(agentRuns.id, options.runId));

  return event;
}

/**
 * Get all events for a run
 */
async function getRunEvents(runId: string): Promise<AgentRunEvent[]> {
  return db.query.agentRunEvents.findMany({
    where: eq(agentRunEvents.runId, runId),
    orderBy: agentRunEvents.timestamp,
  });
}

// ============================================================================
// Prompt Templates & Versions
// ============================================================================

/**
 * Hash prompt content for deduplication
 */
function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Get or create a prompt template by key
 */
async function getOrCreatePromptTemplate(
  key: string,
  description?: string
): Promise<PromptTemplate> {
  const existing = await db.query.promptTemplates.findFirst({
    where: eq(promptTemplates.key, key),
  });

  if (existing) return existing;

  const [template] = await db
    .insert(promptTemplates)
    .values({
      key,
      description,
      owner: "system",
    })
    .returning();

  return template;
}

/**
 * Get or create a prompt version
 *
 * If the latest version has the same content hash, returns that version.
 * Otherwise creates a new version with incremented version number.
 */
async function getOrCreatePromptVersion(options: {
  templateKey: string;
  content: string;
  createdByUserId?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ promptVersion: PromptVersion; isNew: boolean }> {
  const contentHash = hashContent(options.content);

  // Get or create the template
  const template = await getOrCreatePromptTemplate(options.templateKey);

  // Check if latest version has same hash
  const latestVersion = await db.query.promptVersions.findFirst({
    where: eq(promptVersions.templateId, template.id),
    orderBy: desc(promptVersions.version),
  });

  if (latestVersion && latestVersion.contentHash === contentHash) {
    return { promptVersion: latestVersion, isNew: false };
  }

  // Create new version
  const nextVersion = (latestVersion?.version ?? 0) + 1;

  const [newVersion] = await db
    .insert(promptVersions)
    .values({
      templateId: template.id,
      version: nextVersion,
      content: options.content,
      contentHash,
      createdByUserId: options.createdByUserId,
      metadata: options.metadata ?? {},
    })
    .returning();

  return { promptVersion: newVersion, isNew: true };
}

/**
 * Get a prompt version by ID
 */
async function getPromptVersion(versionId: string): Promise<PromptVersion | undefined> {
  return db.query.promptVersions.findFirst({
    where: eq(promptVersions.id, versionId),
  });
}

/**
 * Get the latest version for a template key
 */
async function getLatestPromptVersion(templateKey: string): Promise<PromptVersion | undefined> {
  const template = await db.query.promptTemplates.findFirst({
    where: eq(promptTemplates.key, templateKey),
  });

  if (!template) return undefined;

  return db.query.promptVersions.findFirst({
    where: eq(promptVersions.templateId, template.id),
    orderBy: desc(promptVersions.version),
  });
}

/**
 * List all versions for a template
 */
export async function listPromptVersions(templateKey: string): Promise<PromptVersion[]> {
  const template = await db.query.promptTemplates.findFirst({
    where: eq(promptTemplates.key, templateKey),
  });

  if (!template) return [];

  return db.query.promptVersions.findMany({
    where: eq(promptVersions.templateId, template.id),
    orderBy: desc(promptVersions.version),
  });
}

/**
 * List all prompt templates
 */
export async function listPromptTemplates(): Promise<PromptTemplate[]> {
  return db.query.promptTemplates.findMany({
    orderBy: promptTemplates.key,
  });
}

// ============================================================================
// Stale Run Management
// ============================================================================

/**
 * Find stale runs - runs in "running" status for longer than threshold
 * Default threshold: 30 minutes
 */
export async function findStaleRuns(thresholdMinutes: number = 30): Promise<AgentRun[]> {
  const runs = await db.query.agentRuns.findMany({
    where: eq(agentRuns.status, "running"),
    orderBy: agentRuns.updatedAt,
  });

  const thresholdMs = thresholdMinutes * 60 * 1000;
  return runs
    .filter((run) => isStale(run.updatedAt ?? run.startedAt, thresholdMs))
    .sort((a, b) => parseTimestampMs(a.updatedAt ?? a.startedAt) - parseTimestampMs(b.updatedAt ?? b.startedAt));
}

/**
 * Find zombie runs - runs in "running" status with no updates for longer than threshold
 * Default threshold: 5 minutes
 */
export async function findZombieRuns(thresholdMinutes: number = 5): Promise<AgentRun[]> {
  const runs = await db.query.agentRuns.findMany({
    where: eq(agentRuns.status, "running"),
    orderBy: agentRuns.updatedAt,
  });

  const thresholdMs = thresholdMinutes * 60 * 1000;
  return runs
    .filter((run) => isStale(run.updatedAt ?? run.startedAt, thresholdMs))
    .sort((a, b) => parseTimestampMs(a.updatedAt ?? a.startedAt) - parseTimestampMs(b.updatedAt ?? b.startedAt));
}

/**
 * Mark a run as failed due to timeout/abandonment
 */
export async function markRunAsTimedOut(
  runId: string,
  reason: string = "timeout"
): Promise<AgentRun | undefined> {
  const run = await getAgentRun(runId);
  if (!run) return undefined;

  const completedAt = nowISO();
  const [updated] = await db
    .update(agentRuns)
    .set({
      status: "failed",
      completedAt,
      durationMs: calculateDurationMs(run.startedAt, completedAt),
      updatedAt: completedAt,
      metadata: {
        ...((run.metadata as object) || {}),
        cleanupReason: reason,
        cleanedUpAt: completedAt,
      },
    })
    .where(eq(agentRuns.id, runId))
    .returning();

  return updated;
}

/**
 * Mark a run as cancelled
 */
export async function markRunAsCancelled(
  runId: string,
  reason: string = "cancelled",
  metadata?: Record<string, unknown>
): Promise<AgentRun | undefined> {
  const run = await getAgentRun(runId);
  if (!run) return undefined;

  const completedAt = nowISO();
  const [updated] = await db
    .update(agentRuns)
    .set({
      status: "cancelled",
      completedAt,
      durationMs: calculateDurationMs(run.startedAt, completedAt),
      updatedAt: completedAt,
      metadata: {
        ...((run.metadata as object) || {}),
        cancelReason: reason,
        cancelledAt: completedAt,
        ...(metadata ?? {}),
      },
    })
    .where(eq(agentRuns.id, runId))
    .returning();

  return updated;
}

// ============================================================================
// Admin/List Queries
// ============================================================================

export interface ListAgentRunsOptions {
  page?: number;
  limit?: number;
  sessionId?: string;
  userId?: string;
  pipelineName?: string;
  status?: AgentRunStatus;
  startDate?: string;
  endDate?: string;
}

/**
 * List all runs with filters and pagination
 */
export async function listAgentRuns(options: ListAgentRunsOptions = {}): Promise<{
  runs: AgentRun[];
  total: number;
  page: number;
  limit: number;
}> {
  const { page = 1, limit = 50, sessionId, userId, pipelineName, status, startDate, endDate } = options;

  // Build where conditions
  const conditions = [];
  if (sessionId) conditions.push(like(agentRuns.sessionId, `%${sessionId}%`));
  if (userId) conditions.push(like(agentRuns.userId, `%${userId}%`));
  if (pipelineName) conditions.push(eq(agentRuns.pipelineName, pipelineName));
  if (status) conditions.push(eq(agentRuns.status, status));
  if (startDate) conditions.push(gte(agentRuns.startedAt, startDate));
  if (endDate) conditions.push(lte(agentRuns.startedAt, endDate));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Get total count
  const [countResult] = await db
    .select({ count: count() })
    .from(agentRuns)
    .where(whereClause);
  const total = countResult?.count || 0;

  // Get paginated runs
  const runs = await db.query.agentRuns.findMany({
    where: whereClause,
    orderBy: desc(agentRuns.startedAt),
    limit,
    offset: (page - 1) * limit,
  });

  return { runs, total, page, limit };
}

/**
 * Get run with full details including events
 */
export async function getAgentRunWithEvents(runId: string): Promise<{
  run: AgentRun;
  events: AgentRunEvent[];
} | undefined> {
  const run = await db.query.agentRuns.findFirst({
    where: eq(agentRuns.id, runId),
  });

  if (!run) return undefined;

  const events = await db.query.agentRunEvents.findMany({
    where: eq(agentRunEvents.runId, runId),
    orderBy: asc(agentRunEvents.timestamp),
  });

  return { run, events };
}

// ============================================================================
// Prompt Analytics
// ============================================================================

export interface PromptVersionMetrics {
  versionId: string;
  version: number;
  templateKey: string;
  runCount: number;
  successCount: number;
  failedCount: number;
  successRate: number;
  avgDurationMs: number;
  firstUsedAt: string;
  lastUsedAt: string;
}

/**
 * Get aggregated metrics for prompt versions
 */
export async function getPromptVersionMetrics(
  templateKey: string
): Promise<PromptVersionMetrics[]> {
  // Get all versions for template
  const versions = await listPromptVersions(templateKey);

  // For each version, aggregate run stats from events that link to it
  const metrics: PromptVersionMetrics[] = [];

  for (const version of versions) {
    // Find events referencing this version
    const events = await db.query.agentRunEvents.findMany({
      where: eq(agentRunEvents.promptVersionId, version.id),
    });

    // Get unique run IDs
    const runIds = [...new Set(events.map((e) => e.runId))];

    let successCount = 0;
    let failedCount = 0;
    let totalDuration = 0;
    let firstUsedAt = version.createdAt;
    let lastUsedAt = version.createdAt;

    for (const runId of runIds) {
      const run = await getAgentRun(runId);
      if (run) {
        if (run.status === "succeeded") successCount++;
        if (run.status === "failed") failedCount++;
        if (run.durationMs) totalDuration += run.durationMs;
        if (run.startedAt < firstUsedAt) firstUsedAt = run.startedAt;
        if (run.startedAt > lastUsedAt) lastUsedAt = run.startedAt;
      }
    }

    metrics.push({
      versionId: version.id,
      version: version.version,
      templateKey,
      runCount: runIds.length,
      successCount,
      failedCount,
      successRate: runIds.length > 0 ? successCount / runIds.length : 0,
      avgDurationMs: runIds.length > 0 ? totalDuration / runIds.length : 0,
      firstUsedAt,
      lastUsedAt,
    });
  }

  return metrics;
}

/**
 * Get runs that used a specific prompt version
 */
async function getRunsByPromptVersion(
  versionId: string,
  limit: number = 50
): Promise<AgentRun[]> {
  const events = await db.query.agentRunEvents.findMany({
    where: eq(agentRunEvents.promptVersionId, versionId),
    columns: { runId: true },
  });

  const runIds = [...new Set(events.map((e) => e.runId))];

  if (runIds.length === 0) return [];

  const runs = await db.query.agentRuns.findMany({
    where: or(...runIds.map((id) => eq(agentRuns.id, id))),
    orderBy: desc(agentRuns.startedAt),
    limit,
  });

  return runs;
}

/**
 * Get prompt version adoption over time (daily buckets)
 */
export async function getVersionAdoptionTimeline(
  templateKey: string,
  days: number = 30
): Promise<Array<{ date: string; versionId: string; version: number; count: number }>> {
  const versions = await listPromptVersions(templateKey);
  const results: Array<{ date: string; versionId: string; version: number; count: number }> = [];

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  startDate.setHours(0, 0, 0, 0);

  for (const version of versions) {
    // Get all events for this version within date range
    const events = await db.query.agentRunEvents.findMany({
      where: and(
        eq(agentRunEvents.promptVersionId, version.id),
        gte(agentRunEvents.timestamp, startDate.toISOString())
      ),
      orderBy: asc(agentRunEvents.timestamp),
    });

    // Group by date
    const dateCounts: Record<string, number> = {};
    for (const event of events) {
      const date = event.timestamp.split("T")[0];
      dateCounts[date] = (dateCounts[date] || 0) + 1;
    }

    // Add to results
    for (const [date, eventCount] of Object.entries(dateCounts)) {
      results.push({
        date,
        versionId: version.id,
        version: version.version,
        count: eventCount,
      });
    }
  }

  return results.sort((a, b) => a.date.localeCompare(b.date));
}
