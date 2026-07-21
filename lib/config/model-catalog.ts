/**
 * Unified Model Catalog
 *
 * Single source of truth that aggregates all provider model lists
 * and enriches them with metadata for the Bag of Models UI.
 *
 * Re-uses existing getXxxModels() functions — no duplication.
 */

import { getAntigravityModels } from "@/lib/auth/antigravity-models";
import { getCodexModels, normalizeCodexModel } from "@/lib/auth/codex-models";
import { getClaudeCodeModels } from "@/lib/auth/claudecode-models";
import { getKimiModels } from "@/lib/auth/kimi-models";
import { getMiniMaxModels } from "@/lib/auth/minimax-models";
import { getBlackBoxModels } from "@/lib/auth/blackboxai-models";
import { getDeepSeekModels } from "@/lib/auth/deepseek-models";
import type { LLMProvider } from "@/lib/ai/providers";
import type {
  ModelItem,
  ModelCapabilities,
  ModelRole,
} from "@/components/model-bag/model-bag.types";
import { PROVIDER_DISPLAY_NAMES } from "@/components/model-bag/model-bag.constants";
import { invertAssignments } from "@/components/model-bag/model-bag.utils";

// ---------------------------------------------------------------------------
// Static metadata enrichment for known models
// ---------------------------------------------------------------------------

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  vision: false,
  thinking: false,
  toolUse: true,
  streaming: true,
  speed: "standard",
};

const MODEL_METADATA: Record<
  string,
  Partial<Pick<ModelItem, "tier"> & { capabilities: Partial<ModelCapabilities> }>
