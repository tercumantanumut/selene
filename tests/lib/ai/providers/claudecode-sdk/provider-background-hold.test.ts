/**
 * Agent SDK streaming provider — background-task hold semantics.
 *
 * When the CLI reports live (non-ambient) background tasks via
 * `system/background_tasks_changed`, a `result` must NOT end the Selene turn:
 * the provider keeps consuming so the CLI's auto-wake follow-up turn streams
 * into the same SSE response. When no live tasks exist, `result` stays
 * terminal (see provider-result-terminal.test.ts).
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

vi.mock("@/lib/db/sqlite-client", () => ({
  getRawSqlite: vi.fn(() => null),
  getDb: vi.fn(() => null),
}));

import {
  createClaudeCodeSdkProvider,
  invalidateClaudeCodeSdkProvider,
} from "@/lib/ai/providers/claudecode-sdk/provider";

type SdkEvent = Record<string, unknown>;

const textEvents = (index: number, text: string): SdkEvent[] => [
  {
    type: "stream_event",
    event: { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  },
  {
    type: "stream_event",
    event: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
  },
  { type: "stream_event", event: { type: "content_block_stop", index } },
];

const resultEvent = (result: string, extra: SdkEvent = {}): SdkEvent => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result,
  usage: { input_tokens: 10, output_tokens: 5 },
  ...extra,
});

const tasksChanged = (
  tasks: Array<{ task_id: string; task_type: string; description: string; ambient?: boolean }>,
): SdkEvent => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks,
  uuid: "u",
  session_id: "s",
});

const LIVE_BASH_TASK = { task_id: "bbrmixfcz", task_type: "local_bash", description: "sleep 15" };

/**
 * Mirrors the real SDK: when `prompt` is an AsyncIterable, the SDK consumes it
 * (stdin stays open until the iterable ends). Returns a promise that resolves
 * once the provider closes its prompt channel.
 */
function consumePrompt(prompt: unknown): { closed: Promise<void>; items: unknown[] } {
  const items: unknown[] = [];
  if (typeof prompt === "string" || !prompt || typeof prompt !== "object") {
    return { closed: Promise.resolve(), items };
  }
  const iterable = prompt as AsyncIterable<unknown>;
  const closed = (async () => {
    for await (const item of iterable) items.push(item);
  })();
  return { closed, items };
}

function countEvents(sse: string, eventName: string): number {
  return sse.split(`event: ${eventName}\n`).length - 1;
}

