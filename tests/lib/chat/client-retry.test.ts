import { describe, expect, it } from "vitest";

import {
  buildRetryMessage,
  getLastUserMessageId,
  hasMeaningfulAssistantContent,
  shouldAutoRetryClientChat,
} from "@/lib/chat/client-retry";

describe("client retry helpers", () => {
  it("finds the latest user message id", () => {
    expect(
      getLastUserMessageId([
        { id: "u1", role: "user", parts: [] } as any,
        { id: "a1", role: "assistant", parts: [] } as any,
        { id: "u2", role: "user", parts: [] } as any,
      ] as any),
    ).toBe("u2");
  });

  it("detects meaningful assistant output", () => {
    expect(
      hasMeaningfulAssistantContent({
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "done" }],
      } as any),
    ).toBe(true);

    expect(
      hasMeaningfulAssistantContent({
        id: "a1",
        role: "assistant",
        parts: [{ type: "tool-searchTools", state: "input-available" }],
      } as any),
    ).toBe(false);
  });

  it("retries recoverable empty assistant failures", () => {
    expect(
      shouldAutoRetryClientChat({
        error: new Error("Streaming interrupted: server_error"),
        messages: [
          { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
          { id: "a1", role: "assistant", parts: [] },
        ] as any,
      }),
    ).toBe(true);
  });

  it("retries immediate-stop failures when only the user turn remains", () => {
    expect(
      shouldAutoRetryClientChat({
        error: new Error("Streaming interrupted: server_error"),
        messages: [
          { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
        ] as any,
      }),
    ).toBe(true);
  });

  it("builds a resendable retry message from the last user turn", () => {
    expect(
      buildRetryMessage([
        { id: "u1", role: "user", metadata: { custom: { foo: "bar" } }, parts: [{ type: "text", text: "hi" }] },
        { id: "a1", role: "assistant", parts: [] },
      ] as any),
    ).toEqual({
      id: "u1",
      role: "user",
      metadata: { custom: { foo: "bar" } },
      parts: [{ type: "text", text: "hi" }],
      messageId: "u1",
    });
  });

  it("does not retry once assistant content exists or error is non-recoverable", () => {
    expect(
      shouldAutoRetryClientChat({
        error: new Error("Streaming interrupted: server_error"),
        messages: [
          { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
          { id: "a1", role: "assistant", parts: [{ type: "text", text: "partial" }] },
        ] as any,
      }),
    ).toBe(false);

    expect(
      shouldAutoRetryClientChat({
        error: new Error("permission denied"),
        messages: [
          { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
          { id: "a1", role: "assistant", parts: [] },
        ] as any,
      }),
    ).toBe(false);

    expect(
      shouldAutoRetryClientChat({
        error: new Error("Your input exceeds the context window of this model."),
        messages: [
          { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
          { id: "a1", role: "assistant", parts: [] },
        ] as any,
      }),
    ).toBe(false);
  });
});
