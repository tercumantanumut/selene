/**
 * SDK passthrough tool executor — waits for the bridged SDK result for as long
 * as the request lives. There is no fixed wall-clock timeout: the CLI's own
 * Bash ceiling (10 min foreground, up to 2 h background) exceeds the old 300s
 * cap, which produced false "No bridged SDK tool result arrived" errors while
 * the command was still running successfully.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/sqlite-client", () => ({
  getRawSqlite: vi.fn(() => null),
  getDb: vi.fn(() => null),
}));

vi.mock("@/lib/media/base64-extract", () => ({
  sanitizeToolResultForBase64: vi.fn(async (value: unknown) => ({ sanitized: value, mediaRefs: [] })),
  attachMediaRefs: vi.fn((payload: unknown) => payload),
}));

import { createSdkPassthroughTool } from "@/app/api/chat/sdk-passthrough-tool";
import { createSdkToolResultBridge } from "@/app/api/chat/sdk-tool-result-bridge";
import { mcpContextStore, type SeleneMcpContext } from "@/lib/ai/providers/mcp-context-store";

type ToolExecute = (
  args: Record<string, unknown>,
  options: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal },
) => Promise<unknown>;

function runWithBridge<T>(bridge: ReturnType<typeof createSdkToolResultBridge>, fn: () => T): T {
  const ctx: SeleneMcpContext = {
    userId: "user-1",
    sessionId: "session-1",
    characterId: null,
    sdkToolResultBridge: bridge,
  };
  return mcpContextStore.run(ctx, fn);
}

function track<T>(promise: Promise<T>): { settled: () => boolean; promise: Promise<T> } {
  let settled = false;
  const wrapped = promise.then(
    (value) => { settled = true; return value; },
    (error) => { settled = true; throw error; },
  );
  return { settled: () => settled, promise: wrapped };
}

describe("createSdkPassthroughTool", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps waiting well past 300s and resolves with the bridged output when it finally arrives", async () => {
    const bridge = createSdkToolResultBridge();
    const tool = createSdkPassthroughTool("Bash", { sessionId: "session-1" });
    const execute = tool.execute as unknown as ToolExecute;

    const pending = track(
      runWithBridge(bridge, () =>
        execute({ command: "sleep 400; echo done" }, { toolCallId: "toolu_long", messages: [] }),
      ),
    );

    // Old behaviour: a 300_000ms timer would have fired here and returned the
    // "No bridged SDK tool result arrived" fallback.
    await vi.advanceTimersByTimeAsync(300_000);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(pending.settled()).toBe(false);

    bridge.publish("toolu_long", { stdout: "done\n", exit_code: 0 }, "Bash");
    const output = (await pending.promise) as Record<string, unknown>;

    expect(output.sdkPassthroughMissing).toBeUndefined();
    expect(JSON.stringify(output)).toContain("done");
  });

  it("returns the structured missing-result output when the request aborts mid-wait", async () => {
    const bridge = createSdkToolResultBridge();
    const tool = createSdkPassthroughTool("Bash", { sessionId: "session-1" });
    const execute = tool.execute as unknown as ToolExecute;
    const controller = new AbortController();

    const pending = track(
      runWithBridge(bridge, () =>
        execute({ command: "sleep 999" }, { toolCallId: "toolu_abort", messages: [], abortSignal: controller.signal }),
      ),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pending.settled()).toBe(false);

    controller.abort();
    const output = (await pending.promise) as Record<string, unknown>;
    expect(output.sdkPassthroughMissing).toBe(true);
    expect(output.status).toBe("error");
  });

  it("returns the structured missing-result output when the bridge is disposed at end of stream", async () => {
    const bridge = createSdkToolResultBridge();
    const tool = createSdkPassthroughTool("Read", { sessionId: "session-1" });
    const execute = tool.execute as unknown as ToolExecute;

    const pending = track(
      runWithBridge(bridge, () => execute({ file_path: "/x" }, { toolCallId: "toolu_disposed", messages: [] })),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pending.settled()).toBe(false);

    bridge.dispose?.();
    const output = (await pending.promise) as Record<string, unknown>;
    expect(output.sdkPassthroughMissing).toBe(true);
  });

  it("returns the plain passthrough marker when no bridge is on the context", async () => {
    const tool = createSdkPassthroughTool("Bash", { sessionId: "session-1" });
    const execute = tool.execute as unknown as ToolExecute;
    const output = (await execute({ command: "ls" }, { toolCallId: "toolu_nobridge", messages: [] })) as Record<string, unknown>;
    expect(output._sdkPassthrough).toBe(true);
  });
});
