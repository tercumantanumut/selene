import { limitToolOutput } from "./output-limiter";
import { getRunContext } from "@/lib/observability/run-context";
import { parseNestedJsonString } from "@/lib/utils/parse-nested-json";

type ToolResultNormalization = {
  output: Record<string, unknown>;
  summary: string;
  status: string;
  error?: string;
};

type ToolResultNormalizationMode = "canonical" | "projection";

interface NormalizeToolResultOptions {
  /**
   * `canonical`: for durable persistence in session history. Must be lossless.
   * `projection`: for model input / transport shaping. May apply truncation.
   */
  mode: ToolResultNormalizationMode;
}

const MAX_TOOL_SUMMARY_LENGTH = 280;

function truncateSummary(text: string, maxLength: number = MAX_TOOL_SUMMARY_LENGTH): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength - 3) + "...";
}

function getString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function extractTextFromMcpContentArray(items: unknown[]): string | undefined {
  const textParts = items
    .map((item) => getRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => String(item.text));
  if (textParts.length === 0) return undefined;
  const merged = textParts.join("\n").trim();
  return merged.length > 0 ? merged : undefined;
}

function unwrapMcpTextWrappedToolResult(output: unknown): unknown {
  const parseTextPayload = (text: string): unknown => {
    const parsed = parseNestedJsonString(text);
    return parsed === undefined ? text : parsed;
  };

  // Variant A: CallToolResult-like object { content: [{ type: "text", text: "..." }], isError? }
  const obj = getRecord(output);
  if (obj && Array.isArray(obj.content)) {
    const text = extractTextFromMcpContentArray(obj.content);
    if (!text) return output;

    const parsed = parseTextPayload(text);
    if (obj.isError === true) {
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const parsedObj = parsed as Record<string, unknown>;
        return {
          ...parsedObj,
          status: "error",
          ...(typeof parsedObj.error === "string" ? {} : { error: text }),
        };
      }
      return {
        status: "error",
        error: typeof parsed === "string" ? parsed : text,
      };
    }

    return parsed;
  }

  // Variant B: raw content array [{ type: "text", text: "..." }]
  if (Array.isArray(output)) {
    const text = extractTextFromMcpContentArray(output);
    if (!text) return output;
    return parseTextPayload(text);
  }

  return output;
}

const COMMAND_CONTEXT_OUTPUT_LIMIT = 2000;

