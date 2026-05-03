"use client";

import React from "react";
import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslations } from "next-intl";
import { BrainIcon, KeyIcon, SparklesIcon } from "lucide-react";
import { CustomWorkflowsManager } from "@/components/comfyui";
import { AdvancedVectorSettings } from "@/components/settings/advanced-vector-settings";
import { SwiftEngineSettings } from "@/components/settings/swift-engine-settings";
import { MCPSettings } from "@/components/settings/mcp-settings";
import { PluginSettings } from "@/components/settings/plugin-settings";
import {
  SettingsField,
  SettingsOptionGroup,
  SettingsPanelCard,
  SettingsRadioCard,
  SettingsToggleRow,
  settingsInputClassName,
  settingsSectionShellClassName,
} from "@/components/settings/settings-form-layout";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { LLMProvider } from "@/lib/ai/provider-types";
import type { FormState, SettingsSection } from "./settings-types";
import { WhisperModelSelector } from "./whisper-model-selector";
import { ParakeetModelSelector } from "./parakeet-model-selector";
import { EdgeTTSVoiceSelector } from "./edge-tts-voice-selector";
import { PreferencesSection } from "./preferences-section";
import { MemorySection } from "./memory-section";
import { ApiKeysSection } from "./api-keys-section";
import { ModelsSection } from "./models-section";
import { GhostOsSection } from "./ghost-os-section";
import { LocalEmbeddingModelSelector } from "./embedding-model-selector";
import { ShortcutRecorder } from "@/components/settings/shortcut-recorder";
import { buildModelCatalog } from "@/lib/config/model-catalog";
import { getElectronAPI, type PermissionCheckResult } from "@/lib/electron/types";
import { cn } from "@/lib/utils";

const TRANSCRIBER_AUTO_OPTION = "__auto__";

const EMPTY_PROVIDER_AUTH_STATUS: Record<LLMProvider, boolean> = {
  anthropic: false,
  openrouter: false,
  antigravity: false,
  codex: false,
  kimi: false,
  ollama: false,
  claudecode: false,
  minimax: false,
  blackboxai: false,
  deepseek: false,
  vllm: false,
};

