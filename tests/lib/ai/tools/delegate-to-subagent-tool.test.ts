import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWorkflowByAgentId: vi.fn(),
  getWorkflowMembers: vi.fn(),
  getCharacterFull: vi.fn(),
  createSession: vi.fn(),
  getMessages: vi.fn(),
  getObserveMessageSummary: vi.fn(),
  getObserveStepsSince: vi.fn(),
  listAgentRunsBySession: vi.fn(),
  markRunAsCancelled: vi.fn(),
  abortChatRun: vi.fn(),
  removeChatAbortController: vi.fn(),
  taskRegistryGet: vi.fn(),
  taskRegistryUpdateStatus: vi.fn(),
  appendToLivePromptQueueBySession: vi.fn(),
  removeFromQueueByDelegationId: vi.fn(),
  removeDelegationCompletionById: vi.fn(),
  addDelegationCompletion: vi.fn(),
  markDelegationResultDelivered: vi.fn(),
  getDelegationDeliveryRecord: vi.fn(),
  clearDelegationDeliveryRecords: vi.fn(),
}));

vi.mock("@/lib/agents/workflows", () => ({
  getWorkflowByAgentId: mocks.getWorkflowByAgentId,
  getWorkflowMembers: mocks.getWorkflowMembers,
}));

vi.mock("@/lib/characters/queries", () => ({
  getCharacterFull: mocks.getCharacterFull,
}));

vi.mock("@/lib/db/sqlite-queries", () => ({
  createSession: mocks.createSession,
  getMessages: mocks.getMessages,
  getObserveMessageSummary: mocks.getObserveMessageSummary,
  getObserveStepsSince: mocks.getObserveStepsSince,
}));

vi.mock("@/lib/observability/queries", () => ({
  listAgentRunsBySession: mocks.listAgentRunsBySession,
  markRunAsCancelled: mocks.markRunAsCancelled,
}));

vi.mock("@/lib/background-tasks/chat-abort-registry", () => ({
  abortChatRun: mocks.abortChatRun,
  removeChatAbortController: mocks.removeChatAbortController,
}));

vi.mock("@/lib/background-tasks/live-prompt-queue-registry", () => ({
  appendToLivePromptQueueBySession: mocks.appendToLivePromptQueueBySession,
  removeFromQueueByDelegationId: mocks.removeFromQueueByDelegationId,
}));

vi.mock("@/lib/ai/tools/delegation-completion-store", () => ({
  addDelegationCompletion: mocks.addDelegationCompletion,
  removeDelegationCompletionById: mocks.removeDelegationCompletionById,
}));

vi.mock("@/lib/ai/tools/delegation-delivery-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/tools/delegation-delivery-registry")>();
  return {
    ...actual,
    markDelegationResultDelivered: mocks.markDelegationResultDelivered,
    getDelegationDeliveryRecord: mocks.getDelegationDeliveryRecord,
    clearDelegationDeliveryRecords: mocks.clearDelegationDeliveryRecords,
  };
});

vi.mock("@/lib/background-tasks/registry", () => ({
  taskRegistry: {
    get: mocks.taskRegistryGet,
    updateStatus: mocks.taskRegistryUpdateStatus,
  },
}));

const bridgeMocks = vi.hoisted(() => ({
  getPendingInteractivePrompts: vi.fn(),
  resolveInteractiveWait: vi.fn(),
}));

vi.mock("@/lib/interactive-tool-bridge", () => ({
  getPendingInteractivePrompts: bridgeMocks.getPendingInteractivePrompts,
  resolveInteractiveWait: bridgeMocks.resolveInteractiveWait,
}));

import { createDelegateToSubagentTool } from "@/lib/ai/tools/delegate-to-subagent-tool";
import { activeDelegations } from "@/lib/ai/tools/delegate-to-subagent-types";
import { clearDelegationDeliveryRecords } from "@/lib/ai/tools/delegation-delivery-registry";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTool(provider = "claudecode") {
  return createDelegateToSubagentTool({
    sessionId: "sess-main",
    userId: "user-1",
    characterId: "agent-init",
    provider,
  });
}

