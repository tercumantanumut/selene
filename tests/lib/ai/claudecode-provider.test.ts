import { describe, it, expect, vi, beforeEach, type MockedFunction } from "vitest";
import {
  buildPlanApprovalResult,
  normalizeAnthropicToolUseInputs,
  normalizeClaudeSdkToolName,
  sanitizeJsonStringValues,
  queryWithSdkOptions,
  type ClaudeAgentSdkQueryOptions,
  createClaudeCodeProvider,
} from "@/lib/ai/providers/claudecode-provider";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Use vi.hoisted so the mock factory can reference the variable after hoisting.
const { mockQuery, mockLoadClaudeAgentSdkRuntime } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockLoadClaudeAgentSdkRuntime: vi.fn(async () => ({ query: mockQuery })),
}));

// Mock the Agent SDK so tests don't spawn real CLI processes.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
  createSdkMcpServer: vi.fn(() => ({})),
}));

vi.mock("@/lib/ai/providers/claude-agent-sdk-runtime", () => ({
  loadClaudeAgentSdkRuntime: mockLoadClaudeAgentSdkRuntime,
}));

// Mock auth so auth-error tests don't need a real SDK process.
vi.mock("@/lib/auth/claude-agent-sdk-auth", () => ({
  readClaudeAgentSdkAuthStatus: vi.fn(async () => ({
    authenticated: true,
    authUrl: undefined,
    output: [],
  })),
  getSdkExecutableConfig: vi.fn(() => ({
    executable: "node",
    env: {},
  })),
}));

// Mock retry helpers to keep tests synchronous.
vi.mock("@/lib/ai/retry/stream-recovery", () => ({
  classifyRecoverability: vi.fn(() => ({ retryable: false, reason: "non-retryable" })),
  getBackoffDelayMs: vi.fn(() => 0),
  shouldRetry: vi.fn(() => false),
  sleepWithAbort: vi.fn(async () => {}),
}));

