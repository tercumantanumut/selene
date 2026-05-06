import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createMessage: vi.fn(),
  updateMessage: vi.fn(),
  emitProgress: vi.fn(),
  limitProgressContent: vi.fn(() => null),
  nextOrderingIndex: vi.fn(async () => 1),
}));

vi.mock("@/lib/db/queries", () => ({
  createMessage: mocks.createMessage,
  updateMessage: mocks.updateMessage,
}));

vi.mock("@/lib/background-tasks/registry", () => ({
  taskRegistry: {
    emitProgress: mocks.emitProgress,
  },
}));

vi.mock("@/lib/background-tasks/progress-content-limiter", () => ({
  limitProgressContent: mocks.limitProgressContent,
}));

vi.mock("@/lib/session/message-ordering", () => ({
  nextOrderingIndex: mocks.nextOrderingIndex,
}));

import { createSyncStreamingMessage } from "@/app/api/chat/streaming-progress";
import type { StreamingMessageState } from "@/app/api/chat/streaming-state";
import type { DBContentPart } from "@/lib/messages/converter";

const leakedPlanningText =
  "I need continue with actual tools available names. Only commentary tools under functions.* not tool. Need sequential edits. Must read current files before edit. Need use editFile and run tests. Let's implement carefully. Need add setting to app/settings/settings-types FormState.";

const exactNamespaceLeakText =
  "Need use actual tool names weird transcript says functions.tool due maybe alias? Need continue. Read route.";

function makeState(parts: DBContentPart[]): StreamingMessageState {
  return {
    parts,
    toolCallParts: new Map(),
    loggedIncompleteToolCalls: new Set(),
    messageId: "msg-1",
    lastBroadcastAt: 0,
    lastBroadcastSignature: "",
  };
}

describe("createSyncStreamingMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateMessage.mockResolvedValue(undefined);
    mocks.createMessage.mockResolvedValue({ id: "msg-1" });
  });

  it("filters leaked internal planning text from persisted and emitted progress content", async () => {
    const streamingState = makeState([
      { type: "text", text: leakedPlanningText },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "editFile",
        args: { filePath: "route.ts" },
        state: "input-available",
      },
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "editFile",
        result: { status: "success" },
        status: "success",
        state: "output-available",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const syncStreamingMessage = createSyncStreamingMessage({
      sessionId: "session-1",
      userId: "user-1",
      eventCharacterId: "char-1",
      scheduledRunId: null,
      scheduledTaskId: null,
      scheduledTaskName: null,
      getAgentRunId: () => "run-1",
      streamingState,
      getAssistantMessageId: () => "msg-1",
    });

    await syncStreamingMessage(true);

    expect(mocks.updateMessage).toHaveBeenCalledTimes(1);
    const persistedContent = mocks.updateMessage.mock.calls[0]?.[1]?.content as DBContentPart[];
    expect(persistedContent).toEqual([
      expect.objectContaining({ type: "tool-call", toolCallId: "call-1" }),
      expect.objectContaining({ type: "tool-result", toolCallId: "call-1" }),
    ]);
    expect(persistedContent.some((part) => part.type === "text")).toBe(false);

    expect(mocks.emitProgress).toHaveBeenCalledTimes(1);
    expect(mocks.emitProgress.mock.calls[0]?.[1]).toBe("Running editFile...");

    const progressContent = mocks.emitProgress.mock.calls[0]?.[3]?.progressContent as DBContentPart[];
    expect(progressContent.some((part) => part.type === "text")).toBe(false);
  });

  it("preserves normal assistant text in progress content", async () => {
    const assistantText = "I checked the file and applied the patch.";
    const streamingState = makeState([
      { type: "text", text: assistantText },
      {
        type: "tool-call",
        toolCallId: "call-2",
        toolName: "editFile",
        args: { filePath: "route.ts" },
        state: "input-available",
      },
      {
        type: "tool-result",
        toolCallId: "call-2",
        toolName: "editFile",
        result: { status: "success" },
        status: "success",
        state: "output-available",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const syncStreamingMessage = createSyncStreamingMessage({
      sessionId: "session-1",
      userId: "user-1",
      eventCharacterId: "char-1",
      scheduledRunId: null,
      scheduledTaskId: null,
      scheduledTaskName: null,
      getAgentRunId: () => "run-2",
      streamingState,
      getAssistantMessageId: () => "msg-1",
    });

    await syncStreamingMessage(true);

    const persistedContent = mocks.updateMessage.mock.calls[0]?.[1]?.content as DBContentPart[];
    expect(persistedContent).toEqual([
      { type: "text", text: assistantText },
      expect.objectContaining({ type: "tool-call", toolCallId: "call-2" }),
      expect.objectContaining({ type: "tool-result", toolCallId: "call-2" }),
    ]);

    const progressContent = mocks.emitProgress.mock.calls[0]?.[3]?.progressContent as DBContentPart[];
    expect(progressContent[0]).toEqual({ type: "text", text: assistantText });
  });

  it("replaces exact leaked namespace planning text with generic progress when no tool part exists yet", async () => {
    const streamingState = makeState([{ type: "text", text: exactNamespaceLeakText }]);

    const syncStreamingMessage = createSyncStreamingMessage({
      sessionId: "session-1",
      userId: "user-1",
      eventCharacterId: "char-1",
      scheduledRunId: null,
      scheduledTaskId: null,
      scheduledTaskName: null,
      getAgentRunId: () => "run-3",
      streamingState,
      getAssistantMessageId: () => "msg-1",
    });

    await syncStreamingMessage(true);

    const persistedContent = mocks.updateMessage.mock.calls[0]?.[1]?.content as DBContentPart[];
    expect(persistedContent).toEqual([{ type: "text", text: "Working..." }]);

    expect(mocks.emitProgress.mock.calls[0]?.[1]).toBe("Working...");
    const progressContent = mocks.emitProgress.mock.calls[0]?.[3]?.progressContent as DBContentPart[];
    expect(progressContent).toEqual([{ type: "text", text: "Working..." }]);
  });
});
