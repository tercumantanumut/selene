/**
 * streaming-progress.ts
 *
 * Factory for the `syncStreamingMessage` function used inside the POST handler.
 * This function persists the current streaming state to the database and emits
 * progress events to the background-task registry.
 */

import { createMessage, updateMessage } from "@/lib/db/queries";
import { taskRegistry } from "@/lib/background-tasks/registry";
import { limitProgressContent } from "@/lib/background-tasks/progress-content-limiter";
import { nextOrderingIndex } from "@/lib/session/message-ordering";
import { nowISO } from "@/lib/utils/timestamp";
import type { DBContentPart, DBToolCallPart } from "@/lib/messages/converter";
import { toDisplayToolName } from "@/lib/messages/tool-name-placeholder";
import { sanitizeAssistantOutputText } from "./content-sanitizer";
import {
  type StreamingMessageState,
  cloneContentParts,
  buildProgressSignature,
  extractTextFromParts,
} from "./streaming-state";
import { INTERACTIVE_TOOL_NAME_SET } from "@/lib/interactive-tools/constants";

function collectPersistedToolResultIds(parts: DBContentPart[]): Set<string> {
  const persistedToolResultIds = new Set<string>();
  for (const part of parts) {
    if (part.type === "tool-result" && typeof part.toolCallId === "string") {
      persistedToolResultIds.add(part.toolCallId);
    }
  }
  return persistedToolResultIds;
}

function emitDroppedToolCallTelemetry(
  streamingState: StreamingMessageState,
  part: DBToolCallPart,
  reason: "input-streaming" | "malformed-args" | "unresolved-no-result",
  persistedToolResultIds: Set<string>
): void {
  const toolCallId = part.toolCallId || "unknown-tool-call";
  const toolName = toDisplayToolName(part.toolName);
  const logKey = `drop:${reason}:${toolCallId}`;
  if (streamingState.loggedIncompleteToolCalls.has(logKey)) {
    return;
  }
  streamingState.loggedIncompleteToolCalls.add(logKey);

  console.warn("[CHAT API] Dropped unresolved projected tool call", {
    toolCallId,
    toolName,
    reason,
    state: part.state,
    hasArgs: part.args !== undefined,
    hasArgsText: typeof part.argsText === "string" && part.argsText.length > 0,
    argsTextLength: typeof part.argsText === "string" ? part.argsText.length : 0,
    hasResultPart: persistedToolResultIds.has(toolCallId),
    projection: "streaming-persistence",
  });
}

/**
 * Tool names that block SDK execution while waiting for user input.
 * These must be persisted to the DB even without a matching tool-result,
 * otherwise they vanish from the chat when the client reloads from DB
 * (background mode). See: https://github.com/seline/seline/issues/XXX
 */
const INTERACTIVE_TOOL_NAMES = INTERACTIVE_TOOL_NAME_SET;

