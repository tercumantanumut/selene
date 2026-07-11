/**
 * Normalizes Claude Agent SDK passthrough tool results into the canonical shape
 * used by persisted tool-result history, and synthesizes a structured error
 * result when the SDK never publishes a concrete result. Used only by the
 * optional "sdk" Claude Code backend.
 */
import { normalizeToolResultOutput } from "@/lib/ai/tool-result-utils";

function toCanonicalToolName(name: string): string {
  const match = /^mcp__.+?__(.+)$/.exec(name);
  return match?.[1] || name;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function buildMissingBashHints(input: unknown): string[] {
  const args = getRecord(input);
  if (!args) return [];

  const hints: string[] = [];
  const command = typeof args.command === "string" ? args.command : "";

  if (/<<\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/m.test(command)) {
    hints.push(
      "The command uses POSIX heredoc syntax (`<<...`), which often fails when the active shell is `cmd.exe` or another non-POSIX wrapper. Use `python -c`, write a temporary script file, or run it in a POSIX shell."
    );
  }

  if ("action" in args || "processId" in args) {
    hints.push(
      "For a normal `Bash` command, omit `action` and `processId`. Those fields are only for background-process management calls."
    );
  }

  if (hints.length === 0) {
    hints.push(
      "Retry with simpler quoting and avoid shell-specific syntax that may not be supported by the current shell wrapper."
    );
  }

  return hints;
}

/**
 * Normalize Claude SDK passthrough outputs into the same canonical shape
 * used by persisted tool-result history.
 */
export function normalizeSdkPassthroughOutput(
  toolName: string,
  output: unknown,
  input: unknown
): Record<string, unknown> {
  const normalizedToolName = toCanonicalToolName(toolName || "tool");
  return normalizeToolResultOutput(normalizedToolName, output, input, {
    mode: "canonical",
  }).output;
}

/**
 * Build a structured error result when the Claude SDK never publishes a
 * concrete tool result back to the AI SDK passthrough layer.
 */
export function buildMissingSdkPassthroughOutput(
  toolName: string,
  input: unknown,
  options?: { reason?: string }
): Record<string, unknown> {
  const normalizedToolName = toCanonicalToolName(toolName || "tool");
  const details: string[] = [];

  if (options?.reason) {
    details.push(`Runtime detail: ${options.reason}`);
  }

  if (normalizedToolName === "Bash") {
    details.push(...buildMissingBashHints(input));
  }

  const output: Record<string, unknown> = {
    status: "error",
    error: `${normalizedToolName} failed before the Claude Code SDK returned a structured tool result.`,
    sdkPassthroughMissing: true,
  };

  const inputRecord = getRecord(input);
  if (normalizedToolName === "Bash" && typeof inputRecord?.command === "string") {
    output.command = inputRecord.command;
  }

  if (details.length > 0) {
    output.stderr = details.join("\n");
  }

  return normalizeToolResultOutput(normalizedToolName, output, input, {
    mode: "canonical",
  }).output;
}
