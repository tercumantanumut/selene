/**
 * DeepSeek Model Definitions
 *
 * DeepSeek V4 is DeepSeek AI's flagship model family with:
 * - 1M context window (1,048,576 tokens)
 * - 384K max output tokens
 * - Hybrid attention (CSA + HCA) for long-context efficiency
 * - Thinking/reasoning modes with configurable reasoning_effort
 * - Strong coding and agentic capabilities
 *
 * API: OpenAI-compatible at https://api.deepseek.com
 * Anthropic-format: https://api.deepseek.com/anthropic
 *
 * Legacy aliases (deprecated 2026/07/24):
 * - deepseek-chat   -> non-thinking mode of deepseek-v4-flash
 * - deepseek-reasoner -> thinking mode of deepseek-v4-flash
 */

export const DEEPSEEK_MODEL_IDS = [
  // V4 flagship (recommended)
  "deepseek-v4-pro",
  "deepseek-v4-flash",

  // Legacy aliases (to be deprecated 2026/07/24)
  "deepseek-chat",
  "deepseek-reasoner",
] as const;

type DeepSeekModelId = (typeof DEEPSEEK_MODEL_IDS)[number];

// Models that enable thinking/reasoning mode by default
const DEEPSEEK_THINKING_ENABLED_MODELS = new Set<string>([
  "deepseek-v4-pro",
  "deepseek-reasoner",
]);

// DeepSeek currently rejects the OpenAI-compatible `tool_choice` field for its
// reasoning-mode models even though they otherwise support tool calls.
const DEEPSEEK_MODELS_WITHOUT_TOOL_CHOICE = new Set<string>([
  "deepseek-v4-pro",
  "deepseek-reasoner",
]);

// Models that explicitly disable thinking mode
const DEEPSEEK_THINKING_DISABLED_MODELS = new Set<string>([
  "deepseek-v4-flash",
  "deepseek-chat",
]);

// DeepSeek's text/tool-use chat endpoint at /chat/completions rejects
// `image_url` content parts ("unknown variant `image_url`"). Vision inputs
// are served through a separate Janus family that Selene does not wire up
// here. Until that integration lands, mark all DeepSeek chat models as
// text-only so the outbound request pipeline strips image parts before
// sending.
const DEEPSEEK_VISION_MODELS = new Set<string>([]);

// Default models for different roles.
// NOTE: `vision` is intentionally absent — DeepSeek's /chat/completions endpoint
// rejects `image_url` content parts ("unknown variant"). See DEEPSEEK_VISION_MODELS
// above. When DeepSeek is the active provider and a user attaches an image,
// message-prep strips the image and routes the model to `describeImage`, which
// requires a vision-capable provider configured elsewhere (or a Claude API key
// fallback). Re-add a vision default here ONLY if Janus-family vision gets wired
// into this adapter.
const DEEPSEEK_DEFAULT_MODELS = {
  chat: "deepseek-v4-pro" as DeepSeekModelId,
  research: "deepseek-v4-pro" as DeepSeekModelId,
  utility: "deepseek-v4-flash" as DeepSeekModelId,
};

// DeepSeek API configuration
export const DEEPSEEK_CONFIG = {
  BASE_URL: "https://api.deepseek.com",
  ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
  BETA_URL: "https://api.deepseek.com/beta",
  DEFAULT_TEMPERATURE: 0.6,
  // Default reasoning_effort for thinking-enabled models
  DEFAULT_REASONING_EFFORT: "high" as const,
  // Max context window shared by all V4 models
  MAX_CONTEXT_TOKENS: 1_048_576,
  MAX_OUTPUT_TOKENS: 393_216, // 384K
} as const;

// Model display names
const MODEL_LABELS: Record<string, string> = {
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "deepseek-chat": "DeepSeek Chat (legacy)",
  "deepseek-reasoner": "DeepSeek Reasoner (legacy)",
};

/**
 * Get display name for a DeepSeek model
 */
function getDeepSeekModelDisplayName(modelId: string): string {
  return MODEL_LABELS[modelId] || modelId;
}

/**
 * Get all DeepSeek models with display names
 */
export function getDeepSeekModels(): Array<{ id: DeepSeekModelId; name: string }> {
  return DEEPSEEK_MODEL_IDS.map((id) => ({
    id,
    name: getDeepSeekModelDisplayName(id),
  }));
}

/**
 * Determine whether a model should run with thinking/reasoning mode enabled
 */
export function deepseekModelHasThinkingEnabled(modelId: string): boolean {
  return DEEPSEEK_THINKING_ENABLED_MODELS.has(modelId);
}

/**
 * Determine whether a model should explicitly disable thinking mode
 */
export function deepseekModelHasThinkingDisabled(modelId: string): boolean {
  return DEEPSEEK_THINKING_DISABLED_MODELS.has(modelId);
}

/**
 * Check if a DeepSeek model supports vision inputs
 */
export function deepseekModelSupportsVision(modelId: string): boolean {
  return DEEPSEEK_VISION_MODELS.has(modelId);
}

/**
 * Check if a DeepSeek model supports thinking at all
 */
export function deepseekModelSupportsThinking(modelId: string): boolean {
  return (
    DEEPSEEK_THINKING_ENABLED_MODELS.has(modelId) ||
    DEEPSEEK_THINKING_DISABLED_MODELS.has(modelId)
  );
}

/**
 * Check whether a DeepSeek model accepts OpenAI-compatible `tool_choice`.
 */
export function deepseekModelSupportsToolChoice(modelId: string): boolean {
  return !DEEPSEEK_MODELS_WITHOUT_TOOL_CHOICE.has(modelId);
}

export type { DeepSeekModelId };
export { DEEPSEEK_DEFAULT_MODELS };
