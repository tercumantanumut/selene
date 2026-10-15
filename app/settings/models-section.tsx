"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { settingsSectionShellClassName } from "@/components/settings/settings-form-layout";
import { getAntigravityModels } from "@/lib/auth/antigravity-models";
import { getCodexModels } from "@/lib/auth/codex-models";
import { getClaudeCodeModels } from "@/lib/auth/claudecode-models";
import { getKimiModels } from "@/lib/auth/kimi-models";
import { getMiniMaxModels } from "@/lib/auth/minimax-models";
import { getBlackBoxModels } from "@/lib/auth/blackboxai-models";
import { getDeepSeekModels } from "@/lib/auth/deepseek-models";
import type { FormState } from "./settings-types";

const MODEL_FIELDS = ["chatModel", "researchModel", "visionModel", "utilityModel"] as const;
type ModelFieldKey = (typeof MODEL_FIELDS)[number];
const BLACKBOX_MANUAL_OPTION = "__manual__";
const OLLAMA_MANUAL_OPTION = "__manual__";

interface OllamaModel {
  name: string;
  size?: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function getBlackBoxSelectValue(value: string, fallback: string, knownModels: Set<string>): string {
  if (!value) return fallback;
  return knownModels.has(value) ? value : BLACKBOX_MANUAL_OPTION;
}

function renderModelOptions(models: Array<{ id: string; name: string }>) {
  return models.map((model) => (
    <option key={model.id} value={model.id}>{model.name}</option>
  ));
}

function BlackBoxManualInput({
  value,
  onChange,
  label,
  placeholder,
  helper,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder: string;
  helper: string;
}) {
  return (
    <div className="mt-2 rounded border border-dashed border-terminal-border/70 bg-terminal-cream/40 p-3">
      <label className="mb-1 block font-mono text-xs uppercase tracking-wide text-terminal-muted">
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 px-3 py-2 font-mono text-sm text-terminal-dark placeholder:text-terminal-muted/50 focus:border-terminal-green focus:outline-none focus:ring-1 focus:ring-terminal-green"
      />
      <p className="mt-1 font-mono text-xs text-terminal-muted">
        {helper}
      </p>
    </div>
  );
}

const ANTIGRAVITY_MODELS = getAntigravityModels();
const CODEX_MODELS = getCodexModels();
const CLAUDECODE_MODELS = getClaudeCodeModels();
const KIMI_MODELS = getKimiModels();
const MINIMAX_MODELS = getMiniMaxModels();
const BLACKBOX_MODELS = getBlackBoxModels();
const DEEPSEEK_MODELS = getDeepSeekModels();

interface ModelsSectionProps {
  formState: FormState;
  updateField: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
}

function getOllamaSelectValue(value: string, knownNames: Set<string>): string {
  if (!value) return "";
  return knownNames.has(value) ? value : OLLAMA_MANUAL_OPTION;
}

function ModelSelect({
  label,
  fieldKey,
  formState,
  updateField,
  antigravityDefault,
  codexDefault,
  claudecodeDefault,
  kimiDefault,
  minimaxDefault,
  blackboxaiDefault,
  deepseekDefault,
  anthropicPlaceholder,
  ollamaPlaceholder,
  openrouterPlaceholder,
  helperKey,
  t,
  ollamaModels,
  ollamaModelsFailed,
}: {
  label: string;
  fieldKey: ModelFieldKey;
  formState: FormState;
  updateField: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  antigravityDefault: string;
  codexDefault: string;
  claudecodeDefault: string;
  kimiDefault: string;
  minimaxDefault: string;
  blackboxaiDefault: string;
  deepseekDefault: string;
  anthropicPlaceholder: string;
  ollamaPlaceholder: string;
  openrouterPlaceholder: string;
  helperKey: string;
  t: ReturnType<typeof useTranslations<"settings">>;
  ollamaModels: OllamaModel[];
  ollamaModelsFailed: boolean;
}) {
  const blackboxModelIds = useMemo(
    () => new Set(BLACKBOX_MODELS.map((model) => model.id)),
    [],
  );
  const blackboxSelectValue = getBlackBoxSelectValue(
    formState[fieldKey] ?? "",
    blackboxaiDefault,
    blackboxModelIds,
  );
  const isBlackBoxManual = formState.llmProvider === "blackboxai" && blackboxSelectValue === "__manual__";

  const ollamaModelNames = useMemo(
    () => new Set(ollamaModels.map((m) => m.name)),
    [ollamaModels],
  );
  const ollamaSelectValue = getOllamaSelectValue(
    formState[fieldKey] ?? "",
    ollamaModelNames,
  );
  const isOllamaManual = formState.llmProvider === "ollama" && ollamaSelectValue === OLLAMA_MANUAL_OPTION && (formState[fieldKey] ?? "") !== "";

  return (
    <div>
      <label className="mb-1 block font-mono text-sm text-terminal-muted">{label}</label>
      {formState.llmProvider === "ollama" && ollamaModels.length > 0 && !ollamaModelsFailed ? (
        <>
          <select
            value={ollamaSelectValue || ""}
            onChange={(e) => {
              const nextValue = e.target.value;
              if (nextValue === OLLAMA_MANUAL_OPTION) {
                updateField(fieldKey, formState[fieldKey] || "");
                return;
              }
              updateField(fieldKey, nextValue);
            }}
            className="w-full rounded border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 px-3 py-2 font-mono text-sm text-terminal-dark focus:border-terminal-green focus:outline-none focus:ring-1 focus:ring-terminal-green"
          >
            <option value="">-- select model --</option>
            {ollamaModels.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}{m.size ? ` (${formatBytes(m.size)})` : ""}
              </option>
            ))}
            <option value={OLLAMA_MANUAL_OPTION}>{t("models.manualModelId" as Parameters<typeof t>[0])}</option>
          </select>
          {isOllamaManual && (
            <div className="mt-2 rounded border border-dashed border-terminal-border/70 bg-terminal-cream/40 p-3">
              <label className="mb-1 block font-mono text-xs uppercase tracking-wide text-terminal-muted">
                Manual model ID
              </label>
              <input
                type="text"
                value={formState[fieldKey] ?? ""}
                onChange={(e) => updateField(fieldKey, e.target.value)}
                placeholder={ollamaPlaceholder}
                className="w-full rounded border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 px-3 py-2 font-mono text-sm text-terminal-dark placeholder:text-terminal-muted/50 focus:border-terminal-green focus:outline-none focus:ring-1 focus:ring-terminal-green"
              />
            </div>
          )}
        </>
      ) : formState.llmProvider === "antigravity" ? (
        <select
          value={formState[fieldKey] || antigravityDefault}
          onChange={(e) => updateField(fieldKey, e.target.value)}
          className="w-full rounded border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 px-3 py-2 font-mono text-sm text-terminal-dark focus:border-terminal-green focus:outline-none focus:ring-1 focus:ring-terminal-green"
        >
          {renderModelOptions(ANTIGRAVITY_MODELS)}
        </select>
      ) : formState.llmProvider === "codex" ? (
        <select
          value={formState[fieldKey] || codexDefault}
          onChange={(e) => updateField(fieldKey, e.target.value)}
          className="w-full rounded border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 px-3 py-2 font-mono text-sm text-terminal-dark focus:border-terminal-green focus:outline-none focus:ring-1 focus:ring-terminal-green"
        >
          {renderModelOptions(CODEX_MODELS)}
        </select>
      ) : formState.llmProvider === "claudecode" ? (
        <select
          value={formState[fieldKey] || claudecodeDefault}
          onChange={(e) => updateField(fieldKey, e.target.value)}
          className="w-full rounded border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 px-3 py-2 font-mono text-sm text-terminal-dark focus:border-terminal-green focus:outline-none focus:ring-1 focus:ring-terminal-green"
        >
          {renderModelOptions(CLAUDECODE_MODELS)}
        </select>
      ) : formState.llmProvider === "kimi" ? (
        <select
          value={formState[fieldKey] || kimiDefault}
          onChange={(e) => updateField(fieldKey, e.target.value)}
          className="w-full rounded border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 px-3 py-2 font-mono text-sm text-terminal-dark focus:border-terminal-green focus:outline-none focus:ring-1 focus:ring-terminal-green"
        >
          {renderModelOptions(KIMI_MODELS)}
        </select>
      ) : formState.llmProvider === "minimax" ? (
        <select
          value={formState[fieldKey] || minimaxDefault}
          onChange={(e) => updateField(fieldKey, e.target.value)}
          className="w-full rounded border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 px-3 py-2 font-mono text-sm text-terminal-dark focus:border-terminal-green focus:outline-none focus:ring-1 focus:ring-terminal-green"
        >
          {renderModelOptions(MINIMAX_MODELS)}
        </select>
      ) : formState.llmProvider === "blackboxai" ? (
        <>
          <select
            value={blackboxSelectValue}
            onChange={(e) => {
              const nextValue = e.target.value;
              if (nextValue === "__manual__") {
                updateField(fieldKey, formState[fieldKey] || "");
                return;
              }
              updateField(fieldKey, nextValue);
            }}
            className="w-full rounded border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 px-3 py-2 font-mono text-sm text-terminal-dark focus:border-terminal-green focus:outline-none focus:ring-1 focus:ring-terminal-green"
          >
            {renderModelOptions(BLACKBOX_MODELS)}
            <option value="__manual__">{t("models.manualModelId" as Parameters<typeof t>[0])}</option>
          </select>
          {isBlackBoxManual && (
            <BlackBoxManualInput
              value={formState[fieldKey] ?? ""}
              onChange={(value) => updateField(fieldKey, value)}
              label={t("models.blackboxAdvancedLabel" as Parameters<typeof t>[0])}
              placeholder={blackboxaiDefault}
              helper={t("models.blackboxAdvancedPlaceholder" as Parameters<typeof t>[0])}
            />
          )}

        </>
      ) : formState.llmProvider === "deepseek" ? (
        fieldKey === "visionModel" ? (
          // DeepSeek's /chat/completions endpoint rejects image_url content parts,
          // so none of its chat models can serve as a vision model. Surface that
          // clearly instead of offering a dropdown whose options all fail when
          // the user actually attaches an image. See lib/auth/deepseek-models.ts
          // (DEEPSEEK_DEFAULT_MODELS has no vision entry on purpose) and the
          // describeImage companion-tool promotion in tools-builder.ts.
          <div className="w-full rounded border border-dashed border-amber-500/60 bg-amber-50/40 dark:bg-amber-900/10 p-3 space-y-1">
            <p className="font-mono text-xs font-semibold text-terminal-dark">
              {t("models.fields.vision.deepseekUnsupportedTitle" as Parameters<typeof t>[0])}
            </p>
            <p className="font-mono text-xs text-terminal-muted">
              {t("models.fields.vision.deepseekUnsupportedBody" as Parameters<typeof t>[0])}
            </p>
          </div>
        ) : (
          <select
            value={formState[fieldKey] || deepseekDefault}
            onChange={(e) => updateField(fieldKey, e.target.value)}
            className="w-full rounded border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 px-3 py-2 font-mono text-sm text-terminal-dark focus:border-terminal-green focus:outline-none focus:ring-1 focus:ring-terminal-green"
          >
            {renderModelOptions(DEEPSEEK_MODELS)}
          </select>
        )
      ) : (
        <input
          type="text"
          value={formState[fieldKey] ?? ""}
          onChange={(e) => updateField(fieldKey, e.target.value)}
          placeholder={
            formState.llmProvider === "anthropic"
              ? anthropicPlaceholder
              : formState.llmProvider === "ollama"
                ? ollamaPlaceholder
                : openrouterPlaceholder
          }
          className="w-full rounded border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 px-3 py-2 font-mono text-sm text-terminal-dark placeholder:text-terminal-muted/50 focus:border-terminal-green focus:outline-none focus:ring-1 focus:ring-terminal-green"
        />
      )}
      <p className="mt-1 font-mono text-xs text-terminal-muted">
        {t(helperKey as Parameters<typeof t>[0])}
      </p>
    </div>
  );
}