function truncateField(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n... [TRUNCATED ${value.length - maxLength} CHARS] ...`;
}

function compactCommandOutput(output: unknown): unknown {
  const result = getRecord(output);
  if (!result) return output;

  const compact: Record<string, unknown> = {
    status: result.status ?? "success",
  };

  if (typeof result.exitCode === "number") compact.exitCode = result.exitCode;
  if (typeof result.executionTime === "number") compact.executionTime = result.executionTime;
  if (typeof result.logId === "string") compact.logId = result.logId;
  if (result.isTruncated === true) compact.isTruncated = true;
  if (typeof result.error === "string") compact.error = result.error;

  const stdout = truncateField(result.stdout, COMMAND_CONTEXT_OUTPUT_LIMIT);
  const stderr = truncateField(result.stderr, COMMAND_CONTEXT_OUTPUT_LIMIT);
  if (stdout) compact.stdout = stdout;
  if (stderr) compact.stderr = stderr;

  const summary = getString(result.summary) || getString(result.message);
  if (summary) compact.summary = truncateSummary(summary, 220);

  if (result.isTruncated === true && typeof result.logId === "string") {
    compact.truncated = true;
    compact.truncatedContentId = result.logId;
  }

  return compact;
}

function summarizeToolKeys(result: Record<string, unknown>): string {
  const keys = Object.keys(result)
    .filter((key) => !["content", "summary", "error", "status", "metadata"].includes(key))
    .sort()
    .slice(0, 4);
  if (keys.length === 0) return "";
  return ` keys=${keys.join(", ")}`;
}

function buildToolSummary(toolName: string, input?: unknown, output?: unknown): string {
  const safeName = toolName || "tool";

  if (output === null || output === undefined) {
    return `${safeName}: no output returned`;
  }

  if (typeof output !== "object" || Array.isArray(output)) {
    return `${safeName}: returned ${typeof output}`;
  }

  const result = output as Record<string, unknown>;
  const inputObj = getRecord(input);
  const status = getString(result.status);
  const isErrorStatus = status === "error" || status === "failed";
  const error = getString(result.error) || (isErrorStatus ? getString(result.message) : undefined);

  if (error) {
    const statusTag = status ? ` (${status})` : "";
    return `${safeName}${statusTag} failed: ${error}`;
  }

  switch (safeName) {
    case "readFile": {
      const filePath = getString(result.filePath) || getString(result.path) || "file";
      // Binary file soft-redirect: show a descriptive summary instead of "lines ?"
      if (result.isBinary === true) {
        return `${filePath}: binary file (use Read tool)`;
      }
      const lineRange = getString(result.lineRange) || "?";
      const totalLines = getNumber(result.totalLines);
      const truncated = Boolean(result.truncated);
      const totalText = totalLines ? ` of ${totalLines}` : "";
      const truncatedText = truncated ? " (truncated)" : "";
      return `Read ${filePath}: lines ${lineRange}${totalText}${truncatedText}`;
    }
    case "localGrep": {
      const pattern =
        getString(result.pattern) ||
        getString(inputObj?.pattern) ||
        getString(inputObj?.query) ||
        "pattern";
      const matchCount =
        getNumber(result.matchCount) ||
        (Array.isArray(result.matches) ? result.matches.length : undefined) ||
        0;
      const totalMatchCount = getNumber(result.totalMatchCount);
      const wasTruncated = Boolean(result.wasTruncated);
      const fileCount = Array.isArray(result.matches)
        ? new Set(result.matches.map((m) => getRecord(m)?.file).filter(Boolean)).size
        : undefined;
      const totalText =
        totalMatchCount && totalMatchCount !== matchCount
          ? ` (${totalMatchCount} total)`
          : "";
      const fileText = fileCount ? ` in ${fileCount} files` : "";
      const truncatedText = wasTruncated ? " (truncated)" : "";
      return `Grep "${pattern}": ${matchCount} matches${totalText}${fileText}${truncatedText}`;
    }
    case "vectorSearch": {
      const summary = getString(result.summary);
      if (summary) return summary;
      const findings = Array.isArray(result.findings) ? result.findings.length : 0;
      return `Vector search: ${findings} findings`;
    }
    case "webSearch": {
      const query = getString(result.query) || getString(inputObj?.query) || "query";
      const sources = Array.isArray(result.sources) ? result.sources.length : 0;
      const answer = getString(result.answer);
      const answerText = answer ? `; answer: ${truncateSummary(answer, 120)}` : "";
      return `Web search "${query}": ${sources} sources${answerText}`;
    }
    case "webBrowse": {
      const fetched =
        (Array.isArray(result.fetchedUrls) ? result.fetchedUrls.length : 0) ||
        (Array.isArray(result.sourcesUsed) ? result.sourcesUsed.length : 0);
      const synthesis = getString(result.synthesis);
      const synthesisText = synthesis ? `; synthesis: ${truncateSummary(synthesis, 120)}` : "";
      return `${safeName}: fetched ${fetched} URL${fetched === 1 ? "" : "s"}${synthesisText}`;
    }
    case "executeCommand": {
      const command = getString(inputObj?.command) || getString(result.command) || "command";
      const exitCode = getNumber(result.exitCode);
      const stdoutLen = getString(result.stdout)?.length || 0;
      const stderrLen = getString(result.stderr)?.length || 0;
      const statusTag = status ? ` ${status}` : "";
      const exitText = exitCode !== undefined ? ` (exit ${exitCode})` : "";
      return `Command "${command}":${statusTag}${exitText}, stdout ${stdoutLen} chars, stderr ${stderrLen} chars`;
    }
    case "bash": {
      const command = getString(inputObj?.command) || getString(result.command) || "command";
      const exitCode = getNumber(result.exitCode);
      const stdoutLen = getString(result.stdout)?.length || 0;
      const stderrLen = getString(result.stderr)?.length || 0;
      const statusTag = status ? ` ${status}` : "";
      const exitText = exitCode !== undefined ? ` (exit ${exitCode})` : "";
      return `Bash "${command}":${statusTag}${exitText}, stdout ${stdoutLen} chars, stderr ${stderrLen} chars`;
    }
    case "searchTools": {
      const query = getString(result.query) || getString(inputObj?.query) || "query";
      const results = Array.isArray(result.results) ? result.results.length : 0;
      return `Tool search "${query}": ${results} result${results === 1 ? "" : "s"}`;
    }
    case "retrieveFullContent": {
      const contentId = getString(result.contentId) || getString(inputObj?.contentId);
      return contentId ? `Retrieved full content (${contentId})` : "Retrieved full content";
    }
    case "delegateToSubagent": {
      const action = getString(inputObj?.action) || "delegate";
      const agentName = getString(result.agentName) || getString(result.delegateAgent) || getString(inputObj?.agentName);
      const delegationId = getString(result.delegationId);
      const completed = result.completed === true;
      const statusTag = completed ? "completed" : status || "in-progress";

      // Extract actual sub-agent response content.
      // Prefer `lastResponse` (the terminal assistant message) over `allResponses`
      // (which only contains truncated previews of prior turns, not the final one).
      const lastResponseField = getString(result.lastResponse);
      const allResponses = Array.isArray(result.allResponses) ? result.allResponses : [];
      let responseExcerpt = "";
      const excerptSource = lastResponseField ?? (allResponses.length > 0 ? allResponses[allResponses.length - 1] : undefined);
      if (excerptSource) {
        const lastResponse = excerptSource;
        let text: string | undefined;
        if (typeof lastResponse === "string") {
          text = lastResponse;
        } else if (typeof lastResponse === "object" && lastResponse) {
          const rec = lastResponse as Record<string, unknown>;
          text = getString(rec.content) || getString(rec.text);
          if (!text) {
            try { text = JSON.stringify(lastResponse).slice(0, 300); } catch { /* circular ref */ }
          }
        } else {
          text = String(lastResponse);
        }
        if (text) {
          responseExcerpt = text.length > 200 ? text.slice(0, 200) + "…" : text;
        }
      }

      const parts: string[] = [`Delegation ${action}`];
      if (agentName) parts.push(`to ${agentName}`);
      if (delegationId) parts.push(`(${delegationId})`);
      parts.push(`[${statusTag}]`);
      if (responseExcerpt) parts.push(`— ${responseExcerpt}`);
      return parts.join(" ");
    }
    default: {
      const statusTag = status ? ` (${status})` : "";
      const keys = summarizeToolKeys(result);
      return `${safeName}${statusTag}:${keys || " completed"}`;
    }
  }
}

const PROJECTION_TRUNCATION_SENTINEL = "OUTPUT TRUNCATED TO PREVENT CONTEXT OVERFLOW";

function hasProjectionTruncationMarker(value: unknown): boolean {
  if (typeof value === "string") {
    return value.includes(PROJECTION_TRUNCATION_SENTINEL);
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const obj = value as Record<string, unknown>;

  if (typeof obj.truncatedContentId === "string" && obj.truncatedContentId.startsWith("trunc_")) {
    return true;
  }

  if (obj.content && hasProjectionTruncationMarker(obj.content)) return true;
  if (obj.text && hasProjectionTruncationMarker(obj.text)) return true;
  if (obj.stdout && hasProjectionTruncationMarker(obj.stdout)) return true;
  if (obj.output && hasProjectionTruncationMarker(obj.output)) return true;
  if (obj.results && hasProjectionTruncationMarker(obj.results)) return true;
  if (obj.summary && hasProjectionTruncationMarker(obj.summary)) return true;
  if (obj.markdown && hasProjectionTruncationMarker(obj.markdown)) return true;
  return false;
}

function getToolSummaryFromOutput(toolName: string, output?: unknown, input?: unknown): string {
  const resultObj = getRecord(output);
  const summary = getString(resultObj?.summary);
  if (summary) {
    return truncateSummary(summary);
  }
  return truncateSummary(buildToolSummary(toolName, input, output));
}

export function normalizeToolResultOutput(
  toolName: string,
  output: unknown,
  input: unknown = undefined,
  options: NormalizeToolResultOptions
): ToolResultNormalization {
  // Canonical history must remain lossless. Projection is allowed to compact/limit.
  const mode = options.mode;
  let normalizedOutput = unwrapMcpTextWrappedToolResult(output);
  if (mode === "projection" && (toolName === "executeCommand" || toolName === "bash")) {
    normalizedOutput = compactCommandOutput(normalizedOutput);
  }

  // Get session ID from run context for content storage
  const sessionId = getRunContext()?.sessionId;

  if (mode === "projection") {
    // Exempt tools that intentionally return bounded content payloads.
    // readFile has built-in limits; skill and webSearch browse mode may return
    // richer content that should not be utility-truncated here.
    // retrieveFullContent self-limits to PER_CALL_TOKEN_BUDGET (8K) via log-slice.ts.
    const EXEMPT_TOOLS = new Set(["readFile", "skill", "webSearch", "retrieveFullContent"]);

    // Per-tool token budgets for tools that need more context than the default 3,000.
    // localGrep and vectorSearch results are dense, useful content — 10,000 tokens
    // (~40,000 chars) accommodates ~25 matches with context lines.
    const TOOL_TOKEN_BUDGETS: Record<string, number> = {
      localGrep: 10000,
      vectorSearch: 10000,
    };

    // Apply token limit (universal safety net) — UNLESS tool is exempt
    // This prevents context bloat from massive outputs like ls -R, pip freeze, etc.
    const limitResult = !EXEMPT_TOOLS.has(toolName)
      ? limitToolOutput(normalizedOutput, toolName, sessionId, {
          maxTokens: TOOL_TOKEN_BUDGETS[toolName],
        })
      : { limited: false, output: "", originalLength: 0, truncatedLength: 0, estimatedTokens: 0 };

    // If limited, update output with truncated version
    if (limitResult.limited) {
      console.debug(
        `[ToolResult] Limited ${toolName} output: ` +
          `${limitResult.originalLength} → ${limitResult.truncatedLength} chars ` +
          `(~${limitResult.estimatedTokens} tokens)`
      );

      // Handle string output
      if (typeof normalizedOutput === "string") {
        normalizedOutput = limitResult.output;
      }
      // Handle object output with text fields
      else if (normalizedOutput && typeof normalizedOutput === "object") {
        const obj = normalizedOutput as Record<string, unknown>;

        // Update the primary text field
        if (typeof obj.content === "string") {
          obj.content = limitResult.output;
        } else if (typeof obj.text === "string") {
          obj.text = limitResult.output;
        } else if (typeof obj.result === "string") {
          obj.result = limitResult.output;
        } else if (typeof obj.results === "string") {
          obj.results = limitResult.output;
        } else if (typeof obj.output === "string") {
          obj.output = limitResult.output;
        } else if (typeof obj.summary === "string") {
          obj.summary = limitResult.output;
        } else if (typeof obj.markdown === "string") {
          obj.markdown = limitResult.output;
        } else if (typeof obj.stdout === "string") {
          obj.stdout = limitResult.output;
        }

        // Mark as truncated
        obj.truncated = true;
        if (limitResult.contentId) {
          obj.truncatedContentId = limitResult.contentId;
        }
      }
    }
  } else if (hasProjectionTruncationMarker(normalizedOutput)) {
    // Guardrail: canonical writes should not receive projection-truncated payloads.
    console.warn(
      `[ToolResult] Canonical normalization for ${toolName} received projected truncation markers. ` +
      `This indicates projection data leaking into canonical history.`
    );
  }

  // Continue with existing normalization logic
  if (normalizedOutput === null || normalizedOutput === undefined) {
    const error = "Tool returned no output.";
    const summary = truncateSummary(buildToolSummary(toolName, input, { status: "error", error }));
    return {
      output: { status: "error", error, summary },
      summary,
      status: "error",
      error,
    };
  }

  if (typeof normalizedOutput !== "object" || Array.isArray(normalizedOutput)) {
    const summary = truncateSummary(buildToolSummary(toolName, input, normalizedOutput));
    return {
      output: { status: "success", content: normalizedOutput, summary },
      summary,
      status: "success",
    };
  }

  const result = { ...(normalizedOutput as Record<string, unknown>) };
  const error = getString(result.error);
  let summary = getString(result.summary);
  if (!summary) {
    summary = truncateSummary(buildToolSummary(toolName, input, result));
    result.summary = summary;
  }
  if (!("content" in result) && !("summary" in result) && !("error" in result)) {
    result.summary = summary;
  }
  if (!("status" in result)) {
    result.status = error ? "error" : "success";
  }

  return {
    output: result,
    summary,
    status: String(result.status ?? (error ? "error" : "success")),
    error,
  };
}

export function isMissingToolResult(output: unknown): boolean {
  return output === null || output === undefined;
}

/**
 * Normalize legacy tool results to structured format.
 * 
 * Handles migration from old text-based [SYSTEM: ...] markers to structured tool-result parts.
 * If the result is a string (legacy format), wraps it in a structured object.
 * If already structured, returns as-is.
 * 
 * @param result - The tool result from database (could be string or object)
 * @returns Structured tool result object
 */
function normalizeLegacyToolResult(result: unknown): Record<string, unknown> {
  // If null/undefined, return empty error result
  if (result === null || result === undefined) {
    return { status: "error", error: "No result available" };
  }

  // If already an object, return as-is (already structured)
  if (typeof result === "object" && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }

  // If string, wrap in structured format (legacy text result)
  if (typeof result === "string") {
    // Check if it looks like a [SYSTEM: ...] marker and extract the actual content
    // Note: Using [\s\S] instead of . with 's' flag for ES2015 compatibility
    const systemMarkerMatch = result.match(/\[SYSTEM: Tool [^\]]+\]\s*([\s\S]+)/);
    const content = systemMarkerMatch ? systemMarkerMatch[1] : result;
    
    return {
      status: "success",
      text: content,
      summary: content.slice(0, 100) + (content.length > 100 ? "..." : ""),
    };
  }

  // For arrays or other types, wrap in content field
  return {
    status: "success",
    content: result,
  };
}
