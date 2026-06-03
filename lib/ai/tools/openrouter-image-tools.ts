import { tool } from "ai";
import { createToolRun, updateToolRun, createImage } from "@/lib/db/queries";
import { getFullPath, saveBase64Image } from "@/lib/storage/local-storage";
import { withToolLogging } from "@/lib/ai/tool-registry/logging";
import { imageToDataUrl } from "@/lib/ai/tools/image-tools";
import {
  openRouterGenerateSchema,
  openRouterEditSchema,
  openRouterReferenceSchema,
  openRouterImageSchema,
  openRouterImageModelSchema,
  type OpenRouterImageGenerationArgs,
  type OpenRouterImageEditingArgs,
  type OpenRouterImageReferencingArgs,
  type OpenRouterImageInput,
  type OpenRouterImageModelInput,
  OPENROUTER_MODELS,
} from "@/lib/ai/tools/openrouter-image-schemas";

// Helper to get current timestamp as ISO string for SQLite
const now = () => new Date().toISOString();

/**
 * Core execution function for OpenRouter image operations
 */
async function executeOpenRouterImage(
  sessionId: string,
  model: string,
  operation: "generate" | "edit" | "reference",
  args: OpenRouterImageGenerationArgs | OpenRouterImageEditingArgs | OpenRouterImageReferencingArgs
): Promise<{
  status: "completed" | "error";
  images?: Array<{ url: string; localPath?: string; filePath?: string }>;
  error?: string;
}> {
  const toolName = `${operation}ImageOpenRouter${model.replace(/[^a-zA-Z0-9]/g, "")}`;

  // Preflight: fail fast with a clear error if the API key is missing
  if (!process.env.OPENROUTER_API_KEY) {
    return { status: "error" as const, error: "OpenRouter API key is not configured. Set OPENROUTER_API_KEY in your environment." };
  }

  const toolRun = await createToolRun({
    sessionId,
    toolName,
    args: args as unknown as Record<string, unknown>,
    status: "running",
  });

  try {
    let messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }>;

    if (operation === "generate") {
      messages = [{ role: "user", content: args.prompt }];
    } else if (operation === "edit") {
      const editArgs = args as OpenRouterImageEditingArgs;
      const imageContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
      for (const imageUrl of editArgs.source_image_urls) {
        const imageDataUrl = await imageToDataUrl(imageUrl);
        imageContent.push({ type: "image_url", image_url: { url: imageDataUrl } });
      }
      // Include mask image if provided (inpainting: white=edit, black=preserve)
      if (editArgs.mask_url) {
        const maskDataUrl = await imageToDataUrl(editArgs.mask_url);
        imageContent.push({ type: "image_url", image_url: { url: maskDataUrl } });
        imageContent.push({ type: "text", text: `${editArgs.prompt}\n\n[The last image is a mask for inpainting — white areas will be edited, black areas preserved.]` });
      } else {
        imageContent.push({ type: "text", text: editArgs.prompt });
      }
      messages = [{ role: "user", content: imageContent }];
    } else { // reference
      const refArgs = args as OpenRouterImageReferencingArgs;
      const imageContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
      for (const imageUrl of refArgs.reference_image_urls) {
        const imageDataUrl = await imageToDataUrl(imageUrl);
        imageContent.push({ type: "image_url", image_url: { url: imageDataUrl } });
      }
      // Append reference strength guidance if provided
      const promptText = refArgs.reference_strength != null
        ? `${refArgs.prompt}\n\n[Reference strength: ${refArgs.reference_strength}]`
        : refArgs.prompt;
      imageContent.push({ type: "text", text: promptText });
      messages = [{ role: "user", content: imageContent }];
    }

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL || "https://styly-agent.com",
        "X-Title": "Styly Agent",
      },
      body: JSON.stringify({
        model,
        messages,
        modalities: ["image", "text"],
        stream: false,
        ...((args as OpenRouterImageGenerationArgs).aspect_ratio && {
          image_config: { aspect_ratio: (args as OpenRouterImageGenerationArgs).aspect_ratio }
        }),
      }),
    });

    if (!response.ok) {
      // Robust error decoding: try JSON, fall back to text for HTML/proxy errors
      let errorMsg = `OpenRouter request failed (${response.status})`;
      try {
        const err = await response.json() as { error?: { message?: string } };
        if (err.error?.message) errorMsg = err.error.message;
      } catch {
        const text = await response.text().catch(() => "");
        if (text) errorMsg = `OpenRouter request failed (${response.status}): ${text.slice(0, 200)}`;
      }
      throw new Error(errorMsg);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { images?: Array<{ image_url: { url: string } }> } }>
    };
    const rawImages = data.choices?.[0]?.message?.images || [];

    // Gemini 3 Pro (and occasionally others) can return identical duplicate images.
    // Deduplicate by hashing the full URL or base64 data to avoid false collisions.
    const seen = new Set<string>();
    const images = rawImages.filter((img) => {
      const url = img?.image_url?.url;
      if (!url) return false;
      // Use a simple hash of the full URL for dedup (avoids 200-char truncation collisions)
      let hash = 0;
      for (let i = 0; i < url.length; i++) {
        const chr = url.charCodeAt(i);
        hash = ((hash << 5) - hash) + chr;
        hash |= 0; // Convert to 32-bit integer
      }
      const key = `${url.length}:${hash}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (images.length !== rawImages.length) {
      console.log(
        `[OpenRouter Image] Deduplicated ${rawImages.length} -> ${images.length} images (model: ${model}, operation: ${operation})`
      );
    }

    if (images.length === 0) {
      throw new Error("No images returned from OpenRouter API");
    }

    // Process images: if base64 data URLs, save to local storage to avoid token bloat
    const processedImages: Array<{ url: string; localPath?: string; filePath?: string }> = [];

    for (const img of images) {
      const rawUrl = img.image_url.url;

      if (rawUrl.startsWith("data:image/")) {
        const formatMatch = rawUrl.match(/^data:image\/(\w+);base64,/);
        const format = formatMatch?.[1] || "png";

        const uploadResult = await saveBase64Image(
          rawUrl,
          sessionId,
          "generated",
          format
        );

        processedImages.push({
          url: uploadResult.url,
          localPath: uploadResult.localPath,
          filePath: getFullPath(uploadResult.localPath),
        });
      } else {
        processedImages.push({
          url: rawUrl,
          localPath: rawUrl,
        });
      }
    }

    const imageObjects = processedImages.map((img) => ({
      url: img.url,
      ...(img.localPath ? { localPath: img.localPath } : {}),
      ...(img.filePath ? { filePath: img.filePath } : {}),
    }));

    for (const img of processedImages) {
      await createImage({
        sessionId,
        toolRunId: toolRun.id,
        role: "generated",
        url: img.url,
        localPath: img.localPath || img.url,
        metadata: { model, operation, prompt: args.prompt },
      });
    }

    await updateToolRun(toolRun.id, {
      status: "succeeded",
      result: { images: imageObjects },
      completedAt: now(),
    });

    return { status: "completed", images: imageObjects };

  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    await updateToolRun(toolRun.id, {
      status: "failed",
      error: msg,
      completedAt: now(),
    });
    return { status: "error", error: msg };
  }
}

// ==========================================================================
// ==========================================================================
// Per-Model Tool Descriptors + Generic Factory (replaces 33 hand-written functions)
// ==========================================================================

interface ModelToolConfig {
  suffix: string;
  model: string;
  unifiedToolName: string;
  unifiedDisplayName: string;
  capabilitySummary: string;
  gen:   { toolName: string; desc: string };
  edit:  { toolName: string; desc: string };
  ref:   { toolName: string; desc: string };
}

const MODEL_DESCRIPTORS: ModelToolConfig[] = [
  { suffix: "Flux2Flex", model: OPENROUTER_MODELS.FLUX2_FLEX,
    unifiedToolName: "openRouterImageFlux2Flex", unifiedDisplayName: "OpenRouter Image — Flux.2 Flex",
    capabilitySummary: "Generate, edit, and reference images. Best in the Flux.2 family for text and typography rendering.",
    gen:   { toolName: "generateImageFlux2Flex", desc: "Generate images from text using Flux.2 Flex via OpenRouter. High-quality, versatile image generation." },
    edit:  { toolName: "editImageFlux2Flex", desc: "Edit one or more images using Flux.2 Flex via OpenRouter. Supports multiple source images for batch editing, transformation, or enhancement." },
    ref:   { toolName: "referenceImageFlux2Flex", desc: "Generate images guided by one or more reference images using Flux.2 Flex via OpenRouter. Supports multiple references for style transfer and content-guided generation." },
  },
  { suffix: "Gpt5ImageMini", model: OPENROUTER_MODELS.GPT5_IMAGE_MINI,
    unifiedToolName: "openRouterImageGpt5Mini", unifiedDisplayName: "OpenRouter Image — GPT-5 Image Mini",
    capabilitySummary: "Generate, edit, and reference images. Fast, efficient OpenAI image workflows.",
    gen:   { toolName: "generateImageGpt5Mini", desc: "Generate images from text using GPT-5 Image Mini via OpenRouter. Fast, efficient image generation." },
    edit:  { toolName: "editImageGpt5Mini", desc: "Edit one or more images using GPT-5 Image Mini via OpenRouter. Supports multiple source images for quick batch modifications." },
    ref:   { toolName: "referenceImageGpt5Mini", desc: "Generate images guided by one or more reference images using GPT-5 Image Mini via OpenRouter. Supports multiple references." },
  },
  { suffix: "Gpt5Image", model: OPENROUTER_MODELS.GPT5_IMAGE,
    unifiedToolName: "openRouterImageGpt5", unifiedDisplayName: "OpenRouter Image — GPT-5 Image",
    capabilitySummary: "Generate, edit, and reference images. Premium OpenAI image quality.",
    gen:   { toolName: "generateImageGpt5", desc: "Generate images from text using GPT-5 Image via OpenRouter. Premium quality image generation." },
    edit:  { toolName: "editImageGpt5", desc: "Edit one or more images using GPT-5 Image via OpenRouter. Supports multiple source images for premium batch editing." },
    ref:   { toolName: "referenceImageGpt5", desc: "Generate images guided by one or more reference images using GPT-5 Image via OpenRouter. Supports multiple references for premium style transfer." },
  },
  { suffix: "Gemini31FlashImage", model: OPENROUTER_MODELS.GEMINI_31_FLASH_IMAGE,
    unifiedToolName: "openRouterImageGemini31Flash", unifiedDisplayName: "OpenRouter Image — Nano Banana 2",
    capabilitySummary: "Generate, edit, and reference images. Pro-level quality at Flash speed with strong contextual understanding.",
    gen:   { toolName: "generateImageGemini31Flash", desc: "Generate images from text using Gemini 3.1 Flash Image (Nano Banana 2) via OpenRouter. Pro-level visual quality at Flash speed — Google's latest and most-used image model." },
    edit:  { toolName: "editImageGemini31Flash", desc: "Edit one or more images using Gemini 3.1 Flash Image (Nano Banana 2) via OpenRouter. Fast, high-quality batch editing with advanced contextual understanding." },
    ref:   { toolName: "referenceImageGemini31Flash", desc: "Generate images guided by one or more reference images using Gemini 3.1 Flash Image (Nano Banana 2) via OpenRouter. Supports multiple references for style transfer." },
  },
  { suffix: "Gemini3ProImage", model: OPENROUTER_MODELS.GEMINI_3_PRO_IMAGE,
    unifiedToolName: "openRouterImageGemini3Pro", unifiedDisplayName: "OpenRouter Image — Gemini 3 Pro",
    capabilitySummary: "Generate, edit, and reference images. Advanced Gemini image model for complex, detailed outputs.",
    gen:   { toolName: "generateImageGemini3Pro", desc: "Generate images from text using Gemini 3 Pro Image via OpenRouter. Latest Gemini image generation." },
    edit:  { toolName: "editImageGemini3Pro", desc: "Edit one or more images using Gemini 3 Pro Image via OpenRouter. Supports multiple source images for advanced batch editing." },
    ref:   { toolName: "referenceImageGemini3Pro", desc: "Generate images guided by one or more reference images using Gemini 3 Pro Image via OpenRouter. Supports multiple references for advanced style transfer." },
  },
  { suffix: "Flux2Pro", model: OPENROUTER_MODELS.FLUX2_PRO,
    unifiedToolName: "openRouterImageFlux2Pro", unifiedDisplayName: "OpenRouter Image — Flux.2 Pro",
    capabilitySummary: "Generate, edit, and reference images. Frontier photorealism with strong prompt adherence and up to 4MP output.",
    gen:   { toolName: "generateImageFlux2Pro", desc: "Generate images from text using Flux.2 Pro via OpenRouter. Frontier-level visual quality with strong prompt adherence, stable lighting, and sharp textures. Supports up to 4MP resolution." },
    edit:  { toolName: "editImageFlux2Pro", desc: "Edit images using Flux.2 Pro via OpenRouter. Production-grade editing with consistent character/style reproduction across multi-reference inputs." },
    ref:   { toolName: "referenceImageFlux2Pro", desc: "Generate images guided by reference images using Flux.2 Pro via OpenRouter. Consistent character/style reproduction across multiple references." },
  },
  { suffix: "Flux2Max", model: OPENROUTER_MODELS.FLUX2_MAX,
    unifiedToolName: "openRouterImageFlux2Max", unifiedDisplayName: "OpenRouter Image — Flux.2 Max",
    capabilitySummary: "Generate, edit, and reference images. Top-tier Flux.2 quality and editing consistency.",
    gen:   { toolName: "generateImageFlux2Max", desc: "Generate images from text using Flux.2 Max via OpenRouter. Top-tier image quality — highest level of prompt understanding and editing consistency in the Flux.2 family." },
    edit:  { toolName: "editImageFlux2Max", desc: "Edit images using Flux.2 Max via OpenRouter. Best-in-class editing with unmatched prompt understanding and consistency." },
    ref:   { toolName: "referenceImageFlux2Max", desc: "Generate images guided by reference images using Flux.2 Max via OpenRouter. Maximum quality style transfer and reference-guided generation." },
  },
  { suffix: "Flux2Klein4B", model: OPENROUTER_MODELS.FLUX2_KLEIN_4B,
    unifiedToolName: "openRouterImageFlux2Klein4B", unifiedDisplayName: "OpenRouter Image — Flux.2 Klein 4B",
    capabilitySummary: "Generate, edit, and reference images. Fastest and most cost-effective Flux.2 option.",
    gen:   { toolName: "generateImageFlux2Klein4B", desc: "Generate images from text using Flux.2 Klein 4B via OpenRouter. Fastest and most cost-effective Flux.2 model — optimized for high-throughput use cases." },
    edit:  { toolName: "editImageFlux2Klein4B", desc: "Edit images using Flux.2 Klein 4B via OpenRouter. Fast, cost-effective editing for high-throughput workflows." },
    ref:   { toolName: "referenceImageFlux2Klein4B", desc: "Generate images guided by reference images using Flux.2 Klein 4B via OpenRouter. Fast, cost-effective reference-guided generation." },
  },
  { suffix: "Gpt54Image2", model: OPENROUTER_MODELS.GPT54_IMAGE_2,
    unifiedToolName: "openRouterImageGpt54Image2", unifiedDisplayName: "OpenRouter Image — GPT-5.4 Image 2",
    capabilitySummary: "Generate, edit, and reference images. Latest OpenAI reasoning plus image generation workflow.",
    gen:   { toolName: "generateImageGpt54Image2", desc: "Generate images from text using GPT-5.4 Image 2 via OpenRouter. Combines GPT-5.4 reasoning with GPT Image 2 state-of-the-art generation — seamless multimodal workflows." },
    edit:  { toolName: "editImageGpt54Image2", desc: "Edit images using GPT-5.4 Image 2 via OpenRouter. Advanced editing with GPT-5.4's reasoning capabilities." },
    ref:   { toolName: "referenceImageGpt54Image2", desc: "Generate images guided by reference images using GPT-5.4 Image 2 via OpenRouter. Reference-guided generation with GPT-5.4's reasoning." },
  },
  { suffix: "GrokImagine", model: OPENROUTER_MODELS.GROK_IMAGINE,
    unifiedToolName: "openRouterImageGrokImagine", unifiedDisplayName: "OpenRouter Image — Grok Imagine",
    capabilitySummary: "Generate, edit, and reference images. Photorealistic outputs, named entities, brands, and multilingual text.",
    gen:   { toolName: "generateImageGrokImagine", desc: "Generate images from text using Grok Imagine via OpenRouter. xAI's fast, high-fidelity generation — photorealistic outputs at 1K/2K with strong named-entity rendering and clean multilingual text in images." },
    edit:  { toolName: "editImageGrokImagine", desc: "Edit images using Grok Imagine via OpenRouter. Photorealistic editing with identity and structure preservation for product placement, brand-aligned variations, and character continuity." },
    ref:   { toolName: "referenceImageGrokImagine", desc: "Generate images guided by reference images using Grok Imagine via OpenRouter. Reference-guided generation with identity preservation for posters, packaging, ads, and social graphics." },
  },
  { suffix: "Seedream45", model: OPENROUTER_MODELS.SEEDREAM_45,
    unifiedToolName: "openRouterImageSeedream45", unifiedDisplayName: "OpenRouter Image — Seedream 4.5",
    capabilitySummary: "Generate, edit, and reference images. Strong editing consistency, portrait refinement, and multi-image composition.",
    gen:   { toolName: "generateImageSeedream45", desc: "Generate images from text using Seedream 4.5 via OpenRouter. ByteDance's latest — strong editing consistency, portrait refinement, small-text rendering, and multi-image composition." },
    edit:  { toolName: "editImageSeedream45", desc: "Edit images using Seedream 4.5 via OpenRouter. Excellent editing consistency with subject detail, lighting, and color tone preservation." },
    ref:   { toolName: "referenceImageSeedream45", desc: "Generate images guided by reference images using Seedream 4.5 via OpenRouter. Reference-guided generation with strong multi-image composition capabilities." },
  },
];

function createModelTool(
  sessionId: string,
  config: ModelToolConfig,
  operation: "generate" | "edit" | "reference",
  toolName: string,
  description: string,
) {
  const schema = operation === "generate"
    ? openRouterGenerateSchema
    : operation === "edit"
    ? openRouterEditSchema
    : openRouterReferenceSchema;

  return tool({
    description,
    inputSchema: schema,
    execute: withToolLogging(toolName, sessionId,
      (args) => executeOpenRouterImage(sessionId, config.model, operation, args)
    ),
  });
}

function createUnifiedModelTool(sessionId: string, config: ModelToolConfig) {
  const description = `${config.unifiedDisplayName}: ${config.capabilitySummary}

The selected tool fixes the provider/model to ${config.model}; do not pass a model parameter.

**Actions:**
- action="generate" → text-to-image (prompt + optional aspect_ratio)
- action="edit" → edit existing images (prompt + source_image_urls + optional mask_url)
- action="reference" → reference-guided generation (prompt + reference_image_urls + optional reference_strength)

Use edit when changing supplied source images. Use reference when creating a new image guided by one or more references.`;

  return tool({
    description,
    inputSchema: openRouterImageModelSchema,
    execute: withToolLogging(config.unifiedToolName, sessionId,
      (args: OpenRouterImageModelInput) =>
        executeOpenRouterImage(
          sessionId,
          config.model,
          args.action,
          args as OpenRouterImageGenerationArgs | OpenRouterImageEditingArgs | OpenRouterImageReferencingArgs
        )
    ),
  });
}

// ── Thin exports (33 functions, auto-generated from MODEL_DESCRIPTORS) ──
export const createOpenRouterFlux2FlexGenerate = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[0], "generate", "generateImageFlux2Flex", "Generate images from text using Flux.2 Flex via OpenRouter. High-quality, versatile image generation.");

export const createOpenRouterFlux2FlexEdit = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[0], "edit", "editImageFlux2Flex", "Edit one or more images using Flux.2 Flex via OpenRouter. Supports multiple source images for batch editing, transformation, or enhancement.");

export const createOpenRouterFlux2FlexReference = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[0], "reference", "referenceImageFlux2Flex", "Generate images guided by one or more reference images using Flux.2 Flex via OpenRouter. Supports multiple references for style transfer and content-guided generation.");

export const createOpenRouterGpt5ImageMiniGenerate = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[1], "generate", "generateImageGpt5Mini", "Generate images from text using GPT-5 Image Mini via OpenRouter. Fast, efficient image generation.");

export const createOpenRouterGpt5ImageMiniEdit = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[1], "edit", "editImageGpt5Mini", "Edit one or more images using GPT-5 Image Mini via OpenRouter. Supports multiple source images for quick batch modifications.");

export const createOpenRouterGpt5ImageMiniReference = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[1], "reference", "referenceImageGpt5Mini", "Generate images guided by one or more reference images using GPT-5 Image Mini via OpenRouter. Supports multiple references.");

export const createOpenRouterGpt5ImageGenerate = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[2], "generate", "generateImageGpt5", "Generate images from text using GPT-5 Image via OpenRouter. Premium quality image generation.");

export const createOpenRouterGpt5ImageEdit = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[2], "edit", "editImageGpt5", "Edit one or more images using GPT-5 Image via OpenRouter. Supports multiple source images for premium batch editing.");

export const createOpenRouterGpt5ImageReference = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[2], "reference", "referenceImageGpt5", "Generate images guided by one or more reference images using GPT-5 Image via OpenRouter. Supports multiple references for premium style transfer.");

export const createOpenRouterGemini31FlashImageGenerate = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[3], "generate", "generateImageGemini31Flash", "Generate images from text using Gemini 3.1 Flash Image (Nano Banana 2) via OpenRouter. Pro-level visual quality at Flash speed — Google's latest and most-used image model.");

export const createOpenRouterGemini31FlashImageEdit = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[3], "edit", "editImageGemini31Flash", "Edit one or more images using Gemini 3.1 Flash Image (Nano Banana 2) via OpenRouter. Fast, high-quality batch editing with advanced contextual understanding.");

export const createOpenRouterGemini31FlashImageReference = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[3], "reference", "referenceImageGemini31Flash", "Generate images guided by one or more reference images using Gemini 3.1 Flash Image (Nano Banana 2) via OpenRouter. Supports multiple references for style transfer.");

export const createOpenRouterGemini3ProImageGenerate = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[4], "generate", "generateImageGemini3Pro", "Generate images from text using Gemini 3 Pro Image via OpenRouter. Latest Gemini image generation.");

export const createOpenRouterGemini3ProImageEdit = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[4], "edit", "editImageGemini3Pro", "Edit one or more images using Gemini 3 Pro Image via OpenRouter. Supports multiple source images for advanced batch editing.");

export const createOpenRouterGemini3ProImageReference = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[4], "reference", "referenceImageGemini3Pro", "Generate images guided by one or more reference images using Gemini 3 Pro Image via OpenRouter. Supports multiple references for advanced style transfer.");

export const createOpenRouterFlux2ProGenerate = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[5], "generate", "generateImageFlux2Pro", "Generate images from text using Flux.2 Pro via OpenRouter. Frontier-level visual quality with strong prompt adherence, stable lighting, and sharp textures. Supports up to 4MP resolution.");

export const createOpenRouterFlux2ProEdit = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[5], "edit", "editImageFlux2Pro", "Edit images using Flux.2 Pro via OpenRouter. Production-grade editing with consistent character/style reproduction across multi-reference inputs.");

export const createOpenRouterFlux2ProReference = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[5], "reference", "referenceImageFlux2Pro", "Generate images guided by reference images using Flux.2 Pro via OpenRouter. Consistent character/style reproduction across multiple references.");

export const createOpenRouterFlux2MaxGenerate = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[6], "generate", "generateImageFlux2Max", "Generate images from text using Flux.2 Max via OpenRouter. Top-tier image quality — highest level of prompt understanding and editing consistency in the Flux.2 family.");

export const createOpenRouterFlux2MaxEdit = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[6], "edit", "editImageFlux2Max", "Edit images using Flux.2 Max via OpenRouter. Best-in-class editing with unmatched prompt understanding and consistency.");

export const createOpenRouterFlux2MaxReference = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[6], "reference", "referenceImageFlux2Max", "Generate images guided by reference images using Flux.2 Max via OpenRouter. Maximum quality style transfer and reference-guided generation.");

export const createOpenRouterFlux2Klein4BGenerate = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[7], "generate", "generateImageFlux2Klein4B", "Generate images from text using Flux.2 Klein 4B via OpenRouter. Fastest and most cost-effective Flux.2 model — optimized for high-throughput use cases.");

export const createOpenRouterFlux2Klein4BEdit = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[7], "edit", "editImageFlux2Klein4B", "Edit images using Flux.2 Klein 4B via OpenRouter. Fast, cost-effective editing for high-throughput workflows.");

export const createOpenRouterFlux2Klein4BReference = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[7], "reference", "referenceImageFlux2Klein4B", "Generate images guided by reference images using Flux.2 Klein 4B via OpenRouter. Fast, cost-effective reference-guided generation.");

export const createOpenRouterGpt54Image2Generate = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[8], "generate", "generateImageGpt54Image2", "Generate images from text using GPT-5.4 Image 2 via OpenRouter. Combines GPT-5.4 reasoning with GPT Image 2 state-of-the-art generation — seamless multimodal workflows.");

export const createOpenRouterGpt54Image2Edit = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[8], "edit", "editImageGpt54Image2", "Edit images using GPT-5.4 Image 2 via OpenRouter. Advanced editing with GPT-5.4's reasoning capabilities.");

export const createOpenRouterGpt54Image2Reference = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[8], "reference", "referenceImageGpt54Image2", "Generate images guided by reference images using GPT-5.4 Image 2 via OpenRouter. Reference-guided generation with GPT-5.4's reasoning.");

export const createOpenRouterGrokImagineGenerate = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[9], "generate", "generateImageGrokImagine", "Generate images from text using Grok Imagine via OpenRouter. xAI's fast, high-fidelity generation — photorealistic outputs at 1K/2K with strong named-entity rendering and clean multilingual text in images.");

export const createOpenRouterGrokImagineEdit = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[9], "edit", "editImageGrokImagine", "Edit images using Grok Imagine via OpenRouter. Photorealistic editing with identity and structure preservation for product placement, brand-aligned variations, and character continuity.");

export const createOpenRouterGrokImagineReference = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[9], "reference", "referenceImageGrokImagine", "Generate images guided by reference images using Grok Imagine via OpenRouter. Reference-guided generation with identity preservation for posters, packaging, ads, and social graphics.");

export const createOpenRouterSeedream45Generate = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[10], "generate", "generateImageSeedream45", "Generate images from text using Seedream 4.5 via OpenRouter. ByteDance's latest — strong editing consistency, portrait refinement, small-text rendering, and multi-image composition.");

export const createOpenRouterSeedream45Edit = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[10], "edit", "editImageSeedream45", "Edit images using Seedream 4.5 via OpenRouter. Excellent editing consistency with subject detail, lighting, and color tone preservation.");

export const createOpenRouterSeedream45Reference = (sessionId: string) =>
  createModelTool(sessionId, MODEL_DESCRIPTORS[10], "reference", "referenceImageSeedream45", "Generate images guided by reference images using Seedream 4.5 via OpenRouter. Reference-guided generation with strong multi-image composition capabilities.");

// ── Per-model unified tools (one selectable provider/model, multiple actions) ──
export const createOpenRouterFlux2FlexImageTool = (sessionId: string) =>
  createUnifiedModelTool(sessionId, MODEL_DESCRIPTORS[0]);
export const createOpenRouterGpt5ImageMiniImageTool = (sessionId: string) =>
  createUnifiedModelTool(sessionId, MODEL_DESCRIPTORS[1]);
export const createOpenRouterGpt5ImageImageTool = (sessionId: string) =>
  createUnifiedModelTool(sessionId, MODEL_DESCRIPTORS[2]);
export const createOpenRouterGemini31FlashImageTool = (sessionId: string) =>
  createUnifiedModelTool(sessionId, MODEL_DESCRIPTORS[3]);
export const createOpenRouterGemini3ProImageTool = (sessionId: string) =>
  createUnifiedModelTool(sessionId, MODEL_DESCRIPTORS[4]);
export const createOpenRouterFlux2ProImageTool = (sessionId: string) =>
  createUnifiedModelTool(sessionId, MODEL_DESCRIPTORS[5]);
export const createOpenRouterFlux2MaxImageTool = (sessionId: string) =>
  createUnifiedModelTool(sessionId, MODEL_DESCRIPTORS[6]);
export const createOpenRouterFlux2Klein4BImageTool = (sessionId: string) =>
  createUnifiedModelTool(sessionId, MODEL_DESCRIPTORS[7]);
export const createOpenRouterGpt54Image2ImageTool = (sessionId: string) =>
  createUnifiedModelTool(sessionId, MODEL_DESCRIPTORS[8]);
export const createOpenRouterGrokImagineImageTool = (sessionId: string) =>
  createUnifiedModelTool(sessionId, MODEL_DESCRIPTORS[9]);
export const createOpenRouterSeedream45ImageTool = (sessionId: string) =>
  createUnifiedModelTool(sessionId, MODEL_DESCRIPTORS[10]);

// UNIFIED OPENROUTER IMAGE TOOL (Phase 1 consolidation)
// Single multi-action tool replacing per-model generate/edit/reference tools.
// ==========================================================================

export function createOpenRouterImageTool(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "openRouterImage",
    sessionId,
    (args: OpenRouterImageInput) =>
      executeOpenRouterImage(sessionId, args.model, args.action, args)
  );

  return tool({
    description: `Unified OpenRouter image tool — generate, edit, or reference images across 11 models.

**Models (by quality tier):**
- Best overall: ${OPENROUTER_MODELS.GEMINI_31_FLASH_IMAGE} (Nano Banana 2 — most used), ${OPENROUTER_MODELS.GEMINI_3_PRO_IMAGE} (Nano Banana Pro)
- Best photorealism: ${OPENROUTER_MODELS.FLUX2_MAX}, ${OPENROUTER_MODELS.FLUX2_PRO}
- Best text rendering: ${OPENROUTER_MODELS.FLUX2_FLEX}
- Latest OpenAI: ${OPENROUTER_MODELS.GPT54_IMAGE_2} (GPT-5.4 + Image 2), ${OPENROUTER_MODELS.GPT5_IMAGE}
- Fast/cheap: ${OPENROUTER_MODELS.GPT5_IMAGE_MINI}, ${OPENROUTER_MODELS.FLUX2_KLEIN_4B}
- Named entities/brands: ${OPENROUTER_MODELS.GROK_IMAGINE}
- Multi-image composition: ${OPENROUTER_MODELS.SEEDREAM_45}

**Actions:**
- action="generate" → text-to-image (prompt + optional aspect_ratio)
- action="edit" → edit existing images (prompt + source_image_urls + optional mask_url)
- action="reference" → reference-guided generation (prompt + reference_image_urls + optional reference_strength)

All actions use the same chat/completions API. Images returned as base64 data URLs.`,
    inputSchema: openRouterImageSchema,
    execute: executeWithLogging,
  });
}
