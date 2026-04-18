import type { LivePromptEntry } from "./live-prompt-queue-registry";
import {
  buildInspectPromptText,
  sanitizeInspectMessageContext,
} from "@/lib/design/workspace/inspect-context";

function sanitizeDelegationCompletionEntry(entry: LivePromptEntry): string {
  // The entry content already contains the full <delegation-result> XML
  // with the subagent's actual response — pass it through directly.
  // The model can read the result inline without calling observe().
  return [
    `[Delegation result delivered — integrate this into your response]`,
    entry.content,
    "If other delegations are still running, wait for them. Once all are complete, synthesize a final response.",
  ].join("\n");
}

function buildDelegationCompletionInstruction(entries: LivePromptEntry[]): string {
  return entries.map((entry) => sanitizeDelegationCompletionEntry(entry)).join("\n\n");
}

function buildGenericInstructionText(entry: LivePromptEntry, index: number): string {
  const inspectContext = sanitizeInspectMessageContext(entry.metadata?.inspectContext);
  const inspectPromptText = buildInspectPromptText(inspectContext);
  const messageText = sanitizeLivePromptContent(entry.content);
  const lines = [`Instruction ${index + 1}:`];

  if (inspectPromptText) {
    lines.push(inspectPromptText);
  }

  lines.push(`Message: ${messageText}`);
  return lines.join("\n");
}

const STOP_INTENT_PATTERNS = [
  /^stop\b/i,
  /^cancel\b/i,
  /^halt\b/i,
  /^abort\b/i,
  /^wait\b/i,
  /^pause\b/i,
  /^nevermind\b/i,
  /^never mind\b/i,
];

// When the user starts with a stop-word but follows it with a redirect
// marker, they are pivoting the task rather than asking the agent to halt.
// Example: "nevermind, lets check X instead of Y" — the agent should drop
// the current task and take on the new one, not wrap up with
// "Stopping here as requested." Without this guard, Claude Code's
// pumpLivePromptQueue routes the redirect through buildStopSystemMessage
// ([STOP REQUESTED BY USER] ... Do not start any new tasks or tool calls),
// producing a phantom stop the user never asked for.
// `let's` / `let\u2019s` (smart-quote) and `let s` (no apostrophe) are all
// valid colloquial pivots — match all three by treating the apostrophe as
// optional and accepting either ASCII (') or RIGHT SINGLE QUOTATION MARK
// (\u2019, the character iOS/macOS auto-substitute when users type ').
const REDIRECT_MARKERS =
  /\b(instead|let[\u2019']?s|rather|switch\s+to|change\s+to|do\s+this\s+instead|actually\s+(?:do|check|search|use|try|look))\b/i;

/** Returns true if the message content signals the user wants to stop the current run. */
export function hasStopIntent(content: string): boolean {
  const trimmed = content.trim();
  if (!STOP_INTENT_PATTERNS.some(pattern => pattern.test(trimmed))) {
    return false;
  }
  // Redirect wins over stop: "nevermind, let's do X instead" is a pivot,
  // not a halt. Only classify as stop when no redirection markers are
  // present.
  if (REDIRECT_MARKERS.test(trimmed)) {
    return false;
  }
  return true;
}

/**
 * Sanitize user-provided content before injecting into the model context.
 * Strips prompt-injection attempts and caps length.
 */
export function sanitizeLivePromptContent(content: string): string {
  return content
    .replace(/\[SYSTEM:/gi, "[USER-INJECTED:")
    .replace(/<\/?system>/gi, "")
    .trim()
    .slice(0, 2000);
}

/**
 * Build the text injected as a user message when the user sends mid-run instructions.
 * Formatted so the model understands these arrived while it was working.
 */
export function buildUserInjectionContent(entries: LivePromptEntry[]): string {
  if (entries.length === 0) return "";

  const delegationCompletions = entries.filter(
    (entry) => entry.metadata?.kind === "delegation_completion" && entry.metadata?.delegationId,
  );
  if (delegationCompletions.length > 0 && delegationCompletions.length === entries.length) {
    return buildDelegationCompletionInstruction(delegationCompletions);
  }

  const sections = entries.map((entry, index) => buildGenericInstructionText(entry, index));

  return [
    "[Mid-run instruction(s) from user — received while you were processing a tool step]",
    ...sections,
    "Please acknowledge and incorporate these into your current work.",
  ].join("\n\n");
}

/**
 * Build a system-level stop message for when the user requests the run to halt.
 * Returned as the `system` field in prepareStep to signal the model to wrap up.
 */
export function buildStopSystemMessage(entries: LivePromptEntry[]): string {
  const stopMessages = entries
    .filter(e => e.stopIntent)
    .map(e => sanitizeLivePromptContent(e.content))
    .join("; ");

  return [
    "[STOP REQUESTED BY USER]",
    `The user has asked you to stop: "${stopMessages || "stop"}"`,
    "Please wrap up gracefully. Do not start any new tasks or tool calls.",
  ].join("\n");
}
