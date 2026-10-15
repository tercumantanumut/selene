import { describe, expect, it } from "vitest";

import {
  TokenTracker,
  getReliableMessageTokenCount,
} from "@/lib/context-window/token-tracker";

describe("TokenTracker legacy token handling", () => {
  it("falls back to content estimate for legacy assistant rows", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "x".repeat(80) }],
      tokenCount: 500,
      metadata: {
        usage: {
          inputTokens: 420,
          outputTokens: 80,
          totalTokens: 500,
        },
      },
    } as any;

    expect(getReliableMessageTokenCount(message)).toBe(20);
  });

  it("keeps tokenCount for non-legacy assistant rows", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "x".repeat(80) }],
      tokenCount: 33,
      metadata: {
        usage: {
          inputTokens: 420,
          outputTokens: 80,
          totalTokens: 500,
        },
      },
    } as any;

    expect(getReliableMessageTokenCount(message)).toBe(33);
  });

  it("ignores synthetic tool-result messages from context usage", async () => {
    const usage = await TokenTracker.calculateUsage(
      "session-1",
      [
        {
          id: "assistant-1",
          sessionId: "session-1",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          tokenCount: 1,
          isCompacted: false,
          metadata: {},
        },
        {
          id: "tool-1",
          sessionId: "session-1",
          role: "tool",
          content: [{ type: "tool-result", result: { status: "success" } }],
          tokenCount: 999,
          isCompacted: false,
          metadata: { syntheticToolResult: true },
        },
      ] as any,
      0,
      null
    );

    expect(usage.toolResultTokens).toBe(0);
    expect(usage.assistantMessageTokens).toBe(5);
  });
});

