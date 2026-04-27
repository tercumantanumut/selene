import Database from "better-sqlite3";

export function initLobbiesTablesWith(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS lobby_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      default_seats TEXT NOT NULL DEFAULT '[]',
      planning_prompt TEXT NOT NULL,
      synthesis_prompt TEXT NOT NULL,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private', 'public')),
      config TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS lobbies (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      goal TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'roster' CHECK(status IN ('roster', 'planning', 'rolling', 'review', 'completed', 'aborted')),
      template_id TEXT REFERENCES lobby_templates(id) ON DELETE SET NULL,
      planning_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
      synthesis_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
      output_artifact_id TEXT,
      config TEXT NOT NULL DEFAULT '{"version":1}',
      lock_version INTEGER NOT NULL DEFAULT 0,
      event_sequence INTEGER NOT NULL DEFAULT 0,
      started_at TEXT,
      completed_at TEXT,
      aborted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS lobby_seats (
      id TEXT PRIMARY KEY,
      lobby_id TEXT NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      agent_id TEXT REFERENCES characters(id) ON DELETE RESTRICT,
      permission_scope TEXT NOT NULL DEFAULT '{"version":1,"mode":"tool_list","allowedTools":[]}',
      position INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'empty' CHECK(status IN ('empty', 'ready', 'busy', 'idle')),
      lock_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS lobby_cards (
      id TEXT PRIMARY KEY,
      lobby_id TEXT NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
      column TEXT NOT NULL DEFAULT 'backlog' CHECK(column IN ('backlog', 'ready', 'in_progress', 'review', 'done', 'blocked')),
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      assigned_seat_id TEXT REFERENCES lobby_seats(id) ON DELETE RESTRICT,
      position INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'awaiting_review', 'approved', 'rejected', 'failed', 'cancelled')),
      agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
      output TEXT,
      failure_reason TEXT,
      review_notes TEXT,
      reviewed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      lock_version INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL CHECK(created_by IN ('planner', 'human')),
      started_at TEXT,
      completed_at TEXT,
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS lobby_card_dependencies (
      lobby_id TEXT NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
      card_id TEXT NOT NULL REFERENCES lobby_cards(id) ON DELETE CASCADE,
      depends_on_card_id TEXT NOT NULL REFERENCES lobby_cards(id) ON DELETE CASCADE,
      optional INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (lobby_id, card_id, depends_on_card_id)
    )
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS lobby_events (
      id TEXT PRIMARY KEY,
      lobby_id TEXT NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      actor TEXT NOT NULL CHECK(actor IN ('captain', 'agent', 'system')),
      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      actor_agent_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
      card_id TEXT REFERENCES lobby_cards(id) ON DELETE SET NULL,
      seat_id TEXT REFERENCES lobby_seats(id) ON DELETE SET NULL,
      agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_lobby_templates_user_visibility
      ON lobby_templates (user_id, visibility)
  `);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_lobbies_user_status_updated
      ON lobbies (user_id, status, updated_at)
  `);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_lobbies_template
      ON lobbies (template_id)
  `);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_lobbies_planning_run
      ON lobbies (planning_run_id)
  `);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_lobbies_synthesis_run
      ON lobbies (synthesis_run_id)
  `);

  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lobbies_session
      ON lobbies (session_id)
  `);

  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lobby_seats_lobby_position
      ON lobby_seats (lobby_id, position)
  `);

  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lobby_seats_lobby_agent
      ON lobby_seats (lobby_id, agent_id)
      WHERE agent_id IS NOT NULL
  `);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_lobby_seats_lobby
      ON lobby_seats (lobby_id)
  `);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_lobby_seats_agent
      ON lobby_seats (agent_id)
  `);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_lobby_cards_lobby_column_position
      ON lobby_cards (lobby_id, column, position)
  `);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_lobby_cards_lobby_status
      ON lobby_cards (lobby_id, status)
  `);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_lobby_cards_assigned_seat_status
      ON lobby_cards (assigned_seat_id, status)
  `);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_lobby_cards_agent_run
      ON lobby_cards (agent_run_id)
  `);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_lobby_card_dependencies_lobby_depends_on
      ON lobby_card_dependencies (lobby_id, depends_on_card_id)
  `);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_lobby_card_dependencies_lobby_card
      ON lobby_card_dependencies (lobby_id, card_id)
  `);

  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lobby_events_lobby_sequence
      ON lobby_events (lobby_id, sequence)
  `);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_lobby_events_lobby_created
      ON lobby_events (lobby_id, created_at)
  `);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_lobby_events_lobby_type
      ON lobby_events (lobby_id, type)
  `);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_lobby_events_card
      ON lobby_events (card_id)
  `);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_lobby_events_agent_run
      ON lobby_events (agent_run_id)
  `);
}
