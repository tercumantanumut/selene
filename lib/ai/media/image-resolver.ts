/**
 * Image Resolver
 *
 * Provider-agnostic helpers for turning a "image source" string —
 * data URI, /api/media/ URL, local-media:// ref, http(s) URL, or an
 * approved local filesystem path — into a base64 data URI.
 *
 * Used by:
 *  - `lib/ai/tools/read-file-tool.ts` to resolve image attachments on demand
 *    and return them as multimodal tool results.
 *  - `lib/ai/tools/image-tools-utils.ts` (legacy `describeImage` tool, scheduled
 *    for removal). This module is the long-term home of the helper.
 *
 * Path-safety policy: only files under Selene's local media storage root or
 * remote http(s) URLs are accepted. Arbitrary filesystem paths are rejected
 * to keep the chat agent inside the storage sandbox.
 */
import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getFullPathFromMediaRef, getMediaStoragePath } from "@/lib/storage/local-storage";

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

const WINDOWS_DRIVE_PATH_RE = /^[a-zA-Z]:[\\/]/;
const WINDOWS_UNC_PATH_RE = /^\\\\[^\\]+\\[^\\]+/;
const ATTACHMENT_HELPER_TEXT_RE = /^\[Attachment:/;
const SOURCE_HINT =
  "Expected a data URL, http(s) URL, /api/media/ URL, local-media:// reference, storage-relative path, or an approved local media file path.";

export function isImageExtension(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() in IMAGE_MIME_TYPES;
}

export function inferImageMimeType(filePath: string): string {
  return IMAGE_MIME_TYPES[path.extname(filePath).toLowerCase()] || "image/png";
}

function toImageDataUrl(buffer: Buffer, filePath: string): string {
  return `data:${inferImageMimeType(filePath)};base64,${buffer.toString("base64")}`;
}

function isApprovedAbsoluteImagePath(absolutePath: string): boolean {
  const storageRoot = path.resolve(getMediaStoragePath());
  const resolvedPath = path.resolve(absolutePath);
  const relativeToStorage = path.relative(storageRoot, resolvedPath);

  return relativeToStorage === "" || (!relativeToStorage.startsWith("..") && !path.isAbsolute(relativeToStorage));
}

function readAbsoluteImageFile(absolutePath: string): string {
  const resolvedPath = path.resolve(absolutePath);

  if (!isApprovedAbsoluteImagePath(resolvedPath)) {
    throw new Error(
      `Unsupported local image path: ${absolutePath}. ` +
        "Only files under Selene's local media storage can be read.",
    );
  }

  if (!existsSync(resolvedPath)) {
    throw new Error(`Local file not found: ${resolvedPath}`);
  }

  return toImageDataUrl(readFileSync(resolvedPath), resolvedPath);
}

function resolveAbsoluteImagePath(imageSource: string): string | undefined {
  let resolvedPath: string | undefined;

  if (imageSource.startsWith("file://")) {
    try {
      resolvedPath = fileURLToPath(imageSource);
    } catch {
      throw new Error(`Invalid file URL: ${imageSource}`);
    }
  } else if (
    imageSource.startsWith("/")
    || WINDOWS_DRIVE_PATH_RE.test(imageSource)
    || WINDOWS_UNC_PATH_RE.test(imageSource)
  ) {
    resolvedPath = imageSource;
  }

  if (!resolvedPath) {
    return undefined;
  }

  if (!isApprovedAbsoluteImagePath(resolvedPath)) {
    throw new Error(
      `Unsupported local image path: ${imageSource}. ` +
        "Only files under Selene's local media storage can be read.",
    );
  }

  return resolvedPath;
}

/**
 * Convert an image URL/path/data-URI to a base64 data URL ready for
 * multimodal model input.
 *
 * Accepted inputs (in priority order):
 *  - `data:image/<mime>;base64,<payload>` — returned as-is
 *  - `/api/media/<path>` or `local-media://<ref>` — resolved against the
 *    Selene storage sandbox
 *  - `http(s)://...` — fetched and inlined (uses content-type header)
 *  - File-URL or absolute path under the storage sandbox — read from disk
 *  - Storage-relative path resolvable via `getFullPathFromMediaRef`
 *
 * Throws if the source cannot be classified or resolves outside the sandbox.
 */
export async function imageToDataUrl(imageSource: string): Promise<string> {
  // Already a data URL — return verbatim.
  if (imageSource.startsWith("data:image/")) {
    return imageSource;
  }

  // Reject helper-text remnants that occasionally leak into LLM tool input.
  if (ATTACHMENT_HELPER_TEXT_RE.test(imageSource)) {
    throw new Error(
      `Unsupported image source for describeImage: ${imageSource.substring(0, 120)}. ${SOURCE_HINT}`,
    );
  }

  // Explicit storage-backed media refs.
  if (imageSource.startsWith("/api/media/") || imageSource.startsWith("local-media://")) {
    const storagePath = getFullPathFromMediaRef(imageSource);
    if (storagePath) {
      return readAbsoluteImageFile(storagePath);
    }
  }

  // Remote URL — fetch and convert.
  if (imageSource.startsWith("http://") || imageSource.startsWith("https://")) {
    const response = await fetch(imageSource);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const base64 = buffer.toString("base64");
    const contentType = response.headers.get("content-type") || "image/png";
    return `data:${contentType};base64,${base64}`;
  }

  const absolutePath = resolveAbsoluteImagePath(imageSource);
  if (absolutePath) {
    return readAbsoluteImageFile(absolutePath);
  }

  // Storage-relative paths (after excluding true absolute paths).
  const storagePath = getFullPathFromMediaRef(imageSource);
  if (storagePath) {
    return readAbsoluteImageFile(storagePath);
  }

  throw new Error(
    `Unsupported image source for describeImage: ${imageSource.substring(0, 120)}. ${SOURCE_HINT}`,
  );
}

/**
 * Split a data URI into its base64 payload + mediaType so the AI SDK doesn't
 * try to download it (the SDK's `validateDownloadUrl` rejects `data:` schemes).
 *
 * Returns `null` when the input isn't a data URI — caller should fall back to
 * passing the raw value through as-is.
 */
const DATA_URI_RE = /^data:([^;]+);base64,(.+)$/s;

export function splitDataUri(dataUri: string): { mediaType: string; base64: string } | null {
  const match = dataUri.match(DATA_URI_RE);
  if (!match) return null;
  return { mediaType: match[1], base64: match[2].trim() };
}
