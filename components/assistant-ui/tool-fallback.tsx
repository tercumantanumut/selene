"use client";

import { memo, useEffect, useMemo, useRef, useState, type FC } from "react";
import { CircleNotch, CheckCircle, XCircle, Clock } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { getToolIcon } from "@/components/ui/tool-icon-map";
import { getCanonicalToolName, humanizeToolName, loadToolNameCache } from "./tool-name-utils";
import { useToolExpansion } from "./tool-expansion-context";
import { stripXmlStatusTags } from "./claude-code-tools/parse-text-result";
import { DiffStyledPre } from "./diff-styled-pre";
import { MarkdownFilePreview } from "./markdown-file-preview";
import { useChatSessionId } from "@/components/chat-provider";
import { isMarkdownFile, stripReadFileLineNumbers } from "@/lib/markdown/file-preview";
// Define the tool call component type manually since it's no longer exported
type ToolCallContentPartComponent = FC<{
  toolName: string;
  argsText?: string;
  args?: unknown;
  result?: unknown;
}>;

interface ImageResult {
  url: string;
  width?: number;
  height?: number;
  format?: string;
}

interface VideoResult {
  url: string;
  width?: number;
  height?: number;
  format?: string;
  fps?: number;
  duration?: number;
}

// Web search source type
interface WebSearchSource {
  url: string;
  title: string;
  snippet: string;
  relevanceScore: number;
}

interface ToolResult {
  status: "completed" | "processing" | "error" | "success" | "no_results" | "no_api_key" | "no_paths" | "disabled" | "no_provider";
  images?: ImageResult[];
  videos?: VideoResult[];
  results?: Array<{
    prompt?: string;
    status?: string;
    images?: ImageResult[];
    error?: string;
    // searchTools result fields
    name?: string;
    displayName?: string;
    category?: string;
    description?: string;
    isAvailable?: boolean;
  }>;
  error?: string;
  text?: string;
  jobId?: string;
  timeTaken?: number;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  executionTime?: number;
  // Honest truncation signal from executeCommand / bash. The fallback renderer
  // surfaces these so users see "output truncated" + a copy-retrieval CTA when
  // the dedicated tool UIs aren't selected (e.g. unknown alias, MCP wrapper).
  isTruncated?: boolean;
  logId?: string;
  // searchTools specific fields
  query?: string;
  message?: string;
  // webSearch specific fields
  sources?: WebSearchSource[];
  answer?: string;
  formattedResults?: string;
  iterationPerformed?: boolean;
}

function parseNestedJsonValue(text: string, maxDepth: number = 3): unknown | undefined {
  let current: unknown = text;
  for (let i = 0; i < maxDepth; i += 1) {
    if (typeof current !== "string") return current;
    const trimmed = current.trim();
    if (!trimmed) return undefined;
    try {
      current = JSON.parse(trimmed);
    } catch {
      return i === 0 ? undefined : current;
    }
  }
  return current;
}

export function unwrapMcpTextWrappedResult(result: ToolResult | string): ToolResult {
  if (typeof result === "string") {
    const parsed = parseNestedJsonValue(result);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ToolResult;
    }
    return {
      status: "success",
      text: typeof parsed === "string" ? parsed : result,
    };
  }

  const content = (result as ToolResult & { content?: unknown }).content;
  if (typeof content === "string") {
    const parsed = parseNestedJsonValue(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const parsedObj = parsed as Record<string, unknown>;
      return {
        ...result,
        ...parsedObj,
        status: typeof parsedObj.status === "string" ? (parsedObj.status as ToolResult["status"]) : result.status,
      };
    }
    if (typeof parsed === "string" && parsed.trim().length > 0) {
      return {
        ...result,
        text: parsed,
      };
    }
    return result;
  }

  if (!Array.isArray(content)) return result;

  const textItem = content.find(
    (item): item is { type?: string; text?: string } =>
      !!item &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string"
  );

  if (!textItem?.text) return result;
  const parsed = parseNestedJsonValue(textItem.text);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const parsedObj = parsed as Record<string, unknown>;
    return {
      ...result,
      ...parsedObj,
      status: typeof parsedObj.status === "string" ? (parsedObj.status as ToolResult["status"]) : result.status,
    };
  }

  if (typeof parsed === "string" && parsed.trim().length > 0) {
    return {
      ...result,
      text: parsed,
    };
  }

  return result;
}

function hasVisualMedia(result?: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.images) && (r.images as Array<Record<string, unknown>>).length) return true;
  if (Array.isArray(r.videos) && (r.videos as Array<Record<string, unknown>>).length) return true;
  if (Array.isArray(r.results)) {
    return r.results.some((item) => hasVisualMedia(item));
  }
  return false;
}

