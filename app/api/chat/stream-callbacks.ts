/**
 * stream-callbacks.ts
 *
 * Factory functions for the onFinish and onAbort callbacks passed to streamText.
 * These callbacks handle saving messages, updating session metadata, triggering
 * memory extraction, completing agent runs, and channel delivery.
 */

import type { ModelMessage } from "ai";
import { AI_CONFIG } from "@/lib/ai/config";
import { createMessage, updateMessage, getSession, updateSession } from "@/lib/db/queries";
import type { CacheableSystemBlock } from "@/lib/ai/cache/types";
import {
  completeAgentRun,
  appendRunEvent,
} from "@/lib/observability";
import { triggerExtraction } from "@/lib/agent-memory";
import { deliverChannelReply } from "@/lib/channels/delivery";
import { taskRegistry } from "@/lib/background-tasks/registry";
import { removeChatAbortController } from "@/lib/background-tasks/chat-abort-registry";
import { removeLivePromptQueue, drainLivePromptQueue } from "@/lib/background-tasks/live-prompt-queue-registry";
import { signalUndrainedMessages } from "@/lib/background-tasks/undrained-signal";
import { nextOrderingIndex } from "@/lib/session/message-ordering";
import { addDelegationCompletion } from "@/lib/ai/tools/delegation-completion-store";
import { runStopHooks } from "@/lib/plugins/hook-integration";
import { buildInterruptionMessage, buildInterruptionMetadata } from "@/lib/messages/interruption";
import type { DBContentPart } from "@/lib/messages/converter";
import {
  type StepLike,
  buildCanonicalAssistantContentFromSteps,
  mergeCanonicalAssistantContent,
  countCanonicalTruncationMarkers,
  stubEphemeralToolResults,
} from "./canonical-content";
import { estimateMessageTokens } from "@/lib/utils";
import {
  finalizeStreamingToolCalls,
  sealDanglingToolCalls,
  type StreamingMessageState,
} from "./streaming-state";
import type { ContextInjectionTrackingMetadata } from "./context-injection";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Drain any messages that were queued for live-prompt injection but never
 * processed by prepareStep (e.g. run ended before a second step was reached).
 *
 * Delegation completion entries are moved to the persistent completion store
 * so the next turn's prepareStep can inject them. This enables the auto-resume
 * flow: delegation completes → result stored → frontend notified → new turn
 * drains the store and injects results.
 *
 * Non-delegation entries are PERSISTED as `user` rows (tagged
 * `livePromptInjected: true`) so they survive a page refresh and the frontend
 * auto-resume can replay them as a new run. Historically these were discarded
 * with only a `signalUndrainedMessages(sessionId)` ping, which caused the
 * in-session messages to disappear from history after the run finalized —
 * exactly the bug this patch fixes.
 *
 * The frontend still receives the undrained-signal so it can convert the
 * injected-live chips to "fallback" and kick off auto-resume; the only
 * behavior change is that the DB now retains the user's input.
 */
