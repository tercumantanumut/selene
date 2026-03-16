/**
 * Character System Prompt Builder
 *
 * Builds dynamic system prompts for user-created agents.
 * Uses shared blocks from lib/ai/prompts for consistency.
 */

import type { CharacterFull } from "@/lib/db/schema";
import { getTemporalContextBlock } from "./datetime-context";
import { formatMemoriesForPrompt } from "@/lib/agent-memory";
import { formatSkillsForPromptFromSummary } from "@/lib/skills/prompt-injection";
import {
  MEDIA_DISPLAY_RULES,
  RESPONSE_STYLE,
  DOING_TASKS,
  EXECUTING_WITH_CARE,
  WORKFLOW_SUBAGENT_BASELENE,
  LANGUAGE_HANDLING,
  TOOL_USAGE_RULES,
  TOOL_DISCOVERY_MINIMAL,
  TOOL_DISCOVERY_ALWAYS,
  MULTI_IMAGE_TOOL_USAGE,
  getChannelFormattingBlock,
} from "./prompts";
import { combineBlocks, getToolExecutionReliabilityBlock } from "./prompts/shared-blocks";
import type { CacheableSystemBlock } from "./cache/types";

/**
 * Gets the primary avatar URL for a character
 */
export function getCharacterAvatarUrl(character: CharacterFull): string | null {
  if (!character.images || character.images.length === 0) return null;

  // Find primary image first
  const primaryImage = character.images.find(img => img.isPrimary);
  if (primaryImage) return primaryImage.url;

  // Fallback to first portrait or avatar type
  const portraitOrAvatar = character.images.find(
    img => img.imageType === "portrait" || img.imageType === "avatar"
  );
  if (portraitOrAvatar) return portraitOrAvatar.url;

  // Fallback to first image
  return character.images[0]?.url || null;
}

function getSkillSummariesFromMetadata(metadata: Record<string, any>): Array<{
  id: string;
  name: string;
  description: string;
}> {
  const raw = metadata.skills;
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((skill): skill is Record<string, unknown> => !!skill && typeof skill === "object")
    .map((skill) => ({
      id: String(skill.id || ""),
      name: String(skill.name || "").trim(),
      description: String(skill.description || "").trim(),
      triggerExamples: Array.isArray(skill.triggerExamples)
        ? skill.triggerExamples.map((value) => String(value || "").trim()).filter((value) => value.length > 0).slice(0, 3)
        : [],
    }))
    .filter((skill) => skill.name.length > 0);
}

/**
 * Builds a dynamic system prompt from character data
 * Used for user-created agents on Styly Agents
 */
