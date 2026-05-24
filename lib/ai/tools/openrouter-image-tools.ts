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
  type OpenRouterImageGenerationArgs,
  type OpenRouterImageEditingArgs,
  type OpenRouterImageReferencingArgs,
  type OpenRouterImageInput,
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
// Flux.2 Flex Tools (black-forest-labs/flux.2-flex)
// ==========================================================================

export function createOpenRouterFlux2FlexGenerate(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "generateImageFlux2Flex",
    sessionId,
    (args: OpenRouterImageGenerationArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.FLUX2_FLEX, "generate", args)
  );

  return tool({
    description: "Generate images from text using Flux.2 Flex via OpenRouter. High-quality, versatile image generation.",
    inputSchema: openRouterGenerateSchema,
    execute: executeWithLogging,
  });
}

export function createOpenRouterFlux2FlexEdit(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "editImageFlux2Flex",
    sessionId,
    (args: OpenRouterImageEditingArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.FLUX2_FLEX, "edit", args)
  );

  return tool({
    description: "Edit one or more images using Flux.2 Flex via OpenRouter. Supports multiple source images for batch editing, transformation, or enhancement.",
    inputSchema: openRouterEditSchema,
    execute: executeWithLogging,
  });
}

export function createOpenRouterFlux2FlexReference(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "referenceImageFlux2Flex",
    sessionId,
    (args: OpenRouterImageReferencingArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.FLUX2_FLEX, "reference", args)
  );

  return tool({
    description: "Generate images guided by one or more reference images using Flux.2 Flex via OpenRouter. Supports multiple references for style transfer and content-guided generation.",
    inputSchema: openRouterReferenceSchema,
    execute: executeWithLogging,
  });
}

// ==========================================================================
// GPT-5 Image Mini Tools (openai/gpt-5-image-mini)
// ==========================================================================

export function createOpenRouterGpt5ImageMiniGenerate(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "generateImageGpt5Mini",
    sessionId,
    (args: OpenRouterImageGenerationArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.GPT5_IMAGE_MINI, "generate", args)
  );

  return tool({
    description: "Generate images from text using GPT-5 Image Mini via OpenRouter. Fast, efficient image generation.",
    inputSchema: openRouterGenerateSchema,
    execute: executeWithLogging,
  });
}

export function createOpenRouterGpt5ImageMiniEdit(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "editImageGpt5Mini",
    sessionId,
    (args: OpenRouterImageEditingArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.GPT5_IMAGE_MINI, "edit", args)
  );

  return tool({
    description: "Edit one or more images using GPT-5 Image Mini via OpenRouter. Supports multiple source images for quick batch modifications.",
    inputSchema: openRouterEditSchema,
    execute: executeWithLogging,
  });
}

export function createOpenRouterGpt5ImageMiniReference(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "referenceImageGpt5Mini",
    sessionId,
    (args: OpenRouterImageReferencingArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.GPT5_IMAGE_MINI, "reference", args)
  );

  return tool({
    description: "Generate images guided by one or more reference images using GPT-5 Image Mini via OpenRouter. Supports multiple references.",
    inputSchema: openRouterReferenceSchema,
    execute: executeWithLogging,
  });
}

// ==========================================================================
// GPT-5 Image Tools (openai/gpt-5-image)
// ==========================================================================

export function createOpenRouterGpt5ImageGenerate(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "generateImageGpt5",
    sessionId,
    (args: OpenRouterImageGenerationArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.GPT5_IMAGE, "generate", args)
  );

  return tool({
    description: "Generate images from text using GPT-5 Image via OpenRouter. Premium quality image generation.",
    inputSchema: openRouterGenerateSchema,
    execute: executeWithLogging,
  });
}

export function createOpenRouterGpt5ImageEdit(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "editImageGpt5",
    sessionId,
    (args: OpenRouterImageEditingArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.GPT5_IMAGE, "edit", args)
  );

  return tool({
    description: "Edit one or more images using GPT-5 Image via OpenRouter. Supports multiple source images for premium batch editing.",
    inputSchema: openRouterEditSchema,
    execute: executeWithLogging,
  });
}

