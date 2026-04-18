/**
 * Tests for `sanitizeToolResultForBase64()` — the current-turn sanitizer that
 * rewrites Anthropic-style base64 content blocks (`{type:"image"|"document",
 * source:{type:"base64", data, media_type}}`) into `/api/media/...` URL refs
 * BEFORE they reach the Vercel AI SDK executor.
 *
 * This pipeline is consumed at the Claude Agent SDK passthrough bridge in
 * `app/api/chat/tools-builder.ts` so SDK-native built-ins (Read, Write,
 * NotebookEdit, etc.) that inline binary files as base64 never bloat the
 * model's active context.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let counter = 0;
  return {
    saveBase64Image: vi.fn(async (_data: string, _sessionId: string, role: string, ext: string) => {
      counter += 1;
      const id = `img-${counter}`;
      return {
        url: `/api/media/test-session/${role}/${id}.${ext}`,
        localPath: `test-session/${role}/${id}.${ext}`,
        filePath: `/abs/test-session/${role}/${id}.${ext}`,
      };
    }),
    saveBase64Video: vi.fn(async (_data: string, _sessionId: string, role: string, ext: string) => {
      counter += 1;
      const id = `doc-${counter}`;
      return {
        url: `/api/media/test-session/${role}/${id}.${ext}`,
        localPath: `test-session/${role}/${id}.${ext}`,
        filePath: `/abs/test-session/${role}/${id}.${ext}`,
      };
    }),
    reset: () => {
      counter = 0;
    },
  };
});

vi.mock("@/lib/storage/local-storage", () => ({
  saveBase64Image: mocks.saveBase64Image,
  saveBase64Video: mocks.saveBase64Video,
  getFullPath: vi.fn((relativePath: string) => `/abs/${relativePath}`),
}));

import {
  sanitizeToolResultForBase64,
  attachMediaRefs,
  BASE64_REMOVED_PLACEHOLDER,
} from "@/lib/media/base64-extract";

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

/** Generate a base64 string of at least `len` characters that is syntactically valid. */
function fakeBase64(len: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += alphabet[i % alphabet.length];
  }
  // Ensure length is a multiple of 4 (valid base64 padding requirements).
  const padded = out.padEnd(Math.ceil(out.length / 4) * 4, "=");
  return padded;
}

/** Count runs of suspicious-looking base64 (length ≥ threshold) in a serialized string. */
function countLongBase64Runs(serialized: string, minRunLen = 500): number {
  const matches = serialized.match(/[A-Za-z0-9+/]{500,}={0,2}/g) ?? [];
  return matches.filter((m) => m.length >= minRunLen).length;
}

function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

