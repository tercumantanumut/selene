"use client";

import { useCallback, useRef, useSyncExternalStore } from "react";
import type { TaskEvent, TaskProgressEvent } from "@/lib/background-tasks/types";
import { getCanonicalToolName } from "./tool-name-utils";

export type LiveToolPhase = "preparing" | "running" | "completed" | "error";

export interface LiveToolStatus {
  toolCallId?: string;
  toolName: string;
  canonicalToolName: string;
  phase: LiveToolPhase;
  label: string;
  detail?: string;
  argsPreview?: string;
  outputPreview?: string;
  updatedAt: number;
  /** Unix ms when the tool call began executing (Agent only). */
  startedAt?: number;
  /** Milliseconds elapsed from start to completion (Agent only, set on completion). */
  elapsedMs?: number;
  /** Parsed execution steps from the Agent result (numbered/bulleted lists). */
  steps?: string[];
  /** Count of parsed steps, used as the badge pill count. */
  stepCount?: number;
}

interface ProgressToolPartLike {
  type?: string;
  toolCallId?: string;
  toolName?: string;
  state?: string;
  status?: string;
  input?: unknown;
  args?: unknown;
  argsText?: string;
  result?: unknown;
  output?: unknown;
  errorText?: string;
}

function isProgressTruncatedMarker(value: unknown): value is {
  _progressTruncated: true;
  summary?: unknown;
} {
  return !!value && typeof value === "object" && (value as { _progressTruncated?: unknown })._progressTruncated === true;
}

