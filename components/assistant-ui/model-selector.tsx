"use client";

import type { FC } from "react";
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  ChevronDownIcon,
  SearchIcon,
  CheckIcon,
  Loader2Icon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useModelBag } from "@/components/model-bag/use-model-bag";
import type { ModelItem } from "@/components/model-bag/model-bag.types";
import { resilientPut } from "@/lib/utils/resilient-fetch";
import { useTranslations } from "next-intl";
import type { ContextStatusInfo } from "@/lib/hooks/use-context-status";

const PROVIDER_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  anthropic: { bg: "bg-amber-500/10", text: "text-amber-700", border: "border-amber-500/30" },
  openrouter: { bg: "bg-blue-500/10", text: "text-blue-700", border: "border-blue-500/30" },
  antigravity: { bg: "bg-purple-500/10", text: "text-purple-700", border: "border-purple-500/30" },
  codex: { bg: "bg-green-500/10", text: "text-green-700", border: "border-green-500/30" },
  claudecode: { bg: "bg-orange-500/10", text: "text-orange-700", border: "border-orange-500/30" },
  kimi: { bg: "bg-cyan-500/10", text: "text-cyan-700", border: "border-cyan-500/30" },
  minimax: { bg: "bg-rose-500/10", text: "text-rose-700", border: "border-rose-500/30" },
  blackboxai: { bg: "bg-emerald-500/10", text: "text-emerald-700", border: "border-emerald-500/30" },
  ollama: { bg: "bg-gray-500/10", text: "text-gray-700", border: "border-gray-500/30" },
  vllm: { bg: "bg-indigo-500/10", text: "text-indigo-700", border: "border-indigo-500/30" },
};

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  antigravity: "Antigravity",
  codex: "Codex",
  claudecode: "Claude Code",
  kimi: "Kimi",
  minimax: "MiniMax",
  blackboxai: "BlackBox AI",
  ollama: "Ollama",
  vllm: "vLLM",
};

const MANUAL_MODEL_PROVIDERS = new Set(["openrouter", "blackboxai", "ollama", "vllm"]);

export function formatModelName(modelId: string): string {
  const stripped = modelId.includes("/") ? modelId.split("/").pop()! : modelId;

  const simplePatterns: [RegExp, string][] = [
    [/^kimi-k(\d[\d.]*)/i, "Kimi K$1"],
    [/^claude-opus-(\d+)-(\d+)/i, "Opus $1.$2"],
    [/^claude-opus-(\d+)/i, "Opus $1"],
    [/^claude-sonnet-(\d+)-(\d+)/i, "Sonnet $1.$2"],
    [/^claude-haiku-(\d+)-(\d+)/i, "Haiku $1.$2"],
    [/^claude-(\d[\d.]*)/i, "Claude $1"],
  ];

  for (const [regex, replacement] of simplePatterns) {
    if (regex.test(stripped)) {
      return stripped.replace(regex, replacement);
    }
  }

  const gptMatch = stripped.match(/^gpt-(\d[\d.]*)-?(.*)/i);
  if (gptMatch) {
    const [, ver, suffix] = gptMatch;
    return `GPT ${ver}${suffix ? ` ${suffix.charAt(0).toUpperCase() + suffix.slice(1)}` : ""}`;
  }

  const geminiMatch = stripped.match(/^gemini-(\d[\d.]*)-?(.*)/i);
  if (geminiMatch) {
    const [, ver, suffix] = geminiMatch;
    return `Gemini ${ver}${suffix ? ` ${suffix.charAt(0).toUpperCase() + suffix.slice(1)}` : ""}`;
  }

  return stripped
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
}

function getManualModelPlaceholder(provider: string): string {
  switch (provider) {
    case "blackboxai": return "anthropic/claude-sonnet-4.6";
    case "vllm": return "Qwen/Qwen3.5-35B-A3B";
    case "ollama": return "llama3.1:8b";
    default: return "x-ai/grok-4.1-fast";
  }
}

interface ModelSelectorProps {
  sessionId: string;
  status: ContextStatusInfo | null;
}

