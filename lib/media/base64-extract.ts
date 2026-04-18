/**
 * Base64 extraction & sanitization for tool results.
 *
 * Walks tool-result payloads and rewrites Anthropic-style content blocks that
 * inline binary data as base64 (`{type:"image"|"document", source:{type:"base64", data, media_type}}`)
 * into Selene's `mediaRef` shape — persisting the bytes to local media storage
 * and swapping `source` to a `{type:"url", url}` reference.
 *
 * The sanitizer is intentionally narrow: it only fires on the Anthropic
 * envelope shapes and `data:<mime>;base64,<payload>` URI strings. It does NOT
 * chase long base64-lookalike strings (hashes, tokens, IDs) — shape detection
 * only, no false positives.
 *
 * Idempotent: blocks already rewritten to `{type:"url", ...}` are left alone.
 *
 * Shared by:
 *   - `lib/mcp/result-formatter.ts`           — formats native MCP tool results
 *   - `app/api/chat/tools-builder.ts`          — sanitizes Claude Agent SDK
 *                                                 passthrough tool results BEFORE
 *                                                 they reach the AI SDK executor
 *                                                 (protects the current turn's
 *                                                 model-facing context, not only
 *                                                 persisted history).
 */

import { saveBase64Image, saveBase64Video } from "@/lib/storage/local-storage";
import { parseDataUrl } from "@/lib/storage/data-url";

/** Maximum recursion depth while walking tool-result payloads. */
const MAX_WALK_DEPTH = 16;

/** Placeholder left in place of base64 strings that could not be persisted. */
export const BASE64_REMOVED_PLACEHOLDER = "[Base64 data removed to prevent context bloat]";

/**
 * A persisted media reference emitted by the sanitizer and attached to the
 * top-level tool-result payload for easy discovery by replay / UI code.
 */
export interface MediaRef {
  /** `/api/media/<session>/<role>/<nanoid>.<ext>` — the canonical Selene URL. */
  url: string;
  /** MIME type of the persisted bytes (e.g. `image/png`, `application/pdf`). */
  mimeType: string;
  /** Decoded byte length of the persisted content. */
  byteLength: number;
  /** Which envelope the data came from, for diagnostics. */
  kind: "image" | "document" | "video" | "data-url";
}

export interface SanitizeOptions {
  /**
   * Session-scoped storage bucket. Required for normal operation; if missing,
   * `saveBase64Image` / `saveBase64Video` still work (they sanitize the empty
   * sessionId down to the literal segment "session"), but the persisted file
   * will not be associated with any chat session. Prefer supplying this.
   */
  sessionId?: string;
  /** Storage role passed through to `saveBase64Image` (defaults to `generated`). */
  role?: "upload" | "reference" | "generated" | "mask" | "tile";
}

