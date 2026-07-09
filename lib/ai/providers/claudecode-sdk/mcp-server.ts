/**
 * Selene Platform MCP Server for Claude Agent SDK
 *
 * Creates an in-process MCP server (via createSdkMcpServer) that bridges
 * Selene's ToolRegistry and per-agent MCP servers to the Claude Agent SDK.
 *
 * This lets the SDK agent see and call all Selene platform tools (vectorSearch,
 * memorize, skill, scheduleTask, etc.) and any MCP server tools configured
 * for the active agent — not just Claude Code's built-in tools.
 *
 * Tool exposure rules:
 *  - Built-in ToolRegistry tools: exposed if env-enabled + passes enabledTools filter
 *  - alwaysLoad utility tools (searchTools): always exposed
 *  - MCP tools: scoped to the active agent's enabledMcpServers / enabledMcpTools
 *  - Deferred loading: non-alwaysLoad tools require searchTools discovery first
 *  - Rich outputs (image/video URLs) are forwarded to ctx.onRichOutput
 */

import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { ToolRegistry } from "@/lib/ai/tool-registry/registry";
// Lazy imports to break the cycle:
// providers → claudecode-sdk/provider → claudecode-sdk/mcp-server → mcp-tool-adapter → client-manager → ... → providers
// providers → claudecode-sdk/provider → claudecode-sdk/mcp-server → search-tool → providers
async function loadMcpToolAdapter() {
  return import("@/lib/ai/tool-registry/mcp-tool-adapter");
}
async function loadSearchTool() {
  return import("@/lib/ai/tool-registry/search-tool");
}
import type { ToolSearchContext } from "@/lib/ai/tool-registry/search-tool";
import type { SeleneMcpContext } from "../mcp-context-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a Zod raw shape from a Vercel AI SDK Tool's inputSchema.
 *
 * Vercel AI SDK v6 has two schema styles:
 *   1. `z.object(...)` — a ZodObject with `.shape: Record<string, ZodTypeAny>`.
 *   2. `jsonSchema(...)` — a `Schema<T>` wrapper with `.jsonSchema: JSONSchema7`.
 *
 * If neither form is recognised the tool gets an empty shape ({}).
 */
function zodShapeFromInputSchema(inputSchema: unknown): Record<string, z.ZodTypeAny> {
  if (!inputSchema || typeof inputSchema !== "object") return {};

  // Case 1: ZodObject — has .shape
  if (
    "shape" in inputSchema &&
    (inputSchema as { shape: unknown }).shape !== null &&
    typeof (inputSchema as { shape: unknown }).shape === "object"
  ) {
    return (inputSchema as { shape: Record<string, z.ZodTypeAny> }).shape;
  }

  // Case 2: Vercel AI jsonSchema() wrapper — has .jsonSchema (raw JSONSchema7)
  if ("jsonSchema" in inputSchema) {
    const raw = (inputSchema as { jsonSchema: unknown }).jsonSchema;
    if (raw && typeof raw === "object") {
      return jsonSchemaToZodShape(raw as Record<string, unknown>);
    }
  }

  return {};
}

/**
 * Convert a simple JSON Schema object (type:object with properties) into a
 * Zod raw shape. Used for MCP tools whose schemas come in JSON Schema format.
 * Non-required fields are made optional.
 */
function jsonSchemaToZodShape(
  schema: Record<string, unknown>
): Record<string, z.ZodTypeAny> {
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (!properties || typeof properties !== "object") return {};

  const required = new Set<string>(
    Array.isArray(schema.required) ? (schema.required as string[]) : []
  );

  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(properties)) {
    if (!prop || typeof prop !== "object") {
      shape[key] = z.unknown().optional();
      continue;
    }

    const p = prop as Record<string, unknown>;
    let zodType: z.ZodTypeAny;

    switch (p.type) {
      case "string":
        zodType = z.string();
        break;
      case "number":
      case "integer":
        zodType = z.number();
        break;
      case "boolean":
        zodType = z.boolean();
        break;
      case "array":
        zodType = z.array(z.unknown());
        break;
      case "object":
        zodType = z.record(z.unknown());
        break;
      default:
        zodType = z.unknown();
    }

    if (!required.has(key)) {
      zodType = zodType.optional();
    }

    shape[key] = zodType;
  }

  return shape;
}

/**
 * Wrap any Vercel AI / raw tool result into the MCP CallToolResult shape
 * expected by createSdkMcpServer tool handlers.
 */