export function createOpenRouterGpt5ImageReference(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "referenceImageGpt5",
    sessionId,
    (args: OpenRouterImageReferencingArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.GPT5_IMAGE, "reference", args)
  );

  return tool({
    description: "Generate images guided by one or more reference images using GPT-5 Image via OpenRouter. Supports multiple references for premium style transfer.",
    inputSchema: openRouterReferenceSchema,
    execute: executeWithLogging,
  });
}

// ==========================================================================
// Gemini 3.1 Flash Image Tools (google/gemini-3.1-flash-image-preview) — "Nano Banana 2"
// ==========================================================================

export function createOpenRouterGemini31FlashImageGenerate(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "generateImageGemini31Flash",
    sessionId,
    (args: OpenRouterImageGenerationArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.GEMINI_31_FLASH_IMAGE, "generate", args)
  );

  return tool({
    description: "Generate images from text using Gemini 3.1 Flash Image (Nano Banana 2) via OpenRouter. Pro-level visual quality at Flash speed — Google's latest and most-used image model.",
    inputSchema: openRouterGenerateSchema,
    execute: executeWithLogging,
  });
}

export function createOpenRouterGemini31FlashImageEdit(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "editImageGemini31Flash",
    sessionId,
    (args: OpenRouterImageEditingArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.GEMINI_31_FLASH_IMAGE, "edit", args)
  );

  return tool({
    description: "Edit one or more images using Gemini 3.1 Flash Image (Nano Banana 2) via OpenRouter. Fast, high-quality batch editing with advanced contextual understanding.",
    inputSchema: openRouterEditSchema,
    execute: executeWithLogging,
  });
}

export function createOpenRouterGemini31FlashImageReference(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "referenceImageGemini31Flash",
    sessionId,
    (args: OpenRouterImageReferencingArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.GEMINI_31_FLASH_IMAGE, "reference", args)
  );

  return tool({
    description: "Generate images guided by one or more reference images using Gemini 3.1 Flash Image (Nano Banana 2) via OpenRouter. Supports multiple references for style transfer.",
    inputSchema: openRouterReferenceSchema,
    execute: executeWithLogging,
  });
}

// ==========================================================================
// Gemini 3 Pro Image Tools (google/gemini-3-pro-image-preview)
// ==========================================================================

export function createOpenRouterGemini3ProImageGenerate(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "generateImageGemini3Pro",
    sessionId,
    (args: OpenRouterImageGenerationArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.GEMINI_3_PRO_IMAGE, "generate", args)
  );

  return tool({
    description: "Generate images from text using Gemini 3 Pro Image via OpenRouter. Latest Gemini image generation.",
    inputSchema: openRouterGenerateSchema,
    execute: executeWithLogging,
  });
}

export function createOpenRouterGemini3ProImageEdit(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "editImageGemini3Pro",
    sessionId,
    (args: OpenRouterImageEditingArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.GEMINI_3_PRO_IMAGE, "edit", args)
  );

  return tool({
    description: "Edit one or more images using Gemini 3 Pro Image via OpenRouter. Supports multiple source images for advanced batch editing.",
    inputSchema: openRouterEditSchema,
    execute: executeWithLogging,
  });
}

export function createOpenRouterGemini3ProImageReference(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "referenceImageGemini3Pro",
    sessionId,
    (args: OpenRouterImageReferencingArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.GEMINI_3_PRO_IMAGE, "reference", args)
  );

  return tool({
    description: "Generate images guided by one or more reference images using Gemini 3 Pro Image via OpenRouter. Supports multiple references for advanced style transfer.",
    inputSchema: openRouterReferenceSchema,
    execute: executeWithLogging,
  });
}

// ==========================================================================
// Flux.2 Pro Tools (black-forest-labs/flux.2-pro)
// ==========================================================================

export function createOpenRouterFlux2ProGenerate(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "generateImageFlux2Pro",
    sessionId,
    (args: OpenRouterImageGenerationArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.FLUX2_PRO, "generate", args)
  );
  return tool({
    description: "Generate images from text using Flux.2 Pro via OpenRouter. Frontier-level visual quality with strong prompt adherence, stable lighting, and sharp textures. Supports up to 4MP resolution.",
    inputSchema: openRouterGenerateSchema,
    execute: executeWithLogging,
  });
}

