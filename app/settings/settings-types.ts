import { DEFAULT_WHISPER_MODEL } from "@/lib/config/whisper-models";
import {
  DEFAULT_CHAT_WORKSPACE_MODE,
  type ChatWorkspaceMode,
} from "@/lib/chat/workspace-mode";
import type { VoiceSettingsFields } from "@/lib/settings/voice-settings-fields";

export type LlmProvider = "anthropic" | "openrouter" | "antigravity" | "codex" | "kimi" | "minimax" | "ollama" | "claudecode" | "blackboxai" | "deepseek" | "vllm";

interface AppSettingsPublic {
  appLanguage?: "en" | "tr";
  llmProvider: LlmProvider;
  anthropicApiKey?: string;
  openrouterApiKey?: string;
  kimiApiKey?: string;
  minimaxApiKey?: string;
  blackboxaiApiKey?: string;
  deepseekApiKey?: string;
  openaiApiKey?: string;
  ollamaBaseUrl?: string;
  vllmBaseUrl?: string;
  vllmApiKey?: string;
  vllmContextWindow?: string;  // Custom context window size (e.g. "256K", "262144")
  ollamaContextWindow?: string; // Custom context window size for Ollama models
  tavilyApiKey?: string;
  firecrawlApiKey?: string;
  webScraperProvider?: "firecrawl" | "local";
  webSearchProvider?: "tavily" | "duckduckgo" | "auto";
  stylyAiApiKey?: string;
  huggingFaceToken?: string;
  chatModel?: string;
  embeddingProvider?: "openrouter" | "local";
  embeddingModel?: string;
  researchModel?: string;
  visionModel?: string;
  utilityModel?: string;
  embeddingReindexRequired?: boolean;
  theme: "dark" | "light" | "system";
  chatWorkspaceMode?: ChatWorkspaceMode;
  toolDisplayMode?: "compact" | "detailed";
  localUserId: string;
  localUserEmail: string;
  promptCachingEnabled?: boolean;
  postEditHooksPreset?: "off" | "fast" | "strict";
  postEditHooksEnabled?: boolean;
  postEditTypecheckEnabled?: boolean;
  postEditLintEnabled?: boolean;
  postEditTypecheckScope?: "auto" | "app" | "lib" | "electron" | "tooling" | "all";
  postEditRunInPatchTool?: boolean;
  rtkEnabled?: boolean;
  rtkInstalled?: boolean;
  rtkVerbosity?: 0 | 1 | 2 | 3;
  rtkUltraCompact?: boolean;
  vectorDBEnabled?: boolean;
  vectorSearchHybridEnabled?: boolean;
  vectorSearchTokenChunkingEnabled?: boolean;
  vectorSearchRerankingEnabled?: boolean;
  vectorSearchQueryExpansionEnabled?: boolean;
  vectorSearchLlmSynthesisEnabled?: boolean;

  vectorSearchRrfK?: number;
  vectorSearchDenseWeight?: number;
  vectorSearchLexicalWeight?: number;
  vectorSearchRerankModel?: string;
  vectorSearchRerankTopK?: number;
  vectorSearchTokenChunkSize?: number;
  vectorSearchTokenChunkStride?: number;
  vectorSearchMaxFileLines?: number;
  vectorSearchMaxLineLength?: number;
  comfyuiCustomHost?: string;
  comfyuiCustomPort?: number;
  comfyuiCustomUseHttps?: boolean;
  comfyuiCustomAutoDetect?: boolean;
  comfyuiCustomBaseUrl?: string;
  // Antigravity auth state (read-only, managed via OAuth)
  antigravityAuth?: {
    isAuthenticated: boolean;
    email?: string;
    expiresAt?: number;
  };
  codexAuth?: {
    isAuthenticated: boolean;
    email?: string;
    accountId?: string;
    expiresAt?: number;
  };
  // Video generation provider keys
  runwayApiSecret?: string;
  vertexAIProjectId?: string;
  vertexAILocation?: string;
  vertexAICredentialsPath?: string;
  screenCaptureEnabled?: boolean;
  screenCaptureShortcut?: string;
  quickCaptureEnabled?: boolean;
  quickCaptureHotkey?: string;
  quickCaptureAutoSend?: boolean;
  quickCaptureAutoSendDelay?: number;
  screenCaptureExcludedApps?: string;
  screenCaptureRetention?: "session" | "day" | "week" | "forever";
  screenCapturePreviewBeforeSend?: boolean;
  screenCaptureOnboardingSeen?: boolean;
  // Mini Overlay settings
  miniOverlayDefaultMode?: "direct" | "compose";
  miniOverlayAutoCloseAfterSpeak?: boolean;
  miniOverlayKeepAppFocusedOnCompose?: boolean;
  miniOverlayShowScreenPreview?: boolean;
}

