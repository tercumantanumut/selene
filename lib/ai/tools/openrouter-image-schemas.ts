import { jsonSchema } from "ai";

// ==========================================================================
// OpenRouter Image Generation Shared Schemas and Types
// ==========================================================================

export interface OpenRouterImageGenerationArgs {
  prompt: string;
  aspect_ratio?: string;  // "1:1", "16:9", "9:16", etc.
}

export interface OpenRouterImageEditingArgs {
  prompt: string;                    // Edit instructions
  source_image_urls: string[];       // Array of Base64 data URLs or HTTP URLs
  mask_url?: string;                 // Optional mask for inpainting
  aspect_ratio?: string;
}

export interface OpenRouterImageReferencingArgs {
  prompt: string;                    // Generation instructions
  reference_image_urls: string[];    // Array of style/content references
  reference_strength?: number;       // 0.0-1.0 (if supported by model)
  aspect_ratio?: string;
}

export const openRouterGenerateSchema = jsonSchema<OpenRouterImageGenerationArgs>({
  type: "object",
  title: "OpenRouterGenerateInput",
  description: "Input schema for OpenRouter image generation",
  properties: {
    prompt: { type: "string", description: "Text description of the image to generate" },
    aspect_ratio: { type: "string", description: "Aspect ratio (optional)", enum: ["1:1", "16:9", "9:16", "4:3", "3:4"] }
  },
  required: ["prompt"],
  additionalProperties: false,
});

export const openRouterEditSchema = jsonSchema<OpenRouterImageEditingArgs>({
  type: "object",
  title: "OpenRouterEditInput",
  description: "Input schema for OpenRouter image editing",
  properties: {
    prompt: { type: "string", description: "Edit instructions for the images" },
    source_image_urls: { type: "array", items: { type: "string" }, description: "Array of source image URLs or base64 data URLs to edit (supports multiple images)" },
    mask_url: { type: "string", description: "Optional mask URL for inpainting (white = edit, black = preserve)" },
    aspect_ratio: { type: "string", description: "Aspect ratio (optional)", enum: ["1:1", "16:9", "9:16", "4:3", "3:4"] }
  },
  required: ["prompt", "source_image_urls"],
  additionalProperties: false,
});

export const openRouterReferenceSchema = jsonSchema<OpenRouterImageReferencingArgs>({
  type: "object",
  title: "OpenRouterReferenceInput",
  description: "Input schema for OpenRouter reference-guided image generation",
  properties: {
    prompt: { type: "string", description: "Generation instructions guided by the reference images" },
    reference_image_urls: { type: "array", items: { type: "string" }, description: "Array of reference image URLs or base64 data URLs for style/content guidance (supports multiple images)" },
    reference_strength: { type: "number", description: "Reference influence strength (0.0-1.0, optional)", minimum: 0, maximum: 1 },
    aspect_ratio: { type: "string", description: "Aspect ratio (optional)", enum: ["1:1", "16:9", "9:16", "4:3", "3:4"] }
  },
  required: ["prompt", "reference_image_urls"],
  additionalProperties: false,
});

// ==========================================================================
// OpenRouter Model Constants (updated May 2026)
export const OPENROUTER_MODELS = {
  // Black Forest Labs — Flux.2 family
  FLUX2_FLEX: "black-forest-labs/flux.2-flex",
  FLUX2_PRO: "black-forest-labs/flux.2-pro",
  FLUX2_MAX: "black-forest-labs/flux.2-max",
  FLUX2_KLEIN_4B: "black-forest-labs/flux.2-klein-4b",

  // OpenAI
  GPT5_IMAGE_MINI: "openai/gpt-5-image-mini",
  GPT5_IMAGE: "openai/gpt-5-image",
  GPT54_IMAGE_2: "openai/gpt-5.4-image-2",

  // Google Gemini
  GEMINI_31_FLASH_IMAGE: "google/gemini-3.1-flash-image-preview",  // Nano Banana 2
  GEMINI_3_PRO_IMAGE: "google/gemini-3-pro-image-preview",        // Nano Banana Pro

  // xAI
  GROK_IMAGINE: "x-ai/grok-imagine-image-quality",

  // ByteDance
  SEEDREAM_45: "bytedance-seed/seedream-4.5",
} as const;

// Unified Multi-Action Schema (Phase 1 consolidation — 1 tool, 3 actions, 11 models)
// ==========================================================================

export interface OpenRouterImageInput {
  action: "generate" | "edit" | "reference";
  model: string;
  prompt: string;
  aspect_ratio?: "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
  source_image_urls?: string[];
  mask_url?: string;
  reference_image_urls?: string[];
  reference_strength?: number;
}

export const openRouterImageSchema = jsonSchema<OpenRouterImageInput>({
  type: "object",
  title: "OpenRouterImageInput",
  description: "Unified input schema for OpenRouter image generation, editing, and reference-guided generation",
  properties: {
    action: {
      type: "string",
      enum: ["generate", "edit", "reference"],
      description: "Operation to perform. 'generate'=text-to-image, 'edit'=image-to-image editing (needs source_image_urls), 'reference'=reference-guided generation (needs reference_image_urls)."
    },
    model: {
      type: "string",
      enum: Object.values(OPENROUTER_MODELS),
      description: `OpenRouter image model ID. Must be one of the 11 supported models.`,
    },
    prompt: { type: "string", description: "Text prompt. generate: describe the image. edit: describe changes. reference: describe output guided by references." },
    aspect_ratio: { type: "string", enum: ["1:1", "16:9", "9:16", "4:3", "3:4"], description: "Output aspect ratio (optional)." },
    source_image_urls: { type: "array", items: { type: "string" }, minItems: 1, description: "Image URLs to edit. REQUIRED for action='edit'. Supports multiple images for batch editing." },
    mask_url: { type: "string", description: "Optional mask for inpainting (white=edit, black=preserve). Edit action only." },
    reference_image_urls: { type: "array", items: { type: "string" }, minItems: 1, description: "Reference image URLs for style/content guidance. REQUIRED for action='reference'. Supports multiple images." },
    reference_strength: { type: "number", minimum: 0, maximum: 1, description: "Reference influence strength (0.0-1.0, optional). Reference action only." },
  },
  required: ["action", "model", "prompt"],
  additionalProperties: false,
});


