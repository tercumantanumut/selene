import { z } from "zod";

// ============================================================================
// ENUM SCHEMAS
// ============================================================================

const characterStatusSchema = z.enum(["draft", "active", "archived"]);

const characterImageTypeSchema = z.enum([
  "portrait", "full_body", "expression", "outfit", "scene", "avatar"
]);

// ============================================================================
// BASE CHARACTER SCHEMA
// ============================================================================

export const createCharacterSchema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Name too long"),
  displayName: z.string().max(100).optional(),
  tagline: z.string().max(200).optional(),
  isDefault: z.boolean().optional().default(false),
});

export const updateCharacterSchema = createCharacterSchema.partial().extend({
  status: characterStatusSchema.optional(),
});

// ============================================================================
// CHARACTER IMAGE SCHEMA
// ============================================================================

const characterImageSchema = z.object({
  imageType: characterImageTypeSchema,
  isPrimary: z.boolean().optional().default(false),
  s3Key: z.string().min(1),
  url: z.string().url(),
  thumbnailUrl: z.string().url().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  format: z.string().max(20).optional(),
  prompt: z.string().max(2000).optional(),
  seed: z.number().optional(),
  generationModel: z.string().max(50).optional(),
  sortOrder: z.number().int().optional().default(0),
  metadata: z.record(z.unknown()).optional().default({}),
});

// ============================================================================
// AGENT METADATA SCHEMA (B2B Agent Configuration)
// ============================================================================

/**
 * Agent metadata for B2B agent configuration.
 * Stored in characters.metadata JSON column.
 */
const workflowRoleSchema = z.enum(["initiator", "subagent"]);

const workflowSandboxPolicySchema = z.object({
  allowSharedFolders: z.boolean().default(true),
  allowSharedMcp: z.boolean().default(true),
  allowSharedHooks: z.boolean().default(true),
});

const inheritedResourcesSchema = z.object({
  syncFolderIds: z.array(z.string()).default([]),
  pluginIds: z.array(z.string()).default([]),
  mcpServerNames: z.array(z.string()).default([]),
  hookEvents: z.array(z.string()).default([]),
});

const pluginAgentSeedSchema = z.object({
  sourcePath: z.string().max(500).optional(),
  description: z.string().max(2000).optional(),
  purpose: z.string().max(2000).optional(),
  systemPromptSeed: z.string().max(8000).optional(),
  tags: z.array(z.string().max(120)).optional(),
});

const toolLoadingPreferenceSchema = z.enum(["always", "deferred"]);

export const agentMetadataSchema = z.object({
  /** List of enabled tool names for this agent */
  enabledTools: z.array(z.string()).optional(),
  /** Per-enabled-tool initial loading preference. Authorization still comes from enabledTools. */
  toolLoadingPreferences: z.record(z.string(), toolLoadingPreferenceSchema).optional(),
  /** Internal migration guard for per-tool initial loading preferences */
  toolLoadingPolicyMigrationApplied: z.boolean().optional(),
  /** Optional cache/fallback list of enabled plugin IDs for this agent */
  enabledPlugins: z.array(z.string()).optional(),
  /** Agent's purpose/responsibilities description */
  purpose: z.string().max(2000).optional(),
  /** Custom system prompt override (replaces auto-generated prompt if provided) */
  systemPromptOverride: z.string().max(50000).optional(),
  /** Catalog ID of the selected agent template, for traceability */
  selectedTemplateId: z.string().max(200).optional(),

  /** Per-agent defaults for provider/model selection */
  modelConfig: z.object({
    provider: z.enum(["anthropic", "openrouter", "antigravity", "codex", "kimi", "minimax", "blackboxai", "ollama", "claudecode"]).optional(),
    chatModel: z.string().max(200).optional(),
    researchModel: z.string().max(200).optional(),
    visionModel: z.string().max(200).optional(),
    utilityModel: z.string().max(200).optional(),
  }).optional(),

  /** Whether this is a system specialist agent (auto-provisioned) */
  isSystemAgent: z.boolean().optional(),
  /** The specialist type, e.g. "explore", "plan", "command" */
  systemAgentType: z.string().optional(),

  /**
   * Per-agent MCP configuration
   * Can override or extend global MCP servers
   */
  mcpServers: z.object({
    mcpServers: z.record(z.object({
      type: z.enum(["http", "sse", "stdio"]).optional(),
      url: z.string().optional(),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string()).optional(),
      headers: z.record(z.string()).optional(),
      timeout: z.number().optional(),
    })),
  }).optional(),

  /**
   * Which MCP servers are enabled for this agent
   * If not specified, all configured servers are enabled
   */
  enabledMcpServers: z.array(z.string()).optional(),

  /**
   * Which MCP tools are enabled for this agent
   * Format: "serverName:toolName"
   * If not specified, all tools from enabled servers are available
   */
  enabledMcpTools: z.array(z.string()).optional(),

  /**
   * Per-MCP-tool preferences for loading behavior
   * Key format: "serverName:toolName"
   */
  mcpToolPreferences: z.record(
    z.string(),  // Key: "serverName:toolName"
    z.object({
      /** Whether this specific tool is enabled (overrides server-level enablement) */
      enabled: z.boolean().default(true),
      /** Loading mode: "always" loads immediately, "deferred" requires discovery */
      loadingMode: z.enum(["always", "deferred"]).default("deferred"),
      /** Preferred visual tool card mode for this MCP tool in chat UIs */
      displayMode: z.enum(["compact", "detailed"]).default("compact"),
    })
  ).optional(),

  /** Internal marker set when user explicitly configures MCP selections for this agent */
  mcpUserConfigured: z.boolean().optional(),

  /** Internal migration guard to avoid reapplying default MCP disable logic repeatedly */
  defaultMcpDisableMigrationApplied: z.boolean().optional(),

  /** Workflow linkage for plugin-created sub-agents */
  workflowId: z.string().optional(),
  workflowRole: workflowRoleSchema.optional(),
  workflowSandboxPolicy: workflowSandboxPolicySchema.optional(),
  inheritedResources: inheritedResourcesSchema.optional(),
  pluginAgentSeed: pluginAgentSeedSchema.optional(),

  /**
   * Per-agent 3D avatar configuration
   * Selects which GLB model and body type to use for TalkingHead.js
   */
  avatarConfig: z.object({
    source: z.enum(["preset", "custom"]),
    presetId: z.string().optional(),
    modelUrl: z.string(),
    bodyType: z.enum(["M", "F"]),
  }).optional(),

  /**
   * Whether task scheduling is enabled for this agent
   * When enabled, the agent can use the scheduleTask tool
   */
  schedulingEnabled: z.boolean().optional().default(false),

  /**
   * Scheduling preferences for this agent
   */
  schedulingPreferences: z.object({
    /** Tool loading mode: "always" includes scheduleTask in initial context, "deferred" requires discovery */
    loadingMode: z.enum(["always", "deferred"]).default("deferred"),
    /** Maximum concurrent scheduled tasks for this agent */
    maxConcurrent: z.number().min(1).max(10).default(1),
    /** Default timezone for scheduled tasks */
    defaultTimezone: z.string().default("UTC"),
  }).optional(),
});

// ============================================================================
// TYPE EXPORTS
// ============================================================================

type CreateCharacterInput = z.infer<typeof createCharacterSchema>;
type UpdateCharacterInput = z.infer<typeof updateCharacterSchema>;
type CharacterImageInput = z.infer<typeof characterImageSchema>;
export type AgentMetadata = z.infer<typeof agentMetadataSchema>;
