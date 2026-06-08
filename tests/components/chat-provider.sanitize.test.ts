import { describe, expect, it } from "vitest";

import {
  sanitizeMessagesForInit,
  toCreateMessageWithAttachmentMetadata,
} from "@/components/chat-provider";
import { buildRetryMessage } from "@/lib/chat/client-retry";

describe("sanitizeMessagesForInit", () => {
  it("preserves the stopped user turn for resend-based retries", () => {
    const messages = [
      {
        id: "user-stop",
        role: "user",
        metadata: { custom: { attachments: [{ name: "brief.txt" }] } },
        parts: [{ type: "text", text: "Please continue" }],
      },
    ] as any;

    const sanitized = sanitizeMessagesForInit(messages);
    expect(sanitized).toEqual(messages);
    expect(buildRetryMessage(sanitized as any)).toEqual({
      id: "user-stop",
      role: "user",
      metadata: { custom: { attachments: [{ name: "brief.txt" }] } },
      parts: [{ type: "text", text: "Please continue" }],
      messageId: "user-stop",
    });
  });

  it("keeps active tool calls that are explicitly marked as streaming-active", () => {
    const messages = [
      {
        id: "assistant-active",
        role: "assistant",
        parts: [
          { type: "text", text: "Working" },
          {
            type: "tool-localGrep",
            toolCallId: "tool-active",
            state: "input-available",
            input: { pattern: "todo" },
            active: true,
          },
        ],
      },
    ] as any;

    const sanitized = sanitizeMessagesForInit(messages);
    const assistant = sanitized[0];
    const activePart = assistant.parts.find((part: any) => part.toolCallId === "tool-active");

    expect(activePart).toBeDefined();
    expect((activePart as any).active).toBe(true);
  });

  it("removes unresolved tool parts that are not marked pending", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          { type: "text", text: "starting" },
          {
            type: "tool-executeCommand",
            toolCallId: "tool-stream",
            state: "input-streaming",
            input: { command: "echo" },
          },
          {
            type: "tool-localGrep",
            toolCallId: "tool-dangling",
            state: "input-available",
            input: { pattern: "todo" },
          },
          {
            type: "tool-localGrep",
            toolCallId: "tool-complete",
            state: "output-available",
            input: { pattern: "done" },
            output: { count: 1 },
          },
        ],
      },
    ] as any;

    const sanitized = sanitizeMessagesForInit(messages);
    expect(sanitized).toHaveLength(1);

    const assistant = sanitized[0];
    const toolCallIds = assistant.parts
      .filter((part: any) => typeof part.type === "string" && part.type.startsWith("tool-"))
      .map((part: any) => part.toolCallId);

    expect(toolCallIds).toEqual(["tool-complete"]);
  });

  it("keeps unresolved input-available tool parts when marked pending", () => {
    const messages = [
      {
        id: "assistant-pending",
        role: "assistant",
        parts: [
          { type: "text", text: "delegating" },
          {
            type: "tool-delegateToSubagent",
            toolCallId: "tool-pending",
            state: "input-available",
            input: { action: "start", agentName: "Reviewer" },
            active: true,
          },
        ],
      },
    ] as any;

    const sanitized = sanitizeMessagesForInit(messages);
    const assistant = sanitized[0];
    const pendingPart = assistant.parts.find((part: any) => part.toolCallId === "tool-pending");

    expect(pendingPart).toBeDefined();
    expect((pendingPart as any).active).toBe(true);
  });

  it("keeps interrupted tool parts with output payloads", () => {
    const messages = [
      {
        id: "assistant-interrupted",
        role: "assistant",
        parts: [
          { type: "text", text: "Stopped while browsing" },
          {
            type: "tool-chromiumWorkspace",
            toolCallId: "tool-browser",
            state: "input-available",
            input: { action: "open", url: "https://example.com" },
            output: {
              status: "success",
              data: "Browser session opened. Navigated to: https://example.com",
              pageUrl: "https://example.com",
            },
          },
        ],
      },
    ] as any;

    const sanitized = sanitizeMessagesForInit(messages);
    expect(sanitized).toHaveLength(1);

    const assistant = sanitized[0];
    const browserPart = assistant.parts.find(
      (part: any) => part.toolCallId === "tool-browser"
    );

    expect(browserPart).toBeDefined();
    expect((browserPart as any).output).toEqual({
      status: "success",
      data: "Browser session opened. Navigated to: https://example.com",
      pageUrl: "https://example.com",
    });
  });

  it("deduplicates attachment-backed image parts when building a UI message", () => {
    const uiMessage = toCreateMessageWithAttachmentMetadata({
      role: "user",
      content: [
        { type: "text", text: "whats in the image" },
        { type: "image", image: "/api/media/sessions/sess-1/uploads/mockup.png" },
      ],
      attachments: [
        {
          id: "attachment-1",
          type: "image",
          name: "mockup.png",
          contentType: "image/png",
          content: [{ type: "image", image: "/api/media/sessions/sess-1/uploads/mockup.png" }],
          status: { type: "complete" },
          metadata: {
            url: "/api/media/sessions/sess-1/uploads/mockup.png",
            contentType: "image/png",
            kind: "image",
          },
        },
      ],
    } as any);

    expect(uiMessage.parts).toEqual([
      { type: "text", text: "whats in the image" },
      {
        type: "file",
        url: "/api/media/sessions/sess-1/uploads/mockup.png",
        filename: "mockup.png",
        mediaType: "image/png",
      },
    ]);
    expect((uiMessage.metadata as any)?.custom?.attachments).toEqual([
      expect.objectContaining({
        url: "/api/media/sessions/sess-1/uploads/mockup.png",
        contentType: "image/png",
        kind: "image",
      }),
    ]);
  });

  it("preserves rich-editor inline image ordering without attachment previews", () => {
    const uiMessage = toCreateMessageWithAttachmentMetadata({
      role: "user",
      content: [
        { type: "text", text: "intro" },
        {
          type: "image",
          id: "editor-inline-image-1",
          image: "/api/media/sessions/sess-1/uploads/hero.png",
          displayName: "[Image 1]",
          contentType: "image/png",
        },
        { type: "text", text: "middle" },
        {
          type: "image",
          id: "editor-inline-image-2",
          image: "/api/media/sessions/sess-1/uploads/detail.jpg",
          displayName: "[Image 2]",
          contentType: "image/jpeg",
        },
        { type: "text", text: "outro" },
      ],
      attachments: [],
    } as any);

    expect(uiMessage.parts).toEqual([
      { type: "text", text: "intro" },
      {
        type: "file",
        id: "editor-inline-image-1",
        url: "/api/media/sessions/sess-1/uploads/hero.png",
        filename: "[Image 1]",
        mediaType: "image/png",
      },
      { type: "text", text: "middle" },
      {
        type: "file",
        id: "editor-inline-image-2",
        url: "/api/media/sessions/sess-1/uploads/detail.jpg",
        filename: "[Image 2]",
        mediaType: "image/jpeg",
      },
      { type: "text", text: "outro" },
    ]);
    expect((uiMessage.metadata as any)?.custom?.attachments).toBeUndefined();
    expect((uiMessage.metadata as any)?.custom?.inlineAttachments).toEqual([
      expect.objectContaining({
        id: "editor-inline-image-1",
        name: "[Image 1]",
        url: "/api/media/sessions/sess-1/uploads/hero.png",
        contentType: "image/png",
        inline: true,
        order: 1,
        kind: "inline-image",
      }),
      expect.objectContaining({
        id: "editor-inline-image-2",
        name: "[Image 2]",
        url: "/api/media/sessions/sess-1/uploads/detail.jpg",
        contentType: "image/jpeg",
        inline: true,
        order: 2,
        kind: "inline-image",
      }),
    ]);
  });
});
