/**
 * Regression tests for the undrained-queue delegation-completion path.
 *
 * When a delegation result is appended to an ACTIVE run's live prompt queue,
 * `notifyInitiatorSessionOfCompletion` returns early without emitting the SSE
 * signal or scheduling the server fallback — the run is expected to drain it.
 * If the run ends before the next prepareStep, `handleUndrainedQueueMessages`
 * moves the entry into the persistent completion store. Historically it did
 * this WITHOUT re-triggering the delivery signals, leaving that path
 * client-dependent (delivery only on next visit) — the overnight-stall bug.
 *
 * These tests assert that the undrained path now:
 *   1. stores the completion with the run's characterId (needed for the
 *      internal auto-resume request), and
 *   2. emits the SSE signal AND schedules the server-side fallback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/sqlite-client", () => ({ db: {}, getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/db/queries", () => ({
  createMessage: vi.fn(async () => ({ id: "msg-created" })),
  updateMessage: vi.fn(async () => ({})),
  getSession: vi.fn(async () => null),
  updateSession: vi.fn(async () => ({})),
}));
vi.mock("@/lib/observability", () => ({
  completeAgentRun: vi.fn(async () => {}),
  appendRunEvent: vi.fn(async () => {}),
}));
vi.mock("@/lib/agent-memory", () => ({ triggerExtraction: vi.fn() }));
vi.mock("@/lib/channels/outbox", () => ({ deliverChannelReplyDurable: vi.fn() }));
vi.mock("@/lib/plugins/hook-integration", () => ({ runStopHooks: vi.fn(async () => {}) }));
vi.mock("@/lib/session/message-ordering", () => ({ nextOrderingIndex: vi.fn(async () => 0) }));
vi.mock("@/lib/background-tasks/undrained-signal", () => ({ signalUndrainedMessages: vi.fn() }));
vi.mock("@/lib/background-tasks/delegation-completion-signal", () => ({
  emitDelegationCompleted: vi.fn(),
}));
vi.mock("@/lib/background-tasks/delegation-auto-resume", () => ({
  scheduleDelegationAutoResume: vi.fn(),
}));

import { handleUndrainedQueueMessages } from "@/app/api/chat/stream-callbacks";
import { emitDelegationCompleted } from "@/lib/background-tasks/delegation-completion-signal";
import { scheduleDelegationAutoResume } from "@/lib/background-tasks/delegation-auto-resume";
import { signalUndrainedMessages } from "@/lib/background-tasks/undrained-signal";
import {
  createLivePromptQueue,
  appendToLivePromptQueue,
  removeLivePromptQueue,
} from "@/lib/background-tasks/live-prompt-queue-registry";
import {
  drainDelegationCompletions,
  clearDelegationCompletions,
  hasPendingDelegationCompletions,
} from "@/lib/ai/tools/delegation-completion-store";

const RUN_ID = "run-undrained-test";
const SESSION_ID = "session-undrained-test";
const CHARACTER_ID = "agent-main";

describe("handleUndrainedQueueMessages — delegation completion fallback scheduling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearDelegationCompletions(SESSION_ID);
    createLivePromptQueue(RUN_ID, SESSION_ID);
  });

  afterEach(() => {
    removeLivePromptQueue(RUN_ID, SESSION_ID);
    clearDelegationCompletions(SESSION_ID);
  });

  it("moves undrained delegation entries to the store and re-triggers signal + server fallback", async () => {
    appendToLivePromptQueue(RUN_ID, {
      id: "deleg-delivery-del-1",
      content: '<delegation-result delegationId="del-1">done</delegation-result>',
      stopIntent: false,
      metadata: {
        kind: "delegation_completion",
        delegationId: "del-1",
        delegateName: "Reviewer",
        status: "completed",
      },
    });

    await handleUndrainedQueueMessages(RUN_ID, SESSION_ID, CHARACTER_ID);

    // Stored with the initiator's characterId so the internal resume request
    // can be built (or fall back to session metadata when empty).
    const stored = drainDelegationCompletions(SESSION_ID);
    expect(stored).toHaveLength(1);
    expect(stored[0].delegationId).toBe("del-1");
    expect(stored[0].characterId).toBe(CHARACTER_ID);
    expect(stored[0].resultContent).toContain("del-1");

    // Both delivery triggers must fire — otherwise the completion silently
    // waits for the user's next visit (mount-time catch-up).
    expect(emitDelegationCompleted).toHaveBeenCalledWith(SESSION_ID);
    expect(scheduleDelegationAutoResume).toHaveBeenCalledWith(SESSION_ID, CHARACTER_ID);
  });

  it("tolerates a missing characterId (falls back to empty string; route resolves from session metadata)", async () => {
    appendToLivePromptQueue(RUN_ID, {
      id: "deleg-delivery-del-2",
      content: '<delegation-result delegationId="del-2">done</delegation-result>',
      stopIntent: false,
      metadata: { kind: "delegation_completion", delegationId: "del-2", delegateName: "Reviewer" },
    });

    await handleUndrainedQueueMessages(RUN_ID, SESSION_ID);

    expect(hasPendingDelegationCompletions(SESSION_ID)).toBe(true);
    expect(scheduleDelegationAutoResume).toHaveBeenCalledWith(SESSION_ID, "");
  });

  it("does not emit or schedule when there are no delegation entries", async () => {
    appendToLivePromptQueue(RUN_ID, {
      id: "user-entry-1",
      content: "a queued user message",
      stopIntent: false,
    });

    await handleUndrainedQueueMessages(RUN_ID, SESSION_ID, CHARACTER_ID);

    expect(emitDelegationCompleted).not.toHaveBeenCalled();
    expect(scheduleDelegationAutoResume).not.toHaveBeenCalled();
    // Non-delegation entries still get the undrained signal.
    expect(signalUndrainedMessages).toHaveBeenCalledWith(SESSION_ID);
  });

  it("does nothing at all on an empty queue", async () => {
    await handleUndrainedQueueMessages(RUN_ID, SESSION_ID, CHARACTER_ID);

    expect(emitDelegationCompleted).not.toHaveBeenCalled();
    expect(scheduleDelegationAutoResume).not.toHaveBeenCalled();
    expect(signalUndrainedMessages).not.toHaveBeenCalled();
    expect(hasPendingDelegationCompletions(SESSION_ID)).toBe(false);
  });
});
