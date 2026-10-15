import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  scheduleDelegationAutoResume,
  clearDelegationAutoResumeState,
} from "@/lib/background-tasks/delegation-auto-resume";
import {
  addDelegationCompletion,
  clearDelegationCompletions,
  drainDelegationCompletions,
  hasPendingDelegationCompletions,
} from "@/lib/ai/tools/delegation-completion-store";
import {
  reserveLivePromptQueueBySession,
  clearLivePromptQueueBySession,
} from "@/lib/background-tasks/live-prompt-queue-registry";

vi.mock("@/lib/db/sqlite-queries", () => ({
  getMessages: vi.fn(async () => [
    {
      id: "msg-1",
      sessionId: "initiator-session-ar",
      role: "user",
      content: [{ type: "text", text: "please review the branch" }],
      createdAt: new Date().toISOString(),
      orderingIndex: 0,
    },
    {
      id: "msg-2",
      sessionId: "initiator-session-ar",
      role: "assistant",
      content: [{ type: "text", text: "delegating reviews now" }],
      createdAt: new Date().toISOString(),
      orderingIndex: 1,
    },
  ]),
}));

vi.mock("@/lib/config/internal-api-secret", () => ({
  INTERNAL_API_SECRET: "test-internal-secret",
}));

vi.mock("@/lib/utils/environment", () => ({
  getInternalApiBaseUrl: () => "http://localhost:3000",
}));

const SESSION_ID = "initiator-session-ar";
const CHARACTER_ID = "agent-initiator";
const GRACE_MS = 50;

function addPendingCompletion(delegationId = "del-ar-1"): void {
  addDelegationCompletion({
    delegationId,
    delegateName: "Reviewer",
    sessionId: `deleg-session-${delegationId}`,
    initiatorSessionId: SESSION_ID,
    characterId: CHARACTER_ID,
    completedAt: Date.now(),
    resultContent: `<delegation-result delegationId="${delegationId}">ok</delegation-result>`,
  });
}

function mockFetchOk(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function flushTimers(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("delegation server-side auto-resume", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearDelegationAutoResumeState();
    clearDelegationCompletions(SESSION_ID);
    clearLivePromptQueueBySession(SESSION_ID);
  });

  afterEach(() => {
    clearDelegationAutoResumeState();
    clearDelegationCompletions(SESSION_ID);
    clearLivePromptQueueBySession(SESSION_ID);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("resumes the initiator session server-side when completions are pending and no run is active", async () => {
    const fetchMock = mockFetchOk();
    addPendingCompletion();

    scheduleDelegationAutoResume(SESSION_ID, CHARACTER_ID, GRACE_MS);
    await flushTimers(GRACE_MS + 10);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/chat");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Session-Id"]).toBe(SESSION_ID);
    expect(headers["X-Character-Id"]).toBe(CHARACTER_ID);
    expect(headers["X-Internal-Auth"]).toBe("test-internal-secret");
    expect(headers["X-Delegation-Auto-Resume"]).toBe("true");
    expect(headers["X-Task-Source"]).toBe("delegation-auto-resume");

    const body = JSON.parse(init.body as string) as { sessionId: string; messages: unknown[] };
    expect(body.sessionId).toBe(SESSION_ID);
    expect(body.messages.length).toBeGreaterThan(0);
  });

  it("does nothing when the frontend already drained the completions during the grace window", async () => {
    const fetchMock = mockFetchOk();
    addPendingCompletion();

    scheduleDelegationAutoResume(SESSION_ID, CHARACTER_ID, GRACE_MS);
    // Simulate the attached frontend resuming first (step-0 drain).
    drainDelegationCompletions(SESSION_ID);

    await flushTimers(GRACE_MS + 10);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("defers (reschedules) when a run is active for the session instead of double-running", async () => {
    const fetchMock = mockFetchOk();
    addPendingCompletion();
    reserveLivePromptQueueBySession(SESSION_ID);

    scheduleDelegationAutoResume(SESSION_ID, CHARACTER_ID, GRACE_MS);
    await flushTimers(GRACE_MS + 10);
    expect(fetchMock).not.toHaveBeenCalled();

    // Run ends; the rescheduled check should now fire the resume.
    clearLivePromptQueueBySession(SESSION_ID);
    await flushTimers(GRACE_MS + 10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("coalesces multiple completions into a single scheduled resume", async () => {
    const fetchMock = mockFetchOk();
    addPendingCompletion("del-ar-1");
    addPendingCompletion("del-ar-2");
    addPendingCompletion("del-ar-3");

    scheduleDelegationAutoResume(SESSION_ID, CHARACTER_ID, GRACE_MS);
    scheduleDelegationAutoResume(SESSION_ID, CHARACTER_ID, GRACE_MS);
    scheduleDelegationAutoResume(SESSION_ID, CHARACTER_ID, GRACE_MS);

    // Resume run drains the store at step 0 — simulate that side effect so the
    // post-run re-check does not schedule another cycle.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      drainDelegationCompletions(SESSION_ID);
      return new Response("ok", { status: 200 });
    });

    await flushTimers(GRACE_MS + 10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-checks after a resume run if completions arrived during teardown", async () => {
    const fetchMock = mockFetchOk();
    addPendingCompletion("del-ar-1");

    let call = 0;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        // First resume drains the current completion, but a sibling delegation
        // settles during run teardown and lands back in the store.
        drainDelegationCompletions(SESSION_ID);
        addPendingCompletion("del-ar-2");
      } else {
        drainDelegationCompletions(SESSION_ID);
      }
      return new Response("ok", { status: 200 });
    });

    scheduleDelegationAutoResume(SESSION_ID, CHARACTER_ID, GRACE_MS);
    await flushTimers(GRACE_MS + 10);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await flushTimers(GRACE_MS + 10);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(hasPendingDelegationCompletions(SESSION_ID)).toBe(false);
  });

  it("survives a failed resume request without clearing pending completions", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    addPendingCompletion();

    scheduleDelegationAutoResume(SESSION_ID, CHARACTER_ID, GRACE_MS);
    await flushTimers(GRACE_MS + 10);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Completions remain for the next cycle / next user visit.
    expect(hasPendingDelegationCompletions(SESSION_ID)).toBe(true);
  });
});
