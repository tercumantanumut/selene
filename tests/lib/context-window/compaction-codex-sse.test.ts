import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getNonCompactedMessages: vi.fn(),
  updateSessionSummary: vi.fn(),
  markMessagesAsCompactedByIds: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  isCodexAuthenticated: vi.fn(() => true),
  getCodexAuthStatus: vi.fn(async () => ({ authenticated: true })),
}));

const sidecarMocks = vi.hoisted(() => ({
  ensureSidecarReady: vi.fn(async () => ({
    port: 8317,
    apiKey: "selene-test-key",
    baseUrl: "http://127.0.0.1:8317/v1",
  })),
  ensureCodexCredentialBridged: vi.fn(async () => null),
}));

vi.mock("@/lib/db/queries", () => ({
  getSession: dbMocks.getSession,
  getNonCompactedMessages: dbMocks.getNonCompactedMessages,
  updateSessionSummary: dbMocks.updateSessionSummary,
  markMessagesAsCompactedByIds: dbMocks.markMessagesAsCompactedByIds,
}));

vi.mock("@/lib/settings/settings-manager", () => ({
  loadSettings: vi.fn(() => ({
    llmProvider: "codex",
    chatModel: "gpt-5.4",
    researchModel: "gpt-5.4",
    visionModel: "gpt-5.4",
    utilityModel: "gpt-5.4-low",
  })),
  invalidateSettingsCache: vi.fn(),
}));

vi.mock("@/lib/auth/codex-auth", () => authMocks);

vi.mock("@/lib/ai/providers/cliproxy/config", () => ({
  ensureCliproxyConfig: vi.fn(() => ({ port: 8317, apiKey: "selene-test-key" })),
  getCliproxyBaseUrl: vi.fn((port: number) => `http://127.0.0.1:${port}/v1`),
}));

vi.mock("@/lib/ai/providers/cliproxy/sidecar", () => ({
  ensureSidecarReady: sidecarMocks.ensureSidecarReady,
}));

vi.mock("@/lib/ai/providers/cliproxy/codex-bridge", () => ({
  ensureCodexCredentialBridged: sidecarMocks.ensureCodexCredentialBridged,
}));

import { CompactionService } from "@/lib/context-window/compaction-service";

function makeMessage(index: number) {
  return {
    id: `msg-${index}`,
    sessionId: "session-codex-compact",
    role: index % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `Message ${index} ${"x".repeat(300)}` }],
    tokenCount: 100,
    isCompacted: false,
    createdAt: `2026-06-01T10:00:${String(index).padStart(2, "0")}.000Z`,
    updatedAt: `2026-06-01T10:00:${String(index).padStart(2, "0")}.000Z`,
    metadata: null,
  };
}

describe("CompactionService with Codex utility model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.getSession.mockResolvedValue({
      id: "session-codex-compact",
      summary: null,
      summaryLastMessageId: null,
    });
    dbMocks.getNonCompactedMessages.mockResolvedValue(
      Array.from({ length: 8 }, (_, index) => makeMessage(index)),
    );
    dbMocks.updateSessionSummary.mockResolvedValue(undefined);
    dbMocks.markMessagesAsCompactedByIds.mockResolvedValue(7);
    vi.unstubAllGlobals();
  });

  it("converts Codex SSE into JSON for non-streaming compaction summaries", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];

    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === "string") {
        requestBodies.push(JSON.parse(init.body) as Record<string, unknown>);
      }

      return new Response(
        "event: response.created\n" +
          "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_compact\",\"status\":\"in_progress\",\"output\":[]}}\n\n" +
          "event: response.done\n" +
          "data: {\"type\":\"response.done\",\"response\":{\"id\":\"resp_compact\",\"object\":\"response\",\"created_at\":0,\"model\":\"gpt-5.4\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"id\":\"msg_compact\",\"status\":\"completed\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Compacted summary from Codex SSE.\",\"annotations\":[]}]}],\"usage\":{\"input_tokens\":10,\"output_tokens\":5,\"total_tokens\":15,\"input_tokens_details\":{\"cached_tokens\":0},\"output_tokens_details\":{\"reasoning_tokens\":0}}}}\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }));

    const result = await CompactionService.compact("session-codex-compact", {
      keepRecentMessages: 1,
      minMessagesForCompaction: 3,
      enableAutoPruning: false,
    });

    expect(result.success).toBe(true);
    expect(result.newSummary).toBe("Compacted summary from Codex SSE.");
    expect(dbMocks.updateSessionSummary).toHaveBeenCalledWith(
      "session-codex-compact",
      "Compacted summary from Codex SSE.",
      "msg-6",
    );
    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]).toMatchObject({
      model: "gpt-5.4",
      stream: false,
      store: false,
    });
    expect(sidecarMocks.ensureSidecarReady).toHaveBeenCalled();
    expect(sidecarMocks.ensureCodexCredentialBridged).toHaveBeenCalled();
  });
});