export interface SanitizeResult<T = unknown> {
  sanitized: T;
  mediaRefs: MediaRef[];
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Shape detectors                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Matches Anthropic's base64 content-block envelope:
 *   { type: "image"|"document", source: { type: "base64", data, media_type } }
 * Returns the block with the typed source if it matches, null otherwise.
 */
function matchBase64Envelope(value: unknown): {
  kind: "image" | "document";
  data: string;
  mediaType: string;
  block: Record<string, unknown>;
} | null {
  if (!isPlainRecord(value)) return null;
  const kind = value.type;
  if (kind !== "image" && kind !== "document") return null;

  const source = value.source;
  if (!isPlainRecord(source)) return null;
  if (source.type !== "base64") return null;

  const data = source.data;
  const mediaType = source.media_type ?? source.mimeType;
  if (typeof data !== "string" || data.length === 0) return null;
  if (typeof mediaType !== "string" || mediaType.length === 0) return null;

  return { kind, data, mediaType, block: value };
}

/**
 * Matches the legacy Selene MCP image shape (from `@modelcontextprotocol/sdk`):
 *   { type: "image", data: "<base64>", mimeType: "image/png" }
 * Does NOT match data-URL-prefixed strings (those are handled separately).
 */
function matchMcpImageBlock(value: unknown): {
  data: string;
  mediaType: string;
  block: Record<string, unknown>;
} | null {
  if (!isPlainRecord(value)) return null;
  if (value.type !== "image") return null;

  const data = value.data;
  const mimeType = value.mimeType ?? value.media_type;
  if (typeof data !== "string" || data.length === 0) return null;
  if (typeof mimeType !== "string" || mimeType.length === 0) return null;

  // Skip data-URL strings here — the URL/string walker handles them.
  if (data.startsWith("data:")) return null;

  return { data, mediaType: mimeType, block: value };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Persistence                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

function extensionFromMimeType(mimeType: string, fallback: string = "bin"): string {
  const [, subtype] = mimeType.toLowerCase().split("/");
  if (!subtype) return fallback;
  // Strip codec / parameter suffixes: "image/png; charset=x" → "png"
  return subtype.split(";")[0]?.trim() || fallback;
}

function decodeBase64Length(data: string): number {
  // Cheap byte-length estimate without actually allocating a Buffer.
  const trimmed = data.replace(/\s+/g, "");
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding);
}

/**
 * Persist a base64 payload to local media storage and return a MediaRef.
 * Uses `saveBase64Image` for image/* MIME types and `saveBase64Video` for
 * video/* and application/* (PDFs, etc.); anything else falls back to image
 * storage with `.bin` extension so bytes are never lost.
 */
async function persistBase64(
  data: string,
  mediaType: string,
  options: SanitizeOptions,
  kind: MediaRef["kind"]
): Promise<MediaRef | null> {
  const sessionId = options.sessionId ?? "";
  const role = options.role ?? "generated";
  const mime = mediaType.toLowerCase();
  const ext = extensionFromMimeType(mime);

  // `saveBase64Image` strips `data:...;base64,` prefixes itself, but we pass
  // the raw payload when there is no prefix to avoid mime-type ambiguity.
  const payload = data.startsWith("data:") ? data : `data:${mime};base64,${data}`;

  try {
    const isVideoOrDoc = mime.startsWith("video/") || mime.startsWith("application/");
    const saved = isVideoOrDoc
      ? await saveBase64Video(payload, sessionId, role, ext)
      : await saveBase64Image(payload, sessionId, role, ext);

    return {
      url: saved.url,
      mimeType: mime,
      byteLength: decodeBase64Length(data),
      kind,
    };
  } catch (error) {
    console.warn(
      `[base64-extract] Failed to persist ${kind} payload (${mime}): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Public API                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Persist a single Anthropic-style base64 content block and return a MediaRef.
 * Used by higher-level formatters that already recognize the block shape and
 * want to delegate storage + MIME handling to a single helper.
 */
export async function persistBase64ContentBlock(
  block: { type: string; source: { type: string; data: string; media_type?: string; mimeType?: string } },
  options: SanitizeOptions
): Promise<MediaRef | null> {
  const matched = matchBase64Envelope(block);
  if (!matched) return null;
  return persistBase64(
    matched.data,
    matched.mediaType,
    options,
    matched.kind === "document"
      ? matched.mediaType.toLowerCase().startsWith("video/")
        ? "video"
        : "document"
      : "image"
  );
}

/**
 * Walks an arbitrary tool-result payload, persists any base64 image/document
 * envelopes or data-URL strings it finds, and returns a deep copy with those
 * payloads replaced by `/api/media/...` URL references. Aggregated MediaRefs
 * are returned alongside for attachment to the top-level payload.
 *
 * Idempotent: existing `{type:"url", url}` sources and `/api/media/...`
 * strings are passed through unchanged.
 */
export async function sanitizeToolResultForBase64<T = unknown>(
  output: T,
  options: SanitizeOptions = {}
): Promise<SanitizeResult<T>> {
  const mediaRefs: MediaRef[] = [];
  const seen = new WeakSet<object>();

  const walk = async (value: unknown, depth: number): Promise<unknown> => {
    if (depth > MAX_WALK_DEPTH) return value;
    if (value === null || value === undefined) return value;

    // Strings — look for data: URLs only. Leave everything else alone.
    if (typeof value === "string") {
      if (!value.startsWith("data:")) return value;
      const parsed = parseDataUrl(value);
      if (!parsed) return value;
      const ref = await persistBase64(parsed.data, parsed.mimeType, options, "data-url");
      if (ref) {
        mediaRefs.push(ref);
        return ref.url;
      }
      return BASE64_REMOVED_PLACEHOLDER;
    }

    if (typeof value !== "object") return value;

    if (Array.isArray(value)) {
      const next: unknown[] = [];
      for (const item of value) {
        next.push(await walk(item, depth + 1));
      }
      return next;
    }

    // Plain object. Check for known envelope shapes before recursing.
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) {
      // Cycle: returning `obj` here would re-introduce the original (still
      // un-sanitized) reference into the rewritten tree, defeating the whole
      // purpose of this walk for any payload that revisits a node containing
      // a base64 source. Tool-result payloads are JSON-serialised at the
      // bridge boundary anyway (cycles can't survive the persist step), so
      // collapse the cycle to a stable placeholder rather than leaking
      // unsanitized data.
      return { _circular: BASE64_REMOVED_PLACEHOLDER };
    }
    seen.add(obj);

    // Anthropic-style image/document block with base64 source.
    const envelope = matchBase64Envelope(obj);
    if (envelope) {
      const ref = await persistBase64(
        envelope.data,
        envelope.mediaType,
        options,
        envelope.kind === "document"
          ? envelope.mediaType.toLowerCase().startsWith("video/")
            ? "video"
            : "document"
          : "image"
      );
      if (ref) {
        mediaRefs.push(ref);
        return {
          ...obj,
          source: {
            type: "url",
            url: ref.url,
            media_type: ref.mimeType,
            _byteLength: ref.byteLength,
          },
        };
      }
      return {
        ...obj,
        source: {
          type: "base64",
          media_type: envelope.mediaType,
          data: BASE64_REMOVED_PLACEHOLDER,
        },
      };
    }

    // Legacy MCP-SDK image block: `{type:"image", data, mimeType}`.
    const mcpImage = matchMcpImageBlock(obj);
    if (mcpImage) {
      const ref = await persistBase64(mcpImage.data, mcpImage.mediaType, options, "image");
      if (ref) {
        mediaRefs.push(ref);
        const { data: _data, ...rest } = obj;
        void _data;
        return {
          ...rest,
          url: ref.url,
          mimeType: ref.mimeType,
          _byteLength: ref.byteLength,
        };
      }
      return { ...obj, data: BASE64_REMOVED_PLACEHOLDER };
    }

    // Otherwise recurse over fields.
    const next: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      next[key] = await walk(val, depth + 1);
    }
    return next;
  };

  const sanitized = (await walk(output, 0)) as T;
  return { sanitized, mediaRefs };
}

/**
 * Convenience wrapper used by tool-result wrappers that want to attach the
 * collected MediaRefs to the top-level payload under a canonical field name.
 * Only merges when the payload is a plain object and at least one ref exists;
 * preserves any pre-existing `mediaRefs` array.
 */
export function attachMediaRefs<T>(payload: T, mediaRefs: MediaRef[]): T {
  if (mediaRefs.length === 0) return payload;
  if (!isPlainRecord(payload)) return payload;
  const rawExisting = (payload as { mediaRefs?: unknown }).mediaRefs;
  const existing: MediaRef[] = Array.isArray(rawExisting)
    ? (rawExisting as MediaRef[])
    : [];
  // Dedup by url — some callers (e.g. MCP image blocks) already emit the ref
  // once inside `content[]` AND as a top-level `images[]` entry.
  const urls = new Set(existing.map((ref) => ref.url));
  const merged = [...existing];
  for (const ref of mediaRefs) {
    if (!urls.has(ref.url)) {
      urls.add(ref.url);
      merged.push(ref);
    }
  }
  return { ...(payload as Record<string, unknown>), mediaRefs: merged } as T;
}