export type SettingsSection = "api-keys" | "models" | "vector-search" | "comfyui" | "preferences" | "memory" | "mcp" | "plugins" | "voice";

export interface FormState {
  appLanguage: "en" | "tr";
  llmProvider: LlmProvider;
  anthropicApiKey: string;
  openrouterApiKey: string;
  kimiApiKey: string;
  minimaxApiKey: string;
  blackboxaiApiKey: string;
  deepseekApiKey: string;
  openaiApiKey: string;
  ollamaBaseUrl: string;
  vllmBaseUrl: string;
  vllmApiKey: string;
  vllmContextWindow: string;
  ollamaContextWindow: string;
  tavilyApiKey: string;
  firecrawlApiKey: string;
  webScraperProvider: "firecrawl" | "local";
  webSearchProvider: "tavily" | "duckduckgo" | "auto";
  stylyAiApiKey: string;
  huggingFaceToken: string;
  chatModel: string;
  embeddingProvider: "openrouter" | "local";
  embeddingModel: string;
  researchModel: string;
  visionModel: string;
  utilityModel: string;
  openrouterArgs: string;
  theme: "dark" | "light" | "system";
  chatWorkspaceMode: ChatWorkspaceMode;
  toolLoadingMode: "deferred" | "always";
  toolDisplayMode: "compact" | "detailed";
  postEditHooksPreset: "off" | "fast" | "strict";
  postEditHooksEnabled: boolean;
  postEditTypecheckEnabled: boolean;
  postEditLintEnabled: boolean;
  postEditTypecheckScope: "auto" | "app" | "lib" | "electron" | "tooling" | "all";
  postEditRunInPatchTool: boolean;
  promptCachingEnabled: boolean;
  rtkEnabled: boolean;
  rtkVerbosity: 0 | 1 | 2 | 3;
  rtkUltraCompact: boolean;
  devWorkspaceEnabled: boolean;
  devWorkspaceAutoCleanup: boolean;
  devWorkspaceAutoCleanupDays: number;
  // Browser automation settings
  chromiumBrowserMode: "standalone" | "user-chrome";
  chromiumUserProfilePath: string;
  embeddingReindexRequired: boolean;
  vectorDBEnabled: boolean;
  vectorSearchHybridEnabled: boolean;
  vectorSearchTokenChunkingEnabled: boolean;
  vectorSearchRerankingEnabled: boolean;
  vectorSearchQueryExpansionEnabled: boolean;
  vectorSearchLlmSynthesisEnabled: boolean;

