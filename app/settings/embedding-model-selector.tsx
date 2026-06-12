"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Loader2Icon, CheckIcon, FolderOpenIcon, RefreshCwIcon, FlaskConicalIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { LOCAL_EMBEDDING_MODELS as SHARED_LOCAL_EMBEDDING_MODELS, formatDimensionLabel } from "@/lib/config/embedding-models";
import type { FormState } from "./settings-types";

// Derive local embedding model list from shared registry (single source of truth)
const LOCAL_EMBEDDING_MODELS = SHARED_LOCAL_EMBEDDING_MODELS.map((m) => ({
  id: m.id,
  name: `${m.name} (${m.dimensions} dims${m.size ? `, ~${m.size}` : ""})`,
  size: m.size || "",
}));

interface LocalEmbeddingModelSelectorProps {
  formState: FormState;
  updateField: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  t: ReturnType<typeof useTranslations<"settings">>;
}

export function LocalEmbeddingModelSelector({ formState, updateField, t }: LocalEmbeddingModelSelectorProps) {
  const [modelStatus, setModelStatus] = useState<Record<string, boolean>>({});
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number>(0);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [isElectronEnv, setIsElectronEnv] = useState(false);

  // Validation state
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<{
    success: boolean; durationMs: number; dims: number; error?: string;
  } | null>(null);

  // Redownload+validate state
  const [redownloading, setRedownloading] = useState(false);
  const [redownloadStatus, setRedownloadStatus] = useState<string | null>(null);

  // Check if running in Electron and model existence on mount
  useEffect(() => {
    const checkElectronAndModels = async () => {
      if (typeof window !== "undefined" && "electronAPI" in window) {
        setIsElectronEnv(true);
        const electronAPI = (window as unknown as { electronAPI: { model: { checkExists: (id: string) => Promise<boolean> } } }).electronAPI;

        // Check each model's existence
        const status: Record<string, boolean> = {};
        for (const model of LOCAL_EMBEDDING_MODELS) {
          try {
            status[model.id] = await electronAPI.model.checkExists(model.id);
          } catch {
            status[model.id] = false;
          }
        }
        setModelStatus(status);
      }
    };
    checkElectronAndModels();
  }, []);

  // Handle test/validate
  const handleValidate = async (modelId: string) => {
    if (!isElectronEnv) return;
    setValidating(true);
    setValidationResult(null);
    const electronAPI = (window as unknown as { electronAPI: { model: { validate: (id: string) => Promise<{ success: boolean; durationMs: number; dims: number; error?: string }> } } }).electronAPI;
    try {
      const result = await electronAPI.model.validate(modelId);
      setValidationResult(result);
    } catch (error) {
      setValidationResult({
        success: false,
        durationMs: 0,
        dims: 0,
        error: error instanceof Error ? error.message : "Validation failed",
      });
    } finally {
      setValidating(false);
    }
  };

  // Handle open folder
  const handleOpenFolder = (modelId: string) => {
    if (!isElectronEnv) return;
    const electronAPI = (window as unknown as { electronAPI: { model: { openFolder: (id: string) => Promise<unknown> } } }).electronAPI;
    electronAPI.model.openFolder(modelId).catch(() => {/* ignore */});
  };

  // Handle redownload + validate
  const handleRedownloadAndValidate = async (modelId: string) => {
    if (!isElectronEnv) return;
    setRedownloading(true);
    setRedownloadStatus(t("models.fields.embedding.redownloadStarting"));
    setValidationResult(null);

    const electronAPI = (window as unknown as {
      electronAPI: {
        model: {
          onRedownloadProgress?: (cb: (data: { modelId: string; status: string; detail?: string }) => void) => void;
          removeRedownloadProgressListener?: () => void;
          redownloadAndValidate: (id: string) => Promise<{
            success: boolean;
            error?: string;
            validation?: { success: boolean; durationMs: number; dims: number; error?: string };
          }>;
        }
      }
    }).electronAPI;

    electronAPI.model.onRedownloadProgress?.((data) => {
      if (data.modelId === modelId) setRedownloadStatus(data.detail ?? data.status);
    });

    try {
      const result = await electronAPI.model.redownloadAndValidate(modelId);

      if (result.success) {
        setModelStatus((prev) => ({ ...prev, [modelId]: true }));
        if (result.validation) setValidationResult(result.validation);
      } else {
        setValidationResult({ success: false, durationMs: 0, dims: 0, error: result.error });
      }
    } catch (error) {
      setValidationResult({
        success: false,
        durationMs: 0,
        dims: 0,
        error: error instanceof Error ? error.message : "Redownload failed",
      });
    } finally {
      electronAPI.model.removeRedownloadProgressListener?.();
      setRedownloading(false);
      setRedownloadStatus(null);
    }
  };

  // Handle download
  const handleDownload = async (modelId: string) => {
    if (!isElectronEnv) return;

    setDownloading(modelId);
    setDownloadProgress(0);
    setDownloadError(null);

    const electronAPI = (window as unknown as {
      electronAPI?: {
        model?: {
          download?: (id: string) => Promise<{ success: boolean; error?: string }>;
          onProgress?: (cb: (data: { modelId: string; status: string; progress?: number; error?: string }) => void) => void;
          removeProgressListener?: () => void;
        }
      }
    }).electronAPI;

    // Safety check - API might not be fully exposed
    if (!electronAPI?.model?.download) {
      setDownloadError(t("models.downloadApiUnavailable"));
      setDownloading(null);
      return;
    }

    // Set up progress listener (if available)
    if (electronAPI.model.onProgress) {
      electronAPI.model.onProgress((data) => {
        if (data.modelId === modelId) {
          if (data.progress !== undefined) {
            setDownloadProgress(data.progress);
          }
          if (data.status === "completed") {
            setDownloading(null);
            setModelStatus((prev) => ({ ...prev, [modelId]: true }));
          }
          if (data.status === "error") {
            setDownloading(null);
            setDownloadError(data.error || t("models.downloadFailed"));
          }
        }
      });
    }

    try {
      const result = await electronAPI.model.download(modelId);
      if (!result.success) {
        setDownloadError(result.error || t("models.downloadFailed"));
      }
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : t("models.downloadFailed"));
    } finally {
      setDownloading(null);
      electronAPI.model.removeProgressListener?.();
    }
  };

  // For local provider, show dropdown with download support
  if (formState.embeddingProvider === "local") {
    return (
      <div>
        <label className="mb-1 block font-mono text-sm text-terminal-muted">
          {t("models.fields.embedding.label")}
        </label>
        <div className="flex gap-2">
          <select
            value={formState.embeddingModel || LOCAL_EMBEDDING_MODELS[0].id}
            onChange={(e) => updateField("embeddingModel", e.target.value)}
            className="flex-1 rounded border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 px-3 py-2 font-mono text-sm text-terminal-dark focus:border-terminal-green focus:outline-none focus:ring-1 focus:ring-terminal-green"
          >
            {LOCAL_EMBEDDING_MODELS.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name} {modelStatus[model.id] ? "✓" : ""}
              </option>
            ))}
          </select>

          {isElectronEnv && (
            <Button
              type="button"
              onClick={() => handleDownload(formState.embeddingModel || LOCAL_EMBEDDING_MODELS[0].id)}
              disabled={downloading !== null || modelStatus[formState.embeddingModel || LOCAL_EMBEDDING_MODELS[0].id]}
              className="gap-2 bg-terminal-green text-white hover:bg-terminal-green/90 disabled:opacity-50"
            >
              {downloading ? (
                <>
                  <Loader2Icon className="size-4 animate-spin" />
                  {downloadProgress}%
                </>
              ) : modelStatus[formState.embeddingModel || LOCAL_EMBEDDING_MODELS[0].id] ? (
                <>
                  <CheckIcon className="size-4" />
                  {t("models.fields.embedding.downloaded")}
                </>
              ) : (
                t("models.fields.embedding.download")
              )}
            </Button>
          )}
        </div>

        {downloadError && (
          <p className="mt-1 font-mono text-xs text-red-600">{downloadError}</p>
        )}

        {/* Validate / Open Folder / Redownload — only shown when model is present */}
        {isElectronEnv && modelStatus[formState.embeddingModel || LOCAL_EMBEDDING_MODELS[0].id] && (
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => handleValidate(formState.embeddingModel || LOCAL_EMBEDDING_MODELS[0].id)}
              disabled={validating || redownloading || downloading !== null}
              className="gap-1.5 font-mono text-xs"
            >
              {validating
                ? <><Loader2Icon className="size-3.5 animate-spin" /> {t("models.fields.embedding.testing")}</>
                : <><FlaskConicalIcon className="size-3.5" /> {t("models.fields.embedding.testModel")}</>}
            </Button>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => handleOpenFolder(formState.embeddingModel || LOCAL_EMBEDDING_MODELS[0].id)}
              disabled={redownloading}
              className="gap-1.5 font-mono text-xs text-terminal-muted hover:text-terminal-dark"
            >
              <FolderOpenIcon className="size-3.5" />
              {t("models.fields.embedding.openFolder")}
            </Button>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => handleRedownloadAndValidate(formState.embeddingModel || LOCAL_EMBEDDING_MODELS[0].id)}
              disabled={redownloading || downloading !== null || validating}
              className="gap-1.5 font-mono text-xs text-amber-700 border-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/20"
            >
              {redownloading
                ? <><Loader2Icon className="size-3.5 animate-spin" /> {redownloadStatus ?? t("models.fields.embedding.redownloadWorking")}</>
                : <><RefreshCwIcon className="size-3.5" /> {t("models.fields.embedding.validateRedownload")}</>}
            </Button>
          </div>
        )}

        {/* Validation result */}
        {validationResult && (
          <p className={`mt-1.5 font-mono text-xs ${validationResult.success ? "text-terminal-green" : "text-red-600"}`}>
            {validationResult.success
              ? t("models.fields.embedding.validationSuccess", { dims: validationResult.dims, durationMs: validationResult.durationMs })
              : t("models.fields.embedding.validationFailed", { error: validationResult.error ?? "" })}
          </p>
        )}

        <p className="mt-1 font-mono text-xs text-terminal-muted">
          {t("models.fields.embedding.helperLocal")}
        </p>
      </div>
    );
  }

  // For OpenRouter, show text input
  return (
    <div>
      <label className="mb-1 block font-mono text-sm text-terminal-muted">
        {t("models.fields.embedding.label")}
      </label>
      <input
        type="text"
        value={formState.embeddingModel ?? ""}
        onChange={(e) => updateField("embeddingModel", e.target.value)}
        placeholder={t("models.fields.embedding.placeholderOpenRouter")}
        className="w-full rounded border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 px-3 py-2 font-mono text-sm text-terminal-dark placeholder:text-terminal-muted/50 focus:border-terminal-green focus:outline-none focus:ring-1 focus:ring-terminal-green"
      />
      <p className="mt-1 font-mono text-xs text-terminal-muted">
        {t("models.fields.embedding.helper")}
      </p>
      {formState.embeddingModel && (
        <p className="mt-1 font-mono text-xs text-terminal-green">
          {t("models.vectorDimensions", { dims: formatDimensionLabel(formState.embeddingModel) })}
        </p>
      )}
    </div>
  );
}
