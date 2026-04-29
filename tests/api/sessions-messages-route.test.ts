import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  requireAuth: vi.fn(async () => "auth-user-1"),
}));

const settingsMocks = vi.hoisted(() => ({
  loadSettings: vi.fn(() => ({ localUserEmail: "local@example.com" })),
}));

const dbMocks = vi.hoisted(() => ({
  getSessionWithMessages: vi.fn(),
  updateMessage: vi.fn(async () => undefined),
  getOrCreateLocalUser: vi.fn(async () => ({ id: "db-user-1" })),
}));

const observabilityMocks = vi.hoisted(() => ({
  listAgentRunsBySession: vi.fn(),
}));

const delegationMocks = vi.hoisted(() => ({
  activeDelegations: new Map<string, { id: string; settled: boolean; sessionId: string }>(),
}));

vi.mock("@/lib/auth/local-auth", () => authMocks);
vi.mock("@/lib/settings/settings-manager", () => settingsMocks);
vi.mock("@/lib/db/queries", () => dbMocks);
vi.mock("@/lib/observability/queries", () => observabilityMocks);
vi.mock("@/lib/ai/tools/delegate-to-subagent-types", () => ({
  activeDelegations: delegationMocks.activeDelegations,
}));

import { GET, sealDanglingToolCallsInContent } from "@/app/api/sessions/[id]/messages/route";

describe("sealDanglingToolCallsInContent", () => {
  beforeEach(() => {
    delegationMocks.activeDelegations.clear();
  });

  it("keeps active delegated tool calls pending during message repair", () => {
    delegationMocks.activeDelegations.set("del-running", {
      id: "del-running",
      settled: false,
      sessionId: "sess-child-1",
    });

    const repaired = sealDanglingToolCallsInContent([
      {
        type: "tool-call",
        toolCallId: "delegate-running",
        toolName: "delegateToSubagent",
        args: { action: "start", delegationId: "del-running", agentId: "agent-1" },
        state: "input-available",
        active: true,
        timestamp: new Date().toISOString(),
      },
      {
        type: "tool-call",
        toolCallId: "delegate-finished",
        toolName: "delegateToSubagent",
        args: { action: "observe", delegationId: "del-finished" },
        state: "input-available",
      },
      {
        type: "tool-result",
        toolCallId: "delegate-finished",
        toolName: "delegateToSubagent",
        result: { completed: true, running: false },
        status: "success",
        state: "output-available",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ]);

    expect(repaired.changed).toBe(false);
    const content = repaired.content as Array<Record<string, unknown>>;
    expect(
      content.find((part) => part.type === "tool-result" && part.toolCallId === "delegate-running")
    ).toBeUndefined();
  });

  it("still seals inactive unresolved delegated tool calls", () => {
    const repaired = sealDanglingToolCallsInContent([
      {
        type: "tool-call",
        toolCallId: "delegate-inactive",
        toolName: "delegateToSubagent",
        args: { action: "start", delegationId: "del-missing", task: "work" },
        state: "input-available",
      },
    ]);

    expect(repaired.changed).toBe(true);
    const content = repaired.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[1]).toMatchObject({
      type: "tool-result",
      toolCallId: "delegate-inactive",
      status: "error",
      state: "output-error",
    });
  });
});

describe("GET /api/sessions/[id]/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delegationMocks.activeDelegations.clear();
    observabilityMocks.listAgentRunsBySession.mockResolvedValue([]);
  });

  it("does not rewrite active delegated calls to synthetic errors during refresh", async () => {
    delegationMocks.activeDelegations.set("del-running", {
      id: "del-running",
      settled: false,
      sessionId: "sess-child-1",
    });

    dbMocks.getSessionWithMessages.mockResolvedValue({
      session: { id: "session-1", userId: "db-user-1" },
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          metadata: {},
          content: [
            {
              type: "tool-call",
              toolCallId: "delegate-running",
              toolName: "delegateToSubagent",
              args: { action: "start", delegationId: "del-running", agentId: "agent-1" },
              state: "input-available",
              active: true,
              timestamp: new Date().toISOString(),
            },
            {
              type: "tool-call",
              toolCallId: "delegate-finished",
              toolName: "delegateToSubagent",
              args: { action: "observe", delegationId: "del-finished" },
              state: "input-available",
            },
            {
              type: "tool-result",
              toolCallId: "delegate-finished",
              toolName: "delegateToSubagent",
              result: { completed: true, running: false },
              status: "success",
              state: "output-available",
              timestamp: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      ],
    });

    const response = await GET(
      new Request("http://localhost/api/sessions/session-1/messages") as any,
      { params: Promise.resolve({ id: "session-1" }) }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    const content = body.messages[0].content as Array<Record<string, unknown>>;

    expect(
      content.find((part) => part.type === "tool-result" && part.toolCallId === "delegate-running")
    ).toBeUndefined();
    expect(dbMocks.updateMessage).not.toHaveBeenCalled();
  });

  it("repairs stale delegated projections during refresh", async () => {
    dbMocks.getSessionWithMessages.mockResolvedValue({
      session: { id: "session-1", userId: "db-user-1" },
      messages: [
        {
          id: "assistant-stale",
          role: "assistant",
          metadata: {},
          content: [
            {
              type: "tool-call",
              toolCallId: "delegate-stale",
              toolName: "delegateToSubagent",
              args: { action: "start", delegationId: "del-stale", agentId: "agent-1" },
              state: "input-available",
              active: true,
              timestamp: new Date(Date.now() - (8 * 24 * 60 * 60 * 1000)).toISOString(),
            },
          ],
        },
      ],
    });

    const response = await GET(
      new Request("http://localhost/api/sessions/session-1/messages") as any,
      { params: Promise.resolve({ id: "session-1" }) }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    const content = body.messages[0].content as Array<Record<string, unknown>>;

    expect(
      content.find((part) => part.type === "tool-result" && part.toolCallId === "delegate-stale")
    ).toMatchObject({
      type: "tool-result",
      toolCallId: "delegate-stale",
      status: "error",
      state: "output-error",
    });
    expect(dbMocks.updateMessage).toHaveBeenCalledOnce();
  });
});
