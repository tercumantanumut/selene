/**
 * Swift Engine selection telemetry.
 *
 * Sprint 7 W7.1.G — anonymous, in-process diagnostic counters that record
 * which retrieval engine fulfilled each `searchWithRouter` call. Surfaced in
 * the experimental Swift Engine settings panel so operators can verify the
 * opt-in is actually routing requests.
 *
 * # Design constraints
 *
 *   - Pure in-memory. No disk IO, no network egress, no IPC. Pure local
 *     diagnostics only.
 *   - Bounded ring buffer (RING_CAPACITY=200) so a long-running session can
 *     not grow this module's footprint without bound.
 *   - Zero PII. Events MUST NOT carry queries, file paths, document IDs, or
 *     any other content. The only string field accepted is `errorCode`, which
 *     callers MUST populate with an error name/code (e.g. "swift_unavailable",
 *     "rpc_timeout") and never with raw error messages that could leak paths
 *     or query text.
 *   - Single-threaded — Electron main process runs the search router on the
 *     JS event loop, so all `recordEngineSelection` calls are serialized by
 *     the loop. We still defensively guard the totals counters against
 *     malformed events so a typo upstream cannot poison the stats.
 *
 * Public API:
 *
 *   recordEngineSelection(evt)   — append + bump totals.
 *   getEngineSelectionStats()    — read totals + last event snapshot.
 *   getRecentEngineEvents(n?)    — read up to N most recent events.
 *   __resetEngineTelemetryForTests() — internal: drop all state.
 */

export type SwiftEngineSelection = "lance" | "swift";

export type EngineSelectionOutcome =
  | "primary"             // engine ran successfully end-to-end
  | "fallback-unavailable" // primary engine unavailable, fell back to LanceDB
  | "fallback-error";     // primary engine errored mid-call, fell back to LanceDB

export interface EngineSelectionEvent {
  /** Which engine *actually* served the call (after any fallback). */
  engine: SwiftEngineSelection;
  /** Whether this was the primary engine or a fallback. */
  outcome: EngineSelectionOutcome;
  /** Optional total wall-clock time for the search call, in ms. */
  durationMs?: number;
  /**
   * Optional short error code/name when `outcome !== "primary"`. PII-free —
   * callers MUST pass an error.name / structured code, never a raw message.
   */
  errorCode?: string;
}

interface InternalEvent extends EngineSelectionEvent {
  /** Monotonic timestamp from the wallclock for ordering. */
  recordedAt: number;
}

export interface EngineSelectionStats {
  totals: Record<SwiftEngineSelection, number>;
  /** Total events whose outcome started with "fallback-". */
  fallbacks: number;
  /** Total event count over the lifetime of this process. */
  totalEvents: number;
  /** Most recent event, if any. */
  lastEvent?: EngineSelectionEvent;
}

const RING_CAPACITY = 200;

interface TelemetryState {
  ring: InternalEvent[];
  /** Index of the next slot to write. Wraps modulo ring.length. */
  cursor: number;
  /** True once the ring has filled at least once. */
  filled: boolean;
  totals: Record<SwiftEngineSelection, number>;
  fallbacks: number;
  totalEvents: number;
  lastEvent: EngineSelectionEvent | undefined;
}

function makeInitialState(): TelemetryState {
  return {
    ring: new Array<InternalEvent>(RING_CAPACITY),
    cursor: 0,
    filled: false,
    totals: { lance: 0, swift: 0 },
    fallbacks: 0,
    totalEvents: 0,
    lastEvent: undefined,
  };
}

let state: TelemetryState = makeInitialState();

/**
 * Defensive engine validator. We never throw — a bad input is dropped silently
 * (still incrementing totalEvents so callers can spot the discrepancy) so a
 * typo in the search router can never crash a search call.
 */
function isValidEngine(value: unknown): value is SwiftEngineSelection {
  return value === "lance" || value === "swift";
}

function isValidOutcome(value: unknown): value is EngineSelectionOutcome {
  return (
    value === "primary" ||
    value === "fallback-unavailable" ||
    value === "fallback-error"
  );
}

/**
 * Record an engine-selection event.
 *
 * Never throws. Bad inputs are silently dropped so a misconfigured caller can
 * not crash the search hot path.
 */
export function recordEngineSelection(evt: EngineSelectionEvent): void {
  try {
    if (!evt || typeof evt !== "object") return;
    if (!isValidEngine(evt.engine)) return;
    if (!isValidOutcome(evt.outcome)) return;

    // Sanitize: defensively coerce numeric fields and clip strings.
    const sanitized: EngineSelectionEvent = {
      engine: evt.engine,
      outcome: evt.outcome,
    };
    if (typeof evt.durationMs === "number" && Number.isFinite(evt.durationMs)) {
      // Clip to non-negative; treat NaN/Infinity as undefined.
      sanitized.durationMs = Math.max(0, evt.durationMs);
    }
    if (typeof evt.errorCode === "string" && evt.errorCode.length > 0) {
      // Cap at 64 chars to keep the buffer bounded against accidental message
      // dumps. Strip control chars defensively.
      sanitized.errorCode = evt.errorCode
        .replace(/[\x00-\x1f\x7f]/g, "")
        .slice(0, 64);
    }

    const internal: InternalEvent = {
      ...sanitized,
      recordedAt: Date.now(),
    };

    state.ring[state.cursor] = internal;
    state.cursor = (state.cursor + 1) % RING_CAPACITY;
    if (state.cursor === 0) state.filled = true;

    state.totals[sanitized.engine] += 1;
    if (
      sanitized.outcome === "fallback-unavailable" ||
      sanitized.outcome === "fallback-error"
    ) {
      state.fallbacks += 1;
    }
    state.totalEvents += 1;
    state.lastEvent = sanitized;
  } catch {
    // Defensive: telemetry MUST NEVER throw out of this function.
  }
}

/**
 * Read aggregate stats. O(1).
 */
export function getEngineSelectionStats(): EngineSelectionStats {
  return {
    totals: { lance: state.totals.lance, swift: state.totals.swift },
    fallbacks: state.fallbacks,
    totalEvents: state.totalEvents,
    lastEvent: state.lastEvent,
  };
}

/**
 * Read up to `limit` most recent events in chronological order (oldest first).
 * Default `limit` returns the full ring window (≤ RING_CAPACITY).
 */
export function getRecentEngineEvents(
  limit: number = RING_CAPACITY,
): EngineSelectionEvent[] {
  const total = state.filled ? RING_CAPACITY : state.cursor;
  if (total === 0) return [];
  const cap = Math.max(0, Math.min(limit, total));
  if (cap === 0) return [];

  const out: EngineSelectionEvent[] = new Array(cap);
  // Newest event lives at (cursor - 1); we want the last `cap` items in order.
  // Walk back `cap` slots from the cursor.
  let idx = (state.cursor - cap + RING_CAPACITY) % RING_CAPACITY;
  for (let i = 0; i < cap; i++) {
    const e = state.ring[idx];
    out[i] = {
      engine: e.engine,
      outcome: e.outcome,
      ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
      ...(e.errorCode !== undefined ? { errorCode: e.errorCode } : {}),
    };
    idx = (idx + 1) % RING_CAPACITY;
  }
  return out;
}

/**
 * Test-only: drop all telemetry state. Not exported via any public barrel.
 */
export function __resetEngineTelemetryForTests(): void {
  state = makeInitialState();
}

/** Test-only: expose the ring capacity constant. */
export const __ENGINE_TELEMETRY_RING_CAPACITY = RING_CAPACITY;