export function buildCharacterSystemPrompt(
  character: CharacterFull,
  options: {
    toolLoadingMode?: "deferred" | "always";
    channelType?: string | null;
    skillSummaries?: Array<{ id: string; name: string; description: string; triggerExamples?: string[] }>;
  } = {}
): string {
  // Check for custom prompt override first
  const metadata = character.metadata as Record<string, any> || {};
  if (metadata.systemPromptOverride && typeof metadata.systemPromptOverride === "string" && metadata.systemPromptOverride.trim()) {
    console.log(`[Character Prompt] Using custom system prompt override for ${character.name}`);
    const channelBlock = getChannelFormattingBlock(options.channelType);
    return channelBlock ? `${metadata.systemPromptOverride}\n\n${channelBlock}` : metadata.systemPromptOverride;
  }

  const sections: string[] = [];

  // Agent identity
  sections.push(`You are an AI agent named ${character.name}${character.displayName ? ` (also known as "${character.displayName}")` : ""}.`);

  if (character.tagline) {
    sections.push(character.tagline);
  }

  // Build agent profile section
  const profileParts: string[] = [];

  profileParts.push(`## Agent Profile\n`);
  profileParts.push(`**Name:** ${character.name}`);
  if (character.displayName) {
    profileParts.push(`**Also Known As:** ${character.displayName}`);
  }

  // Include avatar URL so the character knows what they look like
  const avatarUrl = getCharacterAvatarUrl(character);
  if (avatarUrl) {
    profileParts.push(`**Your Avatar Image URL:** ${avatarUrl}`);
  }

  // Add metadata/purpose if available
  if (metadata.purpose) {
    profileParts.push(`**Your Purpose:** ${metadata.purpose}`);
  }

  sections.push(profileParts.join("\n"));

  // Agent Memory - learned preferences and patterns
  const { markdown: memoryMarkdown, tokenEstimate, memoryCount } = formatMemoriesForPrompt(character.id);
  if (memoryMarkdown) {
    sections.push(memoryMarkdown);
    console.log(`[Character Prompt] Injected ${memoryCount} memories (~${tokenEstimate} tokens) for ${character.name}`);
  }

  const skillSummaries = options.skillSummaries || getSkillSummariesFromMetadata(metadata);
  if (skillSummaries.length > 0) {
    const skillBlock = formatSkillsForPromptFromSummary(skillSummaries);
    if (skillBlock.markdown) {
      sections.push(skillBlock.markdown);
      sections.push(
        [
          "## Skill Matching Guidance",
          "- If the user asks for a workflow, campaign, template, playbook, or other reusable task, check for related skills first.",
          "- Use `runSkill` action=\"list\" to discover available skills when needed.",
          "- Use `runSkill` action=\"run\" when a user request clearly matches a skill trigger example.",
          "- Use `updateSkill` for create/patch/replace/metadata/copy/archive operations.",
          "- If multiple skills match, ask a brief clarification before running.",
          "- If confidence is low, ask for confirmation instead of auto-running.",
        ].join("\n")
      );
      console.log(
        `[Character Prompt] Injected ${skillBlock.skillCount} skills (~${skillBlock.tokenEstimate} tokens) for ${character.name}`
      );
    }
  }

  // Universal guidelines from shared blocks
  sections.push(RESPONSE_STYLE);
  sections.push(DOING_TASKS);
  sections.push(EXECUTING_WITH_CARE);
  sections.push(WORKFLOW_SUBAGENT_BASELENE);
  sections.push(LANGUAGE_HANDLING);
  sections.push(MEDIA_DISPLAY_RULES);
  sections.push(TOOL_USAGE_RULES);
  sections.push(options.toolLoadingMode === "always" ? TOOL_DISCOVERY_ALWAYS : TOOL_DISCOVERY_MINIMAL);

  // Tool execution reliability hint (env-gated)
  const reliabilityBlock = getToolExecutionReliabilityBlock();
  if (reliabilityBlock) {
    sections.push(reliabilityBlock);
  }

  sections.push(MULTI_IMAGE_TOOL_USAGE); // Multi-image guidance for edit/reference tools

  // Channel-aware formatting guidance (prevents broken Markdown in chat apps)
  const channelBlock = getChannelFormattingBlock(options.channelType);
  if (channelBlock) {
    sections.push(channelBlock);
  }

  // Prepend temporal context for accurate date/time awareness
  const temporalContext = getTemporalContextBlock();
  return `${temporalContext}\n\n${sections.join("\n\n")}`;
}

/**
 * Builds a cacheable character system prompt as blocks for Anthropic prompt caching.
 * Returns array format with cache_control markers on stable content.
 *
 * Cache structure:
 * 1. Temporal context (changes daily, not cached)
 * 2. Character identity + profile (static, highly cacheable)
 * 3. Agent memories (updates periodically, cacheable)
 * 4. Universal guidelines (static, highly cacheable)
 *
 * @see https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
 */
