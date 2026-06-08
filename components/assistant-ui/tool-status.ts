import type { ToolCallBadgeStatus } from "./tool-call-badge";

interface ToolStatusPartLike {
  status?: { type?: string } | null;
  result?: unknown;
  isError?: boolean;
}

export function getToolBadgeStatus(part: ToolStatusPartLike): ToolCallBadgeStatus {
  if (part.isError) return "error";

  const hasResult = part.result != null;
  const result =
    hasResult && typeof part.result === "object"
      ? (part.result as Record<string, unknown>)
      : undefined;
  const status = typeof result?.status === "string" ? result.status.toLowerCase() : undefined;
  const resultIndicatesError =
    status === "error" || status === "failed" || status === "denied" || typeof result?.error === "string";

  if (hasResult) {
    if (resultIndicatesError) return "error";
    if (status === "processing" || status === "running") return "running";
    return "completed";
  }

  // assistant-ui applies the parent message status to unresolved tool calls.
  // `incomplete` here means the assistant turn ended early, not that the tool failed.
  if (part.status?.type === "running" || part.status?.type === "requires-action" || part.status?.type === "incomplete") {
    return "running";
  }

  return "running";
}
