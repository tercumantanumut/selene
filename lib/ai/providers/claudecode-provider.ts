// fallow-ignore-file circular-dependency
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { query as claudeAgentQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentDefinition,
  HookCallback,
  HookEvent,
  HookCallbackMatcher,
  SdkPluginConfig,
  SDKUserMessage,
  OutputFormat,
  ThinkingConfig,
} from "@anthropic-ai/claude-agent-sdk";
import type { LanguageModel } from "ai";
import {
  classifyRecoverability,
  getBackoffDelayMs,
  shouldRetry,
  sleepWithAbort,
} from "@/lib/ai/retry/stream-recovery";
import { readClaudeAgentSdkAuthStatus, getSdkExecutableConfig } from "@/lib/auth/claude-agent-sdk-auth";
import { getCliPath } from "@/lib/auth/claude-login-process";
import {
  mcpContextStore,
  type SeleneMcpContext,
} from "./mcp-context-store";
import { createSeleneSdkMcpServer } from "./selene-sdk-mcp-server";
import { buildSdkHooksFromSelene, mergeHooks } from "@/lib/plugins/sdk-hook-adapter";
import {
  registerInteractiveWait,
  storeUserAnswer,
  popUserAnswer,
  type InteractiveWaitResult,
} from "@/lib/interactive-tool-bridge";
import {
  drainLivePromptQueue,
  hasLivePromptQueue,
  type LivePromptEntry,
  waitForQueueMessage,
} from "@/lib/background-tasks/live-prompt-queue-registry";
import {
  buildStopSystemMessage,
  buildUserInjectionContent,
} from "@/lib/background-tasks/live-prompt-helpers";

const CLAUDECODE_MAX_RETRY_ATTEMPTS = 5;
const DEFAULT_MODEL = "claude-sonnet-4-6";
const CLAUDECODE_INPUT_DELTA_BATCH_ENABLED =
  process.env.CLAUDECODE_INPUT_DELTA_BATCH_ENABLED !== "false";
const CLAUDECODE_INPUT_DELTA_BATCH_MAX_CHARS = (() => {
  const parsed = Number(process.env.CLAUDECODE_INPUT_DELTA_BATCH_MAX_CHARS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 8_192;
})();
const CLAUDECODE_INPUT_DELTA_BATCH_INTERVAL_MS = (() => {
  const parsed = Number(process.env.CLAUDECODE_INPUT_DELTA_BATCH_INTERVAL_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 40;
})();

/** Anthropic Messages API usage shape (snake_case wire format). */
type AnthropicTokenUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

/** Shape of a "result" message from the Claude Agent SDK query iterator. */
type ClaudeAgentResultMessage = {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  errors?: string[];
  usage?: AnthropicTokenUsage;
};

type ClaudeAgentQueryStreamMessage = {
  type?: string;
  [key: string]: unknown;
};

type ClaudeAgentQueryStream = AsyncGenerator<ClaudeAgentQueryStreamMessage, void> & {
  streamInput?: (stream: AsyncIterable<SDKUserMessage>) => Promise<void>;
};

/**
 * SDK-native options that extend a basic Claude Agent SDK query.
 * These are forwarded directly to the SDK's query() call, enabling full
 * SDK capabilities: multi-agent delegation, lifecycle hooks, plugin loading,
 * session continuation, structured output, and thinking controls.
 *
 * Use these when you need capabilities beyond the basic prompt→text path
 * provided by the fetch interceptor (e.g. background tasks, direct SDK calls).
 */
export type ClaudeAgentSdkQueryOptions = {
  /**
   * Custom subagent definitions for SDK-native Task tool delegation.
   * Keys are agent names; values define the subagent's prompt, tools, and model.
   */
  agents?: Record<string, AgentDefinition>;
  /**
   * Tool names auto-allowed without permission prompts.
   * Does not restrict; use `disallowedTools` to remove tools entirely.
   */
  allowedTools?: string[];
  /**
   * Tool names to explicitly disallow. These are removed from the model's
   * context and cannot be used even if otherwise allowed.
   */
  disallowedTools?: string[];
  /**
   * Lifecycle hook callbacks (PreToolUse, PostToolUse, Notification, etc.).
   * Enables programmatic observability and control over tool execution.
   */
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /**
   * Local plugins to load for this session.
   * Plugins provide custom commands, agents, skills, and hooks.
   * Currently only `{ type: 'local', path: string }` is supported.
   */
  plugins?: SdkPluginConfig[];
  /**
   * Resume a prior session by its session ID.
   * Loads conversation history so the agent can continue where it left off.
   */
  resume?: string;
  /**
   * Pin a specific session ID for this query (must be a valid UUID).
   * Mutually exclusive with `resume` unless `forkSession` is used.
   */
  sessionId?: string;
  /**
   * Structured output format.
   * When set, the agent returns data matching the provided JSON schema.
   */
  outputFormat?: OutputFormat;
  /**
   * Extended thinking / reasoning configuration.
   * - `{ type: 'adaptive' }` — Claude decides when and how much to think (Opus 4.6+)
   * - `{ type: 'enabled', budgetTokens: number }` — fixed token budget
   * - `{ type: 'disabled' }` — no extended thinking
   */
  thinking?: ThinkingConfig;
  /**
   * Response effort level (guides thinking depth).
   * - 'low' — fastest, minimal thinking
   * - 'medium' — moderate
   * - 'high' — deep reasoning (default)
   * - 'max' — maximum (Opus 4.6 only)
   */
  effort?: "low" | "medium" | "high" | "max";
  /**
   * Whether to persist the session to ~/.claude/projects/.
   * Set to `false` for ephemeral or automated workflows that don't need history.
   * @default true
   */
  persistSession?: boolean;
  /**
   * Maximum number of conversation turns before stopping.
   * Defaults to 1000 to allow arbitrarily long agentic work.
   * @default 1000
   */
  maxTurns?: number;
  /**
   * Override the permission mode for this specific query.
   * Defaults to "bypassPermissions" (server context has no interactive TTY).
   * Use "acceptEdits" for slightly stricter control (auto-accepts file edits,
   * still gates on arbitrary bash commands).
   */
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";
  /**
   * Working directory for the SDK agent session.
   * Defaults to the agent's primary sync folder (resolved from DB) or `process.cwd()`.
   */
  cwd?: string;
  /**
   * Per-request Selene platform context used to build an in-process MCP server
   * that exposes ToolRegistry tools and per-agent MCP tools to the SDK agent.
   *
   * When provided here (for `queryWithSdkOptions` callers) or propagated via
   * `mcpContextStore` (for the fetch-interceptor / chat-route path), the SDK
   * agent can call vectorSearch, memorize, skill, scheduleTask, and any
   * MCP server tools configured for the active agent.
   */
  mcpContext?: SeleneMcpContext;
};

function sanitizeLoneSurrogates(input: string): { value: string; changed: boolean } {
  let changed = false;
  let output = "";

  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);

    // Preserve valid surrogate pairs and replace malformed lone surrogates.
    if (code >= 0xd800 && code <= 0xdbff) {
      const nextCode = i + 1 < input.length ? input.charCodeAt(i + 1) : 0;
      if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
        output += input[i] + input[i + 1];
        i += 1;
      } else {
        output += "\ufffd";
        changed = true;
      }
      continue;
    }

    if (code >= 0xdc00 && code <= 0xdfff) {
      output += "\ufffd";
      changed = true;
      continue;
    }

    output += input[i];
  }

  return { value: output, changed };
}

export function sanitizeJsonStringValues(value: unknown): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    return sanitizeLoneSurrogates(value);
  }

  if (Array.isArray(value)) {
    let changed = false;
    const sanitizedArray = value.map((entry) => {
      const result = sanitizeJsonStringValues(entry);
      changed = changed || result.changed;
      return result.value;
    });
    return { value: sanitizedArray, changed };
  }

  if (value && typeof value === "object") {
    let changed = false;
    const sanitizedObject: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const result = sanitizeJsonStringValues(entry);
      changed = changed || result.changed;
      sanitizedObject[key] = result.value;
    }
    return { value: sanitizedObject, changed };
  }

  return { value, changed: false };
}