> = {
  // Anthropic direct / Claude Code
  // --- 5 / 4.8 / 4.7 / 4.6 / 4.5 Series ---
  "claude-fable-5": {
    tier: "flagship",
    capabilities: { vision: true, thinking: true, contextWindow: "1M", speed: "standard" },
  },
  "claude-opus-4-8": {
    tier: "flagship",
    capabilities: { vision: true, thinking: true, contextWindow: "1M", speed: "standard" },
  },
  "claude-opus-4-7": {
    tier: "flagship",
    capabilities: { vision: true, thinking: true, contextWindow: "1M", speed: "standard" },
  },
  "claude-opus-4-6": {
    tier: "flagship",
    capabilities: { vision: true, thinking: true, contextWindow: "1M", speed: "standard" },
  },
  "claude-sonnet-4-6": {
    tier: "flagship",
    capabilities: { vision: true, contextWindow: "200K", speed: "standard" },
  },
  "claude-sonnet-4-5-20250929": {
    tier: "flagship",
    capabilities: { vision: true, thinking: true, contextWindow: "200K", speed: "standard" },
  },
  "claude-haiku-4-5-20251001": {
    tier: "utility",
    capabilities: { vision: true, contextWindow: "200K", speed: "fast" },
  },

  // --- Legacy 4.x Series ---
  "claude-opus-4-5-20251101": {
    tier: "legacy",
    capabilities: { vision: true, thinking: true, contextWindow: "200K", speed: "slow" },
  },
  "claude-opus-4-1-20250805": {
    tier: "legacy",
    capabilities: { vision: true, thinking: true, contextWindow: "200K", speed: "slow" },
  },
  "claude-sonnet-4-20250514": {
    tier: "legacy",
    capabilities: { vision: true, contextWindow: "200K", speed: "standard" },
  },
  "claude-3-7-sonnet-20250219": {
    tier: "legacy",
    capabilities: { vision: true, contextWindow: "200K", speed: "standard" },
  },
  "claude-opus-4-20250514": {
    tier: "legacy",
    capabilities: { vision: true, thinking: true, contextWindow: "200K", speed: "slow" },
  },

  // --- 3.5 Series ---
  "claude-3-5-sonnet-20241022": {
    tier: "legacy",
    capabilities: { vision: true, thinking: true, contextWindow: "200K", speed: "standard" },
  },
  "claude-3-5-haiku-20241022": {
    tier: "legacy",
    capabilities: { vision: false, contextWindow: "200K", speed: "fast" },
  },



  // Antigravity
  "gemini-3.1-pro-high": {
    tier: "flagship",
    capabilities: { vision: true, thinking: true, contextWindow: "1M", speed: "standard" },
  },
  "gemini-3.1-pro-low": {
    tier: "standard",
    capabilities: { vision: true, contextWindow: "1M", speed: "fast" },
  },
  "gemini-3-flash": {
    tier: "utility",
    capabilities: { vision: true, contextWindow: "1M", speed: "fast" },
  },
  "gpt-oss-120b-medium": {
    tier: "standard",
    capabilities: { vision: false, contextWindow: "128K", speed: "standard" },
  },

  // Codex GPT-5.6 family (372K context)
  "gpt-5.6-sol": {
    tier: "flagship",
    capabilities: { vision: true, thinking: true, contextWindow: "372K", speed: "standard" },
  },
  "gpt-5.6-terra": {
    tier: "standard",
    capabilities: { vision: true, thinking: true, contextWindow: "372K", speed: "standard" },
  },
  "gpt-5.6-luna": {
    tier: "utility",
    capabilities: { vision: true, thinking: true, contextWindow: "372K", speed: "fast" },
  },
  // Codex (GPT-5.5 — 1M context, released 2026-04-23)
  "gpt-5.5": {
    tier: "flagship",
    capabilities: { vision: true, thinking: true, contextWindow: "1M", speed: "fast" },
  },
  "gpt-5.5-pro": {
    tier: "flagship",
    capabilities: { vision: true, thinking: true, contextWindow: "1M", speed: "standard" },
  },
  // Codex (GPT-5.4 — 1M context)
  "gpt-5.4": {
    tier: "flagship",
    capabilities: { vision: true, thinking: true, contextWindow: "1M", speed: "fast" },
  },
  "gpt-5.4-mini": {
    tier: "standard",
    capabilities: { vision: true, thinking: true, contextWindow: "400K", speed: "fast" },
  },
  // Codex (GPT-5 legacy models — 400K context)
  "gpt-5.3-codex": {
    tier: "standard",
    capabilities: { vision: true, thinking: true, contextWindow: "400K", speed: "standard" },
  },
  "gpt-5.3-codex-spark": {
    tier: "utility",
    capabilities: { vision: true, thinking: true, contextWindow: "128K", speed: "fast" },
  },
  "codex-auto-review": {
    tier: "utility",
    capabilities: { vision: true, thinking: true, contextWindow: "272K", speed: "standard" },
  },
  "gpt-5.2-codex": {
    tier: "flagship",
    capabilities: { vision: true, thinking: true, contextWindow: "400K", speed: "standard" },
  },
  "gpt-5.2": {
    tier: "standard",
    capabilities: { vision: true, thinking: true, contextWindow: "400K", speed: "standard" },
  },
  "gpt-5.1-codex-max": {
    tier: "flagship",
    capabilities: { vision: true, thinking: true, contextWindow: "400K", speed: "slow" },
  },
  "gpt-5.1-codex": {
    tier: "standard",
    capabilities: { vision: true, thinking: true, contextWindow: "400K", speed: "standard" },
  },
  "gpt-5.1-codex-mini": {
    tier: "utility",
    capabilities: { vision: true, contextWindow: "400K", speed: "fast" },
  },
  "gpt-5.1": {
    tier: "standard",
    capabilities: { vision: true, thinking: true, contextWindow: "400K", speed: "standard" },
  },

  // Kimi
  "k3": {
    tier: "flagship",
    capabilities: { vision: true, thinking: true, contextWindow: "1M", speed: "standard" },
  },
  "kimi-k2.6": {
    tier: "flagship",
    capabilities: { vision: true, thinking: true, contextWindow: "256K", speed: "standard" },
  },
  "kimi-k2.5": {
    tier: "flagship",
    capabilities: { vision: true, thinking: true, contextWindow: "256K", speed: "standard" },
  },
  "kimi-k2-thinking": {
    tier: "flagship",
    capabilities: { vision: false, thinking: true, contextWindow: "128K", speed: "slow" },
  },
  "kimi-k2-thinking-turbo": {
    tier: "standard",
    capabilities: { vision: false, thinking: true, contextWindow: "128K", speed: "standard" },
  },
  "kimi-k2-turbo-preview": {
    tier: "utility",
    capabilities: { vision: false, contextWindow: "128K", speed: "fast" },
  },
  "kimi-k2-0905-preview": {
    tier: "standard",
    capabilities: { vision: false, contextWindow: "128K", speed: "standard" },
  },

  // MiniMax
  "MiniMax-M2.1": {
    tier: "flagship",
    capabilities: { vision: false, contextWindow: "80K", speed: "standard" },
  },
  "MiniMax-M2.1-lightning": {
    tier: "utility",
    capabilities: { vision: false, contextWindow: "80K", speed: "fast" },
  },
  "MiniMax-M2": {
    tier: "standard",
    capabilities: { vision: false, contextWindow: "80K", speed: "standard" },
  },

  // DeepSeek (native — 1M context, 384K max output)
  "deepseek-v4-pro": {
    tier: "flagship",
    capabilities: { vision: true, thinking: true, contextWindow: "1M", speed: "standard" },
  },
  "deepseek-v4-flash": {
    tier: "standard",
    capabilities: { vision: true, contextWindow: "1M", speed: "fast" },
  },
  "deepseek-chat": {
    tier: "legacy",
    capabilities: { vision: true, contextWindow: "1M", speed: "fast" },
  },
  "deepseek-reasoner": {
    tier: "legacy",
    capabilities: { vision: true, thinking: true, contextWindow: "1M", speed: "standard" },
  },

  // BlackBox AI — key models with context/capability metadata
  "anthropic/claude-sonnet-4.5": {
    tier: "flagship",
    capabilities: { vision: true, thinking: true, contextWindow: "200K", speed: "standard" },
  },
  "anthropic/claude-opus-4.5": {
    tier: "flagship",
    capabilities: { vision: true, thinking: true, contextWindow: "200K", speed: "slow" },
  },
  "anthropic/claude-opus-4.6": {
    tier: "flagship",
    capabilities: { vision: true, thinking: true, contextWindow: "200K", speed: "slow" },
  },
  "anthropic/claude-sonnet-4.6": {
    tier: "flagship",
    capabilities: { vision: true, thinking: true, contextWindow: "200K", speed: "standard" },
  },
  "openai/gpt-5.5": {
    tier: "flagship",
    capabilities: { vision: true, thinking: true, contextWindow: "1M", speed: "fast" },
  },
  "openai/gpt-5.5-pro": {
    tier: "flagship",
    capabilities: { vision: true, thinking: true, contextWindow: "1M", speed: "standard" },
  },
  "openai/gpt-5.4": {
    tier: "flagship",
    capabilities: { vision: true, thinking: true, contextWindow: "400K", speed: "standard" },
  },
  "openai/gpt-5.4-pro": {
    tier: "flagship",
    capabilities: { vision: true, thinking: true, contextWindow: "400K", speed: "slow" },
  },
  "openai/gpt-5.2-codex": {
    tier: "flagship",
    capabilities: { vision: true, thinking: true, contextWindow: "400K", speed: "standard" },
  },
  "openai/gpt-5.2": {
    tier: "standard",
    capabilities: { vision: true, thinking: true, contextWindow: "400K", speed: "standard" },
  },
  "openai/gpt-5.1": {
    tier: "standard",
    capabilities: { vision: true, thinking: true, contextWindow: "400K", speed: "standard" },
  },
  "openai/gpt-5.1-codex": {
    tier: "standard",
    capabilities: { vision: true, thinking: true, contextWindow: "400K", speed: "standard" },
  },
  "openai/codex-mini": {
    tier: "utility",
    capabilities: { vision: false, contextWindow: "200K", speed: "fast" },
  },
  "openai/gpt-4.1": {
    tier: "standard",
    capabilities: { vision: true, contextWindow: "1M", speed: "standard" },
  },
  "openai/gpt-4.1-mini": {
    tier: "utility",
    capabilities: { vision: true, contextWindow: "1M", speed: "fast" },
  },
  "openai/gpt-4o": {
    tier: "standard",
    capabilities: { vision: true, contextWindow: "128K", speed: "standard" },
  },
  "openai/gpt-4o-mini": {
    tier: "utility",
    capabilities: { vision: true, contextWindow: "128K", speed: "fast" },
  },
  "openai/o3": {
    tier: "flagship",
    capabilities: { vision: false, thinking: true, contextWindow: "200K", speed: "slow" },
  },
  "openai/o3-pro": {
    tier: "flagship",
    capabilities: { vision: false, thinking: true, contextWindow: "200K", speed: "slow" },
  },
  "openai/o4-mini": {
    tier: "standard",
    capabilities: { vision: false, thinking: true, contextWindow: "200K", speed: "standard" },
  },
  "google/gemini-3-pro-preview": {
    tier: "flagship",
    capabilities: { vision: true, thinking: true, contextWindow: "1M", speed: "standard" },
  },
  "google/gemini-2.5-pro": {
    tier: "flagship",
    capabilities: { vision: true, thinking: true, contextWindow: "1M", speed: "standard" },
  },
  "google/gemini-2.5-flash": {
    tier: "standard",
    capabilities: { vision: true, thinking: true, contextWindow: "1M", speed: "fast" },
  },
  "google/gemini-2.0-flash-001": {
    tier: "utility",
    capabilities: { vision: true, contextWindow: "1M", speed: "fast" },
  },
  "deepseek/deepseek-r1": {
    tier: "flagship",
    capabilities: { vision: false, thinking: true, contextWindow: "128K", speed: "standard" },
  },
  "deepseek/deepseek-chat": {
    tier: "standard",
    capabilities: { vision: false, contextWindow: "164K", speed: "fast" },
  },
  "deepseek/deepseek-r1-0528": {
    tier: "flagship",
    capabilities: { vision: false, thinking: true, contextWindow: "128K", speed: "standard" },
  },
  "meta-llama/llama-4-maverick": {
    tier: "standard",
    capabilities: { vision: true, contextWindow: "1M", speed: "standard" },
  },
  "meta-llama/llama-4-scout": {
    tier: "standard",
    capabilities: { vision: true, contextWindow: "1M", speed: "fast" },
  },
  "x-ai/grok-3": {
    tier: "flagship",
    capabilities: { vision: false, contextWindow: "131K", speed: "standard" },
  },
  "x-ai/grok-3-mini": {
    tier: "standard",
    capabilities: { vision: false, contextWindow: "131K", speed: "fast" },
  },
  "mistralai/mistral-large": {
    tier: "flagship",
    capabilities: { vision: false, contextWindow: "128K", speed: "standard" },
  },
  "mistralai/codestral-2501": {
    tier: "standard",
    capabilities: { vision: false, contextWindow: "262K", speed: "standard" },
  },
  "qwen/qwen3-235b-a22b": {
    tier: "flagship",
    capabilities: { vision: false, thinking: true, contextWindow: "41K", speed: "standard" },
  },
  "qwen/qwq-32b": {
    tier: "standard",
    capabilities: { vision: false, thinking: true, contextWindow: "131K", speed: "standard" },
  },
  "perplexity/sonar-pro": {
    tier: "standard",
    capabilities: { vision: false, contextWindow: "200K", speed: "standard" },
  },
  "cohere/command-a": {
    tier: "standard",
    capabilities: { vision: false, contextWindow: "256K", speed: "standard" },
  },
};

