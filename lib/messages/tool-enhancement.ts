/**
 * Tool Enhancement Utilities
 *
 * Functions for enhancing frontend messages with tool results from the database.
 * Extracted from app/api/chat/route.ts to allow importing in tests without
 * violating Next.js route export restrictions.
 */

import { getToolResultsForSession, createMessage } from "@/lib/db/queries";
import { isMissingToolResult, normalizeToolResultOutput } from "@/lib/ai/tool-result-utils";
import { nextOrderingIndex } from "@/lib/session/message-ordering";
import type { DBToolResultPart } from "@/lib/messages/converter";

// Types
interface FrontendMessagePart {
  type: string;
  text?: string;
  image?: string;
  url?: string;
  // Tool call parts (from assistant-ui streaming format)
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  argsText?: string;
  result?: unknown;
  input?: unknown;
  output?: unknown;
  state?: string;
  errorText?: string;
}

// Frontend message type (from assistant-ui / AssistantChatTransport)
export interface FrontendMessage {
  id?: string;
  role: string;
  content?: string | unknown;
  parts?: FrontendMessagePart[];
  experimental_attachments?: Array<{
    name?: string;
    contentType?: string;
    url?: string;
    localPath?: string;
    filePath?: string;
    size?: number;
    kind?: string;
  }>;
  metadata?: {
    custom?: {
      attachments?: Array<{
        name?: string;
        contentType?: string;
        url?: string;
        localPath?: string;
        filePath?: string;
        size?: number;
        kind?: string;
      }>;
      inspectContext?: unknown;
      designContext?: unknown;
    };
  };
}

interface ToolResultEnhancementOptions {
  // Kept for API compatibility; strict history mode does not refetch missing results.
  refetchTools?: Record<string, unknown>;
  maxRefetch?: number;
  // Disabled by default to avoid creating orphaned tool rows after history truncation.
  allowSyntheticBackfill?: boolean;
}

/**
 * Safely parse tool arguments from various frontend formats
 */
