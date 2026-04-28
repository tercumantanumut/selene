/**
 * Base System Prompt Builder
 *
 * Creates minimal, efficient system prompts for AI agents.
 * Focuses on core identity and universal behaviors.
 * Task-specific instructions live in tool descriptions.
 */

import { getTemporalContextBlock } from "../datetime-context";
import {
  MEDIA_DISPLAY_RULES,
  LANGUAGE_HANDLING,
  RESPONSE_STYLE,
  DOING_TASKS,
  EXECUTING_WITH_CARE,
  WORKFLOW_SUBAGENT_BASELENE,
  TOOL_USAGE_RULES,
  TOOL_DISCOVERY_MINIMAL,
  TOOL_DISCOVERY_ALWAYS,
  MULTI_IMAGE_TOOL_USAGE,
  combineBlocks,
} from "./shared-blocks";
import type { CacheableSystemBlock } from "../cache/types";

export interface BaseSystemPromptOptions {
  /** Agent's display name */
  agentName: string;
  /** Brief role description */
  agentRole: string;
  /** Optional personality/vibe description */
  agentVibe?: string;
  /** Optional personality traits */
  personalityTraits?: string[];
  /** Whether to include tool discovery instructions */
  includeToolDiscovery?: boolean;
  /** Tool loading strategy (deferred = prompt mentions searchTools, always = tools already loaded) */
  toolLoadingMode?: "deferred" | "always";
  /** Additional context to append (e.g., character memories, custom instructions) */
  additionalContext?: string;
  /** Enable prompt caching for system blocks (Anthropic-compatible providers) */
  enableCaching?: boolean;
}

function buildCoreIdentity(options: Pick<BaseSystemPromptOptions, "agentName" | "agentRole" | "agentVibe" | "personalityTraits">): string {
  const identityParts: string[] = [`You are ${options.agentName}, ${options.agentRole}.`];
  if (options.agentVibe) {
    identityParts.push(`**Vibe:** ${options.agentVibe}`);
  }
  if (options.personalityTraits && options.personalityTraits.length > 0) {
    identityParts.push(`**Personality:** ${options.personalityTraits.join(", ")}`);
  }
  return identityParts.join("\n");
}

/**
 * Build a minimal, efficient base system prompt.
 *
 * Structure (~500 tokens total):
 * 1. Temporal context (~150 tokens)
 * 2. Core identity (~50 tokens)
 * 3. Response style (~80 tokens)
 * 4. Language handling (~50 tokens)
 * 5. Media display rules (~100 tokens)
 * 6. Tool discovery hint (~70 tokens, optional)
 */
function buildBaseSystemPrompt(options: BaseSystemPromptOptions): string {
  const {
    includeToolDiscovery = true,
    toolLoadingMode = "deferred",
    additionalContext,
  } = options;

  const coreIdentity = buildCoreIdentity(options);

  // Assemble the prompt
  const sections = [
    coreIdentity,
    RESPONSE_STYLE,
    DOING_TASKS,
    EXECUTING_WITH_CARE,
    WORKFLOW_SUBAGENT_BASELENE,
    LANGUAGE_HANDLING,
    MEDIA_DISPLAY_RULES,
    TOOL_USAGE_RULES,
    MULTI_IMAGE_TOOL_USAGE,
  ];

  // Add tool discovery if enabled
  if (includeToolDiscovery) {
    sections.push(toolLoadingMode === "always" ? TOOL_DISCOVERY_ALWAYS : TOOL_DISCOVERY_MINIMAL);
  }

  // Add any additional context
  if (additionalContext) {
    sections.push(additionalContext);
  }

  // Temporal context at the bottom for recency bias
  sections.push(getTemporalContextBlock());

  return combineBlocks(...sections);
}

/**
 * Default Selene agent configuration
 */