function isDictionary(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getClaudeSdkParentToolUseId(msg: unknown): string | undefined {
  if (!isDictionary(msg)) return undefined;
  return typeof msg.parent_tool_use_id === "string" && msg.parent_tool_use_id.trim().length > 0
    ? msg.parent_tool_use_id
    : undefined;
}

export function normalizeClaudeSdkToolName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  // Strip the Selene MCP server prefix added by the Claude Agent SDK.
  // e.g. "mcp__selene-platform__calculator" → "calculator"
  // Only strip our own server prefix to avoid cross-server name collisions
  // (another MCP server could expose a tool with the same leaf name).
  // Don't return early — the extracted candidate still needs cleanup below
  // in case the SDK payload is malformed (e.g. trailing attribute fragments).
  const mcpPrefixMatch = /^mcp__selene-platform__(.+)$/.exec(trimmed);
  const afterPrefix = mcpPrefixMatch?.[1] ?? trimmed;

  // Some malformed SDK payloads include name="Tool" style fragments.
  const nameAttrMatch = /(?:^|[\s<])name\s*=\s*["']?([A-Za-z0-9_.:-]+)/i.exec(afterPrefix);
  if (nameAttrMatch?.[1]) {
    return nameAttrMatch[1];
  }

  const firstToken = afterPrefix.split(/\s+/)[0] ?? "";
  if (!firstToken) return undefined;

  const unwrapped = firstToken
    .replace(/^["'`<]+/, "")
    .replace(/[>"'`,;]+$/g, "");

  if (!unwrapped) return undefined;

  // Handle dangling-quote corruption like: Task" subagent_type="Explore
  const quoteIndex = unwrapped.search(/["']/);
  const candidate = (quoteIndex >= 0 ? unwrapped.slice(0, quoteIndex) : unwrapped).trim();
  return candidate || undefined;
}

function readPlanModeFile(cwd: string): string {
  // Claude Code SDK writes plans to ~/.claude/plans/<name>.md.
  // Check both home dir and cwd; pick the most recently modified file.
  const dirs = [
    join(homedir(), ".claude", "plans"),
    join(cwd, ".claude", "plans"),
  ];
  let bestPath = "";
  let bestMtime = 0;
  for (const dir of dirs) {
    try {
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith(".md")) continue;
        const full = join(dir, entry);
        try {
          const mt = statSync(full).mtimeMs;
          if (mt > bestMtime) {
            bestMtime = mt;
            bestPath = full;
          }
        } catch { /* skip unreadable */ }
      }
    } catch { /* dir doesn't exist */ }
  }
  if (bestPath) {
    try {
      return readFileSync(bestPath, "utf8").trim();
    } catch { /* fall through */ }
  }
  // Legacy fallback: .claude/plan (singular)
  try {
    return readFileSync(join(cwd, ".claude", "plan"), "utf8").trim();
  } catch {
    return "";
  }
}

function buildPlanApprovalPrompt(plan: string): Record<string, unknown> {
  return {
    type: "plan_approval",
    toolName: "ExitPlanMode",
    question: "Review the plan and choose how to continue.",
    plan,
    options: [
      {
        label: "Approve & Continue",
        description: "Approve this plan and let the agent start implementing.",
      },
      {
        label: "Reject / Edit",
        description: "Send feedback and keep the agent in planning mode.",
      },
    ],
  };
}

export function buildPlanApprovalResult(
  waitResult: InteractiveWaitResult,
  plan: string,
): Record<string, unknown> {
  const normalizedPlan = plan.trim().length > 0 ? plan : null;

  if (waitResult.kind === "interrupted") {
    return {
      status: "interrupted",
      action: "Interrupted",
      approved: false,
      interrupted: true,
      reason: waitResult.reason,
      plan: normalizedPlan,
      isAgent: false,
      awaitingLeaderApproval: true,
    };
  }

  const answers = waitResult.answers;
  const action = answers.action === "Approve & Continue" ? "Approve & Continue" : "Reject / Edit";
  const approved = action === "Approve & Continue";
  const message = answers.message?.trim();

  return {
    status: approved ? "success" : "cancelled",
    action,
    approved,
    plan: normalizedPlan,
    isAgent: false,
    awaitingLeaderApproval: !approved,
    ...(message ? { message } : {}),
  };
}

function buildPlanApprovalHookOutput(result: Record<string, unknown>): {
  hookEventName: "PreToolUse";
  permissionDecision: "allow" | "deny";
  permissionDecisionReason?: string;
  additionalContext?: string;
} {
  const status = typeof result.status === "string" ? result.status : "error";
  const approved = result.approved === true;
  const userFeedback = typeof result.message === "string" ? result.message : "";

  if (approved) {
    return {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      additionalContext: "The user approved the plan. Proceed with implementation.",
    };
  }

  if (status === "cancelled") {
    return {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      additionalContext: `The user REJECTED this plan.${userFeedback ? ` Their feedback: "${userFeedback}".` : ""} Re-enter plan mode using EnterPlanMode and revise the plan based on their feedback.`,
    };
  }

  return {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "Plan approval was interrupted before the user responded.",
  };
}

function buildBashSanitizerHookMatcher(): HookCallbackMatcher {
  const bashSanitizerHook: HookCallback = async (input) => {
    const toolInput = (input as Record<string, unknown>).tool_input;
    if (!isDictionary(toolInput)) {
      return {};
    }

    const command = typeof toolInput.command === "string" ? toolInput.command.trim() : "";
    if (!command) {
      return {};
    }

    let changed = false;
    const sanitizedInput: Record<string, unknown> = { ...toolInput };

    // Claude sometimes leaks background-management args into ordinary Bash calls.
    // Strip them before the SDK validates the command execution request.
    if ("action" in sanitizedInput) {
      delete sanitizedInput.action;
      changed = true;
    }
    if ("processId" in sanitizedInput) {
      delete sanitizedInput.processId;
      changed = true;
    }
    if (sanitizedInput.run_in_background === false) {
      delete sanitizedInput.run_in_background;
      changed = true;
    }

    if (!changed) {
      return {};
    }

    console.debug(
      `[ClaudeCode] Sanitized Bash tool input for foreground command: ${command}`
    );

    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "allow" as const,
        updatedInput: sanitizedInput,
      },
    };
  };

  return {
    matcher: "Bash",
    hooks: [bashSanitizerHook],
  };
}

function extractSdkToolResultsFromUserMessage(
  msg: unknown,
): Array<{ toolCallId: string; output: unknown; toolName?: string }> {
  if (!isDictionary(msg) || msg.type !== "user") return [];

  const out: Array<{ toolCallId: string; output: unknown; toolName?: string }> = [];
  const seen = new Set<string>();
  const pushResult = (toolCallId: string, output: unknown, toolName?: string) => {
    if (!toolCallId || seen.has(toolCallId)) return;
    seen.add(toolCallId);
    out.push({ toolCallId, output, ...(toolName ? { toolName } : {}) });
  };

  const parentToolUseId = getClaudeSdkParentToolUseId(msg) ?? "";
  const parentToolName = normalizeClaudeSdkToolName(msg.tool_name);
  if (
    "tool_use_result" in msg &&
    parentToolUseId &&
    (parentToolName === "Task" || parentToolName === "Agent")
  ) {
    pushResult(
      parentToolUseId,
      (msg as { tool_use_result?: unknown }).tool_use_result,
      parentToolName,
    );
  }

  // SDK subagent traffic is correlated via parent_tool_use_id. Keep only the
  // root Task/Agent completion result for the bridge and ignore nested tool results.
  if (parentToolUseId) {
    return out;
  }

  const innerMessage = isDictionary(msg.message) ? msg.message : null;
  const content = Array.isArray(innerMessage?.content)
    ? innerMessage.content
    : [];

  for (const part of content) {
    if (!isDictionary(part) || part.type !== "tool_result") continue;
    const toolUseId =
      typeof part.tool_use_id === "string"
        ? part.tool_use_id
        : parentToolUseId;
    if (!toolUseId) continue;

    const toolName =
      normalizeClaudeSdkToolName(part.name) ??
      normalizeClaudeSdkToolName(part.tool_name);

    if ("tool_use_result" in part) {
      pushResult(toolUseId, (part as { tool_use_result?: unknown }).tool_use_result, toolName);
      continue;
    }
    if ("content" in part) {
      pushResult(toolUseId, (part as { content?: unknown }).content, toolName);
      continue;
    }
    pushResult(toolUseId, part, toolName);
  }

  return out;
}

function normalizeToolUseInput(input: unknown): Record<string, unknown> {
  if (isDictionary(input)) {
    return input;
  }

  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (isDictionary(parsed)) {
        return parsed;
      }
    } catch {
      // Fall through to placeholder object.
    }
  }

  return {
    _recoveredInvalidToolUseInput: true,
    _inputType: input === null ? "null" : Array.isArray(input) ? "array" : typeof input,
  };
}

export function normalizeAnthropicToolUseInputs(body: Record<string, unknown>): {
  body: Record<string, unknown>;
  fixedCount: number;
} {
  const messages = body.messages;
  if (!Array.isArray(messages)) {
    return { body, fixedCount: 0 };
  }

  let fixedCount = 0;
  const normalizedMessages = messages.map((message) => {
    if (!isDictionary(message) || !Array.isArray(message.content)) {
      return message;
    }

    const normalizedContent = message.content.map((part) => {
      if (!isDictionary(part) || part.type !== "tool_use") {
        return part;
      }

      const normalizedInput = normalizeToolUseInput(part.input);
      if (normalizedInput !== part.input) {
        fixedCount += 1;
      }

      return {
        ...part,
        input: normalizedInput,
      };
    });

    return { ...message, content: normalizedContent };
  });

  return { body: { ...body, messages: normalizedMessages }, fixedCount };
}

function buildSystemPrompt(system: unknown): string | undefined {
  if (typeof system === "string" && system.trim().length > 0) {
    return system;
  }

  if (Array.isArray(system)) {
    const text = system
      .map((entry) => {
        if (isDictionary(entry) && typeof entry.text === "string") {
          return entry.text;
        }
        return "";
      })
      .filter((line) => line.length > 0)
      .join("\n\n")
      .trim();

    if (text.length > 0) {
      return text;
    }
  }

  return undefined;
}

function buildPromptFromMessages(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return "<human_turn>\nContinue.\n</human_turn>";
  }

  const lines: string[] = [];

  for (const message of messages) {
    if (!isDictionary(message)) {
      continue;
    }

    const isAssistant = message.role === "assistant";
    const openTag = isAssistant ? "<assistant_turn>" : "<human_turn>";
    const closeTag = isAssistant ? "</assistant_turn>" : "</human_turn>";
    const content = message.content;

    if (typeof content === "string" && content.trim().length > 0) {
      lines.push(`${openTag}\n${content}\n${closeTag}`);
      continue;
    }

    if (Array.isArray(content)) {
      const fragments: string[] = [];
      for (const part of content) {
        if (!isDictionary(part) || typeof part.type !== "string") {
          continue;
        }

        if (part.type === "text" && typeof part.text === "string") {
          fragments.push(part.text);
        } else if (part.type === "tool_use") {
          const toolName = normalizeClaudeSdkToolName(part.name) || "tool";
          fragments.push(`[tool_use:${toolName}]`);
        } else if (part.type === "tool_result") {
          fragments.push("[tool_result]");
        }
      }

      if (fragments.length > 0) {
        lines.push(`${openTag}\n${fragments.join("\n")}\n${closeTag}`);
      }
    }
  }

  if (lines.length === 0) {
    return "<human_turn>\nContinue.\n</human_turn>";
  }

  return lines.join("\n\n");
}