/** @internal - exported for tests only. */
export async function handleUndrainedQueueMessages(
  runId: string,
  sessionId: string,
): Promise<void> {
  const undrained = drainLivePromptQueue(runId);
  if (undrained.length === 0) return;

  const delegationEntries = undrained.filter(
    (e) => e.metadata?.kind === "delegation_completion",
  );
  const otherEntries = undrained.filter(
    (e) => e.metadata?.kind !== "delegation_completion",
  );

  // Move delegation results to the persistent completion store so the next
  // turn can pick them up via prepareStep, and signal the frontend to auto-resume.
  for (const entry of delegationEntries) {
    addDelegationCompletion({
      delegationId: entry.metadata?.delegationId || entry.id,
      delegateName: entry.metadata?.delegateName || "Sub-agent",
      sessionId: "",
      initiatorSessionId: sessionId,
      characterId: "",
      completedAt: Date.now(),
      resultContent: entry.content,
    });
  }

  // Persist non-delegation entries as user rows so they don't vanish after
  // refresh. Mirrors the `handleInjectedPromptsNonCC` persistence loop at
  // `lib/ai/streaming/injection-handler.ts:223-294`.
  for (const entry of otherEntries) {
    try {
      const orderingIndex = await nextOrderingIndex(sessionId);
      const promptCustom: Record<string, unknown> = {};
      if (entry.metadata?.inspectContext) {
        promptCustom.inspectContext = entry.metadata.inspectContext;
      }

      await createMessage({
        sessionId,
        role: "user",
        content: [{ type: "text", text: entry.content }],
        orderingIndex,
        metadata: {
          livePromptInjected: true,
          ...(entry.stopIntent ? { stopIntent: true } : {}),
          // Tag as undrained so operators can distinguish these from inline
          // injections that actually reached `prepareStep`.
          undrained: true,
          ...(Object.keys(promptCustom).length > 0
            ? { custom: promptCustom }
            : {}),
        },
      });
    } catch (dbError) {
      console.warn(
        "[CHAT API] Failed to persist undrained live-prompt entry:",
        dbError,
      );
    }
  }

  if (otherEntries.length > 0) {
    signalUndrainedMessages(sessionId);
  }
}

// ─── Context interface ────────────────────────────────────────────────────────

interface StreamCallbackContext {
  sessionId: string;
  characterId: string | null;
  sessionMetadata: Record<string, unknown>;
  agentRun: { id: string } | null;
  streamingState: StreamingMessageState | null;
  syncStreamingMessage: ((force?: boolean) => Promise<void>) | null | undefined;
  shouldEmitProgress: boolean;
  useCaching: boolean;
  systemPromptValue: string | CacheableSystemBlock[];
  cachedMessages: ModelMessage[];
  discoveredTools: Set<string>;
  previouslyDiscoveredTools: Set<string>;
  initialActiveToolNames: string[];
  contextTracking: ContextInjectionTrackingMetadata | null;
  injectContext: boolean;
  toolLoadingMode: "deferred" | "always";
  allowedPluginNames: Set<string>;
  pluginRoots: Map<string, string>;
  hasStopHooks: boolean;
  chatTaskRegistered: boolean;
  runFinalized: { value: boolean };
  provider: string;
  streamAbortSignal: AbortSignal;
  disposeSdkToolResultBridge?: () => void;
  rawMode?: boolean;
  /** Getter for the current assistant message UUID (may be rotated on retry). */
  getAssistantMessageId?: () => string | undefined;
  latestUserPromptText?: string;
  persistedUserMessageId?: string;
}

// ─── onFinish callback factory ────────────────────────────────────────────────