const DEFAULT_AGENT_CONFIG: BaseSystemPromptOptions = {
  agentName: "Selene",
  agentRole: `a powerful AI agent on the Selene platform — an open-source, self-hosted agent platform with rich capabilities including:
- **Tools & Plugins**: Extensible tool system with plugin marketplace, hooks lifecycle (PreToolUse/PostToolUse), and MCP server integration
- **Skills**: Reusable, parameterized prompt templates with version history and execution tracking
- **Multi-Agent Workflows**: Agent delegation with initiator/subagent roles, shared resources, and observe/continue/stop operations
- **Synced Folders**: Vector-powered semantic search over synced folder contents with hybrid retrieval
- **Channels**: Native integration with Telegram, WhatsApp, Slack, and Discord — with voice transcription, attachments, and formatting
- **Image & Video Generation**: Multiple backends (Flux.2, GPT-5 Image, Gemini, local ComfyUI) for text-to-image, editing, virtual try-on, and video assembly
- **Agent Memory**: Auto-extracted patterns and preferences that persist across conversations
- **Codebase Tools**: File read/write/edit, shell execution, ripgrep search, git worktree management
- **Deep Research**: Multi-step research workflows with planning, search, analysis, and synthesis
- **Scheduling**: Cron, interval, and one-time task scheduling with template variables
- **Speech**: Text-to-speech synthesis and voice note transcription via Whisper`,
  agentVibe: "Capable, direct, and resourceful — oriented toward getting real work done",
  personalityTraits: [
    "Creative & practical — offers suggestions and alternatives when helpful, but keeps solutions focused",
  ],
  includeToolDiscovery: true,
};

/**
 * Build the default Selene agent system prompt
 */
export function buildDefaultSystemPrompt(
  options: { includeToolDiscovery?: boolean; toolLoadingMode?: "deferred" | "always" } = {}
): string {
  return buildBaseSystemPrompt({
    ...DEFAULT_AGENT_CONFIG,
    includeToolDiscovery: options.includeToolDiscovery ?? true,
    toolLoadingMode: options.toolLoadingMode ?? "deferred",
  });
}

/**
 * Build system prompt as cacheable blocks for Anthropic prompt caching.
 * Returns array format with cache_control markers.
 *
 * Cache structure:
 * 1. Temporal context (changes daily, not cached)
 * 2. Core identity + response rules (static, highly cacheable)
 * 3. Tool discovery (optional, changes with mode)
 * 4. Additional context (character memories, etc., cacheable)
 *
 * @see https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
 */
function buildCacheableSystemPrompt(
  options: BaseSystemPromptOptions
): CacheableSystemBlock[] {
  const {
    includeToolDiscovery = true,
    toolLoadingMode = "deferred",
    additionalContext,
    enableCaching = false,
  } = options;

  const blocks: CacheableSystemBlock[] = [];

  const coreIdentity = buildCoreIdentity(options);

  // Block 1: Core identity + response rules (static, highly cacheable)
  const staticBlocks = combineBlocks(
    coreIdentity,
    RESPONSE_STYLE,
    DOING_TASKS,
    EXECUTING_WITH_CARE,
    WORKFLOW_SUBAGENT_BASELENE,
    LANGUAGE_HANDLING,
    MEDIA_DISPLAY_RULES,
    TOOL_USAGE_RULES,
    MULTI_IMAGE_TOOL_USAGE
  );

  blocks.push({
    role: "system",
    content: staticBlocks,
    // Cache this block if caching is enabled
    ...(enableCaching && {
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
      },
    }),
  });

  // Block 3: Tool discovery (optional, changes with mode)
  if (includeToolDiscovery) {
    blocks.push({
      role: "system",
      content: toolLoadingMode === "always" ? TOOL_DISCOVERY_ALWAYS : TOOL_DISCOVERY_MINIMAL,
    });
  }

  // Block 4: Additional context (character memories, etc.)
  if (additionalContext) {
    blocks.push({
      role: "system",
      content: additionalContext,
      // Cache additional context if enabled (character instructions are stable)
      ...(enableCaching && {
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
        },
      }),
    });
  }

  // Temporal context at the bottom for recency bias (changes daily, not cached)
  blocks.push({
    role: "system",
    content: getTemporalContextBlock(),
  });

  return blocks;
}

/**
 * Build the default Selene agent system prompt as cacheable blocks
 */
export function buildDefaultCacheableSystemPrompt(
  options: {
    includeToolDiscovery?: boolean;
    toolLoadingMode?: "deferred" | "always";
    enableCaching?: boolean;
  } = {}
): CacheableSystemBlock[] {
  return buildCacheableSystemPrompt({
    ...DEFAULT_AGENT_CONFIG,
    includeToolDiscovery: options.includeToolDiscovery ?? true,
    toolLoadingMode: options.toolLoadingMode ?? "deferred",
    enableCaching: options.enableCaching ?? false,
  });
}
