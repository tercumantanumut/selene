import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { routeMultimodalReadFileResults } from "@/app/api/chat/multimodal-tool-result-router";

const imageToolMessage: ModelMessage = {
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: "call-read-image",
      toolName: "readFile",
      output: {
        type: "json",
        value: {
          status: "success",
          kind: "image",
          filePath: "/api/media/uploads/photo.png",
          message: "Loaded image photo.png",
          image: {
            dataUri: "data:image/png;base64,aW1hZ2UtYnl0ZXM=",
            mediaType: "image/png",
            byteLength: 11,
          },
        },
      },
    },
  ],
} as ModelMessage;

describe("routeMultimodalReadFileResults", () => {
  it("routes Anthropic readFile images as native tool-result media content", () => {
    const routed = routeMultimodalReadFileResults([imageToolMessage], "anthropic");

    expect(routed).toHaveLength(1);
    const content = routed[0].content as Array<{ output?: unknown }>;
    expect(content[0].output).toEqual({
      type: "content",
      value: [
        { type: "text", text: "Loaded image photo.png" },
        { type: "media", data: "aW1hZ2UtYnl0ZXM=", mediaType: "image/png" },
      ],
    });
  });

  it("routes OpenAI-compatible readFile images through an ephemeral user image message", () => {
    const routed = routeMultimodalReadFileResults([imageToolMessage], "openrouter");

    expect(routed).toHaveLength(2);
    const toolContent = routed[0].content as Array<{ output?: unknown }>;
    expect(toolContent[0].output).toEqual({
      type: "text",
      value: "Loaded image photo.png",
    });
    expect(routed[1]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "(Ephemeral image from readFile for /api/media/uploads/photo.png. This image is visible only for this model step.)",
        },
        { type: "image", image: "aW1hZ2UtYnl0ZXM=", mediaType: "image/png" },
      ],
    });
  });

  it("routes blind-provider readFile images to a transparent unsupported text result", () => {
    const routed = routeMultimodalReadFileResults([imageToolMessage], "deepseek");

    expect(routed).toHaveLength(1);
    const content = routed[0].content as Array<{ output?: unknown }>;
    expect(content[0].output).toEqual({
      type: "text",
      value: "deepseek cannot view images in Selene. Switch to a vision-capable model to inspect this file.",
    });
  });

  it("ignores persisted readFile image stubs whose bytes were intentionally omitted", () => {
    const persistedStub: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-read-image",
          toolName: "readFile",
          output: {
            type: "json",
            value: {
              status: "success",
              kind: "image",
              filePath: "/api/media/uploads/photo.png",
              image: {
                dataUri: "[ephemeral image bytes omitted from persisted history]",
                mediaType: "image/png",
                byteLength: 11,
              },
            },
          },
        },
      ],
    } as ModelMessage;

    expect(routeMultimodalReadFileResults([persistedStub], "openrouter")).toEqual([persistedStub]);
  });
});
