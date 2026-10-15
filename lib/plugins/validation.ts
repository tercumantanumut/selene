/**
 * Plugin System Validation Schemas
 *
 * Zod schemas for validating plugin manifests, hook configs,
 * marketplace manifests, and import data.
 */

import { z } from "zod";

// =============================================================================
// Plugin Manifest Validation
// =============================================================================

const pluginAuthorSchema = z.object({
  name: z.string().min(1).max(200),
  // Real-world plugins have comma-separated emails, URLs, etc. — don't validate format
  email: z.string().max(500).optional(),
  url: z.string().max(500).optional(),
}).passthrough();

const hookHandlerSchema = z.object({
  type: z.enum(["command", "prompt", "agent"]),
  command: z.string().max(4096).optional(),
  timeout: z.number().int().positive().max(3600).optional(),
  statusMessage: z.string().max(500).optional(),
});

const hookEntrySchema = z.object({
  matcher: z.string().max(500).optional(),
  hooks: z.array(hookHandlerSchema).min(1).max(50),
});

const hookEventTypeSchema = z.enum([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "TeammateIdle",
  "TaskCompleted",
  "PreCompact",
  "SessionEnd",
]);

export const pluginHooksConfigSchema = z.object({
  hooks: z.partialRecord(hookEventTypeSchema, z.array(hookEntrySchema)).optional().default({}),
  description: z.string().optional(),
}).passthrough();

const pluginMCPServerEntrySchema = z.object({
  command: z.string().max(4096).optional(),
  args: z.array(z.string().max(4096)).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  type: z.enum(["http", "sse", "stdio"]).optional(),
});

const pluginLSPServerEntrySchema = z.object({
  command: z.string().min(1).max(4096),
  args: z.array(z.string().max(4096)).optional(),
  extensionToLanguage: z.record(z.string().min(1), z.string().min(1)),
});

export const pluginManifestSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/, "Plugin name must be kebab-case"),
  description: z.string().min(1).max(5000),
  version: z.string().min(1).max(50),
  author: pluginAuthorSchema.optional(),
  homepage: z.string().url().optional(),
  repository: z.string().url().optional(),
  license: z.string().max(50).optional(),
  keywords: z.array(z.string().max(80)).max(20).optional(),
  category: z.string().max(80).optional(),
  commands: z.union([z.string(), z.array(z.string())]).optional(),
  skills: z.union([z.string(), z.array(z.string())]).optional(),
  agents: z.union([z.string(), z.array(z.string())]).optional(),
  hooks: z.union([z.string(), pluginHooksConfigSchema]).optional(),
  mcpServers: z.union([z.string(), z.record(z.string(), pluginMCPServerEntrySchema)]).optional(),
  lspServers: z.union([z.string(), z.record(z.string(), pluginLSPServerEntrySchema)]).optional(),
}).passthrough();

// =============================================================================
// Marketplace Validation
// =============================================================================

const pluginSourceGitHubSchema = z.object({
  source: z.literal("github"),
  repo: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
  ref: z.string().optional(),
  sha: z.string().length(40).optional(),
});

const pluginSourceURLSchema = z.object({
  source: z.literal("url"),
  url: z.string().url(),
  ref: z.string().optional(),
  sha: z.string().length(40).optional(),
});

const pluginSourceNPMSchema = z.object({
  source: z.literal("npm"),
  package: z.string().min(1),
  version: z.string().optional(),
  registry: z.string().url().optional(),
});

const pluginSourcePIPSchema = z.object({
  source: z.literal("pip"),
  package: z.string().min(1),
  version: z.string().optional(),
  registry: z.string().url().optional(),
});

const pluginSourceSchema = z.union([
  pluginSourceGitHubSchema,
  pluginSourceURLSchema,
  pluginSourceNPMSchema,
  pluginSourcePIPSchema,
]);

const marketplacePluginEntrySchema = z.object({
  name: z.string().min(1).max(120),
  source: z.union([z.string(), pluginSourceSchema]),
  description: z.string().max(5000).optional(),
  version: z.string().max(50).optional(),
  author: pluginAuthorSchema.optional(),
  homepage: z.string().url().optional(),
  repository: z.string().url().optional(),
  license: z.string().max(50).optional(),
  keywords: z.array(z.string().max(80)).max(20).optional(),
  category: z.string().max(80).optional(),
  tags: z.array(z.string().max(80)).max(20).optional(),
  strict: z.boolean().optional().default(true),
  commands: z.union([z.string(), z.array(z.string())]).optional(),
  agents: z.union([z.string(), z.array(z.string())]).optional(),
  hooks: z.union([z.string(), pluginHooksConfigSchema]).optional(),
  mcpServers: z.union([z.string(), z.record(z.string(), pluginMCPServerEntrySchema)]).optional(),
  lspServers: z.union([z.string(), z.record(z.string(), pluginLSPServerEntrySchema)]).optional(),
});

export const marketplaceManifestSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/, "Marketplace name must be kebab-case"),
  owner: pluginAuthorSchema,
  metadata: z
    .object({
      description: z.string().max(5000).optional(),
      version: z.string().max(50).optional(),
      pluginRoot: z.string().max(500).optional(),
    })
    .optional(),
  plugins: z.array(marketplacePluginEntrySchema).max(500),
});

// Reserved marketplace names that cannot be used by third parties.
export const RESERVED_MARKETPLACE_NAMES = new Set([
  "claude-code-marketplace",
  "claude-code-plugins",
  "claude-plugins-official",
  "anthropic-marketplace",
  "anthropic-plugins",
  "agent-skills",
  "life-sciences",
]);

// =============================================================================
// Hook Input Validation
// =============================================================================

export const preToolUseHookInputSchema = z.object({
  hook_type: z.literal("PreToolUse"),
  tool_name: z.string().min(1),
  tool_input: z.record(z.string(), z.unknown()),
  session_id: z.string().optional(),
});

export const postToolUseHookInputSchema = z.object({
  hook_type: z.literal("PostToolUse"),
  tool_name: z.string().min(1),
  tool_input: z.record(z.string(), z.unknown()),
  tool_output: z.unknown().optional(),
  session_id: z.string().optional(),
});

export const postToolUseFailureHookInputSchema = z.object({
  hook_type: z.literal("PostToolUseFailure"),
  tool_name: z.string().min(1),
  tool_input: z.record(z.string(), z.unknown()),
  error: z.string(),
  session_id: z.string().optional(),
});
