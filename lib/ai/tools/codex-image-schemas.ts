import { jsonSchema } from "ai";

/**
 * Argument schemas for the Codex `gpt-image-2` tools (text-to-image, edit,
 * and reference). These mirror the OpenAI Images API surface the CLIProxyAPI
 * sidecar passes through to Codex's `image_generation` tool.
 */

export interface CodexImageGenerationArgs {
  prompt: string;
  size?: "1024x1024" | "1024x1536" | "1536x1024" | "auto";
  quality?: "low" | "medium" | "high" | "auto";
  background?: "transparent" | "opaque" | "auto";
  output_format?: "png" | "jpeg" | "webp";
}

export interface CodexImageEditingArgs {
  prompt: string;
  source_image_urls: string[];
  mask_url?: string;
  size?: "1024x1024" | "1024x1536" | "1536x1024" | "auto";
  quality?: "low" | "medium" | "high" | "auto";
  background?: "transparent" | "opaque" | "auto";
  output_format?: "png" | "jpeg" | "webp";
}

export interface CodexImageReferencingArgs {
  prompt: string;
  reference_image_urls: string[];
  size?: "1024x1024" | "1024x1536" | "1536x1024" | "auto";
  quality?: "low" | "medium" | "high" | "auto";
  background?: "transparent" | "opaque" | "auto";
  output_format?: "png" | "jpeg" | "webp";
}

const sizeProp = {
  type: "string" as const,
  description: "Output dimensions (defaults to 1024x1024 / auto).",
  enum: ["1024x1024", "1024x1536", "1536x1024", "auto"],
};
const qualityProp = {
  type: "string" as const,
  description: "Rendering effort. 'high' is slowest; 'auto' lets Codex decide.",
  enum: ["low", "medium", "high", "auto"],
};
const backgroundProp = {
  type: "string" as const,
  description: "Background handling. 'transparent' needs PNG output.",
  enum: ["transparent", "opaque", "auto"],
};
const outputFormatProp = {
  type: "string" as const,
  description: "Image format. Use 'png' for transparency.",
  enum: ["png", "jpeg", "webp"],
};

export const codexImageGenerateSchema = jsonSchema<CodexImageGenerationArgs>({
  type: "object",
  title: "CodexGenerateInput",
  description: "Input schema for Codex gpt-image-2 text-to-image generation",
  properties: {
    prompt: { type: "string", description: "Description of the image to generate." },
    size: sizeProp,
    quality: qualityProp,
    background: backgroundProp,
    output_format: outputFormatProp,
  },
  required: ["prompt"],
  additionalProperties: false,
});

export const codexImageEditSchema = jsonSchema<CodexImageEditingArgs>({
  type: "object",
  title: "CodexEditInput",
  description: "Input schema for Codex gpt-image-2 edits",
  properties: {
    prompt: { type: "string", description: "Edit instructions to apply to the source image(s)." },
    source_image_urls: {
      type: "array",
      items: { type: "string" },
      description: "Source images. Data URLs, http(s) URLs, or selene /api/media refs.",
    },
    mask_url: {
      type: "string",
      description: "Optional mask: white pixels are edited, black pixels preserved.",
    },
    size: sizeProp,
    quality: qualityProp,
    background: backgroundProp,
    output_format: outputFormatProp,
  },
  required: ["prompt", "source_image_urls"],
  additionalProperties: false,
});

export const codexImageReferenceSchema = jsonSchema<CodexImageReferencingArgs>({
  type: "object",
  title: "CodexReferenceInput",
  description: "Input schema for Codex gpt-image-2 reference-guided generation",
  properties: {
    prompt: { type: "string", description: "Generation instructions guided by the reference images." },
    reference_image_urls: {
      type: "array",
      items: { type: "string" },
      description: "Reference images for style or subject guidance.",
    },
    size: sizeProp,
    quality: qualityProp,
    background: backgroundProp,
    output_format: outputFormatProp,
  },
  required: ["prompt", "reference_image_urls"],
  additionalProperties: false,
});

// ==========================================================================
// Unified Multi-Action Schema (Phase 2 consolidation — 1 tool, 3 actions)
// ==========================================================================

export interface CodexImageInput {
  action: "generate" | "edit" | "reference";
  prompt: string;
  size?: "1024x1024" | "1024x1536" | "1536x1024" | "auto";
  quality?: "low" | "medium" | "high" | "auto";
  background?: "transparent" | "opaque" | "auto";
  output_format?: "png" | "jpeg" | "webp";
  source_image_urls?: string[];
  mask_url?: string;
  reference_image_urls?: string[];
}

export const codexImageSchema = jsonSchema<CodexImageInput>({
  type: "object",
  title: "CodexImageInput",
  description: "Unified input schema for Codex gpt-image-2 generation, editing, and reference-guided generation",
  properties: {
    action: {
      type: "string",
      enum: ["generate", "edit", "reference"],
      description: "Operation to perform. 'generate'=text-to-image, 'edit'=edit existing images, 'reference'=reference-guided generation."
    },
    prompt: { type: "string", description: "Text prompt describing the image or edit instructions." },
    size: sizeProp,
    quality: qualityProp,
    background: backgroundProp,
    output_format: outputFormatProp,
    source_image_urls: { type: "array", items: { type: "string" }, minItems: 1, description: "Source images to edit. REQUIRED for action='edit'." },
    mask_url: { type: "string", description: "Optional mask for inpainting (white=edit, black=preserve). Edit only." },
    reference_image_urls: { type: "array", items: { type: "string" }, minItems: 1, description: "Reference images for style/subject guidance. REQUIRED for action='reference'." },
  },
  required: ["action", "prompt"],
  additionalProperties: false,
});