// Provider model sets keyed by provider name (for validation)
const PROVIDER_MODEL_SETS: Partial<Record<FormState["llmProvider"], Set<string>>> = {
  antigravity: new Set(ANTIGRAVITY_MODELS.map((m) => m.id)),
  codex: new Set(CODEX_MODELS.map((m) => m.id)),
  claudecode: new Set(CLAUDECODE_MODELS.map((m) => m.id)),
  kimi: new Set(KIMI_MODELS.map((m) => m.id)),
  minimax: new Set(MINIMAX_MODELS.map((m) => m.id)),
  blackboxai: new Set(BLACKBOX_MODELS.map((m) => m.id)),
  deepseek: new Set(DEEPSEEK_MODELS.map((m) => m.id)),
};

export function ModelsSection({ formState, updateField }: ModelsSectionProps) {
  const t = useTranslations("settings");
  const prevProviderRef = useRef<FormState["llmProvider"]>(formState.llmProvider);
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);
  const [ollamaModelsFailed, setOllamaModelsFailed] = useState(false);
  const ollamaFetchedRef = useRef(false);

  // Fetch Ollama models when provider is "ollama"
  const fetchOllamaModels = useCallback(async () => {
    try {
      const res = await fetch("/api/ollama/tags");
      if (!res.ok) {
        setOllamaModelsFailed(true);
        return;
      }
      const data = await res.json();
      const models: OllamaModel[] = (data.models ?? []).map((m: { name: string; size?: number }) => ({
        name: m.name,
        size: m.size,
      }));
      setOllamaModels(models);
      setOllamaModelsFailed(false);
    } catch {
      setOllamaModelsFailed(true);
    }
  }, []);

  useEffect(() => {
    if (formState.llmProvider === "ollama" && !ollamaFetchedRef.current) {
      ollamaFetchedRef.current = true;
      fetchOllamaModels();
    }
  }, [formState.llmProvider, fetchOllamaModels]);

  // Clear model fields that don't belong to the newly selected provider.
  // This prevents stale Codex/Antigravity model IDs from persisting when the
  // user switches providers, which caused wrong options to appear in selects.
  useEffect(() => {
    const prev = prevProviderRef.current;
    const next = formState.llmProvider;
    if (prev === next) return;
    prevProviderRef.current = next;

    const validModels = PROVIDER_MODEL_SETS[next];
    if (!validModels) {
      // For text-input providers (anthropic, openrouter, ollama) we don't
      // pre-validate model IDs — they accept any string.
      return;
    }
    for (const field of MODEL_FIELDS) {
      const current = formState[field];
      if (current && !validModels.has(current)) {
        updateField(field, "");
      }
    }
  }, [formState.llmProvider]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={settingsSectionShellClassName}>
      <div>
        <h2 className="font-mono text-lg font-semibold text-terminal-dark">{t("models.title")}</h2>
        <p className="font-mono text-sm text-terminal-muted">
          {t("models.subtitle")}
        </p>
        <p className="font-mono text-xs text-terminal-muted">
          {t("models.jobDescription")}
        </p>
      </div>

      <div className="rounded border border-terminal-border bg-terminal-cream/30 p-4">
        <p className="font-mono text-xs text-terminal-muted">
          <strong>{t("models.defaults.label")}</strong> {t("models.defaults.value")}
        </p>
      </div>

      <div className="space-y-4">
        <ModelSelect
          label={t("models.fields.chat.label")}
          fieldKey="chatModel"
          formState={formState}
          updateField={updateField}
          antigravityDefault="claude-sonnet-4-5"
          codexDefault="gpt-5.4"
          claudecodeDefault="claude-sonnet-4-5-20250929"
          kimiDefault="k3"
          minimaxDefault="MiniMax-M2.1"
          blackboxaiDefault="qwen-2.5-coder-32b-instruct"
          deepseekDefault="deepseek-v4-pro"
          anthropicPlaceholder="claude-sonnet-4-5-20250929"
          ollamaPlaceholder="llama3.1:8b"
          openrouterPlaceholder="x-ai/grok-4.1-fast"
          helperKey="models.fields.chat.helper"
          t={t}
          ollamaModels={ollamaModels}
          ollamaModelsFailed={ollamaModelsFailed}
        />

        <ModelSelect
          label={t("models.fields.research.label")}
          fieldKey="researchModel"
          formState={formState}
          updateField={updateField}
          antigravityDefault="gemini-3-pro-high"
          codexDefault="gpt-5.4"
          claudecodeDefault="claude-opus-4-6"
          kimiDefault="k3"
          minimaxDefault="MiniMax-M2.1"
          blackboxaiDefault="claude-sonnet-4.6"
          deepseekDefault="deepseek-v4-pro"
          anthropicPlaceholder="claude-sonnet-4-5-20250929"
          ollamaPlaceholder="llama3.1:8b"
          openrouterPlaceholder="x-ai/grok-4.1-fast"
          helperKey="models.fields.research.helper"
          t={t}
          ollamaModels={ollamaModels}
          ollamaModelsFailed={ollamaModelsFailed}
        />

        <ModelSelect
          label={t("models.fields.vision.label")}
          fieldKey="visionModel"
          formState={formState}
          updateField={updateField}
          antigravityDefault="gemini-3-pro-low"
          codexDefault="gpt-5.4"
          claudecodeDefault="claude-sonnet-4-5-20250929"
          kimiDefault="k3"
          minimaxDefault="MiniMax-M2.1"
          blackboxaiDefault="qwen2.5-vl-32b-instruct"
          // DeepSeek intentionally has no vision default — its chat-completions
          // endpoint rejects image_url parts. The ModelSelect renders an
          // informational notice instead of a dropdown for this provider/field.
          deepseekDefault=""
          anthropicPlaceholder="claude-sonnet-4-5-20250929"
          ollamaPlaceholder="llama3.1:8b"
          openrouterPlaceholder="google/gemini-2.0-flash-001"
          helperKey="models.fields.vision.helper"
          t={t}
          ollamaModels={ollamaModels}
          ollamaModelsFailed={ollamaModelsFailed}
        />

        <ModelSelect
          label={t("models.fields.utility.label")}
          fieldKey="utilityModel"
          formState={formState}
          updateField={updateField}
          antigravityDefault="gemini-3-flash"
          codexDefault="gpt-5.4-low"
          claudecodeDefault="claude-haiku-4-5-20251001"
          kimiDefault="kimi-k2-turbo-preview"
          minimaxDefault="MiniMax-M2.1-lightning"
          blackboxaiDefault="gpt-4o-mini"
          deepseekDefault="deepseek-v4-flash"
          anthropicPlaceholder="claude-haiku-4-5-20251001"
          ollamaPlaceholder="llama3.1:8b"
          openrouterPlaceholder="google/gemini-2.0-flash-lite-001"
          helperKey="models.fields.utility.helper"
          t={t}
          ollamaModels={ollamaModels}
          ollamaModelsFailed={ollamaModelsFailed}
        />

        {/* OpenRouter Advanced Options */}
        {formState.llmProvider === "openrouter" && (
          <div>
            <label className="mb-1 block font-mono text-sm text-terminal-muted">
              {t("models.fields.openrouterArgs.label")}
            </label>
            <textarea
              value={formState.openrouterArgs}
              onChange={(e) => updateField("openrouterArgs", e.target.value)}
              placeholder='{ "quant": "q4_0", "thinkingBudget": 512, "includeThoughts": false }'
              className="w-full rounded border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 px-3 py-2 font-mono text-xs text-terminal-dark placeholder:text-terminal-muted/50 focus:border-terminal-green focus:outline-none focus:ring-1 focus:ring-terminal-green resize-none"
              rows={4}
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" onClick={() => updateField("openrouterArgs", '{"quant":"q4_0"}')} className="px-2 py-1 text-xs font-mono text-terminal-green hover:bg-terminal-green/10 rounded transition-colors">
                {t("models.fields.openrouterArgs.presets.q4")}
              </button>
              <button type="button" onClick={() => updateField("openrouterArgs", '{"quant":"q8_0"}')} className="px-2 py-1 text-xs font-mono text-terminal-green hover:bg-terminal-green/10 rounded transition-colors">
                {t("models.fields.openrouterArgs.presets.q8")}
              </button>
              <button type="button" onClick={() => updateField("openrouterArgs", '{"quant":"auto"}')} className="px-2 py-1 text-xs font-mono text-terminal-green hover:bg-terminal-green/10 rounded transition-colors">
                {t("models.fields.openrouterArgs.presets.auto")}
              </button>
              <button type="button" onClick={() => updateField("openrouterArgs", '{"thinkingBudget":0}')} className="px-2 py-1 text-xs font-mono text-terminal-green hover:bg-terminal-green/10 rounded transition-colors">
                {t("models.fields.openrouterArgs.presets.noThinking")}
              </button>
            </div>
            <p className="mt-2 font-mono text-xs text-terminal-muted">
              {t("models.fields.openrouterArgs.helper")}
            </p>
          </div>
        )}
      </div>

      <div className="rounded border border-amber-200 bg-amber-50 p-4">
        <p className="font-mono text-xs text-amber-800">
          <strong>{t("models.tip.title")}</strong> {t("models.tip.body")}
        </p>
      </div>
    </div>
  );
}
