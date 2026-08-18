import Database from "better-sqlite3";

function tableExists(sqlite: Database.Database, tableName: string): boolean {
  const row = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(tableName) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function readTableSql(sqlite: Database.Database, tableName: string): string {
  const row = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?")
    .get(tableName) as { sql?: string } | undefined;
  return row?.sql || "";
}

function tableSupportsDiscord(sql: string): boolean {
  return sql.includes("'discord'");
}

function migrateChannelTablesToSupportDiscord(sqlite: Database.Database): void {
  const tables = ["channel_connections", "channel_conversations", "channel_messages"] as const;
  const needsMigration = tables.some((tableName) => {
    if (!tableExists(sqlite, tableName)) return false;
    return !tableSupportsDiscord(readTableSql(sqlite, tableName));
  });

  if (!needsMigration) {
    return;
  }

  console.log("[SQLite Migration] Rebuilding channel tables to add Discord support");

  try {
    sqlite.exec("BEGIN IMMEDIATE");
    sqlite.exec("PRAGMA foreign_keys=OFF");

    const existingConnections = tableExists(sqlite, "channel_connections");
    const existingConversations = tableExists(sqlite, "channel_conversations");
    const existingMessages = tableExists(sqlite, "channel_messages");

    if (existingMessages) {
      sqlite.exec("ALTER TABLE channel_messages RENAME TO channel_messages_old");
    }
    if (existingConversations) {
      sqlite.exec("ALTER TABLE channel_conversations RENAME TO channel_conversations_old");
    }
    if (existingConnections) {
      sqlite.exec("ALTER TABLE channel_connections RENAME TO channel_connections_old");
    }

    sqlite.exec(`
      CREATE TABLE channel_connections (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        channel_type TEXT NOT NULL CHECK(channel_type IN ('whatsapp', 'telegram', 'slack', 'discord')),
        display_name TEXT,
        config TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'disconnected' CHECK(status IN ('disconnected', 'connecting', 'connected', 'error')),
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    sqlite.exec(`
      CREATE TABLE channel_conversations (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES channel_connections(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        channel_type TEXT NOT NULL CHECK(channel_type IN ('whatsapp', 'telegram', 'slack', 'discord')),
        peer_id TEXT NOT NULL,
        peer_name TEXT,
        thread_id TEXT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        last_message_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    sqlite.exec(`
      CREATE TABLE channel_messages (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES channel_connections(id) ON DELETE CASCADE,
        channel_type TEXT NOT NULL CHECK(channel_type IN ('whatsapp', 'telegram', 'slack', 'discord')),
        external_message_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    if (existingConnections && tableExists(sqlite, "channel_connections_old")) {
      sqlite.exec(`
        INSERT INTO channel_connections (
          id, user_id, character_id, channel_type, display_name, config,
          status, last_error, created_at, updated_at
        )
        SELECT
          id, user_id, character_id, channel_type, display_name, config,
          status, last_error, created_at, updated_at
        FROM channel_connections_old
      `);
    }

    if (existingConversations && tableExists(sqlite, "channel_conversations_old")) {
      sqlite.exec(`
        INSERT INTO channel_conversations (
          id, connection_id, character_id, channel_type, peer_id, peer_name,
          thread_id, session_id, last_message_at, created_at, updated_at
        )
        SELECT
          id, connection_id, character_id, channel_type, peer_id, peer_name,
          thread_id, session_id, last_message_at, created_at, updated_at
        FROM channel_conversations_old
      `);
    }

    if (existingMessages && tableExists(sqlite, "channel_messages_old")) {
      sqlite.exec(`
        INSERT INTO channel_messages (
          id, connection_id, channel_type, external_message_id,
          session_id, message_id, direction, created_at
        )
        SELECT
          id, connection_id, channel_type, external_message_id,
          session_id, message_id, direction, created_at
        FROM channel_messages_old
      `);
    }

    sqlite.exec("DROP TABLE IF EXISTS channel_messages_old");
    sqlite.exec("DROP TABLE IF EXISTS channel_conversations_old");
    sqlite.exec("DROP TABLE IF EXISTS channel_connections_old");

    sqlite.exec("COMMIT");
  } catch (error) {
    try {
      if (sqlite.inTransaction) {
        sqlite.exec("ROLLBACK");
      }
    } catch {
      // Ignore rollback failures
    }

    const hasOldConnections = tableExists(sqlite, "channel_connections_old");
    const hasNewConnections = tableExists(sqlite, "channel_connections");
    if (hasOldConnections && !hasNewConnections) {
      sqlite.exec("ALTER TABLE channel_connections_old RENAME TO channel_connections");
    }

    const hasOldConversations = tableExists(sqlite, "channel_conversations_old");
    const hasNewConversations = tableExists(sqlite, "channel_conversations");
    if (hasOldConversations && !hasNewConversations) {
      sqlite.exec("ALTER TABLE channel_conversations_old RENAME TO channel_conversations");
    }

    const hasOldMessages = tableExists(sqlite, "channel_messages_old");
    const hasNewMessages = tableExists(sqlite, "channel_messages");
    if (hasOldMessages && !hasNewMessages) {
      sqlite.exec("ALTER TABLE channel_messages_old RENAME TO channel_messages");
    }

    console.warn("[SQLite Migration] Channel table Discord migration failed:", error);
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    sqlite.exec("PRAGMA foreign_keys=ON");
  }
}

/**
 * Initialize channel tables: channel_connections, channel_conversations, channel_messages.
 */
export function initChannelTablesWith(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS channel_connections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      channel_type TEXT NOT NULL CHECK(channel_type IN ('whatsapp', 'telegram', 'slack', 'discord')),
      display_name TEXT,
      config TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'disconnected' CHECK(status IN ('disconnected', 'connecting', 'connected', 'error')),
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS channel_conversations (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES channel_connections(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      channel_type TEXT NOT NULL CHECK(channel_type IN ('whatsapp', 'telegram', 'slack', 'discord')),
      peer_id TEXT NOT NULL,
      peer_name TEXT,
      thread_id TEXT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      last_message_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS channel_messages (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES channel_connections(id) ON DELETE CASCADE,
      channel_type TEXT NOT NULL CHECK(channel_type IN ('whatsapp', 'telegram', 'slack', 'discord')),
      external_message_id TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS channel_outbox (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      raw_mode INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'delivering', 'delivered', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_attempt_at TEXT,
      delivered_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  migrateChannelTablesToSupportDiscord(sqlite);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS channel_outbox_status_idx
      ON channel_outbox (status, next_attempt_at)
  `);
  // message_id must be unique: one logical delivery per final message. This
  // makes enqueue idempotent and prevents concurrent workers from creating
  // duplicate deliveries. Drop the pre-release non-unique index and clean up
  // any duplicate rows before creating the unique index.
  sqlite.exec(`DROP INDEX IF EXISTS channel_outbox_message_idx`);
  sqlite.exec(`
    DELETE FROM channel_outbox
      WHERE rowid NOT IN (SELECT MIN(rowid) FROM channel_outbox GROUP BY message_id)
  `);
  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS channel_outbox_message_uidx
      ON channel_outbox (message_id)
  `);
  // Supports resetStaleChannelOutboxEntries (status='delivering' AND updated_at < t).
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS channel_outbox_status_updated_idx
      ON channel_outbox (status, updated_at)
  `);

  // At most one outbound channel_messages record per internal message. This
  // backs the outbox dedup check ("did a previous attempt actually land?")
  // with a DB invariant and an index. Clean up any pre-existing duplicates
  // (possible from the pre-outbox delivery path) before creating it.
  sqlite.exec(`
    DELETE FROM channel_messages
      WHERE direction = 'outbound'
        AND rowid NOT IN (
          SELECT MIN(rowid) FROM channel_messages
            WHERE direction = 'outbound'
            GROUP BY message_id
        )
  `);
  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_messages_outbound_message_uidx
      ON channel_messages (message_id) WHERE direction = 'outbound'
  `);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_channel_connections_user
      ON channel_connections (user_id)
  `);
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_channel_connections_character
      ON channel_connections (character_id)
  `);
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_channel_connections_type
      ON channel_connections (channel_type)
  `);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_channel_conversations_connection
      ON channel_conversations (connection_id)
  `);
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_channel_conversations_character
      ON channel_conversations (character_id)
  `);
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_channel_conversations_peer
      ON channel_conversations (channel_type, peer_id, thread_id)
  `);
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_channel_conversations_session
      ON channel_conversations (session_id)
  `);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_channel_messages_connection
      ON channel_messages (connection_id)
  `);
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_channel_messages_external
      ON channel_messages (channel_type, external_message_id, direction)
  `);
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_channel_messages_session
      ON channel_messages (session_id)
  `);

  sqlite.exec(`
    UPDATE sessions
    SET channel_type = NULL
    WHERE channel_type IS NOT NULL
      AND channel_type NOT IN ('whatsapp', 'telegram', 'slack', 'discord')
  `);
}