afterEach(() => {
  mocks.saveBase64Image.mockClear();
  mocks.saveBase64Video.mockClear();
  mocks.reset();
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Tests                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

describe("sanitizeToolResultForBase64 — SDK built-in tool results", () => {
  it("strips base64 from SDK `Read` PNG envelope and emits a mediaRef", async () => {
    // Mirror of the history excerpt: SDK `Read` on a binary PNG returns an
    // Anthropic-style content block with inline base64 inside a `content` array.
    const raw = {
      type: "tool_result",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: fakeBase64(90_000), // ~90KB base64 → ~67KB decoded bytes
          },
        },
      ],
    };
    const rawBytes = bytesOf(raw);
    expect(rawBytes).toBeGreaterThan(85_000); // sanity — this is a big payload

    const { sanitized, mediaRefs } = await sanitizeToolResultForBase64(raw, {
      sessionId: "test-session",
      role: "generated",
    });

    // (a) Zero long-base64 runs survive in the sanitized output.
    const serialized = JSON.stringify(sanitized);
    expect(countLongBase64Runs(serialized)).toBe(0);
    expect(serialized).not.toContain("base64,");

    // (b) Exactly one mediaRef with /api/media/... URL and correct mimeType.
    expect(mediaRefs).toHaveLength(1);
    expect(mediaRefs[0].url).toMatch(/^\/api\/media\//);
    expect(mediaRefs[0].mimeType).toBe("image/png");
    expect(mediaRefs[0].kind).toBe("image");
    expect(mediaRefs[0].byteLength).toBeGreaterThan(60_000);

    // (c) The original block is rewritten in place: source.type → "url".
    const block = (sanitized.content as Array<Record<string, unknown>>)[0];
    expect(block.type).toBe("image");
    const source = block.source as Record<string, unknown>;
    expect(source.type).toBe("url");
    expect(source.url).toBe(mediaRefs[0].url);
    expect(source.media_type).toBe("image/png");

    // (d) saveBase64Image was called once with role=generated.
    expect(mocks.saveBase64Image).toHaveBeenCalledTimes(1);
    expect(mocks.saveBase64Video).not.toHaveBeenCalled();

    // (e) Dramatic size reduction: sanitized payload should be <1KB
    // (mediaRefs are attached by the tools-builder wrapper, not here).
    const sanitizedBytes = bytesOf(sanitized);
    expect(sanitizedBytes).toBeLessThan(1_500);
    expect(sanitizedBytes).toBeLessThan(rawBytes / 50); // 98%+ reduction
  });

  it("strips base64 from SDK `Read` PDF document envelope", async () => {
    const raw = {
      content: [
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: fakeBase64(50_000),
          },
        },
        { type: "text", text: "Here is the PDF I read." },
      ],
    };

    const { sanitized, mediaRefs } = await sanitizeToolResultForBase64(raw, {
      sessionId: "test-session",
    });

    const serialized = JSON.stringify(sanitized);
    expect(countLongBase64Runs(serialized)).toBe(0);
    expect(mediaRefs).toHaveLength(1);
    expect(mediaRefs[0].mimeType).toBe("application/pdf");
    expect(mediaRefs[0].kind).toBe("document");

    // PDFs go through saveBase64Video (application/* bucket).
    expect(mocks.saveBase64Video).toHaveBeenCalledTimes(1);
    expect(mocks.saveBase64Image).not.toHaveBeenCalled();

    // Text blocks pass through unchanged.
    const content = sanitized.content as Array<Record<string, unknown>>;
    expect(content[1]).toEqual({ type: "text", text: "Here is the PDF I read." });
  });

  it("handles multiple base64 blocks in a single tool result", async () => {
    const raw = {
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: fakeBase64(8_000) },
        },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: fakeBase64(4_000) },
        },
      ],
    };

    const { sanitized, mediaRefs } = await sanitizeToolResultForBase64(raw, {
      sessionId: "test-session",
    });

    expect(mediaRefs).toHaveLength(2);
    expect(mediaRefs[0].mimeType).toBe("image/jpeg");
    expect(mediaRefs[1].mimeType).toBe("image/png");
    expect(countLongBase64Runs(JSON.stringify(sanitized))).toBe(0);
  });

  it("is idempotent: already-rewritten `source:{type:'url'}` blocks pass through", async () => {
    const alreadySanitized = {
      content: [
        {
          type: "image",
          source: {
            type: "url",
            url: "/api/media/test-session/generated/existing.png",
            media_type: "image/png",
          },
        },
      ],
    };

    const { sanitized, mediaRefs } = await sanitizeToolResultForBase64(alreadySanitized, {
      sessionId: "test-session",
    });

    expect(mediaRefs).toHaveLength(0);
    expect(mocks.saveBase64Image).not.toHaveBeenCalled();
    expect(mocks.saveBase64Video).not.toHaveBeenCalled();
    expect(sanitized).toEqual(alreadySanitized);
  });

  it("negative guard: leaves long base64-LOOKING strings outside envelopes alone", async () => {
    // Hashes, JWTs, long IDs — anything base64-alphabet without the envelope
    // shape must NOT be molested (false-positive risk).
    const raw = {
      status: "success",
      output: {
        fileHash: fakeBase64(1_000), // 1000-char hash-like string in a text field
        jwt: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9." + fakeBase64(600),
        someId: "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789".repeat(20),
      },
    };

    const { sanitized, mediaRefs } = await sanitizeToolResultForBase64(raw, {
      sessionId: "test-session",
    });

    expect(mediaRefs).toHaveLength(0);
    expect(mocks.saveBase64Image).not.toHaveBeenCalled();
    expect(sanitized).toEqual(raw);
  });

  it("leaves data-URL strings embedded in prose unchanged (no scanning inside text)", async () => {
    const dataUrl = `data:image/gif;base64,${fakeBase64(2_000)}`;
    const raw = {
      content: [
        { type: "text", text: `Inline: ${dataUrl}` },
        { type: "text", text: `Also embedded: ${dataUrl}` },
      ],
    };

    const { sanitized, mediaRefs } = await sanitizeToolResultForBase64(raw, {
      sessionId: "test-session",
    });

    // Only standalone data-URL string values get captured — text containing
    // a data-URL does NOT match `startsWith("data:")` and is left as-is.
    // This is the correct, conservative behavior: we never scan inside
    // prose. The companion test immediately below this one pins the
    // positive (standalone) case.
    const content = sanitized.content as Array<Record<string, unknown>>;
    expect(content[0].text).toBe(`Inline: ${dataUrl}`); // unchanged
    expect(content[1].text).toBe(`Also embedded: ${dataUrl}`); // unchanged
    expect(mediaRefs).toHaveLength(0);
  });

  it("standalone data-URL string value (not embedded in prose) IS rewritten", async () => {
    const dataUrl = `data:image/gif;base64,${fakeBase64(2_000)}`;
    const raw = {
      thumbnail: dataUrl, // top-level string field with a raw data URL
      status: "success",
    };

    const { sanitized, mediaRefs } = await sanitizeToolResultForBase64(raw, {
      sessionId: "test-session",
    });

    expect(mediaRefs).toHaveLength(1);
    expect(mediaRefs[0].mimeType).toBe("image/gif");
    expect((sanitized as Record<string, unknown>).thumbnail).toMatch(/^\/api\/media\//);
  });

  it("handles legacy MCP SDK shape `{type:'image', data, mimeType}`", async () => {
    // The other live shape in the codebase — emitted by @modelcontextprotocol/sdk
    // v1.25+ for MCP servers that return image content.
    const raw = {
      content: [
        {
          type: "image",
          data: fakeBase64(12_000),
          mimeType: "image/png",
        },
      ],
    };

    const { sanitized, mediaRefs } = await sanitizeToolResultForBase64(raw, {
      sessionId: "test-session",
    });

    expect(mediaRefs).toHaveLength(1);
    expect(mediaRefs[0].mimeType).toBe("image/png");
    expect(countLongBase64Runs(JSON.stringify(sanitized))).toBe(0);

    const block = (sanitized.content as Array<Record<string, unknown>>)[0];
    expect(block.url).toBe(mediaRefs[0].url);
    expect(block.mimeType).toBe("image/png");
    expect(block.data).toBeUndefined();
  });

  it("preserves unrelated tool-result fields during walking", async () => {
    const raw = {
      status: "success",
      toolName: "Read",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: fakeBase64(2_000) },
        },
      ],
      metadata: {
        server: "claudecode",
        nestedData: { deep: { value: "keep me" } },
      },
      notes: ["keep", "these", "strings"],
    };

    const { sanitized } = await sanitizeToolResultForBase64(raw, {
      sessionId: "test-session",
    });

    expect(sanitized.status).toBe("success");
    expect(sanitized.toolName).toBe("Read");
    expect(sanitized.metadata).toEqual({
      server: "claudecode",
      nestedData: { deep: { value: "keep me" } },
    });
    expect(sanitized.notes).toEqual(["keep", "these", "strings"]);
  });

  it("gracefully handles persist failures by replacing data with placeholder", async () => {
    mocks.saveBase64Image.mockRejectedValueOnce(new Error("disk full"));

    const raw = {
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: fakeBase64(1_000) },
        },
      ],
    };

    const { sanitized, mediaRefs } = await sanitizeToolResultForBase64(raw, {
      sessionId: "test-session",
    });

    expect(mediaRefs).toHaveLength(0);
    const block = (sanitized.content as Array<Record<string, unknown>>)[0];
    const source = block.source as Record<string, unknown>;
    expect(source.type).toBe("base64");
    expect(source.data).toBe(BASE64_REMOVED_PLACEHOLDER);
    // No base64 leaked even on failure.
    expect(countLongBase64Runs(JSON.stringify(sanitized))).toBe(0);
  });

  it("passes primitives and nullish values through unchanged", async () => {
    for (const value of [null, undefined, "short string", 42, true, false]) {
      const { sanitized, mediaRefs } = await sanitizeToolResultForBase64(value, {});
      expect(sanitized).toEqual(value);
      expect(mediaRefs).toHaveLength(0);
    }
  });

  // Regression for cdb6db17 — before the fix the cycle branch in
  // `walkValue()` returned the object reference unchanged, which allowed
  // raw base64 to leak back out via the self-referential edge. The fix
  // replaces cycles with a safe placeholder object. This test pins that
  // behavior so the cycle guard never regresses to the leaky fallback.
  it("replaces cyclic refs with a safe placeholder object", async () => {
    // Use a proper Anthropic envelope so the sanitizer actually persists
    // the base64 payload through the matchBase64Envelope path — that way
    // the only remaining source of long base64 in the output would be a
    // leaky cycle fallback.
    const a: Record<string, unknown> = {
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: fakeBase64(1_000),
          },
        },
      ],
    };
    a.self = a;

    const { sanitized } = await sanitizeToolResultForBase64(a, {
      sessionId: "test-session",
    });

    expect((sanitized as Record<string, unknown>).self).toEqual({
      _circular: BASE64_REMOVED_PLACEHOLDER,
    });
    expect(countLongBase64Runs(JSON.stringify(sanitized))).toBe(0);
  });
});