export function safeParseToolArgs(part: FrontendMessagePart): unknown {
  if (part.input !== undefined) {
    if (typeof part.input === "object" && part.input !== null && !Array.isArray(part.input)) {
      return part.input;
    }
    if (typeof part.input === "string") {
      try {
        const parsed = JSON.parse(part.input);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  if (part.args !== undefined) {
    if (typeof part.args === "string") {
      try {
        const parsed = JSON.parse(part.args);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed;
        }
        return undefined;
      } catch {
        return undefined;
      }
    }
    if (typeof part.args === "object" && part.args !== null && !Array.isArray(part.args)) {
      return part.args;
    }
    return undefined;
  }
  if (typeof part.argsText === "string" && part.argsText.trim()) {
    try {
      const parsed = JSON.parse(part.argsText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (error) {
      console.warn(`[TOOL-ENHANCEMENT] Failed to parse tool argsText for ${part.toolName}:`, error);
    }
  }
  return undefined;
}

async function persistToolResultMessage(params: {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  result: unknown;
  status: string;
}) {
  const resultPart: DBToolResultPart = {
    type: "tool-result",
    toolCallId: params.toolCallId,
    toolName: params.toolName,
    result: params.result,
    status: params.status,
    timestamp: new Date().toISOString(),
    state: params.status === "error" || params.status === "failed" ? "output-error" : "output-available",
  };

  // Allocate ordering index for bullet-proof message ordering
  const toolMessageIndex = await nextOrderingIndex(params.sessionId);

  await createMessage({
    sessionId: params.sessionId,
    role: "tool",
    toolName: params.toolName,
    toolCallId: params.toolCallId,
    content: [resultPart],
    orderingIndex: toolMessageIndex,
    metadata: { syntheticToolResult: true },
  });
}

/**
 * HYBRID APPROACH: Enhance frontend messages with tool results from database.
 *
 * This solves the ID mismatch problem between frontend (runtime IDs) and database (UUIDs).
 *
 * The frontend's messages are the source of truth for:
 * - Conversation structure (which messages exist, in what order)
 * - Message content (especially important for EDITED messages)
 *
 * The database provides:
 * - Tool results (which the frontend's streaming messages may not have properly)
 *
 * How it works:
 * 1. Start with the frontend messages exactly as sent
 * 2. For assistant messages with tool-call parts, look up results from DB
 * 3. Add tool results to the parts array
 *
 * This respects edits (frontend has correct truncated state) while getting tool results.
 */
export async function enhanceFrontendMessagesWithToolResults(
  frontendMessages: FrontendMessage[],
  sessionId: string,
  options: ToolResultEnhancementOptions = {}
): Promise<FrontendMessage[]> {
  const allowSyntheticBackfill = options.allowSyntheticBackfill === true;

  // Fetch all tool results from the database for this session
  const toolResults = await getToolResultsForSession(sessionId);

  console.log(`[TOOL-ENHANCEMENT] Hybrid approach: ${frontendMessages.length} frontend messages, ${toolResults.size} tool results from DB`);

  const resolvedToolResults = new Map(toolResults);
  const persistedToolResults = new Set<string>();
  let missingToolResultCount = 0;

  for (const msg of frontendMessages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.parts)) {
      continue;
    }

    for (const part of msg.parts) {
      if (!part.toolCallId) continue;

      const isToolCallPart = part.type === "tool-call";
      const isDynamicToolPart = part.type === "dynamic-tool";
      const isToolUIPart = part.type.startsWith("tool-");
      if (!isToolCallPart && !isDynamicToolPart && !isToolUIPart) continue;

      const toolName =
        part.toolName ||
        (isToolUIPart ? part.type.replace("tool-", "") : "tool");
      const args = safeParseToolArgs(part);
      const partOutput =
        (part.output !== undefined ? part.output : undefined) ??
        (part.result !== undefined ? part.result : undefined);
      const existing = resolvedToolResults.get(part.toolCallId);

      if (!isMissingToolResult(partOutput)) {
        if (isMissingToolResult(existing)) {
          const normalized = normalizeToolResultOutput(toolName, partOutput, args, {
            mode: "canonical",
          });
          resolvedToolResults.set(part.toolCallId, normalized.output);
          if (allowSyntheticBackfill && !persistedToolResults.has(part.toolCallId)) {
            await persistToolResultMessage({
              sessionId,
              toolCallId: part.toolCallId,
              toolName,
              result: normalized.output,
              status: normalized.status,
            });
            persistedToolResults.add(part.toolCallId);
          }
        }
        continue;
      }

      if (!isMissingToolResult(existing)) continue;
      missingToolResultCount += 1;
    }
  }

  if (missingToolResultCount > 0) {
    console.warn(
      `[TOOL-ENHANCEMENT] Missing ${missingToolResultCount} tool results; ` +
      `strict history mode leaves canonical history unchanged (no refetch/fallback rewrite).`
    );
  }

  const getOutputState = (result: unknown) => {
    if (result && typeof result === "object") {
      const status = String((result as { status?: string }).status || "").toLowerCase();
      if (status === "error" || status === "failed") {
        return "output-error";
      }
    }
    return "output-available";
  };

  // Enhance each assistant message with tool results
  const enhancedMessages = frontendMessages.map(msg => {
    // Only enhance assistant messages
    if (msg.role !== 'assistant') {
      return msg;
    }

    // Check if this message has tool-call parts that need results
    if (!msg.parts || !Array.isArray(msg.parts)) {
      return msg;
    }

    // Look for tool-call parts and enhance with results from DB
    let hasEnhancements = false;
    const enhancedParts = msg.parts.map(part => {
      // Handle tool-call parts (from assistant-ui streaming format)
      // These have type like "tool-call" with toolCallId
      if (part.type === 'tool-call' && part.toolCallId) {
        const result = resolvedToolResults.get(part.toolCallId);
        if (!isMissingToolResult(result) && part.result === undefined) {
          hasEnhancements = true;
          console.log(`[TOOL-ENHANCEMENT] Enhanced tool call ${part.toolCallId} (${part.toolName}) with DB result`);
          return { ...part, result };
        }
      }
      // Handle AI SDK tool UI parts (tool-*)
      if (part.type.startsWith("tool-") && part.toolCallId) {
        const result = resolvedToolResults.get(part.toolCallId);
        if (!isMissingToolResult(result) && part.output === undefined) {
          hasEnhancements = true;
          return {
            ...part,
            output: result,
            state: part.state?.startsWith("output") ? part.state : getOutputState(result),
          };
        }
      }
      // Handle dynamic-tool parts (historical tool calls)
      if (part.type === "dynamic-tool" && part.toolCallId) {
        const result = resolvedToolResults.get(part.toolCallId);
        if (!isMissingToolResult(result) && part.output === undefined) {
          hasEnhancements = true;
          return {
            ...part,
            output: result,
            state: part.state?.startsWith("output") ? part.state : getOutputState(result),
          };
        }
      }
      return part;
    });

    if (hasEnhancements) {
      return { ...msg, parts: enhancedParts };
    }

    return msg;
  });

  return enhancedMessages;
}
