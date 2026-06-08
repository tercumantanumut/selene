import { tool, jsonSchema } from "ai";
import { getSession } from "@/lib/db/queries";
import { ContextWindowManager } from "@/lib/context-window";
import { resolveSessionModelScopeForSession } from "@/lib/ai/session-model-resolver";
import { withToolLogging } from "@/lib/ai/tool-registry/logging";

interface CompactSessionToolOptions {
  sessionId: string;
}

interface CompactSessionArgs {
  reason?: string;
}

const compactSessionSchema = jsonSchema<CompactSessionArgs>({
  type: "object",
  title: "CompactSessionInput",
  description: "Input for compacting the current session context",
  properties: {
    reason: {
      type: "string",
      description:
        "Optional short reason for why compaction is being triggered (for auditability).",
    },
  },
  additionalProperties: false,
});

const ESTIMATED_SYSTEM_PROMPT_LENGTH = 5000;

async function executeCompactSession(
  options: CompactSessionToolOptions,
  args: CompactSessionArgs
) {
  const session = await getSession(options.sessionId);
  if (!session) {
    return {
      status: "error",
      error: `Session ${options.sessionId} not found`,
    };
  }

  const metadata = (session.metadata as Record<string, unknown>) || {};
  const resolvedScope = await resolveSessionModelScopeForSession(metadata);
  const modelId = resolvedScope.effectiveConfig.chatModel;
  const provider = resolvedScope.effectiveConfig.provider;

  const result = await ContextWindowManager.forceCompact(
    options.sessionId,
    modelId,
    ESTIMATED_SYSTEM_PROMPT_LENGTH,
    provider
  );

  return {
    status: result.success ? "success" : "error",
    reason: args.reason,
    model: {
      id: modelId,
      provider,
    },
    before: {
      tokens: result.beforeStatus.currentTokens,
      maxInputTokens: result.beforeStatus.maxInputTokens,
      maxTokens: result.beforeStatus.maxTokens,
      maxOutputTokens: result.beforeStatus.maxOutputTokens,
      percentage: result.beforeStatus.usagePercentage,
      formatted: result.beforeStatus.formatted,
      thresholds: result.beforeStatus.thresholds,
      status: result.beforeStatus.status,
    },
    after: {
      tokens: result.afterStatus.currentTokens,
      maxInputTokens: result.afterStatus.maxInputTokens,
      maxTokens: result.afterStatus.maxTokens,
      maxOutputTokens: result.afterStatus.maxOutputTokens,
      percentage: result.afterStatus.usagePercentage,
      formatted: result.afterStatus.formatted,
      thresholds: result.afterStatus.thresholds,
      status: result.afterStatus.status,
    },
    compacted: result.success,
    tokensFreed: result.compactionResult.tokensFreed,
    messagesCompacted: result.compactionResult.messagesCompacted,
    compactionSummaryPreview: result.compactionResult.newSummary.slice(0, 500),
    error: result.compactionResult.error,
    message: result.success
      ? `Compaction completed: freed ${result.compactionResult.tokensFreed} tokens from ${result.compactionResult.messagesCompacted} messages.`
      : `Compaction failed: ${result.compactionResult.error || "unknown error"}`,
  };
}

export function createCompactSessionTool(options: CompactSessionToolOptions) {
  const executeWithLogging = withToolLogging(
    "compactSession",
    options.sessionId,
    (args: CompactSessionArgs) => executeCompactSession(options, args)
  );

  return tool({
    description: `Compact the current conversation history using the existing compaction engine.

Use this tool when context usage is growing and you want to proactively free context before long multi-step work.
This is an explicit, agent-controlled action and returns before/after token usage details.`,
    inputSchema: compactSessionSchema,
    execute: executeWithLogging,
  });
}
