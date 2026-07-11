/**
 * Context Window Provider Limits
 *
 * Defines context window configurations for all supported LLM providers and models.
 * Parses context window strings from model-catalog.ts and provides threshold configurations.
 *
 * @see docs/CONTEXT_WINDOW_MANAGEMENT_DESIGN.md
 */

import type { LLMProvider } from "@/lib/ai/providers";
import { normalizeCodexModel } from "@/lib/auth/codex-models";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextWindowConfig {
  /** Maximum tokens for this model's context window */
  maxTokens: number;
  /**
   * Provider-enforced prompt/input budget. Some models advertise a larger total
   * context than the API accepts as request input once output is reserved.
   */
  maxInputTokens?: number;
  /** Maximum output budget for the model, when known */
  maxOutputTokens?: number;
  /** Percentage threshold to trigger warning (e.g., 0.75 = 75%) */
  warningThreshold: number;
  /** Percentage threshold to force compaction (e.g., 0.90 = 90%) */
  criticalThreshold: number;
  /** Percentage threshold that blocks requests (e.g., 0.95 = 95%) */
  hardLimit: number;
  /** Whether this model supports streaming responses */
  supportsStreaming: boolean;
  /** Minimum messages required before compaction is allowed */
  minMessagesForCompaction: number;
  /** Number of recent messages to always keep uncompacted */
  keepRecentMessages: number;
}

// ---------------------------------------------------------------------------
// Context Window Parsing
// ---------------------------------------------------------------------------

/**
 * Parse context window string (e.g., "200K", "1M", "128K") to numeric tokens
 */
function parseContextWindowString(contextWindow: string): number {
  if (!contextWindow) return 128000; // Default fallback

  const normalized = contextWindow.toUpperCase().trim();

  // Handle "1M" format
  if (normalized.endsWith("M")) {
    const value = parseFloat(normalized.slice(0, -1));
    return value * 1_000_000;
  }

  // Handle "200K" format
  if (normalized.endsWith("K")) {
    const value = parseFloat(normalized.slice(0, -1));
    return value * 1_000;
  }

  // Handle raw numbers
  const parsed = parseInt(normalized, 10);
  return isNaN(parsed) ? 128000 : parsed;
}

// ---------------------------------------------------------------------------
// Default Configuration
// ---------------------------------------------------------------------------

const DEFAULT_CONTEXT_CONFIG: ContextWindowConfig = {
  maxTokens: 128000, // 128K - conservative default for unknown models
  warningThreshold: 0.75, // 75% - trigger background compaction
  criticalThreshold: 0.90, // 90% - force compaction before request
  hardLimit: 0.95, // 95% - block request, require compaction
  supportsStreaming: true,
  minMessagesForCompaction: 3, // Lowered from 10 to allow sparse long-running sessions
  keepRecentMessages: 6,
};

const CODEX_GPT_55_TOTAL_TOKENS = 1_000_000;
const CODEX_GPT_55_MAX_INPUT_TOKENS = 276_000;
const CODEX_GPT_55_MAX_OUTPUT_TOKENS = 128_000;
const CODEX_GPT_55_THRESHOLDS = {
  // Trigger at 95% with 5% headroom before the provider's real input cap.
  warningThreshold: 0.80,
  criticalThreshold: 0.95,
  hardLimit: 0.95,
};

const CODEX_GPT_55_CONTEXT_CONFIG: Partial<ContextWindowConfig> = {
  maxTokens: CODEX_GPT_55_TOTAL_TOKENS,
  maxInputTokens: CODEX_GPT_55_MAX_INPUT_TOKENS,
  maxOutputTokens: CODEX_GPT_55_MAX_OUTPUT_TOKENS,
  supportsStreaming: true,
  ...CODEX_GPT_55_THRESHOLDS,
};

// ---------------------------------------------------------------------------
// Provider Default Limits
// ---------------------------------------------------------------------------

/**
 * Default context window limits per provider.
 * Used when model-specific limits are not available.
 */
