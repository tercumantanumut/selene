import { beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "@/lib/ai/tool-registry/registry";
import {
  authorizeRuntimeLoadedTools,
  createToolSearchTool,
} from "@/lib/ai/tool-registry/search-tool";

function registerBaseTool(name: string) {
  ToolRegistry.getInstance().register(
    name,
    {
      displayName: name,
      category: "utility",
      keywords: [name.toLowerCase()],
      shortDescription: `${name} tool`,
      loading: { alwaysLoad: true },
      requiresSession: false,
    },
    () => ({} as any)
  );
}

describe("createToolSearchTool", () => {
  beforeEach(() => {
    ToolRegistry.reset();
  });

  it("supports exact select syntax", async () => {
    const registry = ToolRegistry.getInstance();
    registerBaseTool("searchTools");

    registry.register(
      "localGrep",
      {
        displayName: "Local Grep",
        category: "knowledge",
        keywords: ["grep", "pattern"],
        searchHint: "search local files with ripgrep",
        shortDescription: "exact text search",
        loading: { deferLoading: true },
        requiresSession: false,
      },
      () => ({} as any)
    );

    registry.register(
      "vectorSearch",
      {
        displayName: "Vector Search",
        category: "knowledge",
        keywords: ["semantic", "vector"],
        searchHint: "semantic search the codebase",
        shortDescription: "semantic search",
        loading: { deferLoading: true },
        requiresSession: false,
      },
      () => ({} as any)
    );

    const searchTool = createToolSearchTool({
      initialActiveTools: new Set(["searchTools"]),
      discoveredTools: new Set<string>(),
      enabledTools: new Set(["localGrep", "vectorSearch"]),
    }) as any;

    const result = await searchTool.execute({
      query: "select:vectorSearch,localGrep",
      limit: 5,
    });

    expect(result.status).toBe("success");
    expect(result.results.map((tool: { name: string }) => tool.name)).toEqual([
      "vectorSearch",
      "localGrep",
    ]);
  });

  it("applies required-term filtering", async () => {
    const registry = ToolRegistry.getInstance();
    registerBaseTool("searchTools");

    registry.register(
      "sendMessageToChannel",
      {
        displayName: "Send Message",
        category: "utility",
        keywords: ["send", "message", "telegram", "slack"],
        searchHint: "send messages to external channels",
        shortDescription: "message a connected channel",
        loading: { deferLoading: true },
        requiresSession: false,
      },
      () => ({} as any)
    );

    registry.register(
      "webSearch",
      {
        displayName: "Web Search",
        category: "search",
        keywords: ["search", "web", "internet"],
        searchHint: "search the web",
        shortDescription: "search the internet",
        loading: { deferLoading: true },
        requiresSession: false,
      },
      () => ({} as any)
    );

    const searchTool = createToolSearchTool({
      initialActiveTools: new Set(["searchTools"]),
      discoveredTools: new Set<string>(),
      enabledTools: new Set(["sendMessageToChannel", "webSearch"]),
    }) as any;

    const result = await searchTool.execute({ query: "+slack send", limit: 5 });

    expect(result.status).toBe("success");
    expect(result.results.map((tool: { name: string }) => tool.name)).toEqual([
      "sendMessageToChannel",
    ]);
  });

  it("discovers deferred MCP tools by native exact name and namespace", async () => {
    const registry = ToolRegistry.getInstance();
    registerBaseTool("searchTools");

    registry.register(
      "mcp_supabase_execute_sql",
      {
        displayName: "Execute Sql",
        category: "mcp",
        keywords: ["execute_sql", "supabase", "mcp", "external", "database", "sql"],
        shortDescription: "Execute SQL against the Supabase project",
        loading: { deferLoading: true, defaultPolicy: "deferred" },
        requiresSession: false,
      },
      () => ({} as any)
    );

    const discoveredTools = new Set<string>();
    const searchTool = createToolSearchTool({
      initialActiveTools: new Set(["searchTools"]),
      discoveredTools,
      enabledTools: new Set(["mcp_supabase_execute_sql"]),
    }) as any;

    const byToolName = await searchTool.execute({
      query: "select:execute_sql",
      category: "mcp",
      limit: 5,
    });

    expect(byToolName.status).toBe("success");
    expect(byToolName.results.map((tool: { name: string }) => tool.name)).toEqual([
      "mcp_supabase_execute_sql",
    ]);
    expect(discoveredTools.has("mcp_supabase_execute_sql")).toBe(true);

    const byNamespace = await searchTool.execute({
      query: "select:supabase:execute_sql",
      category: "mcp",
      limit: 5,
    });

    expect(byNamespace.status).toBe("success");
    expect(byNamespace.results.map((tool: { name: string }) => tool.name)).toEqual([
      "mcp_supabase_execute_sql",
    ]);
  });

  it("does not let stale pre-load disabled policy block runtime-loaded MCP tools", async () => {
    const registry = ToolRegistry.getInstance();
    registerBaseTool("searchTools");

    registry.register(
      "mcp_supabase_list_tables",
      {
        displayName: "List Tables",
        category: "mcp",
        keywords: ["list_tables", "supabase", "mcp", "external", "database", "tables"],
        shortDescription: "List Supabase database tables",
        loading: { deferLoading: true, defaultPolicy: "deferred" },
        requiresSession: false,
      },
      () => ({} as any)
    );

    const context = {
      initialActiveTools: new Set(["searchTools"]),
      discoveredTools: new Set<string>(),
      enabledTools: new Set(["searchTools"]),
      disabledTools: new Set(["mcp_supabase_list_tables"]),
      resolvedPolicies: new Map([
        [
          "mcp_supabase_list_tables",
          {
            policy: "disabled" as const,
            initiallyActive: false,
            discoverable: false,
            authorized: false,
            reason: "not-enabled" as const,
          },
        ],
      ]),
    };
    const searchTool = createToolSearchTool(context) as any;

    // Mirrors the chat builder after loadMCPToolsForCharacter reports the
    // connector's deferred tool as callable for this agent.
    authorizeRuntimeLoadedTools(context, ["mcp_supabase_list_tables"]);

    const result = await searchTool.execute({
      query: "list_tables",
      category: "mcp",
      limit: 5,
    });

    expect(result.status).toBe("success");
    expect(result.results.map((tool: { name: string }) => tool.name)).toEqual([
      "mcp_supabase_list_tables",
    ]);
    expect(context.discoveredTools.has("mcp_supabase_list_tables")).toBe(true);
    expect(result.results[0].isAvailable).toBe(true);
  });

  it("emits Anthropic tool references for deferred matches", async () => {
    const registry = ToolRegistry.getInstance();
    registerBaseTool("searchTools");

    registry.register(
      "localGrep",
      {
        displayName: "Local Grep",
        category: "knowledge",
        keywords: ["grep", "pattern"],
        searchHint: "search local files with ripgrep",
        shortDescription: "exact text search",
        loading: { deferLoading: true },
        requiresSession: false,
      },
      () => ({} as any)
    );

    const searchTool = createToolSearchTool({
      initialActiveTools: new Set(["searchTools"]),
      discoveredTools: new Set<string>(),
      enabledTools: new Set(["localGrep"]),
      enableAnthropicToolReferences: true,
    }) as any;

    const result = await searchTool.execute({ query: "grep", limit: 5 });
    const modelOutput = await searchTool.toModelOutput({
      toolCallId: "tc1",
      input: { query: "grep", limit: 5 },
      output: result,
    });

    expect(modelOutput.type).toBe("content");
    expect(modelOutput.value[0].type).toBe("text");
    expect(modelOutput.value[1].type).toBe("custom");
    expect(modelOutput.value[1].providerOptions.anthropic.type).toBe("tool-reference");
    expect(modelOutput.value[1].providerOptions.anthropic.toolName).toBe("localGrep");
  });

  it("falls back to JSON model output when subagent results are present", async () => {
    const registry = ToolRegistry.getInstance();
    registerBaseTool("searchTools");

    const searchTool = createToolSearchTool({
      initialActiveTools: new Set(["searchTools"]),
      discoveredTools: new Set<string>(),
      enabledTools: new Set<string>(),
      enableAnthropicToolReferences: true,
      subagentDirectory: [
        "- Session Search (id: agent-1): Find relevant sessions from chat history",
      ],
    }) as any;

    const result = await searchTool.execute({ query: "session", limit: 5 });
    const modelOutput = await searchTool.toModelOutput({
      toolCallId: "tc2",
      input: { query: "session", limit: 5 },
      output: result,
    });

    expect(modelOutput.type).toBe("json");
  });
});
