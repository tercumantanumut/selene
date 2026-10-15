/**
 * Durable delegation completion store — write-through persistence tests.
 *
 * The store mirrors every mutation to the `delegation_completions` SQLite
 * table and hydrates the in-memory Map from it on first access, so pending
 * subagent results survive a server/app restart. These tests exercise that
 * behavior against a fake sqlite handle (no native bindings needed) injected
 * via the test-only provider seam.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// delegation-auto-resume imports sqlite-queries (which opens the DB at module
// eval) — mock the chain so no native sqlite is needed. The store itself is
// exercised through the test-only provider seam instead.
vi.mock("@/lib/db/sqlite-queries", () => ({
  getMessages: vi.fn(async () => []),
}));
vi.mock("@/lib/config/internal-api-secret", () => ({
  INTERNAL_API_SECRET: "test-internal-secret",
}));
import {
  addDelegationCompletion,
  drainDelegationCompletions,
  peekDelegationCompletions,
  removeDelegationCompletionById,
  listSessionsWithPendingCompletions,
  resetDelegationCompletionPersistenceStateForTests,
  setDelegationCompletionSqliteProviderForTests,
  type DelegationCompletion,
} from "@/lib/ai/tools/delegation-completion-store";
import { recoverPendingDelegationAutoResumes, clearDelegationAutoResumeState } from "@/lib/background-tasks/delegation-auto-resume";

interface FakeRow {
  initiator_session_id: string;
  delegation_id: string;
  character_id: string;
  completed_at: number;
  payload: string;
}

/** Minimal fake of the better-sqlite3 surface the store uses. */
function createFakeSqlite() {
  const rows = new Map<string, FakeRow>();
  const key = (sid: string, did: string) => `${sid}|${did}`;

  const handle = {
    prepare(sql: string) {
      if (sql.includes("INSERT OR REPLACE")) {
        return {
          run(sid: string, did: string, cid: string, completedAt: number, payload: string) {
            rows.set(key(sid, did), {
              initiator_session_id: sid,
              delegation_id: did,
              character_id: cid,
              completed_at: completedAt,
              payload,
            });
          },
        };
      }
      if (sql.startsWith("SELECT")) {
        return {
          all: () =>
            [...rows.values()].sort((a, b) => a.completed_at - b.completed_at),
        };
      }
      if (sql.includes("initiator_session_id = ? AND delegation_id = ?")) {
        return {
          run(sid: string, did: string) {
            rows.delete(key(sid, did));
          },
        };
      }
      if (sql.includes("initiator_session_id = ?")) {
        return {
          run(sid: string) {
            for (const [k, row] of rows) {
              if (row.initiator_session_id === sid) rows.delete(k);
            }
          },
        };
      }
      if (sql.includes("completed_at <")) {
        return {
          run(cutoff: number) {
            for (const [k, row] of rows) {
              if (row.completed_at < cutoff) rows.delete(k);
            }
          },
        };
      }
      throw new Error(`FakeSqlite: unhandled SQL: ${sql}`);
    },
  };

  return { handle: handle as unknown as import("better-sqlite3").Database, rows };
}

function makeCompletion(overrides: Partial<DelegationCompletion> = {}): DelegationCompletion {
  return {
    delegationId: "del-1",
    delegateName: "Reviewer",
    sessionId: "sub-session-1",
    initiatorSessionId: "session-a",
    characterId: "char-1",
    completedAt: Date.now(),
    status: "completed",
    resultContent: "<delegation-result>ok</delegation-result>",
    ...overrides,
  };
}

