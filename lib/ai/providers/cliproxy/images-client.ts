/**
 * Thin HTTP client for the CLIProxyAPI sidecar's OpenAI-compatible
 * /v1/images/* endpoints.
 *
 * The sidecar talks the OpenAI Images shape to clients and translates to
 * Codex's `/responses` + `image_generation` tool under the hood (see
 * `internal/runtime/executor/codex_openai_images.go` upstream).
 *
 * This module owns:
 *  - JSON requests for /v1/images/generations (text → image)
 *  - multipart/form-data requests for /v1/images/edits (image + mask → image)
 *  - Boot + bridge the Codex credential before every call.
 */

import { ensureCodexCredentialBridged } from "./codex-bridge";
import { ensureSidecarReady } from "./sidecar";

/**
 * Codex image-gen pass-through fields. Names mirror OpenAI's images API.
 * The sidecar forwards these onto the upstream `image_generation` tool spec
 * verbatim — see `codexBuildOpenAIImageTool` in the upstream Go code for the
 * authoritative list.
 */
export interface CodexImageRequestOptions {
  size?: "1024x1024" | "1024x1536" | "1536x1024" | "auto" | (string & {});
  quality?: "low" | "medium" | "high" | "auto";
  background?: "transparent" | "opaque" | "auto";
  outputFormat?: "png" | "jpeg" | "webp";
  moderation?: "low" | "auto";
  outputCompression?: number;
  partialImages?: number;
}

export type CodexImageEditOptions = CodexImageRequestOptions;


export interface CodexImageItem {
  /** Base64-encoded image body (no `data:` prefix). */
  b64: string;
  /** Image format inferred from the sidecar response (defaults to png). */
  format: string;
  /** Model-rewritten prompt, when Codex returns one. */
  revisedPrompt?: string;
}

interface OpenAIImagesResponse {
  data?: Array<{
    b64_json?: string;
    url?: string;
    revised_prompt?: string;
  }>;
  error?: { message?: string; type?: string };
}

// `baseUrl` from the sidecar already includes the `/v1` prefix
// (`http://127.0.0.1:8317/v1`), so the paths here are relative to that.
const IMAGES_GEN_PATH = "/images/generations";
const IMAGES_EDIT_PATH = "/images/edits";
/** The only Codex image model the sidecar recognises. */
export const CODEX_IMAGE_MODEL = "gpt-image-2";

export class CodexImageError extends Error {
  readonly status: number | undefined;
  readonly upstreamType: string | undefined;
  constructor(message: string, opts: { status?: number; upstreamType?: string } = {}) {
    super(message);
    this.name = "CodexImageError";
    this.status = opts.status;
    this.upstreamType = opts.upstreamType;
  }
}

async function ensureReady(): Promise<{ baseUrl: string; apiKey: string }> {
  const ready = await ensureSidecarReady();
  const bridged = await ensureCodexCredentialBridged();
  if (!bridged) {
    throw new CodexImageError(
      "Sign in to Codex in Settings to use gpt-image-2 (no valid Codex token found).",
      { upstreamType: "auth_required" },
    );
  }
  return { baseUrl: ready.baseUrl, apiKey: ready.apiKey };
}

function applyOptions(body: Record<string, unknown>, opts: CodexImageRequestOptions): void {
  if (opts.size) body.size = opts.size;
  if (opts.quality) body.quality = opts.quality;
  if (opts.background) body.background = opts.background;
  if (opts.outputFormat) body.output_format = opts.outputFormat;
  if (opts.moderation) body.moderation = opts.moderation;
  if (typeof opts.outputCompression === "number") body.output_compression = opts.outputCompression;
  if (typeof opts.partialImages === "number") body.partial_images = opts.partialImages;
}

function parseOpenAIImagesPayload(payload: OpenAIImagesResponse, fallbackFormat: string): CodexImageItem[] {
  if (!Array.isArray(payload.data) || payload.data.length === 0) {
    throw new CodexImageError("Sidecar returned no images.");
  }

  const items: CodexImageItem[] = [];
  for (const entry of payload.data) {
    if (entry.b64_json && entry.b64_json.length > 0) {
      items.push({
        b64: entry.b64_json,
        format: fallbackFormat,
        ...(entry.revised_prompt ? { revisedPrompt: entry.revised_prompt } : {}),
      });
      continue;
    }
    if (entry.url) {
      // The sidecar normally returns b64; if it ever returns a URL we
      // surface it as a sentinel so callers don't blindly try to base64-decode.
      throw new CodexImageError(
        "Sidecar returned an image URL instead of base64; selene only supports b64_json mode.",
      );
    }
  }

  if (items.length === 0) {
    throw new CodexImageError("Sidecar response contained no usable b64_json entries.");
  }
  return items;
}