export function isToolErrorResult(result?: ToolResult): boolean {
  if (!result) return false;
  const status = typeof result.status === "string" ? result.status.toLowerCase() : "";
  return status === "error" || status === "failed" || status === "denied" || typeof result.error === "string";
}

const TOOL_RESULT_TEXT_CLASS = "text-sm text-terminal-muted font-mono transition-opacity duration-150 [overflow-wrap:anywhere]";
const TOOL_RESULT_PRE_CLASS = "overflow-x-auto rounded bg-terminal-dark/5 dark:bg-terminal-dark/[0.06] p-2 text-xs whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-terminal-dark dark:text-terminal-dark/90";
const TOOL_RESULT_ERROR_PRE_CLASS = "overflow-x-auto rounded bg-red-50 dark:bg-red-900/20 p-2 text-xs whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-red-600 dark:text-red-400";
const TOOL_ARGS_PREVIEW_MAX_CHARS = 2_000;

export function hasStructuredCommandOutput(result: ToolResult): boolean {
  return (
    typeof result.stdout === "string" ||
    typeof result.stderr === "string" ||
    typeof result.exitCode === "number" ||
    result.exitCode === null
  );
}

// Memoized Icon Component with Phosphor Icons
const ToolIcon: FC<{
  toolName: string;
  isRunning: boolean;
  result?: ToolResult;
}> = memo(({ toolName, isRunning, result }) => {
  const iconClass = "size-4 transition-all duration-200";
  
  // Status-based icons (highest priority)
  if (isRunning) {
    return <CircleNotch className={`${iconClass} animate-spin text-terminal-green`} weight="bold" />;
  }

  if (isToolErrorResult(result)) {
    return <XCircle className={`${iconClass} text-red-600`} weight="fill" />;
  }

  // Tool-specific icons from the icon map
  const iconConfig = getToolIcon(toolName);
  const Icon = iconConfig.icon;
  // Weight is already handled by the icon config
  const weight = iconConfig.weight;

  return <Icon className={`${iconClass} text-terminal-green`} weight={weight} />;
});
ToolIcon.displayName = "ToolIcon";

// Memoized Status Component
const ToolStatus: FC<{ isRunning: boolean; result?: ToolResult }> = memo(({
  isRunning,
  result,
}) => {
  const t = useTranslations("assistantUi.toolStatus");
  if (isRunning) {
    return (
      <span className="text-xs text-terminal-muted font-mono transition-opacity duration-150">{t("processing")}</span>
    );
  }

  if (isToolErrorResult(result)) {
    return <span className="text-xs text-red-600 font-mono transition-opacity duration-150">{t("failed")}</span>;
  }

  if (result?.status === "processing") {
    return <span className="text-xs text-terminal-amber font-mono transition-opacity duration-150">{t("queued")}</span>;
  }

  return <span className="text-xs text-terminal-green font-mono transition-opacity duration-150">{t("completed")}</span>;
});
ToolStatus.displayName = "ToolStatus";

