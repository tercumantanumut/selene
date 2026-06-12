/**
 * Output stub telemetry
 *
 * Emits two structured log events so we can tune truncation thresholds from
 * real traffic without instrumenting a dashboard:
 *
 *   1. "tool_output_tier"      — every tool result that flows through the
 *                                stream guard. Records which tier it landed
 *                                in (passthrough / preview_plus_stub / stub_only).
 *   2. "tool_output_retrieval" — every readLog / retrieveFullContent call.
 *                                Records which slice mode was used and how
 *                                big the returned chunk was.
 *
 * The two events can be joined on `retrievalId` to answer:
 *   - what is the tier distribution across real tool outputs?
 *   - for stub_only results, how often does the model follow up with readLog?
 *   - which slice mode wins (head/tail/range/grep)?
 *
 * No content is logged — sizes and IDs only. Memory is bounded (500 entries,
 * LRU) so it is safe to run indefinitely even in long-lived servers.
 */

export type OutputTier =
  | "passthrough"
  | "preview_plus_stub"
  | "stub_only";

type SliceMode = "default" | "head" | "tail" | "range" | "grep";

interface TierRecord {
  sessionId?: string;
  toolCallId?: string;
  toolName: string;
  originalTokens: number;
  originalChars: number;
  originalLines: number;
  tier: OutputTier;
  retrievalId?: string;
  retrievalIdType?: "logId" | "contentId";
  stubbedAt: number;
}

interface TierIndexEntry {
  record: TierRecord;
  insertedAt: number;
}

const MAX_TIER_ENTRIES = 500;
const TIER_TTL_MS = 60 * 60 * 1_000; // 1 hour

/**
 * Insertion-ordered map; we evict the oldest entries when we cross the size
 * cap. Map iteration order is insertion order in JS, so the first key is
 * always the oldest.
 */
const tierIndex = new Map<string, TierIndexEntry>();

function evictIfNeeded(now: number) {
  // Drop expired entries.
  for (const [id, entry] of tierIndex) {
    if (now - entry.insertedAt > TIER_TTL_MS) {
      tierIndex.delete(id);
    } else {
      break; // insertion order == chronological; rest are younger
    }
  }
  // Drop oldest until under cap.
  while (tierIndex.size > MAX_TIER_ENTRIES) {
    const oldest = tierIndex.keys().next().value;
    if (!oldest) break;
    tierIndex.delete(oldest);
  }
}

interface RecordTierParams {
  sessionId?: string;
  toolCallId?: string;
  toolName: string;
  originalTokens: number;
  originalChars: number;
  originalLines: number;
  tier: OutputTier;
  retrievalId?: string;
  retrievalIdType?: "logId" | "contentId";
}

/**
 * Emit a tier event and, if a retrievalId is attached, index the record so
 * a later retrieval call can correlate against it.
 */
export function recordTier(params: RecordTierParams): void {
  const now = Date.now();

  const payload = {
    event: "tool_output_tier",
    sessionId: params.sessionId,
    toolCallId: params.toolCallId,
    toolName: params.toolName,
    originalTokens: params.originalTokens,
    originalChars: params.originalChars,
    originalLines: params.originalLines,
    tier: params.tier,
    retrievalId: params.retrievalId,
    retrievalIdType: params.retrievalIdType,
    timestamp: new Date(now).toISOString(),
  };

  console.info(`[OutputStubTelemetry] ${JSON.stringify(payload)}`);

  if (params.retrievalId) {
    tierIndex.set(params.retrievalId, {
      record: {
        ...params,
        stubbedAt: now,
      },
      insertedAt: now,
    });
    evictIfNeeded(now);
  }
}

interface RecordRetrievalParams {
  retrievalId: string;
  retrievalIdType: "logId" | "contentId";
  sliceMode: SliceMode;
  sliceParams?: Record<string, unknown>;
  returnedTokens: number;
  budgetHit: boolean;
}

/**
 * Emit a retrieval event. Joins against the prior tier record by retrievalId
 * to report how long after the stub the model reached for content.
 */
export function recordRetrieval(params: RecordRetrievalParams): void {
  const now = Date.now();
  const tier = tierIndex.get(params.retrievalId);

  const payload = {
    event: "tool_output_retrieval",
    retrievalId: params.retrievalId,
    retrievalIdType: params.retrievalIdType,
    sliceMode: params.sliceMode,
    sliceParams: params.sliceParams,
    returnedTokens: params.returnedTokens,
    budgetHit: params.budgetHit,
    sessionId: tier?.record.sessionId,
    sourceTier: tier?.record.tier,
    sourceToolName: tier?.record.toolName,
    millisSinceStub: tier ? now - tier.record.stubbedAt : undefined,
    timestamp: new Date(now).toISOString(),
  };

  console.info(`[OutputStubTelemetry] ${JSON.stringify(payload)}`);
}

// ----------------------------------------------------------------------------
// Test helpers — not part of the public API.
// ----------------------------------------------------------------------------

/** @internal — only for tests. */
export function _clearTelemetryIndex(): void {
  tierIndex.clear();
}

/** @internal — only for tests. */
export function _telemetryIndexSize(): number {
  return tierIndex.size;
}