export function createOpenRouterFlux2ProEdit(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "editImageFlux2Pro",
    sessionId,
    (args: OpenRouterImageEditingArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.FLUX2_PRO, "edit", args)
  );
  return tool({
    description: "Edit images using Flux.2 Pro via OpenRouter. Production-grade editing with consistent character/style reproduction across multi-reference inputs.",
    inputSchema: openRouterEditSchema,
    execute: executeWithLogging,
  });
}

export function createOpenRouterFlux2ProReference(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "referenceImageFlux2Pro",
    sessionId,
    (args: OpenRouterImageReferencingArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.FLUX2_PRO, "reference", args)
  );
  return tool({
    description: "Generate images guided by reference images using Flux.2 Pro via OpenRouter. Consistent character/style reproduction across multiple references.",
    inputSchema: openRouterReferenceSchema,
    execute: executeWithLogging,
  });
}

// ==========================================================================
// Flux.2 Max Tools (black-forest-labs/flux.2-max)
// ==========================================================================

export function createOpenRouterFlux2MaxGenerate(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "generateImageFlux2Max",
    sessionId,
    (args: OpenRouterImageGenerationArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.FLUX2_MAX, "generate", args)
  );
  return tool({
    description: "Generate images from text using Flux.2 Max via OpenRouter. Top-tier image quality — highest level of prompt understanding and editing consistency in the Flux.2 family.",
    inputSchema: openRouterGenerateSchema,
    execute: executeWithLogging,
  });
}

export function createOpenRouterFlux2MaxEdit(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "editImageFlux2Max",
    sessionId,
    (args: OpenRouterImageEditingArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.FLUX2_MAX, "edit", args)
  );
  return tool({
    description: "Edit images using Flux.2 Max via OpenRouter. Best-in-class editing with unmatched prompt understanding and consistency.",
    inputSchema: openRouterEditSchema,
    execute: executeWithLogging,
  });
}

export function createOpenRouterFlux2MaxReference(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "referenceImageFlux2Max",
    sessionId,
    (args: OpenRouterImageReferencingArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.FLUX2_MAX, "reference", args)
  );
  return tool({
    description: "Generate images guided by reference images using Flux.2 Max via OpenRouter. Maximum quality style transfer and reference-guided generation.",
    inputSchema: openRouterReferenceSchema,
    execute: executeWithLogging,
  });
}

// ==========================================================================
// Flux.2 Klein 4B Tools (black-forest-labs/flux.2-klein-4b)
// ==========================================================================

export function createOpenRouterFlux2Klein4BGenerate(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "generateImageFlux2Klein4B",
    sessionId,
    (args: OpenRouterImageGenerationArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.FLUX2_KLEIN_4B, "generate", args)
  );
  return tool({
    description: "Generate images from text using Flux.2 Klein 4B via OpenRouter. Fastest and most cost-effective Flux.2 model — optimized for high-throughput use cases.",
    inputSchema: openRouterGenerateSchema,
    execute: executeWithLogging,
  });
}

export function createOpenRouterFlux2Klein4BEdit(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "editImageFlux2Klein4B",
    sessionId,
    (args: OpenRouterImageEditingArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.FLUX2_KLEIN_4B, "edit", args)
  );
  return tool({
    description: "Edit images using Flux.2 Klein 4B via OpenRouter. Fast, cost-effective editing for high-throughput workflows.",
    inputSchema: openRouterEditSchema,
    execute: executeWithLogging,
  });
}

export function createOpenRouterFlux2Klein4BReference(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "referenceImageFlux2Klein4B",
    sessionId,
    (args: OpenRouterImageReferencingArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.FLUX2_KLEIN_4B, "reference", args)
  );
  return tool({
    description: "Generate images guided by reference images using Flux.2 Klein 4B via OpenRouter. Fast, cost-effective reference-guided generation.",
    inputSchema: openRouterReferenceSchema,
    execute: executeWithLogging,
  });
}

// ==========================================================================
// GPT-5.4 Image 2 Tools (openai/gpt-5.4-image-2)
// ==========================================================================

export function createOpenRouterGpt54Image2Generate(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "generateImageGpt54Image2",
    sessionId,
    (args: OpenRouterImageGenerationArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.GPT54_IMAGE_2, "generate", args)
  );
  return tool({
    description: "Generate images from text using GPT-5.4 Image 2 via OpenRouter. Combines GPT-5.4 reasoning with GPT Image 2 state-of-the-art generation — seamless multimodal workflows.",
    inputSchema: openRouterGenerateSchema,
    execute: executeWithLogging,
  });
}

