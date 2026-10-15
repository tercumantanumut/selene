import Database from "better-sqlite3";

/**
 * Initialize the `delegation_completions` table.
 *
 * Durable mirror of the in-memory delegation completion store
 * (lib/ai/tools/delegation-completion-store.ts). Subagent results that finish
 * while the initiator's run is inactive are held here so a server/app restart
 * cannot lose them: on startup, instrumentation re-schedules the server-side
 * auto-resume fallback for every session that still has pending rows.
 *
 * The in-memory Map remains the synchronous hot path (the /api/chat atomic
 * guard depends on sync reads); this table is a write-through mirror. The
 * full completion object is stored as a JSON `payload` so the schema does not
 * need to chase the TypeScript interface; the key columns exist for indexing,
 * recovery scheduling, and TTL pruning.
 *
 * `(initiator_session_id, delegation_id)` is the primary key: a delegation
 * completes once, and the undrained-queue path may legitimately re-store the
 * same completion after a drain/teardown race — INSERT OR REPLACE keeps the
 * latest version. FK to sessions with ON DELETE CASCADE sweeps rows when the
 * initiator session is deleted (same convention as channel_outbox).
 */
export function initDelegationCompletionsTableWith(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS delegation_completions (
      initiator_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      delegation_id TEXT NOT NULL,
      character_id TEXT NOT NULL DEFAULT '',
      completed_at INTEGER NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (initiator_session_id, delegation_id)
    )
  `);

  // Recovery scan + per-session drain both filter on the session id (covered
  // by the PK prefix, but an explicit index documents the access path and
  // survives PK changes).
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_delegation_completions_session
      ON delegation_completions (initiator_session_id)
  `);

  // TTL pruning deletes by completed_at cutoff.
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_delegation_completions_completed_at
      ON delegation_completions (completed_at)
  `);
}