function dedupeModelOptions(models: Array<{ id: string; name: string }>) {
  const seen = new Set<string>();

  return models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

function withCurrentModelOption(
  models: Array<{ id: string; name: string }>,
  currentModel: string,
) {
  if (!currentModel || models.some((model) => model.id === currentModel)) {
    return models;
  }

  return [{ id: currentModel, name: `${currentModel} (current)` }, ...models];
}

interface SettingsPanelProps {
  section: SettingsSection;
  formState: FormState;
  setFormState: React.Dispatch<React.SetStateAction<FormState>>;
  reloadSettings: () => Promise<void>;
  antigravityAuth: { isAuthenticated: boolean; email?: string; expiresAt?: number } | null;
  antigravityLoading: boolean;
  onAntigravityLogin: () => void;
  onAntigravityLogout: () => void;
  codexAuth: { isAuthenticated: boolean; email?: string; accountId?: string; expiresAt?: number } | null;
  codexLoading: boolean;
  onCodexLogin: () => void;
  onCodexLogout: () => void;
  claudecodeAuth: { isAuthenticated: boolean; email?: string; expiresAt?: number } | null;
  claudecodeLoading: boolean;
  onClaudeCodeLogin: () => void;
  onClaudeCodeLogout: () => void;
  claudeCodePasteMode: boolean;
  claudeCodeAuthSuccess: boolean;
  claudeCodeBrowserOpened: boolean;
  claudeCodeDiagnosticOutput: string[];
  onClaudeCodePasteSubmit: (code: string) => void;
  onClaudeCodePasteCancel: () => void;
  onClaudeCodeAuthComplete: () => void;
  kimiAuth: { isAuthenticated: boolean; email?: string; expiresAt?: number } | null;
  kimiLoading: boolean;
  kimiDeviceCode?: string | null;
  kimiVerificationUrl?: string | null;
  onKimiLogin: () => void;
  onKimiLogout: () => void;
}

function PermissionStatusBanner() {
  const [perms, setPerms] = useState<PermissionCheckResult | null>(null);
  const [checking, setChecking] = useState(false);

  // useCallback so we can safely list `check` in the useEffect dependency array
  const check = useCallback(async () => {
    const api = getElectronAPI();
    if (!api?.permissions) return;
    setChecking(true);
    try {
      const result = await api.permissions.check();
      setPerms(result);
    } finally {
      setChecking(false);
    }
  }, []); // getElectronAPI returns a stable window-level object

  useEffect(() => { void check(); }, [check]);

  const api = getElectronAPI();
  if (!api?.permissions) return null;

  const badge = (label: string, status: string | undefined) => {
    const ok = status === "granted";
    return (
      <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${ok ? "bg-terminal-green/15 text-terminal-green" : "bg-red-500/15 text-red-400"}`}>
        {label}: {ok ? "✓" : "✗"}
      </span>
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-terminal-border/50 bg-terminal-bg/10 px-3 py-2">
      {perms ? (
        <>
          {badge("Screen", perms.screen)}
          {badge("Mic", perms.microphone)}
          {badge("Shortcuts", perms.accessibility)}
          {perms.screen !== "granted" && (
            <button
              type="button"
              onClick={() => void api.permissions!.requestScreen()}
              className="ml-1 font-mono text-[10px] text-terminal-link underline underline-offset-2 hover:text-terminal-link/80"
            >
              Grant access
            </button>
          )}
        </>
      ) : (
        <span className="font-mono text-[10px] text-terminal-muted">{checking ? "Checking permissions…" : "Permission status unavailable"}</span>
      )}
      <button
        type="button"
        onClick={() => void check()}
        disabled={checking}
        className="ml-auto font-mono text-[10px] text-terminal-muted underline underline-offset-2 hover:text-terminal-dim disabled:opacity-50"
      >
        {checking ? "Checking…" : "Check permissions"}
      </button>
    </div>
  );
}

function ClearScreenshotsButton() {
  const t = useTranslations("settings");
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleClear = async () => {
    setClearing(true);
    setCleared(null);
    setError(null);
    try {
      const res = await fetch("/api/screenshots/clear", { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { deleted: number };
      setCleared(data.deleted);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear screenshots");
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={handleClear}
        disabled={clearing}
        className="rounded border border-terminal-border/60 bg-terminal-bg/10 px-3 py-1.5 font-mono text-xs text-terminal-muted hover:border-red-500/60 hover:text-red-400 disabled:opacity-50 dark:border-terminal-border/80 dark:bg-terminal-cream/5"
      >
        {clearing ? t("voice.privacy.clearingBtn") : t("voice.privacy.clearBtn")}
      </button>
      {cleared !== null && (
        <span className="font-mono text-xs text-terminal-green">
          {t("voice.privacy.clearSuccess", { count: cleared })}
        </span>
      )}
      {error !== null && (
        <span className="font-mono text-xs text-red-400">{error}</span>
      )}
    </div>
  );
}

export function SettingsPanel({
  section,
  formState,
  setFormState,
  reloadSettings,
  antigravityAuth,
  antigravityLoading,
  onAntigravityLogin,
  onAntigravityLogout,
  codexAuth,
  codexLoading,
  onCodexLogin,
  onCodexLogout,
  claudecodeAuth,
  claudecodeLoading,
  onClaudeCodeLogin,
  onClaudeCodeLogout,
  claudeCodePasteMode,
  claudeCodeAuthSuccess,
  claudeCodeBrowserOpened,
  claudeCodeDiagnosticOutput,
  onClaudeCodePasteSubmit,
  onClaudeCodePasteCancel,
  onClaudeCodeAuthComplete,
  kimiAuth,
  kimiLoading,
  kimiDeviceCode,
  kimiVerificationUrl,
  onKimiLogin,
  onKimiLogout,
}: SettingsPanelProps) {
  const t = useTranslations("settings");
  const updateField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setFormState((prev) => ({ ...prev, [key]: value }));
  };
  const [ollamaTranscriberModels, setOllamaTranscriberModels] = useState<Array<{ id: string; name: string }>>([]);
  const [vllmTranscriberModels, setVllmTranscriberModels] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    let cancelled = false;

    const loadProviderModels = async () => {
      try {
        if (formState.llmProvider === "ollama" && ollamaTranscriberModels.length === 0) {
          const response = await fetch("/api/ollama/tags");
          if (!response.ok) return;
          const data = await response.json() as { models?: Array<{ name: string }> };
          if (!cancelled) {
            setOllamaTranscriberModels(
              dedupeModelOptions((data.models ?? []).map((model) => ({ id: model.name, name: model.name }))),
            );
          }
          return;
        }

        if (formState.llmProvider === "vllm" && vllmTranscriberModels.length === 0) {
          const response = await fetch("/api/vllm/models");
          if (!response.ok) return;
          const data = await response.json() as { models?: string[] };
          if (!cancelled) {
            setVllmTranscriberModels(
              dedupeModelOptions((data.models ?? []).map((modelId) => ({ id: modelId, name: modelId }))),
            );
          }
        }
      } catch {
        // Keep the selector usable with the auto fallback even if probing fails.
      }
    };

    void loadProviderModels();

    return () => {
      cancelled = true;
    };
  }, [formState.llmProvider, ollamaTranscriberModels.length, vllmTranscriberModels.length]);

  const transcriberModelOptions = useMemo(() => {
    let options: Array<{ id: string; name: string }>;

    if (formState.llmProvider === "ollama") {
      options = ollamaTranscriberModels;
    } else if (formState.llmProvider === "vllm") {
      options = vllmTranscriberModels;
    } else {
      const catalog = buildModelCatalog(
        formState.llmProvider,
        EMPTY_PROVIDER_AUTH_STATUS,
        {
          chatModel: formState.chatModel,
          researchModel: formState.researchModel,
          visionModel: formState.visionModel,
          utilityModel: formState.utilityModel,
          transcriberModel: formState.transcriberModel,
        },
      );

      options = catalog
        .filter((model) => model.provider === formState.llmProvider)
        .map((model) => ({ id: model.id, name: model.name }));
    }

    return withCurrentModelOption(dedupeModelOptions(options), formState.transcriberModel);
  }, [
    formState.chatModel,
    formState.llmProvider,
    formState.researchModel,
    formState.transcriberModel,
    formState.utilityModel,
    formState.visionModel,
    ollamaTranscriberModels,
    vllmTranscriberModels,
  ]);

  if (section === "api-keys") {
    return (
      <ApiKeysSection
        formState={formState}
        updateField={updateField}
        antigravityAuth={antigravityAuth}
        antigravityLoading={antigravityLoading}
        onAntigravityLogin={onAntigravityLogin}
        onAntigravityLogout={onAntigravityLogout}
        codexAuth={codexAuth}
        codexLoading={codexLoading}
        onCodexLogin={onCodexLogin}
        onCodexLogout={onCodexLogout}
        claudecodeAuth={claudecodeAuth}
        claudecodeLoading={claudecodeLoading}
        onClaudeCodeLogin={onClaudeCodeLogin}
        onClaudeCodeLogout={onClaudeCodeLogout}
        claudeCodePasteMode={claudeCodePasteMode}
        claudeCodeAuthSuccess={claudeCodeAuthSuccess}
        claudeCodeBrowserOpened={claudeCodeBrowserOpened}
        claudeCodeDiagnosticOutput={claudeCodeDiagnosticOutput}
        onClaudeCodePasteSubmit={onClaudeCodePasteSubmit}
        onClaudeCodePasteCancel={onClaudeCodePasteCancel}
        onClaudeCodeAuthComplete={onClaudeCodeAuthComplete}
        kimiAuth={kimiAuth}
        kimiLoading={kimiLoading}
        kimiDeviceCode={kimiDeviceCode}
        kimiVerificationUrl={kimiVerificationUrl}
        onKimiLogin={onKimiLogin}
        onKimiLogout={onKimiLogout}
      />
    );
  }

  if (section === "models") {
    return <ModelsSection formState={formState} updateField={updateField} />;
  }

  if (section === "vector-search") {
    return (
      <div className={settingsSectionShellClassName}>
        <h2 className="font-mono text-lg font-semibold text-terminal-dark">{t("vector.title")}</h2>
        <p className="font-mono text-sm text-terminal-muted">
          {t("vector.subtitle")}
        </p>

        {formState.embeddingReindexRequired && (
          <div className="rounded border border-amber-200 bg-amber-50 p-4">
            <p className="font-mono text-xs text-amber-800">
              <strong>{t("vector.reindexRequired.title")}</strong> {t("vector.reindexRequired.body")}
            </p>
            <p className="mt-2 font-mono text-xs text-amber-800">
              {t("vector.reindexRequired.folderHint")}
            </p>
          </div>
        )}

        {/* Embedding Source — always visible so users can configure it before enabling vectorDB */}
        <div className="space-y-3 rounded border border-terminal-border bg-terminal-cream/30 p-4">
          <div>
            <label className="mb-1 block font-mono text-sm font-medium text-terminal-dark">
              {t("models.fields.embeddingProvider.label")}
            </label>
            <div className="space-y-2">
              <label className="flex items-center gap-3">
                <input
                  type="radio"
                  name="embeddingProvider"
                  value="openrouter"
                  checked={formState.embeddingProvider === "openrouter"}
                  onChange={(e) => updateField("embeddingProvider", e.target.value as FormState["embeddingProvider"])}
                  className="size-4 accent-terminal-green"
                />
                <span className="font-mono text-sm text-terminal-dark">
                  {t("models.fields.embeddingProvider.options.openrouter")}
                </span>
              </label>
              <label className="flex items-center gap-3">
                <input
                  type="radio"
                  name="embeddingProvider"
                  value="local"
                  checked={formState.embeddingProvider === "local"}
                  onChange={(e) => updateField("embeddingProvider", e.target.value as FormState["embeddingProvider"])}
                  className="size-4 accent-terminal-green"
                />
                <span className="font-mono text-sm text-terminal-dark">
                  {t("models.fields.embeddingProvider.options.local")}
                </span>
              </label>
            </div>
            <p className="mt-1 font-mono text-xs text-terminal-muted">
              {t("models.fields.embeddingProvider.helper")}
            </p>
          </div>
          <LocalEmbeddingModelSelector
            formState={formState}
            updateField={updateField}
            t={t}
          />
        </div>

        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            id="vectorDBEnabled"
            checked={formState.vectorDBEnabled}
            onChange={(e) => updateField("vectorDBEnabled", e.target.checked)}
            className="size-4 accent-terminal-green"
          />
          <label htmlFor="vectorDBEnabled" className="font-mono text-sm text-terminal-dark">
            {t("vector.enable")}
          </label>
        </div>

        {formState.vectorDBEnabled && (
          <div className="space-y-6">
            <div className="rounded border border-terminal-border bg-terminal-cream/50 p-4">
              <p className="font-mono text-sm text-terminal-muted">
                {t("vector.enabled")}
              </p>
              <p className="mt-2 font-mono text-xs text-terminal-muted">
                {t("vector.path")} <code className="rounded bg-terminal-dark/10 px-1">~/.local-data/vectordb/</code>
              </p>
            </div>

            {/* LLM Synthesis Toggle - Main visible option */}
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                id="llmSynthesisEnabled"
                checked={formState.vectorSearchLlmSynthesisEnabled}
                onChange={(e) => updateField("vectorSearchLlmSynthesisEnabled", e.target.checked)}
                className="size-4 accent-terminal-green"
              />
              <label htmlFor="llmSynthesisEnabled" className="font-mono text-sm text-terminal-dark">
                {t("vector.enableLlmSynthesis")}
              </label>
            </div>

            {/* Advanced Settings Accordion */}
            <AdvancedVectorSettings
              hybridEnabled={formState.vectorSearchHybridEnabled}
              onHybridEnabledChange={(v) => updateField("vectorSearchHybridEnabled", v)}
              denseWeight={formState.vectorSearchDenseWeight}
              onDenseWeightChange={(v) => updateField("vectorSearchDenseWeight", v)}
              lexicalWeight={formState.vectorSearchLexicalWeight}
              onLexicalWeightChange={(v) => updateField("vectorSearchLexicalWeight", v)}
              rrfK={formState.vectorSearchRrfK}
              onRrfKChange={(v) => updateField("vectorSearchRrfK", v)}
              tokenChunkingEnabled={formState.vectorSearchTokenChunkingEnabled}
              onTokenChunkingEnabledChange={(v) => updateField("vectorSearchTokenChunkingEnabled", v)}
              chunkSize={formState.vectorSearchTokenChunkSize}
              onChunkSizeChange={(v) => updateField("vectorSearchTokenChunkSize", v)}
              chunkStride={formState.vectorSearchTokenChunkStride}
              onChunkStrideChange={(v) => updateField("vectorSearchTokenChunkStride", v)}
              rerankingEnabled={formState.vectorSearchRerankingEnabled}
              onRerankingEnabledChange={(v) => updateField("vectorSearchRerankingEnabled", v)}
              rerankTopK={formState.vectorSearchRerankTopK}
              onRerankTopKChange={(v) => updateField("vectorSearchRerankTopK", v)}
              rerankModel={formState.vectorSearchRerankModel}
              onRerankModelChange={(v) => updateField("vectorSearchRerankModel", v)}
              queryExpansionEnabled={formState.vectorSearchQueryExpansionEnabled}
              onQueryExpansionEnabledChange={(v) => updateField("vectorSearchQueryExpansionEnabled", v)}
              maxFileLines={formState.vectorSearchMaxFileLines}
              onMaxFileLinesChange={(v) => updateField("vectorSearchMaxFileLines", v)}
              maxLineLength={formState.vectorSearchMaxLineLength}
              onMaxLineLengthChange={(v) => updateField("vectorSearchMaxLineLength", v)}
              embeddingModel={formState.embeddingModel}
              embeddingProvider={formState.embeddingProvider}
            />

            {/* Sprint 7 W7.1.G — Swift retrieval engine opt-in */}
            <SwiftEngineSettings />
          </div>
        )}
      </div>
    );
  }

  if (section === "preferences") {
    return (
      <div className={settingsSectionShellClassName}>
        <PreferencesSection
          formState={formState}
          updateField={updateField}
          reloadSettings={reloadSettings}
        />
      </div>
    );
  }

  if (section === "comfyui") {
    return (
      <div className={settingsSectionShellClassName}>
        <div>
          <h2 className="mb-2 text-lg font-semibold text-terminal-text">{t("localImage.heading")}</h2>
          <p className="text-sm text-terminal-muted">
            {t("localImage.description")}
          </p>
        </div>

        <div className="rounded-xl border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-terminal-border bg-terminal-green/15 text-terminal-green">
                <KeyIcon className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-semibold text-terminal-text">{t("localImage.hfTokenTitle")}</p>
                <p className="text-xs text-terminal-muted">
                  {t("localImage.hfTokenDesc")}
                </p>
              </div>
            </div>
            <a
              href="https://huggingface.co/settings/tokens"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-terminal-green underline hover:text-terminal-green/80"
            >
              {t("localImage.hfTokenLink")}
            </a>
          </div>
          <input
            type="password"
            value={formState.huggingFaceToken}
            onChange={(e) => updateField("huggingFaceToken", e.target.value)}
            placeholder={t("localImage.hfTokenPlaceholder")}
            className="mt-3 w-full rounded border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 px-3 py-2 text-sm text-terminal-text placeholder:text-terminal-muted/60 focus:border-terminal-green focus:outline-none focus:ring-1 focus:ring-terminal-green"
          />
        </div>

        <div className="rounded-xl border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 p-4 space-y-3">
          <h3 className="text-sm font-semibold text-terminal-text">{t("localImage.primaryFlowTitle")}</h3>
          <p className="text-xs text-terminal-muted">{t("localImage.primaryFlowDesc")}</p>
          <p className="text-xs text-terminal-muted">{t("localImage.workflowsDesc")}</p>
        </div>

        <details className="rounded-xl border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 p-4">
          <summary className="cursor-pointer text-sm font-semibold text-terminal-text">
            {t("localImage.advancedSetupTitle")}
          </summary>
          <p className="mt-2 text-xs text-terminal-muted">{t("localImage.advancedSetupDesc")}</p>

          <div className="mt-4 space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-terminal-text">{t("localImage.workflowsHeading")}</h3>
              <p className="text-xs text-terminal-muted">
                {t("localImage.workflowsDesc")}
              </p>
            </div>
            <CustomWorkflowsManager
              connectionBaseUrl={formState.comfyuiCustomBaseUrl}
              connectionHost={formState.comfyuiCustomHost}
              connectionPort={formState.comfyuiCustomPort}
              connectionUseHttps={formState.comfyuiCustomUseHttps}
              connectionAutoDetect={formState.comfyuiCustomAutoDetect}
              onConnectionBaseUrlChange={(value: string) => updateField("comfyuiCustomBaseUrl", value)}
              onConnectionHostChange={(value: string) => updateField("comfyuiCustomHost", value)}
              onConnectionPortChange={(value: number) => updateField("comfyuiCustomPort", value)}
              onConnectionUseHttpsChange={(value: boolean) => updateField("comfyuiCustomUseHttps", value)}
              onConnectionAutoDetectChange={(value: boolean) => updateField("comfyuiCustomAutoDetect", value)}
            />
          </div>
        </details>
      </div>
    );
  }

  if (section === "memory") {
    return (
      <div className={settingsSectionShellClassName}>
        <MemorySection />
      </div>
    );
  }

  if (section === "mcp") {
    return (
      <div className={settingsSectionShellClassName}>
        <div>
          <h2 className="mb-2 font-mono text-lg font-semibold text-terminal-dark">
            Tool servers (MCP)
          </h2>
          <p className="mb-4 font-mono text-sm text-terminal-muted">
            Connect external tool servers so your agent can use more tools.
          </p>
        </div>
        <MCPSettings />
        <div className="mt-6 border-t pt-6">
          <GhostOsSection />
        </div>
      </div>
    );
  }

  if (section === "plugins") {
    return (
      <div className={settingsSectionShellClassName}>
        <PluginSettings />
      </div>
    );
  }

  if (section === "voice") {
    const ttsAutoModeOptions = [
      { value: "off" as const, label: t("voice.tts.modeOff"), description: t("voice.tts.modeOffDesc") },
      { value: "channels-only" as const, label: t("voice.tts.modeChannels"), description: t("voice.tts.modeChannelsDesc") },
      { value: "always" as const, label: t("voice.tts.modeAlways"), description: t("voice.tts.modeAlwaysDesc") },
    ];

    const ttsProviderOptions = [
      { value: "edge" as const, label: t("voice.tts.providerEdge"), description: t("voice.tts.providerEdgeDesc"), badge: t("voice.tts.badgeFree") },
      { value: "openai" as const, label: t("voice.tts.providerOpenAI"), description: t("voice.tts.providerOpenAIDesc"), badge: t("voice.tts.badgeApiKey") },
      { value: "elevenlabs" as const, label: t("voice.tts.providerElevenLabs"), description: t("voice.tts.providerElevenLabsDesc"), badge: t("voice.tts.badgeApiKey") },
    ];

    const sttProviderOptions = [
      { value: "openai" as const, label: t("voice.stt.providerOpenAI"), description: t("voice.stt.providerOpenAIDesc") },
      { value: "local" as const, label: t("voice.stt.providerLocal"), description: t("voice.stt.providerLocalDesc") },
      { value: "parakeet" as const, label: t("voice.stt.providerParakeet"), description: t("voice.stt.providerParakeetDesc") },
    ];

    const isParakeetProvider = formState.sttProvider === "parakeet";

    return (
      <div className={settingsSectionShellClassName}>
        <div className="space-y-1.5">
          <h2 className="font-mono text-lg font-semibold text-terminal-dark">{t("voice.heading")}</h2>
          <p className="font-mono text-sm text-terminal-muted">
            {t("voice.description")}
          </p>
        </div>

        <div className="space-y-5">
          <SettingsPanelCard
            title={t("voice.tts.title")}
            description={t("voice.tts.description")}
          >
            <SettingsToggleRow
              id="ttsEnabled"
              label={t("voice.tts.enableLabel")}
              description={t("voice.tts.enableDesc")}
              checked={formState.ttsEnabled}
              onChange={(checked) => updateField("ttsEnabled", checked)}
            />

            {formState.ttsEnabled ? (
              <div className="space-y-6">
                <SettingsOptionGroup
                  title={t("voice.tts.whenTitle")}
                  description={t("voice.tts.whenDesc")}
                >
                  {ttsAutoModeOptions.map((option) => (
                    <SettingsRadioCard
                      key={option.value}
                      id={`tts-auto-mode-${option.value}`}
                      name="ttsAutoMode"
                      value={option.value}
                      label={option.label}
                      description={option.description}
                      checked={formState.ttsAutoMode === option.value}
                      onChange={() => updateField("ttsAutoMode", option.value)}
                    />
                  ))}
                </SettingsOptionGroup>

                <SettingsOptionGroup
                  title={t("voice.tts.providerTitle")}
                  description={t("voice.tts.providerDesc")}
                >
                  {ttsProviderOptions.map((option) => (
                    <SettingsRadioCard
                      key={option.value}
                      id={`tts-provider-${option.value}`}
                      name="ttsProvider"
                      value={option.value}
                      label={option.label}
                      description={option.description}
                      badge={option.badge}
                      checked={formState.ttsProvider === option.value}
                      onChange={() => updateField("ttsProvider", option.value)}
                    />
                  ))}
                </SettingsOptionGroup>

                {formState.ttsProvider === "openai" && (
                  <SettingsField
                    label={t("voice.tts.defaultVoiceLabel")}
                    htmlFor="openaiTtsVoice"
                    helperText={t("voice.tts.defaultVoiceHelper")}
                    className="max-w-sm"
                  >
                    <select
                      id="openaiTtsVoice"
                      value={formState.openaiTtsVoice}
                      onChange={(e) => updateField("openaiTtsVoice", e.target.value)}
                      aria-describedby="openaiTtsVoice-help"
                      className={settingsInputClassName}
                    >
                      {["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"].map((voice) => (
                        <option key={voice} value={voice}>
                          {voice}
                        </option>
                      ))}
                    </select>
                  </SettingsField>
                )}

                {formState.ttsProvider === "edge" && (
                  <EdgeTTSVoiceSelector
                    value={formState.edgeTtsVoice}
                    onChange={(voice) => updateField("edgeTtsVoice", voice)}
                  />
                )}

                {formState.ttsProvider === "elevenlabs" && (
                  <SettingsOptionGroup
                    title={t("voice.tts.elevenLabsTitle")}
                    description={t("voice.tts.elevenLabsDesc")}
                  >
                    <div className="grid gap-4 md:grid-cols-2">
                      <SettingsField label={t("voice.tts.elevenLabsKeyLabel")} htmlFor="elevenLabsApiKey">
                        <input
                          id="elevenLabsApiKey"
                          type="password"
                          value={formState.elevenLabsApiKey}
                          onChange={(e) => updateField("elevenLabsApiKey", e.target.value)}
                          placeholder={t("voice.tts.elevenLabsKeyPlaceholder")}
                          className={settingsInputClassName}
                        />
                      </SettingsField>
                      <SettingsField
                        label={t("voice.tts.voiceIdLabel")}
                        htmlFor="elevenLabsVoiceId"
                        helperText={t("voice.tts.voiceIdHelper")}
                      >
                        <input
                          id="elevenLabsVoiceId"
                          type="text"
                          value={formState.elevenLabsVoiceId}
                          onChange={(e) => updateField("elevenLabsVoiceId", e.target.value)}
                          placeholder={t("voice.tts.voiceIdPlaceholder")}
                          aria-describedby="elevenLabsVoiceId-help"
                          className={settingsInputClassName}
                        />
                      </SettingsField>
                    </div>
                  </SettingsOptionGroup>
                )}

                <SettingsField
                  label={t("voice.tts.limitLabel")}
                  htmlFor="ttsSummarizeThreshold"
                  helperText={t("voice.tts.limitHelper")}
                  className="max-w-xs"
                >
                  <input
                    id="ttsSummarizeThreshold"
                    type="number"
                    min={100}
                    max={5000}
                    step={100}
                    value={formState.ttsSummarizeThreshold}
                    onChange={(e) => updateField("ttsSummarizeThreshold", parseInt(e.target.value, 10) || 500)}
                    aria-describedby="ttsSummarizeThreshold-help"
                    className={settingsInputClassName}
                  />
                </SettingsField>

                <SettingsToggleRow
                  id="ttsReadCodeBlocks"
                  label={t("voice.tts.readCodeBlocksLabel")}
                  description={t("voice.tts.readCodeBlocksDesc")}
                  checked={formState.ttsReadCodeBlocks}
                  onChange={(checked) => updateField("ttsReadCodeBlocks", checked)}
                />

                <SettingsToggleRow
                  id="ttsSpeakCodeSymbols"
                  label={t("voice.tts.speakCodeSymbolsLabel")}
                  description={t("voice.tts.speakCodeSymbolsDesc")}
                  checked={formState.ttsSpeakCodeSymbols}
                  onChange={(checked) => updateField("ttsSpeakCodeSymbols", checked)}
                />
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-terminal-border/60 bg-terminal-bg/5 px-3 py-2.5 font-mono text-xs text-terminal-muted dark:border-terminal-border/80 dark:bg-terminal-cream/5">
                {t("voice.tts.disabledHint")}
              </div>
            )}
          </SettingsPanelCard>

          <SettingsPanelCard
            title={t("voice.stt.title")}
            description={t("voice.stt.description")}
          >
            <SettingsToggleRow
              id="sttEnabled"
              label={t("voice.stt.enableLabel")}
              description={t("voice.stt.enableDesc")}
              checked={formState.sttEnabled}
              onChange={(checked) => updateField("sttEnabled", checked)}
            />

            {formState.sttEnabled ? (
              <div className="space-y-6">
                <SettingsOptionGroup
                  title={t("voice.stt.providerTitle")}
                  description={t("voice.stt.providerDesc")}
                >
                  {sttProviderOptions.map((option) => (
                    <SettingsRadioCard
                      key={option.value}
                      id={`stt-provider-${option.value}`}
                      name="sttProvider"
                      value={option.value}
                      label={option.label}
                      description={option.description}
                      checked={formState.sttProvider === option.value}
                      onChange={() => updateField("sttProvider", option.value)}
                    />
                  ))}
                </SettingsOptionGroup>

                {formState.sttProvider === "local" && (
                  <WhisperModelSelector formState={formState} updateField={updateField} />
                )}

                {isParakeetProvider && (
                  <ParakeetModelSelector formState={formState} updateField={updateField} />
                )}

                <SettingsOptionGroup
                  title="Text Processing"
                  description="Optional cleanup that runs after speech-to-text finishes."
                >
                  <div className="space-y-3 rounded-xl border border-terminal-border/55 bg-terminal-bg/5 p-4 dark:border-terminal-border/90 dark:bg-terminal-cream-dark/45">
                    <div className="flex items-center gap-2 font-mono text-sm font-semibold text-terminal-dark">
                      <SparklesIcon className="size-4 text-terminal-green" />
                      Text Processing
                    </div>

                    <SettingsToggleRow
                      id="voicePostProcessing"
                      label="Fix grammatical errors"
                      description="Automatically fix punctuation, capitalization, and grammar in transcribed text"
                      checked={formState.voicePostProcessing}
                      onChange={(checked) => updateField("voicePostProcessing", checked)}
                    />

                    {!formState.voicePostProcessing && (
                      <p className="font-mono text-xs leading-relaxed text-terminal-muted">
                        Raw transcription is used as-is without any AI processing.
                      </p>
                    )}

                    <div
                      className={cn(
                        "space-y-3 rounded-xl border border-terminal-border/55 bg-terminal-cream/40 p-3.5 transition-opacity dark:border-terminal-border/90 dark:bg-terminal-cream-dark/55",
                        !formState.voicePostProcessing && "opacity-50",
                      )}
                    >
                      <div className="flex items-center gap-2 font-mono text-sm font-semibold text-terminal-dark">
                        <BrainIcon className="size-4 text-terminal-green" />
                        Transcriber Model
                      </div>

                      <p className="font-mono text-xs leading-relaxed text-terminal-muted">
                        Model used for voice text processing. Defaults to utility model.
                      </p>

                      <Select
                        value={formState.transcriberModel || TRANSCRIBER_AUTO_OPTION}
                        onValueChange={(value) => updateField("transcriberModel", value === TRANSCRIBER_AUTO_OPTION ? "" : value)}
                        disabled={!formState.voicePostProcessing}
                      >
                        <SelectTrigger
                          id="transcriberModel"
                          aria-describedby="transcriberModel-help"
                          className={cn(
                            settingsInputClassName,
                            "h-10 font-mono text-sm",
                            !formState.voicePostProcessing && "pointer-events-none",
                          )}
                        >
                          <SelectValue placeholder="Auto (use utility model)" />
                        </SelectTrigger>
                        <SelectContent className="font-mono text-sm">
                          <SelectItem value={TRANSCRIBER_AUTO_OPTION} className="font-mono text-sm">
                            Auto (use utility model)
                          </SelectItem>
                          {transcriberModelOptions.map((model) => (
                            <SelectItem key={model.id} value={model.id} className="font-mono text-sm">
                              {model.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      <p id="transcriberModel-help" className="font-mono text-xs leading-relaxed text-terminal-muted">
                        Uses the active {formState.llmProvider} model list for transcript cleanup.
                      </p>
                    </div>
                  </div>
                </SettingsOptionGroup>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-terminal-border/60 bg-terminal-bg/5 px-3 py-2.5 font-mono text-xs text-terminal-muted dark:border-terminal-border/80 dark:bg-terminal-cream/5">
                {t("voice.stt.disabledHint")}
              </div>
            )}
          </SettingsPanelCard>

          <SettingsPanelCard
            title="Shortcuts"
            description="Global keyboard shortcuts for screen and voice capture."
          >
            <PermissionStatusBanner />

            <div className="flex items-center justify-between gap-4">
              <div className="flex-1">
                <div className="space-y-1">
                  <p className="font-medium text-terminal-dark">Voice shortcut</p>
                  <p className="text-sm text-terminal-muted">
                    Open the voice overlay without capturing the screen.
                  </p>
                </div>
              </div>
              <div className="shrink-0 w-48">
                <ShortcutRecorder
                  id="voiceHotkey"
                  value={formState.voiceHotkey}
                  onChange={(v) => updateField("voiceHotkey", v)}
                />
              </div>
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className="flex-1">
                <SettingsToggleRow
                  id="screenCaptureEnabled"
                  label="Screenshot shortcut"
                  description="Capture the active display and attach it to the current chat."
                  checked={formState.screenCaptureEnabled}
                  onChange={(checked) => updateField("screenCaptureEnabled", checked)}
                />
              </div>
              {formState.screenCaptureEnabled && (
                <div className="shrink-0 w-48">
                  <ShortcutRecorder
                    id="screenCaptureShortcut"
                    value={formState.screenCaptureShortcut}
                    onChange={(v) => updateField("screenCaptureShortcut", v)}
                  />
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className="flex-1">
                <SettingsToggleRow
                  id="quickCaptureEnabled"
                  label="Voice + screen shortcut"
                  description="Capture screen and open the voice overlay simultaneously."
                  checked={formState.quickCaptureEnabled}
                  onChange={(checked) => updateField("quickCaptureEnabled", checked)}
                />
              </div>
              {formState.quickCaptureEnabled && (
                <div className="shrink-0 w-48">
                  <ShortcutRecorder
                    id="quickCaptureHotkey"
                    value={formState.quickCaptureHotkey}
                    onChange={(v) => updateField("quickCaptureHotkey", v)}
                  />
                </div>
              )}
            </div>
          </SettingsPanelCard>

          <SettingsPanelCard
            title="Overlay"
            description="Behavior for the floating capture overlay."
          >
            <SettingsOptionGroup
              title="Default mode"
              description="Which mode the overlay starts in."
            >
              <SettingsRadioCard
                id="miniOverlayDefaultMode-direct"
                name="miniOverlayDefaultMode"
                value="direct"
                label="Direct"
                description="Send immediately and get a spoken response."
                checked={formState.miniOverlayDefaultMode === "direct"}
                onChange={() => updateField("miniOverlayDefaultMode", "direct")}
              />
              <SettingsRadioCard
                id="miniOverlayDefaultMode-compose"
                name="miniOverlayDefaultMode"
                value="compose"
                label="Compose"
                description="Refine transcript, then open as draft."
                checked={formState.miniOverlayDefaultMode === "compose"}
                onChange={() => updateField("miniOverlayDefaultMode", "compose")}
              />
            </SettingsOptionGroup>

            <SettingsToggleRow
              id="miniOverlayAutoCloseAfterSpeak"
              label="Auto-close after response"
              description="Close overlay after TTS finishes in Direct mode."
              checked={formState.miniOverlayAutoCloseAfterSpeak}
              onChange={(checked) => updateField("miniOverlayAutoCloseAfterSpeak", checked)}
            />

            <SettingsToggleRow
              id="miniOverlayShowScreenPreview"
              label="Show screen preview"
              description="Display screenshot thumbnail in the overlay."
              checked={formState.miniOverlayShowScreenPreview}
              onChange={(checked) => updateField("miniOverlayShowScreenPreview", checked)}
            />

            <SettingsToggleRow
              id="miniOverlayKeepAppFocusedOnCompose"
              label="Keep Selene focused after compose"
              description="Keep Selene in foreground after compose handoff."
              checked={formState.miniOverlayKeepAppFocusedOnCompose}
              onChange={(checked) => updateField("miniOverlayKeepAppFocusedOnCompose", checked)}
            />
          </SettingsPanelCard>

          <SettingsPanelCard
            title={t("voice.privacy.title")}
            description={t("voice.privacy.description")}
          >
            <SettingsField
              label={t("voice.privacy.excludedAppsLabel")}
              htmlFor="screenCaptureExcludedApps"
              helperText={t("voice.privacy.excludedAppsHelper")}
            >
              <textarea
                id="screenCaptureExcludedApps"
                rows={2}
                value={formState.screenCaptureExcludedApps}
                onChange={(e) => updateField("screenCaptureExcludedApps", e.target.value)}
                className={settingsInputClassName + " resize-none"}
              />
            </SettingsField>

            <SettingsField
              label={t("voice.privacy.retentionLabel")}
              htmlFor="screenCaptureRetention"
              helperText={t("voice.privacy.retentionHelper")}
              className="max-w-md"
            >
              <select
                id="screenCaptureRetention"
                value={formState.screenCaptureRetention}
                onChange={(e) => updateField("screenCaptureRetention", e.target.value as FormState["screenCaptureRetention"])}
                className={settingsInputClassName}
              >
                <option value="session">{t("voice.privacy.retentionSession")}</option>
                <option value="day">{t("voice.privacy.retentionDay")}</option>
                <option value="week">{t("voice.privacy.retentionWeek")}</option>
                <option value="forever">{t("voice.privacy.retentionForever")}</option>
              </select>
            </SettingsField>

            <ClearScreenshotsButton />
          </SettingsPanelCard>
        </div>
      </div>
    );
  }

  return null;
}