describe("attachMediaRefs", () => {
  it("merges mediaRefs into object payloads", () => {
    const payload = { status: "success" };
    const result = attachMediaRefs(payload, [
      { url: "/api/media/a.png", mimeType: "image/png", byteLength: 100, kind: "image" },
    ]);
    expect(result).toEqual({
      status: "success",
      mediaRefs: [{ url: "/api/media/a.png", mimeType: "image/png", byteLength: 100, kind: "image" }],
    });
  });

  it("dedups by url when the payload already has mediaRefs", () => {
    const payload = {
      status: "success",
      mediaRefs: [{ url: "/api/media/a.png", mimeType: "image/png", byteLength: 100, kind: "image" }],
    };
    const result = attachMediaRefs(payload, [
      { url: "/api/media/a.png", mimeType: "image/png", byteLength: 100, kind: "image" },
      { url: "/api/media/b.png", mimeType: "image/png", byteLength: 200, kind: "image" },
    ]);
    const refs = (result as { mediaRefs: Array<{ url: string }> }).mediaRefs;
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.url).sort()).toEqual(["/api/media/a.png", "/api/media/b.png"]);
  });

  it("no-ops when mediaRefs is empty", () => {
    const payload = { status: "success" };
    expect(attachMediaRefs(payload, [])).toBe(payload);
  });

  it("no-ops when payload is not a plain object", () => {
    expect(
      attachMediaRefs("string-payload", [
        { url: "/api/media/a.png", mimeType: "image/png", byteLength: 1, kind: "image" },
      ])
    ).toBe("string-payload");
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Current-turn context guarantee                                            */
/* ────────────────────────────────────────────────────────────────────────── */

describe("current-turn context guarantee", () => {
  it("reproduces the history-excerpt leak: SDK Read→PNG → sanitized payload is the one handed to streamText()", async () => {
    // Simulate the exact path: Claude SDK's Read returns the Anthropic-style
    // envelope, which tools-builder receives via bridge.waitFor(). Before this
    // fix, this blob reached streamText() verbatim (~41K tokens). After the
    // fix, the sanitizer runs BEFORE normalizeSdkPassthroughOutput, so the
    // model-facing return value contains only URL refs.
    const bridgedOutput = {
      type: "tool_result",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            // Roughly the size implied by the 41K-token truncation message
            // (after the 4:1 char:token ratio, ~164KB of base64 text).
            data: fakeBase64(160_000),
          },
        },
      ],
    };

    const rawBytes = bytesOf(bridgedOutput);
    expect(rawBytes).toBeGreaterThan(150_000);

    const { sanitized, mediaRefs } = await sanitizeToolResultForBase64(bridgedOutput, {
      sessionId: "test-session",
      role: "generated",
    });

    // The return value handed to the AI SDK executor (→ streamText → model):
    const modelFacingBytes = bytesOf(sanitized);

    // Hard invariant: zero base64 reaches the model on the emitting turn.
    expect(countLongBase64Runs(JSON.stringify(sanitized))).toBe(0);
    expect(modelFacingBytes).toBeLessThan(1_500);
    expect(mediaRefs).toHaveLength(1);

    // Sanity: the whole fix buys >99% reduction on the current turn.
    expect(modelFacingBytes / rawBytes).toBeLessThan(0.01);
  });
});
