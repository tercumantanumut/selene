import Database from "better-sqlite3";

export function initClaudeCodeSubagentTablesWith(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS claudecode_subagent_activities (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      run_id TEXT,
      character_id TEXT,
      parent_tool_use_id TEXT NOT NULL,
      task_id TEXT,
      subagent_name TEXT NOT NULL,
      subagent_type TEXT,
      description TEXT,
      status TEXT NOT NULL CHECK(status IN ('starting', 'running', 'completed', 'failed', 'cancelled', 'stale')),
      latest_summary TEXT NOT NULL,
      latest_tool_name TEXT,
      stream_availability TEXT NOT NULL CHECK(stream_availability IN ('pending', 'available', 'unavailable')),
      source TEXT NOT NULL DEFAULT 'claude-code-native',
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_claudecode_subagent_parent
      ON claudecode_subagent_activities (session_id, parent_tool_use_id);

    CREATE INDEX IF NOT EXISTS idx_claudecode_subagent_session_updated
      ON claudecode_subagent_activities (user_id, session_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS claudecode_subagent_events (
      id TEXT PRIMARY KEY,
      activity_id TEXT NOT NULL REFERENCES claudecode_subagent_activities(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      tool_name TEXT,
      task_id TEXT,
      parent_tool_use_id TEXT,
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_claudecode_subagent_events_activity
      ON claudecode_subagent_events (activity_id, timestamp ASC);
  `);
}
