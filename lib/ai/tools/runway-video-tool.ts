import { tool, jsonSchema } from "ai";
import { callRunwayVideo } from "@/lib/ai/runway-video-client";
import { createToolRun } from "@/lib/db/queries";
import { withToolLogging } from "@/lib/ai/tool-registry/logging";
import { failToolRun, saveGeneratedVideos } from "@/lib/ai/tools/tool-run-utils";

// ==========================================================================
// RUNWAY VIDEO TOOL (Text-to-Video and Image-to-Video)
// ==========================================================================

const runwayVideoSchema = jsonSchema<{
  prompt: string;
  image_url?: string;
  model?: "gen4.5" | "gen4_turbo" | "gen3a_turbo";
  duration?: number;
  ratio?: "1280:720" | "720:1280" | "1104:832" | "960:960" | "832:1104" | "1584:672";
  seed?: number;
}>({
  type: "object",
  title: "RunwayVideoInput",
  description: "Input schema for Runway video generation",
  properties: {
    prompt: {
      type: "string",
      description:
        "Text prompt describing the desired video content. Be descriptive about camera movement, lighting, mood, and action. Max 1000 characters.",
    },
    image_url: {
      type: "string",
      description:
        "Reference image to animate into video (image-to-video). Accepts /api/media/ URLs from previously generated images, HTTPS URLs, or data URIs. Omit for text-to-video.",
    },
    model: {
      type: "string",
      enum: ["gen4.5", "gen4_turbo", "gen3a_turbo"],
      default: "gen4_turbo",
      description:
        "Runway model to use. gen4.5 = highest quality, gen4_turbo = fast+good quality (default), gen3a_turbo = fastest (image-to-video only).",
    },
    duration: {
      type: "integer",
      minimum: 2,
      maximum: 10,
      default: 5,
      description: "Video duration in seconds (2-10). Default is 5.",
    },
    ratio: {
      type: "string",
      enum: ["1280:720", "720:1280", "1104:832", "960:960", "832:1104", "1584:672"],
      default: "1280:720",
      description:
        "Output aspect ratio as pixel dimensions. 1280:720 = landscape (default), 720:1280 = portrait, 960:960 = square.",
    },
    seed: {
      type: "integer",
      minimum: 0,
      // Clamp to int32 max — Anthropic's tool-schema validator rejects
      // values that overflow int32 ("int too big to convert").
      maximum: 2147483647,
      description: "Optional seed for reproducible generation.",
    },
  },
  required: ["prompt"],
  additionalProperties: false,
});

interface RunwayVideoArgs {
  prompt: string;
  image_url?: string;
  model?: "gen4.5" | "gen4_turbo" | "gen3a_turbo";
  duration?: number;
  ratio?: "1280:720" | "720:1280" | "1104:832" | "960:960" | "832:1104" | "1584:672";
  seed?: number;
}

/**
 * Core Runway video execution logic
 */
async function executeRunwayVideo(sessionId: string, args: RunwayVideoArgs) {
  const { prompt, image_url, model, duration, ratio, seed } = args;

  const toolRun = await createToolRun({
    sessionId,
    toolName: "generateVideoRunway",
    args: { prompt, image_url, model, duration, ratio, seed },
    status: "running",
  });

  try {
    const result = await callRunwayVideo(
      { prompt, image_url, model, duration, ratio, seed },
      sessionId
    );

    return saveGeneratedVideos(sessionId, toolRun.id, result, prompt, {
      provider: "runway",
      model: model ?? "gen4_turbo",
    });
  } catch (error) {
    return failToolRun(toolRun.id, error);
  }
}

export function createRunwayVideoTool(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "generateVideoRunway",
    sessionId,
    (args: RunwayVideoArgs) => executeRunwayVideo(sessionId, args)
  );

  return tool({
    description: `Generate videos with Runway. Supports text-to-video and image-to-video. Use searchTools first for full parameters.`,
    inputSchema: runwayVideoSchema,
    execute: executeWithLogging,
  });
}
