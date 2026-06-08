import { describe, expect, it } from "vitest";

import {
  getVisibleActivitySignature,
  isMessageInitiallyThinking,
  shouldShowIdleThinking,
  SYNTHETIC_THINKING_IDLE_DELAY_MS,
} from "@/components/assistant-ui/thread-message-activity";
import { getToolBadgeStatus } from "@/components/assistant-ui/tool-status";

describe("thread message activity helpers", () => {
  it("treats running messages without visible text as initial thinking", () => {
    expect(isMessageInitiallyThinking({ type: "running" }, [])).toBe(true);
    expect(
      isMessageInitiallyThinking(
        { type: "running" },
        [{ type: "tool-call", toolCallId: "tool-1", toolName: "localGrep" }]
      )
    ).toBe(true);
  });

  it("stops initial thinking once visible text is present", () => {
    expect(
      isMessageInitiallyThinking(
        { type: "running" },
        [{ type: "text", text: "Working on it" }]
      )
    ).toBe(false);
  });

  it("shows idle thinking only after the inactivity threshold", () => {
    const now = 50_000;
    const lastVisibleActivityAt = now - SYNTHETIC_THINKING_IDLE_DELAY_MS;

    expect(
      shouldShowIdleThinking({ type: "running" }, lastVisibleActivityAt, now)
    ).toBe(true);
    expect(
      shouldShowIdleThinking({ type: "running" }, lastVisibleActivityAt + 1, now)
    ).toBe(false);
    expect(
      shouldShowIdleThinking({ type: "complete" }, lastVisibleActivityAt, now)
    ).toBe(false);
  });

  it("includes live tool progress in the visible activity signature", () => {
    const parts = [
      {
        type: "tool-call",
        toolCallId: "tool-1",
        toolName: "localGrep",
        args: { pattern: "TODO" },
      },
    ];

    const baselene = getVisibleActivitySignature(parts, {});
    const withProgress = getVisibleActivitySignature(parts, {
      "tool-1": {
        toolCallId: "tool-1",
        toolName: "localGrep",
        canonicalToolName: "localGrep",
        phase: "running",
        label: "Running",
        detail: "Scanning src",
        updatedAt: 1,
      },
    });

    expect(withProgress).not.toBe(baselene);
    expect(withProgress).toContain("Scanning src");
  });

  it("changes signature when text grows after tool churn", () => {
    const before = getVisibleActivitySignature([
      { type: "tool-call", toolCallId: "tool-1", toolName: "localGrep" },
    ]);
    const after = getVisibleActivitySignature([
      { type: "tool-call", toolCallId: "tool-1", toolName: "localGrep" },
      { type: "text", text: "Final answer" },
    ]);

    expect(after).not.toBe(before);
    expect(after).toContain("Final answer");
  });
});

describe("getToolBadgeStatus", () => {
  it("keeps unresolved tool calls running when the assistant message is incomplete", () => {
    expect(
      getToolBadgeStatus({
        status: { type: "incomplete" },
      })
    ).toBe("running");
  });

  it("still marks unresolved tool calls running when sibling delegations have settled", () => {
    expect(
      getToolBadgeStatus({
        toolCallId: "delegate-2",
        toolName: "delegateToSubagent",
        status: { type: "incomplete" },
      })
    ).toBe("running");

    expect(
      getToolBadgeStatus({
        toolCallId: "delegate-1",
        toolName: "delegateToSubagent",
        status: { type: "complete" },
        result: { completed: true },
      })
    ).toBe("completed");
  });

  it("treats running shell tool results as running before the final output arrives", () => {
    expect(
      getToolBadgeStatus({
        status: { type: "complete" },
        result: { status: "running", message: "Running git status..." },
      })
    ).toBe("running");
  });
});