vi.mock("@/lib/ai/providers/selene-sdk-mcp-server", () => ({
  createSeleneSdkMcpServer: vi.fn(() => ({})),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SDKMessage = { type: string; [key: string]: unknown };

/** Creates an async generator that yields the given messages. */
async function* makeStream(messages: SDKMessage[]): AsyncGenerator<SDKMessage, void> {
  for (const msg of messages) {
    yield msg;
  }
}

function setMockStream(messages: SDKMessage[]) {
  (mockQuery as MockedFunction<typeof mockQuery>).mockReturnValue(makeStream(messages));
}

// ---------------------------------------------------------------------------
// normalizeClaudeSdkToolName
// ---------------------------------------------------------------------------

describe("normalizeClaudeSdkToolName", () => {
  it("recovers malformed tool names with trailing attribute fragments", () => {
    expect(normalizeClaudeSdkToolName('Task" subagent_type="Explore')).toBe("Task");
  });

  it("extracts tool names from name= fragments", () => {
    expect(normalizeClaudeSdkToolName('name="Task" subagent_type="Explore"')).toBe("Task");
  });

  it("strips selene-platform MCP prefix from tool names", () => {
    expect(normalizeClaudeSdkToolName("mcp__selene-platform__searchTools")).toBe("searchTools");
    expect(normalizeClaudeSdkToolName("mcp__selene-platform__calculator")).toBe("calculator");
  });

  it("does NOT strip MCP prefix from other servers (avoids cross-server collisions)", () => {
    expect(normalizeClaudeSdkToolName("mcp__other-server__someAction")).toBe("mcp__other-server__someAction");
  });

  it("cleans up malformed MCP-prefixed names with trailing attribute fragments", () => {
    expect(
      normalizeClaudeSdkToolName('mcp__selene-platform__searchTools" subagent_type="Explore')
    ).toBe("searchTools");
  });

  it("returns undefined for non-string or empty values", () => {
    expect(normalizeClaudeSdkToolName(undefined)).toBeUndefined();
    expect(normalizeClaudeSdkToolName("   ")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// sanitizeJsonStringValues
// ---------------------------------------------------------------------------

describe("sanitizeJsonStringValues", () => {
  it("preserves valid surrogate pairs", () => {
    const input = {
      text: "ok \u{1F600} end",
      nested: [{ value: "pair: \u{1F604}" }],
    };

    const result = sanitizeJsonStringValues(input);

    expect(result.changed).toBe(false);
    expect(result.value).toEqual(input);
  });

  it("replaces lone high and low surrogates recursively", () => {
    const loneHigh = "\ud83d";
    const loneLow = "\ude00";

    const input = {
      top: `A${loneHigh}B${loneLow}C`,
      nested: [{ text: `${loneLow}${loneHigh}` }],
    };

    const result = sanitizeJsonStringValues(input);

    expect(result.changed).toBe(true);
    expect(result.value).toEqual({
      top: "A\ufffdB\ufffdC",
      nested: [{ text: "\ufffd\ufffd" }],
    });
  });

  it("handles primitive types without mutation", () => {
    expect(sanitizeJsonStringValues(42)).toEqual({ value: 42, changed: false });
    expect(sanitizeJsonStringValues(null)).toEqual({ value: null, changed: false });
    expect(sanitizeJsonStringValues(true)).toEqual({ value: true, changed: false });
  });
});

// ---------------------------------------------------------------------------
// normalizeAnthropicToolUseInputs
// ---------------------------------------------------------------------------

describe("normalizeAnthropicToolUseInputs", () => {
  it("parses tool_use input when input is a JSON string object", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "editFile",
              input: "{\"filePath\":\"app/today/page.tsx\",\"edits\":[{\"oldString\":\"a\",\"newString\":\"b\"}]}",
            },
          ],
        },
      ],
    };

    const result = normalizeAnthropicToolUseInputs(body);

    expect(result.fixedCount).toBe(1);
    const normalizedInput = (result.body.messages as Array<any>)[0].content[0].input;
    expect(normalizedInput).toEqual({
      filePath: "app/today/page.tsx",
      edits: [{ oldString: "a", newString: "b" }],
    });
  });

  it("replaces non-object tool_use input with recovery placeholder", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_2",
              name: "editFile",
              input: "[1,2,3]",
            },
          ],
        },
      ],
    };

    const result = normalizeAnthropicToolUseInputs(body);

    expect(result.fixedCount).toBe(1);
    const normalizedInput = (result.body.messages as Array<any>)[0].content[0].input;
    expect(normalizedInput).toEqual({
      _recoveredInvalidToolUseInput: true,
      _inputType: "string",
    });
  });

  it("leaves already-object inputs unchanged", () => {
    const input = { key: "value" };
    const body = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_3", name: "readFile", input }],
        },
      ],
    };

    const result = normalizeAnthropicToolUseInputs(body);

    expect(result.fixedCount).toBe(0);
    expect((result.body.messages as Array<any>)[0].content[0].input).toBe(input);
  });

  it("returns body unchanged when there are no messages", () => {
    const body = { model: "claude-sonnet-4-6" };
    const result = normalizeAnthropicToolUseInputs(body);
    expect(result.fixedCount).toBe(0);
    expect(result.body).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// queryWithSdkOptions — text extraction
// ---------------------------------------------------------------------------

describe("queryWithSdkOptions — text extraction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadClaudeAgentSdkRuntime.mockResolvedValue({ query: mockQuery });
  });

  it("extracts text from stream_event content_block_delta messages", async () => {
    setMockStream([
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } },
      },
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "world" } },
      },
      { type: "result", subtype: "success", is_error: false, result: "", errors: [] },
    ]);

    const text = await queryWithSdkOptions({ prompt: "hi" });
    expect(text).toBe("Hello world");
  });

  it("falls back to assistant message text when no stream events emitted", async () => {
    setMockStream([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Fallback response" }] },
      },
      { type: "result", subtype: "success", is_error: false, result: "", errors: [] },
    ]);

    const text = await queryWithSdkOptions({ prompt: "hi" });
    expect(text).toBe("Fallback response");
  });

  it("skips assistant message text when stream deltas were already consumed", async () => {
    setMockStream([
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Stream text" } },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Duplicate assistant text" }] },
      },
      { type: "result", subtype: "success", is_error: false, result: "", errors: [] },
    ]);

    const text = await queryWithSdkOptions({ prompt: "hi" });
    // Must NOT contain duplicate content
    expect(text).toBe("Stream text");
    expect(text).not.toContain("Duplicate");
  });

  it("uses result.result as last-resort fallback when no other text collected", async () => {
    setMockStream([
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Result text fallback",
        errors: [],
      },
    ]);

    const text = await queryWithSdkOptions({ prompt: "hi" });
    expect(text).toBe("Result text fallback");
  });

  it("does NOT use result.result when assistant text was already captured", async () => {
    setMockStream([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Good response" }] },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Should be ignored",
        errors: [],
      },
    ]);

    const text = await queryWithSdkOptions({ prompt: "hi" });
    expect(text).toBe("Good response");
    expect(text).not.toContain("ignored");
  });

  it("appends result.errors to the collected text", async () => {
    setMockStream([
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Partial" } },
      },
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "",
        errors: ["Tool execution failed"],
      },
    ]);

    await expect(queryWithSdkOptions({ prompt: "hi" })).rejects.toThrow(
      "error_during_execution"
    );
  });

  it("ignores unrecognised SDK message types without throwing", async () => {
    setMockStream([
      { type: "system", subtype: "hook_started", hook_id: "h1", hook_name: "pre-tool", hook_event: "PreToolUse" },
      { type: "status", message: "processing" },
      { type: "tool_progress", tool_name: "Bash", progress: "running" },
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Done" } },
      },
      { type: "result", subtype: "success", is_error: false, result: "", errors: [] },
    ]);

    const text = await queryWithSdkOptions({ prompt: "hi" });
    expect(text).toBe("Done");
  });

  it("ignores nested subagent messages annotated with parent_tool_use_id", async () => {
    setMockStream([
      {
        type: "stream_event",
        parent_tool_use_id: "task-root-1",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "nested subagent chatter" },
        },
      },
      {
        type: "assistant",
        parent_tool_use_id: "task-root-1",
        message: { content: [{ type: "text", text: "nested assistant text" }] },
      },
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Root answer" } },
      },
      { type: "result", subtype: "success", is_error: false, result: "", errors: [] },
    ]);

    const text = await queryWithSdkOptions({ prompt: "hi" });
    expect(text).toBe("Root answer");
    expect(text).not.toContain("nested");
  });
});

