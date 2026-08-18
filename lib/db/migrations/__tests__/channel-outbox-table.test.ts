/**
 * Coverage for the `channel_outbox` table added by `initChannelTablesWith`.
 *
 * The outbox is the durable delivery queue for outbound channel replies:
 * final assistant responses are enqueued here and retried by the outbox
 * worker if the send fails (e.g. after a long-running agent execution).
 *
 * Invariants under test:
 *   1. The migration is idempotent — a second invocation preserves rows.
 *   2. The table has the expected column shape and status CHECK constraint.
 *   3. Both declared indexes exist.
 *   4. Deleting the referenced message cascades the outbox rows.
 */
import Database from "better-sqlite3";
import { describe, expect, it, beforeEach } from "vitest";
import { initChannelTablesWith } from "../channel-tables";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");

  // Minimal parent tables referenced by the channel FKs.
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE characters (id TEXT PRIMARY KEY);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, channel_type TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY);
    INSERT INTO users (id) VALUES ('user-a');
    INSERT INTO characters (id) VALUES ('char-a');
    INSERT INTO sessions (id) VALUES ('session-a');
    INSERT INTO messages (id) VALUES ('message-a');
  `);

  return db;
}

describe("channel_outbox migration", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    initChannelTablesWith(db);
  });

  it("creates the channel_outbox table with the expected columns", () => {
    const columns = db
      .prepare("PRAGMA table_info(channel_outbox)")
      .all()
      .map((c) => (c as { name: string }).name);
    expect(columns).toEqual([
      "id",
      "session_id",
      "message_id",
      "raw_mode",
      "status",
      "attempts",
      "last_error",
      "next_attempt_at",
      "delivered_at",
      "created_at",
      "updated_at",
    ]);
  });

  it("creates the declared indexes", () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='channel_outbox'")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(indexes).toContain("channel_outbox_status_idx");
    expect(indexes).toContain("channel_outbox_message_uidx");
    // The pre-release non-unique index must be gone.
    expect(indexes).not.toContain("channel_outbox_message_idx");
  });

  it("enforces one outbox entry per message_id", () => {
    db.prepare(
      "INSERT INTO channel_outbox (id, session_id, message_id) VALUES ('outbox-1', 'session-a', 'message-a')"
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO channel_outbox (id, session_id, message_id) VALUES ('outbox-dup', 'session-a', 'message-a')"
        )
        .run()
    ).toThrow(/UNIQUE/);
  });

  it("enforces at most one outbound channel_messages record per message", () => {
    db.prepare(
      `INSERT INTO channel_connections (id, user_id, character_id, channel_type, status)
       VALUES ('conn-a', 'user-a', 'char-a', 'telegram', 'connected')`
    ).run();
    const insert = db.prepare(
      `INSERT INTO channel_messages (id, connection_id, channel_type, external_message_id, session_id, message_id, direction)
       VALUES (?, 'conn-a', 'telegram', ?, 'session-a', 'message-a', ?)`
    );
    insert.run("cm-1", "ext-1", "outbound");
    // Inbound duplicates for the same message are allowed (partial index).
    insert.run("cm-2", "ext-2", "inbound");
    expect(() => insert.run("cm-3", "ext-3", "outbound")).toThrow(/UNIQUE/);
  });

  it("upgrades a pre-release non-unique message index, deduping rows", () => {
    const legacy = createTestDb();
    // Simulate the pre-release state: table without the unique index and
    // with duplicate rows for the same message.
    legacy.exec(`
      CREATE TABLE channel_outbox (
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
      );
      CREATE INDEX channel_outbox_message_idx ON channel_outbox (message_id);
      INSERT INTO channel_outbox (id, session_id, message_id) VALUES ('outbox-1', 'session-a', 'message-a');
      INSERT INTO channel_outbox (id, session_id, message_id) VALUES ('outbox-2', 'session-a', 'message-a');
    `);

    initChannelTablesWith(legacy);

    const rows = legacy
      .prepare("SELECT id FROM channel_outbox ORDER BY id")
      .all()
      .map((r) => (r as { id: string }).id);
    expect(rows).toEqual(["outbox-1"]);
  });

  it("is idempotent and preserves rows across re-runs", () => {
    db.prepare(
      "INSERT INTO channel_outbox (id, session_id, message_id) VALUES ('outbox-1', 'session-a', 'message-a')"
    ).run();

    initChannelTablesWith(db);

    const row = db
      .prepare("SELECT status, attempts FROM channel_outbox WHERE id = 'outbox-1'")
      .get() as { status: string; attempts: number };
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
  });

  it("rejects invalid status values", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO channel_outbox (id, session_id, message_id, status) VALUES ('outbox-x', 'session-a', 'message-a', 'bogus')"
        )
        .run()
    ).toThrow(/CHECK/);
  });

  it("cascades outbox rows when the referenced message is deleted", () => {
    db.prepare(
      "INSERT INTO channel_outbox (id, session_id, message_id) VALUES ('outbox-2', 'session-a', 'message-a')"
    ).run();

    db.prepare("DELETE FROM messages WHERE id = 'message-a'").run();

    const remaining = db.prepare("SELECT COUNT(*) as n FROM channel_outbox").get() as { n: number };
    expect(remaining.n).toBe(0);
  });
});