  vectorSearchRrfK: number;
  vectorSearchDenseWeight: number;
  vectorSearchLexicalWeight: number;
  vectorSearchRerankModel: string;
  vectorSearchRerankTopK: number;
  vectorSearchTokenChunkSize: number;
  vectorSearchTokenChunkStride: number;
  vectorSearchMaxFileLines: number;
  vectorSearchMaxLineLength: number;
  // Local Grep settings
  localGrepEnabled: boolean;
  localGrepMaxResults: number;
  localGrepContextLines: number;
  localGrepRespectGitignore: boolean;
  // Local image generation settings
  comfyuiEnabled: boolean;
  comfyuiCustomHost: string;
  comfyuiCustomPort: number;
  comfyuiCustomUseHttps: boolean;
  comfyuiCustomAutoDetect: boolean;
  comfyuiCustomBaseUrl: string;
  // 3D Avatar settings
  avatar3dEnabled: boolean;
  // Emotion Detection (Selene Fun)
  emotionDetectionEnabled: boolean;
  // EverMemOS shared memory settings
  everMemOSEnabled: boolean;
  everMemOSServerUrl: string;
  // Voice & Audio settings (shared field definitions — see lib/settings/voice-settings-fields.ts)
  ttsEnabled: VoiceSettingsFields["ttsEnabled"];
  ttsProvider: VoiceSettingsFields["ttsProvider"];
  ttsAutoMode: VoiceSettingsFields["ttsAutoMode"];
  elevenLabsApiKey: VoiceSettingsFields["elevenLabsApiKey"];
  elevenLabsVoiceId: VoiceSettingsFields["elevenLabsVoiceId"];
  openaiTtsVoice: VoiceSettingsFields["openaiTtsVoice"];
  edgeTtsVoice: VoiceSettingsFields["edgeTtsVoice"];
  ttsSummarizeThreshold: VoiceSettingsFields["ttsSummarizeThreshold"];
  ttsReadCodeBlocks: VoiceSettingsFields["ttsReadCodeBlocks"];
  ttsSpeakCodeSymbols: VoiceSettingsFields["ttsSpeakCodeSymbols"];
  sttEnabled: VoiceSettingsFields["sttEnabled"];
  sttProvider: VoiceSettingsFields["sttProvider"];
  sttLocalModel: VoiceSettingsFields["sttLocalModel"];
  voicePostProcessing: VoiceSettingsFields["voicePostProcessing"];
  transcriberModel: VoiceSettingsFields["transcriberModel"];
  voiceAgentName: VoiceSettingsFields["voiceAgentName"];
  voiceAudioCues: VoiceSettingsFields["voiceAudioCues"];
  voiceAutoLearn: VoiceSettingsFields["voiceAutoLearn"];
  voiceActivationMode: VoiceSettingsFields["voiceActivationMode"];
  parakeetModel: VoiceSettingsFields["parakeetModel"];
  parakeetAutoStart: VoiceSettingsFields["parakeetAutoStart"];
  parakeetServerPort: VoiceSettingsFields["parakeetServerPort"];
  voiceHotkey: VoiceSettingsFields["voiceHotkey"];
  screenCaptureEnabled: VoiceSettingsFields["screenCaptureEnabled"];
  screenCaptureShortcut: VoiceSettingsFields["screenCaptureShortcut"];
  quickCaptureEnabled: VoiceSettingsFields["quickCaptureEnabled"];
  quickCaptureHotkey: VoiceSettingsFields["quickCaptureHotkey"];
  quickCaptureAutoSend: VoiceSettingsFields["quickCaptureAutoSend"];
  quickCaptureAutoSendDelay: VoiceSettingsFields["quickCaptureAutoSendDelay"];
  screenCaptureExcludedApps: VoiceSettingsFields["screenCaptureExcludedApps"];
  screenCaptureRetention: VoiceSettingsFields["screenCaptureRetention"];
  screenCapturePreviewBeforeSend: VoiceSettingsFields["screenCapturePreviewBeforeSend"];
  screenCaptureOnboardingSeen: VoiceSettingsFields["screenCaptureOnboardingSeen"];
  customDictionary: VoiceSettingsFields["customDictionary"];
  voiceHistoryEnabled: VoiceSettingsFields["voiceHistoryEnabled"];
  voiceHistoryLimit: VoiceSettingsFields["voiceHistoryLimit"];
  voiceHistoryRetentionDays: VoiceSettingsFields["voiceHistoryRetentionDays"];
  voiceHistoryPreviewLength: VoiceSettingsFields["voiceHistoryPreviewLength"];
  voiceActionsEnabled: VoiceSettingsFields["voiceActionsEnabled"];
  voiceActionDefaultLanguage: VoiceSettingsFields["voiceActionDefaultLanguage"];
  voiceActionPreserveStyle: VoiceSettingsFields["voiceActionPreserveStyle"];
  voiceActionConfirmDestructive: VoiceSettingsFields["voiceActionConfirmDestructive"];
  voiceActionFormalTone: VoiceSettingsFields["voiceActionFormalTone"];
  voiceActionTranslationStyle: VoiceSettingsFields["voiceActionTranslationStyle"];
  voiceActionSummarizeLength: VoiceSettingsFields["voiceActionSummarizeLength"];
  // Video generation provider keys
  runwayApiSecret: string;
  vertexAIProjectId: string;
  vertexAILocation: string;
  vertexAICredentialsPath: string;
  // Mini Overlay settings
  miniOverlayDefaultMode: "direct" | "compose";
  miniOverlayAutoCloseAfterSpeak: boolean;
  miniOverlayKeepAppFocusedOnCompose: boolean;
  miniOverlayShowScreenPreview: boolean;
}