/**
 * Detect whether intercepted Anthropic API messages contain image content blocks.
 * When images are present, we must use the SDK's multimodal prompt path instead
 * of flattening to a text-only string (which silently drops image data).
 */
function hasImageContent(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    if (!isDictionary(message)) continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (isDictionary(part) && part.type === "image") return true;
    }
  }
  return false;
}

/**
 * Build an AsyncIterable<SDKUserMessage> that preserves image content blocks
 * from intercepted Anthropic API messages. This allows the Claude Agent SDK's
 * query() to process multimodal prompts (text + images) natively.
 *
 * Consolidates the full conversation (user + assistant messages) into a single
 * SDKUserMessage. Assistant turns are included as text context blocks so the
 * model retains conversation history, while user image blocks are preserved.
 * SDKUserMessage.type must be 'user' — the SDK's streamInput only accepts that.
 */
async function* buildMultimodalSdkPrompt(
  messages: unknown[],
): AsyncGenerator<SDKUserMessage> {
  const sessionId = crypto.randomUUID();

  // Collect all content blocks across the conversation into a single message.
  // This mirrors buildPromptFromMessages (single string) but preserves images.
  const contentBlocks: unknown[] = [];

  for (const message of messages) {
    if (!isDictionary(message)) continue;

    const isAssistant = message.role === "assistant";
    const openTag = isAssistant ? "<assistant_turn>" : "<human_turn>";
    const closeTag = isAssistant ? "</assistant_turn>" : "</human_turn>";
    const content = message.content;

    if (typeof content === "string" && content.trim().length > 0) {
      contentBlocks.push({ type: "text", text: `${openTag}\n${content}\n${closeTag}` });
      continue;
    }

    if (Array.isArray(content)) {
      // Flatten all structured blocks to text, except image blocks which
      // are preserved as native content (the whole point of this path).
      const textFragments: string[] = [];

      for (const part of content) {
        if (!isDictionary(part) || typeof part.type !== "string") continue;

        if (part.type === "text" && typeof part.text === "string") {
          textFragments.push(part.text);
        } else if (part.type === "image") {
          // Safety guard: if the image base64 payload exceeds the API limit
          // (should have been resized upstream, but catch edge cases here)
          const imageData: unknown = (part as Record<string, unknown>).image;
          if (typeof imageData === "string" && imageData.length > 5 * 1024 * 1024) {
            console.warn(
              `[CLAUDECODE] Image block too large (${Math.round(imageData.length / 1024)}KB), replacing with placeholder`,
            );
            contentBlocks.push({ type: "text", text: "[Image omitted — exceeded provider size limit]" });
          } else {
            contentBlocks.push(part);
          }
        } else if (part.type === "tool_use") {
          const toolName = normalizeClaudeSdkToolName(part.name) || "tool";
          textFragments.push(`[tool_use:${toolName}]`);
        } else if (part.type === "tool_result") {
          textFragments.push("[tool_result]");
        }
      }

      if (textFragments.length > 0) {
        contentBlocks.push({
          type: "text",
          text: `${openTag}\n${textFragments.join("\n")}\n${closeTag}`,
        });
      }
    }
  }

  if (contentBlocks.length === 0) return;

  yield {
    type: "user" as const,
    message: {
      role: "user" as const,
      content: contentBlocks,
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  } as SDKUserMessage;
}

function buildSdkUserMessage(content: string, sessionId: string): SDKUserMessage {
  return {
    type: "user" as const,
    message: {
      role: "user" as const,
      content,
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  } as SDKUserMessage;
}

/**
 * Long-lived, push-driven AsyncIterable channel used to feed the SDK's
 * `query.streamInput(...)` for the full lifetime of a query.
 *
 * Why this exists:
 *   The Claude Agent SDK's `streamInput(asyncIterable)` iterates the passed
 *   iterable and, when that iterable returns, calls `transport.endInput()`
 *   which closes stdin to the CLI subprocess (sdk.mjs, Query.streamInput).
 *   Any subsequent `streamInput(...)` call therefore writes to a stdin that
 *   has already been `.end()`'d, so the message is silently dropped —
 *   including the wire frame the CLI would have emitted back to us.
 *
 *   The old `pumpLivePromptQueue` implementation called `streamInput(...)`
 *   once per drain with a fresh single-message generator, so only the FIRST
 *   mid-stream injection ever reached the model. The 2nd, 3rd, ... were
 *   dropped on closed stdin — matching the reported "only first injection
 *   works on CC" behavior.
 *
 * Fix shape:
 *   Create ONE channel per query. Call `streamInput(channel.iterable())`
 *   ONCE. Every subsequent injection calls `channel.push(message)`, which
 *   resolves the iterator's pending `next()` and ships the message through
 *   the same, still-open stdin pipe. The iterable is closed only when the
 *   query ends (signal.aborted or session close), so `endInput()` fires
 *   exactly once at the correct moment.
 */
interface SdkUserMessageChannel {
  iterable: AsyncIterable<SDKUserMessage>;
  push: (message: SDKUserMessage) => void;
  close: () => void;
}

function createSdkUserMessageChannel(): SdkUserMessageChannel {
  const queue: SDKUserMessage[] = [];
  let pendingResolve: (() => void) | null = null;
  let closed = false;

  const waitForItem = (): Promise<void> => {
    if (queue.length > 0 || closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      pendingResolve = resolve;
    });
  };

  const iterable: AsyncIterable<SDKUserMessage> = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queue.length > 0) {
          const next = queue.shift();
          if (next) yield next;
        }
        if (closed) return;
        await waitForItem();
      }
    },
  };

  return {
    iterable,
    push(message) {
      if (closed) return;
      queue.push(message);
      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve();
      }
    },
    close() {
      if (closed) return;
      closed = true;
      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve();
      }
    },
  };
}