function summarizeString(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 3))}...`;
}

/**
 * Unwrap MCP-style content arrays: `{ content: [{ type: "text", text: "..." }] }`
 * Returns the extracted text if the pattern matches, otherwise undefined.
 */
function unwrapMcpContent(record: Record<string, unknown>): string | undefined {
  const content = record.content;
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;

  const textItem = content.find(
    (item): item is { type: string; text: string } =>
      !!item &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string"
  );

  return textItem?.text?.trim() || undefined;
}

/**
 * Build a human-readable key-value summary from an object's most meaningful fields,
 * instead of dumping raw JSON.
 */
function summarizeObjectReadable(record: Record<string, unknown>, maxLength: number): string {
  // Keys that are noise in a summary
  const skipKeys = new Set([
    "status", "type", "content", "_progressTruncated",
    "images", "videos", "sources", "results",
  ]);

  // Prefer these keys in order for building the summary
  const preferredOrder = [
    "filePath", "file", "path", "name", "displayName",
    "pattern", "query", "command", "description",
    "answer", "matchCount", "totalMatchCount", "count",
    "language", "lineRange", "totalLines",
    "action", "branch", "url",
  ];

  const parts: string[] = [];
  const seen = new Set<string>();

  // First pass: preferred keys
  for (const key of preferredOrder) {
    if (seen.has(key) || skipKeys.has(key)) continue;
    const val = record[key];
    if (val === undefined || val === null) continue;
    seen.add(key);
    if (typeof val === "string") {
      const short = val.length > 60 ? val.slice(0, 57) + "..." : val;
      // For file paths, show just the filename
      if ((key === "filePath" || key === "file" || key === "path") && short.includes("/")) {
        parts.push(short.split("/").pop() || short);
      } else {
        parts.push(`${key}: ${short}`);
      }
    } else if (typeof val === "number" || typeof val === "boolean") {
      parts.push(`${key}: ${val}`);
    }
    // Stop early if we have enough context
    if (parts.join(", ").length > maxLength * 0.8) break;
  }

  // Second pass: remaining string/number/boolean fields
  if (parts.length === 0) {
    for (const [key, val] of Object.entries(record)) {
      if (seen.has(key) || skipKeys.has(key)) continue;
      if (val === undefined || val === null) continue;
      if (typeof val === "string" && val.trim()) {
        parts.push(`${key}: ${val.length > 50 ? val.slice(0, 47) + "..." : val}`);
      } else if (typeof val === "number" || typeof val === "boolean") {
        parts.push(`${key}: ${val}`);
      }
      if (parts.join(", ").length > maxLength * 0.8) break;
    }
  }

  if (parts.length > 0) {
    return summarizeString(parts.join(", "), maxLength);
  }

  // Last resort: JSON, but we tried
  try {
    return summarizeString(JSON.stringify(record), maxLength);
  } catch {
    return summarizeString(String(record), maxLength);
  }
}

function summarizeToolValue(value: unknown, maxLength: number = 120): string | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? summarizeString(trimmed, maxLength) : undefined;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const first = summarizeToolValue(value[0], Math.max(32, Math.floor(maxLength / 2)));
    return first ? `${value.length} items - ${first}` : `${value.length} items`;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (isProgressTruncatedMarker(record)) {
      if (typeof record.summary === "string" && record.summary.trim()) {
        return summarizeString(record.summary, maxLength);
      }
      return "Truncated for progress display";
    }
    if (Array.isArray(record.images)) return `${record.images.length} image${record.images.length === 1 ? "" : "s"}`;
    if (Array.isArray(record.videos)) return `${record.videos.length} video${record.videos.length === 1 ? "" : "s"}`;
    if (Array.isArray(record.sources)) return `${record.sources.length} source${record.sources.length === 1 ? "" : "s"}`;

    // Unwrap MCP content arrays before checking text fields
    const mcpText = unwrapMcpContent(record);
    if (mcpText) {
      // Try to parse as JSON in case the text wraps structured data
      try {
        const parsed = JSON.parse(mcpText);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return summarizeToolValue(parsed, maxLength);
        }
      } catch { /* not JSON, use as-is */ }
      return summarizeString(mcpText, maxLength);
    }

    if (typeof record.message === "string") return summarizeString(record.message, maxLength);
    if (typeof record.summary === "string") return summarizeString(record.summary, maxLength);
    if (typeof record.text === "string") return summarizeString(record.text, maxLength);
    if (typeof record.answer === "string") return summarizeString(record.answer, maxLength);
    if (typeof record.stdout === "string") return summarizeString(record.stdout, maxLength);
    if (typeof record.error === "string") return summarizeString(record.error, maxLength);
    if (typeof record.errorText === "string") return summarizeString(record.errorText, maxLength);

    // Build a human-readable summary from object fields instead of raw JSON
    return summarizeObjectReadable(record, maxLength);
  }

  return summarizeString(String(value), maxLength);
}

/**
 * Extract a clean pill summary for known provider tool shapes (Claude Code, etc.).
 * Returns undefined if the tool isn't recognized, so callers can fall back
 * to the generic `summarizeToolInput`.
 */
export function summarizeToolInputByName(toolName: string, value: unknown): string | undefined {
  if (!value || typeof value !== "object") return summarizeToolInput(value);

  const args = value as Record<string, unknown>;

  switch (toolName) {
    case "Edit": {
      const fp = typeof args.file_path === "string" ? args.file_path : undefined;
      return fp ? fp.split("/").pop() || fp : summarizeToolInput(value);
    }
    case "Bash": {
      if (typeof args.description === "string" && args.description.trim()) {
        return summarizeString(args.description.trim(), 96);
      }
      if (typeof args.command === "string") {
        return summarizeString(args.command, 96);
      }
      return summarizeToolInput(value);
    }
    case "Read": {
      const fp = typeof args.file_path === "string" ? args.file_path : undefined;
      if (!fp) return summarizeToolInput(value);
      const name = fp.split("/").pop() || fp;
      if (typeof args.offset === "number" || typeof args.limit === "number") {
        return `${name} (L${args.offset ?? 1}${args.limit ? `–${(args.offset as number ?? 1) + (args.limit as number)}` : ""})`;
      }
      return name;
    }
    case "Write": {
      const fp = typeof args.file_path === "string" ? args.file_path : undefined;
      return fp ? fp.split("/").pop() || fp : summarizeToolInput(value);
    }
    case "Glob": {
      return typeof args.pattern === "string" ? args.pattern : summarizeToolInput(value);
    }
    case "Grep": {
      const pattern = typeof args.pattern === "string" ? args.pattern : undefined;
      if (!pattern) return summarizeToolInput(value);
      const path = typeof args.path === "string" ? args.path.split("/").pop() : undefined;
      return path ? `${pattern} in ${path}` : pattern;
    }
    case "Agent": {
      if (typeof args.description === "string" && args.description.trim()) {
        return summarizeString(args.description.trim(), 96);
      }
      return summarizeToolInput(value);
    }
    case "WebFetch": {
      if (typeof args.url === "string") {
        try { return new URL(args.url).hostname; } catch { /* ignore */ }
        return summarizeString(args.url, 96);
      }
      return summarizeToolInput(value);
    }
    case "WebSearch": {
      return typeof args.query === "string" ? summarizeString(args.query, 96) : summarizeToolInput(value);
    }
    case "NotebookEdit": {
      const fp = typeof args.notebook_path === "string" ? args.notebook_path : undefined;
      return fp ? fp.split("/").pop() || fp : summarizeToolInput(value);
    }
    case "TodoWrite": {
      return "Task list update";
    }
    case "EnterPlanMode": {
      return "Planning mode";
    }
    case "ExitPlanMode": {
      return "Plan approval";
    }
    case "EnterWorktree": {
      const name = typeof args.name === "string" ? args.name : undefined;
      return name ? `Worktree: ${name}` : "Create worktree";
    }
    case "AskUserQuestion": {
      return "Asking question";
    }
    case "Skill": {
      return typeof args.skill === "string" ? args.skill : summarizeToolInput(value);
    }
    case "delegateToSubagent": {
      const action = typeof args.action === "string" ? args.action : undefined;
      const agentName = typeof args.agentName === "string" ? args.agentName : undefined;
      const task = typeof args.task === "string" ? args.task : undefined;
      const parts: string[] = [];
      if (action) parts.push(action);
      if (agentName) parts.push(`→ ${agentName}`);
      if (task) parts.push(summarizeString(task, 60));
      return parts.length > 0 ? parts.join(" ") : summarizeToolInput(value);
    }
    default:
      return summarizeToolInput(value);
  }
}

export function summarizeToolInput(value: unknown): string | undefined {
  return summarizeToolValue(value, 96);
}

function summarizeToolOutput(value: unknown): string | undefined {
  return summarizeToolValue(value, 120);
}

/**
 * Tool-aware output summarization. Produces a clean, contextual summary
 * for known tool result shapes instead of generic value inspection.
 */
export function summarizeToolOutputByName(toolName: string, value: unknown): string | undefined {
  if (!value || typeof value !== "object") return summarizeToolOutput(value);

  const record = value as Record<string, unknown>;
  const MAX = 140;

  // Don't emit success copy for failed tool results
  const status = typeof record.status === "string" ? record.status.toLowerCase() : "";
  if (
    record.isError === true ||
    status === "error" ||
    status === "failed" ||
    status === "denied" ||
    typeof record.error === "string" ||
    typeof record.errorText === "string"
  ) {
    return summarizeToolOutput(value);
  }

  switch (toolName) {
    case "Read":
    case "readFile": {
      const fp = typeof record.filePath === "string" ? record.filePath
        : typeof record.file_path === "string" ? (record.file_path as string)
        : undefined;
      const fileName = fp ? (fp.split("/").pop() || fp) : undefined;
      const lines = typeof record.totalLines === "number" ? record.totalLines : undefined;
      const lang = typeof record.language === "string" ? record.language : undefined;
      const parts: string[] = [];
      if (fileName) parts.push(fileName);
      if (lang) parts.push(lang);
      if (lines) parts.push(`${lines} lines`);
      if (record.truncated) parts.push("truncated");
      return parts.length > 0 ? parts.join(", ") : summarizeToolOutput(value);
    }
    case "Edit":
    case "editFile": {
      const fp = typeof record.filePath === "string" ? record.filePath
        : typeof record.file_path === "string" ? (record.file_path as string)
        : undefined;
      const fileName = fp ? (fp.split("/").pop() || fp) : undefined;
      if (fileName) {
        const changed = typeof record.linesChanged === "number" ? record.linesChanged
          : typeof record.lines_changed === "number" ? (record.lines_changed as number)
          : undefined;
        const changedSuffix = changed !== undefined ? `, ${changed} lines changed` : "";
        return `${fileName}${changedSuffix}`;
      }
      return summarizeToolOutput(value);
    }
    case "Write":
    case "writeFile": {
      const fp = typeof record.filePath === "string" ? record.filePath
        : typeof record.file_path === "string" ? (record.file_path as string)
        : undefined;
      return fp ? (fp.split("/").pop() || fp) : summarizeToolOutput(value);
    }
    case "Grep":
    case "localGrep": {
      const count = typeof record.matchCount === "number" ? record.matchCount
        : typeof record.match_count === "number" ? (record.match_count as number)
        : undefined;
      const total = typeof record.totalMatchCount === "number" ? record.totalMatchCount
        : typeof record.total_match_count === "number" ? (record.total_match_count as number)
        : undefined;
      const pattern = typeof record.pattern === "string" ? record.pattern : undefined;
      if (count !== undefined && pattern) {
        const countText = total && total > count ? `${count} of ${total}` : `${count}`;
        return summarizeString(`${countText} matches for "${pattern}"`, MAX);
      }
      return summarizeToolOutput(value);
    }
    case "Glob": {
      const matches = Array.isArray(record.matches) ? record.matches
        : Array.isArray(record.result) ? record.result
        : undefined;
      if (matches) return `${matches.length} file${matches.length === 1 ? "" : "s"} matched`;
      return summarizeToolOutput(value);
    }
    case "WebSearch":
    case "webSearch": {
      if (typeof record.answer === "string" && record.answer.trim()) return summarizeString(record.answer.trim(), MAX);
      const sources = Array.isArray(record.sources) ? record.sources : [];
      if (sources.length > 0) return `${sources.length} source${sources.length === 1 ? "" : "s"} found`;
      return summarizeToolOutput(value);
    }
    case "Bash":
    case "executeCommand": {
      if (typeof record.stdout === "string" && record.stdout.trim()) {
        return summarizeString(record.stdout.trim(), MAX);
      }
      if (typeof record.stderr === "string" && record.stderr.trim()) {
        return summarizeString(record.stderr.trim(), MAX);
      }
      const exit = typeof record.exitCode === "number" ? record.exitCode
        : typeof record.exit_code === "number" ? (record.exit_code as number)
        : null;
      if (exit !== null) return exit === 0 ? "Completed successfully" : `Exit code ${exit}`;
      return summarizeToolOutput(value);
    }
    case "Agent": {
      if (typeof record.description === "string" && record.description.trim()) {
        return summarizeString(record.description.trim(), MAX);
      }
      return summarizeToolOutput(value);
    }
    case "NotebookEdit": {
      const fp = typeof record.notebook_path === "string" ? record.notebook_path
        : typeof record.notebookPath === "string" ? (record.notebookPath as string)
        : undefined;
      return fp ? (fp.split("/").pop() || fp) : summarizeToolOutput(value);
    }
    case "searchTools": {
      const results = Array.isArray(record.results) ? record.results : [];
      if (results.length > 0) {
        const names = results
          .map((r) => typeof r === "object" && r ? ((r as Record<string, unknown>).displayName || (r as Record<string, unknown>).name) : undefined)
          .filter(Boolean)
          .slice(0, 3);
        return names.length > 0
          ? summarizeString(`${results.length} found: ${names.join(", ")}`, MAX)
          : `${results.length} tool${results.length === 1 ? "" : "s"} found`;
      }
      return summarizeToolOutput(value);
    }
    case "memorize":
      return typeof record.message === "string" ? summarizeString(record.message, MAX) : "Memory saved";
    case "scheduleTask":
      return typeof record.message === "string" ? summarizeString(record.message, MAX) : "Task scheduled";
    case "updatePlan":
      return "Plan updated";
    case "workspace": {
      const msg = typeof record.message === "string" ? record.message : undefined;
      return msg ? summarizeString(msg, MAX) : summarizeToolOutput(value);
    }
    case "describeImage":
      return typeof record.description === "string" ? summarizeString(record.description, MAX) : summarizeToolOutput(value);
    case "chromiumWorkspace": {
      const action = typeof record.action === "string" ? record.action : undefined;
      const title = typeof record.title === "string" ? record.title : undefined;
      if (action && title) return `${action}: ${summarizeString(title, MAX - action.length - 2)}`;
      if (action) return action;
      return summarizeToolOutput(value);
    }
    case "delegateToSubagent": {
      const agentName = typeof record.agentName === "string" ? record.agentName
        : typeof record.delegateAgent === "string" ? record.delegateAgent
        : undefined;
      const completed = record.completed === true;
      const allResponses = Array.isArray(record.allResponses) ? record.allResponses : [];

      // Extract the most meaningful content from the delegation result
      let content = "";
      if (allResponses.length > 0) {
        const last = allResponses[allResponses.length - 1];
        content = typeof last === "string" ? last
          : typeof last === "object" && last
            ? (typeof (last as Record<string, unknown>).content === "string"
                ? (last as Record<string, unknown>).content as string
                : typeof (last as Record<string, unknown>).text === "string"
                  ? (last as Record<string, unknown>).text as string
                  : "")
            : "";
      }

      const parts: string[] = [];
      if (agentName) parts.push(agentName);
      if (completed) parts.push("completed");
      if (content) {
        const used = parts.join(", ").length;
        parts.push(summarizeString(content, Math.max(40, MAX - used - 4)));
      }
      return parts.length > 0 ? parts.join(", ") : summarizeToolOutput(value);
    }
    default:
      return summarizeToolOutput(value);
  }
}

/**
 * Extract raw text from an Agent tool result (handles MCP content arrays,
 * normalized wrappers, plain strings, etc.).
 */
function extractAgentResultText(result: unknown): string | undefined {
  if (!result) return undefined;
  if (typeof result === "string") return result;
  if (typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.content)) {
    const item = r.content.find(
      (c: unknown) => !!c && typeof c === "object" && (c as { type?: unknown }).type === "text"
    ) as { text?: string } | undefined;
    if (typeof item?.text === "string") return item.text;
  }
  if (typeof r.content === "string") return r.content;
  if (typeof r.text === "string") return r.text;
  return undefined;
}

/**
 * Parse an Agent tool result into discrete execution steps.
 * Looks for numbered lists ("1. ..."), then bullet lists ("- ..."),
 * then falls back to significant paragraphs.
 */
export function parseAgentSteps(result: unknown): { steps: string[]; count: number } {
  const text = extractAgentResultText(result);
  if (!text || text.length < 10) return { steps: [], count: 0 };

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  // Numbered list: "1. ...", "2. ..." etc.
  const numbered = lines
    .filter((l) => /^\d+\.\s/.test(l))
    .map((l) => l.replace(/^\d+\.\s+/, "").slice(0, 120));
  if (numbered.length >= 2) return { steps: numbered.slice(0, 12), count: numbered.length };

  // Bullet list: "- ", "• ", "* "
  const bullets = lines
    .filter((l) => /^[-•*]\s/.test(l))
    .map((l) => l.replace(/^[-•*]\s+/, "").slice(0, 120));
  if (bullets.length >= 2) return { steps: bullets.slice(0, 12), count: bullets.length };

  // Fallback: meaningful paragraphs (first line of each, 30+ chars)
  const paragraphs = text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 30)
    .map((p) => p.split("\n")[0].slice(0, 120));
  if (paragraphs.length >= 2) return { steps: paragraphs.slice(0, 8), count: paragraphs.length };

  return { steps: [], count: 0 };
}

function asProgressToolPart(part: unknown): ProgressToolPartLike | null {
  if (!part || typeof part !== "object") return null;
  return part as ProgressToolPartLike;
}

function getLatestToolPart(event: TaskProgressEvent): ProgressToolPartLike | null {
  const parts = Array.isArray(event.progressContent) ? event.progressContent : [];
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = asProgressToolPart(parts[index]);
    if (part?.type === "tool-result" || part?.type === "tool-call") {
      return part;
    }
  }
  return null;
}

function getToolScopedProgressDetail(event: TaskProgressEvent, toolName: string): string | undefined {
  const progressLabel = typeof event.progressText === "string" ? event.progressText.trim() : "";
  if (!progressLabel) return undefined;

  const lower = progressLabel.toLowerCase();
  const canonicalToolName = getCanonicalToolName(toolName).toLowerCase();
  const rawToolName = toolName.toLowerCase();

  // Ignore generic assistant prose snapshots; they often represent the final
  // response body rather than the active tool state.
  if (
    lower.startsWith("running ") ||
    lower.startsWith("preparing ") ||
    lower.includes(rawToolName) ||
    lower.includes(canonicalToolName)
  ) {
    return progressLabel;
  }

  return undefined;
}

function buildLiveStatusFromProgress(event: TaskProgressEvent): LiveToolStatus | null {
  const part = getLatestToolPart(event);
  if (!part?.toolName || typeof part.toolName !== "string") return null;

  const canonicalToolName = getCanonicalToolName(part.toolName);
  const scopedDetail = getToolScopedProgressDetail(event, part.toolName);

  if (part.type === "tool-result") {
    const rawStatus = typeof part.status === "string" ? part.status.toLowerCase() : "";
    const resultRecord = part.result && typeof part.result === "object"
      ? (part.result as Record<string, unknown>)
      : undefined;
    const isError =
      rawStatus === "error" ||
      rawStatus === "failed" ||
      rawStatus === "denied" ||
      typeof part.errorText === "string" ||
      typeof resultRecord?.error === "string";

    // For Agent: parse steps from the result text
    let steps: string[] | undefined;
    let stepCount: number | undefined;
    if (canonicalToolName === "Agent" && !isError) {
      const parsed = parseAgentSteps(part.result ?? part.output);
      if (parsed.count > 0) {
        steps = parsed.steps;
        stepCount = parsed.count;
      }
    }

    return {
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      canonicalToolName,
      phase: isError ? "error" : "completed",
      label: isError ? "Failed" : "Completed",
      detail: typeof part.errorText === "string" ? summarizeString(part.errorText, 120) : scopedDetail,
      outputPreview: summarizeToolOutputByName(canonicalToolName, part.result ?? part.output),
      updatedAt: Date.now(),
      steps,
      stepCount,
    };
  }

  const rawState = typeof part.state === "string" ? part.state : "";
  const phase: LiveToolPhase = rawState === "input-streaming" || rawState === "input-available"
    ? "preparing"
    : "running";
  const inputPreviewValue = part.input ?? part.args ?? part.argsText;
  const isTruncatedPreview = isProgressTruncatedMarker(inputPreviewValue);

  return {
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    canonicalToolName,
    phase,
    label: phase === "preparing" ? "Preparing" : "Running",
    detail: scopedDetail,
    argsPreview: isTruncatedPreview ? undefined : summarizeToolInput(inputPreviewValue),
    updatedAt: Date.now(),
  };
}

export function getFallbackToolPhase(result: unknown, isRunning: boolean): LiveToolPhase {
  if (isRunning) return "running";
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : undefined;
  const status = typeof record?.status === "string" ? record.status.toLowerCase() : undefined;
  if (status === "error" || status === "failed" || status === "denied" || typeof record?.error === "string") {
    return "error";
  }
  return "completed";
}

// ---------------------------------------------------------------------------
// Shared live-status store
//
// A long thread mounts one AssistantMessage per turn and one ToolCallGroup per
// tool group. Each used to add its own window listener and build statuses
// itself, so every progress event ran hundreds of times and re-rendered every
// subscriber. One listener now feeds a per-session map, and each component
// subscribes only to the tool calls it shows.
// ---------------------------------------------------------------------------

type LiveStatusMap = Record<string, LiveToolStatus>;

interface LiveStatusSessionEntry {
  statuses: LiveStatusMap;
  listeners: Set<() => void>;
}

const liveStatusSessions = new Map<string, LiveStatusSessionEntry>();
let removeWindowProgressListener: (() => void) | null = null;

function sameSteps(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((step, i) => step === b[i]);
}

function mergeLiveStatus(existing: LiveToolStatus | undefined, status: LiveToolStatus): LiveToolStatus | null {
  // For Agent tool calls: carry startedAt across updates, compute elapsedMs on completion.
  let enriched = status;
  if (status.canonicalToolName === "Agent") {
    const now = Date.now();
    if (status.phase === "preparing" || status.phase === "running") {
      enriched = { ...status, startedAt: existing?.startedAt ?? now };
    } else {
      const startedAt = existing?.startedAt;
      enriched = {
        ...status,
        startedAt,
        elapsedMs: startedAt != null ? now - startedAt : undefined,
      };
    }
  }

  if (
    existing &&
    existing.phase === enriched.phase &&
    existing.label === enriched.label &&
    existing.detail === enriched.detail &&
    existing.argsPreview === enriched.argsPreview &&
    existing.outputPreview === enriched.outputPreview &&
    existing.elapsedMs === enriched.elapsedMs &&
    existing.stepCount === enriched.stepCount &&
    sameSteps(existing.steps, enriched.steps)
  ) {
    return null;
  }
  return enriched;
}

function handleWindowProgress(event: Event): void {
  const detail = (event as CustomEvent<TaskEvent>).detail;
  if (!detail || detail.eventType !== "task:progress" || !detail.sessionId) return;
  const entry = liveStatusSessions.get(detail.sessionId);
  if (!entry) return;

  const status = buildLiveStatusFromProgress(detail);
  if (!status || !status.toolCallId) return;
  if (detail.progressContentProjectionOnly && detail.progressContentLimited && status.phase !== "completed" && status.phase !== "error") {
    return;
  }

  const merged = mergeLiveStatus(entry.statuses[status.toolCallId], status);
  if (!merged) return;
  entry.statuses = { ...entry.statuses, [status.toolCallId]: merged };
  for (const listener of entry.listeners) listener();
}

function subscribeLiveStatuses(sessionId: string, listener: () => void): () => void {
  let entry = liveStatusSessions.get(sessionId);
  if (!entry) {
    entry = { statuses: {}, listeners: new Set() };
    liveStatusSessions.set(sessionId, entry);
  }
  entry.listeners.add(listener);

  if (!removeWindowProgressListener && typeof window !== "undefined") {
    window.addEventListener("background-task-progress", handleWindowProgress);
    removeWindowProgressListener = () =>
      window.removeEventListener("background-task-progress", handleWindowProgress);
  }

  return () => {
    const current = liveStatusSessions.get(sessionId);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      liveStatusSessions.delete(sessionId);
    }
    if (liveStatusSessions.size === 0 && removeWindowProgressListener) {
      removeWindowProgressListener();
      removeWindowProgressListener = null;
    }
  };
}

const EMPTY_LIVE_STATUSES: LiveStatusMap = {};

/**
 * Live statuses for `toolCallIds` in a session. The returned object keeps its
 * identity until one of those tool calls gets a new status, so unrelated
 * progress events do not re-render the caller.
 */
export function useLiveToolStatuses(
  sessionId: string | undefined,
  toolCallIds: readonly string[]
): LiveStatusMap {
  const selectionRef = useRef<LiveStatusMap>(EMPTY_LIVE_STATUSES);

  const subscribe = useCallback(
    (listener: () => void) => (sessionId ? subscribeLiveStatuses(sessionId, listener) : () => {}),
    [sessionId]
  );

  const getSnapshot = useCallback((): LiveStatusMap => {
    const statuses = sessionId ? liveStatusSessions.get(sessionId)?.statuses : undefined;
    const previous = selectionRef.current;
    if (!statuses) {
      selectionRef.current = EMPTY_LIVE_STATUSES;
      return EMPTY_LIVE_STATUSES;
    }

    let changed = false;
    let count = 0;
    const next: LiveStatusMap = {};
    for (const id of toolCallIds) {
      const status = statuses[id];
      if (!status) continue;
      next[id] = status;
      count++;
      if (previous[id] !== status) changed = true;
    }
    if (!changed && count === Object.keys(previous).length) return previous;

    selectionRef.current = count === 0 ? EMPTY_LIVE_STATUSES : next;
    return selectionRef.current;
  }, [sessionId, toolCallIds]);

  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_LIVE_STATUSES);
}
