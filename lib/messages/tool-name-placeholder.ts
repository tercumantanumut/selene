export const UNKNOWN_TOOL_NAME = "__unknown_tool__";

export function isMissingOrPlaceholderToolName(value: unknown): boolean {
  if (typeof value !== "string") {
    return true;
  }

  const normalized = value.trim();
  return (
    normalized.length === 0 ||
    normalized === "tool" ||
    normalized === "unknown_tool" ||
    normalized === UNKNOWN_TOOL_NAME
  );
}

export function toStructuredToolName(value: unknown): string {
  if (typeof value !== "string") {
    return UNKNOWN_TOOL_NAME;
  }

  const normalized = value.trim();
  return isMissingOrPlaceholderToolName(normalized)
    ? UNKNOWN_TOOL_NAME
    : normalized;
}

export function toDisplayToolName(value: unknown, fallback = "tool"): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim();
  return isMissingOrPlaceholderToolName(normalized) ? fallback : normalized;
}
