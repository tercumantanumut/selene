/**
 * Moonshot Kimi Model Definitions
 *
 * Kimi K2.6 is Moonshot AI's flagship multimodal model with:
 * - 256K context window
 * - Native vision support
 * - Thinking/reasoning modes
 * - Native video understanding
 * - Strong agentic capabilities
 *
 * Kimi K2.7 Code is Moonshot AI's current coding-specialized line.
 *
 * API: OpenAI-compatible at https://api.moonshot.ai/v1
 */

export const KIMI_MODEL_IDS = [
  // Primary multimodal model (recommended)
  "kimi-k2.6",

  // Previous flagship multimodal model
  "kimi-k2.5",

  // Latest coding models
  "kimi-k2.7-code",
  "kimi-k2.7-code-highspeed",
  "kimi-k2.6-code-preview",

  // K2 generation models
  "kimi-k2-0905-preview",
  "kimi-k2-0711-preview",
  "kimi-k2-turbo-preview",

  // Thinking models (deep reasoning)
  "kimi-k2-thinking",
  "kimi-k2-thinking-turbo",

  // Legacy moonshot-v1 models (text only)
  "moonshot-v1-8k",
  "moonshot-v1-32k",
  "moonshot-v1-128k",

  // Legacy vision models
  "moonshot-v1-8k-vision-preview",
  "moonshot-v1-32k-vision-preview",
  "moonshot-v1-128k-vision-preview",
] as const;

type KimiModelId = (typeof KIMI_MODEL_IDS)[number];

// Models that support vision
const KIMI_VISION_MODELS = new Set<string>([
  "kimi-k2.6",
  "kimi-k2.5",
  "moonshot-v1-8k-vision-preview",
  "moonshot-v1-32k-vision-preview",
  "moonshot-v1-128k-vision-preview",
]);

// Models that support thinking mode
const KIMI_THINKING_MODELS = new Set<string>([
  "kimi-k2.7-code",
  "kimi-k2.7-code-highspeed",
  "kimi-k2.6",
  "kimi-k2.5",
  "kimi-k2-thinking",
  "kimi-k2-thinking-turbo",
]);

// Default models for different roles
const KIMI_DEFAULT_MODELS = {
  chat: "kimi-k2.6" as KimiModelId,
  research: "kimi-k2.6" as KimiModelId,
  vision: "kimi-k2.6" as KimiModelId,
  utility: "kimi-k2-turbo-preview" as KimiModelId,
};

// Kimi API configuration
export const KIMI_CONFIG = {
  BASE_URL: "https://api.moonshot.ai/v1",
  DEFAULT_TEMPERATURE: 0.6,
  // K2.5 uses fixed temperature 1.0 in thinking mode
  THINKING_TEMPERATURE: 1.0,
} as const;

// Model display names
const MODEL_LABELS: Record<string, string> = {
  "kimi-k2.6": "Kimi K2.6",
  "kimi-k2.5": "Kimi K2.5",
  "kimi-k2.7-code": "Kimi K2.7 Code",
  "kimi-k2.7-code-highspeed": "Kimi K2.7 Code HighSpeed",
  "kimi-k2.6-code-preview": "Kimi K2.6 Code Preview",
  "kimi-k2-0905-preview": "Kimi K2 (0905)",
  "kimi-k2-0711-preview": "Kimi K2 (0711)",
  "kimi-k2-turbo-preview": "Kimi K2 Turbo",
  "kimi-k2-thinking": "Kimi K2 Thinking",
  "kimi-k2-thinking-turbo": "Kimi K2 Thinking Turbo",
  "moonshot-v1-8k": "Moonshot V1 8K",
  "moonshot-v1-32k": "Moonshot V1 32K",
  "moonshot-v1-128k": "Moonshot V1 128K",
  "moonshot-v1-8k-vision-preview": "Moonshot V1 8K Vision",
  "moonshot-v1-32k-vision-preview": "Moonshot V1 32K Vision",
  "moonshot-v1-128k-vision-preview": "Moonshot V1 128K Vision",
};

/**
 * Get display name for a Kimi model
 */
function getKimiModelDisplayName(modelId: string): string {
  return MODEL_LABELS[modelId] || modelId;
}

/**
 * Get all Kimi models with display names
 */
export function getKimiModels(): Array<{ id: KimiModelId; name: string }> {
  return KIMI_MODEL_IDS.map((id) => ({
    id,
    name: getKimiModelDisplayName(id),
  }));
}

/**
 * Check if a model supports vision
 */
function kimiModelSupportsVision(modelId: string): boolean {
  return KIMI_VISION_MODELS.has(modelId);
}

/**
 * Check if a model supports thinking mode
 */
function kimiModelSupportsThinking(modelId: string): boolean {
  return KIMI_THINKING_MODELS.has(modelId);
}
