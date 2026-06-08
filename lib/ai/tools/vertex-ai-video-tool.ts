import { tool, jsonSchema } from "ai";
import { callVertexAIVideo } from "@/lib/ai/vertex-ai-video-client";
import { createToolRun } from "@/lib/db/queries";
import { withToolLogging } from "@/lib/ai/tool-registry/logging";
import { failToolRun, saveGeneratedVideos } from "@/lib/ai/tools/tool-run-utils";

// ==========================================================================
// VERTEX AI VEO VIDEO TOOL (Text-to-Video and Image-to-Video)
// ==========================================================================

const vertexAIVideoSchema = jsonSchema<{
  prompt: string;
  image_url?: string;
  model?: string;
  duration_seconds?: number;
  aspect_ratio?: "16:9" | "9:16";
  resolution?: "720p" | "1080p";
  negative_prompt?: string;
  seed?: number;
  generate_audio?: boolean;
  sample_count?: number;
}>({
  type: "object",
  title: "VertexAIVideoInput",
  description: "Input schema for Google Veo video generation via Vertex AI",
  properties: {
    prompt: {
      type: "string",
      description:
        "Text prompt describing the desired video content. Be descriptive about scene, action, camera movement, and style.",
    },
    image_url: {
      type: "string",
      description:
        "Reference image to animate into video (image-to-video). Accepts /api/media/ URLs from previously generated images, HTTPS URLs, or data URIs. Omit for text-to-video.",
    },
    model: {
      type: "string",
      enum: [
        "veo-2.0-generate-001",
        "veo-3.0-generate-001",
        "veo-3.0-fast-generate-001",
        "veo-3.1-generate-001",
        "veo-3.1-fast-generate-001",
      ],
      default: "veo-3.0-generate-001",
      description:
        "Veo model to use. veo-3.0-generate-001 = default, veo-3.1-* = latest, *-fast-* = faster generation, veo-2.0 = legacy.",
    },
    duration_seconds: {
      type: "integer",
      minimum: 4,
      maximum: 8,
      default: 8,
      description: "Video duration in seconds. Veo 2: 5-8, Veo 3+: 4/6/8. Default is 8.",
    },
    aspect_ratio: {
      type: "string",
      enum: ["16:9", "9:16"],
      default: "16:9",
      description: "Output aspect ratio. 16:9 = landscape (default), 9:16 = portrait.",
    },
    resolution: {
      type: "string",
      enum: ["720p", "1080p"],
      default: "720p",
      description: "Output resolution. 720p (default) or 1080p (Veo 3+ only).",
    },
    negative_prompt: {
      type: "string",
      description:
        "Elements to avoid in the generated video (e.g., 'blurry, distorted, low quality').",
    },
    seed: {
      type: "integer",
      minimum: 0,
      // Clamp to int32 max — Anthropic's tool-schema validator rejects
      // values that overflow int32 ("int too big to convert"). Vertex's API
      // accepts up to uint32, but the practical seed range below int32 max
      // is sufficient for deterministic generation.
      maximum: 2147483647,
      description: "Optional seed for deterministic/reproducible generation.",
    },
    generate_audio: {
      type: "boolean",
      default: true,
      description: "Whether to generate audio for the video (Veo 3+ models only). Default true.",
    },
    sample_count: {
      type: "integer",
      minimum: 1,
      maximum: 4,
      default: 1,
      description: "Number of video samples to generate (1-4). Default is 1.",
    },
  },
  required: ["prompt"],
  additionalProperties: false,
});

interface VertexAIVideoArgs {
  prompt: string;
  image_url?: string;
  model?: string;
  duration_seconds?: number;
  aspect_ratio?: "16:9" | "9:16";
  resolution?: "720p" | "1080p";
  negative_prompt?: string;
  seed?: number;
  generate_audio?: boolean;
  sample_count?: number;
}

/**
 * Core Vertex AI Veo video execution logic
 */
async function executeVertexAIVideo(sessionId: string, args: VertexAIVideoArgs) {
  const {
    prompt,
    image_url,
    model,
    duration_seconds,
    aspect_ratio,
    resolution,
    negative_prompt,
    seed,
    generate_audio,
    sample_count,
  } = args;

  const toolRun = await createToolRun({
    sessionId,
    toolName: "generateVideoVertexAI",
    args: {
      prompt,
      image_url,
      model,
      duration_seconds,
      aspect_ratio,
      resolution,
      negative_prompt,
      seed,
      generate_audio,
      sample_count,
    },
    status: "running",
  });

  try {
    const result = await callVertexAIVideo(
      {
        prompt,
        image_url,
        model,
        duration_seconds,
        aspect_ratio,
        resolution,
        negative_prompt,
        seed,
        generate_audio,
        sample_count,
      },
      sessionId
    );

    return saveGeneratedVideos(sessionId, toolRun.id, result, prompt, {
      provider: "vertex-ai",
      model: model ?? "veo-3.0-generate-001",
    });
  } catch (error) {
    return failToolRun(toolRun.id, error);
  }
}

export function createVertexAIVideoTool(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "generateVideoVertexAI",
    sessionId,
    (args: VertexAIVideoArgs) => executeVertexAIVideo(sessionId, args)
  );

  return tool({
    description: `Generate videos with Google Veo via Vertex AI. Supports text-to-video and image-to-video. Use searchTools first for full parameters.`,
    inputSchema: vertexAIVideoSchema,
    execute: executeWithLogging,
  });
}
