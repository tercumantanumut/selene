/**
 * Session Model Resolver
 *
 * Resolves the effective provider/model configuration for a chat scope using:
 *   session override -> agent default -> global fallback -> provider default
 */

import type { LanguageModel } from "ai";
import type {
  AgentModelConfig,
  ModelConfig,
  ModelConfigSource,
  ResolvedModelConfig,
  ResolvedModelSources,
  SessionModelConfig,
} from "@/components/model-bag/model-bag.types";
import { loadSettings, type AppSettings } from "@/lib/settings/settings-manager";
import {
  DEFAULT_MODELS,
  UTILITY_MODELS,
  getLanguageModelForProvider,
  getProviderDisplayName,
  isProviderOperational,
  resolveModelForProvider,
  resolveProviderWithFallback,
  type LLMProvider,
} from "@/lib/ai/providers";

const SESSION_MODEL_KEYS = {
  provider: "sessionProvider",
  chat: "sessionChatModel",
  research: "sessionResearchModel",
  vision: "sessionVisionModel",
  utility: "sessionUtilityModel",
  transcriber: "sessionTranscriberModel",
} as const;

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  antigravity: "Antigravity",
  codex: "OpenAI Codex",
  claudecode: "Claude Code",
  kimi: "Moonshot Kimi",
  minimax: "MiniMax",
  blackboxai: "BlackBox AI",
  ollama: "Ollama",
  vllm: "vLLM",
};

const ROLE_FIELDS = ["chatModel", "researchModel", "visionModel", "utilityModel", "transcriberModel"] as const;
type RoleField = (typeof ROLE_FIELDS)[number];

interface ResolvedSessionModelScope {
  effectiveConfig: ResolvedModelConfig;
  sources: ResolvedModelSources;
  sessionConfig: SessionModelConfig | null;
  agentConfig: AgentModelConfig | null;
  globalConfig: ModelConfig;
}

interface SessionResolverOptions {
  characterId?: string | null;
  agentModelConfig?: AgentModelConfig | null;
  settings?: AppSettings;
}

interface CandidateValue {
  model: string;
  source: ModelConfigSource;
}

function getGlobalModelConfig(settings: AppSettings): ModelConfig {
  return {
    provider: settings.llmProvider,
    chatModel: settings.chatModel || undefined,
    researchModel: settings.researchModel || undefined,
    visionModel: settings.visionModel || undefined,
    utilityModel: settings.utilityModel || undefined,
    transcriberModel: settings.transcriberModel || undefined,
  };
}

function getCharacterIdFromMetadata(
  sessionMetadata: Record<string, unknown> | null | undefined,
): string | null {
  return typeof sessionMetadata?.characterId === "string" && sessionMetadata.characterId
    ? sessionMetadata.characterId
    : null;
}

