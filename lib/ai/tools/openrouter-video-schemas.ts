import { jsonSchema } from "ai";

// ==========================================================================
// OpenRouter Video Generation Shared Schemas and Types
// ==========================================================================

export interface OpenRouterVideoInput {
  action: "generate" | "animate" | "reference" | "check";
  model: string;
  prompt: string;
  /** Optional: job ID from a previous request to check status. */
  job_id?: string;
  /** Optional: polling URL from a previous request. Overrides job_id when both are set. */
  polling_url?: string;
  /** Image URL for image-to-video workflows (action="animate"). Animates a still image. */
  image_url?: string;
  /** Reference image URLs for style/content guidance (action="reference"). */
  reference_image_urls?: string[];
  /** First frame URL for frame-to-video transitions (Kling, Veo, Seedance, Wan). */
  first_frame_url?: string;
  /** Last frame URL for guided transitions between two frames. */
  last_frame_url?: string;
  /** Video duration in seconds (model-dependent). */
  duration?: number;
  /** Aspect ratio. */
  aspect_ratio?: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
}

export interface OpenRouterVideoResult {
  status: "completed" | "processing" | "error" | "timeout";
  jobId?: string;
  pollingUrl?: string;
  videoUrls?: string[];
  error?: string;
  message?: string;
}

// ==========================================================================
// OpenRouter Video Model Constants
// ==========================================================================

export const OPENROUTER_VIDEO_MODELS = {
  // xAI
  GROK_IMAGINE_VIDEO: "x-ai/grok-imagine-video",

  // Kling (Kuaishou)
  KLING_V3_PRO: "kwaivgi/kling-v3.0-pro",
  KLING_V3_STANDARD: "kwaivgi/kling-v3.0-standard",
  KLING_O1: "kwaivgi/kling-o1",

  // Google Veo
  VEO_31_FAST: "google/veo-3.1-fast",
  VEO_31_LITE: "google/veo-3.1-lite",

  // MiniMax
  HAILUO_23: "minimax/hailuo-2.3",

  // ByteDance Seedance
  SEEDANCE_20_FAST: "bytedance/seedance-2.0-fast",
  SEEDANCE_20: "bytedance/seedance-2.0",

  // Alibaba
  WAN_27: "alibaba/wan-2.7",
} as const;

// ==========================================================================
// Unified Multi-Action Schema
// ==========================================================================

export const openRouterVideoSchema = jsonSchema<OpenRouterVideoInput>({
  type: "object",
  title: "OpenRouterVideoInput",
  description: "Unified input schema for OpenRouter video generation with async polling. Supports text-to-video, image-to-video, and reference-to-video.",
  properties: {
    action: {
      type: "string",
      enum: ["generate", "animate", "reference", "check"],
      description: "'generate'=text-to-video, 'animate'=image-to-video (needs image_url), 'reference'=reference-to-video (needs reference_image_urls — Grok/Seedance/Wan only), 'check'=poll an existing job.",
    },
    model: {
      type: "string",
      description: "OpenRouter video model ID.",
    },
    prompt: {
      type: "string",
      description: "Text description of the video to generate. Be specific about motion, camera movement, lighting, and mood.",
    },
    job_id: {
      type: "string",
      description: "Job ID from a previous request. Used with action='check'.",
    },
    polling_url: {
      type: "string",
      description: "Polling URL from a previous request. Overrides job_id when both are set.",
    },
    image_url: {
      type: "string",
      description: "Image URL for image-to-video workflows (action='animate'). Animates a still image.",
    },
    reference_image_urls: {
      type: "array",
      items: { type: "string" },
      description: "Reference image URLs for style/content guidance. REQUIRED for action='reference'. Only Grok Imagine, Seedance, and Wan 2.7 support this.",
    },
    first_frame_url: {
      type: "string",
      description: "First frame image URL for frame-to-video transitions. Supported by Kling, Veo, Seedance, and Wan 2.7.",
    },
    last_frame_url: {
      type: "string",
      description: "Last frame image URL for guided transitions between two frames.",
    },
    duration: {
      type: "number",
      description: "Video duration in seconds (model-dependent). Ranges from 1-15s depending on model.",
    },
    aspect_ratio: {
      type: "string",
      enum: ["16:9", "9:16", "1:1", "4:3", "3:4"],
      description: "Output aspect ratio (model-dependent). Most models support at least 16:9, 9:16, 1:1.",
    },
  },
  required: ["action", "model"],
  additionalProperties: false,
});
