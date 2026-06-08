import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractContent } from "@/app/api/chat/content-extractor";

/**
 * Locks in the @-mention v2 backend contract:
 * - `metadata.custom.vectorMentions` survives the structured-content gate
 * - "chunk" mentions inject the snippet text verbatim
 * - "file" mentions inject the on-disk file content
 * - Per-message total budget caps overflow into a summary marker
 */

describe("extractContent — vector mentions injection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "vmention-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("injects chunk snippet text as a [Vector chunk: …] marker", async () => {
    const result = await extractContent({
      role: "user",
      content: "explain this",
      metadata: {
        custom: {
          vectorMentions: [
            {
              kind: "chunk",
              relativePath: "lib/foo/bar.ts",
              filePath: "/abs/lib/foo/bar.ts",
              snippet: {
                text: "export const answer = 42;",
                startLine: 10,
                endLine: 12,
                score: 0.85,
                chunkIndex: 3,
              },
            },
          ],
        },
      },
    });

    expect(Array.isArray(result)).toBe(true);
    const parts = result as Array<{ type: string; text?: string }>;
    const vectorPart = parts.find((p) => p.type === "text" && p.text?.startsWith("[Vector chunk:"));
    expect(vectorPart).toBeDefined();
    expect(vectorPart!.text).toContain("[Vector chunk: lib/foo/bar.ts:L10-12]");
    expect(vectorPart!.text).toContain("export const answer = 42;");
  });

  it("injects full file content for kind='file' mentions", async () => {
    const filePath = path.join(tmpDir, "small.txt");
    writeFileSync(filePath, "hello from disk\nline two");

    const result = await extractContent({
      role: "user",
      content: "read this",
      metadata: {
        custom: {
          vectorMentions: [
            {
              kind: "file",
              relativePath: "small.txt",
              filePath,
            },
          ],
        },
      },
    });

    const parts = result as Array<{ type: string; text?: string }>;
    const vectorPart = parts.find((p) => p.type === "text" && p.text?.startsWith("[Vector file:"));
    expect(vectorPart).toBeDefined();
    expect(vectorPart!.text).toContain("[Vector file: small.txt]");
    expect(vectorPart!.text).toContain("hello from disk");
    expect(vectorPart!.text).toContain("line two");
  });

  it("preserves the user prompt text alongside injected mentions", async () => {
    const result = await extractContent({
      role: "user",
      content: "what does this do?",
      metadata: {
        custom: {
          vectorMentions: [
            {
              kind: "chunk",
              relativePath: "x.ts",
              filePath: "/abs/x.ts",
              snippet: { text: "function noop() {}" },
            },
          ],
        },
      },
    });

    const parts = result as Array<{ type: string; text?: string }>;
    const promptPart = parts.find((p) => p.type === "text" && p.text === "what does this do?");
    const mentionPart = parts.find((p) => p.type === "text" && p.text?.startsWith("[Vector chunk:"));
    expect(promptPart).toBeDefined();
    expect(mentionPart).toBeDefined();
  });

  it("falls back to snippet text when a file mention's filePath cannot be read", async () => {
    const result = await extractContent({
      role: "user",
      content: "use this",
      metadata: {
        custom: {
          vectorMentions: [
            {
              kind: "file",
              relativePath: "missing.ts",
              filePath: "/this/path/does/not/exist/missing.ts",
              snippet: { text: "const fallback = true;" },
            },
          ],
        },
      },
    });

    const parts = result as Array<{ type: string; text?: string }>;
    const vectorPart = parts.find((p) => p.type === "text" && p.text?.startsWith("[Vector file:"));
    expect(vectorPart).toBeDefined();
    expect(vectorPart!.text).toContain("const fallback = true;");
  });

  it("emits a 'mentions skipped' marker when total budget is exceeded", async () => {
    // 70 chunks × ~1k chars each blows past MAX_VECTOR_MENTION_TOTAL_CHARS (60k).
    const big = "x".repeat(1_000);
    const mentions = Array.from({ length: 70 }, (_, i) => ({
      kind: "chunk" as const,
      relativePath: `f${i}.ts`,
      filePath: `/abs/f${i}.ts`,
      snippet: { text: big, startLine: i * 10, endLine: i * 10 + 5 },
    }));

    const result = await extractContent({
      role: "user",
      content: "summarize all",
      metadata: { custom: { vectorMentions: mentions } },
    });

    const parts = result as Array<{ type: string; text?: string }>;
    const skipMarker = parts.find(
      (p) => p.type === "text" && p.text?.startsWith("[Vector mentions skipped"),
    );
    expect(skipMarker).toBeDefined();
    expect(skipMarker!.text).toMatch(/f\d+\.ts/);
  });

  it("does nothing when vectorMentions is empty/undefined", async () => {
    const result = await extractContent({
      role: "user",
      content: "hello",
      metadata: { custom: {} },
    });
    // Plain string return path — no structured parts triggered.
    expect(result).toBe("hello");
  });
});