function getAgentModelConfigFromUnknown(value: unknown): AgentModelConfig | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const config = value as Record<string, unknown>;
  const result: AgentModelConfig = {};

  if (typeof config.provider === "string") {
    result.provider = config.provider as LLMProvider;
  }

  for (const field of ROLE_FIELDS) {
    if (typeof config[field] === "string" && config[field]) {
      result[field] = config[field] as string;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

async function loadAgentModelConfig(
  characterId: string | null | undefined,
): Promise<AgentModelConfig | null> {
  if (!characterId) {
    return null;
  }

  try {
    const { getCharacter } = await import("@/lib/characters/queries");
    const character = await getCharacter(characterId);
    return getAgentModelConfigFromUnknown(
      (character?.metadata as Record<string, unknown> | null)?.modelConfig,
    );
  } catch (error) {
    console.warn(
      `[SESSION-RESOLVER] Failed to load agent model config for character ${characterId}:`,
      error,
    );
    return null;
  }
}

function resolveEffectiveProvider(
  sessionConfig: SessionModelConfig | null,
  agentConfig: AgentModelConfig | null,
  settings: AppSettings,
): { provider: LLMProvider; source: ModelConfigSource } {
  const providerCandidates: Array<{ provider?: LLMProvider; source: ModelConfigSource }> = [
    { provider: sessionConfig?.sessionProvider, source: "session" },
    { provider: agentConfig?.provider, source: "agent" },
    { provider: settings.llmProvider, source: "global" },
  ];

  for (const candidate of providerCandidates) {
    if (!candidate.provider) {
      continue;
    }

    if (isProviderOperational(candidate.provider)) {
      return { provider: candidate.provider, source: candidate.source };
    }

    console.warn(
      `[SESSION-RESOLVER] ${candidate.source} provider "${candidate.provider}" is unavailable, trying the next fallback layer`,
    );
  }

  return {
    provider: resolveProviderWithFallback(settings.llmProvider, "anthropic"),
    source: "provider-default",
  };
}

function pickCompatibleModel(
  fieldName: RoleField,
  provider: LLMProvider,
  candidates: CandidateValue[],
  providerDefault: string,
): { model: string; source: ModelConfigSource } {
  for (const candidate of candidates) {
    const resolved = resolveModelForProvider(candidate.model, provider, providerDefault, fieldName);
    if (resolved === candidate.model) {
      return { model: candidate.model, source: candidate.source };
    }

    if (resolved === providerDefault) {
      console.warn(
        `[SESSION-RESOLVER] Skipping incompatible ${candidate.source} ${fieldName} "${candidate.model}" for provider "${provider}"`,
      );
    }
  }

  return { model: providerDefault, source: "provider-default" };
}

function resolveEffectiveModelConfig(input: {
  sessionConfig: SessionModelConfig | null;
  agentConfig: AgentModelConfig | null;
  settings: AppSettings;
}): ResolvedSessionModelScope {
  const { sessionConfig, agentConfig, settings } = input;
  const globalConfig = getGlobalModelConfig(settings);
  const providerResolution = resolveEffectiveProvider(sessionConfig, agentConfig, settings);
  const provider = providerResolution.provider;

  const chatResolution = pickCompatibleModel(
    "chatModel",
    provider,
    [
      sessionConfig?.sessionChatModel
        ? { model: sessionConfig.sessionChatModel, source: "session" }
        : null,
      agentConfig?.chatModel
        ? { model: agentConfig.chatModel, source: "agent" }
        : null,
      globalConfig.chatModel
        ? { model: globalConfig.chatModel, source: "global" }
        : null,
    ].filter((value): value is CandidateValue => value !== null),
    DEFAULT_MODELS[provider],
  );

  const researchResolution = pickCompatibleModel(
    "researchModel",
    provider,
    [
      sessionConfig?.sessionResearchModel
        ? { model: sessionConfig.sessionResearchModel, source: "session" }
        : null,
      agentConfig?.researchModel
        ? { model: agentConfig.researchModel, source: "agent" }
        : null,
      globalConfig.researchModel
        ? { model: globalConfig.researchModel, source: "global" }
        : null,
      { model: chatResolution.model, source: chatResolution.source },
    ].filter((value): value is CandidateValue => value !== null),
    DEFAULT_MODELS[provider],
  );

  const visionResolution = pickCompatibleModel(
    "visionModel",
    provider,
    [
      sessionConfig?.sessionVisionModel
        ? { model: sessionConfig.sessionVisionModel, source: "session" }
        : null,
      agentConfig?.visionModel
        ? { model: agentConfig.visionModel, source: "agent" }
        : null,
      globalConfig.visionModel
        ? { model: globalConfig.visionModel, source: "global" }
        : null,
      { model: chatResolution.model, source: chatResolution.source },
    ].filter((value): value is CandidateValue => value !== null),
    DEFAULT_MODELS[provider],
  );

  const utilityResolution = pickCompatibleModel(
    "utilityModel",
    provider,
    [
      sessionConfig?.sessionUtilityModel
        ? { model: sessionConfig.sessionUtilityModel, source: "session" }
        : null,
      agentConfig?.utilityModel
        ? { model: agentConfig.utilityModel, source: "agent" }
        : null,
      globalConfig.utilityModel
        ? { model: globalConfig.utilityModel, source: "global" }
        : null,
    ].filter((value): value is CandidateValue => value !== null),
    UTILITY_MODELS[provider],
  );

  const transcriberResolution = pickCompatibleModel(
    "transcriberModel",
    provider,
    [
      sessionConfig?.sessionTranscriberModel
        ? { model: sessionConfig.sessionTranscriberModel, source: "session" }
        : null,
      agentConfig?.transcriberModel
        ? { model: agentConfig.transcriberModel, source: "agent" }
        : null,
      globalConfig.transcriberModel
        ? { model: globalConfig.transcriberModel, source: "global" }
        : null,
      { model: utilityResolution.model, source: utilityResolution.source },
    ].filter((value): value is CandidateValue => value !== null),
    utilityResolution.model,
  );

  return {
    effectiveConfig: {
      provider,
      chatModel: chatResolution.model,
      researchModel: researchResolution.model,
      visionModel: visionResolution.model,
      utilityModel: utilityResolution.model,
      transcriberModel: transcriberResolution.model,
    },
    sources: {
      provider: providerResolution.source,
      chatModel: chatResolution.source,
      researchModel: researchResolution.source,
      visionModel: visionResolution.source,
      utilityModel: utilityResolution.source,
      transcriberModel: transcriberResolution.source,
    },
    sessionConfig,
    agentConfig,
    globalConfig,
  };
}

export function extractSessionModelConfig(
  metadata: Record<string, unknown> | null | undefined,
): SessionModelConfig | null {
  if (!metadata) return null;

  const config: SessionModelConfig = {};
  let hasOverride = false;

  if (typeof metadata[SESSION_MODEL_KEYS.provider] === "string" && metadata[SESSION_MODEL_KEYS.provider]) {
    config.sessionProvider = metadata[SESSION_MODEL_KEYS.provider] as LLMProvider;
    hasOverride = true;
  }
  if (typeof metadata[SESSION_MODEL_KEYS.chat] === "string" && metadata[SESSION_MODEL_KEYS.chat]) {
    config.sessionChatModel = metadata[SESSION_MODEL_KEYS.chat] as string;
    hasOverride = true;
  }
  if (typeof metadata[SESSION_MODEL_KEYS.research] === "string" && metadata[SESSION_MODEL_KEYS.research]) {
    config.sessionResearchModel = metadata[SESSION_MODEL_KEYS.research] as string;
    hasOverride = true;
  }
  if (typeof metadata[SESSION_MODEL_KEYS.vision] === "string" && metadata[SESSION_MODEL_KEYS.vision]) {
    config.sessionVisionModel = metadata[SESSION_MODEL_KEYS.vision] as string;
    hasOverride = true;
  }
  if (typeof metadata[SESSION_MODEL_KEYS.utility] === "string" && metadata[SESSION_MODEL_KEYS.utility]) {
    config.sessionUtilityModel = metadata[SESSION_MODEL_KEYS.utility] as string;
    hasOverride = true;
  }
  if (typeof metadata[SESSION_MODEL_KEYS.transcriber] === "string" && metadata[SESSION_MODEL_KEYS.transcriber]) {
    config.sessionTranscriberModel = metadata[SESSION_MODEL_KEYS.transcriber] as string;
    hasOverride = true;
  }

  return hasOverride ? config : null;
}

export function resolveSessionModelScope(
  sessionMetadata: Record<string, unknown> | null | undefined,
  options: SessionResolverOptions = {},
): ResolvedSessionModelScope {
  const settings = options.settings ?? loadSettings();
  const sessionConfig = extractSessionModelConfig(sessionMetadata);

  return resolveEffectiveModelConfig({
    sessionConfig,
    agentConfig: options.agentModelConfig ?? null,
    settings,
  });
}

export async function resolveSessionModelScopeForSession(
  sessionMetadata: Record<string, unknown> | null | undefined,
  options: SessionResolverOptions = {},
): Promise<ResolvedSessionModelScope> {
  const settings = options.settings ?? loadSettings();
  const agentConfig =
    options.agentModelConfig ??
    (await loadAgentModelConfig(options.characterId ?? getCharacterIdFromMetadata(sessionMetadata)));

  return resolveSessionModelScope(sessionMetadata, {
    ...options,
    settings,
    agentModelConfig: agentConfig,
  });
}

function getSessionModelId(
  sessionMetadata: Record<string, unknown> | null | undefined,
  options: SessionResolverOptions = {},
): string {
  return resolveSessionModelScope(sessionMetadata, options).effectiveConfig.chatModel;
}

export async function getSessionModelIdForSession(
  sessionMetadata: Record<string, unknown> | null | undefined,
  options: SessionResolverOptions = {},
): Promise<string> {
  return (await resolveSessionModelScopeForSession(sessionMetadata, options)).effectiveConfig.chatModel;
}

export function getSessionProvider(
  sessionMetadata: Record<string, unknown> | null | undefined,
  options: SessionResolverOptions = {},
): LLMProvider {
  return resolveSessionModelScope(sessionMetadata, options).effectiveConfig.provider;
}

export async function getSessionProviderForSession(
  sessionMetadata: Record<string, unknown> | null | undefined,
  options: SessionResolverOptions = {},
): Promise<LLMProvider> {
  return (await resolveSessionModelScopeForSession(sessionMetadata, options)).effectiveConfig.provider;
}

function resolveSessionChatModel(
  sessionMetadata: Record<string, unknown> | null | undefined,
  options: SessionResolverOptions = {},
): LanguageModel {
  const scope = resolveSessionModelScope(sessionMetadata, options);
  return getLanguageModelForProvider(scope.effectiveConfig.provider, scope.effectiveConfig.chatModel);
}

async function resolveSessionChatModelForSession(
  sessionMetadata: Record<string, unknown> | null | undefined,
  options: SessionResolverOptions = {},
): Promise<LanguageModel> {
  const scope = await resolveSessionModelScopeForSession(sessionMetadata, options);
  return getLanguageModelForProvider(scope.effectiveConfig.provider, scope.effectiveConfig.chatModel);
}

function resolveSessionLanguageModel(
  sessionMetadata: Record<string, unknown> | null | undefined,
  options: SessionResolverOptions = {},
): LanguageModel {
  const scope = resolveSessionModelScope(sessionMetadata, options);
  return getLanguageModelForProvider(scope.effectiveConfig.provider, scope.effectiveConfig.chatModel);
}

export async function resolveSessionLanguageModelForSession(
  sessionMetadata: Record<string, unknown> | null | undefined,
  options: SessionResolverOptions = {},
): Promise<LanguageModel> {
  const scope = await resolveSessionModelScopeForSession(sessionMetadata, options);
  return getLanguageModelForProvider(scope.effectiveConfig.provider, scope.effectiveConfig.chatModel);
}

export function resolveSessionResearchModel(
  sessionMetadata: Record<string, unknown> | null | undefined,
  options: SessionResolverOptions = {},
): LanguageModel {
  const scope = resolveSessionModelScope(sessionMetadata, options);
  return getLanguageModelForProvider(scope.effectiveConfig.provider, scope.effectiveConfig.researchModel);
}

async function resolveSessionResearchModelForSession(
  sessionMetadata: Record<string, unknown> | null | undefined,
  options: SessionResolverOptions = {},
): Promise<LanguageModel> {
  const scope = await resolveSessionModelScopeForSession(sessionMetadata, options);
  return getLanguageModelForProvider(scope.effectiveConfig.provider, scope.effectiveConfig.researchModel);
}

function resolveSessionVisionModel(
  sessionMetadata: Record<string, unknown> | null | undefined,
  options: SessionResolverOptions = {},
): LanguageModel {
  const scope = resolveSessionModelScope(sessionMetadata, options);
  return getLanguageModelForProvider(scope.effectiveConfig.provider, scope.effectiveConfig.visionModel);
}

export async function resolveSessionVisionModelForSession(
  sessionMetadata: Record<string, unknown> | null | undefined,
  options: SessionResolverOptions = {},
): Promise<LanguageModel> {
  const scope = await resolveSessionModelScopeForSession(sessionMetadata, options);
  return getLanguageModelForProvider(scope.effectiveConfig.provider, scope.effectiveConfig.visionModel);
}

export function resolveSessionUtilityModel(
  sessionMetadata: Record<string, unknown> | null | undefined,
  options: SessionResolverOptions = {},
): LanguageModel {
  const scope = resolveSessionModelScope(sessionMetadata, options);
  return getLanguageModelForProvider(scope.effectiveConfig.provider, scope.effectiveConfig.utilityModel);
}

function resolveTranscriberModel(
  settings: AppSettings,
  provider?: LLMProvider,
): LanguageModel {
  const scope = resolveSessionModelScope(null, provider ? {
    settings,
    agentModelConfig: { provider },
  } : { settings });
  return getLanguageModelForProvider(
    scope.effectiveConfig.provider,
    scope.effectiveConfig.transcriberModel,
  );
}

export async function resolveSessionUtilityModelForSession(
  sessionMetadata: Record<string, unknown> | null | undefined,
  options: SessionResolverOptions = {},
): Promise<LanguageModel> {
  const scope = await resolveSessionModelScopeForSession(sessionMetadata, options);
  return getLanguageModelForProvider(scope.effectiveConfig.provider, scope.effectiveConfig.utilityModel);
}

export async function resolveTranscriberModelForSession(
  sessionMetadata: Record<string, unknown> | null | undefined,
  options: SessionResolverOptions = {},
): Promise<LanguageModel> {
  const scope = await resolveSessionModelScopeForSession(sessionMetadata, {
    ...options,
  });
  return getLanguageModelForProvider(
    scope.effectiveConfig.provider,
    scope.effectiveConfig.transcriberModel,
  );
}

export function buildSessionModelMetadata(
  config: SessionModelConfig,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (config.sessionProvider) result[SESSION_MODEL_KEYS.provider] = config.sessionProvider;
  if (config.sessionChatModel) result[SESSION_MODEL_KEYS.chat] = config.sessionChatModel;
  if (config.sessionResearchModel) result[SESSION_MODEL_KEYS.research] = config.sessionResearchModel;
  if (config.sessionVisionModel) result[SESSION_MODEL_KEYS.vision] = config.sessionVisionModel;
  if (config.sessionUtilityModel) result[SESSION_MODEL_KEYS.utility] = config.sessionUtilityModel;
  if (config.sessionTranscriberModel) result[SESSION_MODEL_KEYS.transcriber] = config.sessionTranscriberModel;
  return result;
}

export function clearSessionModelMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...metadata };
  for (const key of Object.values(SESSION_MODEL_KEYS)) {
    delete result[key];
  }
  return result;
}