// ---------------------------------------------------------------------------
// queryWithSdkOptions — authentication errors
// ---------------------------------------------------------------------------

describe("buildPlanApprovalResult", () => {
  it("marks approved plans as success and preserves the plan text", () => {
    const result = buildPlanApprovalResult(
      {
        kind: "submitted",
        answers: { action: "Approve & Continue" },
      },
      "Implement the fix",
    );

    expect(result).toEqual({
      status: "success",
      action: "Approve & Continue",
      approved: true,
      plan: "Implement the fix",
      isAgent: false,
      awaitingLeaderApproval: false,
    });
  });

  it("marks interrupted approvals without turning them into synthetic rejection feedback", () => {
    const result = buildPlanApprovalResult(
      {
        kind: "interrupted",
        reason: "aborted",
      },
      "Implement the fix",
    );

    expect(result).toEqual({
      status: "interrupted",
      action: "Interrupted",
      approved: false,
      interrupted: true,
      reason: "aborted",
      plan: "Implement the fix",
      isAgent: false,
      awaitingLeaderApproval: true,
    });
  });
});

// ---------------------------------------------------------------------------
// queryWithSdkOptions — authentication errors
// ---------------------------------------------------------------------------

describe("queryWithSdkOptions — authentication errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadClaudeAgentSdkRuntime.mockResolvedValue({ query: mockQuery });
  });

  it("throws an auth error with URL when SDK returns authentication_failed", async () => {
    setMockStream([
      {
        type: "assistant",
        error: "authentication_failed",
        message: { content: [] },
      },
    ]);

    const err = await queryWithSdkOptions({ prompt: "hi" }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("authentication");
  });

  it("throws an auth error when SDK returns billing_error", async () => {
    setMockStream([
      {
        type: "assistant",
        error: "billing_error",
        message: { content: [] },
      },
    ]);

    const err = await queryWithSdkOptions({ prompt: "hi" }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/billing_error|authentication/);
  });
});

