import { NextRequest, NextResponse } from "next/server";
import { loadSettings, saveSettings, validateSettingsModels, type AppSettings } from "@/lib/settings/settings-manager";
import { invalidateProviderCache } from "@/lib/ai/providers";
import { validateModelConfiguration } from "@/lib/config/embedding-models";
import { locales, type Locale } from "@/i18n/config";

/**
 * GET /api/settings
 * Returns current application settings
 */
export async function GET() {
  try {
    const settings = loadSettings();
    // Don't expose full API keys - mask them for display
    const maskedSettings = {
      ...settings,
      anthropicApiKey: settings.anthropicApiKey ? maskApiKey(settings.anthropicApiKey) : undefined,
      openrouterApiKey: settings.openrouterApiKey ? maskApiKey(settings.openrouterApiKey) : undefined,
      kimiApiKey: settings.kimiApiKey ? maskApiKey(settings.kimiApiKey) : undefined,
      minimaxApiKey: settings.minimaxApiKey ? maskApiKey(settings.minimaxApiKey) : undefined,
      blackboxaiApiKey: settings.blackboxaiApiKey ? maskApiKey(settings.blackboxaiApiKey) : undefined,
      deepseekApiKey: settings.deepseekApiKey ? maskApiKey(settings.deepseekApiKey) : undefined,
      tavilyApiKey: settings.tavilyApiKey ? maskApiKey(settings.tavilyApiKey) : undefined,
      firecrawlApiKey: settings.firecrawlApiKey ? maskApiKey(settings.firecrawlApiKey) : undefined,
      stylyAiApiKey: settings.stylyAiApiKey ? maskApiKey(settings.stylyAiApiKey) : undefined,
      huggingFaceToken: settings.huggingFaceToken ? maskApiKey(settings.huggingFaceToken) : undefined,
      elevenLabsApiKey: settings.elevenLabsApiKey ? maskApiKey(settings.elevenLabsApiKey) : undefined,
      openaiApiKey: settings.openaiApiKey ? maskApiKey(settings.openaiApiKey) : undefined,
      vllmApiKey: settings.vllmApiKey ? maskApiKey(settings.vllmApiKey) : undefined,
      runwayApiSecret: settings.runwayApiSecret ? maskApiKey(settings.runwayApiSecret) : undefined,
    };
    return NextResponse.json(maskedSettings);
  } catch (error) {
    console.error("[Settings API] Error loading settings:", error);
    return NextResponse.json({ error: "Failed to load settings" }, { status: 500 });
  }
}

