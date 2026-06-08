/**
 * Tests for stubEphemeralToolResults() — the canonical-write interceptor that
 * rewrites ephemeral tool-results (MCP, including Ghost OS screenshots) into
 * compact stubs before persistence, so replay context stays lean across turns.
 *
 * The model has already seen the full result in the current streaming turn;
 * the stub preserves status + hosted media URLs only.
 */
import { describe, it, expect } from "vitest";

import {
  stubEphemeralToolResults,
  EPHEMERAL_STUB_MARKER,
  countCanonicalTruncationMarkers,
} from "@/app/api/chat/canonical-content";
import { retrieveFullContent } from "@/lib/ai/truncated-content-store";
import type { DBContentPart, DBToolResultPart } from "@/lib/messages/converter";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ephemeralLookup(ephemeralToolNames: string[]) {
  const set = new Set(ephemeralToolNames);
  return (name: string) => set.has(name);
}

function makeGhostScreenshotResult(): DBToolResultPart {
  return {
    type: "tool-result",
    toolCallId: "call-1",
    toolName: "mcp_ghostos_ghost_screenshot",
    result: {
      status: "success",
      source: "mcp",
      server: "ghostos",
      tool: "ghost_screenshot",
      metadata: { server: "ghostos", tool: "ghost_screenshot" },
      images: [
        {
          url: "/api/media/session-1/generated/screenshot-1.png",
          localPath: "session-1/generated/screenshot-1.png",
          filePath: "/abs/session-1/generated/screenshot-1.png",
        },
      ],
      content: [
        {
          type: "image",
          url: "/api/media/session-1/generated/screenshot-1.png",
          mimeType: "image/png",
          data: "[Base64 data removed to prevent context bloat]",
        },
      ],
    },
    status: "success",
    state: "output-available",
    timestamp: "2026-04-17T00:00:00.000Z",
  };
}

