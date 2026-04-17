/**
 * Tool Definitions
 *
 * Register all tools with the ToolRegistry along with their metadata.
 * This centralizes tool configuration and enables the Tool Search pattern.
 *
 * LOADING STRATEGY (optimized for token efficiency):
 * - alwaysLoad: true  → Core tools that must always be available:
 *   - searchTools: Required for discovering other tools
 *   - compactSession: Explicit agent-controlled context compaction
 *   - describeImage: Essential for virtual try-on workflows
 * - deferLoading: true → All other tools (discovered on-demand via searchTools)
 *
 * CRITICAL: searchTools MUST have alwaysLoad: true.
 * Without it, the AI cannot discover other tools and will output raw
 * function call syntax as plain text instead of executing tools.
 *
 * This saves ~2,500 tokens per request by deferring tool descriptions until needed.
 * Tools are discoverable via searchTools and loaded dynamically when the AI needs them.
 */

import { tool, jsonSchema } from "ai";
import { ToolRegistry } from "./registry";
import type { ToolMetadata } from "./types";
import { createToolSearchTool } from "./search-tool";
import {
  createDescribeImageTool,
  createRetrieveFullContentTool,
} from "../tools";
import { createWebSearchTool } from "../web-search";
import { createFirecrawlCrawlTool } from "../firecrawl";
import { createVectorSearchToolV2 } from "../vector-search";
import { createReadFileTool } from "../tools/read-file-tool";
import { createLocalGrepTool } from "../ripgrep";
import { createSpeakAloudTool } from "../tools/speak-aloud-tool";
import { createTranscribeTool } from "../tools/transcribe-tool";
import { createSendMessageToChannelTool } from "../tools/channel-tools";
import { createDelegateToSubagentTool } from "../tools/delegate-to-subagent-tool";
import { createCompactSessionTool } from "../tools/compact-session-tool";
import { createSearchSessionsTool } from "../tools/search-sessions-tool";
import { createGhostOsPreflightTool } from "../tools/ghost-os-preflight-tool";
import { registerCollaborationTools } from "./register-collaboration-tools";
import { registerImageAndVideoTools } from "./register-image-video-tools";

/**
 * Register all tools with the registry
 * Call this once during app initialization
 */