// ---------------------------------------------------------------------------
// Default models per provider (mirrors providers.ts DEFAULT_MODELS)
// ---------------------------------------------------------------------------

const DEFAULT_MODELS: Record<LLMProvider, string> = {
  anthropic: "claude-sonnet-4-6",
  openrouter: "openrouter/auto",
  antigravity: "claude-sonnet-4-6",
  codex: "gpt-5.4",
  claudecode: "claude-sonnet-4-6",
  kimi: "k3",
  minimax: "MiniMax-M2.1",
  blackboxai: "anthropic/claude-sonnet-4.5",
  deepseek: "deepseek-v4-pro",
  ollama: "llama3.1:8b",
  vllm: "",
};

// ---------------------------------------------------------------------------
// Catalog builder
// ---------------------------------------------------------------------------

/**
 * Build the complete model catalog.
 *
 * @param activeProvider  Currently selected llmProvider from settings
 * @param authStatus      Per-provider authentication state
 * @param currentAssignments  { chatModel: "...", researchModel: "...", ... }
 */
export function buildModelCatalog(
  activeProvider: LLMProvider,
  authStatus: Record<LLMProvider, boolean>,
  currentAssignments: Record<string, string>,
): ModelItem[] {
  const catalog: ModelItem[] = [];
  const roleInverse = invertAssignments(currentAssignments);

  // Anthropic (expanded to include full roster)
  const anthropicModels = [
    // 4.7 / 4.6 / 4.5 Series
    { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
    { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5" },
    { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
    
    // Legacy 4.x Series
    { id: "claude-opus-4-5-20251101", name: "Claude Opus 4.5" },
    { id: "claude-opus-4-1-20250805", name: "Claude Opus 4.1" },
    { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
    { id: "claude-3-7-sonnet-20250219", name: "Claude Sonnet 3.7" },
    { id: "claude-opus-4-20250514", name: "Claude Opus 4" },

    // 3.5 Series
    { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet" },
    { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku" },

  ];

  // OpenRouter models - organized by category
  // Users can also enter custom IDs via the input field
  const openrouterModels = [
    // --- Routers ---
    { id: "openrouter/auto", name: "🎯 Auto Router (Smart Selection)" },
    { id: "openrouter/free", name: "🆓 Free Router (Random Free Model)" },
    
    // --- Most Popular (Top Usage) ---
    { id: "moonshotai/kimi-k2.5", name: "Kimi K2.5 (#1 Most Used)" },
    { id: "google/gemini-3-flash-preview", name: "Gemini 3 Flash Preview" },
    { id: "deepseek/deepseek-chat-v3-0324", name: "DeepSeek V3.2" },
    { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
    { id: "x-ai/grok-4.1-fast", name: "Grok 4.1 Fast" },
    
    // --- Best Value (Performance/Price) ---
    { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash (Fast)" },
    { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "anthropic/claude-haiku-4.5", name: "Claude Haiku 4.5 (Coding)" },
    { id: "openai/gpt-oss-120b", name: "GPT-OSS-120B (Open Weight)" },
    { id: "qwen/qwen3-coder-next", name: "Qwen3 Coder Next" },
    
    // --- Free Models (Top Tier) ---
    { id: "openai/gpt-oss-120b:free", name: "🆓 GPT-OSS-120B Free" },
    { id: "openai/gpt-oss-20b:free", name: "🆓 GPT-OSS-20B Free" },
    { id: "deepseek/deepseek-r1-0528:free", name: "🆓 DeepSeek R1 Free" },
    { id: "z-ai/glm-4.5-air:free", name: "🆓 GLM 4.5 Air Free" },
    { id: "arcee-ai/trinity-large-preview:free", name: "🆓 Trinity Large Preview Free" },
    { id: "stepfun/step-3.5-flash:free", name: "🆓 Step 3.5 Flash Free" },
    { id: "nvidia/nemotron-3-nano-30b-a3b:free", name: "🆓 NVIDIA Nemotron 30B Free" },
    { id: "upstage/solar-pro-3:free", name: "🆓 Solar Pro 3 Free" },
    
    // --- Reasoning Models ---
    { id: "deepseek/deepseek-r1", name: "DeepSeek R1 (Reasoning)" },
    { id: "qwen/qwen3-max-thinking", name: "Qwen3 Max Thinking" },
    { id: "x-ai/grok-code", name: "Grok Code (Reasoning)" },
    
    // --- Legacy Popular ---
    { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet" },
    { id: "openai/gpt-4o", name: "GPT-4o" },
    { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B" },
  ];

  const allSources: Array<{
    provider: LLMProvider;
    models: Array<{ id: string; name: string }>;
  }> = [
    { provider: "anthropic", models: anthropicModels },
    { provider: "antigravity", models: getAntigravityModels() },
    { provider: "codex", models: getCodexModels() },
    { provider: "claudecode", models: getClaudeCodeModels() },
    { provider: "kimi", models: getKimiModels() },
    { provider: "minimax", models: getMiniMaxModels() },
    { provider: "blackboxai", models: getBlackBoxModels() },
    { provider: "deepseek", models: getDeepSeekModels() },
    { provider: "openrouter", models: openrouterModels },
    // ollama and vllm are free-text — handled separately in UI
  ];

  for (const { provider, models } of allSources) {
    for (const model of models) {
      const resolvedModelId = provider === "codex" ? normalizeCodexModel(model.id) : model.id;
      const meta = MODEL_METADATA[model.id] ?? MODEL_METADATA[resolvedModelId];
      catalog.push({
        id: model.id,
        name: model.name,
        provider,
        providerDisplayName: PROVIDER_DISPLAY_NAMES[provider],
        tier: meta?.tier ?? "standard",
        capabilities: { ...DEFAULT_CAPABILITIES, ...meta?.capabilities },
        assignedRoles: roleInverse[model.id] ?? [],
        isAvailable: authStatus[provider] ?? false,
        isDefault: model.id === DEFAULT_MODELS[provider],
      });
    }
  }

  // Synthetic entries for assigned models not in catalog.
  // Handles free-text providers (ollama, vllm, openrouter, blackboxai)
  // where users can enter arbitrary model IDs.
  const catalogIds = new Set(catalog.map((m) => m.id));
  for (const modelId of Object.values(currentAssignments)) {
    if (modelId && !catalogIds.has(modelId)) {
      catalog.push({
        id: modelId,
        name: modelId,
        provider: activeProvider,
        providerDisplayName: PROVIDER_DISPLAY_NAMES[activeProvider],
        tier: "standard",
        capabilities: { ...DEFAULT_CAPABILITIES },
        assignedRoles: roleInverse[modelId] ?? [],
        isAvailable: authStatus[activeProvider] ?? false,
        isDefault: false,
      });
      catalogIds.add(modelId);
    }
  }

  return catalog;
}

/**
 * Get default model ID for a provider.
 */
export function getDefaultModelForProvider(provider: LLMProvider): string {
  return DEFAULT_MODELS[provider] ?? "";
}