describe("TokenTracker scoped counting", () => {
  it("counts only main-scope parts for claudecode sessions", async () => {
    const usage = await TokenTracker.calculateUsage(
      "session-main-only",
      [
        {
          id: "assistant-mixed",
          sessionId: "session-main-only",
          role: "assistant",
          content: [
            { type: "text", text: "root answer", contextScope: "main" },
            { type: "text", text: "delegated trace", contextScope: "delegated" },
            { type: "tool-call", toolCallId: "tc-1", toolName: "Task", state: "output-available", contextScope: "delegated" },
          ],
          tokenCount: 400,
          isCompacted: false,
          metadata: {},
        },
      ] as any,
      0,
      null,
      {
        provider: "claudecode",
        scopedMode: "scoped",
      }
    );

    const expectedTextTokens = Math.ceil("root answer".length / 4);
    expect(usage.assistantMessageTokens).toBe(expectedTextTokens + 4);
    expect(usage.toolCallTokens).toBe(0);
  });

  it("counts delegated-scope parts when the measured session is a subagent worker", async () => {
    const usage = await TokenTracker.calculateUsage(
      "session-delegated-worker",
      [
        {
          id: "assistant-delegated-worker",
          sessionId: "session-delegated-worker",
          role: "assistant",
          content: [
            { type: "text", text: "worker answer", contextScope: "delegated" },
            { type: "text", text: "root-only trace", contextScope: "main" },
          ],
          tokenCount: 400,
          isCompacted: false,
          metadata: { contextScope: "delegated" },
        },
      ] as any,
      0,
      null,
      {
        provider: "openai",
        targetScope: "delegated",
        hasDelegatedAnnotations: true,
      }
    );

    const expectedTextTokens = Math.ceil("worker answer".length / 4);
    expect(usage.assistantMessageTokens).toBe(expectedTextTokens + 4);
  });

  it("falls back to legacy behavior for non-claudecode providers", async () => {
    const messages = [
      {
        id: "assistant-legacy",
        sessionId: "session-legacy",
        role: "assistant",
        content: [{ type: "text", text: "hello legacy" }],
        tokenCount: 42,
        isCompacted: false,
        metadata: {},
      },
    ] as any;

    const legacyUsage = await TokenTracker.calculateUsage(
      "session-legacy",
      messages,
      0,
      null,
      {
        provider: "openai",
      }
    );

    expect(legacyUsage.assistantMessageTokens).toBe(46);
  });

  it("applies legacy fallback heuristic for untagged delegated tool calls", async () => {
    const usage = await TokenTracker.calculateUsage(
      "session-fallback",
      [
        {
          id: "assistant-untagged",
          sessionId: "session-fallback",
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "tc-legacy", toolName: "Task", state: "input-available" },
            { type: "text", text: "internal delegated chatter" },
            { type: "tool-result", toolCallId: "tc-legacy", toolName: "Task", state: "output-available", result: { ok: true } },
          ],
          tokenCount: 200,
          isCompacted: false,
          metadata: {},
        },
      ] as any,
      0,
      null,
      {
        provider: "claudecode",
        scopedMode: "scoped",
        fallbackEnabled: true,
        fallbackMinConfidence: 0.6,
      }
    );

    expect(usage.assistantMessageTokens).toBe(0);
    expect(usage.toolCallTokens).toBe(0);
  });

  it("keeps conservative counting when fallback confidence threshold is too high", async () => {
    const usage = await TokenTracker.calculateUsage(
      "session-high-threshold",
      [
        {
          id: "assistant-threshold",
          sessionId: "session-high-threshold",
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "tc-threshold", toolName: "Task", state: "input-available" },
            { type: "text", text: "ambiguous text" },
          ],
          tokenCount: 200,
          isCompacted: false,
          metadata: {},
        },
      ] as any,
      0,
      null,
      {
        provider: "claudecode",
        scopedMode: "scoped",
        fallbackEnabled: true,
        fallbackMinConfidence: 0.99,
      }
    );

    expect(usage.assistantMessageTokens).toBeGreaterThan(0);
  });

  it("excludes delegated intermediate observe parts when delegated annotations are present", async () => {
    const usage = await TokenTracker.calculateUsage(
      "session-delegate-intermediate",
      [
        {
          id: "assistant-delegate-intermediate",
          sessionId: "session-delegate-intermediate",
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "delegate-1", toolName: "delegateToSubagent", contextScope: "delegated" },
            {
              type: "tool-result",
              toolCallId: "delegate-1",
              toolName: "delegateToSubagent",
              contextScope: "delegated",
              result: {
                running: true,
                completed: false,
                allResponses: ["partial"],
              },
            },
          ],
          tokenCount: 500,
          isCompacted: false,
          metadata: {},
        },
      ] as any,
      0,
      null,
      {
        provider: "openai",
        hasDelegatedAnnotations: true,
      }
    );

    expect(usage.assistantMessageTokens).toBe(0);
    expect(usage.toolCallTokens).toBe(0);
    expect(usage.toolResultTokens).toBe(0);
  });

  it("keeps final observe results counted when they are not delegated-tagged", async () => {
    const usage = await TokenTracker.calculateUsage(
      "session-delegate-final",
      [
        {
          id: "assistant-delegate-final",
          sessionId: "session-delegate-final",
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "delegate-2", toolName: "delegateToSubagent", contextScope: "main" },
            {
              type: "tool-result",
              toolCallId: "delegate-2",
              toolName: "delegateToSubagent",
              contextScope: "main",
              result: {
                running: false,
                completed: true,
                lastResponse: "done",
              },
            },
          ],
          tokenCount: 220,
          isCompacted: false,
          metadata: {},
        },
      ] as any,
      0,
      null,
      {
        provider: "openai",
        hasDelegatedAnnotations: true,
      }
    );

    expect(usage.assistantMessageTokens).toBeGreaterThan(0);
  });

  it("keeps behavior unchanged when no delegated annotations exist", async () => {
    const messages = [
      {
        id: "assistant-main-only",
        sessionId: "session-main-only-annotations",
        role: "assistant",
        content: [{ type: "text", text: "plain assistant text" }],
        tokenCount: 50,
        isCompacted: false,
        metadata: { contextScope: "main" },
      },
    ] as any;

    const withoutFlag = await TokenTracker.calculateUsage(
      "session-main-only-annotations",
      messages,
      0,
      null,
      {
        provider: "openai",
      }
    );

    const withFalseFlag = await TokenTracker.calculateUsage(
      "session-main-only-annotations",
      messages,
      0,
      null,
      {
        provider: "openai",
        hasDelegatedAnnotations: false,
      }
    );

    expect(withoutFlag.totalTokens).toBe(withFalseFlag.totalTokens);
  });

  it("does not activate scoped exclusion with only main annotations", async () => {
    const usage = await TokenTracker.calculateUsage(
      "session-main-annotation-only",
      [
        {
          id: "assistant-main-annotation",
          sessionId: "session-main-annotation-only",
          role: "assistant",
          content: [{ type: "text", text: "still counted", contextScope: "main" }],
          tokenCount: 120,
          isCompacted: false,
          metadata: { contextScope: "main" },
        },
      ] as any,
      0,
      null,
      {
        provider: "openai",
      }
    );

    expect(usage.assistantMessageTokens).toBeGreaterThan(0);
  });
});