function buildPendingToolCallProjection(
  part: DBToolCallPart,
  persistedToolResultIds: Set<string>,
): DBToolCallPart | null {
  // Guard: if a result already exists for this tool call, it is resolved —
  // never project it as pending/active. This prevents rehydration from
  // marking completed calls as active after stream persistence.
  if (persistedToolResultIds.has(part.toolCallId)) {
    return null;
  }

  const isFinalizedInputState = part.state === undefined || part.state === "input-available";
  if (!isFinalizedInputState) {
    return null;
  }

  if (part.args !== undefined) {
    return {
      ...part,
      state: part.state ?? "input-available",
      active: true,
      timestamp: part.timestamp ?? new Date().toISOString(),
    };
  }

  if (typeof part.argsText !== "string" || part.argsText.length === 0) {
    return null;
  }

  try {
    return {
      ...part,
      args: JSON.parse(part.argsText),
      state: "input-available",
      active: true,
      timestamp: part.timestamp ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function filterStreamingPartsForPersistence(
  streamingState: StreamingMessageState
): DBContentPart[] {
  const persistedToolResultIds = collectPersistedToolResultIds(streamingState.parts);

  const filteredParts: DBContentPart[] = [];

  for (const part of streamingState.parts) {
    if (part.type !== "tool-call") {
      filteredParts.push(part);
      continue;
    }

    const hasCompleteArgs = part.args !== undefined;
    const isStillStreaming = part.state === "input-streaming";

    // Interactive tools (AskUserQuestion, ExitPlanMode, AskFollowupQuestion) block
    // the SDK while waiting for user input. The SDK fires PreToolUse *before*
    // emitting content_block_stop, so args may not be complete yet when
    // filterStreamingPartsForPersistence is first called. We must persist them
    // early — as long as there's any argument content — so the UI shows the
    // pending question while the user is deciding. The non-result check below
    // is intentionally skipped for these tools.
    if (INTERACTIVE_TOOL_NAMES.has(part.toolName)) {
      const hasArgContent =
        hasCompleteArgs ||
        (typeof part.argsText === "string" && part.argsText.length > 0);
      if (hasArgContent) filteredParts.push(part);
      continue;
    }

    if (isStillStreaming && !hasCompleteArgs) {
      emitDroppedToolCallTelemetry(streamingState, part, "input-streaming", persistedToolResultIds);
      continue;
    }

    if (!hasCompleteArgs && part.argsText) {
      try {
        JSON.parse(part.argsText);
      } catch {
        emitDroppedToolCallTelemetry(streamingState, part, "malformed-args", persistedToolResultIds);
        continue;
      }
    }

    if (!persistedToolResultIds.has(part.toolCallId)) {
      const pendingProjection = buildPendingToolCallProjection(part, persistedToolResultIds);
      if (pendingProjection) {
        filteredParts.push(pendingProjection);
        continue;
      }

      emitDroppedToolCallTelemetry(
        streamingState,
        part,
        "unresolved-no-result",
        persistedToolResultIds,
      );
      continue;
    }

    filteredParts.push(part);
  }

  return filteredParts;
}

function buildProgressContentSnapshot(
  streamingState: StreamingMessageState,
  persistedParts: DBContentPart[]
): DBContentPart[] {
  const persistedToolResultIds = collectPersistedToolResultIds(streamingState.parts);

  return streamingState.parts.map((part) => {
    if (part.type !== "tool-call") {
      return part;
    }

    const isResolved = persistedToolResultIds.has(part.toolCallId);
    if (isResolved) {
      // Explicitly mark resolved calls as inactive so downstream consumers
      // (converter, tool UIs) never treat them as pending after rehydration.
      return { ...part, active: false };
    }

    const progressPart: DBToolCallPart = {
      ...part,
      active: true,
      timestamp: part.timestamp ?? new Date().toISOString(),
    };

    return progressPart;
  }).filter((part) => {
    if (part.type !== "tool-call") {
      return true;
    }

    if ((part as DBToolCallPart).active === true) {
      return true;
    }

    return persistedParts.some(
      (candidate) => candidate.type === "tool-call" && candidate.toolCallId === part.toolCallId
    );
  });
}

function hasToolCallLikeParts(parts: DBContentPart[]): boolean {
  return parts.some((part) => part.type === "tool-call" || part.type === "tool-result");
}

function sanitizeAssistantProgressParts(parts: DBContentPart[]): DBContentPart[] {
  const hasToolContext = hasToolCallLikeParts(parts);

  const sanitized: DBContentPart[] = [];
  for (const part of parts) {
    if (part.type !== "text") {
      sanitized.push(part);
      continue;
    }

    const cleanedText = sanitizeAssistantOutputText(part.text, {
      hasToolCallLikeParts: hasToolContext,
    });
    if (!cleanedText.trim()) {
      continue;
    }

    sanitized.push({ ...part, text: cleanedText });
  }

  return sanitized;
}

// Progress content limiter is now ON by default. Set env to "true" to disable.
const DISABLE_PROGRESS_CONTENT_LIMITER =
  process.env.DISABLE_PROGRESS_CONTENT_LIMITER === "true";

interface SyncStreamingMessageContext {
  sessionId: string;
  userId: string;
  eventCharacterId: string;
  scheduledRunId: string | null;
  scheduledTaskId: string | null;
  scheduledTaskName: string | null;
  /** Reference to the current agentRun — may be set after factory is called. */
  getAgentRunId: () => string | undefined;
  streamingState: StreamingMessageState;
  /**
   * Returns the assistant UUID that should be used when the next streaming DB
   * record is created. This allows live-prompt splits to rotate the frontend/DB
   * message ID so post-injection assistant segments do not reuse the original ID.
   */
  getAssistantMessageId?: () => string | undefined;
}

/**
 * Creates the `syncStreamingMessage(force?)` function.
 * The returned function is self-referencing (for deferred setTimeout calls),
 * so the factory returns the function directly rather than via an object.
 */
export function createSyncStreamingMessage(
  ctx: SyncStreamingMessageContext
): (force?: boolean) => Promise<void> {
  const {
    sessionId,
    userId,
    eventCharacterId,
    scheduledRunId,
    scheduledTaskId,
    scheduledTaskName,
    getAgentRunId,
    streamingState,
    getAssistantMessageId,
  } = ctx;

  const syncStreamingMessage = async (force = false): Promise<void> => {
    if (streamingState.parts.length === 0) return;

    let filteredParts = filterStreamingPartsForPersistence(streamingState);

    filteredParts = sanitizeAssistantProgressParts(filteredParts);

    if (filteredParts.length === 0 && streamingState.parts.length > 0) {
      filteredParts = [{ type: "text", text: "Working..." }];
    }

    const now = Date.now();
    const signature = buildProgressSignature(filteredParts);
    if (signature === streamingState.lastBroadcastSignature) return;

    if (!force) {
      const timeSinceLastBroadcast = now - streamingState.lastBroadcastAt;
      const hasToolChanges = filteredParts.some(
        (part) => part.type === "tool-call" || part.type === "tool-result"
      );
      const throttleInterval = hasToolChanges ? 400 : 200;
      if (timeSinceLastBroadcast < throttleInterval) {
        if (!streamingState.pendingBroadcast) {
          streamingState.pendingBroadcast = true;
          setTimeout(() => {
            if (streamingState.pendingBroadcast) {
              streamingState.pendingBroadcast = false;
              void syncStreamingMessage();
            }
          }, throttleInterval - timeSinceLastBroadcast);
        }
        return;
      }
    }

    streamingState.pendingBroadcast = false;
    const partsSnapshot = cloneContentParts(filteredParts);

    if (!streamingState.messageId) {
      if (streamingState.isCreating) return;
      streamingState.isCreating = true;
      try {
        const assistantMessageIndex = await nextOrderingIndex(sessionId);
        const assistantMessageId = getAssistantMessageId?.();
        const created = await createMessage({
          ...(assistantMessageId ? { id: assistantMessageId } : {}),
          sessionId,
          role: "assistant",
          content: partsSnapshot,
          orderingIndex: assistantMessageIndex,
          metadata: { isStreaming: true, scheduledRunId, scheduledTaskId },
        });
        streamingState.messageId = created?.id;
      } finally {
        streamingState.isCreating = false;
      }
    } else {
      await updateMessage(streamingState.messageId, { content: partsSnapshot });
    }

    if (streamingState.messageId) {
      streamingState.lastBroadcastSignature = signature;
      streamingState.lastBroadcastAt = now;
      let progressText = extractTextFromParts(partsSnapshot);
      if (!progressText) {
        for (let index = streamingState.parts.length - 1; index >= 0; index -= 1) {
          const part = streamingState.parts[index];
          if (part?.type === "tool-call") {
            progressText = `Running ${toDisplayToolName(part.toolName)}...`;
            break;
          }
        }
      }
      if (!progressText) progressText = "Working...";

      const agentRunId = getAgentRunId();
      const progressRunId = scheduledRunId ?? agentRunId;
      const progressType = scheduledRunId ? "scheduled" : agentRunId ? "chat" : undefined;
      const assistantMessageId = streamingState.messageId;

      console.log("[CHAT API] Progress event routing:", {
        scheduledRunId,
        agentRunId,
        progressRunId,
        progressType,
        assistantMessageId,
        progressText: progressText.slice(0, 50),
        willEmitToRegistry: Boolean(progressRunId && progressType),
      });

      if (progressRunId && progressType) {
        const rawProgressSnapshot = buildProgressContentSnapshot(streamingState, partsSnapshot);
        const progressSnapshot = sanitizeAssistantProgressParts(rawProgressSnapshot);

        // Strip argsText from tool-call parts before progress emission.
        // argsText is only needed for finalization, not for display, and can
        // be hundreds of KB from runaway model outputs.
        let strippedSnapshot = progressSnapshot.map((part) => {
          if (part.type === "tool-call" && "argsText" in part) {
            const { argsText: _strip, ...rest } = part as unknown as Record<string, unknown>;
            return rest as unknown as DBContentPart;
          }
          return part;
        });

        if (strippedSnapshot.length === 0) {
          strippedSnapshot = [{ type: "text", text: "Working..." }];
        }

        const progressLimit = DISABLE_PROGRESS_CONTENT_LIMITER
          ? null
          : limitProgressContent(strippedSnapshot);
        if (progressLimit?.wasTruncated) {
          console.log(
            `[CHAT API] Progress content truncated: ` +
              `~${progressLimit.originalTokens.toLocaleString()} -> ~${progressLimit.finalTokens.toLocaleString()} tokens` +
              (progressLimit.hardCapped ? " (hard cap summary applied)" : "")
          );
        }
        taskRegistry.emitProgress(progressRunId, progressText, undefined, {
          type: progressType,
          taskId: scheduledTaskId ?? undefined,
          taskName: scheduledTaskName ?? undefined,
          userId,
          characterId: eventCharacterId,
          sessionId,
          assistantMessageId,
          progressContent: (progressLimit?.content ?? strippedSnapshot) as DBContentPart[],
          progressContentLimited: progressLimit?.wasTruncated,
          progressContentOriginalTokens: progressLimit?.originalTokens,
          progressContentFinalTokens: progressLimit?.finalTokens,
          progressContentTruncatedParts: progressLimit?.truncatedParts,
          progressContentProjectionOnly: true,
          startedAt: nowISO(),
        });
      }
    }
  };

  return syncStreamingMessage;
}
