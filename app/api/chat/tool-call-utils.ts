import { normalizeToolResultOutput } from "@/lib/ai/tool-result-utils";
import { toStructuredToolName } from "@/lib/messages/tool-name-placeholder";

export function reconcileToolCallPairs(
  parts: Array<{
    type: string;
    text?: string;
    image?: string;
    toolCallId?: string;
    toolName?: string;
    input?: unknown;
    output?: unknown;
  }>
): Array<{
  type: string;
  text?: string;
  image?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
}> {
  const normalized: Array<{
    type: string;
    text?: string;
    image?: string;
    toolCallId?: string;
    toolName?: string;
    input?: unknown;
    output?: unknown;
  }> = [];
  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();

  let reconstructedCalls = 0;
  let reconstructedResults = 0;

  for (const part of parts) {
    if (part.type === "tool-result" && typeof part.toolCallId === "string") {
      if (!toolCallIds.has(part.toolCallId)) {
        normalized.push({
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: toStructuredToolName(part.toolName),
          input: {
            __reconstructed: true,
            reason: "missing_tool_call_in_history",
          },
        });
        toolCallIds.add(part.toolCallId);
        reconstructedCalls += 1;
      }
      toolResultIds.add(part.toolCallId);
      normalized.push(part);
      continue;
    }

    if (part.type === "tool-call" && typeof part.toolCallId === "string") {
      toolCallIds.add(part.toolCallId);
    }

    normalized.push(part);
  }

  for (const toolCallId of toolCallIds) {
    if (toolResultIds.has(toolCallId)) continue;
    const callPart = normalized.find(
      (part) => part.type === "tool-call" && part.toolCallId === toolCallId
    );
    normalized.push({
      type: "tool-result",
      toolCallId,
      toolName: toStructuredToolName(callPart?.toolName),
      output: toModelToolResultOutput({
        status: "error",
        error: "Tool execution did not return a persisted result in history.",
        reconstructed: true,
      }),
    });
    reconstructedResults += 1;
  }

  if (reconstructedCalls > 0 || reconstructedResults > 0) {
    console.warn(
      `[CHAT API] Reconciled tool call/result pairs before model send: ` +
      `reconstructedCalls=${reconstructedCalls}, reconstructedResults=${reconstructedResults}`
    );
  }

  return normalized;
}

export function toModelToolResultOutput(
  output: unknown
): { type: "text"; value: string } | { type: "json"; value: unknown } {
  if (typeof output === "string") {
    return { type: "text", value: output };
  }

  // Ensure payload stays JSON-serializable for ModelMessage validation.
  try {
    return { type: "json", value: JSON.parse(JSON.stringify(output ?? null)) };
  } catch {
    return {
      type: "json",
      value: { status: "error", error: "Tool result was not JSON-serializable." },
    };
  }
}

export function normalizeToolCallInput(
  input: unknown,
  toolName: string,
  toolCallId: string
): Record<string, unknown> | null {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch (error) {
      console.warn(
        `[CHAT API] Invalid tool call input for ${toolName} (${toolCallId}): ${String(error)}`
      );
      return null;
    }
  }
  console.warn(
    `[CHAT API] Skipping tool call ${toolName} (${toolCallId}) with non-object input`
  );
  return null;
}

/**
 * Sanitize numeric values in parsed JSON args after repair.
 * Replaces Infinity, -Infinity, NaN, and absurdly large numbers with null.
 * This prevents degenerate model output (e.g., repeated digits producing
 * Infinity for endLine) from causing downstream tool execution blowups.
 */
function sanitizeNumericValues(obj: Record<string, unknown>): Record<string, unknown> {
  // No realistic tool parameter exceeds 1e15 (1 quadrillion).
  // File line numbers, timeouts, counts — all well under this.
  const MAX_SANE_NUMBER = 1e15;

  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Math.abs(value) > MAX_SANE_NUMBER) {
        console.warn(
          `[CHAT API] Sanitized degenerate numeric value in repaired JSON: ${key}=${value} → null`
        );
        obj[key] = null;
      }
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] === "number") {
          if (!Number.isFinite(value[i] as number) || Math.abs(value[i] as number) > MAX_SANE_NUMBER) {
            value[i] = null;
          }
        } else if (value[i] && typeof value[i] === "object" && !Array.isArray(value[i])) {
          sanitizeNumericValues(value[i] as Record<string, unknown>);
        }
      }
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      sanitizeNumericValues(value as Record<string, unknown>);
    }
  }
  return obj;
}

/**
 * Attempt to repair truncated JSON from streaming tool calls.
 * Handles common patterns where the stream was interrupted mid-JSON:
 * - Missing closing braces/brackets: {"command": "python", "args": ["-c"
 * - Truncated string values: {"command": "python", "args": ["-c", "from PIL
 * Returns parsed object or null if repair is not possible.
 *
 * After successful repair, numeric values are sanitized to catch degenerate
 * model output (e.g., token repetition producing astronomically large numbers).
 */
export function attemptJsonRepair(malformedJson: string): Record<string, unknown> | null {
  if (!malformedJson || malformedJson.trim().length === 0) {
    return null;
  }

  const trimmed = malformedJson.trim();

  // If it doesn't start with {, it's not a recoverable JSON object
  if (!trimmed.startsWith("{")) {
    return null;
  }

  // Strategy: Track string/escape state and count open braces/brackets,
  // then append the necessary closing characters.
  let inString = false;
  let escapeNext = false;
  const stack: string[] = [];

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === "\\") {
      if (inString) escapeNext = true;
      continue;
    }

    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
    } else if (char === "}" || char === "]") {
      if (stack.length > 0 && stack[stack.length - 1] === char) {
        stack.pop();
      }
    }
  }

  // If nothing is unclosed, the JSON is structurally complete but still
  // failed to parse — we can't repair syntax errors, only truncation.
  if (stack.length === 0 && !inString) {
    return null;
  }

  // Build a repaired string: close any open string, then close brackets/braces
  let repaired = trimmed;
  if (inString) {
    repaired += '"';
  }
  // Close all open brackets/braces in reverse order
  while (stack.length > 0) {
    repaired += stack.pop();
  }

  try {
    const parsed = JSON.parse(repaired);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return sanitizeNumericValues(parsed as Record<string, unknown>);
    }
  } catch {
    // Repair attempt didn't produce valid JSON
  }

  return null;
}

// Re-export normalizeToolResultOutput so content-extractor.ts can import from one place
{ normalizeToolResultOutput };