describe("delegate-to-subagent-tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeDelegations.clear();
    clearDelegationDeliveryRecords();

    mocks.getWorkflowByAgentId.mockResolvedValue({
      workflow: { id: "wf-1", name: "Main Workflow" },
      member: { workflowId: "wf-1", agentId: "agent-init", role: "initiator" },
    });

    mocks.getWorkflowMembers.mockResolvedValue([
      { workflowId: "wf-1", agentId: "agent-init", role: "initiator", metadataSeed: {} },
      {
        workflowId: "wf-1",
        agentId: "agent-research",
        role: "subagent",
        metadataSeed: { purpose: "Research and synthesis" },
      },
      {
        workflowId: "wf-1",
        agentId: "agent-review",
        role: "subagent",
        metadataSeed: { purpose: "Code review" },
      },
    ]);

    mocks.getCharacterFull.mockImplementation(async (agentId: string) => {
      if (agentId === "agent-research") {
        return {
          id: "agent-research",
          name: "researcher",
          displayName: "Research Analyst",
          tagline: "Research specialist",
        };
      }
      if (agentId === "agent-review") {
        return {
          id: "agent-review",
          name: "reviewer",
          displayName: "Code Reviewer",
          tagline: "Review specialist",
        };
      }
      if (agentId === "agent-init") {
        return {
          id: "agent-init",
          name: "initiator",
          displayName: "Initiator",
          tagline: "Main coordinator",
        };
      }
      return null;
    });

    mocks.createSession.mockResolvedValue({ id: "delegation-session-1" });
    mocks.getMessages.mockResolvedValue([
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);
    mocks.getObserveMessageSummary.mockResolvedValue({
      recentAssistantMessages: [
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ],
      assistantMessageCount: 1,
      messageCount: 1,
      toolMessageCount: 0,
    });
    mocks.getObserveStepsSince.mockResolvedValue({
      steps: [],
      maxOrderingIndex: 0,
    });
    mocks.listAgentRunsBySession.mockResolvedValue([]);
    mocks.markRunAsCancelled.mockResolvedValue(undefined);
    mocks.abortChatRun.mockReturnValue(true);
    mocks.taskRegistryGet.mockReturnValue(undefined);
    bridgeMocks.getPendingInteractivePrompts.mockReturnValue([]);
    bridgeMocks.resolveInteractiveWait.mockReturnValue(false);
    mocks.appendToLivePromptQueueBySession.mockReturnValue(false);
    mocks.removeFromQueueByDelegationId.mockReturnValue(0);
    mocks.removeDelegationCompletionById.mockReturnValue(false);
    mocks.markDelegationResultDelivered.mockImplementation((record) => record);
    mocks.getDelegationDeliveryRecord.mockReturnValue(undefined);

    fetchMock.mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
        }),
      },
      text: async () => "",
    });
  });

  it("list returns available sub-agents with names and ids", async () => {
    const tool = makeTool();
    const result = await (tool as any).execute({ action: "list" });

    expect(result.success).toBe(true);
    expect(result.availableAgents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: "agent-research",
          agentName: "Research Analyst",
        }),
        expect.objectContaining({
          agentId: "agent-review",
          agentName: "Code Reviewer",
        }),
      ]),
    );
  });

  it("start resolves sub-agent by agentName", async () => {
    const tool = makeTool();
    const result = await (tool as any).execute({
      action: "start",
      agentName: "Research Analyst",
      task: "Summarize recent API changes",
    });

    expect(result.success).toBe(true);
    expect(result.delegateAgent).toBe("Research Analyst");
    expect(result.delegationId).toBeTypeOf("string");

    await (tool as any).execute({
      action: "stop",
      delegationId: result.delegationId,
    });
  });

  it("start returns a clear ambiguity error when agentName is not unique", async () => {
    mocks.getWorkflowMembers.mockResolvedValue([
      { workflowId: "wf-1", agentId: "agent-init", role: "initiator", metadataSeed: {} },
      { workflowId: "wf-1", agentId: "agent-1", role: "subagent", metadataSeed: {} },
      { workflowId: "wf-1", agentId: "agent-2", role: "subagent", metadataSeed: {} },
    ]);

    mocks.getCharacterFull.mockImplementation(async (agentId: string) => {
      if (agentId === "agent-1") {
        return { id: "agent-1", name: "analyst-east", displayName: "Analyst East" };
      }
      if (agentId === "agent-2") {
        return { id: "agent-2", name: "analyst-west", displayName: "Analyst West" };
      }
      return { id: "agent-init", name: "initiator", displayName: "Initiator" };
    });

    const tool = makeTool();
    const result = await (tool as any).execute({
      action: "start",
      agentName: "Analyst",
      task: "Run analysis",
    });

    expect(result.success).toBe(false);
    expect(String(result.error || "")).toContain("matches multiple sub-agents");
    expect(Array.isArray(result.availableAgents)).toBe(true);
  });

  it("stop cancels the underlying active run so background UI state can clear", async () => {
    mocks.listAgentRunsBySession.mockResolvedValue([
      {
        id: "run-delegated-1",
        status: "running",
        startedAt: new Date(Date.now() - 2_000).toISOString(),
      },
    ]);
    mocks.taskRegistryGet.mockReturnValue({
      startedAt: new Date(Date.now() - 1_000).toISOString(),
    });

    const tool = makeTool();
    const start = await (tool as any).execute({
      action: "start",
      agentName: "Research Analyst",
      task: "Investigate lingering active session UI",
      mode: "background",
    });

    const stopped = await (tool as any).execute({
      action: "stop",
      delegationId: start.delegationId,
    });

    expect(stopped.success).toBe(true);
    expect(mocks.listAgentRunsBySession).toHaveBeenCalledWith("delegation-session-1");
    expect(mocks.abortChatRun).toHaveBeenCalledWith("run-delegated-1", "user_cancelled");
    expect(mocks.markRunAsCancelled).toHaveBeenCalledWith(
      "run-delegated-1",
      "user_cancelled",
      expect.objectContaining({
        terminalStatus: "stopped",
        delegationId: start.delegationId,
        stoppedAt: expect.any(String),
      }),
    );
    expect(mocks.taskRegistryUpdateStatus).toHaveBeenCalledWith(
      "run-delegated-1",
      "cancelled",
      expect.objectContaining({
        durationMs: expect.any(Number),
        metadata: expect.objectContaining({
          terminalStatus: "stopped",
          delegationId: start.delegationId,
          stoppedAt: expect.any(String),
        }),
      }),
    );
    expect(mocks.removeChatAbortController).toHaveBeenCalledWith("run-delegated-1");
  });

  it("stop falls back cleanly when no active run exists yet", async () => {
    mocks.listAgentRunsBySession.mockResolvedValue([]);

    const tool = makeTool();
    const start = await (tool as any).execute({
      action: "start",
      agentName: "Research Analyst",
      task: "Cancel before run registration",
      mode: "background",
    });

    const stopped = await (tool as any).execute({
      action: "stop",
      delegationId: start.delegationId,
    });

    expect(stopped.success).toBe(true);
    expect(mocks.markRunAsCancelled).not.toHaveBeenCalled();
    expect(mocks.taskRegistryUpdateStatus).not.toHaveBeenCalled();
    expect(mocks.removeChatAbortController).not.toHaveBeenCalled();
  });

  it("reports an explicitly stopped sub-agent as stopped, not completed", async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });

    const tool = makeTool();
    const start = await (tool as any).execute({
      action: "start",
      agentName: "Research Analyst",
      task: "Cancel and report status accurately",
      mode: "background",
    });

    const stopped = await (tool as any).execute({
      action: "stop",
      delegationId: start.delegationId,
    });

    await delay(20);

    expect(stopped).toEqual(expect.objectContaining({
      success: true,
      delegationId: start.delegationId,
      running: false,
      completed: false,
      status: "stopped",
    }));

    expect(mocks.addDelegationCompletion).toHaveBeenCalled();
    const completion = mocks.addDelegationCompletion.mock.calls.at(-1)?.[0];
    expect(completion).toEqual(expect.objectContaining({
      delegationId: start.delegationId,
      status: "stopped",
      error: undefined,
    }));
    expect(completion.resultContent).toContain('status="stopped"');
    expect(completion.resultContent).not.toContain('status="completed"');

    const observed = await (tool as any).execute({
      action: "observe",
      delegationId: start.delegationId,
    });
    expect(observed).toEqual(expect.objectContaining({
      success: true,
      running: false,
      completed: false,
      status: "stopped",
    }));
  });

  it("observe supports waitSeconds so callers can avoid tight polling loops", async () => {
    let readCount = 0;
    fetchMock.mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (readCount === 0) {
              readCount += 1;
              await delay(180);
              return { done: false, value: new Uint8Array([1]) };
            }
            return { done: true, value: undefined };
          },
        }),
      },
      text: async () => "",
    });

    const tool = makeTool();
    const start = await (tool as any).execute({
      action: "start",
      agentName: "Research Analyst",
      task: "Investigate build regressions",
      mode: "background",
    });

    expect(start.success).toBe(true);
    expect(start.mode).toBe("background");

    const immediateObserve = await (tool as any).execute({
      action: "observe",
      delegationId: start.delegationId,
    });
    expect(immediateObserve.running).toBe(true);

    const waitedObserve = await (tool as any).execute({
      action: "observe",
      delegationId: start.delegationId,
      waitSeconds: 0.3,
    });
    expect(waitedObserve.success).toBe(true);
    expect(waitedObserve.running).toBe(false);
    expect(waitedObserve.completed).toBe(true);
    expect(waitedObserve.waitTimedOut).toBe(false);
    expect((waitedObserve.waitedMs as number) >= 150).toBe(true);
  });

  it("list keeps settled delegations visible until TTL cleanup", async () => {
    let readCount = 0;
    fetchMock.mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (readCount === 0) {
              readCount += 1;
              await delay(50);
              return { done: false, value: new Uint8Array([1]) };
            }
            return { done: true, value: undefined };
          },
        }),
      },
      text: async () => "",
    });

    const tool = makeTool();
    const started = await (tool as any).execute({
      action: "start",
      agentName: "Research Analyst",
      task: "Investigate delegation cleanup",
      mode: "background",
    });

    const runningList = await (tool as any).execute({ action: "list" });
    expect(runningList.delegations).toEqual([
      expect.objectContaining({
        delegationId: started.delegationId,
        running: true,
        completed: false,
      }),
    ]);

    await delay(120);

    const observed = await (tool as any).execute({
      action: "observe",
      delegationId: started.delegationId,
    });
    expect(observed.success).toBe(true);
    expect(observed.completed).toBe(true);

    const settledList = await (tool as any).execute({ action: "list" });
    expect(settledList.delegations).toEqual([
      expect.objectContaining({
        delegationId: started.delegationId,
        running: false,
        completed: true,
      }),
    ]);
  });

  it("observe keeps a successfully settled background delegation in the registry for follow-up reads", async () => {
    let readCount = 0;
    fetchMock.mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (readCount === 0) {
              readCount += 1;
              await delay(40);
              return { done: false, value: new Uint8Array([1]) };
            }
            return { done: true, value: undefined };
          },
        }),
      },
      text: async () => "",
    });

    const tool = makeTool();
    const started = await (tool as any).execute({
      action: "start",
      agentName: "Research Analyst",
      task: "Verify source cleanup after completion",
      mode: "background",
    });

    expect(activeDelegations.has(started.delegationId!)).toBe(true);

    await delay(120);

    const observed = await (tool as any).execute({
      action: "observe",
      delegationId: started.delegationId,
    });

    expect(observed.success).toBe(true);
    expect(observed.completed).toBe(true);
    expect(activeDelegations.has(started.delegationId!)).toBe(true);

    const secondObserve = await (tool as any).execute({
      action: "observe",
      delegationId: started.delegationId,
    });
    expect(secondObserve.success).toBe(true);
    expect(secondObserve.completed).toBe(true);
  });

  it("observe returns compact metadata after an auto-delivered result unless forced", async () => {
    let readCount = 0;
    fetchMock.mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (readCount === 0) {
              readCount += 1;
              await delay(40);
              return { done: false, value: new Uint8Array([1]) };
            }
            return { done: true, value: undefined };
          },
        }),
      },
      text: async () => "",
    });

    mocks.getDelegationDeliveryRecord.mockReturnValue({
      delegationId: "delivered-id",
      resultVersion: 1,
      deliveryId: "deleg-delivery-delivered-id-v1",
      resultHash: "hash-1",
      deliveredAt: 123,
      channel: "live-prompt",
    });

    const tool = makeTool();
    const started = await (tool as any).execute({
      action: "start",
      agentName: "Research Analyst",
      task: "Verify duplicate delivery guard",
      mode: "background",
    });

    await delay(120);

    const observed = await (tool as any).execute({
      action: "observe",
      delegationId: started.delegationId,
    });

    expect(observed).toEqual(expect.objectContaining({
      success: true,
      completed: true,
      deliveryStatus: "already_delivered",
      deliveryId: "deleg-delivery-delivered-id-v1",
      resultVersion: 1,
      resultHash: "hash-1",
      deliveredAt: 123,
    }));
    expect(observed.lastResponse).toBeUndefined();
    expect(mocks.getObserveMessageSummary).not.toHaveBeenCalled();

    const forced = await (tool as any).execute({
      action: "observe",
      delegationId: started.delegationId,
      force: true,
    });

    expect(forced.success).toBe(true);
    expect(forced.lastResponse).toBe("done");
    expect(forced.deliveryId).toBe("deleg-delivery-delivered-id-v1");
    expect(mocks.getObserveMessageSummary).toHaveBeenCalledTimes(1);
  });

  it("start always returns immediately in background mode regardless of runInBackground flag", async () => {
    const tool = makeTool();
    const result = await (tool as any).execute({
      action: "start",
      agentName: "Research Analyst",
      task: "Investigate flaky tests",
      runInBackground: false,
    });

    expect(result.success).toBe(true);
    expect(typeof result.delegationId).toBe("string");
    expect(result.mode).toBe("background");
    expect(result.message).toContain("background");
    // Delegation stays in the registry for the model to observe later
    expect(activeDelegations.has(result.delegationId!)).toBe(true);
  });


  it("start returns immediately even when a sub-agent has pending interactive prompts", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            await delay(40);
            return { done: false, value: new Uint8Array([1]) };
          },
        }),
      },
      text: async () => "",
    });

    bridgeMocks.getPendingInteractivePrompts.mockImplementation(() => [
      {
        sessionId: "delegation-session-1",
        toolUseId: "toolu_123",
        questions: [{ question: "Proceed?", options: [] }],
        createdAt: Date.now(),
      },
    ]);

    const tool = makeTool();
    const result = await (tool as any).execute({
      action: "start",
      agentName: "Research Analyst",
      task: "Run QA check",
    });

    // Start always returns immediately in background mode — interactive
    // prompts are discovered via observe(), not blocking start()
    expect(result.success).toBe(true);
    expect(result.mode).toBe("background");
    expect(result.message).toContain("background");
  });

  it("start supports resume alias by mapping to continue semantics", async () => {
    let readCount = 0;
    fetchMock.mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (readCount === 0) {
              readCount += 1;
              await delay(150);
              return { done: false, value: new Uint8Array([1]) };
            }
            return { done: true, value: undefined };
          },
        }),
      },
      text: async () => "",
    });

    const tool = makeTool();

    const started = await (tool as any).execute({
      action: "start",
      agentName: "Research Analyst",
      task: "Initial analysis",
      mode: "background",
    });

    const resumed = await (tool as any).execute({
      action: "start",
      resume: started.delegationId,
      task: "Focus only on regressions",
    });

    expect(resumed.success).toBe(true);
    expect(String(resumed.message || "")).toContain("Follow-up message");
  });

  it("continue aborts previous run without surfacing an abort failure", async () => {
    let readCount = 0;
    fetchMock.mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (readCount === 0) {
              readCount += 1;
              await delay(150);
              return { done: false, value: new Uint8Array([1]) };
            }
            return { done: true, value: undefined };
          },
        }),
      },
      text: async () => "",
    });

    const tool = makeTool();
    const started = await (tool as any).execute({
      action: "start",
      agentName: "Research Analyst",
      task: "Initial analysis",
      mode: "background",
    });

    await delay(10);

    const resumed = await (tool as any).execute({
      action: "continue",
      delegationId: started.delegationId,
      followUpMessage: "Focus only on regressions",
    });

    expect(resumed.success).toBe(true);

    await delay(300);

    const observed = await (tool as any).execute({
      action: "observe",
      delegationId: started.delegationId,
    });

    expect(observed.success).toBe(true);
    expect(observed.completed).toBe(true);
    expect(observed.running).toBe(false);
    expect(String(observed.error || "")).toBe("");
  });

  it("answer forwards interactive responses into the delegation session", async () => {
    const tool = makeTool();
    const started = await (tool as any).execute({
      action: "start",
      agentName: "Research Analyst",
      task: "Initial analysis",
      mode: "background",
    });

    bridgeMocks.resolveInteractiveWait.mockReturnValueOnce(true);

    const answered = await (tool as any).execute({
      action: "answer",
      delegationId: started.delegationId,
      toolUseId: "toolu_123",
      answers: { Proceed: "Continue and confirm generation" },
    });

    expect(answered.success).toBe(true);
    expect(bridgeMocks.resolveInteractiveWait).toHaveBeenCalledWith(
      "delegation-session-1",
      "toolu_123",
      { Proceed: "Continue and confirm generation" },
    );
  });

  it("start ignores maxTurns and does not inject execution constraints", async () => {
    const tool = makeTool();
    const result = await (tool as any).execute({
      action: "start",
      agentName: "Research Analyst",
      task: "Analyze module",
      maxTurns: 999,
    });

    expect(result.success).toBe(true);

    const fetchBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const delegatedPrompt = String(fetchBody.messages?.[0]?.content || "");
    expect(delegatedPrompt).not.toContain("Execution constraint from initiator");
  });

  it("observe rejects waitSeconds over the max limit", async () => {
    const tool = makeTool();
    const result = await (tool as any).execute({
      action: "observe",
      delegationId: "del-test",
      waitSeconds: 601,
    });

    expect(result.success).toBe(false);
    expect(String(result.error || "")).toContain("cannot exceed 600");
  });

  it("observe cleans up completion notifications when returning a settled result (prevents duplicate responses)", async () => {
    // Regression test: when observe() returns a completed delegation, it must
    // remove any queued live prompt notifications AND delegation completion store
    // entries for this delegation. Without this, the model receives the result
    // AND a "[Delegation Complete] Use observe..." notification in the next step,
    // causing it to re-observe or generate a duplicate/looped response.
    const finalText = "Analysis complete. Want me to dig deeper into any specific part?";
    mocks.getObserveMessageSummary.mockResolvedValue({
      recentAssistantMessages: [
        { role: "assistant", content: [{ type: "text", text: finalText }] },
      ],
      assistantMessageCount: 1,
      messageCount: 2,
      toolMessageCount: 0,
    });

    fetchMock.mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
        }),
      },
      text: async () => "",
    });

    const tool = makeTool();
    const start = await (tool as any).execute({
      action: "start",
      agentName: "Research Analyst",
      task: "Summarize the auth module",
      mode: "background",
    });

    // Wait for delegation to settle
    await delay(60);

    const observed = await (tool as any).execute({
      action: "observe",
      delegationId: start.delegationId,
    });

    // The observe should return the result exactly once
    expect(observed.success).toBe(true);
    expect(observed.completed).toBe(true);
    expect(observed.lastResponse).toBe(finalText);

    // Cleanup should have been called to prevent double-delivery
    expect(mocks.removeFromQueueByDelegationId).toHaveBeenCalledWith(
      "sess-main",
      start.delegationId,
    );
    expect(mocks.removeDelegationCompletionById).toHaveBeenCalledWith(
      "sess-main",
      start.delegationId,
    );
  });

  it("observe does NOT clean up notifications when delegation is still running", async () => {
    let readCount = 0;
    fetchMock.mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (readCount === 0) {
              readCount += 1;
              await delay(500);
              return { done: false, value: new Uint8Array([1]) };
            }
            return { done: true, value: undefined };
          },
        }),
      },
      text: async () => "",
    });

    const tool = makeTool();
    const start = await (tool as any).execute({
      action: "start",
      agentName: "Research Analyst",
      task: "Long running analysis",
      mode: "background",
    });

    // Observe immediately — delegation still running
    const observed = await (tool as any).execute({
      action: "observe",
      delegationId: start.delegationId,
    });

    expect(observed.success).toBe(true);
    expect(observed.running).toBe(true);
    expect(observed.completed).toBe(false);

    // Should NOT clean up notifications for still-running delegations
    expect(mocks.removeFromQueueByDelegationId).not.toHaveBeenCalled();
    expect(mocks.removeDelegationCompletionById).not.toHaveBeenCalled();
  });

  it("observe returns full lastResponse and bounded/truncated prior response previews", async () => {
    const longPrior = "P".repeat(1_450);
    const longLast = "L".repeat(9_200);
    // getObserveMessageSummary is asked for MAX_OBSERVE_PREVIEW_RESPONSES + 1 = 7
    // recent assistant messages, so the mock should return exactly 7.
    mocks.getObserveMessageSummary.mockResolvedValue({
      recentAssistantMessages: [
        { role: "assistant", content: [{ type: "text", text: longPrior }] },
        { role: "assistant", content: [{ type: "text", text: "step-4" }] },
        { role: "assistant", content: [{ type: "text", text: "step-5" }] },
        { role: "assistant", content: [{ type: "text", text: "step-6" }] },
        { role: "assistant", content: [{ type: "text", text: "step-7" }] },
        { role: "assistant", content: [{ type: "text", text: "step-8" }] },
        { role: "assistant", content: [{ type: "text", text: longLast }] },
      ],
      assistantMessageCount: 9,
      messageCount: 10,
      toolMessageCount: 1,
    });

    fetchMock.mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
        }),
      },
      text: async () => "",
    });

    const tool = makeTool();
    const start = await (tool as any).execute({
      action: "start",
      agentName: "Research Analyst",
      task: "Investigate delegation history output",
      mode: "background",
    });

    const observed = await (tool as any).execute({
      action: "observe",
      delegationId: start.delegationId,
    });

    expect(observed.success).toBe(true);
    expect(observed.lastResponse).toBe(longLast);
    expect(observed.allResponses).toHaveLength(6);
    expect(observed.allResponses?.join("\n")).not.toContain(longLast);
    expect(observed.allResponses?.some((r: string) => r.includes("[Response truncated]"))).toBe(true);
    expect(observed.responseCount).toBe(9);
    expect(observed.responsePreviewCount).toBe(6);
    expect(observed.responsePreviewOmittedCount).toBe(2);
    expect(observed.responsePreviewTruncatedCount).toBe(1);
  });
});
