/**
 * Shared think-tag model patterns.
 *
 * Both the think-tag streaming middleware (`think-tag-stream.ts`) and the
 * think-tag text filter (`think-tag-filter.ts`) need to know which models
 * emit raw `<think>` tags. This module is the single source of truth for
 * those patterns so the two lists can never diverge.
 */

/**
 * Model-name substrings known to emit `<think>` / `<thinking>` tags.
 * Case-insensitive substring matching is used against the model ID.
 *
 * NOTE: `r1` is handled separately via {@link isR1Model} to avoid
 * false positives on model names that incidentally contain "r1".
 */
const THINK_TAG_MODEL_PATTERNS = [
  "deepseek",
  "minimax",
  "qwq",
  "qwen",
] as const;

/**
 * Matches model IDs that represent R1-family models.
 *
 * Requires a word boundary: the string must start with "r1", or "r1" must
 * be preceded by `-`, `:`, or `/`.
 *
 * Examples that match:  "r1", "deepseek-r1", "deepseek-r1:14b", "kimi-r1-preview"
 * Examples that don't:  "llama3.1", "gemma3:latest", "gpt4r1x"
 */
const R1_PATTERN = /(?:^|[-:/])r1(?:$|[-:/])/i;

function isR1Model(modelId: string): boolean {
  return R1_PATTERN.test(modelId);
}

/**
 * Returns `true` if the given model ID matches any known think-tag model
 * pattern (case-insensitive).
 */
export function isThinkTagModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return (
    THINK_TAG_MODEL_PATTERNS.some((p) => lower.includes(p)) ||
    isR1Model(lower)
  );
}