export function buildCacheableCharacterPrompt(
  character: CharacterFull,
  options: {
    toolLoadingMode?: "deferred" | "always";
    channelType?: string | null;
    enableCaching?: boolean;
    skillSummaries?: Array<{ id: string; name: string; description: string; triggerExamples?: string[] }>;
  } = {}
): CacheableSystemBlock[] {
  const {
    toolLoadingMode = "deferred",
    channelType,
    enableCaching = false,
  } = options;

  // Check for custom prompt override first
  const metadata = (character.metadata as Record<string, any>) || {};
  if (metadata.systemPromptOverride && typeof metadata.systemPromptOverride === "string" && metadata.systemPromptOverride.trim()) {
    console.log(`[Character Prompt] Using custom system prompt override for ${character.name} (cacheable)`);
    return [{
      role: "system",
      content: metadata.systemPromptOverride,
      ...(enableCaching && {
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
        },
      }),
    }];
  }

  const blocks: CacheableSystemBlock[] = [];

  // Block 1: Temporal context (changes daily, not cached)
  blocks.push({
    role: "system",
    content: getTemporalContextBlock(),
  });

  // Block 2: Character identity + profile (HIGHLY CACHEABLE)
  const identityParts: string[] = [];

  identityParts.push(
    `You are an AI agent named ${character.name}${
      character.displayName ? ` (also known as "${character.displayName}")` : ""
    }.`
  );

  if (character.tagline) {
    identityParts.push(character.tagline);
  }

  // Build agent profile section
  const profileParts: string[] = [`## Agent Profile\n`];
  profileParts.push(`**Name:** ${character.name}`);
  if (character.displayName) {
    profileParts.push(`**Also Known As:** ${character.displayName}`);
  }

  // Include avatar URL so the character knows what they look like
  const avatarUrl = getCharacterAvatarUrl(character);
  if (avatarUrl) {
    profileParts.push(`**Your Avatar Image URL:** ${avatarUrl}`);
  }

  // Add metadata/purpose if available (metadata already declared at top)
  if (metadata.purpose) {
    profileParts.push(`**Your Purpose:** ${metadata.purpose}`);
  }

  identityParts.push(profileParts.join("\n"));

  blocks.push({
    role: "system",
    content: identityParts.join("\n\n"),
    // Cache character identity (stable, rarely changes)
    ...(enableCaching && {
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
      },
    }),
  });

  // Block 3: Agent Memory (if available, CACHEABLE)
  const { markdown: memoryMarkdown, tokenEstimate, memoryCount } =
    formatMemoriesForPrompt(character.id);

  if (memoryMarkdown) {
    blocks.push({
      role: "system",
      content: memoryMarkdown,
      // Cache memories (they update periodically, not every request)
      ...(enableCaching && {
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
        },
      }),
    });
    console.log(
      `[Character Prompt] Injected ${memoryCount} memories (~${tokenEstimate} tokens) for ${character.name}`
    );
  }

  const skillSummaries = options.skillSummaries || getSkillSummariesFromMetadata(metadata);
  if (skillSummaries.length > 0) {
    const skillBlock = formatSkillsForPromptFromSummary(skillSummaries);
    if (skillBlock.markdown) {
      blocks.push({
        role: "system",
        content: skillBlock.markdown,
        ...(enableCaching && {
          providerOptions: {
            anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
          },
        }),
      });
      blocks.push({
        role: "system",
        content: [
          "## Skill Matching Guidance",
          "- Use `runSkill` action=\"list\" to discover available skills when needed.",
          "- Use `runSkill` action=\"run\" when a user request clearly matches a skill trigger example.",
          "- Use `updateSkill` for create/patch/replace/metadata/copy/archive operations.",
          "- If multiple skills match, ask a brief clarification before running.",
          "- If confidence is low, ask for confirmation instead of auto-running.",
        ].join("\n"),
      });
      console.log(
        `[Character Prompt] Injected ${skillBlock.skillCount} skills (~${skillBlock.tokenEstimate} tokens) for ${character.name} (cacheable)`
      );
    }
  }

  // Block 4: Universal guidelines (static, highly cacheable)
  const guidelines = combineBlocks(
    RESPONSE_STYLE,
    DOING_TASKS,
    EXECUTING_WITH_CARE,
    WORKFLOW_SUBAGENT_BASELENE,
    LANGUAGE_HANDLING,
    MEDIA_DISPLAY_RULES,
    TOOL_USAGE_RULES,
    toolLoadingMode === "always" ? TOOL_DISCOVERY_ALWAYS : TOOL_DISCOVERY_MINIMAL,
    getToolExecutionReliabilityBlock(),
    MULTI_IMAGE_TOOL_USAGE
  );

  blocks.push({
    role: "system",
    content: guidelines,
    // Cache guidelines (never change)
    ...(enableCaching && {
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
      },
    }),
  });

  const channelBlock = getChannelFormattingBlock(channelType);
  if (channelBlock) {
    blocks.push({
      role: "system",
      content: channelBlock,
    });
  }

  return blocks;
}

/**
 * Combines character prompt with tool-specific instructions
 */
export interface CharacterPromptOptions {
  character: CharacterFull;
  geminiEnabled?: boolean;
  flux2Enabled?: boolean;
  toolInstructions?: string;
  toolLoadingMode?: "deferred" | "always";
}

export function buildFullSystemPrompt(options: CharacterPromptOptions): string {
  const { character, toolInstructions, toolLoadingMode } = options;

  let prompt = buildCharacterSystemPrompt(character, { toolLoadingMode });

  if (toolInstructions) {
    prompt += "\n\n" + toolInstructions;
  }

  return prompt;
}
