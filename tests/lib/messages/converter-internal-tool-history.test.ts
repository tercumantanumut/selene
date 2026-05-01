import { describe, expect, it } from "vitest";

import { convertDBMessagesToUIMessages, convertToThreadMessageLike } from "@/lib/messages/converter";
import {
  isInternalAssistantLeakText,
  isInternalToolHistoryLeakText,
} from "@/lib/messages/internal-tool-history";

describe("converter internal tool history guard", () => {
  it("hides leaked internal tool fallback assistant text while preserving real tool parts", () => {
    const leakedText =
      '[Previous tool result; call_id=call_legacy]: {"status":"success","stdout":"..." }';
    const now = new Date().toISOString();

    const uiMessages = convertDBMessagesToUIMessages([
      {
        id: "u1",
        role: "user",
        content: [{ type: "text", text: leakedText }],
        createdAt: now,
        orderingIndex: 1,
      },
      {
        id: "a1",
        role: "assistant",
        content: [
          { type: "text", text: leakedText },
          {
            type: "tool-call",
            toolCallId: "call_legacy",
            toolName: "localGrep",
            args: { pattern: "x" },
            state: "input-available",
          },
          {
            type: "tool-result",
            toolCallId: "call_legacy",
            toolName: "localGrep",
            result: { status: "success", matchCount: 1 },
            status: "success",
            state: "output-available",
          },
        ],
        createdAt: now,
        orderingIndex: 2,
      },
    ] as any);

    expect(uiMessages).toHaveLength(2);

    const user = uiMessages.find((msg) => msg.role === "user");
    const assistant = uiMessages.find((msg) => msg.role === "assistant");

    const userTextParts = (user?.parts ?? []).filter(
      (part): part is { type: "text"; text: string } =>
        part.type === "text" && typeof (part as { text?: unknown }).text === "string"
    );
    expect(userTextParts[0]?.text).toContain("[Previous tool result;");

    const assistantTextParts = (assistant?.parts ?? []).filter(
      (part): part is { type: "text"; text: string } =>
        part.type === "text" && typeof (part as { text?: unknown }).text === "string"
    );
    expect(assistantTextParts.some((part) => isInternalToolHistoryLeakText(part.text))).toBe(false);

    const assistantToolParts = (assistant?.parts ?? []).filter(
      (part) => typeof part.type === "string" && part.type.startsWith("tool-")
    );
    expect(assistantToolParts.length).toBeGreaterThan(0);
  });

  // Fixture-based test removed: docs/dev/auth-and-vector-engine-audit-162c03ba.json
  // was cleaned up in repo cleanup (6b474e5). The inline test above covers the
  // same converter guard logic without depending on an external fixture file.

  it("keeps assistant messages as empty placeholders when all parts are sanitized", () => {
    const now = new Date().toISOString();

    const uiMessages = convertDBMessagesToUIMessages([
      {
        id: "a-empty",
        role: "assistant",
        content: [
          {
            type: "text",
            text: '[Previous tool result; call_id=call_1]: {"status":"success"}',
          },
        ],
        createdAt: now,
        orderingIndex: 1,
      },
    ] as any);

    expect(uiMessages).toHaveLength(1);
    expect(uiMessages[0]?.role).toBe("assistant");

    const textParts = (uiMessages[0]?.parts ?? []).filter(
      (part): part is { type: "text"; text: string } =>
        part.type === "text" && typeof (part as { text?: unknown }).text === "string"
    );
    expect(textParts).toHaveLength(1);
    expect(textParts[0]?.text).toBe("");
  });

  it("preserves attachment filenames across DB to UI and thread rehydration", () => {
    const now = new Date().toISOString();
    const filename = "Screenshot 2026-02-10 at 11.05.48\u202fAM (1).png";

    const uiMessages = convertDBMessagesToUIMessages([
      {
        id: "u-attachment",
        role: "user",
        content: [
          {
            type: "file",
            url: "/api/media/sessions/sess-1/uploads/screenshot.png",
            filename,
            mediaType: "image/png",
          },
        ],
        createdAt: now,
        orderingIndex: 1,
      },
    ] as any);

    expect(uiMessages).toHaveLength(1);
    const filePart = (uiMessages[0]?.parts ?? []).find(
      (part): part is { type: "file"; url: string; filename?: string; mediaType?: string } => part.type === "file"
    );
    expect(filePart?.filename).toBe(filename);
    expect(filePart?.mediaType).toBe("image/png");

    const threadMessages = convertToThreadMessageLike(uiMessages as any);
    expect(threadMessages).toHaveLength(1);
    expect(threadMessages[0]?.content).toEqual([
      {
        type: "file",
        url: "/api/media/sessions/sess-1/uploads/screenshot.png",
        filename,
        mediaType: "image/png",
      },
    ]);
  });

  it("preserves unresolved pending tool calls through DB to UI conversion", () => {
    const now = new Date().toISOString();

    const uiMessages = convertDBMessagesToUIMessages([
      {
        id: "a-pending",
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-pending",
            toolName: "delegateToSubagent",
            args: { action: "start", agentName: "Reviewer" },
            state: "input-available",
            active: true,
          },
        ],
        createdAt: now,
        orderingIndex: 1,
      },
    ] as any);

    expect(uiMessages).toHaveLength(1);
    const toolPart = uiMessages[0]?.parts.find(
      (part: any) => part.toolCallId === "call-pending"
    ) as any;
    expect(toolPart).toBeDefined();
    expect(toolPart.state).toBe("input-available");
    expect(toolPart.active).toBe(true);
    expect(toolPart.output).toBeUndefined();
  });

  it("preserves persisted attachment metadata on rehydrated UI messages", () => {
    const now = new Date().toISOString();

    const uiMessages = convertDBMessagesToUIMessages([
      {
        id: "u-meta",
        role: "user",
        content: [
          {
            type: "image",
            image: "/api/media/sessions/sess-1/uploads/mockup.png",
            filename: "mockup.png",
            mediaType: "image/png",
          },
        ],
        metadata: {
          custom: {
            attachments: [
              {
                name: "mockup.png",
                contentType: "image/png",
                url: "/api/media/sessions/sess-1/uploads/mockup.png",
                localPath: "sessions/sess-1/uploads/mockup.png",
                filePath: "/tmp/sessions/sess-1/uploads/mockup.png",
                kind: "image",
              },
            ],
          },
        },
        createdAt: now,
        orderingIndex: 1,
      },
    ] as any);

    expect((uiMessages[0]?.metadata as any)?.custom?.attachments).toEqual([
      expect.objectContaining({
        url: "/api/media/sessions/sess-1/uploads/mockup.png",
        localPath: "sessions/sess-1/uploads/mockup.png",
        filePath: "/tmp/sessions/sess-1/uploads/mockup.png",
        kind: "image",
      }),
    ]);
  });

  it("preserves inline image identity while keeping attachment previews separate", () => {
    const now = new Date().toISOString();

    const uiMessages = convertDBMessagesToUIMessages([
      {
        id: "u-inline-images",
        role: "user",
        content: [
          { type: "text", text: "intro" },
          {
            type: "image",
            id: "editor-inline-image-1",
            image: "/api/media/sessions/sess-1/uploads/hero.png",
            displayName: "[Image 1]",
            mediaType: "image/png",
            inline: true,
            order: 1,
          },
          { type: "text", text: "middle" },
          {
            type: "image",
            id: "editor-inline-image-2",
            image: "/api/media/sessions/sess-1/uploads/detail.jpg",
            displayName: "[Image 2]",
            mediaType: "image/jpeg",
            inline: true,
            order: 2,
          },
          { type: "text", text: "outro" },
        ],
        metadata: {
          custom: {
            inlineAttachments: [
              {
                id: "editor-inline-image-1",
                name: "[Image 1]",
                contentType: "image/png",
                url: "/api/media/sessions/sess-1/uploads/hero.png",
                inline: true,
                order: 1,
                kind: "inline-image",
              },
              {
                id: "editor-inline-image-2",
                name: "[Image 2]",
                contentType: "image/jpeg",
                url: "/api/media/sessions/sess-1/uploads/detail.jpg",
                inline: true,
                order: 2,
                kind: "inline-image",
              },
            ],
          },
        },
        createdAt: now,
        orderingIndex: 1,
      },
    ] as any);

    expect(uiMessages[0]?.parts).toEqual([
      { type: "text", text: "intro" },
      {
        type: "file",
        id: "editor-inline-image-1",
        mediaType: "image/png",
        url: "/api/media/sessions/sess-1/uploads/hero.png",
        filename: "[Image 1]",
      },
      { type: "text", text: "middle" },
      {
        type: "file",
        id: "editor-inline-image-2",
        mediaType: "image/jpeg",
        url: "/api/media/sessions/sess-1/uploads/detail.jpg",
        filename: "[Image 2]",
      },
      { type: "text", text: "outro" },
    ]);
    expect((uiMessages[0]?.metadata as any)?.custom?.attachments).toBeUndefined();
    expect((uiMessages[0]?.metadata as any)?.custom?.inlineAttachments).toHaveLength(2);
  });

  it("hides leaked assistant planning prose while preserving tool parts", () => {
    const leakedPlanningText =
      "I need continue with actual tools available names. Only commentary tools under functions.* not tool. Need sequential edits. Must read current files before edit. Need use editFile and run tests. Let's implement carefully. Need add setting to app/settings/settings-types FormState.";
    const now = new Date().toISOString();

    const uiMessages = convertDBMessagesToUIMessages([
      {
        id: "u-planning",
        role: "user",
        content: [{ type: "text", text: leakedPlanningText }],
        createdAt: now,
        orderingIndex: 1,
      },
      {
        id: "a-planning",
        role: "assistant",
        content: [
          { type: "text", text: leakedPlanningText },
          {
            type: "tool-call",
            toolCallId: "call_planning",
            toolName: "editFile",
            args: { filePath: "route.ts" },
            state: "input-available",
          },
          {
            type: "tool-result",
            toolCallId: "call_planning",
            toolName: "editFile",
            result: { status: "success" },
            status: "success",
            state: "output-available",
          },
        ],
        createdAt: now,
        orderingIndex: 2,
      },
    ] as any);

    const user = uiMessages.find((msg) => msg.role === "user");
    const assistant = uiMessages.find((msg) => msg.role === "assistant");

    const userTextParts = (user?.parts ?? []).filter(
      (part): part is { type: "text"; text: string } =>
        part.type === "text" && typeof (part as { text?: unknown }).text === "string"
    );
    expect(userTextParts[0]?.text).toBe(leakedPlanningText);

    const assistantTextParts = (assistant?.parts ?? []).filter(
      (part): part is { type: "text"; text: string } =>
        part.type === "text" && typeof (part as { text?: unknown }).text === "string"
    );
    expect(assistantTextParts.some((part) => isInternalAssistantLeakText(part.text))).toBe(false);
    expect(assistantTextParts).toHaveLength(0);

    const assistantToolParts = (assistant?.parts ?? []).filter(
      (part) => typeof part.type === "string" && part.type.startsWith("tool-")
    );
    expect(assistantToolParts.length).toBeGreaterThan(0);
  });
});
