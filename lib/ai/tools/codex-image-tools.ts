/**
 * Codex `gpt-image-2` image-generation tools.
 *
 * Talks to the CLIProxyAPI sidecar's OpenAI-compatible /v1/images/* endpoint.
 * The sidecar wraps the request into a Codex `/responses` call with the
 * `image_generation` tool and returns base64-encoded results — we save them
 * to local storage and emit the canonical `{ status, images[] }` shape every
 * other selene image tool produces.
 */

import { tool } from "ai";
import { createImage, createToolRun, updateToolRun } from "@/lib/db/queries";
import { getFullPath, getFullPathFromMediaRef, saveBase64Image } from "@/lib/storage/local-storage";
import {
  CodexImageError,
  editCodexImage,
  generateCodexImage,
  type CodexImageItem,
} from "@/lib/ai/providers/cliproxy/images-client";
import { withToolLogging } from "@/lib/ai/tool-registry/logging";
import {
  codexImageEditSchema,
  codexImageGenerateSchema,
  codexImageReferenceSchema,
  codexImageSchema,
  type CodexImageEditingArgs,
  type CodexImageGenerationArgs,
  type CodexImageReferencingArgs,
  type CodexImageInput,
} from "@/lib/ai/tools/codex-image-schemas";

interface ToolImageOutput {
  url: string;
  localPath: string;
  filePath: string;
}

interface ToolSuccessResult {
  status: "completed";
  images: ToolImageOutput[];
  model: "gpt-image-2";
  revisedPrompt?: string;
}

interface ToolErrorResult {
  status: "error";
  error: string;
}

type ToolResult = ToolSuccessResult | ToolErrorResult;

const now = (): string => new Date().toISOString();

