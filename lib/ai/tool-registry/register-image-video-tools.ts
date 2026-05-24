import type { ToolMetadata } from "./types";
import { ToolRegistry } from "./registry";
import {
  createFlux2GenerateTool,
  createImageEditTool,
  createOpenRouterFlux2FlexEdit,
  createOpenRouterFlux2FlexGenerate,
  createOpenRouterFlux2FlexReference,
  createOpenRouterGemini31FlashImageEdit,
  createOpenRouterGemini31FlashImageGenerate,
  createOpenRouterGemini31FlashImageReference,
  createOpenRouterGemini3ProImageEdit,
  createOpenRouterGemini3ProImageGenerate,
  createOpenRouterGemini3ProImageReference,
  createOpenRouterGpt5ImageEdit,
  createOpenRouterGpt5ImageGenerate,
  createOpenRouterGpt5ImageMiniEdit,
  createOpenRouterGpt5ImageMiniGenerate,
  createOpenRouterGpt5ImageMiniReference,
  createOpenRouterGpt5ImageReference,
  createOpenRouterFlux2ProGenerate,
  createOpenRouterFlux2ProEdit,
  createOpenRouterFlux2ProReference,
  createOpenRouterFlux2MaxGenerate,
  createOpenRouterFlux2MaxEdit,
  createOpenRouterFlux2MaxReference,
  createOpenRouterFlux2Klein4BGenerate,
  createOpenRouterFlux2Klein4BEdit,
  createOpenRouterFlux2Klein4BReference,
  createOpenRouterGpt54Image2Generate,
  createOpenRouterGpt54Image2Edit,
  createOpenRouterGpt54Image2Reference,
  createOpenRouterGrokImagineGenerate,
  createOpenRouterGrokImagineEdit,
  createOpenRouterGrokImagineReference,
  createOpenRouterSeedream45Generate,
  createOpenRouterSeedream45Edit,
  createOpenRouterSeedream45Reference,
  createOpenRouterImageTool,
  createWan22ImagenTool,
  createWan22PixelVideoTool,
  createWan22VideoTool,
  createGenerateCodexImageTool,
  createEditCodexImageTool,
  createReferenceCodexImageTool,
  createCodexImageTool,
  createOpenRouterVideoTool,
} from "../tools";
import { createRunwayVideoTool } from "../tools/runway-video-tool";
import { createVertexAIVideoTool } from "../tools/vertex-ai-video-tool";