async function decodeError(res: Response): Promise<CodexImageError> {
  let body: OpenAIImagesResponse | null = null;
  try {
    body = (await res.json()) as OpenAIImagesResponse;
  } catch {
    // ignore — fall back to status text below
  }
  const message = body?.error?.message ?? `Sidecar /v1/images request failed (${res.status} ${res.statusText})`;
  return new CodexImageError(message, { status: res.status, upstreamType: body?.error?.type });
}

/** POST /v1/images/generations — text → image. */
export async function generateCodexImage(args: {
  prompt: string;
  options?: CodexImageRequestOptions;
}): Promise<CodexImageItem[]> {
  const { baseUrl, apiKey } = await ensureReady();
  const body: Record<string, unknown> = {
    model: CODEX_IMAGE_MODEL,
    prompt: args.prompt,
    response_format: "b64_json",
  };
  applyOptions(body, args.options ?? {});

  const res = await fetch(`${baseUrl}${IMAGES_GEN_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw await decodeError(res);

  const payload = (await res.json()) as OpenAIImagesResponse;
  return parseOpenAIImagesPayload(payload, args.options?.outputFormat ?? "png");
}

interface NamedBuffer {
  buffer: Buffer;
  filename: string;
  mediaType: string;
}

/**
 * Decode an `imageRef` (data URL, http(s) URL, or `/api/media/...` path) into
 * a NamedBuffer suitable for multipart upload. Local-storage refs are read
 * from disk via the same helpers selene uses elsewhere; we keep the dep
 * surface narrow by accepting an async resolver instead of importing the
 * storage module directly.
 */
async function fetchImageRef(
  imageRef: string,
  resolveLocal: (ref: string) => string | null,
  defaultFormat: string,
): Promise<NamedBuffer> {
  if (imageRef.startsWith("data:")) {
    const match = imageRef.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new CodexImageError("Malformed data URL passed to edit/reference image.");
    const mediaType = match[1] || `image/${defaultFormat}`;
    const buffer = Buffer.from(match[2], "base64");
    const ext = mediaType.split("/")[1] || defaultFormat;
    return { buffer, filename: `image.${ext}`, mediaType };
  }

  if (imageRef.startsWith("http://") || imageRef.startsWith("https://")) {
    const res = await fetch(imageRef);
    if (!res.ok) throw new CodexImageError(`Failed to download ${imageRef}: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const mediaType = res.headers.get("content-type") || `image/${defaultFormat}`;
    const ext = mediaType.split("/")[1] || defaultFormat;
    return { buffer, filename: `image.${ext}`, mediaType };
  }

  const localPath = resolveLocal(imageRef);
  if (!localPath) {
    throw new CodexImageError(`Unsupported image reference for Codex edit: ${imageRef.slice(0, 80)}`);
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  const buffer = fs.readFileSync(localPath);
  const ext = localPath.split(".").pop()?.toLowerCase() || defaultFormat;
  return { buffer, filename: `image.${ext}`, mediaType: `image/${ext}` };
}

/**
 * POST /v1/images/edits — image (+ optional mask) → image.
 * Uses multipart/form-data per OpenAI's Images API contract; the sidecar
 * adapts to Codex's tool-call format internally.
 */
export async function editCodexImage(args: {
  prompt: string;
  images: string[];
  mask?: string;
  resolveLocal: (ref: string) => string | null;
  options?: CodexImageEditOptions;
}): Promise<CodexImageItem[]> {
  if (args.images.length === 0) {
    throw new CodexImageError("Codex edit requires at least one source image.");
  }

  const { baseUrl, apiKey } = await ensureReady();
  const defaultFormat = args.options?.outputFormat ?? "png";

  const form = new FormData();
  form.set("model", CODEX_IMAGE_MODEL);
  form.set("prompt", args.prompt);
  form.set("response_format", "b64_json");
  if (args.options?.size) form.set("size", args.options.size);
  if (args.options?.quality) form.set("quality", args.options.quality);
  if (args.options?.background) form.set("background", args.options.background);
  if (args.options?.outputFormat) form.set("output_format", args.options.outputFormat);
  if (args.options?.moderation) form.set("moderation", args.options.moderation);
  if (typeof args.options?.outputCompression === "number") form.set("output_compression", String(args.options.outputCompression));
  if (typeof args.options?.partialImages === "number") form.set("partial_images", String(args.options.partialImages));

  for (const ref of args.images) {
    const part = await fetchImageRef(ref, args.resolveLocal, defaultFormat);
    form.append("image", new Blob([new Uint8Array(part.buffer)], { type: part.mediaType }), part.filename);
  }
  if (args.mask) {
    const part = await fetchImageRef(args.mask, args.resolveLocal, defaultFormat);
    form.set("mask", new Blob([new Uint8Array(part.buffer)], { type: part.mediaType }), part.filename);
  }

  const res = await fetch(`${baseUrl}${IMAGES_EDIT_PATH}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) throw await decodeError(res);

  const payload = (await res.json()) as OpenAIImagesResponse;
  return parseOpenAIImagesPayload(payload, defaultFormat);
}
