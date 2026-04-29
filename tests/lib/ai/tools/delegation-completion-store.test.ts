import { beforeEach, describe, expect, it } from "vitest";

import {
  addDelegationCompletion,
  clearDelegationCompletions,
  drainDelegationCompletions,
  hasPendingDelegationCompletions,
  peekDelegationCompletions,
} from "@/lib/ai/tools/delegation-completion-store";

const SESSION_ID = "initiator-session-1";

describe("delegation completion store", () => {
  beforeEach(() => {
    clearDelegationCompletions(SESSION_ID);
  });

  it("tracks pending completions per initiator session", () => {
    expect(hasPendingDelegationCompletions(SESSION_ID)).toBe(false);

    addDelegationCompletion({
      delegationId: "del-1",
      delegateName: "Explore",
      sessionId: "deleg-session-1",
      initiatorSessionId: SESSION_ID,
      characterId: "agent-init",
      completedAt: Date.now(),
    });

    expect(hasPendingDelegationCompletions(SESSION_ID)).toBe(true);
  });

  it("peeks completions without clearing them", () => {
    const completedAt = Date.now();
    addDelegationCompletion({
      delegationId: "del-1",
      delegateName: "Explore",
      sessionId: "deleg-session-1",
      initiatorSessionId: SESSION_ID,
      characterId: "agent-init",
      completedAt,
    });

    expect(peekDelegationCompletions(SESSION_ID)).toEqual([
      expect.objectContaining({ delegationId: "del-1", delegateName: "Explore", completedAt }),
    ]);
    expect(hasPendingDelegationCompletions(SESSION_ID)).toBe(true);
  });

  it("drains completions and clears them from the store", () => {
    const firstCompletedAt = Date.now();
    const secondCompletedAt = firstCompletedAt + 1;
    addDelegationCompletion({
      delegationId: "del-1",
      delegateName: "Explore",
      sessionId: "deleg-session-1",
      initiatorSessionId: SESSION_ID,
      characterId: "agent-init",
      completedAt: firstCompletedAt,
    });
    addDelegationCompletion({
      delegationId: "del-2",
      delegateName: "Reviewer",
      sessionId: "deleg-session-2",
      initiatorSessionId: SESSION_ID,
      characterId: "agent-init",
      completedAt: secondCompletedAt,
      error: "failed",
    });

    expect(drainDelegationCompletions(SESSION_ID)).toEqual([
      expect.objectContaining({ delegationId: "del-1", delegateName: "Explore", completedAt: firstCompletedAt }),
      expect.objectContaining({ delegationId: "del-2", delegateName: "Reviewer", completedAt: secondCompletedAt, error: "failed" }),
    ]);
    expect(hasPendingDelegationCompletions(SESSION_ID)).toBe(false);
    expect(drainDelegationCompletions(SESSION_ID)).toEqual([]);
  });

  it("drops expired completions before exposing them", () => {
    const now = Date.now();
    addDelegationCompletion({
      delegationId: "del-old",
      delegateName: "Explore",
      sessionId: "deleg-session-old",
      initiatorSessionId: SESSION_ID,
      characterId: "agent-init",
      completedAt: now - (8 * 24 * 60 * 60 * 1000),
    });
    addDelegationCompletion({
      delegationId: "del-fresh",
      delegateName: "Reviewer",
      sessionId: "deleg-session-fresh",
      initiatorSessionId: SESSION_ID,
      characterId: "agent-init",
      completedAt: now,
    });

    expect(peekDelegationCompletions(SESSION_ID)).toEqual([
      expect.objectContaining({ delegationId: "del-fresh" }),
    ]);
  });
});
