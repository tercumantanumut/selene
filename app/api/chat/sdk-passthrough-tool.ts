/**
 * AI SDK passthrough executor for tools the Claude Agent SDK runs internally.
 *
 * Only used by the optional "sdk" Claude Code backend. The SDK agent executes
 * Bash/Read/Agent/… and Selene MCP tools itself and streams `tool_use` blocks
 * the AI SDK cannot execute; these executors resolve the real output from the
 * per-request `sdkToolResultBridge` that the streaming provider publishes to.
 *
 * There is intentionally NO wall-clock timeout on the wait. The CLI's own tool
 * lifetimes (10 min foreground Bash, up to 2 h backgrounded, unbounded Agent
 * sub-tasks) exceed any fixed cap; the request abort signal and the stream's
 * end-of-life cancellation (provider `finally`) are the only ways out.
 */
import { tool, jsonSchema, type Tool } from "ai";
import { mcpContextStore } from "@/lib/ai/providers/mcp-context-store";
import { sanitizeToolResultForBase64, attachMediaRefs } from "@/lib/media/base64-extract";
import {
  buildMissingSdkPassthroughOutput,
  normalizeSdkPassthroughOutput,
} from "./sdk-passthrough-normalizer";

// Inputs above this byte threshold are not echoed back verbatim in the SDK
// passthrough fallback — only a small preview + metadata is kept.
const SDK_PASSTHROUGH_LARGE_INPUT_BYTES = (() => {
  const parsed = Number(process.env.SDK_PASSTHROUGH_LARGE_INPUT_BYTES);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 262_144;
})();

export function createSdkPassthroughTool(
  registeredToolName: string,
  options: { sessionId: string },
): Tool {
  const { sessionId } = options;
  return tool({
    description: "Claude Agent SDK passthrough tool (executed internally by the SDK agent)",
    inputSchema: jsonSchema<Record<string, unknown>>({
      type: "object",
      additionalProperties: true,
    }),
    execute: async (args, execOptions) => {
      const serializedArgs = (() => {
        try {
          return JSON.stringify(args ?? {});
        } catch {
          return "";
        }
      })();
      const largeInputMetadata =
        serializedArgs.length > SDK_PASSTHROUGH_LARGE_INPUT_BYTES
          ? {
              _sdkLargeInput: true,
              _sdkLargeInputBytes: serializedArgs.length,
              _sdkLargeInputPreview: serializedArgs.slice(0, 2_000),
            }
          : null;

      const toolCallId =
        execOptions && typeof execOptions === "object" && "toolCallId" in execOptions &&
        typeof (execOptions as { toolCallId?: unknown }).toolCallId === "string"
          ? (execOptions as { toolCallId: string }).toolCallId
          : "";

      const abortSignal =
        execOptions && typeof execOptions === "object" && "abortSignal" in execOptions &&
        (execOptions as { abortSignal?: unknown }).abortSignal instanceof AbortSignal
          ? (execOptions as { abortSignal: AbortSignal }).abortSignal
          : undefined;

      const bridge = mcpContextStore.getStore()?.sdkToolResultBridge;
      if (bridge && toolCallId) {
        try {
          const resolved = await bridge.waitFor(toolCallId, {
            timeoutMs: null,
            abortSignal,
          });
          if (resolved) {
            // Strip base64 image/document envelopes emitted by SDK-native
            // built-ins like Read before the payload reaches the executor.
            const { sanitized, mediaRefs } = await sanitizeToolResultForBase64(
              resolved.output,
              { sessionId, role: "generated" }
            );
            const normalized = normalizeSdkPassthroughOutput(
              resolved.toolName || registeredToolName,
              sanitized,
              args
            );
            const withMediaRefs = attachMediaRefs(normalized, mediaRefs);
            if (largeInputMetadata) {
              return { ...withMediaRefs, ...largeInputMetadata };
            }
            return withMediaRefs;
          }
          console.warn(
            `[CHAT API] SDK passthrough wait ended without result: ${toolCallId} tool=${registeredToolName}`
          );
          return buildMissingSdkPassthroughOutput(registeredToolName, args, {
            reason: `No bridged SDK tool result arrived for toolCallId=${toolCallId}. The SDK stream ended (abort, error, or shutdown) before this tool published a structured result.`,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(
            `[CHAT API] SDK passthrough bridge wait failed: toolCallId=${toolCallId} tool=${registeredToolName} error=${message}`
          );
          return buildMissingSdkPassthroughOutput(registeredToolName, args, {
            reason: `SDK passthrough bridge wait failed for toolCallId=${toolCallId}: ${message}`,
          });
        }
      }

      return { _sdkPassthrough: true, ...(largeInputMetadata ?? {}) };
    },
  });
}
