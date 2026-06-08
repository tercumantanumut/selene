import { describe, expect, it, vi } from "vitest";

import { convertDBMessagesToUIMessages } from "@/lib/messages/converter";

/**
 * Regression: historical chat rows can contain tool-call/tool-result parts
 * persisted with `toolName: "tool"` from before the streaming-state fix
 * (GPT-5/Codex Responses API occasionally emitted unnamed `tool-input-start`
 * chunks; we previously substituted the literal string "tool"). Projecting
 * those back to UIMessages as `tool-tool` would round-trip to the model on
 * the next turn and produce confused reasoning summaries.
 *
 * The converter must drop such parts from the UI projection so the poison
 * is neutralized lazily without a database migration.
 */
describe("converter phantom-tool boundary filter", () => {
  it("drops tool-call parts whose toolName is the literal 'tool' placeholder", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const now = new Date().toISOString();

    const uiMessages = convertDBMessagesToUIMessages([
      {
        id: "a1",
        role: "assistant",
        content: [
          { type: "text", text: "Reading the file." },
          {
            type: "tool-call",
            toolCallId: "call-poisoned",
            toolName: "tool",
            args: { path: "x.ts" },
            state: "input-available",
          },
          {
            type: "tool-result",
            toolCallId: "call-poisoned",
            toolName: "tool",
            result: { status: "success", contents: "..." },
            status: "success",
            state: "output-available",
          },
        ],
        createdAt: now,
        orderingIndex: 1,
      },
    ] as any);

    const assistant = uiMessages.find((msg) => msg.role === "assistant");
    const phantomToolParts = (assistant?.parts ?? []).filter((part) =>
      typeof part.type === "string" && part.type.startsWith("tool-")
    );

    expect(phantomToolParts).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Dropping unnamed tool-call call-poisoned")
    );

    warnSpy.mockRestore();
  });

  it("drops tool-call parts whose toolName is empty", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const now = new Date().toISOString();

    const uiMessages = convertDBMessagesToUIMessages([
      {
        id: "a1",
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-empty",
            toolName: "",
            args: {},
            state: "input-available",
          },
        ],
        createdAt: now,
        orderingIndex: 1,
      },
    ] as any);

    const assistant = uiMessages.find((msg) => msg.role === "assistant");
    const toolParts = (assistant?.parts ?? []).filter((part) =>
      typeof part.type === "string" && part.type.startsWith("tool-")
    );
    expect(toolParts).toHaveLength(0);

    warnSpy.mockRestore();
  });

  it("drops tool-call parts whose toolName is the structured unknown sentinel", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const now = new Date().toISOString();

    const uiMessages = convertDBMessagesToUIMessages([
      {
        id: "a1",
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-unknown",
            toolName: "__unknown_tool__",
            args: {},
            state: "input-available",
          },
        ],
        createdAt: now,
        orderingIndex: 1,
      },
    ] as any);

    const assistant = uiMessages.find((msg) => msg.role === "assistant");
    const toolParts = (assistant?.parts ?? []).filter((part) =>
      typeof part.type === "string" && part.type.startsWith("tool-")
    );
    expect(toolParts).toHaveLength(0);

    warnSpy.mockRestore();
  });

  it("drops orphan tool-results whose toolName is 'tool' even when no matching tool-call exists", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const now = new Date().toISOString();

    const uiMessages = convertDBMessagesToUIMessages([
      {
        id: "a1",
        role: "assistant",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-orphan",
            toolName: "tool",
            result: { status: "error", error: "Model stopped emitting tool input." },
            status: "error",
            state: "output-error",
          },
        ],
        createdAt: now,
        orderingIndex: 1,
      },
    ] as any);

    const assistant = uiMessages.find((msg) => msg.role === "assistant");
    const toolParts = (assistant?.parts ?? []).filter((part) =>
      typeof part.type === "string" && part.type.startsWith("tool-")
    );
    expect(toolParts).toHaveLength(0);

    warnSpy.mockRestore();
  });

  it("keeps real tool-call parts intact (regression guard)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const now = new Date().toISOString();

    const uiMessages = convertDBMessagesToUIMessages([
      {
        id: "a1",
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-real",
            toolName: "Read",
            args: { path: "x.ts" },
            state: "input-available",
          },
          {
            type: "tool-result",
            toolCallId: "call-real",
            toolName: "Read",
            result: { status: "success" },
            status: "success",
            state: "output-available",
          },
        ],
        createdAt: now,
        orderingIndex: 1,
      },
    ] as any);

    const assistant = uiMessages.find((msg) => msg.role === "assistant");
    const readPart = (assistant?.parts ?? []).find(
      (part) => typeof part.type === "string" && part.type === "tool-Read"
    );
    expect(readPart).toBeDefined();

    warnSpy.mockRestore();
  });
});
