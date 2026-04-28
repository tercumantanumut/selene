/**
 * Coverage for `seedLobbyStarterTemplatesWith` (Sprint 10).
 *
 * SPEC §2 commits to shipping 3 starter templates (blank, research-and-
 * summarize, code-task) and SPEC §4 requires public templates have
 * `user_id IS NULL` and `visibility = 'public'`. The seed mechanism is the
 * only way the spec's commitment is fulfilled at runtime, so we verify:
 *
 *   1. The three templates land with the correct visibility + null user_id.
 *   2. The seed is idempotent — re-running boots does not duplicate rows or
 *      alter existing ones.
 *   3. A divergent row (someone hand-edited the description) is preserved
 *      across re-seeds. This is the deliberate `INSERT OR IGNORE` contract.
 *   4. The seat default-shapes match `LobbyTemplateSeatV1` (required +
 *      position + permissionScope), with `agentId` left undefined so the
 *      captain picks the agent at lobby-create time.
 */

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { initLobbiesTablesWith } from "@/lib/db/migrations/lobbies-tables";
import {
  getStarterTemplateDescriptors,
  seedLobbyStarterTemplatesWith,
} from "../seed-templates";

type TemplateRow = {
  id: string;
  name: string;
  description: string | null;
  default_seats: string;
  planning_prompt: string;
  synthesis_prompt: string;
  user_id: string | null;
  visibility: string;
  config: string;
};

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  // Parent tables the lobby tables FK into — we only need the bare minimum
  // for `lobby_templates`, which references `users(id)`.
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id));
    CREATE TABLE characters (id TEXT PRIMARY KEY);
    CREATE TABLE agent_runs (id TEXT PRIMARY KEY);
  `);
  initLobbiesTablesWith(db);
  return db;
}

function listTemplates(db: Database.Database): TemplateRow[] {
  return db
    .prepare(
      "SELECT id, name, description, default_seats, planning_prompt, synthesis_prompt, user_id, visibility, config FROM lobby_templates ORDER BY id",
    )
    .all() as TemplateRow[];
}

describe("seedLobbyStarterTemplatesWith", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("inserts the three starter templates with public visibility + null user_id", () => {
    seedLobbyStarterTemplatesWith(db);

    const rows = listTemplates(db);
    expect(rows).toHaveLength(3);

    const expectedIds = getStarterTemplateDescriptors()
      .map((t) => t.id)
      .sort();
    expect(rows.map((r) => r.id).sort()).toEqual(expectedIds);

    for (const row of rows) {
      // SPEC §4: public requires user_id NULL.
      expect(row.user_id).toBeNull();
      expect(row.visibility).toBe("public");
      // Prompts are non-empty strings — the orchestrator depends on these.
      expect(row.planning_prompt.length).toBeGreaterThan(0);
      expect(row.synthesis_prompt.length).toBeGreaterThan(0);
      // JSON columns parse cleanly.
      expect(() => JSON.parse(row.default_seats)).not.toThrow();
      expect(() => JSON.parse(row.config)).not.toThrow();
    }
  });

  it("is idempotent — re-running the seed does not duplicate rows", () => {
    seedLobbyStarterTemplatesWith(db);
    const after1 = listTemplates(db);
    expect(after1).toHaveLength(3);

    seedLobbyStarterTemplatesWith(db);
    seedLobbyStarterTemplatesWith(db);
    const after3 = listTemplates(db);
    expect(after3).toHaveLength(3);

    // Row identities preserved.
    expect(after3.map((r) => r.id).sort()).toEqual(
      after1.map((r) => r.id).sort(),
    );
  });

  it("preserves divergent existing rows (INSERT OR IGNORE contract)", () => {
    seedLobbyStarterTemplatesWith(db);
    const [first] = listTemplates(db);

    // Simulate a hand-edit / migration that changed the description of a
    // built-in template. The seed must NOT clobber it on subsequent boots —
    // a future intentional revision will land via a dedicated migration that
    // explicitly UPDATEs by id.
    const sentinel = "operator-edited description";
    db.prepare("UPDATE lobby_templates SET description = ? WHERE id = ?").run(
      sentinel,
      first.id,
    );

    seedLobbyStarterTemplatesWith(db);

    const rowAfter = db
      .prepare("SELECT description FROM lobby_templates WHERE id = ?")
      .get(first.id) as { description: string };
    expect(rowAfter.description).toBe(sentinel);
  });

  it("seat shapes match LobbyTemplateSeatV1 (required + position + permissionScope, agentId omitted)", () => {
    seedLobbyStarterTemplatesWith(db);

    for (const t of getStarterTemplateDescriptors()) {
      const row = db
        .prepare("SELECT default_seats FROM lobby_templates WHERE id = ?")
        .get(t.id) as { default_seats: string };
      const seats = JSON.parse(row.default_seats) as Array<Record<string, unknown>>;

      // Blank template intentionally has zero default seats (captain builds
      // the roster from scratch).
      if (t.id.endsWith("blank")) {
        expect(seats).toEqual([]);
        continue;
      }

      expect(seats.length).toBeGreaterThan(0);
      for (const seat of seats) {
        expect(typeof seat.role).toBe("string");
        expect(typeof seat.required).toBe("boolean");
        expect(typeof seat.position).toBe("number");
        expect(seat.agentId).toBeUndefined();
        expect(seat.permissionScope).toMatchObject({
          version: 1,
          mode: "tool_list",
        });
        expect(
          Array.isArray(
            (seat.permissionScope as { allowedTools: unknown }).allowedTools,
          ),
        ).toBe(true);
      }
    }
  });

  it("does not crash if the lobby_templates table is missing (defensive guard)", () => {
    const bareDb = new Database(":memory:");
    expect(() => seedLobbyStarterTemplatesWith(bareDb)).not.toThrow();
    bareDb.close();
  });
});
