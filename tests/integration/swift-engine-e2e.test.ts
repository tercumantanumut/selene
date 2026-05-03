/**
 * Sprint 7 / W7.1.F — End-to-end smoke against the real selene-engine binary.
 *
 * This test closes the Phase 1 ship loop: it spawns the staged Swift engine
 * binary as an Electron sidecar, performs the MCP initialize handshake, and
 * exercises a small but representative slice of the real tool surface.
 * Every assertion below comes from a real round-trip — no mocks, no fakes,
 * no spawn stubs.
 *
 * Why this exists:
 *   - Unit tests in tests/lib/swift-engine/sidecar.test.ts cover the
 *     supervisor logic with a fake child_process.
 *   - That file ships a tiny "real binary" smoke (initialize handshake only)
 *     gated on SWIFT_ENGINE_INTEGRATION_TEST=1.
 *   - This file goes one step further and verifies the full integrated
 *     stack: SwiftEngineSidecarImpl  ->  JSON-RPC over stdio  ->  Swift
 *     CLI MCP server  ->  real MCP tools/list + tools/call dispatch.
 *
 * How to run locally:
 *
 *     # Make sure the binary is staged at
 *     #   binaries/selene-engine/darwin-arm64/selene-engine
 *     # (build-swift-engine.sh writes it there).
 *
 *     SELENE_E2E_SWIFT=1 \
 *       npx vitest run tests/integration/swift-engine-e2e.test.ts
 *
 * Without `SELENE_E2E_SWIFT=1`, the suite skips cleanly so CI without the
 * binary stays green.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SwiftEngineSidecarImpl } from "@/lib/swift-engine/sidecar";

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

/**
 * Repo-root-relative location of the staged binary. build-swift-engine.sh
 * writes the macOS arm64 binary here; electron-builder.yml ships it as a
 * resource. We resolve to a real filesystem path for `fs.existsSync()`.
 *
 * The binary itself is git-ignored — see .gitignore "binaries/" entry.
 */
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const STAGED_BINARY_PATH = path.join(
  REPO_ROOT,
  "binaries",
  "selene-engine",
  "darwin-arm64",
  "selene-engine",
);

const E2E_ENABLED =
  process.env.SELENE_E2E_SWIFT === "1" && fs.existsSync(STAGED_BINARY_PATH);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wrap sidecar.sendRequest with the MCP `tools/call` envelope. The Swift
 * server only dispatches tools when invoked through `tools/call` (raw
 * `engine.health` returns "Method not found") — confirmed via manual smoke
 * before writing this test.
 */