function makeLocalGrepResult(): DBToolResultPart {
  // A non-ephemeral, first-party tool — should pass through untouched.
  return {
    type: "tool-result",
    toolCallId: "call-2",
    toolName: "localGrep",
    result: {
      status: "success",
      pattern: "needle",
      matches: [{ file: "a.ts", line: 42, text: "found needle" }],
      matchCount: 1,
    },
    status: "success",
    state: "output-available",
    timestamp: "2026-04-17T00:00:01.000Z",
  };
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("stubEphemeralToolResults", () => {
  it("stubs ephemeral MCP tool-results while preserving media URL refs", () => {
    const parts: DBContentPart[] = [
      { type: "tool-call", toolCallId: "call-1", toolName: "mcp_ghostos_ghost_screenshot", args: {} },
      makeGhostScreenshotResult(),
    ];

    const lookup = ephemeralLookup(["mcp_ghostos_ghost_screenshot"]);
    const rewritten = stubEphemeralToolResults(parts, lookup);

    const resultPart = rewritten.find((p) => p.type === "tool-result") as DBToolResultPart | undefined;
    expect(resultPart).toBeDefined();
    const stub = resultPart!.result as Record<string, unknown>;

    expect(stub[EPHEMERAL_STUB_MARKER]).toBe(true);
    expect(stub.status).toBe("success");
    expect(stub.toolName).toBe("mcp_ghostos_ghost_screenshot");
    expect(Array.isArray(stub.mediaRefs)).toBe(true);
    const mediaRefs = stub.mediaRefs as Array<{ url: string; mimeType?: string }>;
    expect(mediaRefs).toHaveLength(1);
    expect(mediaRefs[0].url).toBe("/api/media/session-1/generated/screenshot-1.png");
    expect(mediaRefs[0].mimeType).toBe("image/png");

    // Base64 placeholder / raw image bytes must not survive into history.
    expect(JSON.stringify(stub)).not.toContain("Base64 data removed");
    expect(JSON.stringify(stub)).not.toContain("base64,");
  });

  it("leaves non-ephemeral tool-results untouched", () => {
    const parts: DBContentPart[] = [
      { type: "tool-call", toolCallId: "call-2", toolName: "localGrep", args: {} },
      makeLocalGrepResult(),
    ];

    const lookup = ephemeralLookup([]); // nothing flagged ephemeral
    const rewritten = stubEphemeralToolResults(parts, lookup);
    expect(rewritten).toEqual(parts); // reference-equivalent pass-through
  });

  it("materially reduces the byte-cost of an ephemeral screenshot result", () => {
    // Simulate a large text-heavy payload commonly seen from Ghost OS tools
    // (e.g. ghost_read's accessibility-tree dump) to confirm the stub kills
    // the real replay cost, not just base64.
    const hugeAxTree = "child node\n".repeat(15_000); // ~165 KB of text
    const big: DBToolResultPart = {
      type: "tool-result",
      toolCallId: "call-3",
      toolName: "mcp_ghostos_ghost_read",
      result: {
        status: "success",
        source: "mcp",
        server: "ghostos",
        tool: "ghost_read",
        content: hugeAxTree,
        text: hugeAxTree,
      },
      status: "success",
      state: "output-available",
    };

    const lookup = ephemeralLookup(["mcp_ghostos_ghost_read"]);
    const rewritten = stubEphemeralToolResults([big], lookup);

    const originalBytes = jsonBytes(big);
    const stubbedBytes = jsonBytes(rewritten[0]);

    expect(originalBytes).toBeGreaterThan(150_000);
    // Stub grew slightly when we added the retrieval outline (contentId +
    // top-level keys + ready-to-paste retrieveFullContent examples), but
    // we still expect >99% reduction and a hard ceiling well under 2.5KB.
    expect(stubbedBytes).toBeLessThan(2_500);
    expect(stubbedBytes / originalBytes).toBeLessThan(0.02);

    const stub = (rewritten[0] as DBToolResultPart).result as Record<string, unknown>;
    expect(stub[EPHEMERAL_STUB_MARKER]).toBe(true);
    expect(stub.mediaRefs).toBeUndefined(); // no media refs in a text-only payload
  });

  it("preserves error status and error message on ephemeral failures", () => {
    const failed: DBToolResultPart = {
      type: "tool-result",
      toolCallId: "call-err",
      toolName: "mcp_ghostos_ghost_screenshot",
      result: {
        status: "error",
        error: "Permission denied — screen recording not granted",
        source: "mcp",
        server: "ghostos",
        tool: "ghost_screenshot",
      },
      status: "error",
      state: "output-error",
    };

    const lookup = ephemeralLookup(["mcp_ghostos_ghost_screenshot"]);
    const rewritten = stubEphemeralToolResults([failed], lookup);
    const stub = (rewritten[0] as DBToolResultPart).result as Record<string, unknown>;

    expect(stub.status).toBe("error");
    expect(stub.error).toBe("Permission denied — screen recording not granted");
    expect(stub[EPHEMERAL_STUB_MARKER]).toBe(true);
    expect((rewritten[0] as DBToolResultPart).status).toBe("error");
    expect((rewritten[0] as DBToolResultPart).state).toBe("output-error");
  });

  it("is idempotent — rewriting an already-stubbed result is a no-op", () => {
    const lookup = ephemeralLookup(["mcp_ghostos_ghost_screenshot"]);
    const onceStubbed = stubEphemeralToolResults([makeGhostScreenshotResult()], lookup);
    const twiceStubbed = stubEphemeralToolResults(onceStubbed, lookup);
    expect(twiceStubbed).toEqual(onceStubbed);
  });

  it("handles a mixed DBContentPart[] with text + tool-calls + stubs intermixed", () => {
    const parts: DBContentPart[] = [
      { type: "text", text: "Let me take a screenshot." },
      { type: "tool-call", toolCallId: "call-1", toolName: "mcp_ghostos_ghost_screenshot", args: {} },
      makeGhostScreenshotResult(),
      { type: "text", text: "Okay, I see the current screen." },
      { type: "tool-call", toolCallId: "call-2", toolName: "localGrep", args: {} },
      makeLocalGrepResult(),
    ];

    const lookup = ephemeralLookup(["mcp_ghostos_ghost_screenshot"]);
    const rewritten = stubEphemeralToolResults(parts, lookup);

    // Length preserved, order preserved, non-tool-result parts unchanged
    expect(rewritten).toHaveLength(parts.length);
    expect(rewritten[0]).toEqual(parts[0]);
    expect(rewritten[1]).toEqual(parts[1]);
    expect(rewritten[3]).toEqual(parts[3]);
    expect(rewritten[4]).toEqual(parts[4]);
    expect(rewritten[5]).toEqual(parts[5]); // non-ephemeral tool-result untouched

    // Ephemeral tool-result rewritten
    const stub = (rewritten[2] as DBToolResultPart).result as Record<string, unknown>;
    expect(stub[EPHEMERAL_STUB_MARKER]).toBe(true);
  });

  it("drops the legacy `output` field when rewriting to a stub", () => {
    // Some legacy rows stored the result under `output` instead of `result`.
    const legacy: DBToolResultPart = {
      type: "tool-result",
      toolCallId: "call-legacy",
      toolName: "mcp_ghostos_ghost_screenshot",
      output: {
        status: "success",
        images: [{ url: "/api/media/session-1/generated/legacy.png" }],
      },
      status: "success",
      state: "output-available",
    };

    const lookup = ephemeralLookup(["mcp_ghostos_ghost_screenshot"]);
    const rewritten = stubEphemeralToolResults([legacy], lookup);
    const part = rewritten[0] as DBToolResultPart;

    expect(part.result).toBeDefined();
    const stub = part.result as Record<string, unknown>;
    expect(stub[EPHEMERAL_STUB_MARKER]).toBe(true);
    expect(part.output).toBeUndefined();
    // Media ref still captured from the legacy `output` field.
    expect(stub.mediaRefs).toEqual([{ url: "/api/media/session-1/generated/legacy.png" }]);
  });

  it("mints a retrievable contentId when sessionId is passed and payload is large enough", () => {
    // This is the bug fix: MCP tool returns a big JSON payload. The stub
    // must carry a trunc_XXX contentId so replay/retry turns can call
    // retrieveFullContent instead of guessing IDs like trunc_1.
    const hugeFigmaJson = JSON.stringify({
      id: "2001:1322",
      name: "Vision",
      type: "FRAME",
      children: Array.from({ length: 50 }, (_, i) => ({
        id: `2001:${1323 + i}`,
        name: `child-${i}`,
        nativeCSS: "width: 100px; height: 100px;".repeat(20),
      })),
    });
    const figmaResult: DBToolResultPart = {
      type: "tool-result",
      toolCallId: "call-figma",
      toolName: "mcp_sunnyside_figma_download_figma_images",
      result: {
        status: "success",
        source: "mcp",
        server: "sunnyside-figma",
        tool: "download_figma_images",
        text: hugeFigmaJson,
      },
      status: "success",
      state: "output-available",
    };

    const sessionId = `test-session-${Math.random().toString(36).slice(2)}`;
    const lookup = ephemeralLookup(["mcp_sunnyside_figma_download_figma_images"]);
    const rewritten = stubEphemeralToolResults([figmaResult], {
      sessionId,
      ephemeralLookup: lookup,
    });

    const stub = (rewritten[0] as DBToolResultPart).result as Record<string, unknown>;
    expect(stub[EPHEMERAL_STUB_MARKER]).toBe(true);
    expect(stub.truncated).toBe(true);
    expect(typeof stub.contentId).toBe("string");
    expect((stub.contentId as string).startsWith("trunc_")).toBe(true);
    expect(stub.truncatedContentId).toBe(stub.contentId);

    // Rich summary must include one obvious range retrieval example.
    const summary = stub.summary as string;
    expect(summary).toContain(`contentId=${stub.contentId}`);
    expect(summary).toContain("retrieveFullContent");
    expect(summary).toContain("range:");
    expect(summary).not.toContain("head:");
    expect(summary).not.toContain("tail:");
    expect(summary).not.toContain("grep:");

    // And it should actually be retrievable.
    const retrieved = retrieveFullContent(sessionId, stub.contentId as string);
    expect(retrieved).toBeTruthy();
    expect(retrieved!.fullContent).toBe(hugeFigmaJson);
  });

  it("does NOT mint a contentId when sessionId is omitted (backwards-compat)", () => {
    // Scripts and tests still call the legacy (parts, lookup) shape. The stub
    // should still strip large payloads but skip the retrieval handle.
    const hugeAxTree = "child node\n".repeat(10_000);
    const big: DBToolResultPart = {
      type: "tool-result",
      toolCallId: "call-nosession",
      toolName: "mcp_ghostos_ghost_read",
      result: {
        status: "success",
        content: hugeAxTree,
        text: hugeAxTree,
      },
      status: "success",
      state: "output-available",
    };

    const lookup = ephemeralLookup(["mcp_ghostos_ghost_read"]);
    const rewritten = stubEphemeralToolResults([big], lookup);
    const stub = (rewritten[0] as DBToolResultPart).result as Record<string, unknown>;
    expect(stub[EPHEMERAL_STUB_MARKER]).toBe(true);
    expect(stub.contentId).toBeUndefined();
    expect(stub.truncatedContentId).toBeUndefined();
    // But the rich outline is still produced so the model at least knows the
    // shape of the content.
    expect(typeof stub.summary).toBe("string");
    const summary = stub.summary as string;
    expect(summary.startsWith("[STUB:")).toBe(true);
  });

  it("skips content storage for tiny payloads (no retrieval value)", () => {
    // A 100-char payload doesn't need a retrieval handle — let the compact
    // summary stand alone.
    const tiny: DBToolResultPart = {
      type: "tool-result",
      toolCallId: "call-tiny",
      toolName: "mcp_ghostos_ghost_read",
      result: {
        status: "success",
        text: "short content",
      },
      status: "success",
      state: "output-available",
    };

    const lookup = ephemeralLookup(["mcp_ghostos_ghost_read"]);
    const rewritten = stubEphemeralToolResults([tiny], {
      sessionId: "any-session",
      ephemeralLookup: lookup,
    });
    const stub = (rewritten[0] as DBToolResultPart).result as Record<string, unknown>;
    expect(stub.contentId).toBeUndefined();
    expect(stub.truncatedContentId).toBeUndefined();
  });

  it("does not mint a contentId for error results (nothing useful to retrieve)", () => {
    const failed: DBToolResultPart = {
      type: "tool-result",
      toolCallId: "call-err-big",
      toolName: "mcp_ghostos_ghost_read",
      result: {
        status: "error",
        error: "Big descriptive error " + "x".repeat(2000),
      },
      status: "error",
      state: "output-error",
    };

    const lookup = ephemeralLookup(["mcp_ghostos_ghost_read"]);
    const rewritten = stubEphemeralToolResults([failed], {
      sessionId: "any-session",
      ephemeralLookup: lookup,
    });
    const stub = (rewritten[0] as DBToolResultPart).result as Record<string, unknown>;
    expect(stub.status).toBe("error");
    expect(stub.error).toContain("Big descriptive error");
    expect(stub.contentId).toBeUndefined();
  });

  it("ephemeral stubs do NOT trigger the canonical-invariant truncation counter", () => {
    // truncated + truncatedContentId on an ephemeral stub is LEGITIMATE at the
    // canonical layer — countCanonicalTruncationMarkers must skip them.
    const big: DBToolResultPart = {
      type: "tool-result",
      toolCallId: "call-inv",
      toolName: "mcp_ghostos_ghost_read",
      result: {
        status: "success",
        text: "big content ".repeat(200),
      },
      status: "success",
      state: "output-available",
    };
    const lookup = ephemeralLookup(["mcp_ghostos_ghost_read"]);
    const rewritten = stubEphemeralToolResults([big], {
      sessionId: "inv-session",
      ephemeralLookup: lookup,
    });
    // Stub should have both markers:
    const stub = (rewritten[0] as DBToolResultPart).result as Record<string, unknown>;
    expect(stub.truncated).toBe(true);
    expect(typeof stub.truncatedContentId).toBe("string");
    // But the counter must NOT flag it.
    expect(countCanonicalTruncationMarkers(rewritten)).toBe(0);
  });

  it("ignores random long strings in unrelated fields (no false-positive media refs)", () => {
    const chatty: DBToolResultPart = {
      type: "tool-result",
      toolCallId: "call-chatty",
      toolName: "mcp_ghostos_ghost_read",
      result: {
        status: "success",
        content: "This tool wrote a long description but no media URLs at all.",
        note: "example.com/not-a-media-url",
      },
      status: "success",
      state: "output-available",
    };

    const lookup = ephemeralLookup(["mcp_ghostos_ghost_read"]);
    const rewritten = stubEphemeralToolResults([chatty], lookup);
    const stub = (rewritten[0] as DBToolResultPart).result as Record<string, unknown>;

    // Neither field had a recognised /api/media/ or http(s):// URL-shaped object,
    // so nothing should surface as a media ref.
    expect(stub.mediaRefs).toBeUndefined();
  });
});