export function createOpenRouterGpt54Image2Edit(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "editImageGpt54Image2",
    sessionId,
    (args: OpenRouterImageEditingArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.GPT54_IMAGE_2, "edit", args)
  );
  return tool({
    description: "Edit images using GPT-5.4 Image 2 via OpenRouter. Advanced editing with GPT-5.4's reasoning capabilities.",
    inputSchema: openRouterEditSchema,
    execute: executeWithLogging,
  });
}

export function createOpenRouterGpt54Image2Reference(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "referenceImageGpt54Image2",
    sessionId,
    (args: OpenRouterImageReferencingArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.GPT54_IMAGE_2, "reference", args)
  );
  return tool({
    description: "Generate images guided by reference images using GPT-5.4 Image 2 via OpenRouter. Reference-guided generation with GPT-5.4's reasoning.",
    inputSchema: openRouterReferenceSchema,
    execute: executeWithLogging,
  });
}

// ==========================================================================
// Grok Imagine Image Quality Tools (x-ai/grok-imagine-image-quality)
// ==========================================================================

export function createOpenRouterGrokImagineGenerate(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "generateImageGrokImagine",
    sessionId,
    (args: OpenRouterImageGenerationArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.GROK_IMAGINE, "generate", args)
  );
  return tool({
    description: "Generate images from text using Grok Imagine via OpenRouter. xAI's fast, high-fidelity generation — photorealistic outputs at 1K/2K with strong named-entity rendering and clean multilingual text in images.",
    inputSchema: openRouterGenerateSchema,
    execute: executeWithLogging,
  });
}

export function createOpenRouterGrokImagineEdit(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "editImageGrokImagine",
    sessionId,
    (args: OpenRouterImageEditingArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.GROK_IMAGINE, "edit", args)
  );
  return tool({
    description: "Edit images using Grok Imagine via OpenRouter. Photorealistic editing with identity and structure preservation for product placement, brand-aligned variations, and character continuity.",
    inputSchema: openRouterEditSchema,
    execute: executeWithLogging,
  });
}

export function createOpenRouterGrokImagineReference(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "referenceImageGrokImagine",
    sessionId,
    (args: OpenRouterImageReferencingArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.GROK_IMAGINE, "reference", args)
  );
  return tool({
    description: "Generate images guided by reference images using Grok Imagine via OpenRouter. Reference-guided generation with identity preservation for posters, packaging, ads, and social graphics.",
    inputSchema: openRouterReferenceSchema,
    execute: executeWithLogging,
  });
}

// ==========================================================================
// Seedream 4.5 Tools (bytedance-seed/seedream-4.5)
// ==========================================================================

export function createOpenRouterSeedream45Generate(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "generateImageSeedream45",
    sessionId,
    (args: OpenRouterImageGenerationArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.SEEDREAM_45, "generate", args)
  );
  return tool({
    description: "Generate images from text using Seedream 4.5 via OpenRouter. ByteDance's latest — strong editing consistency, portrait refinement, small-text rendering, and multi-image composition.",
    inputSchema: openRouterGenerateSchema,
    execute: executeWithLogging,
  });
}

export function createOpenRouterSeedream45Edit(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "editImageSeedream45",
    sessionId,
    (args: OpenRouterImageEditingArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.SEEDREAM_45, "edit", args)
  );
  return tool({
    description: "Edit images using Seedream 4.5 via OpenRouter. Excellent editing consistency with subject detail, lighting, and color tone preservation.",
    inputSchema: openRouterEditSchema,
    execute: executeWithLogging,
  });
}

export function createOpenRouterSeedream45Reference(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "referenceImageSeedream45",
    sessionId,
    (args: OpenRouterImageReferencingArgs) =>
      executeOpenRouterImage(sessionId, OPENROUTER_MODELS.SEEDREAM_45, "reference", args)
  );
  return tool({
    description: "Generate images guided by reference images using Seedream 4.5 via OpenRouter. Reference-guided generation with strong multi-image composition capabilities.",
    inputSchema: openRouterReferenceSchema,
    execute: executeWithLogging,
  });
}

// ==========================================================================
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
