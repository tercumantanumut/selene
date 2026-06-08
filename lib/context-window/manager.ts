/**
 * Context Window Manager
 *
 * Orchestrates context window management across all providers.
 * Coordinates token tracking, threshold detection, and compaction triggers.
 *
 * @see docs/CONTEXT_WINDOW_MANAGEMENT_DESIGN.md
 */

import { getSession, getNonCompactedMessages } from "@/lib/db/queries";
import { TokenTracker, formatTokenCount } from "./token-tracker";
import {
  getContextWindowConfig,
  getTokenThresholds,
  type ContextWindowConfig,
} from "./provider-limits";
import { CompactionService, type CompactionResult } from "./compaction-service";
import type { LLMProvider } from "@/lib/ai/providers";
import {
  getScopedFallbackMinConfidence,
  isScopedFallbackEnabled,
  shouldUseScopedCounting,
  shouldDualCalculate,
  type ContextScope,
} from "./scoped-counting-contract";
import type { Message } from "@/lib/db/schema";
import { logScopedCountingTelemetry } from "./scoped-counting-telemetry";

function readContextScope(value: unknown): ContextScope | undefined {
  return value === "main" || value === "delegated" ? value : undefined;
}

function hasDelegatedAnnotations(messages: Message[]): boolean {
  for (const message of messages) {
    const metadata =
      message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
        ? (message.metadata as Record<string, unknown>)
        : null;

    if (readContextScope(metadata?.contextScope) === "delegated") {
      return true;
    }

    if (!Array.isArray(message.content)) {
      continue;
    }

    for (const part of message.content) {
      if (!part || typeof part !== "object" || Array.isArray(part)) {
        continue;
      }
      if (readContextScope((part as { contextScope?: unknown }).contextScope) === "delegated") {
        return true;
      }
    }
  }

  return false;
}

function toFiniteUsageTokenCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function getLatestProviderReportedContextTokens(
  messages: Message[],
  provider?: LLMProvider
): number | null {
  if (provider !== "kimi") {
    return null;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant" || message.isCompacted) {
      continue;
    }

    const metadata =
      message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
        ? (message.metadata as Record<string, unknown>)
        : null;
    const usage =
      metadata?.usage && typeof metadata.usage === "object" && !Array.isArray(metadata.usage)
        ? (metadata.usage as Record<string, unknown>)
        : null;

    if (!usage) {
      continue;
    }

    const inputTokens = toFiniteUsageTokenCount(usage.inputTokens) ?? 0;
    const outputTokens = toFiniteUsageTokenCount(usage.outputTokens) ?? 0;
    if (inputTokens > 0) {
      return inputTokens;
    }

    const totalTokens = toFiniteUsageTokenCount(usage.totalTokens);
    if (totalTokens !== null && totalTokens > 0) {
      return totalTokens;
    }

    if (outputTokens > 0) {
      return outputTokens;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ContextStatus = "safe" | "warning" | "critical" | "exceeded";

export interface ContextWindowStatus {
  /** Current total tokens in context */
  currentTokens: number;
  /** Provider-enforced budget used for request safety decisions */
  maxInputTokens: number;
  /** Maximum advertised context tokens for the model */
  maxTokens: number;
  /** Maximum output budget for the model, when known */
  maxOutputTokens?: number;
  /** Usage as decimal (0-1) */
  usagePercentage: number;
  /** Status classification */
  status: ContextStatus;
  /** Whether background compaction is recommended */
  shouldCompact: boolean;
  /** Whether compaction is required before proceeding */
  mustCompact: boolean;
  /** Human-readable recommendation */
  recommendedAction: string;
  /** Token thresholds for this model */
  thresholds: {
    warning: number;
    critical: number;
    hardLimit: number;
  };
  /** Formatted strings for display */
  formatted: {
    current: string;
    max: string;
    percentage: string;
  };
}

interface ContextWindowCheckOptions {
  /**
   * Use provider-reported request usage as a display floor when available.
   * This is useful for providers like Kimi whose API reports the full prompt
   * size more accurately than our persisted per-message estimates.
   */
  includeProviderReportedUsageFloor?: boolean;
}

interface ContextCheckResult {
  /** Whether the request can proceed */
  canProceed: boolean;
  /** Context window status */
  status: ContextWindowStatus;
  /** If compaction was performed, the result */
  compactionResult?: CompactionResult;
  /** Error message if cannot proceed */
  error?: string;
  /** Recovery options if blocked */
  recovery?: {
    action: "compact" | "new_session";
    message: string;
  };
  /** Milliseconds spent in synchronous preflight compaction. */
  compactionDurationMs?: number;
}

// ---------------------------------------------------------------------------
// ContextWindowManager Class
// ---------------------------------------------------------------------------

export class ContextWindowManager {
  private static classifyStatusFromTokens(
    totalTokens: number,
    thresholds: { warningTokens: number; criticalTokens: number; hardLimitTokens: number }
  ): ContextStatus {
    if (totalTokens >= thresholds.hardLimitTokens) return "exceeded";
    if (totalTokens >= thresholds.criticalTokens) return "critical";
    if (totalTokens >= thresholds.warningTokens) return "warning";
    return "safe";
  }

  /**
   * Check context window status for a session.
   *
   * @param sessionId - The session to check
   * @param modelId - The model being used
   * @param systemPromptLength - Length of system prompt in characters
   * @param provider - Optional provider for fallback config
   * @returns Context window status
   */
  static async checkContextWindow(
    sessionId: string,
    modelId: string,
    systemPromptLength: number,
    provider?: LLMProvider,
    options: ContextWindowCheckOptions = {}
  ): Promise<ContextWindowStatus> {
    const session = await getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const messages = await getNonCompactedMessages(sessionId);
    const config = getContextWindowConfig(modelId, provider);
    const thresholds = getTokenThresholds(modelId, provider);
    const delegatedAnnotationsPresent = hasDelegatedAnnotations(messages);

    const scopedOptions = {
      provider,
      sessionMetadata: (session.metadata ?? null) as Record<string, unknown> | null,
      fallbackEnabled: isScopedFallbackEnabled(),
      fallbackMinConfidence: getScopedFallbackMinConfidence(),
      hasDelegatedAnnotations: delegatedAnnotationsPresent,
    };

    const usage = await TokenTracker.calculateUsage(
      sessionId,
      messages,
      systemPromptLength,
      session.summary,
      scopedOptions
    );

    let usageForDecision = usage;
    if (shouldDualCalculate(provider)) {
      const legacyUsage = await TokenTracker.calculateUsage(
        sessionId,
        messages,
        systemPromptLength,
        session.summary,
        {
          ...scopedOptions,
          scopedMode: "legacy",
        }
      );
      const scopedStatus = this.classifyStatusFromTokens(usage.totalTokens, thresholds);
      const legacyStatus = this.classifyStatusFromTokens(legacyUsage.totalTokens, thresholds);
      logScopedCountingTelemetry({
        sessionId,
        provider,
        legacyTokens: legacyUsage.totalTokens,
        scopedTokens: usage.totalTokens,
        legacyStatus,
        scopedStatus,
        fallbackUsed: scopedOptions.fallbackEnabled,
        fallbackMinConfidence: scopedOptions.fallbackMinConfidence,
      });

      if (!shouldUseScopedCounting(provider)) {
        usageForDecision = legacyUsage;
      }
    }

    const providerReportedTokens = options.includeProviderReportedUsageFloor
      ? getLatestProviderReportedContextTokens(messages, provider)
      : null;
    const effectiveTotalTokens = providerReportedTokens !== null
      ? Math.max(usageForDecision.totalTokens, providerReportedTokens)
      : usageForDecision.totalTokens;
    const decisionMaxTokens = config.maxInputTokens ?? config.maxTokens;
    const usagePercentage = effectiveTotalTokens / decisionMaxTokens;

    // Determine status and actions
    let status: ContextStatus;
    let shouldCompact = false;
    let mustCompact = false;
    let recommendedAction: string;

    if (effectiveTotalTokens >= thresholds.hardLimitTokens) {
      status = "exceeded";
      mustCompact = true;
      recommendedAction =
        "Context window exceeded. Compaction required before continuing. " +
        "If compaction fails, please start a new conversation.";
    } else if (effectiveTotalTokens >= thresholds.criticalTokens) {
      status = "critical";
      mustCompact = true;
      recommendedAction =
        "Context window critical. Forcing compaction before next request.";
    } else if (effectiveTotalTokens >= thresholds.warningTokens) {
      status = "warning";
      shouldCompact = true;
      recommendedAction =
        "Context window approaching limit. Background compaction will run soon.";
    } else {
      status = "safe";
      recommendedAction = "Context window healthy. No action needed.";
    }

    const percentage = usagePercentage * 100;

    return {
      currentTokens: effectiveTotalTokens,
      maxInputTokens: decisionMaxTokens,
      maxTokens: config.maxTokens,
      maxOutputTokens: config.maxOutputTokens,
      usagePercentage,
      status,
      shouldCompact,
      mustCompact,
      recommendedAction,
      thresholds: {
        warning: thresholds.warningTokens,
        critical: thresholds.criticalTokens,
        hardLimit: thresholds.hardLimitTokens,
      },
      formatted: {
        current: formatTokenCount(effectiveTotalTokens),
        max: formatTokenCount(decisionMaxTokens),
        percentage: `${percentage.toFixed(1)}%`,
      },
    };
  }

  /**
   * Perform pre-flight check before sending a request.
   * Handles compaction if needed and determines if request can proceed.
   *
   * @param sessionId - The session ID
   * @param modelId - The model being used
   * @param systemPromptLength - Length of system prompt
   * @param provider - Optional provider
   * @returns Check result with proceed/block decision
   */
  static async preFlightCheck(
    sessionId: string,
    modelId: string,
    systemPromptLength: number,
    provider?: LLMProvider
  ): Promise<ContextCheckResult> {
    const status = await this.checkContextWindow(
      sessionId,
      modelId,
      systemPromptLength,
      provider
    );

    console.log(
      `[ContextWindowManager] Pre-flight check: ${status.status} ` +
      `(${status.formatted.current}/${status.formatted.max}, ${status.formatted.percentage})`
    );

    // Safe - proceed without action
    if (status.status === "safe") {
      return {
        canProceed: true,
        status,
      };
    }

    // Warning - proceed but trigger background compaction
    if (status.status === "warning") {
      console.log(`[ContextWindowManager] Triggering background compaction`);
      // Don't await - run in background
      void this.compactInBackground(sessionId);

      return {
        canProceed: true,
        status,
      };
    }

    // Critical or Exceeded - must compact before proceeding
    if (status.mustCompact) {
      console.log(
        `[ContextWindowManager] Context ${status.status}, forcing compaction`
      );

      const config = getContextWindowConfig(modelId, provider);
      const targetMaxTokens = config.maxInputTokens ?? config.maxTokens;
      const targetTokensToFree = status.currentTokens - Math.floor(targetMaxTokens * 0.7);
      const compactionStartedAt = Date.now();
      const compactionResult = await CompactionService.compact(sessionId, {
        targetTokensToFree: Math.max(0, targetTokensToFree),
      });

      if (compactionResult.success) {
        const compactionDurationMs = Date.now() - compactionStartedAt;

        // Re-check status after compaction
        let newStatus = await this.checkContextWindow(
          sessionId,
          modelId,
          systemPromptLength,
          provider
        );

        console.log(
          `[ContextWindowManager] Post-compaction status: ${newStatus.status} ` +
          `(${newStatus.formatted.current}/${newStatus.formatted.max})`
        );

        // RETRY: If still exceeded, attempt aggressive compaction (keepRecent=0)
        if (newStatus.status === "exceeded") {
          console.warn(
            `[ContextWindowManager] First compaction insufficient, retrying with aggressive strategy (keepRecent=0)`
          );

          const aggressiveTarget = newStatus.currentTokens - Math.floor(targetMaxTokens * 0.5);
          const retryResult = await CompactionService.compact(sessionId, {
            targetTokensToFree: Math.max(0, aggressiveTarget),
            keepRecentMessages: 0, // Compact ALL messages into summary
          });

          if (retryResult.success) {
            newStatus = await this.checkContextWindow(
              sessionId,
              modelId,
              systemPromptLength,
              provider
            );

            console.log(
              `[ContextWindowManager] Post-aggressive-compaction status: ${newStatus.status} ` +
              `(${newStatus.formatted.current}/${newStatus.formatted.max})`
            );

            // Merge compaction results for reporting
            compactionResult.tokensFreed += retryResult.tokensFreed;
            compactionResult.messagesCompacted += retryResult.messagesCompacted;
            compactionResult.newSummary = retryResult.newSummary;
          }
        }

        // FORCE-PROCEED: If compaction freed tokens but we're still slightly over,
        // allow the request through. The provider may accept it (context limits are
        // approximate), and blocking permanently is worse than a potential truncation.
        if (newStatus.status === "exceeded" && compactionResult.tokensFreed > 0) {
          console.warn(
            `[ContextWindowManager] Compaction freed ${formatTokenCount(compactionResult.tokensFreed)} ` +
            `but still at ${newStatus.formatted.current}/${newStatus.formatted.max}. ` +
            `Allowing request to proceed (provider may handle overflow).`
          );
          return {
            canProceed: true,
            status: newStatus,
            compactionResult,
            compactionDurationMs,
            error:
              `Warning: Context window at ${newStatus.formatted.percentage} after compaction. ` +
              `Consider starting a new conversation soon.`,
            recovery: {
              action: "compact",
              message:
                "Context window is near its limit. Use /compact or start a new conversation to free space.",
            },
          };
        }

        // If still exceeded and compaction freed NOTHING, block as last resort
        if (newStatus.status === "exceeded") {
          return {
            canProceed: false,
            status: newStatus,
            compactionResult,
            compactionDurationMs,
            error: "Context window still exceeded after compaction",
            recovery: {
              action: "new_session",
              message:
                "The conversation is too long to continue. Please start a new conversation. " +
                "Your previous context has been summarized and can be referenced.",
            },
          };
        }

        return {
          canProceed: true,
          status: newStatus,
          compactionResult,
          compactionDurationMs,
        };
      } else {
        const compactionDurationMs = Date.now() - compactionStartedAt;

        // Compaction failed - implement graceful fallback
        console.error(
          `[ContextWindowManager] Compaction failed: ${compactionResult.error}`
        );

        // GRACEFUL DEGRADATION: If compaction fails due to insufficient messages
        // but we're not critically over the limit, allow the request to proceed
        // with a warning instead of blocking the entire chat.
        const isInsufficientMessages = compactionResult.error?.includes("Not enough messages");
        const canProceedWithWarning = isInsufficientMessages && status.status === "critical";

        if (canProceedWithWarning) {
          console.warn(
            `[ContextWindowManager] Allowing request despite compaction failure ` +
            `(insufficient messages for compaction, but not critically exceeded)`
          );
          return {
            canProceed: true,
            status,
            compactionResult,
            compactionDurationMs,
            error: `Warning: ${compactionResult.error}. Proceeding with caution.`,
          };
        }

        // For other failures or if truly exceeded, block the request
        return {
          canProceed: false,
          status,
          compactionResult,
          compactionDurationMs,
          error: `Compaction failed: ${compactionResult.error}`,
          recovery: {
            action: "new_session",
            message:
              "Unable to optimize the conversation. Please start a new conversation.",
          },
        };
      }
    }

    // Fallback - shouldn't reach here
    return {
      canProceed: true,
      status,
    };
  }

  /**
   * Perform compaction if needed based on current status.
   *
   * @param sessionId - Session to compact
   * @param modelId - Model being used
   * @param systemPromptLength - System prompt length
   * @param provider - Optional provider
   * @returns Whether compaction was performed
   */
  // fallow-ignore-next-line unused-class-member
  static async compactIfNeeded(
    sessionId: string,
    modelId: string,
    systemPromptLength: number,
    provider?: LLMProvider
  ): Promise<boolean> {
    const status = await this.checkContextWindow(
      sessionId,
      modelId,
      systemPromptLength,
      provider
    );

    if (status.mustCompact || status.shouldCompact) {
      console.log(
        `[ContextWindowManager] Compaction triggered: ${status.status}`
      );

      const cwConfig = getContextWindowConfig(modelId, provider);
      const targetMaxTokens = cwConfig.maxInputTokens ?? cwConfig.maxTokens;
      const targetTokensToFree = status.currentTokens - Math.floor(targetMaxTokens * 0.7);
      const result = await CompactionService.compact(sessionId, {
        targetTokensToFree: Math.max(0, targetTokensToFree),
      });

      if (result.success) {
        console.log(
          `[ContextWindowManager] Compaction successful: ` +
          `${result.messagesCompacted} messages, ${formatTokenCount(result.tokensFreed)} freed`
        );
        return true;
      } else {
        console.error(
          `[ContextWindowManager] Compaction failed: ${result.error}`
        );
        return false;
      }
    }

    return false;
  }

  /**
   * Force-compact a session regardless of thresholds.
   * Used by the /compact command and force-compact API endpoint.
   * Runs aggressive compaction (keepRecent=2) to maximize token savings.
   *
   * @param sessionId - Session to compact
   * @param modelId - Model being used
   * @param systemPromptLength - System prompt length
   * @param provider - Optional provider
   * @returns Compaction result with before/after status
   */
  static async forceCompact(
    sessionId: string,
    modelId: string,
    systemPromptLength: number,
    provider?: LLMProvider
  ): Promise<{
    success: boolean;
    beforeStatus: ContextWindowStatus;
    afterStatus: ContextWindowStatus;
    compactionResult: CompactionResult;
  }> {
    const beforeStatus = await this.checkContextWindow(
      sessionId,
      modelId,
      systemPromptLength,
      provider
    );

    console.log(
      `[ContextWindowManager] Force compaction requested: ${beforeStatus.formatted.current}/${beforeStatus.formatted.max} ` +
      `(${beforeStatus.formatted.percentage})`
    );

    const config = getContextWindowConfig(modelId, provider);
    const targetMaxTokens = config.maxInputTokens ?? config.maxTokens;
    // Target 50% usage after compaction for maximum headroom
    const targetTokensToFree = beforeStatus.currentTokens - Math.floor(targetMaxTokens * 0.5);

    // Run aggressive compaction with keepRecent=2 (keep only the last exchange)
    const compactionResult = await CompactionService.compact(sessionId, {
      targetTokensToFree: Math.max(0, targetTokensToFree),
      keepRecentMessages: 2,
    });

    // If first pass didn't free enough, retry with keepRecent=0
    if (compactionResult.success) {
      const midStatus = await this.checkContextWindow(
        sessionId,
        modelId,
        systemPromptLength,
        provider
      );

      if (midStatus.status === "exceeded" || midStatus.status === "critical") {
        console.log(
          `[ContextWindowManager] Force compaction: first pass at ${midStatus.formatted.percentage}, retrying with keepRecent=0`
        );
        const retryResult = await CompactionService.compact(sessionId, {
          targetTokensToFree: midStatus.currentTokens - Math.floor(targetMaxTokens * 0.5),
          keepRecentMessages: 0,
        });
        if (retryResult.success) {
          compactionResult.tokensFreed += retryResult.tokensFreed;
          compactionResult.messagesCompacted += retryResult.messagesCompacted;
          compactionResult.newSummary = retryResult.newSummary;
        }
      }
    }

    const afterStatus = await this.checkContextWindow(
      sessionId,
      modelId,
      systemPromptLength,
      provider
    );

    console.log(
      `[ContextWindowManager] Force compaction complete: ` +
      `${beforeStatus.formatted.current} → ${afterStatus.formatted.current} ` +
      `(freed ${formatTokenCount(compactionResult.tokensFreed)})`
    );

    return {
      success: compactionResult.success,
      beforeStatus,
      afterStatus,
      compactionResult,
    };
  }

  /**
   * Run compaction in the background (non-blocking).
   *
   * @param sessionId - Session to compact
   */
  private static async compactInBackground(sessionId: string): Promise<void> {
    try {
      const result = await CompactionService.compact(sessionId);
      if (result.success) {
        console.log(
          `[ContextWindowManager] Background compaction complete: ` +
          `${formatTokenCount(result.tokensFreed)} tokens freed`
        );
      }
    } catch (error) {
      console.error(
        `[ContextWindowManager] Background compaction error:`,
        error
      );
    }
  }

  /**
   * Get user-friendly status message for display.
   *
   * @param status - Context window status
   * @returns Human-readable message
   */
  static getStatusMessage(status: ContextWindowStatus): string {
    return (
      `Context usage: ${status.formatted.current}/${status.formatted.max} ` +
      `(${status.formatted.percentage})`
    );
  }

  /**
   * Get status color for UI display.
   *
   * @param status - Context status
   * @returns CSS color class or hex color
   */
  // fallow-ignore-next-line unused-class-member
  static getStatusColor(status: ContextStatus): string {
    switch (status) {
      case "safe":
        return "text-green-500";
      case "warning":
        return "text-yellow-500";
      case "critical":
        return "text-orange-500";
      case "exceeded":
        return "text-red-500";
      default:
        return "text-gray-500";
    }
  }

  /**
   * Estimate if a new message would exceed context limits.
   *
   * @param sessionId - Session ID
   * @param modelId - Model ID
   * @param newMessageContent - Content of the new message
   * @param systemPromptLength - System prompt length
   * @param provider - Optional provider
   * @returns Whether the message would exceed limits
   */
  static async wouldExceedLimit(
    sessionId: string,
    modelId: string,
    newMessageContent: unknown,
    systemPromptLength: number,
    provider?: LLMProvider
  ): Promise<{
    wouldExceed: boolean;
    projectedTokens: number;
    maxTokens: number;
    recommendation: string;
  }> {
    const status = await this.checkContextWindow(
      sessionId,
      modelId,
      systemPromptLength,
      provider
    );

    const newMessageTokens = TokenTracker.estimateNewMessageTokens(newMessageContent);
    const projectedTokens = status.currentTokens + newMessageTokens.tokens;
    const wouldExceed = projectedTokens >= status.thresholds.hardLimit;

    let recommendation: string;
    if (wouldExceed) {
      recommendation =
        "This message would exceed the context limit. Consider compacting first.";
    } else if (projectedTokens >= status.thresholds.critical) {
      recommendation =
        "This message will push context to critical levels. Compaction recommended.";
    } else if (projectedTokens >= status.thresholds.warning) {
      recommendation =
        "Context is approaching limits. Consider shorter messages.";
    } else {
      recommendation = "Message can be sent safely.";
    }

    return {
      wouldExceed,
      projectedTokens,
      maxTokens: status.maxTokens,
      recommendation,
    };
  }
}

// ---------------------------------------------------------------------------
// Convenience Exports
// ---------------------------------------------------------------------------

export { type CompactionResult } from "./compaction-service";
