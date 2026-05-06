/**
 * LLM Provider Type
 *
 * Extracted here to break the circular dependency between
 * providers.ts (which imports model-validation.ts) and
 * model-validation.ts (which needs the LLMProvider type).
 *
 * Both files import LLMProvider from this module.
 */

export type LLMProvider =
  | "anthropic"
  | "openrouter"
  | "antigravity"
  | "codex"
  | "kimi"
  | "ollama"
  | "claudecode"
  | "minimax"
  | "blackboxai"
  | "deepseek"
  | "vllm";

/** Providers whose chat endpoint does not accept user-message image parts. */
export const PROVIDERS_REJECTING_INLINE_IMAGES: ReadonlySet<LLMProvider> =
  new Set<LLMProvider>(["deepseek"]);

/** Providers that can receive image blocks directly inside tool-result content. */
export const PROVIDERS_SUPPORTING_IMAGE_TOOL_RESULTS: ReadonlySet<LLMProvider> =
  new Set<LLMProvider>(["anthropic", "claudecode"]);

/**
 * Returns true when the outbound chat-completions endpoint of `provider`
 * will reject `image_url` content parts. Used by both the server-side
 * prep pipeline and the composer UI to stay in sync.
 *
 * Accepts `string | null | undefined` so callers can pass raw settings
 * values without narrowing first; unknown providers are treated as
 * image-capable (safe default — if we're wrong the backend will still
 * log the strip).
 */
export function providerRejectsInlineImages(
  provider: string | null | undefined,
): boolean {
  if (!provider) return false;
  return PROVIDERS_REJECTING_INLINE_IMAGES.has(provider as LLMProvider);
}

export function providerSupportsUserImageParts(
  provider: string | null | undefined,
): boolean {
  return !providerRejectsInlineImages(provider);
}

export function providerSupportsImageToolResults(
  provider: string | null | undefined,
): boolean {
  if (!provider) return false;
  return PROVIDERS_SUPPORTING_IMAGE_TOOL_RESULTS.has(provider as LLMProvider);
}

export function providerRequiresTextOnlyImageReads(
  provider: string | null | undefined,
): boolean {
  return providerRejectsInlineImages(provider);
}

export function getReadFileImageUnsupportedMessage(
  provider: string | null | undefined,
): string {
  const label = provider || "the selected provider";
  return `${label} cannot view images in Selene. Switch to a vision-capable model to inspect this file.`;
}