export function createOnFinishCallback(ctx: StreamCallbackContext) {
  return async ({
    text,
    steps,
    usage,
    providerMetadata,
  }: {
    text: string;
    steps: StepLike[];
    usage: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    } | null | undefined;
    providerMetadata: unknown;
  }) => {
    if (ctx.runFinalized.value) return;
    ctx.runFinalized.value = true;
    ctx.disposeSdkToolResultBridge?.();

    if (ctx.hasStopHooks) {
      try {
        runStopHooks(
          ctx.sessionId,
          "completed",
          ctx.allowedPluginNames,
          ctx.pluginRoots
        );
      } catch (hookError) {
        console.error("[Hooks] Stop hook dispatch failed:", hookError);
      }
    }

    if (ctx.agentRun?.id) {
      await handleUndrainedQueueMessages(ctx.agentRun.id, ctx.sessionId);
      removeChatAbortController(ctx.agentRun.id);
      removeLivePromptQueue(ctx.agentRun.id, ctx.sessionId);
    }
    // NOTE: Do NOT clear delegation completions here. They persist between
    // turns so the next auto-resumed turn's prepareStep can inject them.

    // Finalize any tool calls that were streamed via deltas (OpenAI format)
    if (ctx.streamingState) {
      finalizeStreamingToolCalls(ctx.streamingState);
      sealDanglingToolCalls(
        ctx.streamingState,
        "Tool execution ended before a final result was persisted."
      );
    }
    if (ctx.streamingState && ctx.syncStreamingMessage) {
      await ctx.syncStreamingMessage(true);
    }

    // Save assistant message to database.
    // When a live prompt was injected mid-run, prepareStep split the streaming
    // message and recorded stepOffset — only include post-injection steps here
    // so the pre-injection content stays in its own sealed DB record.
    const relevantSteps =
      ctx.streamingState?.stepOffset != null
        ? (steps as StepLike[]).slice(ctx.streamingState.stepOffset)
        : (steps as StepLike[] | undefined);
    const stepContent = buildCanonicalAssistantContentFromSteps(
      relevantSteps,
      text
    );
    const mergedContent = mergeCanonicalAssistantContent(
      ctx.streamingState?.parts,
      stepContent
    );
    // Rewrite ephemeral tool-results into compact stubs BEFORE persistence.
    // The model has already seen the full result in the current streaming
    // turn — stubbing the stored copy prevents replay bloat across subsequent
    // turns (e.g. Ghost OS screenshots, large AX trees). The current turn's
    // in-memory result is unaffected.
    const content = stubEphemeralToolResults(mergedContent);
    const canonicalTruncationCount = countCanonicalTruncationMarkers(content);
    if (canonicalTruncationCount > 0) {
      console.error(
        `[CHAT API] Canonical history invariant violation: detected ${canonicalTruncationCount} truncated tool results in final assistant content`
      );
    }

    // DEFENSIVE CHECK: Detect "fake tool calls" where model outputs tool syntax as text
    const fakeToolCallPattern = /\b([a-zA-Z][a-zA-Z0-9]*)\s*\{[\s\S]*?"[^"]+"\s*:/;
    const fakeToolJsonPattern = /\{"type"\s*:\s*"tool-(call|result)"/;
    for (const step of steps || []) {
      if (step.text) {
        const hasFakeToolCall = fakeToolCallPattern.test(step.text);
        const hasFakeToolJson = fakeToolJsonPattern.test(step.text);
        if (hasFakeToolCall || hasFakeToolJson) {
          const format = hasFakeToolJson
            ? "JSON protocol format"
            : "toolName{} format";
          const textSnippet = step.text.substring(0, 200).replace(/\n/g, " ");
          console.warn(
            `[CHAT API] FAKE TOOL CALL DETECTED (${format}): ` +
              `Model output tool-like syntax as text. Text: "${textSnippet}..."`
          );
          console.warn(
            `[CHAT API] Fake tool call context: ` +
              `activeTools at start: ${ctx.initialActiveToolNames.length}, ` +
              `discoveredTools: ${ctx.discoveredTools.size}, ` +
              `previouslyDiscovered: ${ctx.previouslyDiscoveredTools.size}`
          );
        }
      }
    }

    let finalMessageId: string | undefined;
    const assistantContentTokenCount = estimateMessageTokens({ content });

    // Cache metrics
    const anthropicMeta = (providerMetadata as any)?.anthropic || {};
    const rawUsage =
      anthropicMeta.usage || (usage as any)?.raw || {};
    const cacheCreation = ctx.useCaching
      ? anthropicMeta.cacheCreationInputTokens ||
        rawUsage.cache_creation_input_tokens ||
        (usage as any)?.inputTokenDetails?.cacheWriteTokens ||
        0
      : 0;
    const cacheRead = ctx.useCaching
      ? rawUsage.cache_read_input_tokens ||
        (usage as any)?.inputTokenDetails?.cacheReadTokens ||
        0
      : 0;
    const systemBlocksCached =
      ctx.useCaching && Array.isArray(ctx.systemPromptValue)
        ? ctx.systemPromptValue.filter(
            (block) =>
              (block as any).providerOptions?.anthropic?.cacheControl
          ).length
        : 0;
    const messagesCached =
      ctx.useCaching && ctx.cachedMessages.length > 0
        ? (() => {
            const cacheMarkerIndex = ctx.cachedMessages.findIndex(
              (msg) =>
                (msg as any).providerOptions?.anthropic?.cacheControl
            );
            return cacheMarkerIndex > 0 ? cacheMarkerIndex : 0;
          })()
        : 0;
    const basePricePerToken = 3 / 1_000_000;
    const estimatedSavingsUsd =
      cacheRead > 0 ? 0.9 * basePricePerToken * cacheRead : 0;
    const cacheMetrics =
      ctx.useCaching && usage
        ? {
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheCreation,
            estimatedSavingsUsd,
            systemBlocksCached,
            messagesCached,
          }
        : undefined;
    const messageMetadata = usage
      ? {
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
          },
          ...(cacheMetrics ? { cache: cacheMetrics } : {}),
        }
      : {};

    if (ctx.shouldEmitProgress && ctx.streamingState?.messageId) {
      const updated = await updateMessage(ctx.streamingState.messageId, {
        content,
        model: AI_CONFIG.model,
        tokenCount: assistantContentTokenCount,
        metadata: messageMetadata,
      });
      finalMessageId = updated?.id ?? ctx.streamingState.messageId;
      console.log(
        `[CHAT API] Final message updated with ${content.filter((p) => p.type === "tool-call").length} tool calls, ` +
          `${content.filter((p) => p.type === "tool-result").length} tool results`
      );
    } else {
      const assistantMessageIndex = await nextOrderingIndex(ctx.sessionId);

      const created = await createMessage({
        ...(ctx.getAssistantMessageId?.() ? { id: ctx.getAssistantMessageId() } : {}),
        sessionId: ctx.sessionId,
        role: "assistant",
        content: content,
        orderingIndex: assistantMessageIndex,
        model: AI_CONFIG.model,
        tokenCount: assistantContentTokenCount,
        metadata: messageMetadata,
      });
      finalMessageId = created?.id;
      console.log(
        `[CHAT API] Final message created with ${content.filter((p) => p.type === "tool-call").length} tool calls, ` +
          `${content.filter((p) => p.type === "tool-result").length} tool results`
      );
    }

    if (finalMessageId) {
      try {
        await deliverChannelReply({
          sessionId: ctx.sessionId,
          messageId: finalMessageId,
          content: content as DBContentPart[],
          sessionMetadata: ctx.sessionMetadata,
          rawMode: ctx.rawMode,
        });
      } catch (error) {
        console.error("[CHAT API] Channel delivery error:", error);
      }
    }

    // Trigger memory extraction in background (only for character-specific chats)
    if (ctx.characterId) {
      triggerExtraction(ctx.characterId, ctx.sessionId).catch((err) => {
        console.error("[CHAT API] Memory extraction error:", err);
      });
    }

    // Complete the agent run with success
    if (ctx.agentRun) {
      const stepCount = steps?.length || 0;
      const toolCallCount =
        steps?.reduce(
          (acc, s) => acc + ((s as any).toolCalls?.length || 0),
          0
        ) || 0;

      await completeAgentRun(ctx.agentRun.id, "succeeded", {
        stepCount,
        toolCallCount,
        usage: usage
          ? {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              totalTokens: usage.totalTokens,
            }
          : undefined,
        ...(cacheMetrics ? { cache: cacheMetrics } : {}),
      });

      const registryTask = taskRegistry.get(ctx.agentRun.id);
      const registryDurationMs = registryTask
        ? Date.now() - new Date(registryTask.startedAt).getTime()
        : undefined;
      taskRegistry.updateStatus(ctx.agentRun.id, "succeeded", {
        durationMs: registryDurationMs,
      });
    }

    // Log cache performance metrics (if caching enabled)
    if (ctx.useCaching && usage) {
      if (cacheCreation > 0 || cacheRead > 0) {
        console.log(
          `[CACHE] Performance: ${cacheRead} tokens read (hits), ` +
            `${cacheCreation} tokens written (new cache), ` +
            `${systemBlocksCached} system blocks cached, ` +
            `${messagesCached} messages cached`
        );

        if (cacheRead > 0) {
          console.log(
            `[CACHE] Cost savings: ~$${estimatedSavingsUsd.toFixed(4)} (90% discount on ${cacheRead} tokens)`
          );
        }
      } else if (systemBlocksCached > 0 || messagesCached > 0) {
        console.log(
          `[CACHE] Debug: Cache markers applied (${systemBlocksCached} system blocks, ${messagesCached} messages) ` +
            `but no cache metrics returned. Provider metadata: ${JSON.stringify(anthropicMeta)}`
        );
      }
    }

    // Update context injection tracking in session metadata
    const tokensUsedThisRequest = usage?.totalTokens || 0;
    let newTracking: ContextInjectionTrackingMetadata;

    if (ctx.injectContext) {
      newTracking = {
        tokensSinceLastInjection: tokensUsedThisRequest,
        messagesSinceLastInjection: 1,
        lastInjectedAt: new Date().toISOString(),
        toolLoadingMode: ctx.toolLoadingMode,
      };
    } else {
      const currentTracking = ctx.contextTracking || {
        tokensSinceLastInjection: 0,
        messagesSinceLastInjection: 0,
      };
      newTracking = {
        tokensSinceLastInjection:
          currentTracking.tokensSinceLastInjection + tokensUsedThisRequest,
        messagesSinceLastInjection:
          currentTracking.messagesSinceLastInjection + 1,
        lastInjectedAt: currentTracking.lastInjectedAt,
        toolLoadingMode:
          currentTracking.toolLoadingMode ?? ctx.toolLoadingMode,
      };
    }

    // Persist newly discovered tools to session metadata
    let discoveredToolsMetadata:
      | { toolNames: string[]; lastUpdatedAt: string }
      | undefined;
    if (ctx.discoveredTools.size > 0) {
      discoveredToolsMetadata = {
        toolNames: [...ctx.discoveredTools],
        lastUpdatedAt: new Date().toISOString(),
      };
    }

    // Re-read session metadata from DB to avoid overwriting changes made mid-stream
    const freshSession = await getSession(ctx.sessionId);
    const freshMetadata =
      (freshSession?.metadata as Record<string, unknown>) || {};

    const updatedSession = await updateSession(ctx.sessionId, {
      metadata: {
        ...freshMetadata,
        contextInjectionTracking: newTracking,
        ...(discoveredToolsMetadata && {
          discoveredTools: discoveredToolsMetadata,
        }),
      },
    });

    console.log(`[CHAT API] session metadata updated: ${!!updatedSession}`);
    if (updatedSession) {
      const updatedMeta = updatedSession.metadata as Record<string, any>;
      console.log(
        `[CHAT API] updated metadata keys: ${Object.keys(updatedMeta).join(", ")}`
      );
      console.log(
        `[CHAT API] updated discoveredTools: ${JSON.stringify(updatedMeta.discoveredTools)}`
      );
    }
  };
}