// ---------------------------------------------------------------------------
// queryWithSdkOptions — SDK options forwarding
// ---------------------------------------------------------------------------

describe("queryWithSdkOptions — SDK options forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadClaudeAgentSdkRuntime.mockResolvedValue({ query: mockQuery });
    setMockStream([
      { type: "result", subtype: "success", is_error: false, result: "ok", errors: [] },
    ]);
  });

  it("forwards agents option to SDK query()", async () => {
    const agents: ClaudeAgentSdkQueryOptions["agents"] = {
      "system-explore": {
        description: "Explorer",
        prompt: "You are an explorer.",
        model: "inherit",
      },
    };

    await queryWithSdkOptions({ prompt: "hi", sdkOptions: { agents } });

    const callArg = (mockQuery as MockedFunction<typeof mockQuery>).mock.calls[0][0];
    expect(callArg.options.agents).toEqual(agents);
  });

  it("forwards allowedTools and disallowedTools to SDK query()", async () => {
    await queryWithSdkOptions({
      prompt: "hi",
      sdkOptions: { allowedTools: ["Bash", "Read"], disallowedTools: ["Write"] },
    });

    const callArg = (mockQuery as MockedFunction<typeof mockQuery>).mock.calls[0][0];
    expect(callArg.options.allowedTools).toEqual(["Bash", "Read"]);
    expect(callArg.options.disallowedTools).toEqual(["Write"]);
  });

  it("injects a Bash sanitizer hook even when no other hooks are configured", async () => {
    await queryWithSdkOptions({
      prompt: "hi",
      sdkOptions: { allowedTools: ["Bash"] },
    });

    const callArg = (mockQuery as MockedFunction<typeof mockQuery>).mock.calls[0][0];
    expect(callArg.options.hooks?.PreToolUse).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ matcher: "Bash" }),
      ])
    );
  });

  it("merges the Bash sanitizer hook alongside caller-provided hooks", async () => {
    const customHook = { matcher: "Read", hooks: [vi.fn(async () => ({}))] };

    await queryWithSdkOptions({
      prompt: "hi",
      sdkOptions: {
        hooks: {
          PreToolUse: [customHook],
        },
      },
    });

    const callArg = (mockQuery as MockedFunction<typeof mockQuery>).mock.calls[0][0];
    expect(callArg.options.hooks?.PreToolUse).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ matcher: "Bash" }),
        customHook,
      ])
    );
  });

  it("omits undefined sdk options except for the always-on Bash sanitizer hook", async () => {
    await queryWithSdkOptions({ prompt: "hi", sdkOptions: {} });

    const callArg = (mockQuery as MockedFunction<typeof mockQuery>).mock.calls[0][0];
    expect(callArg.options.agents).toBeUndefined();
    expect(callArg.options.hooks).toEqual({
      PreToolUse: [expect.objectContaining({ matcher: "Bash" })],
    });
    expect(callArg.options.plugins).toBeUndefined();
    expect(callArg.options.resume).toBeUndefined();
  });

  it("still injects the Bash sanitizer hook when sdkOptions is not provided", async () => {
    await queryWithSdkOptions({ prompt: "hi" });

    const callArg = (mockQuery as MockedFunction<typeof mockQuery>).mock.calls[0][0];
    expect(callArg.options.hooks).toEqual({
      PreToolUse: [expect.objectContaining({ matcher: "Bash" })],
    });
  });

  it("forwards persistSession: false for ephemeral queries", async () => {
    await queryWithSdkOptions({ prompt: "hi", sdkOptions: { persistSession: false } });

    const callArg = (mockQuery as MockedFunction<typeof mockQuery>).mock.calls[0][0];
    expect(callArg.options.persistSession).toBe(false);
  });

  it("forwards maxTurns override to SDK query()", async () => {
    await queryWithSdkOptions({ prompt: "hi", sdkOptions: { maxTurns: 5 } });

    const callArg = (mockQuery as MockedFunction<typeof mockQuery>).mock.calls[0][0];
    expect(callArg.options.maxTurns).toBe(5);
  });

  it("defaults maxTurns to 1000 when not specified", async () => {
    await queryWithSdkOptions({ prompt: "hi" });

    const callArg = (mockQuery as MockedFunction<typeof mockQuery>).mock.calls[0][0];
    expect(callArg.options.maxTurns).toBe(1000);
  });

  it("forwards effort level to SDK query()", async () => {
    await queryWithSdkOptions({ prompt: "hi", sdkOptions: { effort: "high" } });

    const callArg = (mockQuery as MockedFunction<typeof mockQuery>).mock.calls[0][0];
    expect(callArg.options.effort).toBe("high");
  });

  it("forwards thinking config to SDK query()", async () => {
    const thinking: ClaudeAgentSdkQueryOptions["thinking"] = { type: "adaptive" };
    await queryWithSdkOptions({ prompt: "hi", sdkOptions: { thinking } });

    const callArg = (mockQuery as MockedFunction<typeof mockQuery>).mock.calls[0][0];
    expect(callArg.options.thinking).toEqual({ type: "adaptive" });
  });

  it("forwards resume session ID to SDK query()", async () => {
    const resume = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    await queryWithSdkOptions({ prompt: "hi", sdkOptions: { resume } });

    const callArg = (mockQuery as MockedFunction<typeof mockQuery>).mock.calls[0][0];
    expect(callArg.options.resume).toBe(resume);
  });

  it("forwards plugins list to SDK query()", async () => {
    const plugins: ClaudeAgentSdkQueryOptions["plugins"] = [
      { type: "local", path: "/abs/path/to/plugin" },
    ];
    await queryWithSdkOptions({ prompt: "hi", sdkOptions: { plugins } });

    const callArg = (mockQuery as MockedFunction<typeof mockQuery>).mock.calls[0][0];
    expect(callArg.options.plugins).toEqual(plugins);
  });

  it("keeps only the always-on Bash sanitizer hook when sdkOptions is empty", async () => {
    await queryWithSdkOptions({ prompt: "hi", sdkOptions: {} });

    const callArg = (mockQuery as MockedFunction<typeof mockQuery>).mock.calls[0][0];
    expect(callArg.options.agents).toBeUndefined();
    expect(callArg.options.hooks).toEqual({
      PreToolUse: [expect.objectContaining({ matcher: "Bash" })],
    });
    expect(callArg.options.plugins).toBeUndefined();
    expect(callArg.options.resume).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// queryWithSdkOptions — async agent lifecycle messages
// ---------------------------------------------------------------------------

describe("queryWithSdkOptions — async agent lifecycle (sdk-tools AgentOutput)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadClaudeAgentSdkRuntime.mockResolvedValue({ query: mockQuery });
  });

  it("returns collected stream text when async_launched status is present", async () => {
    // async_launched is a status on AgentOutput (from sdk-tools.d.ts), not a
    // direct SDK message type. The SDK still emits normal message types in the
    // surrounding stream; we verify they are handled correctly alongside any
    // informational system messages.
    setMockStream([
      { type: "system", subtype: "hook_started", hook_id: "h1", hook_name: "n", hook_event: "PreToolUse" },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Async task launched." },
        },
      },
      { type: "result", subtype: "success", is_error: false, result: "", errors: [] },
    ]);

    const text = await queryWithSdkOptions({ prompt: "launch task" });
    expect(text).toBe("Async task launched.");
  });

});