async function callTool(
  sidecar: SwiftEngineSidecarImpl,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{
  result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  error?: { code: number; message: string; data?: unknown };
}> {
  return sidecar.sendRequest<
    { name: string; arguments: Record<string, unknown> },
    { content?: Array<{ type: string; text?: string }>; isError?: boolean }
  >({
    method: "tools/call",
    params: { name, arguments: args },
  });
}

/**
 * MCP tool handlers wrap their JSON DTOs in a `content[0].text` string. This
 * helper unwraps that envelope — it's defensive against tools that return an
 * empty content array.
 */
function unwrapToolText(
  response: Awaited<ReturnType<typeof callTool>>,
): string | undefined {
  const content = response.result?.content;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  return content[0]?.text;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.runIf(E2E_ENABLED)("Swift engine end-to-end (W7.1.F)", () => {
  let sidecar: SwiftEngineSidecarImpl;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "selene-e2e-swift-"));
    sidecar = new SwiftEngineSidecarImpl();
    await sidecar.start({
      binaryPath: STAGED_BINARY_PATH,
      dataDir,
      autoRestart: false,
      startupTimeoutMs: 15_000,
      requestTimeoutMs: 15_000,
    });
  }, 30_000);

  afterAll(async () => {
    if (sidecar) {
      await sidecar.dispose();
    }
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it(
    "completes initialize handshake",
    () => {
      expect(sidecar.isReady()).toBe(true);
      const health = sidecar.health();
      expect(health.state).toBe("ready");
      expect(typeof health.pid).toBe("number");
      expect(health.pid as number).toBeGreaterThan(0);
    },
    30_000,
  );

  it(
    "calls engine.health and returns structured health",
    async () => {
      const response = await callTool(sidecar, "engine.health", {});
      // Successful tool call: error envelope is absent, content array present.
      expect(response.error).toBeUndefined();
      expect(response.result?.isError).not.toBe(true);

      const text = unwrapToolText(response);
      expect(typeof text).toBe("string");
      // The Swift handler returns EngineHealthResponse as a JSON-encoded string
      // inside content[0].text. Parse and assert the documented shape:
      //   { status: "ok", version?: string, tools: number, ... }
      const parsed = JSON.parse(text!) as Record<string, unknown>;
      expect(parsed).toMatchObject({ status: "ok" });
      expect(typeof parsed.tools === "number" || typeof parsed.tools === "string")
        .toBe(true);
    },
    30_000,
  );

  it(
    "calls index.status and returns a structured response",
    async () => {
      // index.status validates that at least one of {characterId, folderId}
      // is provided. We pass a sentinel characterId that won't have any
      // indexed folders so the engine returns an empty manifest list.
      const response = await callTool(sidecar, "index.status", {
        characterId: "e2e-w7-1-f",
      });

      // Either path is acceptable: a successful tool result with content,
      // OR a typed error envelope. Both prove the round-trip works.
      if (response.error) {
        // Transport-level error — must at minimum have a numeric code.
        expect(typeof response.error.code).toBe("number");
        expect(typeof response.error.message).toBe("string");
      } else {
        const text = unwrapToolText(response);
        expect(typeof text).toBe("string");
        const parsed = JSON.parse(text!) as Record<string, unknown>;
        // Real Swift response shape: { folders: [...] } when no manifests.
        expect(parsed).toBeDefined();
        if ("folders" in parsed) {
          expect(Array.isArray(parsed.folders)).toBe(true);
        }
      }

      // Sidecar must remain healthy regardless of which branch we took.
      expect(sidecar.isReady()).toBe(true);
    },
    30_000,
  );

  it(
    "calls vector.embed with a tiny input and returns a structured response",
    async () => {
      // vector.embed will succeed if an embedding provider is reachable, or
      // surface a typed `isError: true` envelope (e.g. provider HTTP 401)
      // when no API key is configured. Either case is acceptable here —
      // we're testing the round-trip plumbing, not the provider integration.
      const response = await callTool(sidecar, "vector.embed", {
        texts: ["hello world"],
      });

      // Whichever path we take, the wire response must be structured.
      const hasResult = response.result !== undefined;
      const hasError = response.error !== undefined;
      expect(hasResult || hasError).toBe(true);

      if (hasError) {
        expect(typeof response.error!.code).toBe("number");
        expect(typeof response.error!.message).toBe("string");
      } else if (response.result?.isError) {
        // Typed tool-error envelope: content[0].text describes what failed.
        const text = unwrapToolText(response);
        expect(typeof text).toBe("string");
        expect(text!.length).toBeGreaterThan(0);
      } else {
        // Success path: content[0].text is the JSON-encoded VectorEmbedResult.
        const text = unwrapToolText(response);
        expect(typeof text).toBe("string");
        const parsed = JSON.parse(text!) as Record<string, unknown>;
        expect(Array.isArray(parsed.vectors)).toBe(true);
        expect((parsed.vectors as unknown[]).length).toBeGreaterThan(0);
      }

      expect(sidecar.isReady()).toBe(true);
    },
    30_000,
  );

  it(
    "survives a sequence of 10 concurrent engine.health calls",
    async () => {
      const calls = Array.from({ length: 10 }, () =>
        callTool(sidecar, "engine.health", {}),
      );
      const results = await Promise.all(calls);

      expect(results).toHaveLength(10);
      for (const r of results) {
        expect(r.error).toBeUndefined();
        expect(r.result?.isError).not.toBe(true);
        const text = unwrapToolText(r);
        expect(typeof text).toBe("string");
        // Every payload should round-trip as JSON with status === "ok".
        const parsed = JSON.parse(text!) as Record<string, unknown>;
        expect(parsed.status).toBe("ok");
      }
      expect(sidecar.isReady()).toBe(true);
    },
    30_000,
  );

  it(
    "returns a structured error envelope for an unknown tool",
    async () => {
      const response = await callTool(sidecar, "nonexistent.tool.zzz", {});

      // The Swift handler signals unknown tools via JSON-RPC error code
      // -32000 with message "Tool handler missing: ..." — a structured
      // error, never a process crash.
      expect(response.error).toBeDefined();
      expect(typeof response.error!.code).toBe("number");
      expect(response.error!.code).toBeLessThan(0);
      expect(typeof response.error!.message).toBe("string");

      // Critically: the sidecar must stay ready. A bogus tool name must
      // never tear down the supervisor.
      expect(sidecar.isReady()).toBe(true);
    },
    30_000,
  );
});
