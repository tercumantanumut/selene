export interface DelegationCompletion {
  delegationId: string;
  delegateName: string;
  sessionId: string;
  initiatorSessionId: string;
  characterId: string;
  completedAt: number;
  status?: "completed" | "failed" | "stopped";
  error?: string;
  /**
   * The full delegation result content (e.g. `<delegation-result>` XML).
   * Populated when the live prompt queue is not active (run ended) so the
   * result can be injected by prepareStep in the next turn.
   */
  resultContent?: string;
  resultVersion?: number;
  deliveryId?: string;
  resultHash?: string;
  deliveredAt?: number;
}

type DelegationCompletionStore = Map<string, DelegationCompletion[]>;

const DELEGATION_COMPLETION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const globalForDelegationCompletions = globalThis as typeof globalThis & {
  delegationCompletions?: DelegationCompletionStore;
  delegationCompletionsHydrated?: boolean;
  delegationCompletionsPersistFailed?: boolean;
};

function getStore(): DelegationCompletionStore {
  if (!globalForDelegationCompletions.delegationCompletions) {
    globalForDelegationCompletions.delegationCompletions = new Map();
  }
  return globalForDelegationCompletions.delegationCompletions;
}

// ---------------------------------------------------------------------------
// SQLite write-through mirror (durability across server/app restarts).
//
// The in-memory Map stays the authoritative synchronous hot path — the
// /api/chat auto-resume guard relies on sync reads with no awaits. Every
// mutation is mirrored to the `delegation_completions` table so a process
// restart cannot lose pending results; on first access after a restart the
// Map is hydrated from the table. All DB access is lazy and fault-tolerant:
// if SQLite is unavailable (e.g. unit-test env without native bindings) the
// store degrades to the previous memory-only behavior with a logged warning.
// ---------------------------------------------------------------------------

type RawSqlite = import("better-sqlite3").Database;

function logPersistenceFailure(error: unknown): void {
  if (globalForDelegationCompletions.delegationCompletionsPersistFailed) return;
  globalForDelegationCompletions.delegationCompletionsPersistFailed = true;
  console.warn(
    "[DelegationCompletions] SQLite persistence unavailable — falling back to in-memory only (pending completions will not survive a restart):",
    error instanceof Error ? error.message : error,
  );
}

/** Test-only seam: lets suites supply a fake sqlite handle without native
 * bindings or module mocks. Never set in production code. */
let sqliteProviderOverride: (() => RawSqlite | null) | null = null;

export function setDelegationCompletionSqliteProviderForTests(
  provider: (() => RawSqlite | null) | null,
): void {
  sqliteProviderOverride = provider;
}

function getSqlite(): RawSqlite | null {
  if (sqliteProviderOverride) {
    try {
      return sqliteProviderOverride();
    } catch (error) {
      logPersistenceFailure(error);
      return null;
    }
  }
  try {
    // Lazy require: importing sqlite-client eagerly opens the database at
    // module-evaluation time, which must not happen in environments where
    // the store is used without a DB (unit tests, build-time evaluation).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getRawSqlite } = require("@/lib/db/sqlite-client") as typeof import("@/lib/db/sqlite-client");
    return getRawSqlite();
  } catch (error) {
    logPersistenceFailure(error);
    return null;
  }
}

interface DelegationCompletionRow {
  initiator_session_id: string;
  delegation_id: string;
  payload: string;
}

/** Load persisted completions into the in-memory Map once per process. */
function ensureHydrated(): void {
  if (globalForDelegationCompletions.delegationCompletionsHydrated) return;
  globalForDelegationCompletions.delegationCompletionsHydrated = true;

  const sqlite = getSqlite();
  if (!sqlite) return;

  try {
    const rows = sqlite
      .prepare(
        "SELECT initiator_session_id, delegation_id, payload FROM delegation_completions ORDER BY completed_at ASC",
      )
      .all() as DelegationCompletionRow[];
    if (rows.length === 0) return;

    const store = getStore();
    let restored = 0;
    for (const row of rows) {
      let completion: DelegationCompletion;
      try {
        completion = JSON.parse(row.payload) as DelegationCompletion;
      } catch {
        continue; // Corrupt payload — skip; pruning/TTL will sweep the row.
      }
      const existing = store.get(row.initiator_session_id) ?? [];
      if (existing.some((c) => c.delegationId === row.delegation_id)) {
        continue; // Memory already has it (same-process re-entry).
      }
      store.set(row.initiator_session_id, [...existing, completion]);
      restored += 1;
    }
    if (restored > 0) {
      console.log(`[DelegationCompletions] Restored ${restored} pending completion(s) from SQLite`);
    }
  } catch (error) {
    logPersistenceFailure(error);
  }
}