describe("createClaudeCodeProvider — nested subagent filtering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadClaudeAgentSdkRuntime.mockResolvedValue({ query: mockQuery });
  });

  it("omits nested subagent SSE traffic but preserves the root task result", async () => {
    setMockStream([
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "task-root-1", name: "Task" },
        },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_stop",
          index: 0,
        },
      },
      {
        type: "stream_event",
        parent_tool_use_id: "task-root-1",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "nested-read-1", name: "Read" },
        },
      },
      {
        type: "stream_event",
        parent_tool_use_id: "task-root-1",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"filePath":"secret.txt"}' },
        },
      },
      {
        type: "stream_event",
        parent_tool_use_id: "task-root-1",
        event: {
          type: "content_block_stop",
          index: 0,
        },
      },
      {
        type: "user",
        parent_tool_use_id: "task-root-1",
        tool_name: "Task",
        tool_use_result: { status: "completed", agentId: "agent-1" },
      },
      { type: "result", subtype: "success", is_error: false, result: "", errors: [] },
    ]);

    const provider = createClaudeCodeProvider();
    const model = provider("claude-sonnet-4-5-20250929");
    const response = await model.doStream({
      prompt: [
        {
          role: "user",
          content: [{ type: "text", text: "Use a subagent" }],
        },
      ],
      inputFormat: "messages",
      mode: {
        type: "regular",
        tools: [
          {
            type: "function",
            name: "Task",
            description: "delegate",
            parameters: {
              type: "object",
              properties: {},
            },
          },
          {
            type: "function",
            name: "Read",
            description: "read file",
            parameters: {
              type: "object",
              properties: {},
            },
          },
        ],
      },
    } as any);

    const chunks: any[] = [];
    const reader = response.stream.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const taskCall = chunks.find((chunk) => chunk.type === "tool-call" && chunk.toolName === "Task");
    const nestedReadCall = chunks.find((chunk) => chunk.type === "tool-call" && chunk.toolName === "Read");

    expect(taskCall).toBeDefined();
    expect(nestedReadCall).toBeUndefined();
    // NOTE: tool-result chunks are NOT emitted by the provider in the SSE path.
    // The AI SDK Anthropic provider only emits tool-call from content_block_start;
    // tool results are resolved by the runtime, not the streaming provider.
  });
});

