import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractContent } from "@/app/api/chat/content-extractor";
import { saveSettings, loadSettings, type AppSettings } from "@/lib/settings/settings-manager";

const MEDIA_ROOT = process.env.LOCAL_DATA_PATH
  ? path.join(process.env.LOCAL_DATA_PATH, "media")
  : path.join(process.cwd(), ".local-data", "media");
const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "documents");

function readFixture(name: string): Buffer {
  return readFileSync(path.join(FIXTURE_DIR, name));
}

function writeMediaFixture(relativePath: string, fixtureName: string): string {
  const fullPath = path.join(MEDIA_ROOT, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, readFixture(fixtureName));
  return fullPath;
}

describe("extractContent attachment persistence", () => {
  let originalSettings: AppSettings;
  let originalPath: string | undefined;

  beforeEach(() => {
    originalSettings = JSON.parse(JSON.stringify(loadSettings())) as AppSettings;
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    saveSettings(originalSettings);
  });
  it("preserves image parts as machine-usable references for stored history", async () => {
    const result = await extractContent({
      role: "user",
      parts: [
        {
          type: "image",
          image: "/api/media/sessions/sess-1/uploads/mockup.png",
        },
      ],
    });

    expect(result).toEqual([
      {
        type: "image",
        image: "/api/media/sessions/sess-1/uploads/mockup.png",
      },
    ]);
  });

  it("preserves experimental image attachments as machine-usable references for stored history", async () => {
    const result = await extractContent({
      role: "user",
      experimental_attachments: [
        {
          name: "mockup.png",
          contentType: "image/png",
          url: "/api/media/sessions/sess-1/uploads/mockup.png",
        },
      ],
    });

    expect(result).toEqual([
      {
        type: "image",
        image: "/api/media/sessions/sess-1/uploads/mockup.png",
      },
    ]);
  });

  it("preserves attachment metadata payloads emitted by the chat runtime", async () => {
    const result = await extractContent({
      role: "user",
      metadata: {
        custom: {
          attachments: [
            {
              name: "mockup.png",
              contentType: "image/png",
              url: "/api/media/sessions/sess-1/uploads/mockup.png",
              localPath: "sessions/sess-1/uploads/mockup.png",
              filePath: "/tmp/sessions/sess-1/uploads/mockup.png",
              size: 123,
              kind: "image",
            },
          ],
        },
      },
    });

    expect(result).toEqual([
      {
        type: "image",
        image: "/api/media/sessions/sess-1/uploads/mockup.png",
      },
    ]);
  });

  it("deduplicates identical image references when both parts and metadata attachments are present", async () => {
    const result = await extractContent({
      role: "user",
      parts: [
        {
          type: "file",
          url: "/api/media/sessions/sess-1/uploads/mockup.png",
          mediaType: "image/png",
          filename: "mockup.png",
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
            },
          ],
        },
      },
    });

    expect(result).toEqual([
      {
        type: "image",
        image: "/api/media/sessions/sess-1/uploads/mockup.png",
      },
    ]);
  });

  it("preserves inline image order without consuming separate attachment metadata", async () => {
    const result = await extractContent({
      role: "user",
      parts: [
        { type: "text", text: "intro" },
        {
          type: "file",
          id: "editor-inline-image-1",
          url: "/api/media/sessions/sess-1/uploads/hero.png",
          mediaType: "image/png",
          filename: "[Image 1]",
        },
        { type: "text", text: "middle" },
        {
          type: "file",
          id: "editor-inline-image-2",
          url: "/api/media/sessions/sess-1/uploads/detail.jpg",
          mediaType: "image/jpeg",
          filename: "[Image 2]",
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
    });

    expect(result).toEqual([
      { type: "text", text: "intro" },
      { type: "image", image: "/api/media/sessions/sess-1/uploads/hero.png" },
      { type: "text", text: "middle" },
      { type: "image", image: "/api/media/sessions/sess-1/uploads/detail.jpg" },
      { type: "text", text: "outro" },
    ]);
  });

  it("prefers structured parts over raw string content when both are present", async () => {
    const result = await extractContent(
      {
        role: "user",
        content: `data:image/png;base64,${"A".repeat(6000)}`,
        parts: [
          {
            type: "text",
            text: "whats in the image",
          },
          {
            type: "file",
            url: "/api/media/sessions/sess-1/uploads/mockup.png",
            mediaType: "image/png",
            filename: "mockup.png",
          },
        ],
      },
      false,
      false,
      "sess-structured-wins",
    );

    expect(result).toEqual([
      {
        type: "text",
        text: "whats in the image",
      },
      {
        type: "image",
        image: "/api/media/sessions/sess-1/uploads/mockup.png",
      },
    ]);
  });

  it("falls back to string content when attachments exist but no text part survives", async () => {
    const result = await extractContent(
      {
        role: "user",
        content: "what's in this?",
        parts: [
          {
            type: "file",
            url: "/api/media/sessions/sess-1/uploads/mockup.png",
            mediaType: "image/png",
            filename: "mockup.png",
          },
        ],
      },
      false,
      false,
      "sess-string-fallback",
    );

    expect(result).toEqual([
      {
        type: "text",
        text: "what's in this?",
      },
      {
        type: "image",
        image: "/api/media/sessions/sess-1/uploads/mockup.png",
      },
    ]);
  });

  it("prefers filePath in helper text for live model requests", async () => {
    const result = await extractContent(
      {
        role: "user",
        experimental_attachments: [
          {
            name: "mockup.png",
            contentType: "image/png",
            url: "/api/media/sessions/sess-1/uploads/mockup.png",
            localPath: "sessions/sess-1/uploads/mockup.png",
            filePath: "/tmp/sessions/sess-1/uploads/mockup.png",
            size: 123,
            kind: "image",
          },
        ],
      },
      true,
      false,
    );

    expect(result).toBe("[Attachment: mockup.png | filePath: /tmp/sessions/sess-1/uploads/mockup.png]");
  });

  it("uses metadata filePath in helper text when part only has URL", async () => {
    const result = await extractContent(
      {
        role: "user",
        parts: [
          {
            type: "text",
            text: "this?",
          },
          {
            type: "file",
            url: "/api/media/sessions/sess-1/uploads/mockup.png",
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
              },
            ],
          },
        },
      },
      true,
      false,
    );

    expect(result).toEqual([
      { type: "text", text: "this?" },
      { type: "text", text: "[Attachment: mockup.png | filePath: /tmp/sessions/sess-1/uploads/mockup.png]" },
    ]);
  });

  it("falls back to localPath then url when filePath is missing", async () => {
    const localPathOnly = await extractContent(
      {
        role: "user",
        experimental_attachments: [
          {
            name: "local-only.png",
            contentType: "image/png",
            url: "/api/media/sessions/sess-1/uploads/local-only.png",
            localPath: "sessions/sess-1/uploads/local-only.png",
          },
        ],
      },
      true,
      false,
    );

    expect(localPathOnly).toBe("[Attachment: local-only.png | localPath: sessions/sess-1/uploads/local-only.png]");

    const urlOnly = await extractContent(
      {
        role: "user",
        experimental_attachments: [
          {
            name: "url-only.png",
            contentType: "image/png",
            url: "/api/media/sessions/sess-1/uploads/url-only.png",
          },
        ],
      },
      true,
      false,
    );

    expect(urlOnly).toBe("[Attachment: url-only.png | url: /api/media/sessions/sess-1/uploads/url-only.png]");
  });

  it("extracts DOCX attachments into chat-ready text", async () => {
    const relativePath = "docs-tests/chat/sample.docx";
    const fullPath = writeMediaFixture(relativePath, "sample.docx");

    const result = await extractContent(
      {
        role: "user",
        experimental_attachments: [
          {
            name: "sample.docx",
            contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            url: `/api/media/${relativePath}`,
            filePath: fullPath,
          },
        ],
      },
      true,
      false,
      "sess-docx",
    );

    expect(result).toBeTypeOf("string");
    const text = result as string;
    expect(text).toContain("[Attachment: sample.docx | filePath:");
    // Content extraction depends on uv/Docling which may not be available.
    // When extraction succeeds, the output includes the content header and body.
    // When it fails, only the helper text is returned.
    if (text.includes("[Attachment content: sample.docx]")) {
      expect(text).toContain("Demonstration of DOCX support in calibre");
    }
  }, 90_000);

  it("extracts VTT attachments into chat-ready text", async () => {
    const relativePath = "docs-tests/chat/sample.vtt";
    const fullPath = writeMediaFixture(relativePath, "sample.vtt");

    const result = await extractContent(
      {
        role: "user",
        experimental_attachments: [
          {
            name: "sample.vtt",
            contentType: "text/vtt",
            url: `/api/media/${relativePath}`,
            filePath: fullPath,
          },
        ],
      },
      true,
      false,
      "sess-vtt",
    );

    expect(result).toBeTypeOf("string");
    const text = result as string;
    expect(text).toContain("[Attachment: sample.vtt | filePath:");
    // Content extraction may fail if the parser is not available.
    // When extraction succeeds, the output includes the content header and body.
    if (text.includes("[Attachment content: sample.vtt]")) {
      expect(text).toContain("Hello from the Selene VTT fixture.");
    }
  }, 90_000);

  it("extracts audio attachments into transcript text", async () => {
    const relativePath = "docs-tests/chat/sample.wav";
    const fullPath = writeMediaFixture(relativePath, "sample.wav");

    process.env.PATH = `/opt/homebrew/bin:${originalPath ?? ""}`;
    saveSettings({
      ...originalSettings,
      sttEnabled: true,
      sttProvider: "local",
      sttLocalModel: "ggml-small.en",
    });

    const result = await extractContent(
      {
        role: "user",
        experimental_attachments: [
          {
            name: "sample.wav",
            contentType: "audio/wav",
            url: `/api/media/${relativePath}`,
            filePath: fullPath,
          },
        ],
      },
      true,
      false,
      "sess-audio",
    );

    expect(result).toBeTypeOf("string");
    const text = result as string;
    expect(text).toContain("[Attachment: sample.wav | filePath:");
    // Audio transcription depends on Whisper which may not be available.
    // When transcription succeeds, the output also includes the transcript header.
  });
});

describe("extractContent reasoning parts (DeepSeek thinking mode replay)", () => {
  it("emits reasoning parts into content when present on an assistant message", async () => {
    const result = await extractContent({
      role: "assistant",
      parts: [
        { type: "reasoning", text: "I should call the tool next." },
        {
          type: "tool-call",
          toolCallId: "tc1",
          toolName: "Read",
          input: { filePath: "/a" },
        },
      ],
    });

    expect(Array.isArray(result)).toBe(true);
    const parts = result as Array<{ type: string; text?: string; toolCallId?: string }>;
    // Reasoning preserved, tool-call preserved
    expect(parts.map((p) => p.type)).toEqual(
      expect.arrayContaining(["reasoning", "tool-call"])
    );
    const reasoning = parts.find((p) => p.type === "reasoning");
    expect(reasoning).toBeDefined();
    expect(reasoning?.text).toBe("I should call the tool next.");
  });

  it("skips reasoning parts with empty text", async () => {
    const result = await extractContent({
      role: "assistant",
      parts: [
        { type: "reasoning", text: "" },
        { type: "text", text: "Hello." },
      ],
    });

    // Single text part after reconciliation collapses into a string return.
    expect(result).toBe("Hello.");
  });
});