/**
 * PUT /api/settings
 * Updates application settings
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const currentSettings = loadSettings();

    // Locale must come from the supported set. The dedicated `/api/locale`
    // path already rejects bad values, but the general settings PUT used to
    // accept anything and persist it, which left the next launch with a value
    // next-intl couldn't resolve and silently fell back to English.
    if (body.appLanguage !== undefined && !locales.includes(body.appLanguage as Locale)) {
      return NextResponse.json(
        {
          error: `Unsupported appLanguage. Expected one of: ${locales.join(", ")}`,
        },
        { status: 400 },
      );
    }

    // Detect provider change early so we can clear stale model fields
    const newProvider = body.llmProvider ?? currentSettings.llmProvider;
    const providerIsChanging = newProvider !== currentSettings.llmProvider;

    // Build updated settings, preserving API keys if not explicitly changed
    // When provider changes and the request doesn't explicitly set model fields,
    // clear them so the new provider uses its own defaults instead of inheriting
    // incompatible model IDs from the previous provider.
    const updatedSettings: AppSettings = {
      ...currentSettings,
      llmProvider: newProvider,
      ollamaBaseUrl: body.ollamaBaseUrl !== undefined ? body.ollamaBaseUrl : currentSettings.ollamaBaseUrl,
      vllmBaseUrl: body.vllmBaseUrl !== undefined ? body.vllmBaseUrl : currentSettings.vllmBaseUrl,
      appLanguage: body.appLanguage !== undefined ? body.appLanguage : currentSettings.appLanguage,
      theme: body.theme ?? currentSettings.theme,
      chatWorkspaceMode:
        body.chatWorkspaceMode === "browser-tabs" || body.chatWorkspaceMode === "sidebar"
          ? body.chatWorkspaceMode
          : currentSettings.chatWorkspaceMode,
      webScraperProvider: body.webScraperProvider ?? currentSettings.webScraperProvider,
      webSearchProvider: body.webSearchProvider ?? currentSettings.webSearchProvider,
      // Model settings - allow empty string to clear, undefined to keep current
      // On provider switch: clear model fields unless the request explicitly provides new values
      chatModel: body.chatModel !== undefined ? body.chatModel : (providerIsChanging ? "" : currentSettings.chatModel),
      embeddingProvider: body.embeddingProvider !== undefined ? body.embeddingProvider : currentSettings.embeddingProvider,
      embeddingModel: body.embeddingModel !== undefined ? body.embeddingModel : currentSettings.embeddingModel,
      researchModel: body.researchModel !== undefined ? body.researchModel : (providerIsChanging ? "" : currentSettings.researchModel),
      visionModel: body.visionModel !== undefined ? body.visionModel : (providerIsChanging ? "" : currentSettings.visionModel),
      utilityModel: body.utilityModel !== undefined ? body.utilityModel : (providerIsChanging ? "" : currentSettings.utilityModel),
      transcriberModel: body.transcriberModel !== undefined ? body.transcriberModel : (providerIsChanging ? "" : currentSettings.transcriberModel),
      openrouterArgs: body.openrouterArgs !== undefined ? body.openrouterArgs : currentSettings.openrouterArgs,
      embeddingReindexRequired: body.embeddingReindexRequired !== undefined
        ? body.embeddingReindexRequired
        : currentSettings.embeddingReindexRequired,
      // Vector search settings - use explicit check for boolean
      vectorDBEnabled: body.vectorDBEnabled !== undefined ? body.vectorDBEnabled : currentSettings.vectorDBEnabled,
      vectorAutoSyncEnabled: body.vectorAutoSyncEnabled !== undefined ? body.vectorAutoSyncEnabled : currentSettings.vectorAutoSyncEnabled,
      vectorSyncIntervalMinutes: body.vectorSyncIntervalMinutes !== undefined ? body.vectorSyncIntervalMinutes : currentSettings.vectorSyncIntervalMinutes,
      vectorSearchHybridEnabled: body.vectorSearchHybridEnabled !== undefined ? body.vectorSearchHybridEnabled : currentSettings.vectorSearchHybridEnabled,
      vectorSearchTokenChunkingEnabled: body.vectorSearchTokenChunkingEnabled !== undefined ? body.vectorSearchTokenChunkingEnabled : currentSettings.vectorSearchTokenChunkingEnabled,
      vectorSearchRerankingEnabled: body.vectorSearchRerankingEnabled !== undefined ? body.vectorSearchRerankingEnabled : currentSettings.vectorSearchRerankingEnabled,
      vectorSearchQueryExpansionEnabled: body.vectorSearchQueryExpansionEnabled !== undefined ? body.vectorSearchQueryExpansionEnabled : currentSettings.vectorSearchQueryExpansionEnabled,
      vectorSearchLlmSynthesisEnabled: body.vectorSearchLlmSynthesisEnabled !== undefined ? body.vectorSearchLlmSynthesisEnabled : currentSettings.vectorSearchLlmSynthesisEnabled,
      // Sprint 7 W7.1.G — Swift engine opt-in. Reject anything other than the
      // two known values so a malformed PUT can't break the search router.
      vectorSearchSearchEngine:
        body.vectorSearchSearchEngine === "swift" || body.vectorSearchSearchEngine === "lance"
          ? body.vectorSearchSearchEngine
          : currentSettings.vectorSearchSearchEngine,

      vectorSearchRrfK: body.vectorSearchRrfK !== undefined ? body.vectorSearchRrfK : currentSettings.vectorSearchRrfK,
      vectorSearchDenseWeight: body.vectorSearchDenseWeight !== undefined ? body.vectorSearchDenseWeight : currentSettings.vectorSearchDenseWeight,
      vectorSearchLexicalWeight: body.vectorSearchLexicalWeight !== undefined ? body.vectorSearchLexicalWeight : currentSettings.vectorSearchLexicalWeight,
      vectorSearchRerankModel: body.vectorSearchRerankModel !== undefined ? body.vectorSearchRerankModel : currentSettings.vectorSearchRerankModel,
      vectorSearchRerankTopK: body.vectorSearchRerankTopK !== undefined ? body.vectorSearchRerankTopK : currentSettings.vectorSearchRerankTopK,
      vectorSearchTokenChunkSize: body.vectorSearchTokenChunkSize !== undefined ? body.vectorSearchTokenChunkSize : currentSettings.vectorSearchTokenChunkSize,
      vectorSearchTokenChunkStride: body.vectorSearchTokenChunkStride !== undefined ? body.vectorSearchTokenChunkStride : currentSettings.vectorSearchTokenChunkStride,
      vectorSearchMaxFileLines: body.vectorSearchMaxFileLines !== undefined ? body.vectorSearchMaxFileLines : currentSettings.vectorSearchMaxFileLines,
      vectorSearchMaxLineLength: body.vectorSearchMaxLineLength !== undefined ? body.vectorSearchMaxLineLength : currentSettings.vectorSearchMaxLineLength,
      // Preferences
      toolLoadingMode: body.toolLoadingMode !== undefined ? body.toolLoadingMode : currentSettings.toolLoadingMode,
      toolDisplayMode: body.toolDisplayMode !== undefined ? body.toolDisplayMode : currentSettings.toolDisplayMode,
      postEditHooksPreset: body.postEditHooksPreset !== undefined ? body.postEditHooksPreset : currentSettings.postEditHooksPreset,
      postEditHooksEnabled: body.postEditHooksEnabled !== undefined ? body.postEditHooksEnabled : currentSettings.postEditHooksEnabled,
      postEditTypecheckEnabled: body.postEditTypecheckEnabled !== undefined ? body.postEditTypecheckEnabled : currentSettings.postEditTypecheckEnabled,
      postEditLintEnabled: body.postEditLintEnabled !== undefined ? body.postEditLintEnabled : currentSettings.postEditLintEnabled,
      postEditTypecheckScope: body.postEditTypecheckScope !== undefined ? body.postEditTypecheckScope : currentSettings.postEditTypecheckScope,
      postEditRunInPatchTool: body.postEditRunInPatchTool !== undefined ? body.postEditRunInPatchTool : currentSettings.postEditRunInPatchTool,
      designPostEditHooksPreset: body.designPostEditHooksPreset !== undefined ? body.designPostEditHooksPreset : currentSettings.designPostEditHooksPreset,
      designPostEditHooksEnabled: body.designPostEditHooksEnabled !== undefined ? body.designPostEditHooksEnabled : currentSettings.designPostEditHooksEnabled,
      designPostEditTypecheckEnabled: body.designPostEditTypecheckEnabled !== undefined ? body.designPostEditTypecheckEnabled : currentSettings.designPostEditTypecheckEnabled,
      designPostEditImportValidationEnabled: body.designPostEditImportValidationEnabled !== undefined ? body.designPostEditImportValidationEnabled : currentSettings.designPostEditImportValidationEnabled,
      designPostEditPreviewEnabled: body.designPostEditPreviewEnabled !== undefined ? body.designPostEditPreviewEnabled : currentSettings.designPostEditPreviewEnabled,
      designTypecheckStrictMode: body.designTypecheckStrictMode !== undefined ? body.designTypecheckStrictMode : currentSettings.designTypecheckStrictMode,
      designJsxValidationEnabled: body.designJsxValidationEnabled !== undefined ? body.designJsxValidationEnabled : currentSettings.designJsxValidationEnabled,
      promptCachingEnabled: body.promptCachingEnabled !== undefined ? body.promptCachingEnabled : currentSettings.promptCachingEnabled,
      // RTK (experimental)
      rtkEnabled: body.rtkEnabled !== undefined ? body.rtkEnabled : currentSettings.rtkEnabled,
      rtkVerbosity: body.rtkVerbosity !== undefined ? body.rtkVerbosity : currentSettings.rtkVerbosity,
      rtkUltraCompact: body.rtkUltraCompact !== undefined ? body.rtkUltraCompact : currentSettings.rtkUltraCompact,
      // Vertex AI Video Generation
      vertexAIProjectId: body.vertexAIProjectId !== undefined ? body.vertexAIProjectId : currentSettings.vertexAIProjectId,
      vertexAILocation: body.vertexAILocation !== undefined ? body.vertexAILocation : currentSettings.vertexAILocation,
      vertexAICredentialsPath: body.vertexAICredentialsPath !== undefined ? body.vertexAICredentialsPath : currentSettings.vertexAICredentialsPath,
      // ComfyUI / Local Image Generation
      comfyuiEnabled: body.comfyuiEnabled !== undefined ? body.comfyuiEnabled : currentSettings.comfyuiEnabled,
      comfyuiCustomHost: body.comfyuiCustomHost !== undefined ? body.comfyuiCustomHost : currentSettings.comfyuiCustomHost,
      comfyuiCustomPort: body.comfyuiCustomPort !== undefined ? body.comfyuiCustomPort : currentSettings.comfyuiCustomPort,
      comfyuiCustomUseHttps: body.comfyuiCustomUseHttps !== undefined ? body.comfyuiCustomUseHttps : currentSettings.comfyuiCustomUseHttps,
      comfyuiCustomAutoDetect: body.comfyuiCustomAutoDetect !== undefined ? body.comfyuiCustomAutoDetect : currentSettings.comfyuiCustomAutoDetect,
      comfyuiCustomBaseUrl: body.comfyuiCustomBaseUrl !== undefined ? body.comfyuiCustomBaseUrl : currentSettings.comfyuiCustomBaseUrl,
      // Local Grep settings
      localGrepEnabled: body.localGrepEnabled !== undefined ? body.localGrepEnabled : currentSettings.localGrepEnabled,
      localGrepMaxResults: body.localGrepMaxResults !== undefined ? body.localGrepMaxResults : currentSettings.localGrepMaxResults,
      localGrepContextLines: body.localGrepContextLines !== undefined ? body.localGrepContextLines : currentSettings.localGrepContextLines,
      localGrepRespectGitignore: body.localGrepRespectGitignore !== undefined ? body.localGrepRespectGitignore : currentSettings.localGrepRespectGitignore,
      // Voice & Audio - TTS
      ttsEnabled: body.ttsEnabled !== undefined ? body.ttsEnabled : currentSettings.ttsEnabled,
      ttsProvider: body.ttsProvider !== undefined ? body.ttsProvider : currentSettings.ttsProvider,
      ttsAutoMode: body.ttsAutoMode !== undefined ? body.ttsAutoMode : currentSettings.ttsAutoMode,
      elevenLabsVoiceId: body.elevenLabsVoiceId !== undefined ? body.elevenLabsVoiceId : currentSettings.elevenLabsVoiceId,
      openaiTtsVoice: body.openaiTtsVoice !== undefined ? body.openaiTtsVoice : currentSettings.openaiTtsVoice,
      openaiTtsModel: body.openaiTtsModel !== undefined ? body.openaiTtsModel : currentSettings.openaiTtsModel,
      edgeTtsVoice: body.edgeTtsVoice !== undefined ? body.edgeTtsVoice : currentSettings.edgeTtsVoice,
      ttsSummarizeThreshold: body.ttsSummarizeThreshold !== undefined ? body.ttsSummarizeThreshold : currentSettings.ttsSummarizeThreshold,
      ttsReadCodeBlocks: body.ttsReadCodeBlocks !== undefined ? body.ttsReadCodeBlocks : currentSettings.ttsReadCodeBlocks,
      ttsSpeakCodeSymbols: body.ttsSpeakCodeSymbols !== undefined ? body.ttsSpeakCodeSymbols : currentSettings.ttsSpeakCodeSymbols,
      // Voice & Audio - STT
      sttEnabled: body.sttEnabled !== undefined ? body.sttEnabled : currentSettings.sttEnabled,
      sttProvider: body.sttProvider !== undefined ? body.sttProvider : currentSettings.sttProvider,
      sttLocalModel: body.sttLocalModel !== undefined ? body.sttLocalModel : currentSettings.sttLocalModel,
      whisperCppPath: body.whisperCppPath !== undefined ? body.whisperCppPath : currentSettings.whisperCppPath,
      voicePostProcessing: body.voicePostProcessing !== undefined ? body.voicePostProcessing : currentSettings.voicePostProcessing,
      voiceAgentName: body.voiceAgentName !== undefined ? body.voiceAgentName : currentSettings.voiceAgentName,
      voiceAudioCues: body.voiceAudioCues !== undefined ? body.voiceAudioCues : currentSettings.voiceAudioCues,
      voiceAutoLearn: body.voiceAutoLearn !== undefined ? body.voiceAutoLearn : currentSettings.voiceAutoLearn,
      voiceActivationMode: body.voiceActivationMode !== undefined ? body.voiceActivationMode : currentSettings.voiceActivationMode,
      parakeetModel: body.parakeetModel !== undefined ? body.parakeetModel : currentSettings.parakeetModel,
      parakeetAutoStart: body.parakeetAutoStart !== undefined ? body.parakeetAutoStart : currentSettings.parakeetAutoStart,
      parakeetServerPort: body.parakeetServerPort !== undefined ? body.parakeetServerPort : currentSettings.parakeetServerPort,
      voiceHotkey: body.voiceHotkey !== undefined ? body.voiceHotkey : currentSettings.voiceHotkey,
      screenCaptureEnabled: body.screenCaptureEnabled !== undefined ? body.screenCaptureEnabled : currentSettings.screenCaptureEnabled,
      screenCaptureShortcut: body.screenCaptureShortcut !== undefined ? body.screenCaptureShortcut : currentSettings.screenCaptureShortcut,
      quickCaptureEnabled: body.quickCaptureEnabled !== undefined ? body.quickCaptureEnabled : currentSettings.quickCaptureEnabled,
      quickCaptureHotkey: body.quickCaptureHotkey !== undefined ? body.quickCaptureHotkey : currentSettings.quickCaptureHotkey,
      quickCaptureAutoSend: body.quickCaptureAutoSend !== undefined ? body.quickCaptureAutoSend : currentSettings.quickCaptureAutoSend,
      quickCaptureAutoSendDelay: body.quickCaptureAutoSendDelay !== undefined ? body.quickCaptureAutoSendDelay : currentSettings.quickCaptureAutoSendDelay,
      miniOverlayDefaultMode:
        body.miniOverlayDefaultMode === "compose" || body.miniOverlayDefaultMode === "direct"
          ? body.miniOverlayDefaultMode
          : currentSettings.miniOverlayDefaultMode,
      miniOverlayAutoCloseAfterSpeak: body.miniOverlayAutoCloseAfterSpeak !== undefined ? body.miniOverlayAutoCloseAfterSpeak : currentSettings.miniOverlayAutoCloseAfterSpeak,
      miniOverlayKeepAppFocusedOnCompose: body.miniOverlayKeepAppFocusedOnCompose !== undefined ? body.miniOverlayKeepAppFocusedOnCompose : currentSettings.miniOverlayKeepAppFocusedOnCompose,
      miniOverlayShowScreenPreview: body.miniOverlayShowScreenPreview !== undefined ? body.miniOverlayShowScreenPreview : currentSettings.miniOverlayShowScreenPreview,
      screenCaptureExcludedApps: body.screenCaptureExcludedApps !== undefined ? body.screenCaptureExcludedApps : currentSettings.screenCaptureExcludedApps,
      screenCaptureRetention: body.screenCaptureRetention !== undefined ? body.screenCaptureRetention : currentSettings.screenCaptureRetention,
      screenCapturePreviewBeforeSend: body.screenCapturePreviewBeforeSend !== undefined ? body.screenCapturePreviewBeforeSend : currentSettings.screenCapturePreviewBeforeSend,
      screenCaptureOnboardingSeen: body.screenCaptureOnboardingSeen !== undefined ? body.screenCaptureOnboardingSeen : currentSettings.screenCaptureOnboardingSeen,
      customDictionary: Array.isArray(body.customDictionary) ? body.customDictionary : (currentSettings.customDictionary ?? []),
      voiceHistoryEnabled: body.voiceHistoryEnabled !== undefined ? body.voiceHistoryEnabled : currentSettings.voiceHistoryEnabled,
      voiceHistoryLimit: body.voiceHistoryLimit !== undefined ? body.voiceHistoryLimit : currentSettings.voiceHistoryLimit,
      voiceHistoryRetentionDays: body.voiceHistoryRetentionDays !== undefined ? body.voiceHistoryRetentionDays : currentSettings.voiceHistoryRetentionDays,
      voiceHistoryPreviewLength: body.voiceHistoryPreviewLength !== undefined ? body.voiceHistoryPreviewLength : currentSettings.voiceHistoryPreviewLength,
      voiceActionsEnabled: body.voiceActionsEnabled !== undefined ? body.voiceActionsEnabled : currentSettings.voiceActionsEnabled,
      voiceActionDefaultLanguage: body.voiceActionDefaultLanguage !== undefined ? body.voiceActionDefaultLanguage : currentSettings.voiceActionDefaultLanguage,
      voiceActionPreserveStyle: body.voiceActionPreserveStyle !== undefined ? body.voiceActionPreserveStyle : currentSettings.voiceActionPreserveStyle,
      voiceActionConfirmDestructive: body.voiceActionConfirmDestructive !== undefined ? body.voiceActionConfirmDestructive : currentSettings.voiceActionConfirmDestructive,
      voiceActionFormalTone: body.voiceActionFormalTone !== undefined ? body.voiceActionFormalTone : currentSettings.voiceActionFormalTone,
      voiceActionTranslationStyle: body.voiceActionTranslationStyle !== undefined ? body.voiceActionTranslationStyle : currentSettings.voiceActionTranslationStyle,
      voiceActionSummarizeLength: body.voiceActionSummarizeLength !== undefined ? body.voiceActionSummarizeLength : currentSettings.voiceActionSummarizeLength,
      // Developer Workspace
      devWorkspaceEnabled: body.devWorkspaceEnabled !== undefined ? body.devWorkspaceEnabled : currentSettings.devWorkspaceEnabled,
      devWorkspaceAutoCleanup: body.devWorkspaceAutoCleanup !== undefined ? body.devWorkspaceAutoCleanup : currentSettings.devWorkspaceAutoCleanup,
      devWorkspaceAutoCleanupDays: body.devWorkspaceAutoCleanupDays !== undefined ? body.devWorkspaceAutoCleanupDays : currentSettings.devWorkspaceAutoCleanupDays,
      workspaceOnboardingSeen: body.workspaceOnboardingSeen !== undefined ? body.workspaceOnboardingSeen : currentSettings.workspaceOnboardingSeen,
      // Browser Automation
      chromiumBrowserMode: body.chromiumBrowserMode !== undefined ? body.chromiumBrowserMode : currentSettings.chromiumBrowserMode,
      chromiumUserProfilePath: body.chromiumUserProfilePath !== undefined ? body.chromiumUserProfilePath : currentSettings.chromiumUserProfilePath,
      // 3D Avatar
      avatar3dEnabled: body.avatar3dEnabled !== undefined ? body.avatar3dEnabled : currentSettings.avatar3dEnabled,
      // Emotion Detection
      emotionDetectionEnabled: body.emotionDetectionEnabled !== undefined ? body.emotionDetectionEnabled : currentSettings.emotionDetectionEnabled,
      // EverMemOS
      everMemOSEnabled: body.everMemOSEnabled !== undefined ? body.everMemOSEnabled : currentSettings.everMemOSEnabled,
      everMemOSServerUrl: body.everMemOSServerUrl !== undefined ? body.everMemOSServerUrl : currentSettings.everMemOSServerUrl,
      // First-visit modals
      hasSeenThemeChooser: body.hasSeenThemeChooser !== undefined ? body.hasSeenThemeChooser : currentSettings.hasSeenThemeChooser,
      // Custom context window overrides for local providers
      vllmContextWindow: body.vllmContextWindow !== undefined ? body.vllmContextWindow : currentSettings.vllmContextWindow,
      ollamaContextWindow: body.ollamaContextWindow !== undefined ? body.ollamaContextWindow : currentSettings.ollamaContextWindow,
    };

    // Only update API keys if they're provided and not masked
    if (body.anthropicApiKey && !body.anthropicApiKey.includes("•")) {
      updatedSettings.anthropicApiKey = body.anthropicApiKey;
    }

    if (body.openrouterApiKey && !body.openrouterApiKey.includes("•")) {
      updatedSettings.openrouterApiKey = body.openrouterApiKey;
    }
    if (body.kimiApiKey && !body.kimiApiKey.includes("•")) {
      updatedSettings.kimiApiKey = body.kimiApiKey;
    }
    if (body.kimiAuth !== undefined) {
      updatedSettings.kimiAuth = body.kimiAuth;
    }
    if (body.kimiToken !== undefined) {
      updatedSettings.kimiToken = body.kimiToken;
    }
    if (body.kimiDeviceId !== undefined) {
      updatedSettings.kimiDeviceId = body.kimiDeviceId;
    }
    if (body.minimaxApiKey && !body.minimaxApiKey.includes("•")) {
      updatedSettings.minimaxApiKey = body.minimaxApiKey;
    }
    if (body.blackboxaiApiKey && !body.blackboxaiApiKey.includes("•")) {
      updatedSettings.blackboxaiApiKey = body.blackboxaiApiKey;
    }
    if (body.deepseekApiKey && !body.deepseekApiKey.includes("•")) {
      updatedSettings.deepseekApiKey = body.deepseekApiKey;
    }
    if (body.tavilyApiKey !== undefined && !String(body.tavilyApiKey).includes("•")) {
      const nextTavilyApiKey = String(body.tavilyApiKey).trim();
      updatedSettings.tavilyApiKey = nextTavilyApiKey.length > 0 ? nextTavilyApiKey : undefined;
    }
    if (body.firecrawlApiKey && !body.firecrawlApiKey.includes("•")) {
      updatedSettings.firecrawlApiKey = body.firecrawlApiKey;
    }
    if (body.stylyAiApiKey && !body.stylyAiApiKey.includes("•")) {
      updatedSettings.stylyAiApiKey = body.stylyAiApiKey;
    }
    if (body.huggingFaceToken && !body.huggingFaceToken.includes("•")) {
      updatedSettings.huggingFaceToken = body.huggingFaceToken;
    }
    if (body.elevenLabsApiKey && !body.elevenLabsApiKey.includes("•")) {
      updatedSettings.elevenLabsApiKey = body.elevenLabsApiKey;
    }
    if (body.openaiApiKey && !body.openaiApiKey.includes("•")) {
      updatedSettings.openaiApiKey = body.openaiApiKey;
    }
    if (body.vllmApiKey && !body.vllmApiKey.includes("•")) {
      updatedSettings.vllmApiKey = body.vllmApiKey;
    }
    if (body.runwayApiSecret && !body.runwayApiSecret.includes("•")) {
      updatedSettings.runwayApiSecret = body.runwayApiSecret;
    }

    const embeddingConfigChanged = (
      (currentSettings.embeddingProvider || "openrouter") !== (updatedSettings.embeddingProvider || "openrouter") ||
      (currentSettings.embeddingModel || "") !== (updatedSettings.embeddingModel || "")
    );

    if (embeddingConfigChanged) {
      updatedSettings.embeddingReindexRequired = true;
    }

    // Validate embedding + reranker model configuration
    const validation = validateModelConfiguration({
      embeddingProvider: updatedSettings.embeddingProvider || "openrouter",
      embeddingModel: updatedSettings.embeddingModel || "",
      rerankingEnabled: updatedSettings.vectorSearchRerankingEnabled ?? false,
      rerankModel: updatedSettings.vectorSearchRerankModel || "",
      previousEmbeddingProvider: currentSettings.embeddingProvider,
      previousEmbeddingModel: currentSettings.embeddingModel,
    });

    // Block save if reranker is definitely an embedding model (wrong model type)
    if (!validation.valid) {
      return NextResponse.json(
        {
          error: "Invalid model configuration",
          details: validation.errors,
          warnings: validation.warnings,
        },
        { status: 400 }
      );
    }

    // Validate model-provider compatibility before saving
    // This replaces the old normalizeModelsForProvider() on-read clearing
    const modelValidation = validateSettingsModels(updatedSettings);
    if (!modelValidation.valid) {
      return NextResponse.json(
        {
          error: "Incompatible model configuration",
          details: modelValidation.errors,
        },
        { status: 400 },
      );
    }

    // CRITICAL: If provider changed, clear cached provider instances so the new
    // provider is used immediately. Without this, stale Antigravity/ClaudeCode/etc.
    // client instances persist in memory even after switching providers.
    saveSettings(updatedSettings);

    if (providerIsChanging) {
      invalidateProviderCache();
      console.log(
        `[Settings API] Provider changed: ${currentSettings.llmProvider} -> ${newProvider}, ` +
        `invalidated provider cache and cleared model fields`
      );
    }

    const shouldRecommendFolderResync =
      Boolean(validation.reindexRequired) || validation.warnings.some(warningSuggestsFolderResync);
    const normalizedWarnings = validation.warnings.map((warning) => {
      if (!warningSuggestsFolderResync(warning)) {
        return warning;
      }
      return "Search index settings changed. Some synced folders may need a refresh.";
    });

    // Include warnings in successful response so the UI can display them
    const responsePayload: Record<string, unknown> = { success: true };
    if (normalizedWarnings.length > 0) {
      responsePayload.warnings = [...new Set(normalizedWarnings)];
    }
    if (validation.embeddingDimensions) {
      responsePayload.embeddingDimensions = validation.embeddingDimensions;
    }
    if (validation.reindexRequired) {
      responsePayload.reindexRequired = true;
    }
    if (shouldRecommendFolderResync) {
      responsePayload.folderResyncRecommended = true;
      responsePayload.folderResyncMessage = "Search index settings changed. If results look outdated, refresh synced folders in Agent Settings.";
    }

    return NextResponse.json(responsePayload);
  } catch (error) {
    console.error("[Settings API] Error saving settings:", error);
    return NextResponse.json({ error: "Failed to save settings" }, { status: 500 });
  }
}

function warningSuggestsFolderResync(warning: string): boolean {
  const normalized = warning.toLowerCase();
  return normalized.includes("reindex") || normalized.includes("embedding model changed") || normalized.includes("vectors");
}

// PATCH is an alias for PUT — both support partial updates via deep merge with current settings.
export { PUT as PATCH };

function maskApiKey(key: string): string {
  if (key.length <= 8) return "••••••••";
  return key.slice(0, 4) + "••••••••" + key.slice(-4);
}