export const DEFAULT_FORM_STATE: FormState = {
  appLanguage: "en",
  llmProvider: "anthropic",
  anthropicApiKey: "",
  openrouterApiKey: "",
  kimiApiKey: "",
  minimaxApiKey: "",
  blackboxaiApiKey: "",
  deepseekApiKey: "",
  openaiApiKey: "",
  ollamaBaseUrl: "http://localhost:11434/v1",
  vllmBaseUrl: "http://localhost:8000/v1",
  vllmApiKey: "",
  vllmContextWindow: "",
  ollamaContextWindow: "",
  tavilyApiKey: "",
  firecrawlApiKey: "",
  webScraperProvider: "local",
  webSearchProvider: "auto",
  stylyAiApiKey: "",
  huggingFaceToken: "",
  chatModel: "",
  embeddingProvider: "openrouter",
  embeddingModel: "",
  researchModel: "",
  visionModel: "",
  utilityModel: "",
  openrouterArgs: "{}",
  theme: "dark",
  chatWorkspaceMode: DEFAULT_CHAT_WORKSPACE_MODE,
  toolLoadingMode: "deferred",
  toolDisplayMode: "compact",
  postEditHooksPreset: "off",
  postEditHooksEnabled: false,
  postEditTypecheckEnabled: false,
  postEditLintEnabled: false,
  postEditTypecheckScope: "auto",
  postEditRunInPatchTool: false,
  promptCachingEnabled: true,
  rtkEnabled: false,
  rtkVerbosity: 0,
  rtkUltraCompact: false,
  devWorkspaceEnabled: false,
  devWorkspaceAutoCleanup: true,
  devWorkspaceAutoCleanupDays: 7,
  chromiumBrowserMode: "standalone",
  chromiumUserProfilePath: "",
  embeddingReindexRequired: false,
  vectorDBEnabled: false,
  vectorSearchHybridEnabled: false,
  vectorSearchTokenChunkingEnabled: false,
  vectorSearchRerankingEnabled: false,
  vectorSearchQueryExpansionEnabled: false,
  vectorSearchLlmSynthesisEnabled: true,
  vectorSearchRrfK: 30,
  vectorSearchDenseWeight: 1.5,
  vectorSearchLexicalWeight: 0.2,
  vectorSearchRerankModel: "cross-encoder/ms-marco-MiniLM-L-6-v2",
  vectorSearchRerankTopK: 20,
  vectorSearchTokenChunkSize: 16,
  vectorSearchTokenChunkStride: 8,
  vectorSearchMaxFileLines: 3000,
  vectorSearchMaxLineLength: 1000,
  localGrepEnabled: true,
  localGrepMaxResults: 20,
  localGrepContextLines: 2,
  localGrepRespectGitignore: true,
  comfyuiEnabled: false,
  comfyuiCustomHost: "127.0.0.1",
  comfyuiCustomPort: 8188,
  comfyuiCustomUseHttps: false,
  comfyuiCustomAutoDetect: true,
  comfyuiCustomBaseUrl: "",
  avatar3dEnabled: false,
  emotionDetectionEnabled: false,
  everMemOSEnabled: false,
  everMemOSServerUrl: "",
  ttsEnabled: true,
  ttsProvider: "edge",
  ttsAutoMode: "off",
  elevenLabsApiKey: "",
  elevenLabsVoiceId: "",
  openaiTtsVoice: "alloy",
  edgeTtsVoice: "en-US-AriaNeural",
  ttsSummarizeThreshold: 500,
  ttsReadCodeBlocks: false,
  ttsSpeakCodeSymbols: false,
  sttEnabled: true,
  sttProvider: "local",
  sttLocalModel: DEFAULT_WHISPER_MODEL,
  voicePostProcessing: true,
  transcriberModel: "",
  voiceAgentName: "Selene",
  voiceAudioCues: true,
  voiceAutoLearn: true,
  voiceActivationMode: "tap",
  parakeetModel: "parakeet-tdt-0.6b-v3",
  parakeetAutoStart: true,
  parakeetServerPort: 0,
  voiceHotkey: "CommandOrControl+Shift+Space",
  screenCaptureEnabled: true,
  screenCaptureShortcut: "CommandOrControl+Shift+S",
  quickCaptureEnabled: true,
  quickCaptureHotkey: "CommandOrControl+Shift+A",
  quickCaptureAutoSend: false,
  quickCaptureAutoSendDelay: 3,
  screenCaptureExcludedApps: "1Password, Keychain Access, System Preferences",
  screenCaptureRetention: "session",
  screenCapturePreviewBeforeSend: true,
  screenCaptureOnboardingSeen: false,
  customDictionary: [],
  voiceHistoryEnabled: true,
  voiceHistoryLimit: 200,
  voiceHistoryRetentionDays: 30,
  voiceHistoryPreviewLength: 140,
  voiceActionsEnabled: true,
  voiceActionDefaultLanguage: "English",
  voiceActionPreserveStyle: true,
  voiceActionConfirmDestructive: true,
  voiceActionFormalTone: "auto",
  voiceActionTranslationStyle: "natural",
  voiceActionSummarizeLength: "medium",
  runwayApiSecret: "",
  vertexAIProjectId: "",
  vertexAILocation: "us-central1",
  vertexAICredentialsPath: "",
  miniOverlayDefaultMode: "direct",
  miniOverlayAutoCloseAfterSpeak: false,
  miniOverlayKeepAppFocusedOnCompose: true,
  miniOverlayShowScreenPreview: true,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildFormStateFromData(data: Record<string, any>): FormState {
  return {
    appLanguage: data.appLanguage === "tr" ? "tr" : "en",
    llmProvider: data.llmProvider || "anthropic",
    anthropicApiKey: data.anthropicApiKey || "",
    openrouterApiKey: data.openrouterApiKey || "",
    kimiApiKey: data.kimiApiKey || "",
    minimaxApiKey: data.minimaxApiKey || "",
    blackboxaiApiKey: data.blackboxaiApiKey || "",
    deepseekApiKey: data.deepseekApiKey || "",
    openaiApiKey: data.openaiApiKey || "",
    ollamaBaseUrl: data.ollamaBaseUrl || "http://localhost:11434/v1",
    vllmBaseUrl: data.vllmBaseUrl || "http://localhost:8000/v1",
    vllmApiKey: data.vllmApiKey || "",
    vllmContextWindow: data.vllmContextWindow || "",
    ollamaContextWindow: data.ollamaContextWindow || "",
    tavilyApiKey: data.tavilyApiKey || "",
    firecrawlApiKey: data.firecrawlApiKey || "",
    webScraperProvider: data.webScraperProvider || "local",
    webSearchProvider: data.webSearchProvider || "auto",
    stylyAiApiKey: data.stylyAiApiKey || "",
    huggingFaceToken: data.huggingFaceToken || "",
    chatModel: data.chatModel || "",
    embeddingProvider: data.embeddingProvider || "openrouter",
    embeddingModel: data.embeddingModel || "",
    researchModel: data.researchModel || "",
    visionModel: data.visionModel || "",
    utilityModel: data.utilityModel || "",
    openrouterArgs: data.openrouterArgs || "{}",
    theme: data.theme || "dark",
    chatWorkspaceMode: data.chatWorkspaceMode === "browser-tabs" ? "browser-tabs" : DEFAULT_CHAT_WORKSPACE_MODE,
    toolLoadingMode: data.toolLoadingMode || "deferred",
    toolDisplayMode: data.toolDisplayMode === "detailed" ? "detailed" : "compact",
    postEditHooksPreset: data.postEditHooksPreset ?? "off",
    postEditHooksEnabled: data.postEditHooksEnabled ?? false,
    postEditTypecheckEnabled: data.postEditTypecheckEnabled ?? false,
    postEditLintEnabled: data.postEditLintEnabled ?? false,
    postEditTypecheckScope: data.postEditTypecheckScope ?? "auto",
    postEditRunInPatchTool: data.postEditRunInPatchTool ?? false,
    promptCachingEnabled: data.promptCachingEnabled ?? true,
    rtkEnabled: data.rtkEnabled ?? false,
    rtkVerbosity: data.rtkVerbosity ?? 0,
    rtkUltraCompact: data.rtkUltraCompact ?? false,
    devWorkspaceEnabled: data.devWorkspaceEnabled ?? false,
    devWorkspaceAutoCleanup: data.devWorkspaceAutoCleanup ?? true,
    devWorkspaceAutoCleanupDays: data.devWorkspaceAutoCleanupDays ?? 7,
    chromiumBrowserMode: data.chromiumBrowserMode ?? "standalone",
    chromiumUserProfilePath: data.chromiumUserProfilePath ?? "",
    embeddingReindexRequired: data.embeddingReindexRequired ?? false,
    vectorDBEnabled: data.vectorDBEnabled || false,
    vectorSearchHybridEnabled: data.vectorSearchHybridEnabled ?? false,
    vectorSearchTokenChunkingEnabled: data.vectorSearchTokenChunkingEnabled ?? false,
    vectorSearchRerankingEnabled: data.vectorSearchRerankingEnabled ?? false,
    vectorSearchQueryExpansionEnabled: data.vectorSearchQueryExpansionEnabled ?? false,
    vectorSearchLlmSynthesisEnabled: data.vectorSearchLlmSynthesisEnabled ?? true,
    vectorSearchRrfK: data.vectorSearchRrfK ?? 30,
    vectorSearchDenseWeight: data.vectorSearchDenseWeight ?? 1.5,
    vectorSearchLexicalWeight: data.vectorSearchLexicalWeight ?? 0.2,
    vectorSearchRerankModel: data.vectorSearchRerankModel ?? "cross-encoder/ms-marco-MiniLM-L-6-v2",
    vectorSearchRerankTopK: data.vectorSearchRerankTopK ?? 20,
    vectorSearchTokenChunkSize: data.vectorSearchTokenChunkSize ?? 16,
    vectorSearchTokenChunkStride: data.vectorSearchTokenChunkStride ?? 8,
    vectorSearchMaxFileLines: data.vectorSearchMaxFileLines ?? 3000,
    vectorSearchMaxLineLength: data.vectorSearchMaxLineLength ?? 1000,
    localGrepEnabled: data.localGrepEnabled ?? true,
    localGrepMaxResults: data.localGrepMaxResults ?? 20,
    localGrepContextLines: data.localGrepContextLines ?? 2,
    localGrepRespectGitignore: data.localGrepRespectGitignore ?? true,
    comfyuiEnabled: data.comfyuiEnabled ?? false,
    comfyuiCustomHost: data.comfyuiCustomHost ?? "127.0.0.1",
    comfyuiCustomPort: data.comfyuiCustomPort ?? 8188,
    comfyuiCustomUseHttps: data.comfyuiCustomUseHttps ?? false,
    comfyuiCustomAutoDetect: data.comfyuiCustomAutoDetect ?? true,
    comfyuiCustomBaseUrl: data.comfyuiCustomBaseUrl ?? "",
    avatar3dEnabled: data.avatar3dEnabled ?? false,
    emotionDetectionEnabled: data.emotionDetectionEnabled ?? false,
    everMemOSEnabled: data.everMemOSEnabled ?? false,
    everMemOSServerUrl: data.everMemOSServerUrl ?? "",
    ttsEnabled: data.ttsEnabled ?? true,
    ttsProvider: data.ttsProvider ?? "edge",
    ttsAutoMode: data.ttsAutoMode ?? "off",
    elevenLabsApiKey: data.elevenLabsApiKey ?? "",
    elevenLabsVoiceId: data.elevenLabsVoiceId ?? "",
    openaiTtsVoice: data.openaiTtsVoice ?? "alloy",
    edgeTtsVoice: data.edgeTtsVoice ?? "en-US-AriaNeural",
    ttsSummarizeThreshold: data.ttsSummarizeThreshold ?? 500,
    ttsReadCodeBlocks: data.ttsReadCodeBlocks ?? false,
    ttsSpeakCodeSymbols: data.ttsSpeakCodeSymbols ?? false,
    sttEnabled: data.sttEnabled ?? true,
    sttProvider: data.sttProvider ?? "local",
    sttLocalModel: data.sttLocalModel ?? DEFAULT_WHISPER_MODEL,
    voicePostProcessing: data.voicePostProcessing ?? true,
    transcriberModel: data.transcriberModel ?? "",
    voiceAgentName: data.voiceAgentName ?? "Selene",
    voiceAudioCues: data.voiceAudioCues ?? true,
    voiceAutoLearn: data.voiceAutoLearn ?? true,
    voiceActivationMode: data.voiceActivationMode ?? "tap",
    parakeetModel: data.parakeetModel ?? "parakeet-tdt-0.6b-v3",
    parakeetAutoStart: data.parakeetAutoStart ?? true,
    parakeetServerPort: data.parakeetServerPort ?? 0,
    voiceHotkey: data.voiceHotkey ?? "CommandOrControl+Shift+Space",
    screenCaptureEnabled: data.screenCaptureEnabled ?? true,
    screenCaptureShortcut: data.screenCaptureShortcut ?? "CommandOrControl+Shift+S",
    quickCaptureEnabled: data.quickCaptureEnabled ?? true,
    quickCaptureHotkey: data.quickCaptureHotkey ?? "CommandOrControl+Shift+A",
    quickCaptureAutoSend: data.quickCaptureAutoSend ?? false,
    quickCaptureAutoSendDelay: data.quickCaptureAutoSendDelay ?? 3,
    screenCaptureExcludedApps: data.screenCaptureExcludedApps ?? "1Password, Keychain Access, System Preferences",
    screenCaptureRetention: data.screenCaptureRetention ?? "session",
    screenCapturePreviewBeforeSend: data.screenCapturePreviewBeforeSend ?? true,
    screenCaptureOnboardingSeen: data.screenCaptureOnboardingSeen ?? false,
    customDictionary: Array.isArray(data.customDictionary) ? data.customDictionary : [],
    voiceHistoryEnabled: data.voiceHistoryEnabled ?? true,
    voiceHistoryLimit: data.voiceHistoryLimit ?? 200,
    voiceHistoryRetentionDays: data.voiceHistoryRetentionDays ?? 30,
    voiceHistoryPreviewLength: data.voiceHistoryPreviewLength ?? 140,
    voiceActionsEnabled: data.voiceActionsEnabled ?? true,
    voiceActionDefaultLanguage: data.voiceActionDefaultLanguage ?? "English",
    voiceActionPreserveStyle: data.voiceActionPreserveStyle ?? true,
    voiceActionConfirmDestructive: data.voiceActionConfirmDestructive ?? true,
    voiceActionFormalTone: data.voiceActionFormalTone ?? "auto",
    voiceActionTranslationStyle: data.voiceActionTranslationStyle ?? "natural",
    voiceActionSummarizeLength: data.voiceActionSummarizeLength ?? "medium",
    runwayApiSecret: data.runwayApiSecret ?? "",
    vertexAIProjectId: data.vertexAIProjectId ?? "",
    vertexAILocation: data.vertexAILocation ?? "us-central1",
    vertexAICredentialsPath: data.vertexAICredentialsPath ?? "",
    miniOverlayDefaultMode: data.miniOverlayDefaultMode === "compose" ? "compose" : "direct",
    miniOverlayAutoCloseAfterSpeak: data.miniOverlayAutoCloseAfterSpeak ?? false,
    miniOverlayKeepAppFocusedOnCompose: data.miniOverlayKeepAppFocusedOnCompose ?? true,
    miniOverlayShowScreenPreview: data.miniOverlayShowScreenPreview ?? true,
  };
}