function toCallToolResult(
  result: unknown
): { content: Array<{ type: "text"; text: string }> } {
  const text =
    typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

function toCallToolError(
  err: unknown
): { content: Array<{ type: "text"; text: string }>; isError: boolean } {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

/**
 * Detect whether a tool result contains rich media outputs (image/video URLs).
 */
function extractRichOutputs(result: unknown): string[] {
  const urls: string[] = [];

  function scan(value: unknown) {
    if (typeof value === "string") {
      // data URIs (e.g. data:image/png;base64,...)
      if (value.startsWith("data:image/") || value.startsWith("data:video/")) {
        urls.push(value);
      }
      // Common URL field values ending in media extensions
      if (/\.(png|jpg|jpeg|gif|webp|mp4|webm|mov)(\?.*)?$/i.test(value) &&
          (value.startsWith("http") || value.startsWith("/api/media/"))) {
        urls.push(value);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) scan(item);
    } else if (value && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) scan(v);
    }
  }

  scan(result);
  return urls;
}

let sdkToolCallCounter = 0;

function nextSdkToolCallId(toolName: string): string {
  sdkToolCallCounter += 1;
  return `sdk_${toolName}_${Date.now()}_${sdkToolCallCounter}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build an in-process MCP server that exposes all Selene platform tools
 * available for the current agent to the Claude Agent SDK.
 *
 * Call this once per SDK query — the underlying MCP server is lightweight
 * (no subprocess, no network) and is garbage-collected when the query ends.
 */
export async function createSeleneSdkMcpServer(
  ctx: SeleneMcpContext
): Promise<McpSdkServerConfigWithInstance> {
  const { getMCPToolsForAgent, getMCPToolId } = await loadMcpToolAdapter();
  const { createToolSearchTool } = await loadSearchTool();
  const registry = ToolRegistry.getInstance();

  const enabledSet = ctx.enabledTools ? new Set(ctx.enabledTools) : null;

  // Companion-tool enforcement: bash and executeCommand are coupled by the
  // stub-retrieval protocol. Promote executeCommand whenever bash is enabled.
  if (enabledSet && enabledSet.has("bash") && !enabledSet.has("executeCommand")) {
    enabledSet.add("executeCommand");
    console.log(
      "[SeleneMcpServer] Companion-tool enforcement: promoted executeCommand into enabledSet because bash is enabled"
    );
  }

  const factoryOpts = {
    sessionId: ctx.sessionId,
    userId: ctx.userId,
    characterId: ctx.characterId ?? undefined,
    onExecuteCommandProgress: ctx.onExecuteCommandProgress,
  };

  const useDeferredMode = ctx.toolLoadingMode === "deferred";

  // ── Session-scoped activation state for deferred loading ──────────────────
  const alwaysLoadMcpSet = new Set(ctx.alwaysLoadMcpToolIds ?? []);
  const activatedTools = new Set<string>([
    ...(ctx.previouslyDiscoveredTools ?? []),
  ]);

  const sdkTools: SdkMcpToolDefinition<any>[] = [];

  // ── Bridge: ToolSearchContext for searchTools ──────────────────────────
  // Uses the SDK's `activatedTools` Set as both initialActiveTools and
  // discoveredTools (same reference), so isAvailable reflects activation state
  // and searchTools.execute() adds discovered tools directly to activatedTools.
  const sdkToolSearchContext: ToolSearchContext = {
    initialActiveTools: activatedTools,
    discoveredTools: activatedTools,
    enabledTools: enabledSet ?? undefined,
    enableAnthropicToolReferences: false,
  };

  // ── Tools handled natively by the Claude Agent SDK ──────────────────────
  const SDK_NATIVE_TOOL_SUPPRESSIONS = new Set(["askUserQuestion"]);

  // ── 1. Built-in ToolRegistry tools (non-MCP) ────────────────────────────
  for (const name of registry.getToolNames()) {
    if (SDK_NATIVE_TOOL_SUPPRESSIONS.has(name)) continue;

    const registeredTool = registry.get(name);
    if (!registeredTool) continue;

    // Skip MCP tools — handled separately below with proper agent scoping
    if (registeredTool.metadata.category === "mcp") continue;

    // Skip tools disabled by environment variable
    if (!registry.isToolEnabled(name)) continue;

    // Per-agent filtering: alwaysLoad tools always pass through
    const isAlwaysLoad = registeredTool.metadata.loading.alwaysLoad === true;
    if (enabledSet && !isAlwaysLoad && !enabledSet.has(name)) continue;

    // Pre-seed alwaysLoad tools into the activated set
    if (isAlwaysLoad) {
      activatedTools.add(name);
    }

    try {
      const isSearchTools = name === "searchTools";

      let toolInstance: ReturnType<typeof registeredTool.factory>;
      if (isSearchTools) {
        toolInstance = createToolSearchTool(sdkToolSearchContext);
      } else {
        toolInstance = registeredTool.factory(factoryOpts);
      }

      const inputSchema = zodShapeFromInputSchema(toolInstance.inputSchema);
      const description =
        toolInstance.description ??
        registeredTool.metadata.shortDescription;

      sdkTools.push({
        name,
        description,
        inputSchema,
        ...(registeredTool.metadata.mcpAnnotations
          ? { annotations: registeredTool.metadata.mcpAnnotations }
          : {}),
        handler: async (args: Record<string, unknown>) => {
          try {
            // Force background mode for delegateToSubagent start actions in the
            // MCP path so parallel delegations don't serialize.
            if (
              name === "delegateToSubagent" &&
              args.action === "start" &&
              !args.mode
            ) {
              args = { ...args, mode: "background" };
            }

            const toolCallId = nextSdkToolCallId(name);
            const result = await (toolInstance as any).execute?.(args, { toolCallId });

            // searchTools: explicitly activate any tool names returned.
            if (isSearchTools && result != null && typeof result === "object") {
              const sr = result as { results?: Array<{ name?: string; resultType?: string }> };
              if (Array.isArray(sr.results)) {
                for (const r of sr.results) {
                  if (r.name && typeof r.name === "string" && r.resultType === "tool") {
                    activatedTools.add(r.name);
                  }
                }
              }
            }

            // Rich output detection
            if (ctx.onRichOutput) {
              const richUrls = extractRichOutputs(result);
              if (richUrls.length > 0) {
                ctx.onRichOutput(toolCallId, name, result);
              }
            }

            return toCallToolResult(result);
          } catch (err) {
            return toCallToolError(err);
          }
        },
      });
    } catch (err) {
      console.warn(`[SeleneMcpServer] Failed to instantiate tool "${name}":`, err);
    }
  }

  // ── 2. Per-agent MCP tools (scoped via getMCPToolsForAgent) ───────────────
  let mcpTools: ReturnType<typeof getMCPToolsForAgent> = [];
  try {
    mcpTools = getMCPToolsForAgent(ctx.enabledMcpServers, ctx.enabledMcpTools);
  } catch (err) {
    console.warn("[SeleneMcpServer] getMCPToolsForAgent failed, no MCP tools exposed:", err);
  }

  // Add MCP tool IDs to enabledTools so searchTools can discover them
  if (sdkToolSearchContext.enabledTools) {
    for (const mcpTool of mcpTools) {
      const toolId = getMCPToolId(mcpTool.serverName, mcpTool.name);
      sdkToolSearchContext.enabledTools.add(toolId);
    }
  }

  for (const mcpTool of mcpTools) {
    const toolId = getMCPToolId(mcpTool.serverName, mcpTool.name);
    const inputSchema = jsonSchemaToZodShape(
      (mcpTool.inputSchema as Record<string, unknown>) ?? {}
    );
    const description =
      mcpTool.description ?? `MCP tool from ${mcpTool.serverName}`;

    const isMcpAlwaysLoad = alwaysLoadMcpSet.has(toolId);
    if (isMcpAlwaysLoad) {
      activatedTools.add(toolId);
    }

    sdkTools.push({
      name: toolId,
      description,
      inputSchema,
      handler: async (args: Record<string, unknown>) => {
        try {
          // Import lazily to avoid circular deps
          const { MCPClientManager } = await import("@/lib/mcp/client-manager");
          const { formatMCPToolResult } = await import("@/lib/mcp/result-formatter");
          const mcpManager = MCPClientManager.getInstance();
          const rawResult = await mcpManager.executeTool(
            mcpTool.serverName,
            mcpTool.name,
            args
          );

          // Format result: converts base64 data URIs → /api/media/ URLs.
          const formattedResult = await formatMCPToolResult(
            mcpTool.serverName,
            mcpTool.name,
            rawResult
          );

          if (ctx.onRichOutput) {
            const richUrls = extractRichOutputs(formattedResult);
            if (richUrls.length > 0) {
              const toolCallId = nextSdkToolCallId(toolId);
              ctx.onRichOutput(toolCallId, toolId, formattedResult);
            }
          }

          return toCallToolResult(formattedResult);
        } catch (err) {
          return toCallToolError(err);
        }
      },
    });
  }

  const builtInCount = sdkTools.length - mcpTools.length;
  console.log(
    `[SeleneMcpServer] Exposing ${sdkTools.length} tools to SDK agent` +
    ` (${builtInCount} built-in, ${mcpTools.length} MCP)` +
    (useDeferredMode
      ? `, deferred mode: ${activatedTools.size} pre-activated`
      : ", always mode: all tools active")
  );

  return createSdkMcpServer({
    name: "selene-platform",
    version: "1.0.0",
    tools: sdkTools,
  });
}
