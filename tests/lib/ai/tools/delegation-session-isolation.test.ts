/**
 * Cross-session isolation tests for the delegation registry.
 *
 * Verifies the core security property introduced in the session-scoping fix:
 * delegations created in Session A must not be visible to, or interactable
 * from, Session B — even when both sessions belong to the same initiator agent.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  getWorkflowByAgentId: vi.fn(),
  getWorkflowMembers: vi.fn(),
  getCharacterFull: vi.fn(),
  createSession: vi.fn(),
  getObserveMessageSummary: vi.fn(),
  getObserveStepsSince: vi.fn(),
  listAgentRunsBySession: vi.fn(),
  markRunAsCancelled: vi.fn(),
  abortChatRun: vi.fn(),
  removeChatAbortController: vi.fn(),
  taskRegistryGet: vi.fn(),
  taskRegistryUpdateStatus: vi.fn(),
  appendToLivePromptQueueBySession: vi.fn(),
  hasStopIntent: vi.fn(),
  sanitizeLivePromptContent: vi.fn((s: string) => s),
  addDelegationCompletion: vi.fn(),
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

vi.mock("@/lib/background-tasks/registry", () => ({
  taskRegistry: {
    get: mocks.taskRegistryGet,
    updateStatus: mocks.taskRegistryUpdateStatus,
  },
}));

vi.mock("@/lib/background-tasks/live-prompt-queue-registry", () => ({
  appendToLivePromptQueueBySession: mocks.appendToLivePromptQueueBySession,
}));

vi.mock("@/lib/background-tasks/live-prompt-helpers", () => ({
  hasStopIntent: mocks.hasStopIntent,
  sanitizeLivePromptContent: mocks.sanitizeLivePromptContent,
}));

vi.mock("@/lib/ai/tools/delegation-completion-store", () => ({
  addDelegationCompletion: mocks.addDelegationCompletion,
  drainDelegationCompletions: vi.fn(() => []),
  hasPendingDelegationCompletions: vi.fn(() => false),
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
import { getActiveDelegationsForCharacter } from "@/lib/ai/tools/delegate-to-subagent-handlers";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const AGENT_ID = "agent-init";
const SESSION_A = "sess-A";
const SESSION_B = "sess-B";

function makeToolForSession(sessionId: string) {
  return createDelegateToSubagentTool({
    sessionId,
    userId: "user-1",
    characterId: AGENT_ID,
    provider: "claudecode",
  });
}

async function startDelegationInSession(sessionId: string): Promise<string> {
  const tool = makeToolForSession(sessionId);
  const result = await (tool as any).execute({
    action: "start",
    agentName: "Worker Agent",
    task: `Task from ${sessionId}`,
    mode: "background",
  });
  expect(result.success).toBe(true);
  expect(typeof result.delegationId).toBe("string");
  return result.delegationId as string;
}

describe("delegate-to-subagent-tool session isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeDelegations.clear();

    mocks.getWorkflowByAgentId.mockResolvedValue({
      workflow: { id: "wf-1", name: "Main Workflow" },
      member: { workflowId: "wf-1", agentId: AGENT_ID, role: "initiator" },
    });

    mocks.getWorkflowMembers.mockResolvedValue([
      { workflowId: "wf-1", agentId: AGENT_ID, role: "initiator", metadataSeed: {} },
      {
        workflowId: "wf-1",
        agentId: "agent-worker",
        role: "subagent",
        metadataSeed: { purpose: "Worker" },
      },
    ]);

    mocks.getCharacterFull.mockImplementation(async (agentId: string) => {
      if (agentId === AGENT_ID) {
        return {
          id: AGENT_ID,
          name: "initiator",
          displayName: "Initiator",
          tagline: "Initiates tasks",
        };
      }
      if (agentId === "agent-worker") {
        return {
          id: "agent-worker",
          name: "worker",
          displayName: "Worker Agent",
          tagline: "Executes tasks",
        };
      }
      return null;
    });

    mocks.createSession.mockImplementation(async ({ metadata }: any) => ({
      id: `deleg-session-${Math.random().toString(36).slice(2, 8)}`,
      metadata,
    }));

    mocks.getObserveMessageSummary.mockResolvedValue({
      recentAssistantMessages: [],
      assistantMessageCount: 0,
      messageCount: 0,
      toolMessageCount: 0,
    });
    mocks.getObserveStepsSince.mockResolvedValue({
      steps: [],
      maxOrderingIndex: 0,
    });

    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolve({
            ok: true,
            body: {
              getReader: () => ({
                read: () => new Promise(() => {}),
              }),
            },
            text: async () => "",
          });
        }),
    );

    mocks.listAgentRunsBySession.mockResolvedValue([]);
    bridgeMocks.getPendingInteractivePrompts.mockReturnValue([]);
    bridgeMocks.resolveInteractiveWait.mockReturnValue(true);
  });

  // ─── Observe ──────────────────────────────────────────────────────────────

  describe("observe", () => {
    it("Session B cannot observe a delegation created in Session A", async () => {
      const delIdA = await startDelegationInSession(SESSION_A);

      // Session A can observe it
      const toolA = makeToolForSession(SESSION_A);
      const observeA = await (toolA as any).execute({
        action: "observe",
        delegationId: delIdA,
      });
      expect(observeA.success).toBe(true);

      // Session B gets "not found"
      const toolB = makeToolForSession(SESSION_B);
      const observeB = await (toolB as any).execute({
        action: "observe",
        delegationId: delIdA,
      });
      expect(observeB.success).toBe(false);
      expect(observeB.error).toContain("not found");
    });
  });

  // ─── Stop ─────────────────────────────────────────────────────────────────

  describe("stop", () => {
    it("Session B cannot stop a delegation created in Session A", async () => {
      const delIdA = await startDelegationInSession(SESSION_A);

      // Session B tries to stop it
      const toolB = makeToolForSession(SESSION_B);
      const stopB = await (toolB as any).execute({
        action: "stop",
        delegationId: delIdA,
      });
      expect(stopB.success).toBe(false);
      expect(stopB.error).toContain("not found");

      // Delegation is still alive — Session A can still observe it
      expect(activeDelegations.has(delIdA)).toBe(true);
      const toolA = makeToolForSession(SESSION_A);
      const observeA = await (toolA as any).execute({
        action: "observe",
        delegationId: delIdA,
      });
      expect(observeA.success).toBe(true);
    });

    it("Session A can stop its own delegation", async () => {
      const delIdA = await startDelegationInSession(SESSION_A);

      const toolA = makeToolForSession(SESSION_A);
      const stopA = await (toolA as any).execute({
        action: "stop",
        delegationId: delIdA,
      });
      expect(stopA.success).toBe(true);
      expect(stopA.status).toBe("stopped");
      expect(activeDelegations.has(delIdA)).toBe(true);
      expect(activeDelegations.get(delIdA)?.terminalStatus).toBe("stopped");
    });
  });

  // ─── Continue ─────────────────────────────────────────────────────────────

  describe("continue", () => {
    it("Session B cannot continue a delegation created in Session A", async () => {
      const delIdA = await startDelegationInSession(SESSION_A);

      const toolB = makeToolForSession(SESSION_B);
      const contB = await (toolB as any).execute({
        action: "continue",
        delegationId: delIdA,
        followUpMessage: "Keep going from Session B",
      });
      expect(contB.success).toBe(false);
      expect(contB.error).toContain("not found");
    });

    it("Session A can continue its own delegation", async () => {
      const delIdA = await startDelegationInSession(SESSION_A);

      const toolA = makeToolForSession(SESSION_A);
      const contA = await (toolA as any).execute({
        action: "continue",
        delegationId: delIdA,
        followUpMessage: "Continue from Session A",
      });
      expect(contA.success).toBe(true);
    });
  });

  // ─── Answer ───────────────────────────────────────────────────────────────

  describe("answer", () => {
    it("Session B cannot answer a delegation created in Session A", async () => {
      const delIdA = await startDelegationInSession(SESSION_A);

      const toolB = makeToolForSession(SESSION_B);
      const ansB = await (toolB as any).execute({
        action: "answer",
        delegationId: delIdA,
        toolUseId: "toolu_123",
        answers: { question: "yes" },
      });
      expect(ansB.success).toBe(false);
      expect(ansB.error).toContain("not found");
    });
  });

  // ─── Resume (start + resume alias) ────────────────────────────────────────

  describe("resume alias (start + resume)", () => {
    it("Session B cannot resume a delegation created in Session A", async () => {
      const delIdA = await startDelegationInSession(SESSION_A);

      const toolB = makeToolForSession(SESSION_B);
      const resumed = await (toolB as any).execute({
        action: "start",
        resume: delIdA,
        task: "Resume from Session B",
      });
      expect(resumed.success).toBe(false);
      expect(resumed.error).toContain("not found");
    });
  });

  // ─── initiatorSessionId storage ───────────────────────────────────────────

  describe("initiatorSessionId storage", () => {
    it("stores initiatorSessionId on the delegation entry", async () => {
      const delIdA = await startDelegationInSession(SESSION_A);
      const delegation = activeDelegations.get(delIdA);
      expect(delegation).toBeDefined();
      expect(delegation!.initiatorSessionId).toBe(SESSION_A);
    });

    it("stores different initiatorSessionIds for delegations in different sessions", async () => {
      const delIdA = await startDelegationInSession(SESSION_A);
      const delIdB = await startDelegationInSession(SESSION_B);

      const delA = activeDelegations.get(delIdA);
      const delB = activeDelegations.get(delIdB);
      expect(delA!.initiatorSessionId).toBe(SESSION_A);
      expect(delB!.initiatorSessionId).toBe(SESSION_B);
    });
  });

  // ─── Accessor backward compatibility ──────────────────────────────────────

  describe("getActiveDelegationsForCharacter backward compatibility", () => {
    it("returns all delegations when initiatorSessionId is omitted", async () => {
      await startDelegationInSession(SESSION_A);
      await startDelegationInSession(SESSION_B);

      // No session filter — returns all
      const all = getActiveDelegationsForCharacter(AGENT_ID);
      expect(all).toHaveLength(2);
    });

    it("returns only matching delegations when initiatorSessionId is provided", async () => {
      await startDelegationInSession(SESSION_A);
      await startDelegationInSession(SESSION_B);

      const onlyA = getActiveDelegationsForCharacter(AGENT_ID, SESSION_A);
      expect(onlyA).toHaveLength(1);

      const onlyB = getActiveDelegationsForCharacter(AGENT_ID, SESSION_B);
      expect(onlyB).toHaveLength(1);

      // Different sessions, different delegations
      expect(onlyA[0].delegationId).not.toBe(onlyB[0].delegationId);
    });

    it("returns empty array for a session with no delegations", async () => {
      await startDelegationInSession(SESSION_A);

      const result = getActiveDelegationsForCharacter(AGENT_ID, "sess-nonexistent");
      expect(result).toHaveLength(0);
    });
  });

  // ─── delegations summary in tool responses ────────────────────────────────

  describe("delegations summary in tool responses", () => {
    it("tool error responses include only session-scoped delegations", async () => {
      await startDelegationInSession(SESSION_A);

      // Session B tries an invalid action — the delegations summary in the
      // error response should not include Session A's delegation.
      const toolB = makeToolForSession(SESSION_B);
      const result = await (toolB as any).execute({
        action: "start",
        agentName: "Worker Agent",
        // Missing task — should fail
      });
      expect(result.success).toBe(false);
      expect(result.delegations).toHaveLength(0);
    });

    it("start response includes only same-session delegations in summary", async () => {
      await startDelegationInSession(SESSION_A);

      // Start a new delegation in Session B
      const toolB = makeToolForSession(SESSION_B);
      const result = await (toolB as any).execute({
        action: "start",
        agentName: "Worker Agent",
        task: "Task from Session B",
        mode: "background",
      });
      expect(result.success).toBe(true);

      // The delegations summary should only contain Session B's delegation
      expect(result.delegations).toHaveLength(1);
      expect(result.delegations[0].delegationId).toBe(result.delegationId);
    });
  });

  // ─── Different agents, same session ID (non-interfering) ──────────────────

  describe("different agents are already isolated by characterId", () => {
    it("agent B cannot see agent A's delegations even with same sessionId", async () => {
      // Create delegation as agent-init
      const delId = await startDelegationInSession(SESSION_A);
      expect(activeDelegations.get(delId)!.delegatorId).toBe(AGENT_ID);

      // Query with a different characterId — should be empty
      const result = getActiveDelegationsForCharacter("agent-other", SESSION_A);
      expect(result).toHaveLength(0);
    });
  });
});
