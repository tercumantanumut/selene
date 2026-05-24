import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  createMessage: vi.fn(),
  updateMessage: vi.fn(),
  getSession: vi.fn(),
  getOrCreateLocalUser: vi.fn(),
  updateSession: vi.fn(),
  deleteMessagesNotIn: vi.fn(),
  getInjectedMessageIds: vi.fn(),
  getSessionWithMessages: vi.fn(),
}));

const contextWindowMocks = vi.hoisted(() => ({
  ContextWindowManager: {
    preFlightCheck: vi.fn(),
    getStatusMessage: vi.fn(() => "Context usage: 10/276K"),
  },
  isDelegatedToolName: vi.fn(() => false),
}));

const messagePrepMocks = vi.hoisted(() => ({
  prepareMessagesForRequest: vi.fn(),
}));

const streamTextMocks = vi.hoisted(() => ({
  streamText: vi.fn(),
  createUIMessageStreamResponse: vi.fn((args: { stream?: ReadableStream }) =>
    new Response(args.stream ?? "ok", { status: 200 })
  ),
  jsonSchema: vi.fn((schema: unknown) => schema),
  tool: vi.fn((definition: unknown) => definition),
  wrapLanguageModel: vi.fn((args: { model: unknown }) => args.model),
}));

vi.mock("ai", () => streamTextMocks);
vi.mock("@/lib/db/queries", () => dbMocks);
vi.mock("@/lib/context-window", () => contextWindowMocks);
vi.mock("@/app/api/chat/message-prep", () => messagePrepMocks);
vi.mock("@/lib/auth/local-auth", () => ({ requireAuth: vi.fn(async () => "local-user") }));
vi.mock("@/lib/settings/settings-manager", () => ({
  loadSettings: vi.fn(() => ({
    localUserEmail: "local@example.com",
    llmProvider: "codex",
    chatModel: "gpt-5.5-high",
    toolLoadingMode: "deferred",
    devWorkspaceEnabled: false,
  })),
}));
vi.mock("@/lib/ai/session-model-resolver", () => ({
  getSessionDisplayNameForSession: vi.fn(() => "Codex"),
  getSessionProviderTemperatureForSession: vi.fn(() => undefined),
  resolveSessionLanguageModelForSession: vi.fn(async () => ({ modelId: "gpt-5.5-high" })),
  resolveSessionModelScopeForSession: vi.fn(async () => ({
    effectiveConfig: {
      provider: "codex",
      chatModel: "gpt-5.5-high",
      researchModel: "gpt-5.5-high",
      visionModel: "gpt-5.5-high",
      utilityModel: "gpt-5.5-high",
      transcriberModel: "gpt-5.5-high",
    },
    sources: {},
    sessionConfig: null,
    agentConfig: null,
    globalConfig: { provider: "codex" },
  })),
  resolveSessionVisionModelForSession: vi.fn(async () => ({ modelId: "vision" })),
}));
vi.mock("@/app/api/chat/system-prompt-builder", () => ({
  buildSystemPromptForRequest: vi.fn(async () => ({
    systemPromptValue: "system",
    characterAvatarUrl: null,
    characterAppearanceDescription: null,
    enabledTools: [],
  })),
}));
vi.mock("@/app/api/chat/tools-builder", () => ({
  buildToolsForRequest: vi.fn(async () => ({
    allToolsWithMCP: {},
    initialActiveToolNames: [],
    hasStopHooks: false,
    discoveredTools: [],
    initialActiveTools: {},
    enabledMcpServers: [],
    enabledMcpTools: [],
    alwaysLoadMcpToolIds: [],
  })),
}));
vi.mock("@/lib/ai/providers", () => ({
  ensureAntigravityTokenValid: vi.fn(async () => true),
  ensureClaudeCodeTokenValid: vi.fn(async () => true),
  ensureCodexTokenValid: vi.fn(async () => true),
  ensureKimiTokenValid: vi.fn(async () => true),
  providerSupportsFeature: vi.fn(() => false),
}));
vi.mock("@/lib/ai/config", () => ({ AI_CONFIG: { maxSteps: 1 } }));
vi.mock("@/lib/vectordb/sync-folder-crud", () => ({ getPrimarySyncFolder: vi.fn(async () => null) }));
vi.mock("@/lib/ai/cache/config", () => ({ shouldUseCache: vi.fn(() => false) }));
vi.mock("@/lib/ai/cache/message-cache", () => ({ applyCacheToMessages: vi.fn((messages) => messages), estimateCacheSavings: vi.fn(() => 0) }));
vi.mock("@/lib/ai/title-generator", () => ({ generateSessionTitle: vi.fn() }));
vi.mock("@/lib/ai/truncated-content-store", () => ({ sessionHasTruncatedContent: vi.fn(async () => false) }));
vi.mock("@/lib/background-tasks/registry", () => ({ taskRegistry: { get: vi.fn(() => null), register: vi.fn(), updateStatus: vi.fn() } }));
vi.mock("@/lib/background-tasks/chat-abort-registry", () => ({ registerChatAbortController: vi.fn(), removeChatAbortController: vi.fn() }));
vi.mock("@/lib/background-tasks/live-prompt-queue-registry", () => ({
  createLivePromptQueue: vi.fn(),
  drainLivePromptQueue: vi.fn(() => []),
  removeLivePromptQueue: vi.fn(),
  waitForQueueMessage: vi.fn(),
  reserveLivePromptQueueBySession: vi.fn(),
  promoteLivePromptQueueToRunId: vi.fn(),
  clearLivePromptQueueBySession: vi.fn(),
  getLivePromptQueueKeyBySession: vi.fn(),
}));
vi.mock("@/lib/background-tasks/live-prompt-helpers", () => ({ buildUserInjectionContent: vi.fn(), buildStopSystemMessage: vi.fn() }));
vi.mock("@/lib/ai/tools/delegation-completion-store", () => ({ drainDelegationCompletions: vi.fn(() => []) }));
vi.mock("@/lib/utils/heartbeat-stream", () => ({
  createHeartbeatStream: vi.fn(() => new TransformStream()),
}));
vi.mock("@/lib/ai/retry/stream-recovery", () => ({
  classifyRecoverability: vi.fn(),
  getBackoffDelayMs: vi.fn(() => 0),
  normalizeStreamError: vi.fn((error) => error),
  shouldRetry: vi.fn(() => false),
  sleepWithAbort: vi.fn(),
}));
vi.mock("@/lib/utils/timestamp", () => ({ nowISO: vi.fn(() => "2026-01-01T00:00:00.000Z") }));
vi.mock("@/lib/messages/converter", () => ({
  convertDBMessagesToUIMessages: vi.fn((messages) =>
    messages.map((message: { id: string; role: string; content: unknown }) => ({
      id: message.id,
      role: message.role,
      parts: Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content ?? "") }],
    }))
  ),
}));
vi.mock("@/lib/observability", () => ({
  withRunContext: vi.fn(async (_runId, fn) => fn()),
  createAgentRun: vi.fn(async () => ({ id: "run-1" })),
  completeAgentRun: vi.fn(),
  appendRunEvent: vi.fn(),
  initializeToolEventHandler: vi.fn(),
}));
vi.mock("@/lib/session/message-ordering", () => ({ nextOrderingIndex: vi.fn(async () => 1) }));
vi.mock("@/lib/plugins/registry", () => ({ getEnabledPluginsForAgent: vi.fn(async () => []), getInstalledPlugins: vi.fn(async () => []), loadPluginHooks: vi.fn(() => 0) }));
vi.mock("@/lib/agents/workflows", () => ({ getWorkflowByAgentId: vi.fn(async () => null) }));
vi.mock("@/lib/agents/workflow-resource-context", () => ({ getWorkflowResources: vi.fn(async () => ({})) }));
vi.mock("@/lib/config/internal-api-secret", () => ({ INTERNAL_API_SECRET: "secret" }));
vi.mock("@/app/api/chat/context-injection", () => ({
  shouldInjectContext: vi.fn(() => false),
  getContextInjectionTracking: vi.fn(() => ({})),
  getDiscoveredToolsFromMessages: vi.fn(() => []),
  getDiscoveredToolsFromMetadata: vi.fn(() => []),
  isValidIanaTimezone: vi.fn(() => false),
  resolvePluginRootMap: vi.fn(async () => ({})),
}));
vi.mock("@/app/api/chat/content-extractor", () => ({ extractContent: vi.fn(async (message) => message.content ?? message.parts ?? "") }));
vi.mock("@/app/api/chat/content-sanitizer", () => ({ stripPasteDelimitersFromMessage: vi.fn((content) => content) }));
vi.mock("@/app/api/chat/streaming-state", () => ({
  appendTextPartToState: vi.fn(),
  appendReasoningPartToState: vi.fn(),
  recordToolInputStart: vi.fn(),
  recordToolInputDelta: vi.fn(),
  recordStructuredToolCall: vi.fn(),
  recordToolResultChunk: vi.fn(),
  finalizeStreamingToolCalls: vi.fn(),
  sealDanglingToolCalls: vi.fn(),
}));
vi.mock("@/app/api/chat/canonical-content", () => ({ shouldTreatStreamErrorAsCancellation: vi.fn(() => false) }));
vi.mock("@/app/api/chat/stream-callbacks", () => ({ createOnFinishCallback: vi.fn(() => vi.fn()), createOnAbortCallback: vi.fn(() => vi.fn()), handleUndrainedQueueMessages: vi.fn() }));
vi.mock("@/app/api/chat/streaming-progress", () => ({ createSyncStreamingMessage: vi.fn(() => vi.fn(async () => undefined)) }));
vi.mock("@/lib/ai/providers/mcp-context-store", () => ({ mcpContextStore: { run: vi.fn((_ctx, fn) => fn()) } }));
vi.mock("@/app/api/chat/tool-schema-recovery", () => ({ disableToolForSchemaRecovery: vi.fn(), parseInvalidToolSchemaError: vi.fn(() => null) }));
vi.mock("@/app/api/chat/delegation-scope-tagging", () => ({ tagIntermediateDelegationParts: vi.fn((parts) => parts) }));
vi.mock("@/app/api/chat/delegation-waiting", () => ({ shouldStopTurn: vi.fn(() => false), hasRunningDelegationsForSession: vi.fn(() => false), hasRunningBackgroundTasksForSession: vi.fn(() => false), hasActiveAsyncWork: vi.fn(() => false) }));
vi.mock("@/lib/ai/streaming/think-tag-filter", () => ({ createThinkTagFilter: vi.fn(() => ({ transform: vi.fn((chunk) => chunk) })), shouldFilterThinkTags: vi.fn(() => false) }));
vi.mock("@/lib/ai/utils/think-tag-stream", () => ({ thinkTagMiddleware: vi.fn(), hasThinkTags: vi.fn(() => false) }));
vi.mock("@/lib/ai/providers/ollama-capabilities", () => ({ ollamaModelSupportsThinking: vi.fn(() => false) }));
vi.mock("@/lib/emotion", () => ({ detectEmotion: vi.fn(async () => null) }));
vi.mock("@/app/api/chat/ui-stream-recovery", () => ({ isUiChunkCommittable: vi.fn(() => true), shouldAttemptPrecommitRecovery: vi.fn(() => false) }));

