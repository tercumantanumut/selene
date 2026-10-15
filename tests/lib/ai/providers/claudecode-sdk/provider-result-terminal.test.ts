import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createAnthropicMock,
  claudeAgentQueryMock,
  getSdkExecutableConfigMock,
  getCliPathMock,
} = vi.hoisted(() => ({
  createAnthropicMock: vi.fn(),
  claudeAgentQueryMock: vi.fn(),
  getSdkExecutableConfigMock: vi.fn(() => ({ executable: undefined, env: undefined })),
  getCliPathMock: vi.fn(() => "/tmp/claude-code"),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: createAnthropicMock,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: claudeAgentQueryMock,
}));

vi.mock("@/lib/ai/providers/claudecode-sdk/auth", () => ({
  getSdkExecutableConfig: getSdkExecutableConfigMock,
  readClaudeAgentSdkAuthStatus: vi.fn(async () => ({ authenticated: true })),
}));

vi.mock("@/lib/ai/providers/claudecode-sdk/login-process", () => ({
  getCliPath: getCliPathMock,
}));

vi.mock("@/lib/db/sqlite-client", () => ({
  getRawSqlite: vi.fn(() => null),
  getDb: vi.fn(() => null),
}));

import {
  createClaudeCodeSdkProvider,
  invalidateClaudeCodeSdkProvider,
} from "@/lib/ai/providers/claudecode-sdk/provider";

describe("Claude Code SDK provider result terminal streaming", () => {
  let capturedFetch: typeof fetch | undefined;

  beforeEach(() => {
    invalidateClaudeCodeSdkProvider();
    capturedFetch = undefined;
    createAnthropicMock.mockReset();
    claudeAgentQueryMock.mockReset();
    getSdkExecutableConfigMock.mockClear();
    getCliPathMock.mockClear();

    createAnthropicMock.mockImplementation((options: { fetch?: typeof fetch }) => {
      capturedFetch = options.fetch;
      return vi.fn((modelId: string) => ({ modelId }));
    });
  });

  it("stops consuming SDK events after terminal result and closes the generator", async () => {
    let generatorReturnedOrClosed = false;

    claudeAgentQueryMock.mockImplementation(() => {
      async function* sdkMessages() {
        try {
          yield {
            type: "stream_event",
            event: {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            },
          };
          yield {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "pre-result assistant text" },
            },
          };
          yield {
            type: "stream_event",
            event: { type: "content_block_stop", index: 0 },
          };
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "fallback text that should not be emitted",
            usage: {
              input_tokens: 12,
              output_tokens: 34,
              cache_read_input_tokens: 5,
              cache_creation_input_tokens: 6,
            },
          };

          yield {
            type: "stream_event",
            event: {
              type: "content_block_start",
              index: 1,
              content_block: {
                type: "tool_use",
                id: "late_tool_call_id",
                name: "lateToolName",
              },
            },
          };
          yield {
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "late_assistant_tool_call_id",
                  name: "lateToolName",
                  input: { late: true },
                },
              ],
            },
          };
          yield {
            type: "user",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "late_tool_call_id",
                  content: "late tool result",
                },
              ],
            },
          };
        } finally {
          generatorReturnedOrClosed = true;
        }
      }

      return sdkMessages();
    });

    createClaudeCodeSdkProvider();
    expect(capturedFetch).toBeDefined();

    const response = await capturedFetch!("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    const sse = await response.text();

    expect(sse).toContain("message_start");
    expect(sse).toContain("pre-result assistant text");
    expect(sse).toContain("message_delta");
    expect(sse).toContain("message_stop");
    expect(sse).not.toContain("late_tool_call_id");
    expect(sse).not.toContain("lateToolName");
    expect(generatorReturnedOrClosed).toBe(true);
  });
});