// Memoized Result Display Component
const ToolResultDisplay: FC<{ toolName: string; result: ToolResult }> = memo(({ toolName, result }) => {
  const tResults = useTranslations("assistantUi.toolResults");
  const tMarkdown = useTranslations("assistantUi.markdownFilePreview");
  const tCommand = useTranslations("assistantUi.commandOutput");
  const canonicalToolName = getCanonicalToolName(toolName);
  const normalizedResult = unwrapMcpTextWrappedResult(result);
  const isCommandLikeTool = canonicalToolName.toLowerCase() === "bash" || canonicalToolName === "executeCommand";

  if (isToolErrorResult(normalizedResult) && (!isCommandLikeTool || !hasStructuredCommandOutput(normalizedResult))) {
    return (
      <div className="rounded bg-red-50 p-2 font-mono text-sm text-red-600 transition-all duration-150 [overflow-wrap:anywhere]">
        {normalizedResult.error || tResults("errorOccurred")}
      </div>
    );
  }

  if (isCommandLikeTool && hasStructuredCommandOutput(normalizedResult)) {
    return (
      <div className="mt-2 space-y-2 transition-opacity duration-150">
        {normalizedResult.error && (
          <div className="rounded bg-red-50 p-2 font-mono text-sm text-red-600 transition-all duration-150 [overflow-wrap:anywhere]">
            {normalizedResult.error}
          </div>
        )}
        {normalizedResult.exitCode !== undefined && normalizedResult.exitCode !== null && normalizedResult.exitCode !== 0 && (
          <div className="text-xs font-mono text-terminal-amber">
            {tResults("exitCode")} {normalizedResult.exitCode}
          </div>
        )}
        {normalizedResult.stdout && (
          <pre className={cn("max-h-64", TOOL_RESULT_PRE_CLASS)}>
            {normalizedResult.stdout}
          </pre>
        )}
        {normalizedResult.stderr && (
          <pre className={cn("max-h-64", TOOL_RESULT_ERROR_PRE_CLASS)}>
            {normalizedResult.stderr}
          </pre>
        )}
        {/*
         * Truncation banner — the executor now propagates `isTruncated` + `logId`
         * honestly (size-clamp or timeout-kill). The dedicated execute-command
         * and Claude bash UIs already render the same banner via command-output.tsx;
         * we mirror it here so MCP wrappers / unknown aliases that fall through
         * to the fallback also surface the signal instead of silently dropping it.
         */}
        {normalizedResult.isTruncated && normalizedResult.logId && (
          <div className="my-1 flex items-center justify-between gap-3 rounded-md border border-terminal-amber/30 bg-terminal-amber/10 p-2">
            <div className="flex items-center gap-2 text-terminal-amber">
              <Clock className="h-4 w-4 shrink-0" weight="regular" />
              <span className="text-xs font-mono">
                {tCommand("truncated", { logId: normalizedResult.logId })}
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(
                  `executeCommand({ command: "readLog", logId: "${normalizedResult.logId}" })`,
                );
              }}
              className="shrink-0 rounded border border-terminal-amber/20 bg-terminal-amber/20 px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-terminal-amber transition-colors hover:bg-terminal-amber/30"
            >
              {tCommand("copyRetrieval")}
            </button>
          </div>
        )}
      </div>
    );
  }

  if (normalizedResult.status === "processing") {
    return (
      <div className={cn("transition-all duration-150", TOOL_RESULT_TEXT_CLASS)}>
        {tResults("generationQueued", { jobId: normalizedResult.jobId ?? "" })}
      </div>
    );
  }

  // Handle searchTools results
  if (canonicalToolName === "searchTools") {
    const rawResults = (normalizedResult as { results?: unknown }).results;
    const searchResults = Array.isArray(rawResults) ? rawResults as Array<{
      name?: string;
      displayName?: string;
      category?: string;
      description?: string;
      isAvailable?: boolean;
    }> : undefined;

    if (rawResults !== undefined && !Array.isArray(rawResults)) {
      return (
        <div className={TOOL_RESULT_TEXT_CLASS}>
          {tResults("unexpectedFormat")}
          <pre className={cn("mt-2 max-h-64", TOOL_RESULT_PRE_CLASS)}>
            {formatResultValue(rawResults)}
          </pre>
        </div>
      );
    }

    if (normalizedResult.status === "no_results") {
      return (
        <div className={TOOL_RESULT_TEXT_CLASS}>
          {tResults("noToolsFound", { query: normalizedResult.query ?? "" })}
        </div>
      );
    }

    if (Array.isArray(searchResults) && searchResults.length === 0) {
      return (
        <div className={TOOL_RESULT_TEXT_CLASS}>
          {tResults("noToolsFound", { query: normalizedResult.query ?? "" })}
        </div>
      );
    }

    if (!searchResults) {
      const fallbackText =
        normalizedResult.message ||
        normalizedResult.text ||
        (typeof (normalizedResult as { summary?: unknown }).summary === "string"
          ? ((normalizedResult as { summary?: string }).summary ?? "")
          : "");
      if (fallbackText.trim().length > 0) {
        return (
          <div className={TOOL_RESULT_TEXT_CLASS}>
            <pre className={cn("mt-2 max-h-64", TOOL_RESULT_PRE_CLASS)}>
              {fallbackText}
            </pre>
          </div>
        );
      }
      return (
        <div className={TOOL_RESULT_TEXT_CLASS}>
          {tResults("unexpectedFormat")}
        </div>
      );
    }

    const toolNames = searchResults.map(t => t.displayName || t.name).filter(Boolean);
    return (
      <div className="text-sm font-mono transition-opacity duration-150">
        <p className="text-terminal-dark mb-2">
          {tResults("toolsFound", { count: searchResults.length, names: toolNames.join(", ") })}
        </p>
        <div className="space-y-1">
          {searchResults.map((tool, idx) => (
            <div key={idx} className="flex items-center gap-2 text-xs">
              <span className={tool.isAvailable ? "text-terminal-green" : "text-terminal-muted"}>
                {tool.isAvailable ? "●" : "○"}
              </span>
              <span className="text-terminal-dark font-medium">{tool.displayName || tool.name}</span>
              {tool.category && (
                <span className="text-terminal-muted">({tool.category})</span>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Handle listAllTools results
  if (canonicalToolName === "listAllTools") {
    return (
      <div className={TOOL_RESULT_TEXT_CLASS}>
        {normalizedResult.message || tResults("toolsListedSuccessfully")}
      </div>
    );
  }

  // Handle webSearch results
  if (canonicalToolName === "webSearch") {
    const action = typeof (normalizedResult as { action?: unknown }).action === "string"
      ? ((normalizedResult as { action?: string }).action ?? "search")
      : "search";

    // Handle provider/configuration errors
    if (normalizedResult.status === "no_provider" || normalizedResult.status === "no_api_key") {
      return (
        <div className={TOOL_RESULT_TEXT_CLASS}>
          {normalizedResult.message || tResults("webSearchUnavailable")}
        </div>
      );
    }

    // Handle browse action with full-page payloads
    if (action === "browse") {
      const pages = Array.isArray((normalizedResult as { pages?: unknown[] }).pages)
        ? ((normalizedResult as { pages?: Array<{ title?: string; url?: string; contentLength?: number }> }).pages ?? [])
        : [];

      if (pages.length === 0) {
        return (
          <div className={TOOL_RESULT_TEXT_CLASS}>
            {normalizedResult.message || normalizedResult.formattedResults || tResults("noBrowseResults")}
          </div>
        );
      }

      return (
        <div className={cn("space-y-3", TOOL_RESULT_TEXT_CLASS)}>
          {normalizedResult.message && (
            <div className="rounded bg-terminal-dark/5 p-2 text-terminal-dark [overflow-wrap:anywhere]">
              {normalizedResult.message}
            </div>
          )}
          <div className="space-y-2">
            <span className="text-terminal-muted text-xs">
              {tResults("sourcesFound", { count: pages.length })}
            </span>
            {pages.map((page, idx) => (
              <div key={idx} className="pl-2 border-l-2 border-terminal-green/30">
                <a
                  href={page.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-terminal-green hover:underline font-medium block"
                >
                  {idx + 1}. {page.title || page.url}
                </a>
                {typeof page.contentLength === "number" && (
                  <p className="text-xs text-terminal-muted mt-0.5">
                    {tResults("kbFetched", { size: Math.round(page.contentLength / 1024) })}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      );
    }

    // For disabled/no_paths statuses, show message when no sources available
    if (normalizedResult.status === "disabled" || normalizedResult.status === "no_paths") {
      const hasSources = Array.isArray(normalizedResult.sources) && normalizedResult.sources.length > 0;
      if (!hasSources) {
        return (
          <div className={TOOL_RESULT_TEXT_CLASS}>
            {normalizedResult.message || tResults("webSearchUnavailable")}
          </div>
        );
      }
    }

    // Display search-style sources with links
    const sources = normalizedResult.sources || [];
    if (sources.length === 0) {
      return (
        <div className={TOOL_RESULT_TEXT_CLASS}>
          {normalizedResult.message || tResults("noWebResults", { query: normalizedResult.query ?? "" })}
        </div>
      );
    }

    return (
      <div className={cn("space-y-3", TOOL_RESULT_TEXT_CLASS)}>
        {/* Summary/Answer */}
        {normalizedResult.answer && (
          <div className="rounded bg-terminal-dark/5 p-2 text-terminal-dark [overflow-wrap:anywhere]">
            <span className="font-medium">{tResults("webSearchSummary")}:</span> {normalizedResult.answer}
          </div>
        )}

        {normalizedResult.message && (
          <div className="rounded bg-terminal-dark/5 p-2 text-terminal-dark [overflow-wrap:anywhere]">
            {normalizedResult.message}
          </div>
        )}

        {/* Sources with clickable links */}
        <div className="space-y-2">
          <span className="text-terminal-muted text-xs">
            {tResults("sourcesFound", { count: sources.length })}
          </span>
          {sources.map((source, idx) => (
            <div key={idx} className="pl-2 border-l-2 border-terminal-green/30">
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-terminal-green hover:underline font-medium block"
              >
                {idx + 1}. {source.title}
              </a>
              <p className="text-xs text-terminal-muted mt-0.5 line-clamp-2">
                {source.snippet}
              </p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Handle readFile results
  if (canonicalToolName === "readFile") {
    const readResult = normalizedResult as ToolResult & {
      filePath?: string;
      language?: string;
      lineRange?: string;
      totalLines?: number;
      content?: string;
      truncated?: boolean;
      source?: string;
      documentTitle?: string;
    };

    // Handle error status
    if (readResult.status === "error") {
      return (
        <div className="rounded bg-red-50 p-2 font-mono text-sm text-red-600 transition-all duration-150 [overflow-wrap:anywhere]">
          {readResult.error || tResults("readFileFailed")}
        </div>
      );
    }

    const fileName = readResult.filePath
      ? readResult.filePath.split("/").pop() || readResult.filePath
      : "file";

    // Handle binary file soft-redirect or text-only responses (no content field)
    if (!readResult.content && readResult.text) {
      return (
        <div className={cn("font-mono", TOOL_RESULT_TEXT_CLASS)}>
          <div className="flex items-center gap-2 mb-2 text-terminal-dark">
            <span className="font-medium">{fileName}</span>
          </div>
          <p className="text-xs text-terminal-muted">
            {readResult.text}
          </p>
        </div>
      );
    }

    const sourceLabel = "";
    const lineInfo = readResult.lineRange
      ? tResults("lineRange", { range: readResult.lineRange }) + (readResult.totalLines ? ` ${tResults("ofTotalLines", { total: readResult.totalLines })}` : "")
      : readResult.totalLines
        ? tResults("totalLines", { count: readResult.totalLines })
        : "";
    const truncatedLabel = readResult.truncated ? ` (${tResults("truncated")})` : "";

    // For readFile, allow a much larger display limit since users explicitly requested this content
    const content = readResult.content || "";
    const READ_FILE_DISPLAY_LIMIT = 20_000;
    const contentWasDisplayLimited = content.length > READ_FILE_DISPLAY_LIMIT;
    const displayContent = contentWasDisplayLimited
      ? content.substring(0, READ_FILE_DISPLAY_LIMIT) + `\n\n... [${tResults("moreCharsFullContent", { count: (content.length - READ_FILE_DISPLAY_LIMIT).toLocaleString() })}]`
      : content;
    const shouldRenderMarkdownPreview =
      isMarkdownFile(readResult.filePath, readResult.language) &&
      displayContent.trim().length > 0;
    const markdownPreviewContent = shouldRenderMarkdownPreview
      ? stripReadFileLineNumbers(displayContent)
      : "";
    const sourceView = displayContent ? (
      <pre className={cn("mt-1 max-h-96 overflow-y-auto", TOOL_RESULT_PRE_CLASS)}>
        {displayContent}
      </pre>
    ) : null;

    return (
      <div className={cn("font-mono", TOOL_RESULT_TEXT_CLASS)}>
        <div className="flex items-center gap-2 mb-2 text-terminal-dark">
          <span className="font-medium">{fileName}</span>
          {readResult.language && (
            <span className="text-xs text-terminal-muted">({readResult.language})</span>
          )}
          {sourceLabel && (
            <span className="text-xs text-terminal-muted">{sourceLabel}</span>
          )}
        </div>
        {lineInfo && (
          <p className="text-xs text-terminal-muted mb-2">
            {lineInfo}{truncatedLabel}
          </p>
        )}
        {sourceView && (shouldRenderMarkdownPreview ? (
          <MarkdownFilePreview
            content={markdownPreviewContent}
            sourceView={sourceView}
            previewNotice={readResult.truncated || contentWasDisplayLimited ? tMarkdown("previewMayBeIncomplete") : undefined}
          />
        ) : sourceView)}
      </div>
    );
  }

  // Handle localGrep results
  if (canonicalToolName === "localGrep") {
    const grepResult = normalizedResult as ToolResult & {
      matchCount?: number;
      pattern?: string;
      results?: string;
      matches?: Array<{ file: string; line: number; text: string }>;
      searchedPaths?: string[];
      pathSource?: "explicit" | "workspace" | "synced_folders" | "workspace_then_synced";
      attemptedScopes?: string[];
      fallbackUsed?: boolean;
    };

    if (grepResult.status === "error") {
      return (
        <div className={cn("font-mono", TOOL_RESULT_TEXT_CLASS)}>
          <p className="mb-2 text-red-600">{tResults("searchFailed")}</p>
          <pre className={TOOL_RESULT_ERROR_PRE_CLASS}>
            {grepResult.error || "Unknown localGrep error"}
          </pre>
        </div>
      );
    }

    // Handle no_paths or disabled status
    if (grepResult.status === "no_paths" || grepResult.status === "disabled") {
      return (
        <div className={TOOL_RESULT_TEXT_CLASS}>
          {grepResult.message || tResults("noPathsToSearch")}
        </div>
      );
    }

    // Handle success with results
    if (grepResult.matchCount !== undefined) {
      return (
        <div className={cn("font-mono", TOOL_RESULT_TEXT_CLASS)}>
          <p className="text-terminal-dark mb-2">
            {tResults("matchesFound", { count: grepResult.matchCount ?? 0, pattern: grepResult.pattern ?? "" })}
          </p>
          {grepResult.message && (
            <p className="text-xs text-terminal-muted mb-2">{grepResult.message}</p>
          )}
          {grepResult.results && (
            <pre className={cn("mt-2 max-h-64", TOOL_RESULT_PRE_CLASS)}>
              {grepResult.results}
            </pre>
          )}
        </div>
      );
    }

    // Fallback for other localGrep statuses
    return (
      <div className={TOOL_RESULT_TEXT_CLASS}>
        {grepResult.message || tResults("searchCompleted")}
      </div>
    );
  }

  // Show generated videos
  if (normalizedResult.videos && normalizedResult.videos.length > 0) {
    return (
      <div className="mt-2 animate-in fade-in zoom-in-95 duration-200">
        <div className="space-y-4">
          {normalizedResult.videos.map((video, idx) => (
            <div key={idx} className="relative">
              <video
                src={video.url}
                controls
                width={video.width || undefined}
                height={video.height || undefined}
                className="w-full max-w-lg h-auto rounded-lg shadow-sm"
                preload="metadata"
              >
                {tResults("videoNotSupported")}
              </video>
              <div className="mt-1 flex items-center gap-2 text-xs text-terminal-muted font-mono">
                {video.duration && <span>{video.duration}s</span>}
                {video.fps && <span>• {video.fps} fps</span>}
                <a
                  href={video.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-auto hover:text-terminal-green"
                >
                  {tResults("openInNewTab")}
                </a>
              </div>
            </div>
          ))}
        </div>
        {normalizedResult.timeTaken && (
          <p className="mt-2 text-xs text-terminal-muted font-mono">
            {tResults("generatedIn", { seconds: normalizedResult.timeTaken.toFixed(1) })}
          </p>
        )}
      </div>
    );
  }

  // Show generated images
  if (normalizedResult.images && normalizedResult.images.length > 0) {
    return (
      <div className="mt-2 animate-in fade-in zoom-in-95 duration-200">
        <div className="image-grid">
          {normalizedResult.images.map((img, idx) => (
            <a
              key={idx}
              href={img.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block"
            >
              <img
                src={img.url}
                alt={tResults("generatedImageAlt", { number: idx + 1 })}
                width={img.width || undefined}
                height={img.height || undefined}
                className="w-full h-auto rounded-lg shadow-sm hover:shadow-md transition-shadow"
                loading="eager"
              />
            </a>
          ))}
        </div>
        {normalizedResult.text && (
          <p className={cn("mt-2", TOOL_RESULT_TEXT_CLASS)}>{normalizedResult.text}</p>
        )}
      </div>
    );
  }


  // Show batch results
  if (Array.isArray(normalizedResult.results) && normalizedResult.results.length > 0) {
    return (
      <div className="mt-2 space-y-4 transition-opacity duration-150">
        {normalizedResult.results.map((item, idx) => (
          <div key={idx} className="pt-4 first:pt-0">
            {item.prompt && (
              <p className="text-xs text-terminal-muted mb-2 font-mono">
                {tResults("variationWithPrompt", { number: idx + 1, prompt: item.prompt.slice(0, 50) })}
              </p>
            )}
            {!item.prompt && (
              <p className="text-xs text-terminal-muted mb-2 font-mono">
                {tResults("variation", { number: idx + 1 })}
              </p>
            )}
            {item.status === "completed" && item.images && (
              <div className="image-grid">
                {item.images.map((img, imgIdx) => (
                  <a
                    key={imgIdx}
                    href={img.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block"
                  >
                    <img
                      src={img.url}
                      alt={tResults("variationImageAlt", { variation: idx + 1, image: imgIdx + 1 })}
                      width={img.width || undefined}
                      height={img.height || undefined}
                      className="w-full h-auto rounded-lg shadow-sm hover:shadow-md transition-shadow"
                      loading="eager"
                    />
                  </a>
                ))}
              </div>
            )}
            {item.status === "error" && (
              <p className="text-sm text-red-600 font-mono">{item.error}</p>
            )}
          </div>
        ))}
      </div>
    );
  }

  if (normalizedResult.results && !Array.isArray(normalizedResult.results)) {
    return (
      <div className={cn("mt-2", TOOL_RESULT_TEXT_CLASS)}>
        <pre className={cn("max-h-64", TOOL_RESULT_PRE_CLASS)}>
          {formatResultValue(normalizedResult.results)}
        </pre>
      </div>
    );
  }

  // Fallback for generic text/content results (e.g., MCP tools like take_snapshot)
  const rawTextContent = normalizedResult.text || (normalizedResult as { content?: string }).content;
  if (rawTextContent && typeof rawTextContent === "string") {
    // Strip XML status tags (e.g., <retrieval_status>timeout</retrieval_status>)
    const { cleanText: textContent } = stripXmlStatusTags(rawTextContent);
    // Truncate very long results for display (full result is still available to AI)
    const displayText = textContent.length > 2000
      ? textContent.substring(0, 2000) + `\n\n... [${tResults("moreChars", { count: textContent.length - 2000 })}]`
      : textContent;

    // Detect diff content: if >30% of lines are +/- prefixed, render with diff styling
    const textLines = displayText.split("\n");
    const diffLineCount = textLines.filter(l => l.startsWith("+ ") || l.startsWith("- ")).length;
    const isDiffContent = diffLineCount > 0 && textLines.length > 1 && diffLineCount / textLines.length > 0.3;

    if (isDiffContent) {
      return (
        <div className={cn("mt-2", TOOL_RESULT_TEXT_CLASS)}>
          <DiffStyledPre lines={textLines} className="max-h-64 overflow-y-auto" />
        </div>
      );
    }

    return (
      <div className={cn("mt-2", TOOL_RESULT_TEXT_CLASS)}>
        <pre className={cn("max-h-64", TOOL_RESULT_PRE_CLASS)}>
          {displayText}
        </pre>
      </div>
    );
  }

  // Final defensive fallback: render unknown object-shaped outputs so the UI
  // never appears empty when a tool completed but returned an unrecognized schema.
  // Only use summary as the sole output when the result has no other substantive fields.
  const genericSummary =
    typeof (normalizedResult as { summary?: unknown }).summary === "string"
      ? ((normalizedResult as { summary?: string }).summary ?? "")
      : "";
  const hasSubstantiveFields = Object.keys(normalizedResult).some(
    (k) => !["status", "summary", "metadata", "success", "isError"].includes(k)
  );

  if (!hasSubstantiveFields && genericSummary.trim().length > 0) {
    return (
      <div className={cn("mt-2", TOOL_RESULT_TEXT_CLASS)}>
        <pre className={cn("max-h-64", TOOL_RESULT_PRE_CLASS)}>
        {genericSummary}
      </pre>
    </div>
  );
}

return (
  <div className={cn("mt-2", TOOL_RESULT_TEXT_CLASS)}>
    <pre className={cn("max-h-64", TOOL_RESULT_PRE_CLASS)}>
      {formatResultValue(normalizedResult)}
    </pre>
  </div>
);
});
ToolResultDisplay.displayName = "ToolResultDisplay";

// Tool name cache is now shared via tool-name-utils.ts loadToolNameCache()

// Main component with memo
export const ToolFallback: ToolCallContentPartComponent = memo(({
  toolName,
  argsText,
  args,
  result,
}) => {
  const t = useTranslations("assistantUi.tools");
  const sessionId = useChatSessionId();
  const canonicalToolName = useMemo(() => getCanonicalToolName(toolName), [toolName]);
  const isRunning = result === undefined;
  const parsedResult = result as ToolResult | undefined;
  const [resolvedName, setResolvedName] = useState<string | null>(null);
  const [isArgsExpanded, setIsArgsExpanded] = useState(false);
  const [isOutputExpanded, setIsOutputExpanded] = useState(false);

  // React to global expand/collapse signal
  const expansionCtx = useToolExpansion();
  const lastSignalRef = useRef(0);
  useEffect(() => {
    if (!expansionCtx || expansionCtx.signal.counter === 0) return;
    if (expansionCtx.signal.counter === lastSignalRef.current) return;
    lastSignalRef.current = expansionCtx.signal.counter;
    const next = expansionCtx.signal.mode === "expand";
    setIsArgsExpanded(next);
    setIsOutputExpanded(next);
  }, [expansionCtx?.signal]);

  // Memoize the display name lookup
  const displayName = useMemo(() => {
    if (t.has(canonicalToolName)) return t(canonicalToolName);
    if (t.has(toolName)) return t(toolName);
    return resolvedName || humanizeToolName(canonicalToolName);
  }, [t, canonicalToolName, toolName, resolvedName]);

  useEffect(() => {
    let cancelled = false;
    if (t.has(canonicalToolName) || t.has(toolName)) {
      setResolvedName(null);
      return;
    }
    loadToolNameCache().then((cache) => {
      if (cancelled) return;
      setResolvedName(cache[canonicalToolName] || cache[toolName] || null);
    });
    return () => {
      cancelled = true;
    };
  }, [canonicalToolName, toolName, t]);

  const dispatchedCompactResultRef = useRef(false);
  useEffect(() => {
    if (
      canonicalToolName !== "compactSession" ||
      !sessionId ||
      !parsedResult ||
      parsedResult.status !== "success"
    ) {
      if (parsedResult === undefined) {
        dispatchedCompactResultRef.current = false;
      }
      return;
    }

    if (dispatchedCompactResultRef.current) {
      return;
    }
    dispatchedCompactResultRef.current = true;

    window.dispatchEvent(new CustomEvent("seline:compact-session-completed", {
      detail: {
        sessionId,
        status: parsedResult,
      },
    }));
  }, [canonicalToolName, parsedResult, sessionId]);

  // When the tool completes, prefer the parsed args object if argsText is
  // stale (e.g. "{}" from a streaming race where the result arrives before
  // the final args delta).
  const effectiveArgsText = useMemo(() => {
    if (!isRunning && (!argsText || argsText.trim() === "{}") && args && typeof args === "object" && Object.keys(args as Record<string, unknown>).length > 0) {
      return JSON.stringify(args, null, 2);
    }
    return argsText;
  }, [argsText, args, isRunning]);

  // Memoize formatted args
  const formattedArgs = useMemo(() => {
    if (!effectiveArgsText) return null;
    // Avoid repeated JSON parsing while the tool is still streaming input.
    if (isRunning || !isArgsExpanded) {
      return formatArgsPreview(effectiveArgsText);
    }
    return formatArgs(effectiveArgsText);
  }, [effectiveArgsText, isArgsExpanded, isRunning]);

  return (
    <div className={cn(
      "my-2 min-w-0 rounded-lg bg-terminal-cream/90 backdrop-blur-sm p-4 font-mono shadow-sm transition-all duration-150 ease-in-out [contain:layout_style]",
      isRunning && "min-h-[60px]"
    )}>
      <div className="mb-2 flex min-w-0 items-center gap-2 transition-opacity duration-150">
        <ToolIcon toolName={canonicalToolName} isRunning={isRunning} result={parsedResult} />
        <span className="min-w-0 truncate font-medium text-sm text-terminal-dark">
          {displayName}
        </span>
        <ToolStatus isRunning={isRunning} result={parsedResult} />
      </div>

      {/* Show args summary */}
      {formattedArgs && (
        <details
          className="mb-2 text-xs text-terminal-muted"
          open={isArgsExpanded}
          onToggle={(event) => {
            setIsArgsExpanded((event.currentTarget as HTMLDetailsElement).open);
          }}
        >
          <summary className="cursor-pointer hover:text-terminal-dark">
            {t("viewParameters")}{isRunning ? t("livePreview") : ""}
          </summary>
          <pre className={cn("mt-2 max-h-48 overflow-y-auto", TOOL_RESULT_PRE_CLASS)}>
            {formattedArgs}
          </pre>
          {isRunning && typeof argsText === "string" && argsText.length > TOOL_ARGS_PREVIEW_MAX_CHARS && (
            <p className="mt-1 text-[11px] text-terminal-muted">
              {t("fullParamsAfterComplete")}
            </p>
          )}
        </details>
      )}

      {/* Show result in collapsible section */}
      {parsedResult && (
        hasVisualMedia(parsedResult) ? (
          <ToolResultDisplay toolName={toolName} result={parsedResult} />
        ) : (
          <details
            className="text-xs text-terminal-muted"
            open={isOutputExpanded}
            onToggle={(event) => {
              setIsOutputExpanded((event.currentTarget as HTMLDetailsElement).open);
            }}
          >
            <summary className="cursor-pointer hover:text-terminal-dark">
              {t("viewOutput")}
            </summary>
            <ToolResultDisplay toolName={toolName} result={parsedResult} />
          </details>
        )
      )}
    </div>
  );
});
ToolFallback.displayName = "ToolFallback";

function formatArgs(argsText: string): string {
  try {
    const parsed = JSON.parse(argsText);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return argsText;
  }
}

export function formatArgsPreview(argsText: string): string {
  if (argsText.length <= TOOL_ARGS_PREVIEW_MAX_CHARS) {
    return argsText;
  }
  const hiddenChars = argsText.length - TOOL_ARGS_PREVIEW_MAX_CHARS;
  return (
    `${argsText.slice(0, TOOL_ARGS_PREVIEW_MAX_CHARS)}\n\n` +
    `... [${hiddenChars.toLocaleString()} more characters hidden in preview]`
  );
}

function formatResultValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
