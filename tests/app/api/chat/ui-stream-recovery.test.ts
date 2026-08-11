import { describe, expect, it } from "vitest";

import {
  hasPersistedStreamingProgress,
  isUiChunkCommittable,
  isUiFinishErrorChunk,
  shouldAttemptPrecommitRecovery,
} from "@/app/api/chat/ui-stream-recovery";

describe("ui-stream-recovery helpers", () => {
  it("treats only non-visible setup chunks as non-committing", () => {
    expect(isUiChunkCommittable({ type: "start" } as any)).toBe(false);
    expect(isUiChunkCommittable({ type: "text-start", id: "t1" } as any)).toBe(false);
    expect(isUiChunkCommittable({ type: "message-metadata", messageMetadata: {} } as any)).toBe(false);
    expect(isUiChunkCommittable({ type: "text-delta", id: "t1", delta: "hello" } as any)).toBe(true);
    expect(isUiChunkCommittable({ type: "tool-input-start", toolCallId: "c1", toolName: "searchTools" } as any)).toBe(true);
  });

  it("only treats a persisted assistant message id as committed DB progress", () => {
    expect(hasPersistedStreamingProgress(undefined)).toBe(false);
    expect(hasPersistedStreamingProgress({ messageId: undefined, parts: [] } as any)).toBe(false);
    expect(hasPersistedStreamingProgress({ messageId: undefined, parts: [{ type: "text", text: "buffered only" }] } as any)).toBe(false);
    expect(hasPersistedStreamingProgress({ messageId: "assistant-1", parts: [] } as any)).toBe(true);
  });

  it("detects finishReason error chunks as pre-commit failures", () => {
    expect(isUiFinishErrorChunk({ type: "finish", finishReason: "error" } as any)).toBe(true);
    expect(isUiFinishErrorChunk({ type: "finish", finishReason: "stop" } as any)).toBe(false);
    expect(isUiFinishErrorChunk({ type: "finish-step" } as any)).toBe(false);
  });

  it("retries recoverable pre-commit failures before anything is committed", () => {
    const decision = shouldAttemptPrecommitRecovery({
      provider: "codex",
      errorMessage: "server_error: stream interrupted",
      attempt: 0,
      maxAttempts: 2,
      aborted: false,
      clientCommitted: false,
      streamingState: { messageId: undefined, parts: [] } as any,
    });

    expect(decision.classification.recoverable).toBe(true);
    expect(decision.retry).toBe(true);
  });

  it("retries Codex overload failures before anything is committed", () => {
    const decision = shouldAttemptPrecommitRecovery({
      provider: "codex",
      errorMessage: "Our servers are currently overloaded. Please try again later.",
      attempt: 0,
      maxAttempts: 2,
      aborted: false,
      clientCommitted: false,
      streamingState: { messageId: undefined, parts: [] } as any,
    });

    expect(decision.classification.recoverable).toBe(true);
    expect(decision.classification.reason).toBe("provider_overloaded");
    expect(decision.retry).toBe(true);
  });

  it("retries finishReason error failures before anything is committed", () => {
    const decision = shouldAttemptPrecommitRecovery({
      provider: "codex",
      error: {
        provider: "codex",
        code: "server_error",
        message: "Provider stream finished with finishReason=error before a UI error chunk",
        finishReason: "error",
      },
      errorMessage: "Provider stream finished with finishReason=error before a UI error chunk",
      attempt: 0,
      maxAttempts: 2,
      aborted: false,
      clientCommitted: false,
      streamingState: { messageId: undefined, parts: [] } as any,
    });

    expect(decision.classification.recoverable).toBe(true);
    expect(decision.retry).toBe(true);
  });

  it("does not retry once client-visible or persisted progress exists", () => {
    expect(
      shouldAttemptPrecommitRecovery({
        provider: "codex",
        errorMessage: "server_error: stream interrupted",
        attempt: 0,
        maxAttempts: 2,
        aborted: false,
        clientCommitted: true,
        streamingState: { messageId: undefined, parts: [] } as any,
      }).retry,
    ).toBe(false);

    expect(
      shouldAttemptPrecommitRecovery({
        provider: "codex",
        errorMessage: "server_error: stream interrupted",
        attempt: 0,
        maxAttempts: 2,
        aborted: false,
        clientCommitted: false,
        streamingState: { messageId: "assistant-1", parts: [] } as any,
      }).retry,
    ).toBe(false);
  });
});