async function pumpLivePromptQueue(options: {
  query: ClaudeAgentQueryStream;
  runId?: string;
  signal: AbortSignal;
  onQueueMessages?: (entries: LivePromptEntry[]) => Promise<void>;
}): Promise<void> {
  const { query, runId, signal, onQueueMessages } = options;
  if (!runId || typeof query.streamInput !== "function") {
    return;
  }

  const inputSessionId = crypto.randomUUID();

  // ONE channel, ONE streamInput call, MANY pushes.
  //
  // We kick off streamInput() asynchronously and do NOT await it here —
  // it only resolves when the channel's async iterator returns (i.e.
  // after we call channel.close() in the finally block). That's also when
  // the SDK internally calls transport.endInput(), which is exactly the
  // moment we want stdin to close: at end-of-query, never mid-query.
  const channel = createSdkUserMessageChannel();
  const streamInputPromise = query
    .streamInput(channel.iterable)
    .catch((err: unknown) => {
      if (!signal.aborted) {
        console.warn(
          "[ClaudeCode] Persistent streamInput channel failed:",
          err instanceof Error ? err.message : err,
        );
      }
    });

  // Close the channel if the query is aborted so the pending streamInput
  // iterator resolves cleanly instead of hanging.
  const onAbort = () => channel.close();
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    while (!signal.aborted && hasLivePromptQueue(runId)) {
      let entries = drainLivePromptQueue(runId);
      if (entries.length === 0) {
        try {
          await waitForQueueMessage(runId, signal);
        } catch {
          break;
        }
        if (signal.aborted || !hasLivePromptQueue(runId)) {
          break;
        }
        entries = drainLivePromptQueue(runId);
        if (entries.length === 0) {
          continue;
        }
      }

      try {
        await onQueueMessages?.(entries);
      } catch (error) {
        console.warn(
          "[ClaudeCode] Failed to persist queued live prompt before injection:",
          error,
        );
      }

      const content = entries.some((entry) => entry.stopIntent)
        ? buildStopSystemMessage(entries)
        : buildUserInjectionContent(entries);
      if (!content) {
        continue;
      }

      // Push through the persistent channel. Never throws — the channel
      // buffers pre-consumer, so ordering is strictly FIFO.
      channel.push(buildSdkUserMessage(content, inputSessionId));

      if (entries.some((entry) => entry.stopIntent)) {
        break;
      }
    }
  } finally {
    // Always close the channel so streamInput's iterator returns and the
    // SDK closes stdin exactly once, at query-end.
    channel.close();
    signal.removeEventListener("abort", onAbort);
    // Don't await — stream lifetime is owned by the query loop. We just
    // ensure the promise doesn't become an unhandled rejection.
    void streamInputPromise;
  }
}

function isAuthError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("authentication") ||
    lower.includes("authentication_failed") ||
    lower.includes("auth") ||
    lower.includes("oauth") ||
    lower.includes("login")
  );
}