export const ModelSelector: FC<ModelSelectorProps> = ({ sessionId, status }) => {
  const t = useTranslations("modelBag");
  const [open, setOpen] = useState(false);
  const bag = useModelBag();
  const [search, setSearch] = useState("");
  const [filterProvider, setFilterProvider] = useState<string | "all">("all");
  const [saving, setSaving] = useState(false);
  const [manualModelInput, setManualModelInput] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
      });
    } else {
      setSearch("");
      setFilterProvider("all");
      setManualModelInput("");
    }
  }, [open]);

  const authProviders = useMemo(
    () => bag.providers.filter((p) => p.isAuthenticated && p.modelCount > 0),
    [bag.providers],
  );

  const visibleModels = useMemo(() => {
    let result = bag.models.filter((m) => m.isAvailable);
    if (filterProvider !== "all") {
      result = result.filter((m) => m.provider === filterProvider);
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
      );
    }
    return result;
  }, [bag.models, filterProvider, search]);

  const groupedModels = useMemo(() => {
    const groups: Record<string, typeof visibleModels> = {};
    for (const m of visibleModels) {
      (groups[m.provider] ??= []).push(m);
    }
    return groups;
  }, [visibleModels]);

  const activeModelId = status?.model?.id ?? null;
  const activeProvider = status?.model?.provider ?? null;
  const manualProvider = filterProvider !== "all" && MANUAL_MODEL_PROVIDERS.has(filterProvider)
    ? filterProvider
    : activeProvider && MANUAL_MODEL_PROVIDERS.has(activeProvider)
      ? activeProvider
      : null;

  const persistSessionModel = useCallback(
    async (provider: string, modelId: string, modelName: string) => {
      setSaving(true);
      try {
        const { error: putError } = await resilientPut(
          `/api/sessions/${sessionId}/model-config`,
          { sessionChatModel: modelId, sessionProvider: provider },
        );
        if (putError) {
          toast.error(putError);
          return false;
        }
        toast.success(t("switched", { name: modelName }));
        setOpen(false);
        window.dispatchEvent(new Event("seline:model-config-changed"));
        return true;
      } catch {
        toast.error(t("switchFailed"));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [sessionId, t],
  );

  const handleSelectModel = useCallback(
    async (model: ModelItem) => {
      if (model.id === activeModelId && model.provider === activeProvider) {
        setOpen(false);
        return;
      }
      await persistSessionModel(model.provider, model.id, model.name);
    },
    [activeModelId, activeProvider, persistSessionModel],
  );

  const handleManualSubmit = useCallback(async () => {
    if (!manualProvider) return;
    const trimmed = manualModelInput.trim();
    if (!trimmed) return;
    if (trimmed === activeModelId && manualProvider === activeProvider) {
      setOpen(false);
      return;
    }
    const success = await persistSessionModel(manualProvider, trimmed, trimmed);
    if (success) {
      setManualModelInput("");
    }
  }, [activeModelId, activeProvider, manualModelInput, manualProvider, persistSessionModel]);

  if (!status?.model) {
    return null;
  }

  const triggerModelName = formatModelName(status.model.id);
  const triggerProvider = status.model.provider;
  const triggerColors = PROVIDER_COLORS[triggerProvider] ?? PROVIDER_COLORS.anthropic;
  const triggerProviderName = PROVIDER_NAMES[triggerProvider] ?? triggerProvider;

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={cn(
          "inline-flex items-center gap-1 px-1.5 py-0.5 rounded border",
          "text-[10px] font-mono select-none transition-colors cursor-pointer",
          "hover:opacity-80 active:opacity-70",
          triggerColors.bg,
          triggerColors.text,
          triggerColors.border,
        )}
      >
        <span className="truncate max-w-[120px]">{triggerModelName}</span>
        <span className="opacity-60">·</span>
        <span className="opacity-60 truncate max-w-[60px]">{triggerProviderName}</span>
        <ChevronDownIcon
          className={cn(
            "size-2.5 shrink-0 opacity-50 transition-transform duration-150",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-2 z-50 w-[380px] max-h-[420px] flex flex-col rounded-xl border border-terminal-border/60 bg-white shadow-xl overflow-hidden">
          <div className="shrink-0 px-3 pt-3 pb-2">
            <div className="relative">
              <SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-terminal-muted/50" />
              <input
                ref={searchInputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("bagSearchPlaceholder")}
                className="w-full rounded-lg border border-terminal-border/30 bg-terminal-cream/30 py-1.5 pl-8 pr-8 font-mono text-xs text-terminal-dark placeholder:text-terminal-muted/40 focus:border-terminal-green/50 focus:outline-none focus:ring-1 focus:ring-terminal-green/20"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-terminal-muted/50 hover:text-terminal-dark transition-colors"
                >
                  <XIcon className="size-3" />
                </button>
              )}
            </div>
          </div>

          <div className="shrink-0 flex items-center gap-1 px-3 pb-2 overflow-x-auto">
            <button
              type="button"
              onClick={() => setFilterProvider("all")}
              className={cn(
                "shrink-0 rounded-full px-2.5 py-1 font-mono text-[10px] font-semibold transition-colors",
                filterProvider === "all"
                  ? "bg-terminal-dark text-terminal-cream"
                  : "text-terminal-muted hover:bg-terminal-dark/5",
              )}
            >
              All
            </button>
            {authProviders.map((p) => (
              <button
                type="button"
                key={p.id}
                onClick={() => setFilterProvider(filterProvider === p.id ? "all" : p.id)}
                className={cn(
                  "shrink-0 flex items-center gap-1 rounded-full px-2.5 py-1 font-mono text-[10px] font-medium transition-colors",
                  filterProvider === p.id
                    ? "bg-terminal-dark text-terminal-cream"
                    : "text-terminal-muted hover:bg-terminal-dark/5",
                )}
              >
                <span>{PROVIDER_NAMES[p.id] ?? p.displayName}</span>
                <span
                  className={cn(
                    "rounded-full px-1 text-[8px] font-bold",
                    filterProvider === p.id ? "bg-terminal-cream/20" : "bg-terminal-dark/5",
                  )}
                >
                  {p.modelCount}
                </span>
              </button>
            ))}
          </div>

          <div className="shrink-0 h-px bg-terminal-border/20" />

          {manualProvider && (
            <div className="shrink-0 border-b border-terminal-border/20 bg-terminal-cream/20 px-3 py-2">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={manualModelInput}
                  onChange={(e) => setManualModelInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleManualSubmit();
                    }
                  }}
                  placeholder={getManualModelPlaceholder(manualProvider)}
                  className="flex-1 rounded-lg border border-terminal-border/40 bg-white py-1.5 px-2.5 font-mono text-xs text-terminal-dark placeholder:text-terminal-muted/40 focus:border-terminal-green/50 focus:outline-none focus:ring-1 focus:ring-terminal-green/20"
                />
                <button
                  type="button"
                  onClick={() => void handleManualSubmit()}
                  disabled={saving || manualModelInput.trim().length === 0}
                  className="rounded-lg border border-terminal-border/40 px-2.5 py-1.5 font-mono text-[10px] text-terminal-dark transition-colors hover:bg-terminal-dark/5 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t("manualUse")}
                </button>
              </div>
              <p className="mt-1 font-mono text-[10px] text-terminal-muted/70">
                {manualProvider === "blackboxai" ? t("manualBlackboxHint") : t("manualSessionHint")}
              </p>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {visibleModels.length === 0 ? (
              <div className="flex h-full min-h-[120px] items-center justify-center px-4 py-8 text-center font-mono text-xs text-terminal-muted">
                {t("noModels")}
              </div>
            ) : (
              Object.entries(groupedModels).map(([provider, models]) => (
                <div key={provider} className="mb-3 last:mb-0">
                  <div className="sticky top-0 z-10 bg-white px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wide text-terminal-muted">
                    {PROVIDER_NAMES[provider] ?? provider}
                  </div>
                  <div className="space-y-1 px-1">
                    {models.map((model) => {
                      const isActive = model.id === activeModelId && model.provider === activeProvider;
                      return (
                        <button
                          key={`${model.provider}:${model.id}`}
                          type="button"
                          onClick={() => void handleSelectModel(model)}
                          disabled={saving}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-lg border px-2 py-2 text-left transition-colors",
                            isActive
                              ? "border-terminal-green/40 bg-terminal-green/5"
                              : "border-transparent hover:border-terminal-border/40 hover:bg-terminal-cream/30",
                            saving && "cursor-wait opacity-70",
                          )}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-mono text-xs font-semibold text-terminal-dark">
                              {model.name}
                            </div>
                            <div className="truncate font-mono text-[10px] text-terminal-muted/70">
                              {model.id}
                            </div>
                          </div>
                          {saving && isActive ? (
                            <Loader2Icon className="size-3.5 animate-spin text-terminal-muted" />
                          ) : isActive ? (
                            <CheckIcon className="size-3.5 text-terminal-green" />
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