export const PROVIDER_DEFAULT_LIMITS: Record<LLMProvider, number> = {
  anthropic: 200000, // 200K for all Claude models (standard context window per Anthropic docs)
  claudecode: 200000, // 200K for Claude Code (Claude Opus 4.6 = 200K standard)
  antigravity: 200000, // Claude-based models = 200K; Gemini models use model-specific overrides
  openrouter: 128000, // Varies widely, conservative default
  codex: 400000, // Mixed provider; keep legacy-safe default and override GPT-5.4 explicitly
  kimi: 128000, // Kimi K2 models range 128K-256K
  minimax: 80000, // MiniMax M2.1 models with 80K context
  blackboxai: 128000, // BlackBox AI default context
  deepseek: 1_048_576, // DeepSeek V4 series — 1M context, 384K max output
  ollama: 32000, // Local models typically have smaller context
  vllm: 32000, // vLLM models vary; conservative default, override per model
};

// ---------------------------------------------------------------------------
// Model-Specific Configurations
// ---------------------------------------------------------------------------

/**
 * Model-specific context window configurations.
 * Overrides defaults for known models with specific limits.
 */
const MODEL_CONTEXT_CONFIGS: Record<string, Partial<ContextWindowConfig>> = {
  // Anthropic Direct — 200K standard context window per Anthropic docs
  // (1M available only via opt-in beta header "context-1m-2025-08-07")
  "claude-sonnet-4-6": {
    maxTokens: 200000,
    supportsStreaming: true,
  },
  "claude-sonnet-4-5-20250929": {
    maxTokens: 200000,
    supportsStreaming: true,
  },
  "claude-haiku-4-5-20251001": {
    maxTokens: 200000,
    supportsStreaming: true,
  },

  // Claude Code — Opus 4.8 / 4.7 / 4.6 and Fable 5 have 1M context via Dario.
  "claude-opus-4-8": {
    maxTokens: 1000000,
    supportsStreaming: true,
    warningThreshold: 0.80,
    criticalThreshold: 0.92,
    hardLimit: 0.97,
  },
  "claude-opus-4-7": {
    maxTokens: 1000000,
    supportsStreaming: true,
    warningThreshold: 0.80,
    criticalThreshold: 0.92,
    hardLimit: 0.97,
  },
  "claude-opus-4-6": {
    maxTokens: 1000000,
    supportsStreaming: true,
    warningThreshold: 0.80,
    criticalThreshold: 0.92,
    hardLimit: 0.97,
  },
  "claude-fable-5": {
    maxTokens: 1000000,
    supportsStreaming: true,
    warningThreshold: 0.80,
    criticalThreshold: 0.92,
    hardLimit: 0.97,
  },

  // Antigravity (Claude-based) — standard 200K context
  "claude-opus-4-6-thinking": {
    maxTokens: 200000,
    supportsStreaming: true,
  },

  // Antigravity (Gemini-based) - Large context windows
  "gemini-3.1-pro-high": {
    maxTokens: 1000000, // 1M tokens
    supportsStreaming: true,
    warningThreshold: 0.80, // Higher threshold for large context
    criticalThreshold: 0.92,
    hardLimit: 0.97,
  },
  "gemini-3.1-pro-low": {
    maxTokens: 1000000,
    supportsStreaming: true,
    warningThreshold: 0.80,
    criticalThreshold: 0.92,
    hardLimit: 0.97,
  },
  "gemini-3-flash": {
    maxTokens: 1000000,
    supportsStreaming: true,
    warningThreshold: 0.80,
    criticalThreshold: 0.92,
    hardLimit: 0.97,
  },

  // Antigravity (GPT-based)
  "gpt-oss-120b-medium": {
    maxTokens: 128000,
    supportsStreaming: true,
  },

  // Codex GPT-5.6 family (372K context)
  "gpt-5.6-sol": {
    maxTokens: 372000,
    supportsStreaming: true,
  },
  "gpt-5.6-terra": {
    maxTokens: 372000,
    supportsStreaming: true,
  },
  "gpt-5.6-luna": {
    maxTokens: 372000,
    supportsStreaming: true,
  },
  // Codex (GPT-5.5 — 1M total, but provider currently accepts ~276K input + 128K output)
  "gpt-5.5": {
    ...CODEX_GPT_55_CONTEXT_CONFIG,
  },
  "gpt-5.5-pro": {
    ...CODEX_GPT_55_CONTEXT_CONFIG,
  },
  // Codex (GPT-5.4 — 1M context)
  "gpt-5.4": {
    maxTokens: 1000000,
    supportsStreaming: true,
    warningThreshold: 0.80,
    criticalThreshold: 0.92,
    hardLimit: 0.97,
  },
  // Codex (GPT-5 legacy models — 400K context)
  "gpt-5.3-codex": {
    maxTokens: 400000,
    supportsStreaming: true,
  },
  "gpt-5.2-codex": {
    maxTokens: 400000,
    supportsStreaming: true,
  },
  "gpt-5.2": {
    maxTokens: 400000,
    supportsStreaming: true,
  },
  "gpt-5.1-codex-max": {
    maxTokens: 400000,
    supportsStreaming: true,
  },
  "gpt-5.1-codex": {
    maxTokens: 400000,
    supportsStreaming: true,
  },
  "gpt-5.1-codex-mini": {
    maxTokens: 400000,
    supportsStreaming: true,
  },
  "gpt-5.1": {
    maxTokens: 400000,
    supportsStreaming: true,
  },

  // Kimi models
  "kimi-k2.6": {
    maxTokens: 256000,
    supportsStreaming: true,
  },
  "kimi-k2.5": {
    maxTokens: 256000,
    supportsStreaming: true,
  },
  "kimi-k2.6-code-preview": {
    maxTokens: 256000,
    supportsStreaming: true,
  },
  "kimi-k2-thinking": {
    maxTokens: 128000,
    supportsStreaming: true,
  },
  "kimi-k2-thinking-turbo": {
    maxTokens: 128000,
    supportsStreaming: true,
  },
  "kimi-k2-turbo-preview": {
    maxTokens: 128000,
    supportsStreaming: true,
  },
  "kimi-k2-0905-preview": {
    maxTokens: 128000,
    supportsStreaming: true,
  },

  // MiniMax models
  "MiniMax-M2.1": {
    maxTokens: 80000,
    supportsStreaming: true,
  },
  "MiniMax-M2.1-lightning": {
    maxTokens: 80000,
    supportsStreaming: true,
  },
  "MiniMax-M2": {
    maxTokens: 80000,
    supportsStreaming: true,
  },

  // DeepSeek V4 — 1M context (1,048,576 tokens), 384K max output
  "deepseek-v4-pro": {
    maxTokens: 1_048_576,
    supportsStreaming: true,
    warningThreshold: 0.80,
    criticalThreshold: 0.92,
    hardLimit: 0.97,
  },
  "deepseek-v4-flash": {
    maxTokens: 1_048_576,
    supportsStreaming: true,
    warningThreshold: 0.80,
    criticalThreshold: 0.92,
    hardLimit: 0.97,
  },
  // Legacy aliases (deprecated 2026/07/24) — map to V4 Flash modes, share 1M context
  "deepseek-chat": {
    maxTokens: 1_048_576,
    supportsStreaming: true,
    warningThreshold: 0.80,
    criticalThreshold: 0.92,
    hardLimit: 0.97,
  },
  "deepseek-reasoner": {
    maxTokens: 1_048_576,
    supportsStreaming: true,
    warningThreshold: 0.80,
    criticalThreshold: 0.92,
    hardLimit: 0.97,
  },

  // Ollama local models (smaller context windows)
  "llama3.1:8b": {
    maxTokens: 32000,
    supportsStreaming: true,
    warningThreshold: 0.70, // Lower threshold for smaller context
    criticalThreshold: 0.85,
    hardLimit: 0.92,
  },
  "llama3.1:70b": {
    maxTokens: 32000,
    supportsStreaming: true,
    warningThreshold: 0.70,
    criticalThreshold: 0.85,
    hardLimit: 0.92,
  },
  "codellama:34b": {
    maxTokens: 16000,
    supportsStreaming: true,
    warningThreshold: 0.65,
    criticalThreshold: 0.80,
    hardLimit: 0.90,
  },

  // BlackBox AI models — key context window configs
  "anthropic/claude-sonnet-4.5": {
    maxTokens: 200000,
    supportsStreaming: true,
  },
  "anthropic/claude-opus-4.5": {
    maxTokens: 200000,
    supportsStreaming: true,
  },
  "anthropic/claude-opus-4.6": {
    maxTokens: 200000,
    supportsStreaming: true,
  },
  "anthropic/claude-sonnet-4.6": {
    maxTokens: 200000,
    supportsStreaming: true,
  },
  "openai/gpt-5.5": {
    ...CODEX_GPT_55_CONTEXT_CONFIG,
  },
  "openai/gpt-5.5-pro": {
    ...CODEX_GPT_55_CONTEXT_CONFIG,
  },
  "openai/gpt-5.4": {
    maxTokens: 400000,
    supportsStreaming: true,
  },
  "openai/gpt-5.4-pro": {
    maxTokens: 400000,
    supportsStreaming: true,
  },
  "openai/gpt-5.2-codex": {
    maxTokens: 400000,
    supportsStreaming: true,
  },
  "openai/gpt-5.2": {
    maxTokens: 400000,
    supportsStreaming: true,
  },
  "openai/gpt-5.1": {
    maxTokens: 400000,
    supportsStreaming: true,
  },
  "openai/gpt-5.1-codex": {
    maxTokens: 400000,
    supportsStreaming: true,
  },
  "openai/codex-mini": {
    maxTokens: 200000,
    supportsStreaming: true,
  },
  "openai/gpt-4.1": {
    maxTokens: 1047576,
    supportsStreaming: true,
    warningThreshold: 0.80,
    criticalThreshold: 0.92,
    hardLimit: 0.97,
  },
  "openai/gpt-4.1-mini": {
    maxTokens: 1047576,
    supportsStreaming: true,
    warningThreshold: 0.80,
    criticalThreshold: 0.92,
    hardLimit: 0.97,
  },
  "openai/gpt-4o": {
    maxTokens: 128000,
    supportsStreaming: true,
  },
  "openai/gpt-4o-mini": {
    maxTokens: 128000,
    supportsStreaming: true,
  },
  "openai/o3": {
    maxTokens: 200000,
    supportsStreaming: true,
  },
  "openai/o3-pro": {
    maxTokens: 200000,
    supportsStreaming: true,
  },
  "openai/o4-mini": {
    maxTokens: 200000,
    supportsStreaming: true,
  },
  "google/gemini-3-pro-preview": {
    maxTokens: 1048576,
    supportsStreaming: true,
    warningThreshold: 0.80,
    criticalThreshold: 0.92,
    hardLimit: 0.97,
  },
  "google/gemini-2.5-pro": {
    maxTokens: 1048576,
    supportsStreaming: true,
    warningThreshold: 0.80,
    criticalThreshold: 0.92,
    hardLimit: 0.97,
  },
  "google/gemini-2.5-flash": {
    maxTokens: 1048576,
    supportsStreaming: true,
    warningThreshold: 0.80,
    criticalThreshold: 0.92,
    hardLimit: 0.97,
  },
  "deepseek/deepseek-r1": {
    maxTokens: 128000,
    supportsStreaming: true,
  },
  "deepseek/deepseek-chat": {
    maxTokens: 163840,
    supportsStreaming: true,
  },
  "meta-llama/llama-4-maverick": {
    maxTokens: 1048576,
    supportsStreaming: true,
    warningThreshold: 0.80,
    criticalThreshold: 0.92,
    hardLimit: 0.97,
  },
  "x-ai/grok-3": {
    maxTokens: 131072,
    supportsStreaming: true,
  },
  "mistralai/mistral-large": {
    maxTokens: 128000,
    supportsStreaming: true,
  },
  "mistralai/codestral-2501": {
    maxTokens: 262144,
    supportsStreaming: true,
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get context window configuration for a specific model.
 *
 * @param modelId - The model identifier (e.g., "claude-sonnet-4-5-20250929")
 * @param provider - Optional provider for fallback defaults
 * @returns Complete context window configuration
 */
function resolveContextConfigModelId(modelId: string, provider?: LLMProvider): string {
  const baseModelId = modelId.includes("/") ? modelId.split("/").pop()! : modelId;
  const lowerModelId = baseModelId.toLowerCase();

  if (provider === "codex" || lowerModelId.includes("codex") || lowerModelId.includes("gpt-5")) {
    return normalizeCodexModel(baseModelId);
  }

  return baseModelId;
}

/**
 * Check for user-configured context window override via env vars.
 * Returns the parsed token count, or null if no override is set.
 */
function getCustomContextWindowOverride(provider?: LLMProvider): number | null {
  if (!provider) return null;

  const envVarMap: Partial<Record<LLMProvider, string>> = {
    vllm: "VLLM_CONTEXT_WINDOW",
    ollama: "OLLAMA_CONTEXT_WINDOW",
  };

  const envVar = envVarMap[provider];
  if (!envVar) return null;

  const value = process.env[envVar]?.trim();
  if (!value) return null;

  const parsed = parseContextWindowString(value);
  // parseContextWindowString returns 128000 on invalid input; only accept if the
  // raw value actually looks intentional (non-empty, didn't fall through to default).
  return parsed > 0 ? parsed : null;
}

export function getContextWindowConfig(
  modelId: string,
  provider?: LLMProvider
): ContextWindowConfig {
  // 1. Check for user-configured override (vLLM / Ollama settings)
  const customOverride = getCustomContextWindowOverride(provider);
  if (customOverride !== null) {
    return {
      ...DEFAULT_CONTEXT_CONFIG,
      maxTokens: customOverride,
      // Use wider thresholds for large context windows
      ...(customOverride >= 200_000
        ? { warningThreshold: 0.80, criticalThreshold: 0.92, hardLimit: 0.97 }
        : {}),
    };
  }

  const resolvedModelId = resolveContextConfigModelId(modelId, provider);

  // 2. Check for model-specific config
  const modelConfig = MODEL_CONTEXT_CONFIGS[modelId] ?? MODEL_CONTEXT_CONFIGS[resolvedModelId];

  if (modelConfig) {
    return {
      ...DEFAULT_CONTEXT_CONFIG,
      ...modelConfig,
    };
  }

  // 3. Fall back to provider default
  if (provider) {
    const providerMaxTokens = PROVIDER_DEFAULT_LIMITS[provider];
    return {
      ...DEFAULT_CONTEXT_CONFIG,
      maxTokens: providerMaxTokens,
    };
  }

  // 4. Return default config
  return DEFAULT_CONTEXT_CONFIG;
}

/**
 * Get context window limit in tokens for a model.
 *
 * @param modelId - The model identifier
 * @param provider - Optional provider for fallback
 * @returns Maximum tokens for the context window
 */
function getContextWindowLimit(modelId: string, provider?: LLMProvider): number {
  return getContextWindowConfig(modelId, provider).maxTokens;
}

/**
 * Calculate token thresholds for a model.
 *
 * @param modelId - The model identifier
 * @param provider - Optional provider for fallback
 * @returns Object with warning, critical, and hard limit token counts
 */
export function getTokenThresholds(
  modelId: string,
  provider?: LLMProvider
): {
  warningTokens: number;
  criticalTokens: number;
  hardLimitTokens: number;
  maxTokens: number;
} {
  const config = getContextWindowConfig(modelId, provider);
  const decisionTokens = config.maxInputTokens ?? config.maxTokens;

  return {
    warningTokens: Math.floor(decisionTokens * config.warningThreshold),
    criticalTokens: Math.floor(decisionTokens * config.criticalThreshold),
    hardLimitTokens: Math.floor(decisionTokens * config.hardLimit),
    maxTokens: config.maxTokens,
  };
}

/**
 * Check if a model supports streaming responses.
 *
 * @param modelId - The model identifier
 * @returns Whether streaming is supported
 */
function supportsStreaming(modelId: string): boolean {
  const config = MODEL_CONTEXT_CONFIGS[modelId];
  return config?.supportsStreaming ?? true;
}

/**
 * Get compaction settings for a model.
 *
 * @param modelId - The model identifier
 * @param provider - Optional provider for fallback
 * @returns Compaction configuration
 */
function getCompactionSettings(
  modelId: string,
  provider?: LLMProvider
): {
  minMessages: number;
  keepRecent: number;
} {
  const config = getContextWindowConfig(modelId, provider);

  return {
    minMessages: config.minMessagesForCompaction,
    keepRecent: config.keepRecentMessages,
  };
}

/**
 * Format context window size for display.
 *
 * @param tokens - Number of tokens
 * @returns Formatted string (e.g., "200K", "1M")
 */
function formatContextWindowSize(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return millions === Math.floor(millions)
      ? `${millions}M`
      : `${millions.toFixed(1)}M`;
  }

  if (tokens >= 1_000) {
    const thousands = tokens / 1_000;
    return thousands === Math.floor(thousands)
      ? `${thousands}K`
      : `${thousands.toFixed(1)}K`;
  }

  return tokens.toString();
}