describe("Claude Code SDK provider — background task hold", () => {
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

  const callStream = async () => {
    createClaudeCodeSdkProvider();
    expect(capturedFetch).toBeDefined();
    return capturedFetch!("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        stream: true,
        messages: [{ role: "user", content: "run it in the background" }],
      }),
    });
  };

  it("keeps consuming after `result` while a live background task exists and streams the auto-wake turn", async () => {
    let generatorFinished = false;
    let reachedFollowUp = false;

    claudeAgentQueryMock.mockImplementation(({ prompt }: { prompt: unknown }) => {
      consumePrompt(prompt);
      async function* sdkMessages() {
        try {
          yield* textEvents(0, "launched.");
          yield tasksChanged([LIVE_BASH_TASK]);
          yield resultEvent("launched.");
          // CLI: task finishes → level signal drains → notification → auto-wake turn
          yield tasksChanged([]);
          yield {
            type: "system",
            subtype: "task_notification",
            task_id: LIVE_BASH_TASK.task_id,
            status: "completed",
            summary: "Background command completed (exit code 0)",
          };
          yield { type: "system", subtype: "init", session_id: "s" };
          reachedFollowUp = true;
          yield* textEvents(0, "follow-up after wake");
          yield resultEvent("follow-up after wake");
        } finally {
          generatorFinished = true;
        }
      }
      return sdkMessages();
    });

    const response = await callStream();
    const sse = await response.text();

    expect(reachedFollowUp).toBe(true);
    expect(sse).toContain("launched.");
    expect(sse).toContain("follow-up after wake");
    expect(countEvents(sse, "message_start")).toBe(1);
    expect(countEvents(sse, "message_delta")).toBe(1);
    expect(countEvents(sse, "message_stop")).toBe(1);
    // message_stop must come after the follow-up text
    expect(sse.indexOf("follow-up after wake")).toBeLessThan(sse.indexOf("event: message_stop"));
    expect(generatorFinished).toBe(true);
  });

  it("treats `result` as terminal when the only live tasks are ambient", async () => {
    let reachedLate = false;

    claudeAgentQueryMock.mockImplementation(({ prompt }: { prompt: unknown }) => {
      consumePrompt(prompt);
      async function* sdkMessages() {
        yield* textEvents(0, "done.");
        yield tasksChanged([{ ...LIVE_BASH_TASK, task_type: "monitor", ambient: true }]);
        yield resultEvent("done.");
        reachedLate = true;
        yield* textEvents(0, "late text that must not stream");
        yield resultEvent("late");
      }
      return sdkMessages();
    });

    const response = await callStream();
    const sse = await response.text();

    expect(sse).toContain("done.");
    expect(sse).not.toContain("late text that must not stream");
    expect(countEvents(sse, "message_stop")).toBe(1);
    expect(reachedLate).toBe(false);
  });

  it("treats `result` as terminal when tasks drained to empty before it arrived", async () => {
    let reachedLate = false;

    claudeAgentQueryMock.mockImplementation(({ prompt }: { prompt: unknown }) => {
      consumePrompt(prompt);
      async function* sdkMessages() {
        yield tasksChanged([LIVE_BASH_TASK]);
        yield tasksChanged([]);
        yield* textEvents(0, "done.");
        yield resultEvent("done.");
        reachedLate = true;
        yield* textEvents(0, "late text that must not stream");
      }
      return sdkMessages();
    });

    const response = await callStream();
    const sse = await response.text();

    expect(sse).toContain("done.");
    expect(sse).not.toContain("late text that must not stream");
    expect(reachedLate).toBe(false);
  });

  it("does not hold on an error `result`, even with live background tasks", async () => {
    let reachedLate = false;

    claudeAgentQueryMock.mockImplementation(({ prompt }: { prompt: unknown }) => {
      consumePrompt(prompt);
      async function* sdkMessages() {
        yield tasksChanged([LIVE_BASH_TASK]);
        yield resultEvent("", { subtype: "error_max_turns", is_error: true, errors: ["max turns"] });
        reachedLate = true;
        yield* textEvents(0, "late text that must not stream");
      }
      return sdkMessages();
    });

    const response = await callStream();
    const sse = await response.text();

    expect(sse).toContain("max turns");
    expect(sse).not.toContain("late text that must not stream");
    expect(reachedLate).toBe(false);
  });

  it("ends the turn after the grace window when tasks drain but no follow-up turn arrives", async () => {
    vi.useFakeTimers();
    let generatorFinished = false;
    let parkedAfterDrain = false;

    claudeAgentQueryMock.mockImplementation(({ prompt }: { prompt: unknown }) => {
      const { closed } = consumePrompt(prompt);
      async function* sdkMessages() {
        try {
          yield* textEvents(0, "launched.");
          yield tasksChanged([LIVE_BASH_TASK]);
          yield resultEvent("launched.");
          yield tasksChanged([]);
          parkedAfterDrain = true;
          // Real CLI: with nothing left to do it idles until stdin closes.
          // Only the provider closing its prompt channel lets us finish.
          await closed;
        } finally {
          generatorFinished = true;
        }
      }
      return sdkMessages();
    });

    const response = await callStream();
    const textPromise = response.text();

    // Let the stream reach the parked state, then sit just under the window.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(parkedAfterDrain).toBe(true);
    await vi.advanceTimersByTimeAsync(13_000);
    expect(generatorFinished).toBe(false);

    // Cross the 15s grace window.
    await vi.advanceTimersByTimeAsync(2_000);
    const sse = await textPromise;

    expect(generatorFinished).toBe(true);
    expect(sse).toContain("launched.");
    expect(countEvents(sse, "message_delta")).toBe(1);
    expect(countEvents(sse, "message_stop")).toBe(1);
  });

  it("cancels the grace window when a new turn starts before it elapses", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let generatorFinished = false;

    claudeAgentQueryMock.mockImplementation(({ prompt }: { prompt: unknown }) => {
      consumePrompt(prompt);
      async function* sdkMessages() {
        try {
          yield* textEvents(0, "launched.");
          yield tasksChanged([LIVE_BASH_TASK]);
          yield resultEvent("launched.");
          yield tasksChanged([]);
          await gate; // wake-up arrives at +10s (inside the window)
          yield* textEvents(0, "woke up");
          yield resultEvent("woke up");
        } finally {
          generatorFinished = true;
        }
      }
      return sdkMessages();
    });

    const response = await callStream();
    const textPromise = response.text();

    await vi.advanceTimersByTimeAsync(10_000);
    release();
    await vi.advanceTimersByTimeAsync(0);
    const sse = await textPromise;

    expect(generatorFinished).toBe(true);
    expect(sse).toContain("woke up");
    expect(countEvents(sse, "message_stop")).toBe(1);
  });
});