describe("delegation completion store persistence", () => {
  let fake: ReturnType<typeof createFakeSqlite>;

  beforeEach(() => {
    fake = createFakeSqlite();
    resetDelegationCompletionPersistenceStateForTests();
    setDelegationCompletionSqliteProviderForTests(() => fake.handle);
    clearDelegationAutoResumeState();
  });

  afterEach(() => {
    setDelegationCompletionSqliteProviderForTests(null);
    resetDelegationCompletionPersistenceStateForTests();
    clearDelegationAutoResumeState();
  });

  it("write-through: add persists a row, drain deletes it", () => {
    addDelegationCompletion(makeCompletion());
    expect(fake.rows.size).toBe(1);
    const row = [...fake.rows.values()][0];
    expect(row.initiator_session_id).toBe("session-a");
    expect(JSON.parse(row.payload).resultContent).toContain("delegation-result");

    const drained = drainDelegationCompletions("session-a");
    expect(drained).toHaveLength(1);
    expect(fake.rows.size).toBe(0);
  });

  it("removeDelegationCompletionById deletes only the matching row", () => {
    addDelegationCompletion(makeCompletion({ delegationId: "del-1" }));
    addDelegationCompletion(makeCompletion({ delegationId: "del-2" }));
    expect(fake.rows.size).toBe(2);

    expect(removeDelegationCompletionById("session-a", "del-1")).toBe(true);
    expect(fake.rows.size).toBe(1);
    expect([...fake.rows.values()][0].delegation_id).toBe("del-2");
  });

  it("hydration: a fresh process restores pending completions from SQLite", () => {
    const base = Date.now();
    addDelegationCompletion(makeCompletion({ delegationId: "del-1", completedAt: base - 2000 }));
    addDelegationCompletion(
      makeCompletion({ delegationId: "del-2", initiatorSessionId: "session-b", completedAt: base - 1000 }),
    );

    // Simulate restart: memory gone, DB rows survive.
    resetDelegationCompletionPersistenceStateForTests();
    setDelegationCompletionSqliteProviderForTests(() => fake.handle);

    const a = peekDelegationCompletions("session-a");
    expect(a).toHaveLength(1);
    expect(a[0].delegationId).toBe("del-1");
    expect(peekDelegationCompletions("session-b")).toHaveLength(1);
  });

  it("listSessionsWithPendingCompletions reports latest non-empty characterId", () => {
    const base = Date.now();
    addDelegationCompletion(
      makeCompletion({ delegationId: "del-1", characterId: "", completedAt: base - 2000 }),
    );
    addDelegationCompletion(
      makeCompletion({ delegationId: "del-2", characterId: "char-late", completedAt: base - 1000 }),
    );

    const sessions = listSessionsWithPendingCompletions();
    expect(sessions).toEqual([{ initiatorSessionId: "session-a", characterId: "char-late" }]);
  });

  it("startup recovery schedules auto-resume for every session with persisted rows", () => {
    addDelegationCompletion(makeCompletion({ initiatorSessionId: "session-a" }));
    addDelegationCompletion(
      makeCompletion({ delegationId: "del-2", initiatorSessionId: "session-b" }),
    );

    // Simulate restart, then instrumentation recovery.
    resetDelegationCompletionPersistenceStateForTests();
    setDelegationCompletionSqliteProviderForTests(() => fake.handle);
    clearDelegationAutoResumeState();

    const recovered = recoverPendingDelegationAutoResumes();
    expect(recovered).toBe(2);
  });

  it("degrades to memory-only when the sqlite provider throws", () => {
    setDelegationCompletionSqliteProviderForTests(() => {
      throw new Error("no native bindings");
    });

    expect(() => addDelegationCompletion(makeCompletion())).not.toThrow();
    expect(peekDelegationCompletions("session-a")).toHaveLength(1);
    expect(drainDelegationCompletions("session-a")).toHaveLength(1);
    expect(peekDelegationCompletions("session-a")).toHaveLength(0);
  });

  it("skips corrupt persisted payloads without breaking hydration", () => {
    const base = Date.now();
    addDelegationCompletion(makeCompletion({ delegationId: "del-good", completedAt: base - 1000 }));
    fake.rows.set("session-a|del-bad", {
      initiator_session_id: "session-a",
      delegation_id: "del-bad",
      character_id: "",
      completed_at: base - 2000,
      payload: "{not json",
    });

    resetDelegationCompletionPersistenceStateForTests();
    setDelegationCompletionSqliteProviderForTests(() => fake.handle);

    const restored = peekDelegationCompletions("session-a");
    expect(restored).toHaveLength(1);
    expect(restored[0].delegationId).toBe("del-good");
  });
});
