"use client";

import { FC, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { parseNestedJsonString } from "@/lib/utils/parse-nested-json";
import {
  BookOpen,
  Heart,
  Eye,
  Copy,
  Check,
  ExternalLink,
  Loader2,
  ChevronDown,
  ChevronUp,
  TrendingUp,
  Shuffle,
  Search,
  Grid3X3,
} from "lucide-react";

// ============================================================================
// Types (mirrors prompt-library-tool.ts output shapes)
// ============================================================================

interface PromptEntry {
  rank: number;
  id: string;
  prompt: string;
  author: string;
  author_name: string;
  likes: number;
  views: number;
  image: string;
  images: string[];
  model: string;
  categories: string[];
  date: string;
  source_url: string;
  format: string;
}

interface PromptPreview {
  id: string;
  rank: number;
  promptPreview: string;
  categories: string[];
  likes: number;
  views: number;
  format: string;
}

interface CategoryEntry {
  name: string;
  count: number;
}

interface PromptLibraryResult {
  action?: string;
  success?: boolean;
  error?: string;
  prompt?: PromptEntry;
  totalMatches?: number;
  returned?: number;
  results?: PromptPreview[];
  categories?: CategoryEntry[];
  // SDK passthrough fields
  _sdkPassthrough?: boolean;
  content?: string | Array<{ type?: string; text?: string }>;
  status?: string;
}

type ToolCallContentPartComponent = FC<{
  toolName: string;
  argsText?: string;
  args?: {
    action?: string;
    query?: string;
    id?: string;
    category?: string;
    limit?: number;
  };
  result?: PromptLibraryResult | Record<string, unknown>;
  output?: PromptLibraryResult | Record<string, unknown> | string;
  state?:
    | "input-streaming"
    | "input-available"
    | "output-available"
    | "output-error"
    | "output-denied";
  errorText?: string;
}>;

// ============================================================================
// Result Normalization
// ============================================================================

function normalizeResult(
  raw: PromptLibraryResult | Record<string, unknown> | string | undefined,
  depth = 0,
): PromptLibraryResult | undefined {
  if (depth > 4 || !raw) return undefined;

  if (typeof raw === "string") {
    const parsed = parseNestedJsonString(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return normalizeResult(parsed as Record<string, unknown>, depth + 1);
    }
    return undefined;
  }

  if (typeof raw !== "object") return undefined;

  const obj = raw as Record<string, unknown>;

  // SDK passthrough — unwrap content
  if (obj._sdkPassthrough === true) {
    if (typeof obj.content === "string") {
      return normalizeResult(obj.content, depth + 1);
    }
    if (Array.isArray(obj.content)) {
      const textItem = (obj.content as Array<{ type?: string; text?: string }>).find(
        (i) => i?.type === "text" && typeof i.text === "string",
      );
      if (textItem?.text) return normalizeResult(textItem.text, depth + 1);
    }
    return undefined;
  }

  // Unwrap nested result/output
  if (obj.result && typeof obj.result === "object" && !Array.isArray(obj.result) && !obj.action) {
    return normalizeResult(obj.result as Record<string, unknown>, depth + 1);
  }
  if (obj.output && typeof obj.output === "object" && !Array.isArray(obj.output) && !obj.action) {
    return normalizeResult(obj.output as Record<string, unknown>, depth + 1);
  }

  // Content string wrapper
  if (typeof obj.content === "string" && obj.content.trim().startsWith("{")) {
    const inner = normalizeResult(obj.content, depth + 1);
    if (inner) return inner;
  }
  if (Array.isArray(obj.content)) {
    const textItem = (obj.content as Array<{ type?: string; text?: string }>).find(
      (i) => i?.type === "text" && typeof i.text === "string",
    );
    if (textItem?.text) {
      const inner = normalizeResult(textItem.text, depth + 1);
      if (inner) return inner;
    }
  }

  // Direct result object
  if (typeof obj.action === "string") {
    return obj as unknown as PromptLibraryResult;
  }

  return undefined;
}

// ============================================================================
// Helpers
// ============================================================================

const ACTION_ICONS: Record<string, typeof BookOpen> = {
  get: BookOpen,
  search: Search,
  trending: TrendingUp,
  random: Shuffle,
  categories: Grid3X3,
};

const ACTION_LABEL_KEYS: Record<string, string> = {
  get: "get",
  search: "search",
  trending: "trending",
  random: "random",
  categories: "categories",
};

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

// ============================================================================
// Sub-Components
// ============================================================================

const CopyButton: FC<{ text: string }> = ({ text }) => {
  const t = useTranslations("assistantUi.promptLibrary");
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={handleCopy}
      className={cn(
        "flex items-center justify-center w-7 h-7 rounded-md transition-all flex-shrink-0",
        copied
          ? "bg-terminal-green/20 text-terminal-green"
          : "hover:bg-terminal-dark/5 text-terminal-muted hover:text-terminal-dark",
      )}
      title={t("copyPrompt")}
    >
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
};


/** Full prompt card for action=get */
const PromptDetailCard: FC<{ prompt: PromptEntry }> = ({ prompt }) => {
  const t = useTranslations("assistantUi.promptLibrary");
  const [expanded, setExpanded] = useState(false);
  const isLong = prompt.prompt.length > 300;
  const displayText = expanded ? prompt.prompt : prompt.prompt.slice(0, 300);

  return (
    <div className="space-y-2">
      {/* Image */}
      {prompt.image && (
        <div className="relative rounded-md overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={prompt.image}
            alt="Prompt reference"
            className="w-full max-h-64 object-cover"
            loading="lazy"
          />
          {prompt.model && (
            <span className="absolute top-1.5 right-1.5 text-[10px] font-mono px-1.5 py-px rounded bg-black/50 text-white/80 backdrop-blur-sm">
              {prompt.model}
            </span>
          )}
        </div>
      )}

      {/* Prompt text */}
      <div>
        <pre className="p-2.5 rounded-md bg-terminal-dark/[0.03] text-[13px] text-terminal-dark whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-snug">
          {displayText}
          {isLong && !expanded && "…"}
        </pre>
        <div className="flex items-center gap-2 mt-1.5">
          {isLong && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex items-center gap-1 text-[11px] text-terminal-muted hover:text-terminal-dark transition-colors"
            >
              {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              {expanded ? t("less") : t("more")}
            </button>
          )}
          <div className="ml-auto">
            <CopyButton text={prompt.prompt} />
          </div>
        </div>
      </div>

      {/* Metadata */}
      <div className="flex items-center gap-2 flex-wrap text-[11px] text-terminal-muted/70">
        <span className="inline-flex items-center gap-0.5"><Heart className="w-2.5 h-2.5" />{formatNumber(prompt.likes)}</span>
        <span className="inline-flex items-center gap-0.5"><Eye className="w-2.5 h-2.5" />{formatNumber(prompt.views)}</span>
        <span className="font-mono">#{prompt.rank}</span>
        <span>·</span>
        <span className="font-mono">{prompt.author_name || prompt.author}</span>
        {prompt.date && <><span>·</span><span className="font-mono">{prompt.date}</span></>}
        {prompt.categories.map((cat) => (
          <span key={cat} className="text-terminal-muted/50">{cat}</span>
        ))}
        {prompt.source_url && (
          <a
            href={prompt.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-terminal-green hover:underline ml-auto"
          >
            <ExternalLink className="w-2.5 h-2.5" />
            {t("source")}
          </a>
        )}
      </div>
    </div>
  );
};

/** Preview card for search/trending/random results */
const PromptPreviewCard: FC<{ preview: PromptPreview; index: number }> = ({
  preview,
}) => {
  const truncated =
    preview.promptPreview.length > 140
      ? preview.promptPreview.slice(0, 140) + "…"
      : preview.promptPreview;

  return (
    <div className="flex items-start gap-2 py-2 group">
      <span className="text-[10px] font-mono text-terminal-muted/60 pt-0.5 w-6 text-right flex-shrink-0">
        {preview.rank}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] text-terminal-dark leading-snug break-words [overflow-wrap:anywhere]">
          {truncated}
        </p>
        <div className="flex items-center gap-2 mt-1 text-[11px] text-terminal-muted/70">
          <span className="inline-flex items-center gap-0.5">
            <Heart className="w-2.5 h-2.5" />
            {formatNumber(preview.likes)}
          </span>
          <span className="inline-flex items-center gap-0.5">
            <Eye className="w-2.5 h-2.5" />
            {formatNumber(preview.views)}
          </span>
          {preview.format === "json" && (
            <span className="font-mono text-terminal-amber">JSON</span>
          )}
          {preview.categories.slice(0, 2).map((cat) => (
            <span key={cat} className="text-terminal-muted/50">{cat}</span>
          ))}
        </div>
      </div>
    </div>
  );
};

/** Category list for action=categories */
const CategoryList: FC<{ categories: CategoryEntry[] }> = ({ categories }) => (
  <div className="grid grid-cols-2 gap-2">
    {categories.map((cat) => (
      <div
        key={cat.name}
        className="flex items-center justify-between p-2.5 rounded-lg border border-terminal-dark/10 bg-transparent"
      >
        <span className="text-sm font-mono text-terminal-dark truncate">
          {cat.name}
        </span>
        <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-terminal-dark/5 text-terminal-muted flex-shrink-0 ml-2">
          {cat.count}
        </span>
      </div>
    ))}
  </div>
);

// ============================================================================
// Main Component
// ============================================================================

export const PromptLibraryToolUI: ToolCallContentPartComponent = ({
  args,
  result,
  output,
  state,
  errorText,
}) => {
  const t = useTranslations("assistantUi.promptLibrary");
  const resolvedRaw = result ?? output;
  const data = useMemo(() => normalizeResult(resolvedRaw), [resolvedRaw]);

  const action = data?.action || args?.action || "search";
  const ActionIcon = ACTION_ICONS[action] || BookOpen;
  const labelKey = ACTION_LABEL_KEYS[action];
  const actionLabel = labelKey ? t(`actions.${labelKey}`) : t("title");

  // Loading state
  const isInputState = state === "input-streaming" || state === "input-available";
  if (!resolvedRaw && isInputState) {
    return (
      <div className="my-2 rounded-lg border border-terminal-border/60 bg-terminal-cream/70 overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2">
          <Loader2 className="w-3 h-3 animate-spin text-terminal-muted" />
          <span className="text-[11px] font-medium text-terminal-muted uppercase tracking-wider">
            {actionLabel}
          </span>
          {args?.query && (
            <code className="text-[11px] font-mono text-terminal-muted/60 truncate">
              &quot;{args.query}&quot;
            </code>
          )}
        </div>
      </div>
    );
  }

  // Error state
  const isError = state === "output-error" || state === "output-denied";
  if ((isError && !data?.success) || (data && data.success === false)) {
    return (
      <div className="my-2 rounded-lg border border-red-200/70 bg-terminal-cream/70 overflow-hidden">
        <div className="flex items-start gap-3 p-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-full bg-red-100 text-red-600 flex-shrink-0">
            <BookOpen className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <span className="text-xs font-medium text-red-600 uppercase tracking-wider">
              {actionLabel} {t("error")}
            </span>
            <p className="mt-1 text-sm text-red-600/90">
              {errorText || data?.error || t("queryFailed")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // No data yet
  if (!data) return null;

  // ─── Get Action ───
  if (data.action === "get" && data.prompt) {
    return (
      <div className="my-2 rounded-lg border border-terminal-border/60 bg-terminal-cream/70 overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-terminal-border/30">
          <BookOpen className="w-3 h-3 text-terminal-muted" />
          <span className="text-[11px] font-medium text-terminal-muted uppercase tracking-wider">
            {actionLabel}
          </span>
        </div>
        <div className="p-3">
          <PromptDetailCard prompt={data.prompt} />
        </div>
      </div>
    );
  }

  // ─── Search / Trending / Random ───
  if (
    (data.action === "search" ||
      data.action === "trending" ||
      data.action === "random") &&
    data.results
  ) {
    return (
      <div className="my-2 rounded-lg border border-terminal-border/60 bg-terminal-cream/70 overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-terminal-border/30">
          <ActionIcon className="w-3 h-3 text-terminal-muted" />
          <span className="text-[11px] font-medium text-terminal-muted uppercase tracking-wider">
            {actionLabel}
          </span>
          {args?.query && (
            <code className="text-[11px] font-mono text-terminal-muted/60 truncate ml-1">
              &quot;{args.query}&quot;
            </code>
          )}
          <span className="ml-auto text-[10px] font-mono text-terminal-muted/50">
            {data.returned ?? data.results.length}/{data.totalMatches ?? "?"}
          </span>
        </div>
        <div className="px-3 pb-2 divide-y divide-terminal-dark/[0.06]">
          {data.results.map((preview, idx) => (
            <PromptPreviewCard key={preview.id || idx} preview={preview} index={idx} />
          ))}
          {data.results.length === 0 && (
            <p className="text-sm text-terminal-muted text-center py-4">
              {t("noPromptsFound")}
            </p>
          )}
        </div>
      </div>
    );
  }

  // ─── Categories ───
  if (data.action === "categories" && data.categories) {
    return (
      <div className="my-2 rounded-lg border border-terminal-border/60 bg-terminal-cream/70 overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-terminal-border/30">
          <Grid3X3 className="w-3 h-3 text-terminal-muted" />
          <span className="text-[11px] font-medium text-terminal-muted uppercase tracking-wider">
            {actionLabel}
          </span>
          <span className="ml-auto text-[10px] font-mono text-terminal-muted/50">
            {data.categories.length}
          </span>
        </div>
        <div className="p-3">
          <CategoryList categories={data.categories} />
        </div>
      </div>
    );
  }

  // ─── Fallback for unknown action shapes ───
  return null;
};
