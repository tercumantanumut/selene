/**
 * Agent Definition Mapper
 *
 * Converts Selene AgentTemplate objects to the Claude Agent SDK's AgentDefinition
 * format so they can be passed to the SDK's `agents` option in query() calls.
 *
 * This enables SDK-native multi-agent delegation via the Task tool: when the SDK
 * spawns a subagent, it will use the system prompt and tool restrictions defined
 * in the Selene system agent templates.
 */

import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { AgentTemplate } from "@/lib/characters/templates/types";
import { SYSTEM_AGENT_TEMPLATES } from "@/lib/characters/templates/system-agents";

// ---------------------------------------------------------------------------
// Tool name mapping
// ---------------------------------------------------------------------------

/**
 * Maps Selene-native tool names to the nearest Claude Agent SDK built-in tool
 * names (PascalCase, as expected by AgentDefinition.tools).
 *
 * Custom Selene tools (vectorSearch, memorize, skill, scheduleTask, etc.)
 * have no direct SDK equivalent and are omitted; the SDK will fall back to its
 * own tool-use rules for those capabilities.
 */
const SELENE_TO_SDK_TOOL: Readonly<Record<string, string>> = {
  readFile: "Read",
  editFile: "Edit",
  writeFile: "Write",
  patchFile: "Edit",
  bash: "Bash",
  executeCommand: "Bash",
  localGrep: "Grep",
  webSearch: "WebSearch",
  webFetch: "WebFetch",
};

/**
 * Maps an array of Selene tool names to their SDK equivalents.
 * Returns `undefined` if none of the tools have a known SDK mapping
 * (the SDK will then inherit all tools from the parent context).
 */
export function mapSeleneToolsToSdk(seleneTools: string[]): string[] | undefined {
  const seen = new Set<string>();
  const sdkTools: string[] = [];

  for (const tool of seleneTools) {
    const sdkName = SELENE_TO_SDK_TOOL[tool];
    if (sdkName && !seen.has(sdkName)) {
      seen.add(sdkName);
      sdkTools.push(sdkName);
    }
  }

  return sdkTools.length > 0 ? sdkTools : undefined;
}

// ---------------------------------------------------------------------------
// Converter
// ---------------------------------------------------------------------------

/**
 * Converts a single Selene AgentTemplate to a Claude Agent SDK AgentDefinition.
 *
 * - `description` — shown to the parent model when deciding which agent to use
 * - `prompt` — the agent's system prompt (maps to AgentTemplate.purpose)
 * - `tools` — SDK-mapped subset of the agent's enabled tools (may be undefined)
 * - `model` — always "inherit" so the agent uses the caller's model
 */
export function templateToAgentDefinition(template: AgentTemplate): AgentDefinition {
  return {
    description: template.tagline,
    prompt: template.purpose,
    model: "inherit",
    ...(template.enabledTools.length > 0
      ? { tools: mapSeleneToolsToSdk(template.enabledTools) }
      : {}),
  };
}

/**
 * Returns all system agent templates as a `Record<agentId, AgentDefinition>`
 * compatible with the SDK's `agents` option. The record keys are the system
 * agent IDs (e.g. "system-explore", "system-plan").
 */
export function systemAgentsToSdkAgents(): Record<string, AgentDefinition> {
  const result: Record<string, AgentDefinition> = {};
  for (const template of SYSTEM_AGENT_TEMPLATES) {
    result[template.id] = templateToAgentDefinition(template);
  }
  return result;
}

/**
 * Returns a subset of system agents as SDK AgentDefinitions, filtered by their IDs.
 */
export function systemAgentsToSdkAgentsById(
  ids: string[]
): Record<string, AgentDefinition> {
  const idSet = new Set(ids);
  const result: Record<string, AgentDefinition> = {};
  for (const template of SYSTEM_AGENT_TEMPLATES) {
    if (idSet.has(template.id)) {
      result[template.id] = templateToAgentDefinition(template);
    }
  }
  return result;
}
