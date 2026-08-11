import type { UIMessageChunk } from "ai";

import {
  classifyRecoverability,
  shouldRetry,
  type RecoveryClassification,
} from "@/lib/ai/retry/stream-recovery";

import type { StreamingMessageState } from "./streaming-state";

const NON_COMMITTING_CHUNK_TYPES = new Set<UIMessageChunk["type"]>([
  "start",
  "finish",
  "message-metadata",
  "start-step",
  "finish-step",
  "text-start",
  "text-end",
]);

export function isUiChunkCommittable(chunk: UIMessageChunk): boolean {
  return !NON_COMMITTING_CHUNK_TYPES.has(chunk.type);
}

export function isUiFinishErrorChunk(chunk: UIMessageChunk): boolean {
  return chunk.type === "finish" && (chunk as { finishReason?: unknown }).finishReason === "error";
}

export function hasPersistedStreamingProgress(
  streamingState: Pick<StreamingMessageState, "parts" | "messageId"> | null | undefined,
): boolean {
  if (!streamingState) return false;
  return Boolean(streamingState.messageId);
}

export function shouldAttemptPrecommitRecovery(args: {
  provider: string;
  error: unknown;
  errorMessage: string;
  attempt: number;
  maxAttempts: number;
  aborted: boolean;
  clientCommitted: boolean;
  streamingState: Pick<StreamingMessageState, "parts" | "messageId"> | null | undefined;
}): { retry: boolean; classification: RecoveryClassification } {
  const {
    provider,
    error,
    errorMessage,
    attempt,
    maxAttempts,
    aborted,
    clientCommitted,
    streamingState,
  } = args;

  const classification = classifyRecoverability(
    error ?? { provider, message: errorMessage },
  );

  const retry = shouldRetry({
    classification,
    attempt,
    maxAttempts,
    aborted,
  }) && !clientCommitted && !hasPersistedStreamingProgress(streamingState);

  return { retry, classification };
}
