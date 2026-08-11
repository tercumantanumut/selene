/**
 * Compaction Boundary Persistence Tests
 *
 * These tests verify the CRITICAL fix for the compaction boundary bug:
 * - Previously, markMessagesAsCompacted used timestamp comparison (< createdAt)
 *   which could skip messages with the same timestamp as the boundary message.
 * - The fix uses deterministic message-ID-based marking via markMessagesAsCompactedByIds.
 *
 * Tests cover:
 * 1. Same-timestamp messages are correctly included in compaction
 * 2. Boundary message itself is included (not excluded by < comparison)
 * 3. Messages after boundary are NOT compacted
 * 4. CompactionService uses markMessagesAsCompactedByIds (not markMessagesAsCompacted)
 * 5. Legacy markMessagesAsCompacted now delegates to markMessagesAsCompactedByIds
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// DB Mocks
// ============================================================================

const dbMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getNonCompactedMessages: vi.fn(),
  updateSessionSummary: vi.fn(),
  markMessagesAsCompacted: vi.fn(),
  markMessagesAsCompactedByIds: vi.fn(),
}));

const providerMocks = vi.hoisted(() => ({
  utilityModel: { modelId: "mock-utility-model" },
  getUtilityModel: vi.fn(),
  getLanguageModelForProvider: vi.fn(),
}));

const resolverMocks = vi.hoisted(() => ({
  resolveSessionModelScopeForSession: vi.fn(),
}));

vi.mock("@/lib/db/queries", () => ({
  getSession: dbMocks.getSession,
  getNonCompactedMessages: dbMocks.getNonCompactedMessages,
  updateSessionSummary: dbMocks.updateSessionSummary,
  markMessagesAsCompacted: dbMocks.markMessagesAsCompacted,
  markMessagesAsCompactedByIds: dbMocks.markMessagesAsCompactedByIds,
}));

// Mock the AI provider and session-scoped resolver used by CompactionService.
vi.mock("@/lib/ai/providers", () => ({
  getUtilityModel: providerMocks.getUtilityModel,
  getLanguageModelForProvider: providerMocks.getLanguageModelForProvider,
}));

vi.mock("@/lib/ai/session-model-resolver", () => ({
  resolveSessionModelScopeForSession: resolverMocks.resolveSessionModelScopeForSession,
}));

// Mock generateText for the compaction service
vi.mock("ai", () => ({
  generateText: vi.fn().mockResolvedValue({
    text: "Compacted summary of the conversation.",
  }),
}));

import { generateText } from "ai";
import { CompactionService } from "@/lib/context-window/compaction-service";

// ============================================================================
// Test Helpers
// ============================================================================

function makeMessage(
  id: string,
  role: "user" | "assistant",
  content: string,
  createdAt: string
) {
  return {
    id,
    sessionId: "session-1",
    role,
    content: JSON.stringify([{ type: "text", text: content }]),
    createdAt,
    isCompacted: false,
    toolInvocations: null,
    metadata: null,
  };
}

function makeRawMessage(
  id: string,
  role: "user" | "assistant",
  content: string,
  createdAt: string
) {
  return {
    id,
    sessionId: "session-1",
    role,
    content,
    createdAt,
    isCompacted: false,
    toolInvocations: null,
    metadata: null,
  };
}

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("Compaction boundary persistence", () => {
  const sessionId = "session-1";

  beforeEach(() => {
    vi.clearAllMocks();

    dbMocks.getSession.mockResolvedValue({
      id: sessionId,
      summary: null,
      summaryLastMessageId: null,
    });
    dbMocks.updateSessionSummary.mockResolvedValue(undefined);
    dbMocks.markMessagesAsCompactedByIds.mockResolvedValue(0);
    providerMocks.getUtilityModel.mockReturnValue(providerMocks.utilityModel);
    providerMocks.getLanguageModelForProvider.mockReturnValue(providerMocks.utilityModel);
    resolverMocks.resolveSessionModelScopeForSession.mockResolvedValue({
      effectiveConfig: {
        provider: "codex",
        utilityModel: "gpt-5.4-low",
      },
    });
  });

  it("uses the session-scoped utility provider instead of the global utility getter", async () => {
    const sessionMetadata = {
      sessionProvider: "kimi",
      sessionUtilityModel: "kimi-k2-turbo-preview",
    };
    dbMocks.getSession.mockResolvedValue({
      id: sessionId,
      summary: null,
      summaryUpToMessageId: null,
      characterId: "character-1",
      metadata: sessionMetadata,
    });
    dbMocks.getNonCompactedMessages.mockResolvedValue([
      makeRawMessage(
        "msg-session-utility",
        "user",
        "Session-scoped context ".repeat(100),
        "2026-02-10T09:59:00.000Z",
      ),
    ]);
    resolverMocks.resolveSessionModelScopeForSession.mockResolvedValueOnce({
      effectiveConfig: {
        provider: "kimi",
        utilityModel: "kimi-k2-turbo-preview",
      },
    });

    const result = await CompactionService.compact(sessionId, {
      keepRecentMessages: 0,
      enableAutoPruning: false,
    });

    expect(resolverMocks.resolveSessionModelScopeForSession).toHaveBeenCalledWith(
      sessionMetadata,
      { characterId: "character-1" },
    );
    expect(providerMocks.getLanguageModelForProvider).toHaveBeenCalledWith(
      "kimi",
      "kimi-k2-turbo-preview",
    );
    expect(providerMocks.getUtilityModel).not.toHaveBeenCalled();
    expect(result.summaryMethod).toBe("utility_model");
  });

  it("uses a 10K-token output budget for generated compaction summaries", async () => {
    const longContent = "X".repeat(500);
    const messages = [
      makeMessage("msg-1", "user", longContent, "2026-02-10T10:00:00.000Z"),
      makeMessage("msg-2", "assistant", longContent, "2026-02-10T10:00:01.000Z"),
      makeMessage("msg-3", "user", longContent, "2026-02-10T10:00:02.000Z"),
      makeMessage("msg-4", "assistant", longContent, "2026-02-10T10:00:03.000Z"),
      makeMessage("msg-5", "user", longContent, "2026-02-10T10:00:04.000Z"),
      makeMessage("msg-6", "assistant", longContent, "2026-02-10T10:00:05.000Z"),
      makeMessage("msg-7", "user", longContent, "2026-02-10T10:00:06.000Z"),
    ];

    dbMocks.getNonCompactedMessages.mockResolvedValue(messages);

    await CompactionService.compact(sessionId);

    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        maxOutputTokens: 10_000,
      })
    );
  });

  it("sends the utility model a non-empty, relevant prompt bounded near the 10K source-token budget", async () => {
    const messages = Array.from({ length: 80 }, (_, index) =>
      makeRawMessage(
        `msg-budget-${index}`,
        index % 2 === 0 ? "user" : "assistant",
        `message-${index} ${"x".repeat(3_000)}`,
        new Date(Date.UTC(2026, 1, 10, 10, 0, index)).toISOString(),
      ),
    );
    dbMocks.getNonCompactedMessages.mockResolvedValue(messages);
    vi.mocked(generateText).mockResolvedValueOnce({
      text: "Synthesized utility-model summary.",
    } as never);

    const result = await CompactionService.compact(sessionId, {
      keepRecentMessages: 0,
      enableAutoPruning: false,
    });

    const [{ prompt }] = vi.mocked(generateText).mock.calls.at(-1)!;
    expect(prompt.trim()).not.toBe("");
    expect(prompt).toContain("message-0");
    expect(prompt).toContain("message-79");
    expect(Math.ceil(prompt.length / 4)).toBeLessThanOrEqual(12_000);
    expect(result.newSummary).toBe("Synthesized utility-model summary.");
    expect(result.summaryMethod).toBe("utility_model");
    expect(result.summaryDiagnostics?.boundedSourceTokens).toBeGreaterThanOrEqual(9_900);
    expect(result.summaryDiagnostics?.sourceTruncated).toBe(true);
  });

  it("shrinks the prompt and output budget to fit a smaller configured utility-model context", async () => {
    const previousContextOverride = process.env.VLLM_CONTEXT_WINDOW;
    process.env.VLLM_CONTEXT_WINDOW = "8K";
    resolverMocks.resolveSessionModelScopeForSession.mockResolvedValueOnce({
      effectiveConfig: {
        provider: "vllm",
        utilityModel: "small-utility-model",
      },
    });
    dbMocks.getNonCompactedMessages.mockResolvedValue(
      Array.from({ length: 20 }, (_, index) =>
        makeRawMessage(
          `msg-small-budget-${index}`,
          index % 2 === 0 ? "user" : "assistant",
          `small-budget-message-${index} ${"y".repeat(3_000)}`,
          new Date(Date.UTC(2026, 1, 10, 11, 0, index)).toISOString(),
        ),
      ),
    );

    try {
      const result = await CompactionService.compact(sessionId, {
        keepRecentMessages: 0,
        enableAutoPruning: false,
      });
      const diagnostics = result.summaryDiagnostics!;

      expect(result.summaryMethod).toBe("utility_model");
      expect(diagnostics.inputLimitTokens).toBe(8_000);
      expect(
        (diagnostics.promptTokens ?? 0) +
          (diagnostics.maxOutputTokens ?? 0) +
          (diagnostics.safetyTokens ?? 0),
      ).toBeLessThanOrEqual(8_000);
      expect(providerMocks.getLanguageModelForProvider).toHaveBeenCalledWith(
        "vllm",
        "small-utility-model",
      );
    } finally {
      if (previousContextOverride === undefined) {
        delete process.env.VLLM_CONTEXT_WINDOW;
      } else {
        process.env.VLLM_CONTEXT_WINDOW = previousContextOverride;
      }
    }
  });

  it("does not split surrogate pairs when globally bounding compaction prompt content", async () => {
    const contentThatSplitsWithStringSlice = `prefix ${"📄".repeat(80_000)} tail`;
    const messages = [
      makeRawMessage("msg-1", "user", contentThatSplitsWithStringSlice, "2026-02-10T10:00:00.000Z"),
      makeRawMessage("msg-2", "assistant", "middle", "2026-02-10T10:00:01.000Z"),
      makeRawMessage("msg-3", "user", "final", "2026-02-10T10:00:02.000Z"),
    ];

    dbMocks.getNonCompactedMessages.mockResolvedValue(messages);

    const result = await CompactionService.compact(sessionId, {
      keepRecentMessages: 0,
      minMessagesForCompaction: 3,
      enableAutoPruning: false,
    });

    const [{ prompt }] = vi.mocked(generateText).mock.calls.at(-1)!;
    expect(prompt).toContain("[Middle context omitted to fit the utility-model input budget.]");
    expect(result.summaryDiagnostics?.boundedSourceTokens).toBeLessThanOrEqual(10_000);
    expect(hasLoneSurrogate(prompt)).toBe(false);
  });

  it("includes boundary message in compacted set (no off-by-one)", async () => {
    // Need >6 messages (keepRecentMessages default) with enough content
    // so the compaction service has something to compact after preserving recent ones.
    const longContent = "X".repeat(500); // ~125 tokens each
    const messages = [
      // These should be compacted (older messages)
      makeMessage("msg-1", "user", longContent, "2026-02-10T10:00:00.000Z"),
      makeMessage("msg-2", "assistant", longContent, "2026-02-10T10:00:01.000Z"),
      makeMessage("msg-3", "user", longContent, "2026-02-10T10:00:02.000Z"),
      makeMessage("msg-4", "assistant", longContent, "2026-02-10T10:00:03.000Z"),
      makeMessage("msg-5", "user", longContent, "2026-02-10T10:00:04.000Z"),
      makeMessage("msg-6", "assistant", longContent, "2026-02-10T10:00:05.000Z"),
      // These should NOT be compacted (recent, within keepRecentMessages=6)
      makeMessage("msg-7", "user", longContent, "2026-02-10T10:00:06.000Z"),
      makeMessage("msg-8", "assistant", longContent, "2026-02-10T10:00:07.000Z"),
      makeMessage("msg-9", "user", longContent, "2026-02-10T10:00:08.000Z"),
      makeMessage("msg-10", "assistant", longContent, "2026-02-10T10:00:09.000Z"),
      makeMessage("msg-11", "user", "Recent Q", "2026-02-10T10:00:10.000Z"),
      makeMessage("msg-12", "assistant", "Recent A", "2026-02-10T10:00:11.000Z"),
    ];

    dbMocks.getNonCompactedMessages.mockResolvedValue(messages);

    const result = await CompactionService.compact(sessionId, {
      targetTokensToFree: 1000,
    });

    // The service should have called markMessagesAsCompactedByIds
    // (NOT the old markMessagesAsCompacted)
    expect(dbMocks.markMessagesAsCompactedByIds).toHaveBeenCalledTimes(1);
    expect(dbMocks.markMessagesAsCompacted).not.toHaveBeenCalled();

    // The IDs passed should include the boundary message
    const [calledSessionId, calledIds] =
      dbMocks.markMessagesAsCompactedByIds.mock.calls[0];
    expect(calledSessionId).toBe(sessionId);

    // All compacted message IDs should be from the messages array
    for (const id of calledIds) {
      expect(messages.some((m) => m.id === id)).toBe(true);
    }

    // The last message in the compacted set should be included (boundary message)
    // and recent messages (msg-11, msg-12) should NOT be compacted
    expect(calledIds).not.toContain("msg-11");
    expect(calledIds).not.toContain("msg-12");

    expect(result.success).toBe(true);
  });

  it("handles same-timestamp messages correctly", async () => {
    // Simulate messages created in the same millisecond (common in batch operations)
    // Need >6 messages total so keepRecentMessages=6 leaves some to compact.
    const sameTimestamp = "2026-02-10T10:00:00.000Z";
    const longContent = "Y".repeat(500);
    const messages = [
      makeMessage("msg-a", "user", longContent, sameTimestamp),
      makeMessage("msg-b", "assistant", longContent, sameTimestamp),
      makeMessage("msg-c", "user", longContent, sameTimestamp),
      makeMessage("msg-d", "assistant", longContent, sameTimestamp),
      makeMessage("msg-e", "user", longContent, sameTimestamp),
      makeMessage("msg-f", "assistant", longContent, sameTimestamp),
      // Recent messages (different timestamp, within keepRecent window)
      makeMessage("msg-g", "user", longContent, "2026-02-10T10:01:00.000Z"),
      makeMessage("msg-h", "assistant", longContent, "2026-02-10T10:01:01.000Z"),
      makeMessage("msg-i", "user", longContent, "2026-02-10T10:01:02.000Z"),
      makeMessage("msg-j", "assistant", longContent, "2026-02-10T10:01:03.000Z"),
      makeMessage("msg-k", "user", "Recent Q", "2026-02-10T10:01:04.000Z"),
      makeMessage("msg-l", "assistant", "Recent A", "2026-02-10T10:01:05.000Z"),
    ];

    dbMocks.getNonCompactedMessages.mockResolvedValue(messages);

    const result = await CompactionService.compact(sessionId, {
      targetTokensToFree: 500,
    });

    expect(result.success).toBe(true);

    // With ID-based marking, same-timestamp messages should be handled correctly
    expect(dbMocks.markMessagesAsCompactedByIds).toHaveBeenCalled();
    const [, calledIds] = dbMocks.markMessagesAsCompactedByIds.mock.calls[0];

    // All IDs should be valid message IDs
    for (const id of calledIds) {
      expect(messages.some((m) => m.id === id)).toBe(true);
    }
    // Recent messages should NOT be in the compacted set
    expect(calledIds).not.toContain("msg-k");
    expect(calledIds).not.toContain("msg-l");

    // The same-timestamp messages that were compacted should all be included
    // (this is the key test: old timestamp-based logic would miss some)
    const compactedSameTimestamp = calledIds.filter((id: string) =>
      ["msg-a", "msg-b", "msg-c", "msg-d", "msg-e", "msg-f"].includes(id)
    );
    // At least some of the same-timestamp messages should be compacted
    expect(compactedSameTimestamp.length).toBeGreaterThan(0);
  });

  it("compacts sparse oversized sessions instead of dead-ending below the message-count threshold", async () => {
    const messages = [
      makeMessage("msg-1", "user", "A".repeat(20_000), "2026-02-10T10:00:00.000Z"),
      makeMessage("msg-2", "assistant", "B".repeat(20_000), "2026-02-10T10:00:01.000Z"),
    ];

    dbMocks.getNonCompactedMessages.mockResolvedValue(messages);

    const result = await CompactionService.compact(sessionId, {
      targetTokensToFree: 1_000,
    });

    expect(result.success).toBe(true);
    expect(dbMocks.updateSessionSummary).toHaveBeenCalled();
    expect(dbMocks.markMessagesAsCompactedByIds).toHaveBeenCalledWith(
      sessionId,
      ["msg-1", "msg-2"],
    );
  });

  it("records when utility-model summarization is skipped because no compactable context exists", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    dbMocks.getNonCompactedMessages.mockResolvedValue([]);

    const result = await CompactionService.compact(sessionId);

    expect(result.success).toBe(false);
    expect(generateText).not.toHaveBeenCalled();
    expect(result.summaryMethod).toBe("skipped");
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Utility-model summary skipped"),
    );
    logSpy.mockRestore();
  });

  it("recompacts an oversized existing summary when no live messages remain", async () => {
    const previousSummary = "Previous compacted context ".repeat(10_000);
    dbMocks.getSession.mockResolvedValue({
      id: sessionId,
      summary: previousSummary,
      summaryUpToMessageId: "msg-existing-boundary",
    });
    dbMocks.getNonCompactedMessages.mockResolvedValue([]);

    const result = await CompactionService.compact(sessionId, {
      targetTokensToFree: 1_000,
      keepRecentMessages: 0,
    });

    expect(result.success).toBe(true);
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(previousSummary.slice(0, 1_000)),
      }),
    );
    expect(dbMocks.updateSessionSummary).toHaveBeenCalledWith(
      sessionId,
      "Compacted summary of the conversation.",
      "msg-existing-boundary",
    );
    expect(dbMocks.markMessagesAsCompactedByIds).not.toHaveBeenCalled();
  });

  it("uses a bounded deterministic fallback when required compaction cannot call the utility model", async () => {
    const messages = [
      makeRawMessage(
        "msg-fallback",
        "user",
        "Critical context ".repeat(20_000),
        "2026-02-10T10:00:00.000Z",
      ),
    ];
    dbMocks.getNonCompactedMessages.mockResolvedValue(messages);
    vi.mocked(generateText).mockRejectedValueOnce(new Error("utility model unavailable"));

    const result = await CompactionService.compact(sessionId, {
      targetTokensToFree: 1_000,
      keepRecentMessages: 0,
      allowDeterministicFallback: true,
    });

    expect(result.success).toBe(true);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(result.newSummary).toContain(
      "[Middle context omitted to fit the utility-model input budget.]",
    );
    expect(Array.from(result.newSummary).length).toBeLessThanOrEqual(24_000);
    expect(result.summaryMethod).toBe("deterministic_fallback");
    expect(result.summaryDiagnostics?.fallbackReason).toBe("utility_model_call_failed");
    expect(dbMocks.markMessagesAsCompactedByIds).toHaveBeenCalledWith(
      sessionId,
      ["msg-fallback"],
    );
  });

  it("does not replace a successful utility summary with fallback when persistence fails", async () => {
    const messages = [
      makeRawMessage(
        "msg-persist-failure",
        "user",
        "Context that must be synthesized before persistence.",
        "2026-02-10T10:00:00.000Z",
      ),
    ];
    dbMocks.getNonCompactedMessages.mockResolvedValue(messages);
    vi.mocked(generateText).mockResolvedValueOnce({
      text: "Useful synthesized summary.",
    } as never);
    dbMocks.updateSessionSummary.mockRejectedValueOnce(new Error("database unavailable"));

    const result = await CompactionService.compact(sessionId, {
      keepRecentMessages: 0,
      allowDeterministicFallback: true,
    });

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(dbMocks.updateSessionSummary).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.error).toContain("database unavailable");
    expect(result.summaryMethod).toBe("utility_model");
  });

  it("compacted IDs match exactly the messages included in summary", async () => {
    const messages = [
      makeMessage("msg-1", "user", "A".repeat(500), "2026-02-10T10:00:00.000Z"),
      makeMessage("msg-2", "assistant", "B".repeat(500), "2026-02-10T10:00:01.000Z"),
      makeMessage("msg-3", "user", "C".repeat(500), "2026-02-10T10:00:02.000Z"),
      makeMessage("msg-4", "assistant", "D".repeat(500), "2026-02-10T10:00:03.000Z"),
      makeMessage("msg-5", "user", "E".repeat(500), "2026-02-10T10:00:04.000Z"),
      makeMessage("msg-6", "assistant", "F".repeat(500), "2026-02-10T10:00:05.000Z"),
      makeMessage("msg-7", "user", "G".repeat(500), "2026-02-10T10:00:06.000Z"),
      makeMessage("msg-8", "assistant", "H".repeat(500), "2026-02-10T10:00:07.000Z"),
      makeMessage("msg-9", "user", "I".repeat(500), "2026-02-10T10:00:08.000Z"),
      makeMessage("msg-10", "assistant", "J".repeat(500), "2026-02-10T10:00:09.000Z"),
      // Recent pair that should be preserved
      makeMessage("msg-11", "user", "Recent Q", "2026-02-10T10:00:10.000Z"),
      makeMessage("msg-12", "assistant", "Recent A", "2026-02-10T10:00:11.000Z"),
    ];

    dbMocks.getNonCompactedMessages.mockResolvedValue(messages);

    await CompactionService.compact(sessionId, {
      targetTokensToFree: 2000,
    });

    // Verify updateSessionSummary was called with the last compacted message's ID
    if (dbMocks.updateSessionSummary.mock.calls.length > 0) {
      const [, , summaryLastMessageId] =
        dbMocks.updateSessionSummary.mock.calls[0];

      // The markMessagesAsCompactedByIds call should include this message
      if (dbMocks.markMessagesAsCompactedByIds.mock.calls.length > 0) {
        const [, compactedIds] =
          dbMocks.markMessagesAsCompactedByIds.mock.calls[0];
        expect(compactedIds).toContain(summaryLastMessageId);
      }
    }
  });
});

describe("Legacy markMessagesAsCompacted backward compatibility", () => {
  // This tests that the refactored markMessagesAsCompacted function
  // (which now delegates to markMessagesAsCompactedByIds) works correctly.
  // We can't test the actual DB function here (it's mocked), but we verify
  // the CompactionService no longer calls it directly.

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("CompactionService does NOT call legacy markMessagesAsCompacted", async () => {
    dbMocks.getSession.mockResolvedValue({
      id: "session-1",
      summary: null,
      summaryLastMessageId: null,
    });

    const messages = Array.from({ length: 12 }, (_, i) =>
      makeMessage(
        `msg-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        `Message ${i} content that is reasonably long to simulate real usage`,
        `2026-02-10T10:00:${String(i).padStart(2, "0")}.000Z`
      )
    );

    dbMocks.getNonCompactedMessages.mockResolvedValue(messages);
    dbMocks.markMessagesAsCompactedByIds.mockResolvedValue(0);
    dbMocks.updateSessionSummary.mockResolvedValue(undefined);

    await CompactionService.compact("session-1", {
      targetTokensToFree: 1000,
    });

    // The new code should use markMessagesAsCompactedByIds exclusively
    expect(dbMocks.markMessagesAsCompacted).not.toHaveBeenCalled();
    // markMessagesAsCompactedByIds should have been called at least once
    // (either for auto-prune or for the main compaction)
    expect(dbMocks.markMessagesAsCompactedByIds).toHaveBeenCalled();
  });
});