describe("queryWithSdkOptions — live prompt queue injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadClaudeAgentSdkRuntime.mockResolvedValue({ query: mockQuery });
  });

  it("injects queued live prompts into the SDK session via streamInput", async () => {
    const pendingMessages: Array<{ resolve: (value: IteratorResult<SDKMessage, void>) => void }> = [];

    const query = {
      async *[Symbol.asyncIterator]() {
        yield {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "done" } },
        };
        yield { type: "result", subtype: "success", is_error: false, result: "", errors: [] };
      },
      async streamInput(stream: AsyncIterable<any>) {
        const seen: any[] = [];
        for await (const message of stream) {
          seen.push(message);
        }
        pendingMessages.push({
          resolve: (() => {
            if (seen.length !== 1) {
              throw new Error(`Expected exactly one injected message, got ${seen.length}`);
            }
            const content = seen[0]?.message?.content;
            if (typeof content !== "string" || !content.includes("follow-up request")) {
              throw new Error(`Unexpected injected content: ${JSON.stringify(content)}`);
            }
            return () => ({ value: undefined, done: true });
          })(),
        });
      },
    };

    (mockQuery as MockedFunction<typeof mockQuery>).mockReturnValue(query as any);

    const { createLivePromptQueue, appendToLivePromptQueue, removeLivePromptQueue } = await import(
      "@/lib/background-tasks/live-prompt-queue-registry"
    );

    const runId = "run-live-prompt-1";
    const sessionId = "session-live-prompt-1";
    createLivePromptQueue(runId, sessionId);

    const resultPromise = queryWithSdkOptions({
      prompt: "start",
      sdkOptions: {
        mcpContext: {
          userId: "user-1",
          sessionId,
          runId,
          characterId: null,
        },
      },
    });

    appendToLivePromptQueue(runId, {
      id: "live-1",
      content: "follow-up request",
      stopIntent: false,
    });

    const text = await resultPromise;
    expect(text).toBe("done");
    expect((mockQuery as MockedFunction<typeof mockQuery>).mock.calls).toHaveLength(1);

    removeLivePromptQueue(runId, sessionId);
  });
});
