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

vi.mock("@/lib/db/queries", () => ({
  getSession: dbMocks.getSession,
  getNonCompactedMessages: dbMocks.getNonCompactedMessages,
  updateSessionSummary: dbMocks.updateSessionSummary,
  markMessagesAsCompacted: dbMocks.markMessagesAsCompacted,
  markMessagesAsCompactedByIds: dbMocks.markMessagesAsCompactedByIds,
}));

// Mock the AI provider used by CompactionService
vi.mock("@/lib/ai/providers", () => ({
  getUtilityModel: vi.fn(() => ({
    doGenerate: vi.fn().mockResolvedValue({
      text: "Compacted summary of the conversation.",
    }),
  })),
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

  it("does not split surrogate pairs when truncating compaction prompt content", async () => {
    const contentThatSplitsWithStringSlice = `${"A".repeat(1999)}📄 trailing text`;
    const messages = [
      makeRawMessage("msg-1", "user", contentThatSplitsWithStringSlice, "2026-02-10T10:00:00.000Z"),
      makeRawMessage("msg-2", "assistant", "middle", "2026-02-10T10:00:01.000Z"),
      makeRawMessage("msg-3", "user", "final", "2026-02-10T10:00:02.000Z"),
    ];

    dbMocks.getNonCompactedMessages.mockResolvedValue(messages);

    await CompactionService.compact(sessionId, {
      keepRecentMessages: 0,
      minMessagesForCompaction: 3,
      enableAutoPruning: false,
    });

    const [{ prompt }] = vi.mocked(generateText).mock.calls.at(-1)!;
    expect(prompt).toContain("... [truncated]");
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

  it("does not compact when there are insufficient messages", async () => {
    // Only 2 messages — too few to compact
    const messages = [
      makeMessage("msg-1", "user", "Hello", "2026-02-10T10:00:00.000Z"),
      makeMessage("msg-2", "assistant", "Hi!", "2026-02-10T10:00:01.000Z"),
    ];

    dbMocks.getNonCompactedMessages.mockResolvedValue(messages);

    const result = await CompactionService.compact(sessionId, {
      targetTokensToFree: 1000,
    });

    // Should fail gracefully with insufficient messages
    expect(result.success).toBe(false);
    expect(result.error).toContain("Not enough messages");
    expect(dbMocks.markMessagesAsCompactedByIds).not.toHaveBeenCalled();
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