function getSessionDisplayName(
  sessionMetadata: Record<string, unknown> | null | undefined,
  options: SessionResolverOptions = {},
): string {
  const scope = resolveSessionModelScope(sessionMetadata, options);
  const providerName = PROVIDER_NAMES[scope.effectiveConfig.provider] || scope.effectiveConfig.provider;

  if (
    scope.sources.chatModel === "global" &&
    scope.sources.provider === "global" &&
    !options.agentModelConfig
  ) {
    return getProviderDisplayName();
  }

  return `${providerName} (${scope.effectiveConfig.chatModel})`;
}

export async function getSessionDisplayNameForSession(
  sessionMetadata: Record<string, unknown> | null | undefined,
  options: SessionResolverOptions = {},
): Promise<string> {
  const scope = await resolveSessionModelScopeForSession(sessionMetadata, options);
  const providerName = PROVIDER_NAMES[scope.effectiveConfig.provider] || scope.effectiveConfig.provider;

  if (scope.sources.chatModel === "global" && scope.sources.provider === "global") {
    return getProviderDisplayName();
  }

  return `${providerName} (${scope.effectiveConfig.chatModel})`;
}

export function getSessionProviderTemperature(
  sessionMetadata: Record<string, unknown> | null | undefined,
  requestedTemp: number,
  options: SessionResolverOptions = {},
): number {
  const provider = getSessionProvider(sessionMetadata, options);
  // Kimi non-thinking mode requires temperature=0.6 (enforced by kimi-client fetch wrapper)
  return provider === "kimi" ? 0.6 : requestedTemp;
}

export async function getSessionProviderTemperatureForSession(
  sessionMetadata: Record<string, unknown> | null | undefined,
  requestedTemp: number,
  options: SessionResolverOptions = {},
): Promise<number> {
  const provider = (await resolveSessionModelScopeForSession(sessionMetadata, options)).effectiveConfig.provider;
  // Kimi non-thinking mode requires temperature=0.6 (enforced by kimi-client fetch wrapper)
  return provider === "kimi" ? 0.6 : requestedTemp;
}

function getAgentModelConfigFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): AgentModelConfig | null {
  return getAgentModelConfigFromUnknown(metadata?.modelConfig);
}