import { POST } from "@/app/api/chat/route";

describe("POST /api/chat compacted history request rebuild", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.getOrCreateLocalUser.mockResolvedValue({ id: "db-user" });
    dbMocks.getSession.mockResolvedValue({
      id: "session-1",
      userId: "db-user",
      metadata: { sessionProvider: "codex", sessionChatModel: "gpt-5.5-high" },
      summary: "compacted summary",
    });
    dbMocks.createMessage.mockResolvedValue({ id: "saved-user" });
    dbMocks.getInjectedMessageIds.mockResolvedValue([]);
    contextWindowMocks.ContextWindowManager.preFlightCheck.mockResolvedValue({
      canProceed: true,
      status: {
        status: "safe",
        currentTokens: 10_000,
        maxInputTokens: 276_000,
        maxTokens: 1_000_000,
        formatted: { current: "10.0K", max: "276.0K", percentage: "3.6%" },
      },
    });
    dbMocks.getSessionWithMessages.mockResolvedValue({
      session: { summary: "compacted summary" },
      messages: [
        { id: "old-user", sessionId: "session-1", role: "user", content: [{ type: "text", text: "old huge message" }], isCompacted: true },
        { id: "recent-user", sessionId: "session-1", role: "user", content: [{ type: "text", text: "recent persisted message" }], isCompacted: false },
      ],
    });
    messagePrepMocks.prepareMessagesForRequest.mockResolvedValue({
      coreMessages: [{ role: "user", content: "recent persisted message" }],
      enhancedMessages: [],
      droppedImagesForProvider: 0,
    });
    streamTextMocks.streamText.mockReturnValue({
      toUIMessageStream: () => new ReadableStream({ start(controller) { controller.close(); } }),
    });
  });

  it("rebuilds send-time messages from compacted DB state even when preflight did not compact again", async () => {
    const staleClientMessages = [
      { id: "old-user", role: "user", parts: [{ type: "text", text: "old huge message" }] },
      { id: "new-user", role: "user", parts: [{ type: "text", text: "next prompt" }] },
    ];

    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Id": "session-1",
      },
      body: JSON.stringify({ sessionId: "session-1", messages: staleClientMessages }),
    }));

    expect(response.status).toBe(200);
    expect(messagePrepMocks.prepareMessagesForRequest).toHaveBeenCalledTimes(1);
    expect(messagePrepMocks.prepareMessagesForRequest.mock.calls[0]?.[0]).toMatchObject({
      sessionSummary: "compacted summary",
    });
    const preparedMessages = messagePrepMocks.prepareMessagesForRequest.mock.calls[0]?.[0].messages;
    expect(preparedMessages).toHaveLength(1);
    expect(preparedMessages[0].id).toBe("recent-user");
  });
});