function createAnthropicMessageResponse(
  text: string,
  model: string,
  usage?: AnthropicTokenUsage,
): Response {
  return new Response(
    JSON.stringify({
      id: `msg_${crypto.randomUUID()}`,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: usage?.input_tokens ?? 0,
        output_tokens: usage?.output_tokens ?? 0,
        cache_read_input_tokens: usage?.cache_read_input_tokens,
        cache_creation_input_tokens: usage?.cache_creation_input_tokens,
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    },
  );
}



/**
 * Resolve all Selene MCP context-derived values needed for a Claude Agent SDK call:
 * the MCP context itself, an in-process MCP server instance, the resolved working
 * directory, merged plugin configs, and merged hook map.
 */
async function resolveSeleneContext(sdk: ClaudeAgentSdkQueryOptions | undefined) {
  const mcpCtx: SeleneMcpContext | undefined =
    sdk?.mcpContext ?? mcpContextStore.getStore();

  const seleneMcpServers = mcpCtx
    ? { "selene-platform": await createSeleneSdkMcpServer(mcpCtx) }
    : undefined;

  const candidateCwd = sdk?.cwd ?? mcpCtx?.cwd ?? process.cwd();
  const resolvedCwd = existsSync(candidateCwd) ? candidateCwd : process.cwd();
  if (resolvedCwd !== candidateCwd) {
    console.warn(`[ClaudeCode] cwd "${candidateCwd}" does not exist, falling back to process.cwd()`);
  }

  // Bridge Selene plugin cache paths → SDK plugin configs
  const selenePluginConfigs: SdkPluginConfig[] = (mcpCtx?.pluginPaths ?? [])
    .map((p) => ({ type: "local" as const, path: p }));
  const mergedPlugins = selenePluginConfigs.length > 0 || sdk?.plugins
    ? [...selenePluginConfigs, ...(sdk?.plugins ?? [])]
    : undefined;

  // Bridge Selene hooks → SDK hook callbacks
  const seleneHooks = mcpCtx?.hookContext
    ? buildSdkHooksFromSelene(
        mcpCtx.sessionId,
        mcpCtx.hookContext.allowedPluginNames,
        mcpCtx.hookContext.pluginRoots,
      )
    : undefined;
  const mergedHookMap = mergeHooks(seleneHooks, sdk?.hooks);

  return { mcpCtx, seleneMcpServers, resolvedCwd, mergedPlugins, mergedHookMap };
}

/**
 * Create a real-time streaming Response that pipes Claude Agent SDK events
 * as Anthropic-compatible SSE content blocks.
 *
 * Unlike `runClaudeAgentQuery` (which collects text then builds a batch response),
 * this streams tool_use and text blocks to the client as they arrive, enabling the
 * chat UI to show intermediate tool steps in real-time.
 */
function createStreamingClaudeCodeResponse(options: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  model: string;
  systemPrompt?: string;
  signal?: AbortSignal;
  sdkOptions?: ClaudeAgentSdkQueryOptions;
}): Response {
  const messageId = `msg_${crypto.randomUUID()}`;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let emitClosed = false;
      const emit = (event: string, data: unknown) => {
        if (emitClosed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // Controller closed (client disconnected). Continue consuming the SDK
          // generator so onFinish fires and DB persistence completes normally.
          emitClosed = true;
        }
      };

      const abortController = new AbortController();
      const onAbort = () => abortController.abort();
      if (options.signal) {
        if (options.signal.aborted) {
          abortController.abort();
        } else {
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      const pendingInputJsonDeltaByIndex = new Map<
        number,
        { partialJson: string; timer: ReturnType<typeof setTimeout> | null }
      >();
      const syntheticToolInputIndices = new Set<number>();

      let livePromptAbortController: AbortController | undefined;
      let onLivePromptAbort: (() => void) | undefined;
      let livePromptPump: Promise<void> = Promise.resolve();

      try {
        const sdk = options.sdkOptions;
        const { mcpCtx, seleneMcpServers, resolvedCwd, mergedPlugins, mergedHookMap } =
          await resolveSeleneContext(sdk);
        const sdkToolResultBridge = mcpCtx?.sdkToolResultBridge;

        // ── Interactive tool gate: pause SDK for AskUserQuestion / ExitPlanMode ──
        // The async PreToolUse hook blocks the SDK from auto-executing
        // interactive tools until the real user answers via the
        // /api/chat/tool-result endpoint.
        const interactiveSessionId = mcpCtx?.sessionId ?? "";
        const interactiveToolHook: HookCallback = async (input, toolUseId, hookOptions) => {
          const toolName = (input as Record<string, unknown>).tool_name as string;

          // ── ExitPlanMode: plan approval gate ──
          if (toolName === "ExitPlanMode") {
            if (!toolUseId || !interactiveSessionId) return {};

            const plan = readPlanModeFile(resolvedCwd);
            const approvalPrompt = buildPlanApprovalPrompt(plan);

            console.debug(
              `[ClaudeCode] Interactive tool gate: blocking ExitPlanMode (${toolUseId}) until user approves plan`,
            );

            const waitResult = await registerInteractiveWait(
              interactiveSessionId,
              toolUseId,
              approvalPrompt,
              { abortSignal: hookOptions.signal },
            );

            const result = buildPlanApprovalResult(waitResult, plan);
            sdkToolResultBridge?.publish(toolUseId, result, toolName);

            console.debug(
              `[ClaudeCode] Interactive tool gate: user responded to ExitPlanMode (${toolUseId}) — status=${String(result.status)}`,
            );

            return {
              hookSpecificOutput: buildPlanApprovalHookOutput(result),
            };
          }

          // ── AskUserQuestion / AskFollowupQuestion gate ──
          if (
            toolName !== "AskUserQuestion" &&
            toolName !== "AskFollowupQuestion"
          ) {
            return {};
          }
          if (!toolUseId || !interactiveSessionId) return {};

          const toolInput = (input as Record<string, unknown>).tool_input;
          console.debug(
            `[ClaudeCode] Interactive tool gate: blocking ${toolName} (${toolUseId}) until user answers`,
          );

          // Block until user answers via the API endpoint
          const waitResult = await registerInteractiveWait(
            interactiveSessionId,
            toolUseId,
            toolInput,
            { abortSignal: hookOptions.signal },
          );

          if (waitResult.kind !== "submitted") {
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                permissionDecision: "deny" as const,
                permissionDecisionReason: "Interactive question was interrupted before the user responded.",
              },
            };
          }

          const answers = waitResult.answers;

          // Store answers so we can override the SDK's auto-answer later
          storeUserAnswer(interactiveSessionId, toolUseId, answers);

          console.debug(
            `[ClaudeCode] Interactive tool gate: user answered ${toolName} (${toolUseId})`,
          );

          // Use updatedInput to inject user's answers into the tool input.
          // This tells the SDK's AskUserQuestion handler that answers are pre-filled,
          // so it passes them through to Claude instead of auto-answering.
          const originalInput =
            typeof toolInput === "object" && toolInput !== null
              ? (toolInput as Record<string, unknown>)
              : {};
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse" as const,
              permissionDecision: "allow" as const,
              updatedInput: { ...originalInput, answers },
              additionalContext: `The user has already answered this question. Their selections: ${JSON.stringify(answers)}. Use these answers as the tool result.`,
            },
          };
        };

        const finalHooks = mergeHooks(mergedHookMap, {
          PreToolUse: [
            buildBashSanitizerHookMatcher(),
            {
              matcher: "AskUserQuestion",
              hooks: [interactiveToolHook],
              timeout: 300,
            },
            {
              matcher: "AskFollowupQuestion",
              hooks: [interactiveToolHook],
              timeout: 300,
            },
            {
              matcher: "ExitPlanMode",
              hooks: [interactiveToolHook],
              timeout: 300,
            },
          ],
        });

        const { executable: sdkExecutable, env: sdkEnv } = getSdkExecutableConfig();

        const query = claudeAgentQuery({
          prompt: options.prompt,
          options: {
            abortController,
            cwd: resolvedCwd,
            ...(resolvedCwd !== process.cwd() ? { additionalDirectories: [resolvedCwd] } : {}),
            executable: sdkExecutable,
            pathToClaudeCodeExecutable: getCliPath(),
            includePartialMessages: true,
            settingSources: ["project"] as ("user" | "project" | "local")[],
            maxTurns: sdk?.maxTurns ?? 1000,
            model: options.model,
            permissionMode: sdk?.permissionMode ?? "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            env: sdkEnv,
            ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
            ...(seleneMcpServers ? { mcpServers: seleneMcpServers } : {}),
            ...(sdk?.agents ? { agents: sdk.agents } : {}),
            ...(sdk?.allowedTools ? { allowedTools: sdk.allowedTools } : {}),
            ...(sdk?.disallowedTools ? { disallowedTools: sdk.disallowedTools } : {}),
            ...(finalHooks ? { hooks: finalHooks } : {}),
            ...(mergedPlugins ? { plugins: mergedPlugins } : {}),
            ...(sdk?.resume ? { resume: sdk.resume } : {}),
            ...(sdk?.sessionId ? { sessionId: sdk.sessionId } : {}),
            ...(sdk?.outputFormat ? { outputFormat: sdk.outputFormat } : {}),
            ...(sdk?.thinking ? { thinking: sdk.thinking } : {}),
            ...(sdk?.effort ? { effort: sdk.effort } : {}),
            ...(sdk?.persistSession !== undefined ? { persistSession: sdk.persistSession } : {}),
          },
        }) as ClaudeAgentQueryStream;

        livePromptAbortController = new AbortController();
        onLivePromptAbort = () => livePromptAbortController?.abort();
        if (options.signal) {
          if (options.signal.aborted) {
            livePromptAbortController.abort();
          } else {
            options.signal.addEventListener("abort", onLivePromptAbort, { once: true });
          }
        }
        livePromptPump = pumpLivePromptQueue({
          query,
          runId: mcpCtx?.runId,
          signal: livePromptAbortController.signal,
          onQueueMessages: mcpCtx?.onQueueMessages,
        });

        // Emit message_start
        emit("message_start", {
          type: "message_start",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            model: options.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });

        let nextContentIndex = 0;
        let inputTokens = 0;
        let outputTokens = 0;
        let finalUsage: AnthropicTokenUsage | undefined;
        let syntheticStreamLocalIndex = -1;
        let sawStreamTextThisTurn = false;
        const streamedToolUseIdsThisTurn = new Set<string>();
        const streamLocalToGlobalIndex = new Map<number, number>();
        const openStreamLocalIndices = new Set<number>();
        /** Global indices that were already closed (force-closed or naturally stopped).
         *  Prevents double-emitting content_block_stop for the same global index
         *  when concurrent SDK Agent sub-tasks collide on the same local index. */
        const closedGlobalIndices = new Set<number>();
        let rawInputJsonDeltaChunks = 0;
        let emittedInputJsonDeltaChunks = 0;

        const allocateContentIndex = () => {
          const idx = nextContentIndex;
          nextContentIndex += 1;
          return idx;
        };

        const emitTextBlock = (text: string, index?: number) => {
          if (!text) return;
          const targetIndex = index ?? allocateContentIndex();
          emit("content_block_start", {
            type: "content_block_start",
            index: targetIndex,
            content_block: { type: "text", text: "" },
          });
          emit("content_block_delta", {
            type: "content_block_delta",
            index: targetIndex,
            delta: { type: "text_delta", text },
          });
          emit("content_block_stop", { type: "content_block_stop", index: targetIndex });
          outputTokens += Math.max(1, Math.ceil(text.length / 4));
        };

        const emitToolUseBlock = (
          id: string,
          name: string,
          inputJson?: string,
          index?: number,
        ) => {
          const targetIndex = index ?? allocateContentIndex();
          emit("content_block_start", {
            type: "content_block_start",
            index: targetIndex,
            content_block: { type: "tool_use", id, name },
          });
          if (inputJson !== undefined) {
            emit("content_block_delta", {
              type: "content_block_delta",
              index: targetIndex,
              delta: { type: "input_json_delta", partial_json: inputJson },
            });
          }
          emit("content_block_stop", { type: "content_block_stop", index: targetIndex });
        };

        const getPendingInputDelta = (index: number) => {
          const existing = pendingInputJsonDeltaByIndex.get(index);
          if (existing) return existing;
          const created = { partialJson: "", timer: null as ReturnType<typeof setTimeout> | null };
          pendingInputJsonDeltaByIndex.set(index, created);
          return created;
        };

        const clearPendingInputDelta = (index: number) => {
          const pending = pendingInputJsonDeltaByIndex.get(index);
          if (!pending) return;
          if (pending.timer) {
            clearTimeout(pending.timer);
          }
          pendingInputJsonDeltaByIndex.delete(index);
        };

        const flushInputJsonDelta = (index: number) => {
          const pending = pendingInputJsonDeltaByIndex.get(index);
          if (!pending || pending.partialJson.length === 0) return;
          if (pending.timer) {
            clearTimeout(pending.timer);
            pending.timer = null;
          }
          emit("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: pending.partialJson },
          });
          emittedInputJsonDeltaChunks += 1;
          pending.partialJson = "";
        };

        const flushAllPendingInputJsonDeltas = () => {
          for (const index of pendingInputJsonDeltaByIndex.keys()) {
            flushInputJsonDelta(index);
          }
        };

        const emitInputJsonDelta = (index: number, partialJson: string) => {
          rawInputJsonDeltaChunks += 1;
          if (!CLAUDECODE_INPUT_DELTA_BATCH_ENABLED) {
            emit("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "input_json_delta", partial_json: partialJson },
            });
            emittedInputJsonDeltaChunks += 1;
            return;
          }

          const pending = getPendingInputDelta(index);
          pending.partialJson += partialJson;

          if (pending.partialJson.length >= CLAUDECODE_INPUT_DELTA_BATCH_MAX_CHARS) {
            flushInputJsonDelta(index);
            return;
          }

          if (!pending.timer) {
            pending.timer = setTimeout(() => {
              const state = pendingInputJsonDeltaByIndex.get(index);
              if (!state) return;
              state.timer = null;
              flushInputJsonDelta(index);
            }, CLAUDECODE_INPUT_DELTA_BATCH_INTERVAL_MS);
          }
        };

        const getEventIndex = (event: Record<string, unknown>): number | null => {
          const raw = event.index;
          if (typeof raw !== "number" || !Number.isInteger(raw)) return null;
          return raw;
        };

        const resolveDeltaOrStopLocalIndex = (event: Record<string, unknown>): number | null => {
          const indexed = getEventIndex(event);
          if (indexed !== null) return indexed;
          if (openStreamLocalIndices.size === 1) {
            return [...openStreamLocalIndices][0];
          }
          return null;
        };

        const closeOpenStreamBlocks = () => {
          for (const localIndex of [...openStreamLocalIndices]) {
            const globalIndex = streamLocalToGlobalIndex.get(localIndex);
            if (globalIndex !== undefined && !closedGlobalIndices.has(globalIndex)) {
              flushInputJsonDelta(globalIndex);
              emit("content_block_stop", { type: "content_block_stop", index: globalIndex });
              closedGlobalIndices.add(globalIndex);
              clearPendingInputDelta(globalIndex);
            }
            openStreamLocalIndices.delete(localIndex);
          }
        };

        const resetTurnStreamTracking = () => {
          closeOpenStreamBlocks();
          streamLocalToGlobalIndex.clear();
          openStreamLocalIndices.clear();
          closedGlobalIndices.clear();
          flushAllPendingInputJsonDeltas();
          for (const index of [...pendingInputJsonDeltaByIndex.keys()]) {
            clearPendingInputDelta(index);
          }
          sawStreamTextThisTurn = false;
          streamedToolUseIdsThisTurn.clear();
        };

        for await (const rawMessage of query) {
          const message = rawMessage as { type?: string };

          // Claude SDK annotates nested subagent traffic with parent_tool_use_id.
          // Keep those events inside the root Task/Agent call instead of replaying
          // every nested tool into the main SSE/chat stream.
          if (getClaudeSdkParentToolUseId(rawMessage)) {
            continue;
          }

          if (message.type === "user") {
            if (sdkToolResultBridge) {
              const bridgedResults = extractSdkToolResultsFromUserMessage(message);
              for (const entry of bridgedResults) {
                // Override SDK's auto-answer with user's real answer for interactive tools
                if (
                  interactiveSessionId &&
                  (entry.toolName === "AskUserQuestion" || entry.toolName === "AskFollowupQuestion")
                ) {
                  console.debug(
                    `[ClaudeCode] SDK auto-answer for ${entry.toolName} (${entry.toolCallId}):`,
                    JSON.stringify(entry.output),
                  );
                  const userAnswer = popUserAnswer(interactiveSessionId, entry.toolCallId);
                  if (userAnswer) {
                    console.debug(
                      `[ClaudeCode] Overriding with user's answer:`,
                      JSON.stringify(userAnswer),
                    );
                    entry.output = { answers: userAnswer };
                  }
                }
                sdkToolResultBridge.publish(entry.toolCallId, entry.output, entry.toolName);
              }
            }
            continue;
          }

          // ── stream_event: real-time deltas (text + tool_use) ──────────────
          if (message.type === "stream_event") {
            const event = (message as { event?: unknown }).event;
            if (!isDictionary(event) || typeof event.type !== "string") continue;

            if (event.type === "content_block_start" && isDictionary(event.content_block)) {
              const explicitLocalIndex = getEventIndex(event);
              // NOTE: Removed index-0 resetTurnStreamTracking() heuristic.
              // With concurrent SDK Agent sub-tasks (Claude fires multiple Agent
              // tool calls), local indices from different sub-agents collide.
              // Resetting all state when index 0 reappears would destroy
              // still-active blocks from other sub-agents, causing crashes.
              const localIndex = explicitLocalIndex ?? syntheticStreamLocalIndex--;
              if (streamLocalToGlobalIndex.has(localIndex)) {
                if (openStreamLocalIndices.has(localIndex)) {
                  // Still-open block at this local index — concurrent sub-agent
                  // collision. Force-close the existing block so the new one can
                  // take over this local index.
                  const oldGlobal = streamLocalToGlobalIndex.get(localIndex)!;
                  flushInputJsonDelta(oldGlobal);
                  if (!closedGlobalIndices.has(oldGlobal)) {
                    emit("content_block_stop", { type: "content_block_stop", index: oldGlobal });
                    closedGlobalIndices.add(oldGlobal);
                  }
                  clearPendingInputDelta(oldGlobal);
                  openStreamLocalIndices.delete(localIndex);
                }
                // Stale/closed mapping — remove so we allocate a fresh global index.
                streamLocalToGlobalIndex.delete(localIndex);
              }
              const globalIndex = allocateContentIndex();
              streamLocalToGlobalIndex.set(localIndex, globalIndex);
              openStreamLocalIndices.add(localIndex);

              const blockType = event.content_block.type;
              if (blockType === "text") {
                emit("content_block_start", {
                  type: "content_block_start",
                  index: globalIndex,
                  content_block: { type: "text", text: "" },
                });
                sawStreamTextThisTurn = true;
              } else if (blockType === "tool_use") {
                const toolUseId =
                  typeof event.content_block.id === "string"
                    ? event.content_block.id
                    : `toolu_${crypto.randomUUID()}`;
                const toolName = normalizeClaudeSdkToolName(event.content_block.name) || "unknown";
                emit("content_block_start", {
                  type: "content_block_start",
                  index: globalIndex,
                  content_block: {
                    type: "tool_use",
                    id: toolUseId,
                    name: toolName,
                  },
                });
                if (toolName === "ExitPlanMode") {
                  syntheticToolInputIndices.add(globalIndex);
                  emit("content_block_delta", {
                    type: "content_block_delta",
                    index: globalIndex,
                    delta: {
                      type: "input_json_delta",
                      partial_json: JSON.stringify(buildPlanApprovalPrompt(readPlanModeFile(resolvedCwd))),
                    },
                  });
                }
                streamedToolUseIdsThisTurn.add(toolUseId);
              } else {
                openStreamLocalIndices.delete(localIndex);
              }
              continue;
            }

            if (event.type === "content_block_delta" && isDictionary(event.delta)) {
              const localIndex = resolveDeltaOrStopLocalIndex(event);
              let globalIndex = localIndex !== null
                ? streamLocalToGlobalIndex.get(localIndex)
                : undefined;
              if (globalIndex === undefined) {
                // Out-of-order delta before start; synthesize a matching block so
                // downstream append-only validation remains stable.
                const fallbackLocalIndex = localIndex ?? syntheticStreamLocalIndex--;
                globalIndex = allocateContentIndex();
                streamLocalToGlobalIndex.set(fallbackLocalIndex, globalIndex);
                openStreamLocalIndices.add(fallbackLocalIndex);
                if (event.delta.type === "text_delta") {
                  emit("content_block_start", {
                    type: "content_block_start",
                    index: globalIndex,
                    content_block: { type: "text", text: "" },
                  });
                  sawStreamTextThisTurn = true;
                } else if (event.delta.type === "input_json_delta") {
                  const toolUseId = `toolu_${crypto.randomUUID()}`;
                  const toolName = "unknown";
                  emit("content_block_start", {
                    type: "content_block_start",
                    index: globalIndex,
                    content_block: { type: "tool_use", id: toolUseId, name: toolName },
                  });
                  streamedToolUseIdsThisTurn.add(toolUseId);
                }
              }

              if (event.delta.type === "text_delta" && typeof event.delta.text === "string") {
                emit("content_block_delta", {
                  type: "content_block_delta",
                  index: globalIndex,
                  delta: { type: "text_delta", text: event.delta.text },
                });
                outputTokens += Math.max(1, Math.ceil(String(event.delta.text).length / 4));
              } else if (event.delta.type === "input_json_delta" && typeof event.delta.partial_json === "string") {
                if (!syntheticToolInputIndices.has(globalIndex)) {
                  emitInputJsonDelta(globalIndex, event.delta.partial_json);
                }
              }
              continue;
            }

            if (event.type === "content_block_stop") {
              const localIndex = resolveDeltaOrStopLocalIndex(event);
              if (localIndex === null) continue;
              const globalIndex = streamLocalToGlobalIndex.get(localIndex);
              if (globalIndex === undefined || !openStreamLocalIndices.has(localIndex)) continue;
              // Guard against double-close: a prior force-close (from concurrent
              // sub-agent index collision) already emitted content_block_stop.
              if (closedGlobalIndices.has(globalIndex)) {
                openStreamLocalIndices.delete(localIndex);
                continue;
              }
              flushInputJsonDelta(globalIndex);
              emit("content_block_stop", { type: "content_block_stop", index: globalIndex });
              closedGlobalIndices.add(globalIndex);
              clearPendingInputDelta(globalIndex);
              syntheticToolInputIndices.delete(globalIndex);
              openStreamLocalIndices.delete(localIndex);
              continue;
            }

            // Pass through any other stream events we don't handle
            continue;
          }

          if (message.type === "tool_use_summary") {
            const summary = (message as { summary?: unknown }).summary;
            if (typeof summary === "string" && summary.trim().length > 0) {
              emitTextBlock(summary);
            }
            continue;
          }

          // ── assistant: finalized message with content blocks ──────────────
          if (message.type === "assistant") {
            // NOTE: Do NOT call closeOpenStreamBlocks() or resetTurnStreamTracking()
            // here. With concurrent SDK Agent sub-tasks, one sub-agent's assistant
            // message would prematurely close blocks and destroy index mappings
            // from other still-active sub-agents, causing frontend crashes.
            // Dedup tracking intentionally accumulates — cleaned up in `result`.
            const assistant = message as {
              message?: {
                content?: Array<{
                  type?: string;
                  text?: string;
                  id?: string;
                  name?: string;
                  input?: unknown;
                }>;
              };
              error?: string;
            };

            if (
              assistant.error === "authentication_failed" ||
              assistant.error === "billing_error"
            ) {
              throw new Error(assistant.error);
            }

            // Fallback/patch-up mode: emit assistant content that wasn't already
            // streamed as deltas across the session.
            const content = assistant.message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (!block?.type) continue;

                if (block.type === "tool_use" && block.id && block.name) {
                  const normalizedBlockName = normalizeClaudeSdkToolName(block.name);
                  if (!normalizedBlockName) {
                    continue;
                  }
                  // Only deduplicate by unique tool-call ID. Name-based dedup
                  // is unsafe: when multiple independent calls share a tool name
                  // (e.g. 4 parallel Agent launches), the first streamed call adds
                  // the name to the set, causing calls 2–N to be silently dropped
                  // even though they were never streamed as deltas.
                  if (streamedToolUseIdsThisTurn.has(block.id)) {
                    continue;
                  }
                  emitToolUseBlock(
                    block.id,
                    normalizedBlockName,
                    normalizedBlockName === "ExitPlanMode"
                      ? JSON.stringify(buildPlanApprovalPrompt(readPlanModeFile(resolvedCwd)))
                      : JSON.stringify(block.input ?? {}),
                  );
                } else if (block.type === "text" && block.text) {
                  // Avoid duplicate assistant text only when stream text was
                  // already emitted via deltas at any point during this session.
                  if (!sawStreamTextThisTurn) {
                    emitTextBlock(block.text);
                  }
                }
              }
            }
            // No reset here — state accumulates across concurrent sub-agent turns.
            // Full cleanup happens in the `result` handler when the query ends.
            continue;
          }

          // ── result: final message ─────────────────────────────────────────
          if (message.type === "result") {
            closeOpenStreamBlocks();
            const result = message as ClaudeAgentResultMessage;

            if (Array.isArray(result.errors) && result.errors.length > 0) {
              const errorText = result.errors.join("\n");
              emitTextBlock(errorText);
            }

            if (
              nextContentIndex === 0 &&
              typeof result.result === "string" &&
              result.result.length > 0
            ) {
              emitTextBlock(result.result);
            }

            // Extract real token usage from SDK result AFTER any emitTextBlock
            // calls above (emitTextBlock accumulates estimated outputTokens, and
            // we want the real SDK values to be the final word).
            if (result.usage) {
              finalUsage = result.usage;
              inputTokens = result.usage.input_tokens ?? inputTokens;
              outputTokens = result.usage.output_tokens ?? outputTokens;
            }

            if (result.is_error) {
              console.error("[ClaudeCode] SDK query error:", result.subtype);
            }
            continue;
          }
        }

        closeOpenStreamBlocks();
        flushAllPendingInputJsonDeltas();

        if (
          CLAUDECODE_INPUT_DELTA_BATCH_ENABLED &&
          rawInputJsonDeltaChunks > 0 &&
          process.env.NODE_ENV !== "production"
        ) {
          console.debug(
            `[ClaudeCode] input_json_delta batching: raw=${rawInputJsonDeltaChunks}, emitted=${emittedInputJsonDeltaChunks}`,
          );
        }

        // Close the message — include real token counts so @ai-sdk/anthropic
        // picks up usage (it reads input_tokens, cache tokens from message_delta.usage).
        emit("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_read_input_tokens: finalUsage?.cache_read_input_tokens,
            cache_creation_input_tokens: finalUsage?.cache_creation_input_tokens,
          },
        });
        emit("message_stop", { type: "message_stop" });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("[ClaudeCode] Streaming error:", errorMessage);

        try {
          const errorEvent = `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: errorMessage } })}\n\n`;
          controller.enqueue(encoder.encode(errorEvent));
        } catch {
          // Controller may already be closed
        }
      } finally {
        livePromptAbortController?.abort();
        if (options.signal && onLivePromptAbort) {
          options.signal.removeEventListener("abort", onLivePromptAbort);
        }
        await livePromptPump.catch(() => {});
        options.signal?.removeEventListener("abort", onAbort);
        for (const pending of pendingInputJsonDeltaByIndex.values()) {
          if (pending.timer) {
            clearTimeout(pending.timer);
          }
        }
        pendingInputJsonDeltaByIndex.clear();
        try {
          controller.close();
        } catch {
          // Already closed
        }
      }
    },
    cancel() {
      // Client stopped reading (disconnect / abort). The try/catch in emit()
      // already no-ops on a closed controller, so the SDK generator keeps
      // running to completion and DB persistence finishes normally.
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

async function runClaudeAgentQuery(options: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  model: string;
  systemPrompt?: string;
  signal?: AbortSignal;
  sdkOptions?: ClaudeAgentSdkQueryOptions;
}): Promise<{ text: string; usage?: AnthropicTokenUsage }> {
  const abortController = new AbortController();
  const signal = options.signal;

  const onAbort = () => abortController.abort();
  if (signal) {
    if (signal.aborted) {
      abortController.abort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const sdk = options.sdkOptions;
  const { mcpCtx, seleneMcpServers, resolvedCwd, mergedPlugins, mergedHookMap } =
    await resolveSeleneContext(sdk);

  const finalHooks = mergeHooks(mergedHookMap, {
    PreToolUse: [buildBashSanitizerHookMatcher()],
  });

  const { executable: sdkExecutable, env: sdkEnv } = getSdkExecutableConfig();

  const query = claudeAgentQuery({
    prompt: options.prompt,
    options: {
      abortController,
      cwd: resolvedCwd,
      ...(resolvedCwd !== process.cwd() ? { additionalDirectories: [resolvedCwd] } : {}),
      executable: sdkExecutable,
      pathToClaudeCodeExecutable: getCliPath(),
      includePartialMessages: true,
      // Allow multi-step agentic work (read → plan → write → verify).
      maxTurns: sdk?.maxTurns ?? 1000,
      model: options.model,
      // bypassPermissions is the correct default for a headless server context:
      // there is no interactive TTY to approve permission prompts, so "default"
      // mode causes the agent to stall on every write/bash and fall back to
      // asking clarifying questions instead of executing.
      permissionMode: sdk?.permissionMode ?? "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      env: sdkEnv,
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
      // Selene platform tools exposed via in-process MCP server
      ...(seleneMcpServers ? { mcpServers: seleneMcpServers } : {}),
      // SDK-native passthrough options
      ...(sdk?.agents ? { agents: sdk.agents } : {}),
      ...(sdk?.allowedTools ? { allowedTools: sdk.allowedTools } : {}),
      ...(sdk?.disallowedTools ? { disallowedTools: sdk.disallowedTools } : {}),
      ...(finalHooks ? { hooks: finalHooks } : {}),
      ...(mergedPlugins ? { plugins: mergedPlugins } : {}),
      ...(sdk?.resume ? { resume: sdk.resume } : {}),
      ...(sdk?.sessionId ? { sessionId: sdk.sessionId } : {}),
      ...(sdk?.outputFormat ? { outputFormat: sdk.outputFormat } : {}),
      ...(sdk?.thinking ? { thinking: sdk.thinking } : {}),
      ...(sdk?.effort ? { effort: sdk.effort } : {}),
      ...(sdk?.persistSession !== undefined ? { persistSession: sdk.persistSession } : {}),
    },
  }) as ClaudeAgentQueryStream;
      
  const livePromptAbortController = new AbortController();
  const onLivePromptAbort = () => livePromptAbortController.abort();
  if (signal) {
    if (signal.aborted) {
      livePromptAbortController.abort();
    } else {
      signal.addEventListener("abort", onLivePromptAbort, { once: true });
    }
  }
  const livePromptPump = pumpLivePromptQueue({
    query,
    runId: mcpCtx?.runId,
    signal: livePromptAbortController.signal,
    onQueueMessages: mcpCtx?.onQueueMessages,
  });

  let text = "";
  let sawStreamText = false;
  let resultUsage: AnthropicTokenUsage | undefined;

  try {
    for await (const rawMessage of query) {
      const message = rawMessage as { type?: string };

      if (getClaudeSdkParentToolUseId(rawMessage)) {
        continue;
      }

      if (message.type === "stream_event") {
        const event = (message as { event?: unknown }).event;
        if (
          isDictionary(event) &&
          event.type === "content_block_delta" &&
          isDictionary(event.delta) &&
          event.delta.type === "text_delta" &&
          typeof event.delta.text === "string"
        ) {
          sawStreamText = true;
          text += event.delta.text;
        }
        continue;
      }

      if (message.type === "assistant") {
        const assistant = message as {
          message?: {
            content?: Array<{ type?: string; text?: string }>;
          };
          error?: string;
        };

        // Surface auth and billing errors immediately so the retry handler can act.
        if (
          assistant.error === "authentication_failed" ||
          assistant.error === "billing_error"
        ) {
          throw new Error(assistant.error);
        }

        // Agent SDK emits both stream deltas and a finalized assistant payload.
        // If we already consumed deltas, skip assistant text to avoid duplicate output.
        if (!sawStreamText) {
          const content = assistant.message?.content;
          if (Array.isArray(content)) {
            for (const part of content) {
              if (part?.type === "text" && typeof part.text === "string") {
                text += part.text;
              }
            }
          }
        }
        continue;
      }

      if (message.type === "result") {
        const result = message as ClaudeAgentResultMessage;

        // Capture real usage from the SDK result
        if (result.usage) {
          resultUsage = result.usage;
        }

        // Some SDK versions include a final textual result summary; only use it
        // when no stream/assistant text was captured.
        if (
          !sawStreamText &&
          text.trim().length === 0 &&
          typeof result.result === "string" &&
          result.result.length > 0
        ) {
          text = result.result;
        }

        if (Array.isArray(result.errors) && result.errors.length > 0) {
          text = `${text}\n${result.errors.join("\n")}`.trim();
        }

        if (result.is_error) {
          throw new Error(result.subtype || "error_during_execution");
        }
        continue;
      }

      // The SDK emits additional informational messages (system subtypes like
      // hook_started/hook_response/files_persisted, tool_progress, task_notification,
      // status, etc.). These don't affect the text output but should not cause errors.
      // We intentionally fall through without handling them.
    }
  } finally {
    livePromptAbortController.abort();
    signal?.removeEventListener("abort", onLivePromptAbort);
    await livePromptPump.catch(() => {});
    signal?.removeEventListener("abort", onAbort);
  }

  return { text: text.trim(), usage: resultUsage };
}

/**
 * Shared retry-with-backoff loop for Agent SDK calls.
 *
 * Runs `attempt` in a loop, retrying on recoverable errors. When an auth error
 * is detected, calls `onAuthError(authStatus)` so the caller can decide whether
 * to throw or return an error Response. Returns the result of the first
 * successful `attempt` call.
 */
async function withClaudeCodeRetry<T>(
  label: string,
  signal: AbortSignal | undefined,
  model: string,
  attempt: (n: number) => Promise<T>,
  onAuthError: (authStatus: Awaited<ReturnType<typeof readClaudeAgentSdkAuthStatus>>) => Promise<T | undefined>
): Promise<T> {
  for (let n = 0; ; n += 1) {
    try {
      return await attempt(n);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (isAuthError(message)) {
        const authStatus = await readClaudeAgentSdkAuthStatus({ timeoutMs: 20_000, model });
        if (!authStatus.authenticated) {
          const handled = await onAuthError(authStatus);
          if (handled !== undefined) return handled;
        }
      }

      const classification = classifyRecoverability({ provider: "claudecode", error, message });
      const retry = shouldRetry({
        classification,
        attempt: n,
        maxAttempts: CLAUDECODE_MAX_RETRY_ATTEMPTS,
        aborted: signal?.aborted ?? false,
      });

      if (!retry) throw error;

      const delay = getBackoffDelayMs(n);
      console.debug(`[ClaudeCode] Retrying Agent SDK ${label}`, {
        attempt: n + 1,
        reason: classification.reason,
        delayMs: delay,
      });
      await sleepWithAbort(delay, signal ?? undefined);
    }
  }
}

/**
 * Execute a Claude Agent SDK query with full SDK capabilities.
 *
 * Unlike the fetch-interceptor path (`createClaudeCodeProvider`), this API
 * accepts native SDK options such as agent definitions, lifecycle hooks, plugin
 * loading, session continuation, structured output, and thinking controls.
 *
 * Includes the same retry-with-exponential-backoff and auth-check behaviour as
 * the fetch interceptor, making it safe to use from background tasks, prompt
 * enhancement pipelines, and direct SDK integrations.
 *
 * @example
 * ```ts
 * const result = await queryWithSdkOptions({
 *   prompt: "Summarise the changes in the last commit",
 *   model: "claude-sonnet-4-6",
 *   sdkOptions: {
 *     persistSession: false,
 *     maxTurns: 3,
 *     allowedTools: ["Bash", "Read"],
 *   },
 * });
 * ```
 */
export async function queryWithSdkOptions(options: {
  prompt: string;
  model?: string;
  systemPrompt?: string;
  signal?: AbortSignal;
  sdkOptions?: ClaudeAgentSdkQueryOptions;
}): Promise<string> {
  const model = options.model ?? DEFAULT_MODEL;

  return withClaudeCodeRetry(
    "query",
    options.signal,
    model,
    async () => {
      const result = await runClaudeAgentQuery({
        prompt: options.prompt,
        model,
        systemPrompt: options.systemPrompt,
        signal: options.signal,
        sdkOptions: options.sdkOptions,
      });
      return result.text;
    },
    async (authStatus) => {
      const err = new Error("Claude Agent SDK authentication required") as Error & {
        auth: { required: boolean; url: string | undefined; output: string[] | undefined };
      };
      err.auth = { required: true, url: authStatus.authUrl, output: authStatus.output };
      throw err;
    }
  );
}

function createClaudeCodeFetch(): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    // Only intercept Anthropic API calls.
    if (!url.includes("api.anthropic.com")) {
      return fetch(input, init);
    }

    if (!init?.body || typeof init.body !== "string") {
      return fetch(input, init);
    }

    let parsedBody: Record<string, unknown>;
    try {
      parsedBody = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      return fetch(input, init);
    }

    const normalizedToolInputs = normalizeAnthropicToolUseInputs(parsedBody);
    if (normalizedToolInputs.fixedCount > 0) {
      console.warn(
        `[ClaudeCode] Normalized ${normalizedToolInputs.fixedCount} invalid tool_use.input payload(s) before Agent SDK call`,
      );
    }

    const sanitizedBody = sanitizeJsonStringValues(normalizedToolInputs.body);
    if (sanitizedBody.changed) {
      console.warn("[ClaudeCode] Replaced lone surrogate characters in request body before Agent SDK call");
    }

    const requestBody = sanitizedBody.value as Record<string, unknown>;
    const model = typeof requestBody.model === "string" ? requestBody.model : DEFAULT_MODEL;
    const systemPrompt = buildSystemPrompt(requestBody.system);
    const isStream = requestBody.stream === true;

    // When messages contain image content blocks (e.g. describeImage tool),
    // use the SDK's native multimodal prompt path to preserve image data.
    // For text-only messages, use the existing string flattening (zero blast radius).
    const isMultimodal = hasImageContent(requestBody.messages);
    // Text prompt is computed once; multimodal generators are rebuilt per-attempt
    // since AsyncGenerator is single-use and retries need a fresh iterable.
    const textPrompt = isMultimodal ? undefined : buildPromptFromMessages(requestBody.messages);
    const makePrompt = (): string | AsyncIterable<SDKUserMessage> =>
      isMultimodal
        ? buildMultimodalSdkPrompt(requestBody.messages as unknown[])
        : textPrompt!;

    // For streaming requests, use the real-time streaming path that pipes SDK
    // events (including tool_use blocks) directly to the client as SSE.
    if (isStream) {
      return createStreamingClaudeCodeResponse({
        prompt: makePrompt(),
        model,
        systemPrompt,
        signal: init.signal ?? undefined,
      });
    }

    return withClaudeCodeRetry(
      "request",
      init.signal ?? undefined,
      model,
      async () => {
        const { text: output, usage } = await runClaudeAgentQuery({
          prompt: makePrompt(),
          model,
          systemPrompt,
          signal: init.signal ?? undefined,
        });
        return createAnthropicMessageResponse(output, model, usage);
      },
      async (authStatus) =>
        new Response(
          JSON.stringify({
            error: "Claude Agent SDK authentication required",
            auth: { required: true, url: authStatus.authUrl, output: authStatus.output },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        )
    );
  };
}

export function createClaudeCodeProvider(): (modelId: string) => LanguageModel {
  const provider = createAnthropic({
    apiKey: "claude-agent-sdk",
    fetch: createClaudeCodeFetch(),
  });

  return (modelId: string): LanguageModel => {
    return provider(modelId) as unknown as LanguageModel;
  };
}