function persistAdd(completion: DelegationCompletion): void {
  const sqlite = getSqlite();
  if (!sqlite) return;
  try {
    sqlite
      .prepare(
        `INSERT OR REPLACE INTO delegation_completions
           (initiator_session_id, delegation_id, character_id, completed_at, payload)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        completion.initiatorSessionId,
        completion.delegationId,
        completion.characterId ?? "",
        completion.completedAt,
        JSON.stringify(completion),
      );
  } catch (error) {
    logPersistenceFailure(error);
  }
}

function persistClearSession(initiatorSessionId: string): void {
  const sqlite = getSqlite();
  if (!sqlite) return;
  try {
    sqlite
      .prepare("DELETE FROM delegation_completions WHERE initiator_session_id = ?")
      .run(initiatorSessionId);
  } catch (error) {
    logPersistenceFailure(error);
  }
}

function persistRemoveOne(initiatorSessionId: string, delegationId: string): void {
  const sqlite = getSqlite();
  if (!sqlite) return;
  try {
    sqlite
      .prepare(
        "DELETE FROM delegation_completions WHERE initiator_session_id = ? AND delegation_id = ?",
      )
      .run(initiatorSessionId, delegationId);
  } catch (error) {
    logPersistenceFailure(error);
  }
}

function persistPruneExpired(cutoff: number): void {
  const sqlite = getSqlite();
  if (!sqlite) return;
  try {
    sqlite.prepare("DELETE FROM delegation_completions WHERE completed_at < ?").run(cutoff);
  } catch (error) {
    logPersistenceFailure(error);
  }
}

function pruneExpiredEntries(now = Date.now()): void {
  const store = getStore();
  let removedAny = false;
  for (const [sessionId, completions] of store.entries()) {
    const fresh = completions.filter((completion) => now - completion.completedAt <= DELEGATION_COMPLETION_TTL_MS);
    if (fresh.length === 0) {
      store.delete(sessionId);
      removedAny = true;
      continue;
    }
    if (fresh.length !== completions.length) {
      store.set(sessionId, fresh);
      removedAny = true;
    }
  }
  if (removedAny) {
    persistPruneExpired(now - DELEGATION_COMPLETION_TTL_MS);
  }
}

export function addDelegationCompletion(completion: DelegationCompletion): void {
  ensureHydrated();
  pruneExpiredEntries();
  const store = getStore();
  const existing = store.get(completion.initiatorSessionId) ?? [];
  store.set(completion.initiatorSessionId, [...existing, completion]);
  persistAdd(completion);
}

export function peekDelegationCompletions(initiatorSessionId: string): DelegationCompletion[] {
  ensureHydrated();
  pruneExpiredEntries();
  return [...(getStore().get(initiatorSessionId) ?? [])];
}

export function clearDelegationCompletions(initiatorSessionId: string): void {
  ensureHydrated();
  getStore().delete(initiatorSessionId);
  persistClearSession(initiatorSessionId);
}

export function drainDelegationCompletions(initiatorSessionId: string): DelegationCompletion[] {
  const completions = peekDelegationCompletions(initiatorSessionId);
  clearDelegationCompletions(initiatorSessionId);
  return completions;
}

export function hasPendingDelegationCompletions(initiatorSessionId: string): boolean {
  return peekDelegationCompletions(initiatorSessionId).length > 0;
}

/**
 * Remove a single delegation completion by ID from the store.
 * Called when observe() returns a completed result — the notification
 * is already consumed and must not be re-delivered via system prompt.
 */
export function removeDelegationCompletionById(
  initiatorSessionId: string,
  delegationId: string,
): boolean {
  ensureHydrated();
  const store = getStore();
  const existing = store.get(initiatorSessionId);
  if (!existing || existing.length === 0) return false;
  const filtered = existing.filter((c) => c.delegationId !== delegationId);
  if (filtered.length === existing.length) return false;
  if (filtered.length === 0) {
    store.delete(initiatorSessionId);
  } else {
    store.set(initiatorSessionId, filtered);
  }
  persistRemoveOne(initiatorSessionId, delegationId);
  return true;
}

/**
 * All sessions that currently have pending completions, with the character to
 * resume as (latest non-empty characterId wins). Used by startup recovery to
 * re-schedule the server-side auto-resume fallback after a process restart.
 */
export function listSessionsWithPendingCompletions(): Array<{
  initiatorSessionId: string;
  characterId: string;
}> {
  ensureHydrated();
  pruneExpiredEntries();
  const result: Array<{ initiatorSessionId: string; characterId: string }> = [];
  for (const [initiatorSessionId, completions] of getStore().entries()) {
    if (completions.length === 0) continue;
    let characterId = "";
    for (const completion of completions) {
      if (completion.characterId) characterId = completion.characterId;
    }
    result.push({ initiatorSessionId, characterId });
  }
  return result;
}

/** Test-only: reset hydration + failure flags so suites can re-exercise them. */
export function resetDelegationCompletionPersistenceStateForTests(): void {
  globalForDelegationCompletions.delegationCompletionsHydrated = false;
  globalForDelegationCompletions.delegationCompletionsPersistFailed = false;
  globalForDelegationCompletions.delegationCompletions = new Map();
}
