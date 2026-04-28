import type { ModelMessage } from "ai";
import type { ContextWindowStatus as ManagedContextWindowStatus } from "@/lib/context-window";
import { toModelToolResultOutput } from "./tool-call-utils";

export function buildContextWindowPromptBlock(status: ManagedContextWindowStatus): string {
  const decisionMaxTokens = status.maxInputTokens ?? status.maxTokens;
  const warningPct = Math.round((status.thresholds.warning / decisionMaxTokens) * 100);
  const criticalPct = Math.round((status.thresholds.critical / decisionMaxTokens) * 100);
  const hardPct = Math.round((status.thresholds.hardLimit / decisionMaxTokens) * 100);

  return `\n\n[Context Window Status]
Current: ${status.formatted.current}/${status.formatted.max} (${status.formatted.percentage})
Thresholds: warning=${warningPct}%, critical=${criticalPct}%, hard=${hardPct}%

You have access to the compactSession tool.
Use compactSession proactively before long multi-step work or large tool outputs.
When status is critical or exceeded, call compactSession before continuing unless you have just compacted and still need user guidance.
Avoid repeated compaction unless additional headroom is needed.`;
}

/**
 * Split tool-result parts out of assistant messages into separate role:"tool" messages.
 *
 * The AI SDK's Anthropic converter only handles tool-result in assistant messages for
 * provider-executed tools (MCP, web_search, code_execution). Regular tool results
 * (executeCommand, vectorSearch, etc.) are silently dropped, leaving orphan tool_use
 * blocks that cause: "tool_use ids were found without tool_result blocks immediately after".
 *
 * This function moves tool-result parts from assistant messages into role:"tool" messages
 * placed immediately after, which the AI SDK correctly converts to Anthropic tool_result blocks.
 */
