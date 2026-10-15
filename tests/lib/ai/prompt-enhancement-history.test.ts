import { describe, expect, it } from "vitest";

import {
  buildPromptEnhancementHistory,
  formatPromptEnhancementAttachmentList,
} from "@/lib/ai/prompt-enhancement-history";

describe("prompt enhancement history assembly", () => {
  it("keeps the latest 6 user/assistant messages in chronological order", () => {
    const messages = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `message-${index}` }],
      orderingIndex: 8 - index,
    }));

    const history = buildPromptEnhancementHistory(messages);

    expect(history).toHaveLength(6);
    expect(history.map((message) => message.content)).toEqual([
      "message-5",
      "message-4",
      "message-3",
      "message-2",
      "message-1",
      "message-0",
    ]);
    expect(history.map((message) => message.role)).toEqual([
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
  });

  it("filters non-conversational lifecycle/task messages before applying the 6-message cap", () => {
    const messages = [
      { role: "user", content: "kept-1", orderingIndex: 1 },
      { role: "assistant", content: "kept-2", orderingIndex: 2 },
      { role: "system", content: "system interruption", orderingIndex: 3 },
      { role: "tool", content: "tool result", orderingIndex: 4 },
      { role: "user", content: "live prompt injection", metadata: { livePromptInjected: true }, orderingIndex: 5 },
      { role: "assistant", content: "delegation completion", metadata: { custom: { kind: "delegation_completion" } }, orderingIndex: 6 },
      { role: "user", content: [{ type: "tool-call", toolCallId: "t1", toolName: "search" }], orderingIndex: 7 },
      { role: "assistant", content: "kept-3", orderingIndex: 8 },
    ];

    const history = buildPromptEnhancementHistory(messages);

    expect(history).toEqual([
      { role: "user", content: "kept-1" },
      { role: "assistant", content: "kept-2" },
      { role: "assistant", content: "kept-3" },
    ]);
  });

  it("returns an empty history for empty or non-conversational input", () => {
    expect(buildPromptEnhancementHistory([])).toEqual([]);
    expect(buildPromptEnhancementHistory([
      { role: "system", content: "cancelled" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", toolName: "localGrep" }] },
    ])).toEqual([]);
  });

  it("preserves attachment references from message parts and metadata", () => {
    const history = buildPromptEnhancementHistory([
      {
        role: "user",
        content: [
          { type: "text", text: "Use this mockup" },
          {
            type: "image",
            image: "/api/media/mockup.png",
            displayName: "mockup.png",
            mediaType: "image/png",
          },
        ],
        metadata: {
          custom: {
            attachments: [
              {
                name: "spec.pdf",
                contentType: "application/pdf",
                filePath: "/tmp/spec.pdf",
              },
            ],
          },
        },
      },
    ]);

    expect(history).toHaveLength(1);
    expect(history[0].content).toContain("Use this mockup");
    expect(history[0].content).toContain("[Image: mockup.png");
    expect(history[0].content).toContain("/api/media/mockup.png");
    expect(history[0].content).toContain("[Attachment: spec.pdf");
    expect(history[0].content).toContain("/tmp/spec.pdf");
  });

  it("formats current composer attachments separately from chat history", () => {
    const formatted = formatPromptEnhancementAttachmentList([
      {
        name: "current-screenshot.png",
        contentType: "image/png",
        url: "/api/media/current-screenshot.png",
        filePath: "/tmp/current-screenshot.png",
        status: "complete",
      },
    ]);

    expect(formatted).toContain("Current composer attachments");
    expect(formatted).toContain("[Image: current-screenshot.png");
    expect(formatted).toContain("/tmp/current-screenshot.png");
    expect(formatted).toContain("status: complete");
  });
});