export function registerImageAndVideoTools(registry: ToolRegistry): void {
// ============================================================
// DEFERRED TOOLS - AI Model Pipelines (require searchTools to discover)
// ============================================================

// ============================================================================
// LEGACY STYLY IO API TOOLS
// These tools use the STYLY IO API and are disabled by default.
// Set ENABLE_LEGACY_IMAGE_TOOLS=true to enable them.
// ============================================================================
if (process.env.ENABLE_LEGACY_IMAGE_TOOLS === "true") {
  // Image Editor Tool (Gemini) - General Image-to-Image editing and Virtual Try-On
  registry.register(
    "editImage",
    {
      displayName: "Image Editor (Gemini)",
      category: "image-editing",
      keywords: [
        // General image editing terms - HIGH PRIORITY for search
        "edit", "edit image", "image edit", "modify", "transform", "change", "adjust",
        "image editing", "photo editing", "edit photo", "photo edit",
        // Variations/remix terms
        "variations", "variation", "remix", "create variations", "generate variations",
        "image-to-image", "img2img", "i2i",
        // Style/transfer terms
        "style transfer", "apply style", "combine images", "blend",
        // Room/interior (original use case, still supported)
        "room", "interior", "material", "texture", "color", "wall", "floor",
        // Furniture visualization
        "furniture", "how would", "look in my room", "place", "visualize",
        "couch", "sofa", "chair", "table", "desk", "bed", "bookcase", "shelf",
        "IKEA", "decor", "staging", "virtual staging",
        // Virtual try-on - KEY USE CASE
        "try on", "try-on", "virtual try-on", "clothing", "outfit", "fashion",
        "shirt", "dress", "pants", "jacket", "suit", "formal wear", "attire",
        "how would I look", "wear", "wearing", "style me",
        // Technical
        "gemini", "flash",
      ],
      shortDescription: "Edit images, combine elements from two images, or create virtual try-on visualizations",
      fullInstructions: `## Image Editor (Gemini)

Edit images with Gemini 2.5 Flash. Two modes: single image edit, or two-image combine (try-on/furniture).

**⚠️ Virtual Try-On Workflow (3 mandatory steps):**
1. \`describeImage\` FIRST → analyze user's photo (never skip!)
2. Get reference image URL (webSearch)
3. \`editImage\` with BOTH image_url + second_image_url + insights from step 1

**Common mistakes:** Skipping describeImage, omitting second_image_url for try-on, assuming gender without analysis.`,
      loading: { deferLoading: true }, // Deferred - discover via searchTools
      requiresSession: true,
      enableEnvVar: "STYLY_AI_API_KEY",
    } satisfies ToolMetadata,
    ({ sessionId }) => createImageEditTool(sessionId!)
  );

  // Flux2 Generate Tool
  registry.register(
    "generateImageFlux2",
    {
      displayName: "Generate Image (Flux2)",
      category: "image-generation",
      keywords: [
        "generate",
        "create",
        "image",
        "flux",
        "text-to-image",
        "art",
        "illustration",
        "reference",
      ],
      shortDescription: "Generate or edit images with Flux2 text-to-image model",
      fullInstructions: `## Flux2 Generation & Editing

Dual-mode: text-to-image (no referenceImages) or image editing (with referenceImages array).

**Mode detection:** If user says "edit/modify/change" + existing image → use referenceImages. Otherwise → pure generation.
**Edit prompts:** Write SHORT, change-focused prompts (e.g., "Add sunset painting to wall"). Don't describe the full scene.
**Image URLs:** Look for \`[Image URL: ...]\` or \`[Previous generateImageFlux2 result - Generated image URLs: ...]\` in conversation.`,
      loading: { deferLoading: true }, // Deferred - discover via searchTools
      requiresSession: true,
      enableEnvVar: "STYLY_AI_API_KEY",
    } satisfies ToolMetadata,
    ({ sessionId, characterAvatarUrl, characterAppearanceDescription }) =>
      createFlux2GenerateTool(sessionId!, {
        characterAvatarUrl,
        characterAppearanceDescription,
      })
  );

  // WAN 2.2 Imagen Tool
  registry.register(
    "generateImageWan22",
    {
      displayName: "Generate Image (WAN 2.2)",
      category: "image-generation",
      keywords: [
        "generate",
        "create",
        "image",
        "wan",
        "anime",
        "artistic",
        "illustration",
        "portrait",
      ],
      shortDescription: "Generate anime-style or artistic images with WAN 2.2",
      fullInstructions: `## WAN 2.2 Image Generation

Anime-style/artistic image generation. Default 768x1344. Use \`positive\` for prompt, \`negative\` to exclude unwanted elements.`,
      loading: { deferLoading: true }, // Deferred - discover via searchTools
      requiresSession: true,
      enableEnvVar: "STYLY_AI_API_KEY",
    } satisfies ToolMetadata,
    ({ sessionId }) => createWan22ImagenTool(sessionId!)
  );

  // WAN 2.2 Video Tool
  registry.register(
    "generateVideoWan22",
    {
      displayName: "Generate Video (WAN 2.2)",
      category: "video-generation",
      keywords: [
        "video",
        "animate",
        "motion",
        "movement",
        "wan",
        "image-to-video",
      ],
      shortDescription: "Animate images into videos with WAN 2.2",
      fullInstructions: `## WAN 2.2 Video Generation

Animate still images into video. Provide image_url + motion prompt (\`positive\`).
Be specific about motion: "Wind blowing through hair" not just "moving". Default fps=21, duration=2s.`,
      loading: { deferLoading: true }, // Deferred - discover via searchTools
      requiresSession: true,
      enableEnvVar: "STYLY_AI_API_KEY",
    } satisfies ToolMetadata,
    ({ sessionId }) => createWan22VideoTool(sessionId!)
  );

  // WAN 2.2 Pixel Animation Tool
  registry.register(
    "generatePixelVideoWan22",
    {
      displayName: "Generate Pixel Animation (WAN 2.2)",
      category: "video-generation",
      keywords: [
        "pixel",
        "sprite",
        "animation",
        "character",
        "game",
        "retro",
        "wan",
        "video",
        "8-bit",
        "16-bit",
      ],
      shortDescription:
        "Generate pixel art character sprite animations with WAN 2.2",
      fullInstructions: `## WAN 2.2 Pixel Animation

Pixel art sprite animations using specialized LoRA. DO NOT change lora_name or lora_strength defaults.

**CRITICAL prompt style:** Use simple 1-2 sentence natural descriptions. DO NOT write phase-by-phase or frame-by-frame specs.
- Good: "Pixel knight swings sword in a powerful slash. Cape billows, glowing trail effect."
- Bad: "Phase 1 (0-20%): Wind-up... Phase 2 (20-45%): Acceleration..." ← produces poor results

Use fps=21-24 for smooth animations. Always add negative: "blurry, distorted, low quality, smeared".`,
      loading: { deferLoading: true }, // Deferred - discover via searchTools
      requiresSession: true,
      enableEnvVar: "STYLY_AI_API_KEY",
    } satisfies ToolMetadata,
    ({ sessionId }) => createWan22PixelVideoTool(sessionId!)
  );
} // End LEGACY STYLY IO API TOOLS conditional

// ============================================================================
// OpenRouter Image Tools
// These tools use OpenRouter API for image generation, editing, and referencing
// ============================================================================

// Flux.2 Flex - Generate
registry.register(
  "generateImageFlux2Flex",
  {
    displayName: "Generate Image (Flux.2 Flex)",
    category: "image-generation",
    keywords: ["generate", "create", "image", "flux", "text-to-image", "art", "illustration"],
    shortDescription: "Generate images from text using Flux.2 Flex via OpenRouter",
    fullInstructions: `## Flux.2 Flex (OpenRouter)

High-quality text-to-image generation via OpenRouter.`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterFlux2FlexGenerate(sessionId!)
);

// Flux.2 Flex - Edit
registry.register(
  "editImageFlux2Flex",
  {
    displayName: "Edit Image (Flux.2 Flex)",
    category: "image-editing",
    keywords: ["edit", "modify", "transform", "image", "flux", "image-to-image"],
    shortDescription: "Edit existing images using Flux.2 Flex via OpenRouter",
    fullInstructions: `## Flux.2 Flex Editing (OpenRouter)

Edit/transform images via OpenRouter. Supports mask for inpainting (white=edit, black=preserve).`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterFlux2FlexEdit(sessionId!)
);

// Flux.2 Flex - Reference
registry.register(
  "referenceImageFlux2Flex",
  {
    displayName: "Reference Image (Flux.2 Flex)",
    category: "image-generation",
    keywords: ["reference", "style", "transfer", "image", "flux", "guided"],
    shortDescription: "Generate images guided by a reference using Flux.2 Flex via OpenRouter",
    fullInstructions: `## Flux.2 Flex Reference (OpenRouter)

Reference-guided generation for style transfer and consistency. Adjust reference_strength (0-1) to control influence.`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterFlux2FlexReference(sessionId!)
);

// GPT-5 Image Mini - Generate
registry.register(
  "generateImageGpt5Mini",
  {
    displayName: "Generate Image (GPT-5 Mini)",
    category: "image-generation",
    keywords: ["generate", "create", "image", "gpt", "openai", "fast", "mini"],
    shortDescription: "Generate images quickly using GPT-5 Image Mini via OpenRouter",
    fullInstructions: `## GPT-5 Image Mini (OpenRouter)

Fast image generation. Good for quick iterations where speed > max quality.`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterGpt5ImageMiniGenerate(sessionId!)
);

// GPT-5 Image Mini - Edit
registry.register(
  "editImageGpt5Mini",
  {
    displayName: "Edit Image (GPT-5 Mini)",
    category: "image-editing",
    keywords: [
      "edit", "modify", "image", "gpt", "openai", "fast", "mini",
      // Virtual try-on and fashion keywords
      "try on", "try-on", "virtual try-on", "clothing", "outfit", "fashion",
      "image editing", "photo editing", "transform",
    ],
    shortDescription: "Edit images quickly using GPT-5 Image Mini via OpenRouter",
    fullInstructions: `## GPT-5 Image Mini Editing (OpenRouter)

Fast image editing. Supports mask for inpainting.`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterGpt5ImageMiniEdit(sessionId!)
);

// GPT-5 Image Mini - Reference
registry.register(
  "referenceImageGpt5Mini",
  {
    displayName: "Reference Image (GPT-5 Mini)",
    category: "image-generation",
    keywords: [
      "reference", "style", "image", "gpt", "openai", "fast", "mini",
      // Virtual try-on and fashion keywords
      "try on", "try-on", "virtual try-on", "clothing", "outfit", "fashion",
      "style transfer", "guided generation",
    ],
    shortDescription: "Generate images with reference using GPT-5 Image Mini via OpenRouter",
    fullInstructions: `## GPT-5 Image Mini Reference (OpenRouter)

Fast reference-guided generation. Adjust reference_strength (0-1).`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterGpt5ImageMiniReference(sessionId!)
);

// GPT-5 Image - Generate
registry.register(
  "generateImageGpt5",
  {
    displayName: "Generate Image (GPT-5)",
    category: "image-generation",
    keywords: ["generate", "create", "image", "gpt", "openai", "premium", "quality"],
    shortDescription: "Generate premium quality images using GPT-5 Image via OpenRouter",
    fullInstructions: `## GPT-5 Image (OpenRouter)

Premium quality image generation for complex, detailed, professional-grade outputs.`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterGpt5ImageGenerate(sessionId!)
);

// GPT-5 Image - Edit
registry.register(
  "editImageGpt5",
  {
    displayName: "Edit Image (GPT-5)",
    category: "image-editing",
    keywords: [
      "edit", "modify", "transform", "image", "gpt", "openai", "premium",
      // Virtual try-on and fashion keywords
      "try on", "try-on", "virtual try-on", "clothing", "outfit", "fashion",
      "image editing", "photo editing",
    ],
    shortDescription: "Premium image editing using GPT-5 Image via OpenRouter",
    fullInstructions: `## GPT-5 Image Editing (OpenRouter)

Premium image editing. Supports mask for inpainting.`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterGpt5ImageEdit(sessionId!)
);

// GPT-5 Image - Reference
registry.register(
  "referenceImageGpt5",
  {
    displayName: "Reference Image (GPT-5)",
    category: "image-generation",
    keywords: [
      "reference", "style", "transfer", "image", "gpt", "openai", "premium",
      // Virtual try-on and fashion keywords
      "try on", "try-on", "virtual try-on", "clothing", "outfit", "fashion",
      "style transfer", "guided generation",
    ],
    shortDescription: "Premium reference-guided generation using GPT-5 Image via OpenRouter",
    fullInstructions: `## GPT-5 Image Reference (OpenRouter)

Premium reference-guided generation and style transfer. Adjust reference_strength (0-1).`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterGpt5ImageReference(sessionId!)
);

// Gemini 3.1 Flash Image - Generate (Nano Banana 2)
registry.register(
  "generateImageGemini31Flash",
  {
    displayName: "Generate Image (Nano Banana 2)",
    category: "image-generation",
    keywords: ["generate", "create", "image", "gemini", "google", "nano banana", "fast"],
    shortDescription: "Pro-level image generation at Flash speed using Gemini 3.1 Flash Image (Nano Banana 2) via OpenRouter",
    fullInstructions: `## Nano Banana 2 — Gemini 3.1 Flash Image (OpenRouter)

Google's latest state-of-the-art image model — Pro-level visual quality at Flash speed with advanced contextual understanding. Top model by usage on OpenRouter.

Supports generate, edit, and reference modes. Use aspect_ratio for output dimensions.`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterGemini31FlashImageGenerate(sessionId!)
);

// Gemini 3.1 Flash Image - Edit
registry.register(
  "editImageGemini31Flash",
  {
    displayName: "Edit Image (Nano Banana 2)",
    category: "image-editing",
    keywords: [
      "edit", "modify", "image", "gemini", "google", "nano banana", "fast",
      "try on", "try-on", "virtual try-on", "clothing", "outfit", "fashion",
      "image editing", "photo editing", "transform",
    ],
    shortDescription: "Fast, high-quality image editing using Nano Banana 2 via OpenRouter",
    fullInstructions: `## Nano Banana 2 Editing (OpenRouter)

Fast, high-quality image editing with Google's latest Gemini 3.1 Flash. Supports mask for inpainting.`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterGemini31FlashImageEdit(sessionId!)
);

// Gemini 3.1 Flash Image - Reference
registry.register(
  "referenceImageGemini31Flash",
  {
    displayName: "Reference Image (Nano Banana 2)",
    category: "image-generation",
    keywords: [
      "reference", "style", "image", "gemini", "google", "nano banana",
      "try on", "try-on", "virtual try-on", "clothing", "outfit", "fashion",
      "style transfer", "guided generation",
    ],
    shortDescription: "Fast reference-guided generation using Nano Banana 2 via OpenRouter",
    fullInstructions: `## Nano Banana 2 Reference (OpenRouter)

Fast reference-guided generation with Gemini 3.1 Flash. Adjust reference_strength (0-1).`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterGemini31FlashImageReference(sessionId!)
);

// Gemini 3 Pro Image - Generate
registry.register(
  "generateImageGemini3Pro",
  {
    displayName: "Generate Image (Gemini 3 Pro)",
    category: "image-generation",
    keywords: ["generate", "create", "image", "gemini", "google", "pro", "latest"],
    shortDescription: "Latest Gemini image generation using Gemini 3 Pro Image via OpenRouter",
    fullInstructions: `## Gemini 3 Pro Image (OpenRouter)

Google's most advanced image model (preview). Best for complex, detailed generation.`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterGemini3ProImageGenerate(sessionId!)
);

// Gemini 3 Pro Image - Edit
registry.register(
  "editImageGemini3Pro",
  {
    displayName: "Edit Image (Gemini 3 Pro)",
    category: "image-editing",
    keywords: [
      "edit", "modify", "image", "gemini", "google", "pro", "advanced",
      // Virtual try-on and fashion keywords
      "try on", "try-on", "virtual try-on", "clothing", "outfit", "fashion",
      "image editing", "photo editing", "transform",
    ],
    shortDescription: "Advanced image editing using Gemini 3 Pro Image via OpenRouter",
    fullInstructions: `## Gemini 3 Pro Editing (OpenRouter)

Advanced image editing with Google's latest model. Supports mask for inpainting.`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterGemini3ProImageEdit(sessionId!)
);

// Gemini 3 Pro Image - Reference
registry.register(
  "referenceImageGemini3Pro",
  {
    displayName: "Reference Image (Gemini 3 Pro)",
    category: "image-generation",
    keywords: [
      "reference", "style", "transfer", "image", "gemini", "google", "pro",
      // Virtual try-on and fashion keywords
      "try on", "try-on", "virtual try-on", "clothing", "outfit", "fashion",
      "style transfer", "guided generation",
    ],
    shortDescription: "Advanced reference-guided generation using Gemini 3 Pro Image via OpenRouter",
    fullInstructions: `## Gemini 3 Pro Reference (OpenRouter)

Advanced reference-guided generation and style transfer. Adjust reference_strength (0-1).`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterGemini3ProImageReference(sessionId!)
);

// ============================================================================
// UNIFIED OPENROUTER IMAGE TOOL (Phase 1 consolidation)
// Single multi-action tool — generate, edit, reference across 11 models.
// ============================================================================

registry.register(
  "openRouterImage",
  {
    displayName: "OpenRouter Image",
    category: "image-generation",
    keywords: [
      "generate", "create", "image", "edit", "modify", "transform", "reference",
      "style transfer", "guided generation", "text-to-image", "image-to-image",
      "flux", "gpt", "openai", "gemini", "google", "nano banana", "grok", "xai",
      "seedream", "bytedance", "try on", "virtual try-on",
      "generate image", "edit image", "create image", "image generation",
    ],
    shortDescription: "Generate, edit, or reference images using 11 OpenRouter models through one unified tool",
    fullInstructions: `## OpenRouter Image (Unified)

Single tool for all OpenRouter image operations. Choose action + model:

**Actions:**
- action="generate" — text-to-image (prompt + optional aspect_ratio)
- action="edit" — edit existing images (prompt + source_image_urls + optional mask_url)
- action="reference" — reference-guided generation (prompt + reference_image_urls + optional reference_strength)

**Models (11 total):**
- Nano Banana 2 (google/gemini-3.1-flash-image-preview) — Most used, Pro quality at Flash speed
- Nano Banana Pro (google/gemini-3-pro-image-preview) — Most advanced, 2K/4K, identity preservation
- GPT-5.4 Image 2 (openai/gpt-5.4-image-2) — Latest OpenAI, reasoning + generation
- GPT-5 Image (openai/gpt-5-image) — Premium quality
- GPT-5 Image Mini (openai/gpt-5-image-mini) — Fast, efficient
- Flux.2 Pro (black-forest-labs/flux.2-pro) — Production photorealism, 4MP
- Flux.2 Max (black-forest-labs/flux.2-max) — Top-tier quality
- Flux.2 Flex (black-forest-labs/flux.2-flex) — Best text/typography rendering
- Flux.2 Klein 4B (black-forest-labs/flux.2-klein-4b) — Fastest, cheapest
- Grok Imagine (x-ai/grok-imagine-image-quality) — Photorealistic, named entities
- Seedream 4.5 (bytedance-seed/seedream-4.5) — Editing consistency, multi-image composition

**Quick guide:** For most tasks, use Nano Banana 2. For photorealism, use Flux.2 Pro/Max. For named entities/brands, use Grok Imagine.`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterImageTool(sessionId!)
);

// ============================================================================
// NEW OPENROUTER IMAGE MODELS (May 2026 — individual per-model tools)
// ============================================================================

// Flux.2 Pro - Generate
registry.register(
  "generateImageFlux2Pro",
  {
    displayName: "Generate Image (Flux.2 Pro)",
    category: "image-generation",
    keywords: ["generate", "create", "image", "flux", "pro", "photorealism", "high quality"],
    shortDescription: "Generate production-quality images with Flux.2 Pro via OpenRouter",
    fullInstructions: `## Flux.2 Pro (OpenRouter)

Frontier-level visual quality — strong prompt adherence, stable lighting, sharp textures. Supports up to 4MP resolution.`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterFlux2ProGenerate(sessionId!)
);
registry.register(
  "editImageFlux2Pro",
  {
    displayName: "Edit Image (Flux.2 Pro)",
    category: "image-editing",
    keywords: ["edit", "modify", "image", "flux", "pro"],
    shortDescription: "Edit images with Flux.2 Pro via OpenRouter",
    fullInstructions: `## Flux.2 Pro Editing (OpenRouter)

Production-grade editing with consistent character/style reproduction. Supports mask for inpainting.`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterFlux2ProEdit(sessionId!)
);
registry.register(
  "referenceImageFlux2Pro",
  {
    displayName: "Reference Image (Flux.2 Pro)",
    category: "image-generation",
    keywords: ["reference", "style", "flux", "pro"],
    shortDescription: "Reference-guided generation with Flux.2 Pro via OpenRouter",
    fullInstructions: `## Flux.2 Pro Reference (OpenRouter)

Reference-guided generation with consistent character/style reproduction. Adjust reference_strength (0-1).`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterFlux2ProReference(sessionId!)
);

// Flux.2 Max - Generate
registry.register(
  "generateImageFlux2Max",
  {
    displayName: "Generate Image (Flux.2 Max)",
    category: "image-generation",
    keywords: ["generate", "create", "image", "flux", "max", "top tier", "best quality"],
    shortDescription: "Generate top-tier images with Flux.2 Max via OpenRouter",
    fullInstructions: `## Flux.2 Max (OpenRouter)

Top-tier image quality — highest prompt understanding and editing consistency in the Flux.2 family.`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterFlux2MaxGenerate(sessionId!)
);
registry.register(
  "editImageFlux2Max",
  {
    displayName: "Edit Image (Flux.2 Max)",
    category: "image-editing",
    keywords: ["edit", "modify", "image", "flux", "max"],
    shortDescription: "Edit images with Flux.2 Max via OpenRouter",
    fullInstructions: `## Flux.2 Max Editing (OpenRouter)

Best-in-class editing with unmatched prompt understanding and consistency.`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterFlux2MaxEdit(sessionId!)
);
registry.register(
  "referenceImageFlux2Max",
  {
    displayName: "Reference Image (Flux.2 Max)",
    category: "image-generation",
    keywords: ["reference", "style", "flux", "max"],
    shortDescription: "Reference-guided generation with Flux.2 Max via OpenRouter",
    fullInstructions: `## Flux.2 Max Reference (OpenRouter)

Maximum quality style transfer and reference-guided generation. Adjust reference_strength (0-1).`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterFlux2MaxReference(sessionId!)
);

// Flux.2 Klein 4B - Generate
registry.register(
  "generateImageFlux2Klein4B",
  {
    displayName: "Generate Image (Flux.2 Klein)",
    category: "image-generation",
    keywords: ["generate", "create", "image", "flux", "klein", "fast", "cheap"],
    shortDescription: "Generate images fast with Flux.2 Klein 4B via OpenRouter",
    fullInstructions: `## Flux.2 Klein 4B (OpenRouter)

Fastest and most cost-effective Flux.2 model — optimized for high-throughput use cases.`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterFlux2Klein4BGenerate(sessionId!)
);
registry.register(
  "editImageFlux2Klein4B",
  {
    displayName: "Edit Image (Flux.2 Klein)",
    category: "image-editing",
    keywords: ["edit", "modify", "image", "flux", "klein", "fast"],
    shortDescription: "Edit images fast with Flux.2 Klein 4B via OpenRouter",
    fullInstructions: `## Flux.2 Klein 4B Editing (OpenRouter)

Fast, cost-effective editing for high-throughput workflows.`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterFlux2Klein4BEdit(sessionId!)
);
registry.register(
  "referenceImageFlux2Klein4B",
  {
    displayName: "Reference Image (Flux.2 Klein)",
    category: "image-generation",
    keywords: ["reference", "style", "flux", "klein", "fast"],
    shortDescription: "Fast reference-guided generation with Flux.2 Klein 4B via OpenRouter",
    fullInstructions: `## Flux.2 Klein 4B Reference (OpenRouter)

Fast, cost-effective reference-guided generation. Adjust reference_strength (0-1).`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterFlux2Klein4BReference(sessionId!)
);

// GPT-5.4 Image 2 - Generate
registry.register(
  "generateImageGpt54Image2",
  {
    displayName: "Generate Image (GPT-5.4 Image 2)",
    category: "image-generation",
    keywords: ["generate", "create", "image", "gpt", "openai", "gpt5.4", "latest"],
    shortDescription: "Generate images with GPT-5.4 Image 2 via OpenRouter — latest OpenAI",
    fullInstructions: `## GPT-5.4 Image 2 (OpenRouter)

Combines GPT-5.4 reasoning with GPT Image 2 state-of-the-art generation. Seamless multimodal workflows between reasoning, coding, and visual generation.`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterGpt54Image2Generate(sessionId!)
);
registry.register(
  "editImageGpt54Image2",
  {
    displayName: "Edit Image (GPT-5.4 Image 2)",
    category: "image-editing",
    keywords: ["edit", "modify", "image", "gpt", "openai", "gpt5.4"],
    shortDescription: "Edit images with GPT-5.4 Image 2 via OpenRouter",
    fullInstructions: `## GPT-5.4 Image 2 Editing (OpenRouter)

Advanced editing with GPT-5.4's reasoning capabilities.`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterGpt54Image2Edit(sessionId!)
);
registry.register(
  "referenceImageGpt54Image2",
  {
    displayName: "Reference Image (GPT-5.4 Image 2)",
    category: "image-generation",
    keywords: ["reference", "style", "image", "gpt", "openai", "gpt5.4"],
    shortDescription: "Reference-guided generation with GPT-5.4 Image 2 via OpenRouter",
    fullInstructions: `## GPT-5.4 Image 2 Reference (OpenRouter)

Reference-guided generation with GPT-5.4's reasoning. Adjust reference_strength (0-1).`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterGpt54Image2Reference(sessionId!)
);

// Grok Imagine - Generate
registry.register(
  "generateImageGrokImagine",
  {
    displayName: "Generate Image (Grok Imagine)",
    category: "image-generation",
    keywords: ["generate", "create", "image", "grok", "xai", "photorealistic", "poster", "ad"],
    shortDescription: "Generate photorealistic images with Grok Imagine via OpenRouter",
    fullInstructions: `## Grok Imagine (OpenRouter)

xAI's fast, high-fidelity generation — photorealistic outputs at 1K/2K. Strong named-entity rendering (brands, public figures, locations) and clean multilingual text. Ideal for posters, packaging, ads, menus, social graphics.`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterGrokImagineGenerate(sessionId!)
);
registry.register(
  "editImageGrokImagine",
  {
    displayName: "Edit Image (Grok Imagine)",
    category: "image-editing",
    keywords: ["edit", "modify", "image", "grok", "xai"],
    shortDescription: "Edit images with Grok Imagine via OpenRouter",
    fullInstructions: `## Grok Imagine Editing (OpenRouter)

Photorealistic editing with identity/structure preservation for product placement, brand-aligned variations, and character continuity.`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterGrokImagineEdit(sessionId!)
);
registry.register(
  "referenceImageGrokImagine",
  {
    displayName: "Reference Image (Grok Imagine)",
    category: "image-generation",
    keywords: ["reference", "style", "image", "grok", "xai"],
    shortDescription: "Reference-guided generation with Grok Imagine via OpenRouter",
    fullInstructions: `## Grok Imagine Reference (OpenRouter)

Reference-guided generation with identity preservation for posters, packaging, ads, and social graphics. Adjust reference_strength (0-1).`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterGrokImagineReference(sessionId!)
);

// Seedream 4.5 - Generate
registry.register(
  "generateImageSeedream45",
  {
    displayName: "Generate Image (Seedream 4.5)",
    category: "image-generation",
    keywords: ["generate", "create", "image", "seedream", "bytedance", "editing", "composition"],
    shortDescription: "Generate images with Seedream 4.5 via OpenRouter — excellent editing consistency",
    fullInstructions: `## Seedream 4.5 (OpenRouter)

ByteDance's latest — strong editing consistency, portrait refinement, small-text rendering, and multi-image composition.`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterSeedream45Generate(sessionId!)
);
registry.register(
  "editImageSeedream45",
  {
    displayName: "Edit Image (Seedream 4.5)",
    category: "image-editing",
    keywords: ["edit", "modify", "image", "seedream", "bytedance"],
    shortDescription: "Edit images with Seedream 4.5 via OpenRouter",
    fullInstructions: `## Seedream 4.5 Editing (OpenRouter)

Excellent editing consistency with subject detail, lighting, and color tone preservation.`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterSeedream45Edit(sessionId!)
);
registry.register(
  "referenceImageSeedream45",
  {
    displayName: "Reference Image (Seedream 4.5)",
    category: "image-generation",
    keywords: ["reference", "style", "image", "seedream", "bytedance"],
    shortDescription: "Reference-guided generation with Seedream 4.5 via OpenRouter",
    fullInstructions: `## Seedream 4.5 Reference (OpenRouter)

Reference-guided generation with strong multi-image composition capabilities. Adjust reference_strength (0-1).`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterSeedream45Reference(sessionId!)
);

// ============================================================================
// OPENROUTER VIDEO TOOL (Phase 3 — 10 models, async polling)
// ============================================================================

registry.register(
  "openRouterVideo",
  {
    displayName: "OpenRouter Video",
    category: "video-generation",
    keywords: [
      "video", "generate video", "animate", "animation", "motion",
      "text-to-video", "image-to-video", "reference-to-video",
      "grok", "kling", "veo", "hailuo", "seedance", "wan",
      "cinematic", "clip", "film", "xai", "google", "bytedance",
    ],
    shortDescription: "Generate videos from text, images, or references using 10 OpenRouter models via async polling",
    fullInstructions: `## OpenRouter Video (Unified)

Generate videos from text, images, or reference images using 10 OpenRouter video models. Uses async polling — action="generate" submits and polls inline (up to 5 minutes).

**Actions:**
- action="generate" — text-to-video (all 10 models)
- action="animate" — image-to-video, animate a still image (all 10 models)
- action="reference" — reference-to-video, style from reference images (Grok/Seedance/Wan only)
- action="check" — poll an existing job by job_id or polling_url

**Models (10 total):**
- Grok Imagine (x-ai/grok-imagine-video) — text/image/reference, 1-15s, 24fps
- Kling v3.0 Pro (kwaivgi/kling-v3.0-pro) — premium, 3-15s, first+last frame, optional audio
- Kling v3.0 Standard (kwaivgi/kling-v3.0-standard) — balanced, 3-15s, first+last frame
- Kling O1 (kwaivgi/kling-o1) — cinematic, 5-10s, first+last frame
- Veo 3.1 Fast (google/veo-3.1-fast) — mid-tier, native audio, first+last frame
- Veo 3.1 Lite (google/veo-3.1-lite) — cheapest, 4-8s, native audio
- Hailuo 2.3 (minimax/hailuo-2.3) — realistic motion, character animation
- Seedance 2.0 Fast (bytedance/seedance-2.0-fast) — speed-prioritized, first+last frame
- Seedance 2.0 (bytedance/seedance-2.0) — character consistency, camera control, first+last frame, reference
- Wan 2.7 (alibaba/wan-2.7) — text/image/reference, first+last frame

**Tips:** Be specific about motion, camera movement, lighting, and mood in your prompt. Videos take 30s-5min to generate depending on model and duration.`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "OPENROUTER_API_KEY",
  } satisfies ToolMetadata,
  ({ sessionId }) => createOpenRouterVideoTool(sessionId!)
);

// ============================================================================
// RUNWAY VIDEO GENERATION TOOLS
// Requires RUNWAYML_API_SECRET environment variable
// ============================================================================

registry.register(
  "generateVideoRunway",
  {
    displayName: "Generate Video (Runway)",
    category: "video-generation",
    keywords: [
      "video", "runway", "gen4", "gen4.5", "cinematic",
      "text-to-video", "image-to-video", "animate", "motion",
      "clip", "film", "generate video",
    ],
    shortDescription: "Generate cinematic videos with Runway Gen-4/Gen-4.5",
    fullInstructions: `## Runway Video Generation

Generate high-quality cinematic videos. Supports text-to-video and image-to-video.

**Models:** gen4.5 (best quality), gen4_turbo (fast + good quality, default), gen3a_turbo (fastest, image-to-video only)
**Duration:** 2-10 seconds
**Ratios:** 1280:720 (landscape), 720:1280 (portrait), 960:960 (square), 1104:832, 832:1104, 1584:672
**Tips:** Be descriptive about camera movement, lighting, and mood. Use seed for reproducibility.
**Image-to-video:** Provide image_url to animate a still image. Accepts /api/media/ URLs from previously generated images directly. Omit for pure text-to-video.
**Continuing from video:** Extract a frame with ffmpeg (via executeCommand using the video's file path), save it alongside the video, then pass the corresponding /api/media/ URL as image_url.`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "RUNWAYML_API_SECRET",
  } satisfies ToolMetadata,
  ({ sessionId }) => createRunwayVideoTool(sessionId!)
);

// ============================================================================
// VERTEX AI VEO VIDEO GENERATION TOOLS
// Requires VERTEX_AI_PROJECT_ID + Google Cloud credentials
// ============================================================================

registry.register(
  "generateVideoVertexAI",
  {
    displayName: "Generate Video (Google Veo)",
    category: "video-generation",
    keywords: [
      "video", "veo", "google", "vertex", "vertex-ai",
      "text-to-video", "image-to-video", "animate", "motion",
      "clip", "film", "generate video",
    ],
    shortDescription: "Generate videos with Google Veo via Vertex AI",
    fullInstructions: `## Google Veo Video Generation

Generate videos with Google's Veo models via Vertex AI.

**Models:** veo-3.0-generate-001 (default), veo-3.1-generate-001 (latest), veo-3.0-fast-generate-001 (fast), veo-2.0-generate-001 (legacy)
**Duration:** Veo 2: 5-8s, Veo 3: 4/6/8s
**Aspect Ratio:** 16:9 (landscape), 9:16 (portrait)
**Resolution:** 720p (default), 1080p (Veo 3+ only)
**Features:** Audio generation (Veo 3+), negative prompts, deterministic seeds, multiple samples (1-4).
**Image-to-video:** Provide image_url to animate a still image. Accepts /api/media/ URLs from previously generated images directly. Omit for pure text-to-video.
**Continuing from video:** Extract a frame with ffmpeg (via executeCommand using the video's file path), save it alongside the video, then pass the corresponding /api/media/ URL as image_url.`,
    loading: { deferLoading: true },
    requiresSession: true,
    enableEnvVar: "VERTEX_AI_PROJECT_ID",
  } satisfies ToolMetadata,
  ({ sessionId }) => createVertexAIVideoTool(sessionId!)
);

// ============================================================================
// Codex gpt-image-2 (CLIProxyAPI sidecar) — generate / edit / reference.
// Auth is gated at execute-time via `isCodexAuthenticated()` — if the user
// hasn't logged in to Codex (settings.codexToken), the tool returns a
// human-readable error directing them to the Settings page. We intentionally
// don't pin `enableEnvVar` here because the auth source is a settings token,
// not an env var, and dynamic state can change without a restart.
// ============================================================================

registry.register(
  "generateImageGptImage2",
  {
    displayName: "Generate Image (Codex gpt-image-2)",
    category: "image-generation",
    keywords: [
      "generate", "image", "codex", "gpt-image", "gpt-image-2", "openai",
      "text-to-image", "transparent", "png", "illustration", "art",
    ],
    shortDescription: "Generate images with Codex gpt-image-2 (OpenAI native)",
    fullInstructions: `## Codex gpt-image-2 — Generate

OpenAI-native image generation routed through the local CLIProxyAPI sidecar.
Requires the user to be signed in to Codex (Settings → Codex).

- \`size\`: 1024x1024 (default), 1024x1536, 1536x1024, or auto
- \`quality\`: low / medium / high (default) / auto
- \`background\`: transparent (PNG only), opaque, or auto
- \`output_format\`: png (default — needed for transparency), jpeg, webp`,
    loading: { deferLoading: true },
    requiresSession: true,
  } satisfies ToolMetadata,
  ({ sessionId }) => createGenerateCodexImageTool(sessionId!)
);

registry.register(
  "editImageGptImage2",
  {
    displayName: "Edit Image (Codex gpt-image-2)",
    category: "image-editing",
    keywords: [
      "edit", "image", "codex", "gpt-image", "gpt-image-2", "openai",
      "image-to-image", "modify", "inpainting", "mask",
    ],
    shortDescription: "Edit existing images with Codex gpt-image-2",
    fullInstructions: `## Codex gpt-image-2 — Edit

Edit an existing image (or composite multiple) via the CLIProxyAPI sidecar.
Pass selene /api/media/ URLs, http(s) URLs, or base64 data URLs as
\`source_image_urls\`. Optional \`mask_url\` controls inpainting
(white pixels are repainted, black pixels preserved). \`input_fidelity: high\`
preserves the source more strictly.`,
    loading: { deferLoading: true },
    requiresSession: true,
  } satisfies ToolMetadata,
  ({ sessionId }) => createEditCodexImageTool(sessionId!)
);

registry.register(
  "referenceImageGptImage2",
  {
    displayName: "Reference Image (Codex gpt-image-2)",
    category: "image-generation",
    keywords: [
      "reference", "style", "image", "codex", "gpt-image", "gpt-image-2",
      "guided", "virtual try-on", "try on", "outfit", "fashion",
    ],
    shortDescription: "Generate images with reference images using Codex gpt-image-2",
    fullInstructions: `## Codex gpt-image-2 — Reference

Generate guided by one or more reference images (style transfer, virtual
try-on, subject consistency). Pass selene /api/media/ URLs, http(s) URLs,
or base64 data URLs as \`reference_image_urls\`. Multi-image input is
supported — combine person + product photos for try-on tasks.`,
    loading: { deferLoading: true },
    requiresSession: true,
  } satisfies ToolMetadata,
  ({ sessionId }) => createReferenceCodexImageTool(sessionId!)
);

// Unified Codex Image Tool (Phase 2 consolidation)
registry.register(
  "codexImage",
  {
    displayName: "Codex Image (gpt-image-2)",
    category: "image-generation",
    keywords: [
      "codex", "gpt-image", "gpt-image-2", "openai", "generate", "create",
      "image", "edit", "reference", "transparent", "png", "text-to-image",
      "image-to-image", "modify", "inpainting", "mask", "style transfer",
      "virtual try-on", "try on",
    ],
    shortDescription: "Generate, edit, or reference images with Codex gpt-image-2 (OpenAI native) via CLIProxyAPI",
    fullInstructions: `## Codex gpt-image-2 (Unified)

OpenAI-native image generation routed through the local CLIProxyAPI sidecar. Requires Codex sign-in (Settings → Codex).

**Actions:**
- action="generate" → text-to-image (prompt + optional size/quality/background/output_format)
- action="edit" → edit images (prompt + source_image_urls + optional mask/input_fidelity)
- action="reference" → reference-guided (prompt + reference_image_urls)

**Options:** size (1024x1024 default), quality (low/medium/high/auto), background (transparent for PNG), output_format (png/jpeg/webp). Use png + transparent background for logos/icons.`,
    loading: { deferLoading: true },
    requiresSession: true,
  } satisfies ToolMetadata,
  ({ sessionId }) => createCodexImageTool(sessionId!)
);

}
