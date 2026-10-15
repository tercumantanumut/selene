import Database from "better-sqlite3";

/**
 * Initialize core tables: users, sessions, messages, tool_runs, web_browse_entries, images.
 */
export function initCoreTablesWith(sqlite: Database.Database): void {
  // Users table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      external_id TEXT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Migration: Add password_hash column if it doesn't exist
  try {
    sqlite.exec(`ALTER TABLE users ADD COLUMN password_hash TEXT`);
  } catch {
    // Column already exists, ignore error
  }

  // Sessions table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      title TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived', 'deleted')),
      provider_session_id TEXT,
      summary TEXT,
      summary_up_to_message_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT NOT NULL DEFAULT '{}'
    )
  `);

  // Migration: Promote frequently queried session metadata to first-class columns
  try {
    sqlite.exec(`ALTER TABLE sessions ADD COLUMN character_id TEXT`);
    console.log("[SQLite Migration] Added character_id column to sessions");
  } catch {
    // Column already exists
  }
  try {
    sqlite.exec(`ALTER TABLE sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0`);
    console.log("[SQLite Migration] Added message_count column to sessions");
  } catch {
    // Column already exists
  }
  try {
    sqlite.exec(`ALTER TABLE sessions ADD COLUMN total_token_count INTEGER NOT NULL DEFAULT 0`);
    console.log("[SQLite Migration] Added total_token_count column to sessions");
  } catch {
    // Column already exists
  }
  try {
    sqlite.exec(`ALTER TABLE sessions ADD COLUMN last_message_at TEXT`);
    console.log("[SQLite Migration] Added last_message_at column to sessions");
  } catch {
    // Column already exists
  }
  try {
    sqlite.exec(`ALTER TABLE sessions ADD COLUMN channel_type TEXT`);
    console.log("[SQLite Migration] Added channel_type column to sessions");
  } catch {
    // Column already exists
  }

  try {
    sqlite.exec(`
      UPDATE sessions
      SET
        character_id = COALESCE(character_id, json_extract(metadata, '$.characterId')),
        channel_type = CASE
          WHEN channel_type IN ('whatsapp', 'telegram', 'slack', 'discord')
            THEN channel_type
          WHEN json_extract(metadata, '$.channelType') IN ('whatsapp', 'telegram', 'slack', 'discord')
            THEN json_extract(metadata, '$.channelType')
          ELSE NULL
        END
      WHERE character_id IS NULL
        OR channel_type IS NULL
        OR channel_type NOT IN ('whatsapp', 'telegram', 'slack', 'discord')
    `);
  } catch (error) {
    console.warn("[SQLite Migration] Failed to backfill sessions metadata columns:", error);
  }

  try {
    sqlite.exec(`
      UPDATE sessions
      SET
        message_count = COALESCE((
          SELECT COUNT(*)
          FROM messages
          WHERE messages.session_id = sessions.id
        ), 0),
        total_token_count = COALESCE((
          SELECT SUM(COALESCE(messages.token_count, 0))
          FROM messages
          WHERE messages.session_id = sessions.id
        ), 0),
        last_message_at = (
          SELECT MAX(messages.created_at)
          FROM messages
          WHERE messages.session_id = sessions.id
        )
      WHERE message_count = 0 AND total_token_count = 0 AND last_message_at IS NULL
    `);
  } catch (error) {
    console.warn("[SQLite Migration] Failed to backfill sessions counters:", error);
  }

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_user_character
      ON sessions (user_id, character_id, status)
  `);
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_user_updated
      ON sessions (user_id, updated_at DESC)
  `);
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_character_updated
      ON sessions (character_id, updated_at DESC)
  `);

  // Messages table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      parent_id TEXT,
      role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant', 'tool')),
      content TEXT NOT NULL,
      model TEXT,
      tool_name TEXT,
      tool_call_id TEXT,
      is_compacted INTEGER NOT NULL DEFAULT 0,
      token_count INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT NOT NULL DEFAULT '{}'
    )
  `);

  // Migration: Add ordering_index column for bullet-proof message ordering
  try {
    sqlite.exec(`ALTER TABLE messages ADD COLUMN ordering_index INTEGER`);
    console.log("[SQLite Migration] Added ordering_index column to messages");
  } catch {
    // Column already exists
  }

  // Migration: Add updated_at to messages for incremental polling
  try {
    sqlite.exec(`ALTER TABLE messages ADD COLUMN updated_at TEXT`);
    console.log("[SQLite Migration] Added updated_at column to messages");
  } catch {
    // Column already exists
  }
  try {
    sqlite.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_session_updated
        ON messages (session_id, updated_at)
    `);
  } catch (error) {
    console.warn("[SQLite Migration] Failed to create messages updated_at index:", error);
  }

  // Migration: Add last_ordering_index column to sessions for atomic index allocation
  try {
    sqlite.exec(`ALTER TABLE sessions ADD COLUMN last_ordering_index INTEGER DEFAULT 0`);
    console.log("[SQLite Migration] Added last_ordering_index column to sessions");
  } catch {
    // Column already exists
  }

  // Migration: Backfill ordering_index for existing messages
  try {
    const needsBackfill = sqlite.prepare(
      `SELECT COUNT(*) as count FROM messages WHERE ordering_index IS NULL`
    ).get() as { count: number };

    if (needsBackfill.count > 0) {
      console.log(`[SQLite Migration] Backfilling ordering_index for ${needsBackfill.count} messages...`);

      // Get all messages grouped by session, ordered by createdAt
      const messages = sqlite.prepare(
        `SELECT id, session_id, created_at FROM messages ORDER BY session_id, created_at, id`
      ).all() as Array<{ id: string; session_id: string; created_at: string }>;

      // Group by session and assign ordering indices
      const messagesBySession = new Map<string, Array<{ id: string; created_at: string }>>();
      for (const msg of messages) {
        const sessionMessages = messagesBySession.get(msg.session_id) || [];
        sessionMessages.push({ id: msg.id, created_at: msg.created_at });
        messagesBySession.set(msg.session_id, sessionMessages);
      }

      const updateStmt = sqlite.prepare(`UPDATE messages SET ordering_index = ? WHERE id = ?`);
      const updateSessionStmt = sqlite.prepare(`UPDATE sessions SET last_ordering_index = ? WHERE id = ?`);

      sqlite.exec("BEGIN TRANSACTION");
      try {
        for (const [sessionId, sessionMessages] of messagesBySession) {
          let maxIndex = 0;
          for (let i = 0; i < sessionMessages.length; i++) {
            const orderingIndex = i + 1; // 1-based indexing
            updateStmt.run(orderingIndex, sessionMessages[i].id);
            maxIndex = orderingIndex;
          }
          updateSessionStmt.run(maxIndex, sessionId);
        }
        sqlite.exec("COMMIT");
        console.log(`[SQLite Migration] Backfilled ordering_index for ${messages.length} messages in ${messagesBySession.size} sessions`);
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  } catch (error) {
    console.warn("[SQLite Migration] Failed to backfill ordering_index:", error);
  }

  // Create index for efficient session message ordering
  try {
    sqlite.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_session_ordering
        ON messages (session_id, ordering_index)
    `);
  } catch (error) {
    console.warn("[SQLite Migration] Failed to create ordering index:", error);
  }

  // Tool runs table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS tool_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      message_id TEXT REFERENCES messages(id),
      tool_name TEXT NOT NULL,
      args TEXT NOT NULL,
      result TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
      error TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    )
  `);

  // Web browse entries table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS web_browse_entries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      content_length INTEGER NOT NULL,
      images TEXT NOT NULL DEFAULT '[]',
      og_image TEXT,
      fetched_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_web_browse_entries_session
      ON web_browse_entries (session_id, fetched_at DESC)
  `);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_web_browse_entries_session_url
      ON web_browse_entries (session_id, url)
  `);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_web_browse_entries_expires
      ON web_browse_entries (expires_at)
  `);

  // Truncated content table (persistent backing for storeFullContent /
  // retrieveFullContent — was formerly an in-memory Map that lost every
  // contentId on Electron restart). FK-scoped to sessions for cascade delete.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS truncated_content (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      context TEXT NOT NULL,
      full_content TEXT NOT NULL,
      full_length INTEGER NOT NULL,
      truncated_length INTEGER NOT NULL,
      stored_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_truncated_content_session
      ON truncated_content (session_id, expires_at)
  `);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_truncated_content_expires
      ON truncated_content (expires_at)
  `);

  // Images table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      message_id TEXT REFERENCES messages(id),
      tool_run_id TEXT REFERENCES tool_runs(id),
      role TEXT NOT NULL CHECK(role IN ('upload', 'reference', 'generated', 'mask', 'tile')),
      local_path TEXT NOT NULL,
      url TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      format TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT NOT NULL DEFAULT '{}'
    )
  `);
}