export function splitToolResultsFromAssistantMessages(messages: ModelMessage[]): ModelMessage[] {
  // First pass: collect all tool-call and tool-result IDs across all messages
  const allToolResultIds = new Set<string>();

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as Array<Record<string, unknown>>) {
      if (part.type === "tool-result" && typeof part.toolCallId === "string") {
        allToolResultIds.add(part.toolCallId);
      }
    }
  }

  const result: ModelMessage[] = [];
  let splitCount = 0;
  let reconstructedCalls = 0;
  let reconstructedResults = 0;

  const makeSyntheticToolResult = (
    toolCallId: string,
    toolName?: string
  ): Record<string, unknown> => ({
    type: "tool-result",
    toolCallId,
    toolName: toolName || "tool",
    output: toModelToolResultOutput({
      status: "error",
      error: "Tool call had no persisted tool result in conversation history.",
      reconstructed: true,
    }),
    status: "error",
  });

  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      result.push(message);
      continue;
    }

    // Separate parts into: before-tool-call, tool-call, tool-result, after-tool-call
    // The Anthropic API requires:
    //   assistant: [text, tool_use]        ← parts up to and including last tool_use
    //   user:      [tool_result]           ← tool results
    //   assistant: [text]                  ← any content generated AFTER tool results
    // Content after the last tool_use was generated in a new step after tool execution,
    // so it must go in a separate assistant message AFTER the tool result message.

    const parts = message.content as Array<Record<string, unknown>>;

    // Find the index of the last tool-call part
    let lastToolCallIdx = -1;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].type === "tool-call") {
        lastToolCallIdx = i;
        break;
      }
    }

    // No tool-calls in this message — check for orphan tool-results
    if (lastToolCallIdx === -1) {
      const toolResultsOnly = parts.filter((p) => p.type === "tool-result");
      if (toolResultsOnly.length === 0) {
        result.push(message);
        continue;
      }

      const nonToolResultParts = parts.filter((p) => p.type !== "tool-result");
      const syntheticCalls = toolResultsOnly
        .filter((part) => typeof part.toolCallId === "string")
        .map((part) => ({
          type: "tool-call",
          toolCallId: part.toolCallId as string,
          toolName: (typeof part.toolName === "string" ? part.toolName : "tool"),
          input: {
            __reconstructed: true,
            reason: "missing_tool_call_in_history",
          },
        }));

      reconstructedCalls += syntheticCalls.length;
      const assistantParts = [...nonToolResultParts, ...syntheticCalls];
      const firstAssistantPart = assistantParts[0] as Record<string, unknown> | undefined;
      result.push({
        ...message,
        content:
          assistantParts.length === 1 &&
          firstAssistantPart?.type === "text" &&
          typeof firstAssistantPart.text === "string"
            ? (firstAssistantPart.text as string)
            : (assistantParts as ModelMessage["content"]),
      } as ModelMessage);

      splitCount += toolResultsOnly.length;
      result.push({
        role: "tool",
        content: toolResultsOnly as ModelMessage["content"],
      } as ModelMessage);
      continue;
    }

    // Split the parts at the last tool-call boundary
    // beforeAndIncluding: text + tool-call parts (the "step 1" assistant content)
    // toolResults: tool-result parts
    // afterToolCalls: text parts after the last tool-call (the "step 2" content)
    const beforeAndIncluding: Array<Record<string, unknown>> = [];
    const toolResultParts: Array<Record<string, unknown>> = [];
    const afterToolCalls: Array<Record<string, unknown>> = [];

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];

      if (part.type === "tool-result") {
        toolResultParts.push(part);
        continue;
      }

      if (part.type === "tool-call" && typeof part.toolCallId === "string" && !allToolResultIds.has(part.toolCallId)) {
        toolResultParts.push(makeSyntheticToolResult(part.toolCallId, typeof part.toolName === "string" ? part.toolName : undefined));
        reconstructedResults += 1;
      }

      if (i <= lastToolCallIdx) {
        beforeAndIncluding.push(part);
      } else {
        afterToolCalls.push(part);
      }
    }

    // No tool-results found and no trailing text — keep as-is
    if (toolResultParts.length === 0 && afterToolCalls.length === 0) {
      result.push(message);
      continue;
    }

    // Reorder beforeAndIncluding: text parts must come before all tool-call parts.
    // When tool-result parts are extracted, text blocks that were between tool-call/result
    // pairs end up between tool-call blocks. The Anthropic API treats text between tool_use
    // blocks as a boundary, expecting tool_results for the preceding group immediately.
    // Moving text before tool-calls avoids this: [text, tool_use, tool_use] is valid.
    const textParts = beforeAndIncluding.filter(p => p.type !== "tool-call");
    const toolCallParts = beforeAndIncluding.filter(p => p.type === "tool-call");
    const reorderedParts = [...textParts, ...toolCallParts];

    // Emit assistant message with parts up to and including tool-calls (step 1)
    if (reorderedParts.length > 0) {
      result.push({ ...message, content: reorderedParts as ModelMessage["content"] } as ModelMessage);
    } else {
      result.push({ ...message, content: "[Calling tools...]" } as ModelMessage);
    }

    // Emit tool message with tool-results
    if (toolResultParts.length > 0) {
      splitCount += toolResultParts.length;
      result.push({
        role: "tool",
        content: toolResultParts,
      } as ModelMessage);
    }

    // Emit second assistant message with content after tool-calls (step 2)
    if (afterToolCalls.length > 0) {
      const afterContent = afterToolCalls.length === 1 &&
        afterToolCalls[0].type === "text" && typeof afterToolCalls[0].text === "string"
        ? afterToolCalls[0].text as string
        : afterToolCalls as ModelMessage["content"];
      result.push({ role: "assistant", content: afterContent } as ModelMessage);
    }
  }

  if (splitCount > 0 || reconstructedCalls > 0 || reconstructedResults > 0) {
    console.log(
      `[CHAT API] Claude message splitting: moved ${splitCount} tool-result parts to role:tool messages, ` +
      `reconstructed ${reconstructedCalls} missing tool-calls and ${reconstructedResults} missing tool-results`
    );
  }

  return result;
}