function describeError(err: unknown): string {
  if (err instanceof CodexImageError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

async function persistGeneratedImages(
  sessionId: string,
  toolRunId: string,
  items: CodexImageItem[],
  metadata: Record<string, unknown>,
): Promise<ToolImageOutput[]> {
  const outputs: ToolImageOutput[] = [];
  for (const item of items) {
    const upload = await saveBase64Image(item.b64, sessionId, "generated", item.format);
    outputs.push({
      url: upload.url,
      localPath: upload.localPath,
      filePath: getFullPath(upload.localPath),
    });
    await createImage({
      sessionId,
      toolRunId,
      role: "generated",
      url: upload.url,
      localPath: upload.localPath,
      metadata: {
        ...metadata,
        ...(item.revisedPrompt ? { revisedPrompt: item.revisedPrompt } : {}),
      },
    });
  }
  return outputs;
}

async function runGenerate(
  sessionId: string,
  args: CodexImageGenerationArgs,
): Promise<ToolResult> {
  const toolRun = await createToolRun({
    sessionId,
    toolName: "generateImageGptImage2",
    args: args as unknown as Record<string, unknown>,
    status: "running",
  });

  try {
    const items = await generateCodexImage({
      prompt: args.prompt,
      options: {
        size: args.size,
        quality: args.quality,
        background: args.background,
        outputFormat: args.output_format,
      },
    });

    const images = await persistGeneratedImages(sessionId, toolRun.id, items, {
      model: "gpt-image-2",
      operation: "generate",
      prompt: args.prompt,
    });

    await updateToolRun(toolRun.id, {
      status: "succeeded",
      result: { images },
      completedAt: now(),
    });

    const revisedPrompt = items.find((i) => i.revisedPrompt)?.revisedPrompt;
    return {
      status: "completed",
      images,
      model: "gpt-image-2",
      ...(revisedPrompt ? { revisedPrompt } : {}),
    };
  } catch (err) {
    const message = describeError(err);
    await updateToolRun(toolRun.id, {
      status: "failed",
      error: message,
      completedAt: now(),
    });
    return { status: "error", error: message };
  }
}

async function runEdit(
  sessionId: string,
  toolName: "editImageGptImage2" | "referenceImageGptImage2",
  args: { prompt: string; images: string[]; mask?: string; format?: CodexImageGenerationArgs["output_format"]; size?: CodexImageGenerationArgs["size"]; quality?: CodexImageGenerationArgs["quality"]; background?: CodexImageGenerationArgs["background"] },
  rawArgs: Record<string, unknown>,
  operation: "edit" | "reference",
): Promise<ToolResult> {
  const toolRun = await createToolRun({
    sessionId,
    toolName,
    args: rawArgs,
    status: "running",
  });

  try {
    const items = await editCodexImage({
      prompt: args.prompt,
      images: args.images,
      mask: args.mask,
      resolveLocal: (ref) => getFullPathFromMediaRef(ref),
      options: {
        size: args.size,
        quality: args.quality,
        background: args.background,
        outputFormat: args.format,
      },
    });

    const images = await persistGeneratedImages(sessionId, toolRun.id, items, {
      model: "gpt-image-2",
      operation,
      prompt: args.prompt,
    });

    await updateToolRun(toolRun.id, {
      status: "succeeded",
      result: { images },
      completedAt: now(),
    });

    const revisedPrompt = items.find((i) => i.revisedPrompt)?.revisedPrompt;
    return {
      status: "completed",
      images,
      model: "gpt-image-2",
      ...(revisedPrompt ? { revisedPrompt } : {}),
    };
  } catch (err) {
    const message = describeError(err);
    await updateToolRun(toolRun.id, {
      status: "failed",
      error: message,
      completedAt: now(),
    });
    return { status: "error", error: message };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Tool factories — names match the registry entries below.
// ────────────────────────────────────────────────────────────────────────────

export function createGenerateCodexImageTool(sessionId: string) {
  return tool({
    description: "Generate a new image from a text prompt using Codex gpt-image-2 (via CLIProxyAPI). High-quality OpenAI-native image model — supports transparent backgrounds and PNG/JPEG/WebP output.",
    inputSchema: codexImageGenerateSchema,
    execute: withToolLogging<CodexImageGenerationArgs, ToolResult>(
      "generateImageGptImage2",
      sessionId,
      (args) => runGenerate(sessionId, args),
    ),
  });
}

export function createEditCodexImageTool(sessionId: string) {
  return tool({
    description: "Edit an existing image using Codex gpt-image-2 (via CLIProxyAPI). Supports an optional mask (white pixels are repainted, black pixels preserved).",
    inputSchema: codexImageEditSchema,
    execute: withToolLogging<CodexImageEditingArgs, ToolResult>(
      "editImageGptImage2",
      sessionId,
      (args) =>
        runEdit(
          sessionId,
          "editImageGptImage2",
          {
            prompt: args.prompt,
            images: args.source_image_urls,
            mask: args.mask_url,
            format: args.output_format,
            size: args.size,
            quality: args.quality,
            background: args.background,
          },
          args as unknown as Record<string, unknown>,
          "edit",
        ),
    ),
  });
}

export function createReferenceCodexImageTool(sessionId: string) {
  return tool({
    description: "Generate a new image guided by one or more reference images using Codex gpt-image-2 (via CLIProxyAPI). Use for style transfer, virtual try-on, or subject consistency.",
    inputSchema: codexImageReferenceSchema,
    execute: withToolLogging<CodexImageReferencingArgs, ToolResult>(
      "referenceImageGptImage2",
      sessionId,
      (args) =>
        runEdit(
          sessionId,
          "referenceImageGptImage2",
          {
            prompt: args.prompt,
            images: args.reference_image_urls,
            format: args.output_format,
            size: args.size,
            quality: args.quality,
            background: args.background,
          },
          args as unknown as Record<string, unknown>,
          "reference",
        ),
    ),
  });
}

// ==========================================================================
// UNIFIED CODEX IMAGE TOOL (Phase 2 consolidation)
// Single multi-action tool replacing per-operation generate/edit/reference tools.
// ==========================================================================

export function createCodexImageTool(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "codexImage",
    sessionId,
    async (args: CodexImageInput): Promise<ToolResult> => {
      switch (args.action) {
        case "generate":
          return runGenerate(sessionId, {
            prompt: args.prompt,
            size: args.size,
            quality: args.quality,
            background: args.background,
            output_format: args.output_format,
          });
        case "edit":
          return runEdit(
            sessionId,
            "editImageGptImage2",
            {
              prompt: args.prompt,
              images: args.source_image_urls ?? [],
              mask: args.mask_url,
              format: args.output_format,
              size: args.size,
              quality: args.quality,
              background: args.background,
            },
            args as unknown as Record<string, unknown>,
            "edit",
          );
        case "reference":
          return runEdit(
            sessionId,
            "referenceImageGptImage2",
            {
              prompt: args.prompt,
              images: args.reference_image_urls ?? [],
              format: args.output_format,
              size: args.size,
              quality: args.quality,
              background: args.background,
            },
            args as unknown as Record<string, unknown>,
            "reference",
          );
      }
    }
  );

  return tool({
    description: `Unified Codex gpt-image-2 tool — generate, edit, or reference images via the local CLIProxyAPI sidecar.

Requires the user to be signed in to Codex (Settings → Codex).

**Actions:**
- action="generate" → text-to-image (prompt + optional size/quality/background/output_format)
- action="edit" → edit existing images (prompt + source_image_urls + optional mask_url)
- action="reference" → reference-guided generation (prompt + reference_image_urls)

**Options:** size (1024x1024 default), quality (low/medium/high/auto), background (transparent/opaque/auto), output_format (png/jpeg/webp). Use png for transparent backgrounds.`,
    inputSchema: codexImageSchema,
    execute: executeWithLogging,
  });
}