export function registerAllTools(): void {
  const registry = ToolRegistry.getInstance();

  // ============================================================
  // CORE UTILITY TOOLS - Always loaded (required for tool discovery)
  // ============================================================

  // Tool Search - MUST be alwaysLoad to enable tool discovery
  registry.register(
    "searchTools",
    {
      displayName: "Search Tools",
      category: "utility",
      keywords: [
        "search",
        "discover",
        "tools",
        "capabilities",
        "list",
        "exploration",
      ],
      shortDescription:
        "Search for available tools and discover capabilities like image generation or code search",
      loading: { alwaysLoad: true }, // CRITICAL: Must always be available to discover other tools
      requiresSession: false,
    } satisfies ToolMetadata,
    () => createToolSearchTool()
  );

  // Retrieve Full Content - allows AI to access full untruncated content
  // This tool is always loaded because truncation notices reference it directly
  registry.register(
    "retrieveFullContent",
    {
      displayName: "Retrieve Full Content",
      category: "utility",
      keywords: [
        "retrieve",
        "full",
        "content",
        "truncated",
        "expand",
        "complete",
        "text",
      ],
      shortDescription:
        "⚠️ NOT for file reading! Only retrieves truncated content with trunc_XXXXXXXX IDs. Use readFile for actual files.",
      loading: { deferLoading: true }, // Only visible when truncation occurs in session
      requiresSession: true, // Requires session to retrieve stored content
    } satisfies ToolMetadata,
    // Placeholder factory - real instance with sessionId is created in chat route
    () =>
      createRetrieveFullContentTool({
        sessionId: "UNSCOPED",
      })
  );

  // Compact Session - explicit, agent-controlled context compaction
  registry.register(
    "compactSession",
    {
      displayName: "Compact Session",
      category: "utility",
      keywords: [
        "compact",
        "compaction",
        "context",
        "context window",
        "token budget",
        "summarize history",
        "free tokens",
      ],
      shortDescription:
        "Run explicit session compaction to free context tokens before long workflows",
      loading: { alwaysLoad: true },
      requiresSession: true,
    } satisfies ToolMetadata,
    ({ sessionId }) =>
      createCompactSessionTool({
        sessionId: sessionId || "UNSCOPED",
      })
  );

  // Search Sessions - discover past conversations
  registry.register(
    "searchSessions",
    {
      displayName: "Search Sessions",
      category: "utility",
      keywords: [
        "session", "sessions", "conversation", "history", "past", "previous",
        "find", "search", "chat", "thread", "recall", "context",
      ],
      shortDescription:
        "Search past sessions by title, message content, channel, agent, or date range",
      fullInstructions: `## Search Sessions

Search and filter past conversations. Returns session metadata and summaries (no full message dump).

**Filters:** query (title + message-content search by default), characterName, channelType (app/whatsapp/telegram/slack/discord), dateRange (today/week/month/all), includeMessageContent (default true).
**Use when:** user asks "what did we discuss about X?", "find my Telegram chats", "recent sessions with agent Y", or "search what we did yesterday".
**Limit:** Max 50 results per call. Default 20.`,
      loading: { deferLoading: true },
      requiresSession: true,
      mcpAnnotations: { readOnlyHint: true },
    } satisfies ToolMetadata,
    ({ sessionId, userId }) =>
      createSearchSessionsTool({
        sessionId: sessionId || "UNSCOPED",
        userId: userId || "UNSCOPED",
      })
  );

  // Vector Search Tool V2 (LLM-powered intelligent search over synced folders)
  registry.register(
    "vectorSearch",
    {
      displayName: "Vector Search (AI-Powered)",
      category: "knowledge",
      keywords: [
        "vector",
        "vectorSearch",
        "semantic",
        "search",
        "similarity",
        "embeddings",
        "folders",
        "files",
        "local",
        "rag",
        "lancedb",
        "code",
        "codebase",
        "intelligent",
        "exploration",
        "analysis",
        "structure",
        "file structure",
        "hierarchy",
        "tree",
        // Cross-category keywords for better discovery
        "grep",
        "find",
        "locate",
        "project",
        "source",
      ],
      shortDescription:
        "Intelligent semantic search across your codebase with AI-powered result synthesis",
      fullInstructions: `## Vector Search (AI-Powered Codebase Search)

Semantic + keyword hybrid search with AI synthesis. Finds code by concept, not just text.

**Query format:** Always phrase as a short question with keywords.
- Good: "Where is getUserById implemented?" / "How are errors handled in API routes?"
- Bad: "getUserById" (bare keyword) or "database issue" (vague)
- Max 5 searches per request; stop once you have context.

**Tips:**
- Default maxResults=50 is fastest; increase to 150 only for broad coverage
- Higher minScore = more precise, fewer results
- Use follow-up questions to refine; check suggested refinements`,
      loading: { deferLoading: true },
      requiresSession: true,  // Needs session for LLM synthesis
    } satisfies ToolMetadata,
    ({ sessionId, characterId }) =>
      createVectorSearchToolV2({
        sessionId: sessionId || "UNSCOPED",
        userId: "UNSCOPED",
        characterId: characterId ?? null,
      })
  );

  // Read File Tool (read files from synced folders)
  registry.register(
    "readFile",
    {
      displayName: "Read File",
      category: "knowledge",
      keywords: [
        "read",
        "file",
        "content",
        "source",
        "code",
        "full",
        "context",
        "lines",
        "import",
        "export",
        "follow",
        "document",
        "markdown",
        "analysis",
        "codebase",
      ],
      shortDescription:
        "Read full file content from synced folders",
      fullInstructions: `## Read File

Read full file content or line ranges from synced folders.

**Sources:** Synced folders (paths from vectorSearch or localGrep).
**Limits:** Max 1MB / 5000 lines. Use startLine/endLine for larger files.

**When to use:** After vectorSearch finds snippets and you need full context, or to follow imports/exports.`,
      loading: { alwaysLoad: true },
      requiresSession: true,
    } satisfies ToolMetadata,
    ({ sessionId, characterId }) =>
      createReadFileTool({
        sessionId: sessionId || "UNSCOPED",
        userId: "UNSCOPED",
        characterId: characterId ?? null,
      })
  );

  // Local Grep Tool (ripgrep - fast exact/regex pattern search)
  registry.register(
    "localGrep",
    {
      displayName: "Local Grep (ripgrep)",
      category: "knowledge",
      keywords: [
        "grep",
        "localGrep",
        "local grep",
        "search",
        "pattern",
        "regex",
        "exact",
        "ripgrep",
        "find",
        "text",
        "code",
        "literal",
        "rg",
        "match",
        "string",
        "analysis",
        "exploration",
        "scan",
        "codebase",
        "file search",
        "code search",
      ],
      shortDescription:
        "Fast exact or regex pattern search across files using ripgrep",
      fullInstructions: `## Local Grep (ripgrep)

Fast EXACT text/regex search. Use for function names, imports, symbol tracing, specific patterns.
Use vectorSearch instead for conceptual/intent-based queries where you don't know exact wording.

Start narrow to avoid noisy output: set specific \`paths\`/\`fileTypes\`, keep \`maxResults\` near 20, then expand only if needed.

**Examples:** \`localGrep({ pattern: "getUserById", maxResults: 20 })\` / \`localGrep({ pattern: "async.*await", regex: true, fileTypes: ["ts", "tsx"], maxResults: 20 })\``,
      loading: { alwaysLoad: true },
      requiresSession: true,
    } satisfies ToolMetadata,
    ({ sessionId, characterId }) =>
      createLocalGrepTool({
        sessionId: sessionId || "UNSCOPED",
        characterId: characterId ?? null,
      })
  );

  // Collaboration + editing tools (command execution, file edits, planning, skills, workspace)
  registerCollaborationTools(registry);


  // ============================================================
  // VOICE & AUDIO TOOLS - Deferred (discovered via searchTools)
  // ============================================================

  // Speak Aloud Tool - Text-to-Speech synthesis
  registry.register(
    "speakAloud",
    {
      displayName: "Speak Aloud",
      category: "utility",
      keywords: [
        "voice", "speak", "say", "read aloud", "tts", "text to speech",
        "audio", "listen", "sound", "narrate", "pronounce",
      ],
      shortDescription: "Synthesize text to speech audio using the configured TTS provider",
      fullInstructions: `## Speak Aloud

Text-to-speech using configured TTS provider. Use when user asks to "read aloud", "say this", or "speak".
TTS must be enabled in Settings → Voice & Audio. Audio plays automatically in desktop UI.`,
      loading: { deferLoading: true },
      requiresSession: true,
    } satisfies ToolMetadata,
    ({ sessionId }) => createSpeakAloudTool({ sessionId: sessionId || "UNSCOPED" })
  );

  // Transcribe Tool - Audio transcription status
  registry.register(
    "transcribe",
    {
      displayName: "Transcribe Audio",
      category: "utility",
      keywords: [
        "transcribe", "transcription", "stt", "speech to text",
        "voice note", "audio", "whisper", "dictation",
      ],
      shortDescription: "Check channel voice note transcription status (WhatsApp, Telegram, Slack, Discord)",
      fullInstructions: `## Transcribe

Audio transcription status. Voice notes (WhatsApp, Telegram, Slack, Discord) are auto-transcribed via Whisper — no manual trigger needed.`,
      loading: { deferLoading: true },
      requiresSession: true,
    } satisfies ToolMetadata,
    ({ sessionId }) => createTranscribeTool({ sessionId: sessionId || "UNSCOPED" })
  );

  // Send Message to Channel Tool
  registry.register(
    "sendMessageToChannel",
    {
      displayName: "Send Message to Channel",
      category: "utility",
      keywords: [
        "message", "send", "channel", "telegram", "slack", "whatsapp",
        "notify", "dm", "direct message", "contact",
      ],
      shortDescription: "Send a direct message to the user via connected external channels",
      fullInstructions: `## Send Message to Channel
      
      Send a message to the user via Telegram, Slack, or WhatsApp.
      Use when the user asks to be notified or messaged externally.
      
      If channelType is omitted, it tries to reply to the current channel conversation or finds the most recent active connection.`,
      loading: { deferLoading: true },
      requiresSession: true,
    } satisfies ToolMetadata,
    ({ sessionId, userId }) =>
      createSendMessageToChannelTool({
        sessionId: sessionId || "UNSCOPED",
        userId: userId || "UNSCOPED",
        sessionMetadata: {},
      })
  );

  // Delegate to Sub-Agent Tool (workflow inter-agent communication)
  registry.register(
    "delegateToSubagent",
    {
      displayName: "Delegate to Sub-Agent",
      category: "utility",
      keywords: [
        "delegate", "subagent", "sub-agent", "workflow", "agent", "team",
        "assign", "task", "collaborate", "orchestrate",
      ],
      shortDescription: "Delegate a task to a workflow sub-agent and receive their response",
      fullInstructions: `## Delegate to Sub-Agent

Delegate work to a workflow sub-agent. Use this when tasks are multi-step, parallelizable,
or better handled by a subagent's stated purpose.

Only available to initiator role in an active workflow.

Required sequence:
1) \`list\` - refresh available sub-agents and active delegations.
2) \`start\` - target by \`agentId\` or \`agentName\`, send precise task.
3) \`observe\` - check progress and collect response (prefer \`waitSeconds\` like 30/60/600).
4) If \`observe\` reports \`pendingInteractivePrompts\`, use \`answer\` with the matching \`toolUseId\` and answers.
5) \`continue\` or \`stop\` - refine or cancel existing delegation.

Rules:
- Do not start duplicate delegations to the same subagent while one is active.
- Reuse existing \`delegationId\` with \`observe\` / \`answer\` / \`continue\` / \`stop\`.
- Include constraints and expected output format in task text.

Compatibility options:
- \`runInBackground\`: default true. If false on \`start\`, tool performs start + observe wait in one call.
- \`resume\`: compatibility alias for existing \`delegationId\` (maps to \`continue\` semantics).

Examples:
- \`{ action: "start", agentName: "Research Analyst", task: "Summarize API docs changes with risks and next actions." }\`
- \`{ action: "observe", delegationId: "del-123", waitSeconds: 60 }\`
- \`{ action: "answer", delegationId: "del-123", toolUseId: "toolu_123", answers: { "Proceed?": "Continue and confirm generation" } }\`
- \`{ action: "continue", delegationId: "del-123", followUpMessage: "Focus only on migration risks." }\``,
      loading: { deferLoading: true },
      requiresSession: true,
    } satisfies ToolMetadata,
    ({ sessionId, userId, characterId, provider }) =>
      createDelegateToSubagentTool({
        sessionId: sessionId || "UNSCOPED",
        userId: userId || "UNSCOPED",
        characterId: characterId || "UNSCOPED",
        provider,
      })
  );

  // Describe Image Tool (ALWAYS LOADED - essential for virtual try-on workflows)
  // CRITICAL: This tool uses the configured vision model (Claude/OpenRouter) to analyze images.
  // ALWAYS use this before making assumptions about user photos, clothing, rooms, or any visual content.
  registry.register(
    "describeImage",
    {
      displayName: "Describe Image",
      category: "analysis",
      keywords: [
        "analyze", "describe", "vision", "understand", "see", "look",
        "person", "photo", "portrait", "selfie", "user photo",
        "room", "layout", "interior", "space",
        "product", "clothing", "outfit", "fashion", "style",
        "gender", "appearance", "body type", "skin tone",
        "identify", "recognize", "detect",
        "image", "virtual", "try-on", "try on", "tryon"
      ],
      shortDescription: "Analyze any image using vision AI - people, rooms, products, clothing. ALWAYS use before making assumptions about visual content.",
      fullInstructions: `## Describe Image (Vision AI)

⚠️ **MUST call FIRST** before virtual try-on, furniture visualization, or any task where you'd guess visual details.
Skipping → wrong gender/body assumptions → poor edit results.

**Analysis types:** person (appearance/body/style), room (layout/materials), product (type/color/material), general.

**Workflow:** describeImage → use analysis in editImage prompt to ensure accurate results. Never assume — always analyze first.`,
      loading: { deferLoading: true },
      requiresSession: false,
      // No enableEnvVar - uses getVisionModel() which falls back to Claude (always available)
    } satisfies ToolMetadata,
    (context) => createDescribeImageTool(context.sessionId)
  );

  // Unified Web Search Tool (action-based: search + browse + synthesize)
  registry.register(
    "webSearch",
    {
      displayName: "Web Search",
      category: "search",
      keywords: [
        "web",
        "search",
        "browse",
        "internet",
        "url",
        "fetch",
        "read",
        "synthesize",
        "current",
        "news",
        "facts",
      ],
      shortDescription: "Search and browse web content with action modes",
      fullInstructions: `## Web Search

Use one tool with explicit actions:

- \`action: "search"\` → find URLs/snippets
- \`action: "browse"\` + \`urls\` → fetch full page content
- \`action: "synthesize"\` + \`urls\` + \`query\` → analyze fetched pages

Recommended flow: search once, then browse selected URLs. Use crawl tool only for whole-site traversal.`,
      loading: { deferLoading: true },
      requiresSession: false,
      // No enableEnvVar — DuckDuckGo + local scraper fallback keeps it available
    } satisfies ToolMetadata,
    () => createWebSearchTool()
  );

  // Crawl Website Tool (standalone for multi-page crawling)
  registry.register(
    "firecrawlCrawl",
    {
      displayName: "Crawl Website",
      category: "search",
      keywords: [
        "crawl",
        "website",
        "site map",
        "multiple pages",
        "docs crawl",
        "traverse",
      ],
      shortDescription: "Crawl multiple pages from a website",
      fullInstructions: `## Crawl Website

Use this only when you need to traverse many pages from a site section.
For normal query-driven discovery and reading, use Web Search actions first.`,
      loading: { deferLoading: true },
      requiresSession: false,
    } satisfies ToolMetadata,
    ({ sessionId }) => createFirecrawlCrawlTool(sessionId)
  );

  // Image + video generation/editing registrations
  registerImageAndVideoTools(registry);

  // ============================================================
  // PRODUCT GALLERY TOOL - Display product images for selection
  // ============================================================

  // Show Product Images Tool (always loaded - essential for shopping & try-on UX)
  registry.register(
    "showProductImages",
    {
      displayName: "Product Gallery",
      category: "utility",
      keywords: [
        "product",
        "image",
        "gallery",
        "show",
        "display",
        "preview",
        "shopping",
        "try-on",
        "reference",
        "find",
        "recommend",
        "buy",
        "purchase",
        "floor tiles",
        "furniture",
        "clothing",
        "decor",
      ],
      shortDescription:
        "REQUIRED: Display products with images and purchase links for ALL shopping/product queries",
      fullInstructions: `## Product Gallery — MANDATORY for product queries

**ALWAYS call** after finding products via webSearch. Never skip when you have product info.

**Workflow:** webSearch (extract images/prices/URLs) → showProductImages immediately.
Each product needs: id, name, imageUrl (required), price, sourceUrl (purchase link).`,
      loading: { deferLoading: true }, // Deferred - discovered via searchTools when shopping
      requiresSession: false,
    } satisfies ToolMetadata,
    () =>
      tool({
        description:
          "REQUIRED for ALL product/shopping queries: Display products with images and purchase links. MUST be called after webSearch when user asks for product recommendations (e.g., 'find floor tiles', 'recommend furniture'). Always include imageUrl and sourceUrl for each product.",
        inputSchema: jsonSchema<{
          query: string;
          products: Array<{
            id: string;
            name: string;
            imageUrl: string;
            price?: string;
            sourceUrl?: string;
            description?: string;
          }>;
        }>({
          type: "object",
          title: "DisplayProductsInput",
          description: "Input schema for displaying product gallery",
          properties: {
            query: {
              type: "string",
              description: "The search query used to find these products",
            },
            products: {
              type: "array",
              description: "Array of products to display in the gallery",
              items: {
                type: "object",
                properties: {
                  id: {
                    type: "string",
                    description: "Unique identifier for the product",
                  },
                  name: {
                    type: "string",
                    description: "Product name",
                  },
                  imageUrl: {
                    type: "string",
                    description: "URL of the product image",
                  },
                  price: {
                    type: "string",
                    description: "Product price (e.g., '$129.90')",
                  },
                  sourceUrl: {
                    type: "string",
                    description: "URL to the product page",
                  },
                  description: {
                    type: "string",
                    description: "Brief product description",
                  },
                },
                required: ["id", "name", "imageUrl"],
              },
            },
          },
          required: ["query", "products"],
        }),
        execute: async ({ query, products }) => {
          // Simply return the data - the UI component handles display
          console.debug(
            `[showProductImages] Displaying ${products.length} products for query: "${query}"`
          );
          return {
            status: "success" as const,
            query,
            products,
          };
        },
      })
  );

  // ============================================================
  // DIAGNOSTIC TOOLS - Deferred (discovered via searchTools)
  // ============================================================

  // Ghost OS Preflight - diagnose the MCP sidecar end-to-end
  registry.register(
    "ghostOsPreflight",
    {
      displayName: "Ghost OS Preflight",
      category: "utility",
      keywords: [
        "ghost",
        "ghostos",
        "ghost os",
        "mcp",
        "sidecar",
        "preflight",
        "diagnose",
        "diagnostic",
        "setup",
        "wizard",
        "handshake",
        "permission",
        "screen recording",
        "tcc",
        "stale",
        "macos",
        "screen capture",
        "desktop control",
        "troubleshoot",
      ],
      shortDescription:
        "Diagnose Ghost OS MCP sidecar: binary lookup → spawn → initialize → tools/list, with remediation advice",
      fullInstructions: `## Ghost OS Preflight

End-to-end diagnostic for the Ghost OS MCP sidecar. Runs these stages and returns a structured verdict plus an \`advice\` array of remediation steps.

**Stages:**
1. \`binary_located\` — resolve \`ghost\` binary from PATH / Homebrew
2. \`permission_preflight\` — macOS Screen Recording check (server context: always \`not-probed\`; use desktop wizard for real verdict)
3. \`sidecar_spawn\` — \`ghost mcp\` child process starts and gets a PID
4. \`mcp_handshake\` — JSON-RPC 2.0 \`initialize\` succeeds
5. \`first_tool_ping\` — \`tools/list\` returns ≥1 tool
6. \`complete\` — overall OK verdict

**Use when:** user reports Ghost OS / screen-sharing / \`ghost mcp\` issues, sidecar won't start, or tools aren't discoverable. Returns concrete per-stage errors so you can propose a fix instead of guessing.

**Note:** This server-side tool cannot read macOS TCC state. For verdicts like \`tcc_stale\` (cosmetic toggle in System Settings), direct the user to the Ghost OS setup wizard in Settings.`,
      loading: { deferLoading: true },
      requiresSession: false,
    } satisfies ToolMetadata,
    ({ sessionId }) =>
      createGhostOsPreflightTool({
        sessionId: sessionId || undefined,
      })
  );

  console.debug(
    `[ToolRegistry] Registered ${registry.getToolNames().length} tools`
  );
}
