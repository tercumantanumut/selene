/**
 * Agent SDK streaming provider — prompt transport mode.
 *
 * The SDK treats a string `prompt` as a single-user-turn query: once `result`
 * arrives it closes stdin and the CLI tears down (killing every background
 * task it hosts). Selene must therefore always hand the SDK an AsyncIterable
 * and feed BOTH the initial turn and live-prompt injections through that one
 * channel — never a second `streamInput()` call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@/lib/ai/providers/claudecode-sdk/mcp-server", () => ({
  createSeleneSdkMcpServer: vi.fn(async () => ({ type: "sdk", name: "selene-platform" })),
}));

vi.mock("@/lib/db/sqlite-client", () => ({
  getRawSqlite: vi.fn(() => null),
  getDb: vi.fn(() => null),
}));

import {
  createClaudeCodeSdkProvider,
  invalidateClaudeCodeSdkProvider,
} from "@/lib/ai/providers/claudecode-sdk/provider";
import { mcpContextStore, type SeleneMcpContext } from "@/lib/ai/providers/mcp-context-store";
import {
  appendToLivePromptQueue,
  createLivePromptQueue,
  removeLivePromptQueue,
} from "@/lib/background-tasks/live-prompt-queue-registry";

type SdkUserItem = { type?: string; message?: { role?: string; content?: unknown } };

const resultEvent = (result: string) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result,
  usage: { input_tokens: 1, output_tokens: 1 },
});

const textEvents = (text: string) => [
  { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
  { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
  { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
];

function contentText(item: SdkUserItem | undefined): string {
  const content = item?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === "object" && "text" in block ? String((block as { text: unknown }).text) : ""))
      .join("\n");
  }
  return "";
}

describe("Claude Code SDK provider — prompt transport mode", () => {
  let capturedFetch: typeof fetch | undefined;

  beforeEach(() => {
    invalidateClaudeCodeSdkProvider();
    capturedFetch = undefined;
    createAnthropicMock.mockReset();
    claudeAgentQueryMock.mockReset();
    createAnthropicMock.mockImplementation((options: { fetch?: typeof fetch }) => {
      capturedFetch = options.fetch;
      return vi.fn((modelId: string) => ({ modelId }));
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const callStream = (messages: unknown[]) => {
    createClaudeCodeSdkProvider();
    expect(capturedFetch).toBeDefined();
    return capturedFetch!("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet-4-6", stream: true, messages }),
    });
  };

  it("passes an AsyncIterable prompt (never a string) for a text-only turn and closes it at end of turn", async () => {
    const items: SdkUserItem[] = [];
    let promptType: string | undefined;
    let promptIsIterable = false;
    let promptClosed = false;
    const streamInput = vi.fn(async () => {});

    claudeAgentQueryMock.mockImplementation(({ prompt }: { prompt: unknown }) => {
      promptType = typeof prompt;
      promptIsIterable = !!prompt && typeof prompt === "object" && Symbol.asyncIterator in (prompt as object);
      if (promptIsIterable) {
        void (async () => {
          for await (const item of prompt as AsyncIterable<SdkUserItem>) items.push(item);
          promptClosed = true;
        })();
      }
      async function* sdkMessages() {
        yield* textEvents("hi there");
        yield resultEvent("hi there");
      }
      const generator = sdkMessages() as AsyncGenerator<unknown> & { streamInput?: typeof streamInput };
      generator.streamInput = streamInput;
      return generator;
    });

    const response = await callStream([{ role: "user", content: "hello from the user" }]);
    const sse = await response.text();

    expect(sse).toContain("hi there");
    expect(promptType).toBe("object");
    expect(promptIsIterable).toBe(true);
    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe("user");
    expect(items[0]?.message?.role).toBe("user");
    expect(contentText(items[0])).toContain("hello from the user");
    expect(streamInput).not.toHaveBeenCalled();
    // Channel must be closed once the turn ends so the SDK can endInput() exactly once.
    await vi.waitFor(() => expect(promptClosed).toBe(true));
  });

  it("routes a multimodal turn through the same iterable channel, preserving the image block", async () => {
    const items: SdkUserItem[] = [];

    claudeAgentQueryMock.mockImplementation(({ prompt }: { prompt: unknown }) => {
      expect(typeof prompt).toBe("object");
      void (async () => {
        for await (const item of prompt as AsyncIterable<SdkUserItem>) items.push(item);
      })();
      async function* sdkMessages() {
        yield* textEvents("I see an image");
        yield resultEvent("I see an image");
      }
      return sdkMessages();
    });

    const response = await callStream([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", image: "aGVsbG8=", mimeType: "image/png" },
        ],
      },
    ]);
    await response.text();

    expect(items).toHaveLength(1);
    const content = items[0]?.message?.content;
    expect(Array.isArray(content)).toBe(true);
    expect((content as Array<{ type: string }>).some((block) => block.type === "image")).toBe(true);
    expect(contentText(items[0])).toContain("what is this?");
  });

  it("delivers live-prompt injections through the same channel as the initial turn", async () => {
    const runId = "run-prompt-mode-1";
    const sessionId = "session-prompt-mode-1";
    createLivePromptQueue(runId, sessionId);

    const items: SdkUserItem[] = [];
    let notifyItem: (() => void) | null = null;
    const waitForItemCount = (count: number) =>
      new Promise<void>((resolve) => {
        if (items.length >= count) return resolve();
        notifyItem = () => {
          if (items.length >= count) {
            notifyItem = null;
            resolve();
          }
        };
      });
    const streamInput = vi.fn(async () => {});

    claudeAgentQueryMock.mockImplementation(({ prompt }: { prompt: unknown }) => {
      void (async () => {
        for await (const item of prompt as AsyncIterable<SdkUserItem>) {
          items.push(item);
          notifyItem?.();
        }
      })();
      async function* sdkMessages() {
        yield* textEvents("working...");
        // Hold the turn open until the injected message reaches the CLI side.
        await waitForItemCount(2);
        yield* textEvents("got the injection");
        yield resultEvent("got the injection");
      }
      const generator = sdkMessages() as AsyncGenerator<unknown> & { streamInput?: typeof streamInput };
      generator.streamInput = streamInput;
      return generator;
    });

    const ctx: SeleneMcpContext = {
      userId: "user-1",
      sessionId,
      runId,
      characterId: null,
    };

    try {
      const response = await mcpContextStore.run(ctx, () =>
        callStream([{ role: "user", content: "start a long job" }]),
      );
      const textPromise = response.text();

      await waitForItemCount(1);
      expect(
        appendToLivePromptQueue(runId, { id: "inj-1", content: "INJECTED MID-TURN", stopIntent: false }),
      ).toBe(true);

      const sse = await textPromise;

      expect(sse).toContain("got the injection");
      expect(items).toHaveLength(2);
      expect(contentText(items[0])).toContain("start a long job");
      expect(contentText(items[1])).toContain("INJECTED MID-TURN");
      expect(streamInput).not.toHaveBeenCalled();
    } finally {
      removeLivePromptQueue(runId, sessionId);
    }
  });
});