// ─── onAbort callback factory ─────────────────────────────────────────────────

export function createOnAbortCallback(ctx: StreamCallbackContext) {
  return async ({ steps }: { steps: StepLike[] }) => {
    if (ctx.runFinalized.value) return;
    ctx.runFinalized.value = true;
    ctx.disposeSdkToolResultBridge?.();

    if (ctx.hasStopHooks) {
      try {
        runStopHooks(
          ctx.sessionId,
          "aborted",
          ctx.allowedPluginNames,
          ctx.pluginRoots
        );
      } catch (hookError) {
        console.error("[Hooks] Stop hook dispatch failed:", hookError);
      }
    }

    if (ctx.agentRun?.id) {
      await handleUndrainedQueueMessages(ctx.agentRun.id, ctx.sessionId);
      removeChatAbortController(ctx.agentRun.id);
      removeLivePromptQueue(ctx.agentRun.id, ctx.sessionId);
    }
    // NOTE: Do NOT clear delegation completions here. They persist between
    // turns so the next auto-resumed turn's prepareStep can inject them.

    try {
      const interruptionTimestamp = new Date();
      if (ctx.streamingState) {
        finalizeStreamingToolCalls(ctx.streamingState);
        sealDanglingToolCalls(
          ctx.streamingState,
          "Tool execution was interrupted before completion."
        );
      }
      if (ctx.streamingState && ctx.syncStreamingMessage) {
        await ctx.syncStreamingMessage(true);
      }

      // Build canonical content from the partial stream and completed steps.
      // Respect the split marker from a mid-run live-prompt injection — only
      // include post-injection steps here so the pre-injection content stays
      // in its own sealed DB record. Matches `onFinish` at
      // stream-callbacks.ts ~180.
      const relevantSteps =
        ctx.streamingState?.stepOffset != null
          ? (steps as StepLike[]).slice(ctx.streamingState.stepOffset)
          : (steps as StepLike[] | undefined);
      const stepContent = buildCanonicalAssistantContentFromSteps(
        relevantSteps,
      );
      const mergedContent = mergeCanonicalAssistantContent(
        ctx.streamingState?.parts,
        stepContent
      );
      // See note at the normal-completion write site — stubbing ephemeral
      // tool-results here keeps interrupted-turn DB rows small too.
      const content = stubEphemeralToolResults(mergedContent);
      const canonicalTruncationCount =
        countCanonicalTruncationMarkers(content);
      if (canonicalTruncationCount > 0) {
        console.error(
          `[CHAT API] Canonical history invariant violation: detected ${canonicalTruncationCount} truncated tool results in aborted assistant content`
        );
      }

      // Save partial assistant message IF there was any content generated
      if (content.length > 0) {
        if (ctx.shouldEmitProgress && ctx.streamingState?.messageId) {
          await updateMessage(ctx.streamingState.messageId, {
            content,
            metadata: { interrupted: true },
          });
        } else {
          const partialMessageIndex = await nextOrderingIndex(ctx.sessionId);

          await createMessage({
            ...(ctx.getAssistantMessageId?.() ? { id: ctx.getAssistantMessageId() } : {}),
            sessionId: ctx.sessionId,
            role: "assistant",
            content: content,
            orderingIndex: partialMessageIndex,
            model: AI_CONFIG.model,
            metadata: { interrupted: true },
          });
        }
        console.log(
          `[CHAT API] Saved partial assistant message (${content.length} parts) before interruption`
        );
      }

      // Save system interruption message
      const systemMessageIndex = await nextOrderingIndex(ctx.sessionId);

      await createMessage({
        sessionId: ctx.sessionId,
        role: "system",
        content: [
          {
            type: "text",
            text: buildInterruptionMessage("chat", interruptionTimestamp),
          },
        ],
        orderingIndex: systemMessageIndex,
        metadata: buildInterruptionMetadata("chat", interruptionTimestamp),
      });

      if (ctx.agentRun) {
        await completeAgentRun(ctx.agentRun.id, "cancelled", {
          reason: "user_cancelled",
          stepCount: steps.length,
        });

        await appendRunEvent({
          runId: ctx.agentRun.id,
          eventType: "run_completed",
          level: "info",
          pipelineName: "chat",
          data: {
            status: "cancelled",
            reason: "user_cancelled",
            stepCount: steps.length,
          },
        });
        const registryTask = taskRegistry.get(ctx.agentRun.id);
        const registryDurationMs = registryTask
          ? Date.now() - new Date(registryTask.startedAt).getTime()
          : undefined;
        taskRegistry.updateStatus(ctx.agentRun.id, "cancelled", {
          durationMs: registryDurationMs,
        });
      }
    } catch (error) {
      console.error("[CHAT API] Failed to record cancellation:", error);
    }
  };
}
