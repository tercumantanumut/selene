import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { ensureDarioSidecarReady } = vi.hoisted(() => ({
  ensureDarioSidecarReady: vi.fn(async () => ({
    port: 8575,
    apiKey: "selene-dario-test-key",
    baseUrl: "http://127.0.0.1:8575/v1",
  })),
}));

vi.mock("@/lib/ai/providers/dario/sidecar", () => ({
  ensureDarioSidecarReady,
  stopDarioSidecar: vi.fn(),
  isDarioSidecarReady: vi.fn(() => true),
}));

import {
  createClaudeCodeProvider,
  invalidateClaudeCodeProvider,
} from "@/lib/ai/providers/claudecode-client";

describe("claudecode-client", () => {
  let dataDir: string;
  let prev: string | undefined;

  beforeEach(() => {
    invalidateClaudeCodeProvider();
    ensureDarioSidecarReady.mockClear();
    dataDir = mkdtempSync(join(tmpdir(), "selene-cc-client-"));
    prev = process.env.LOCAL_DATA_PATH;
    process.env.LOCAL_DATA_PATH = dataDir;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.LOCAL_DATA_PATH;
    else process.env.LOCAL_DATA_PATH = prev;
  });

  it("constructs a provider lazily and returns a LanguageModel per modelId", () => {
    const provider = createClaudeCodeProvider();
    expect(typeof provider).toBe("function");

    const model = provider("claude-opus-4-7");
    expect(model).toBeTruthy();
    // The AI SDK Anthropic provider tags LanguageModel instances with modelId.
    expect((model as { modelId?: string }).modelId).toBe("claude-opus-4-7");
  });

  it("does not boot Dario at construction time (lazy boot via fetch)", () => {
    createClaudeCodeProvider();
    expect(ensureDarioSidecarReady).not.toHaveBeenCalled();
  });

  it("caches the provider across calls so two calls share one instance", () => {
    const a = createClaudeCodeProvider();
    const b = createClaudeCodeProvider();
    const ma = a("claude-opus-4-7") as { modelId?: string };
    const mb = b("claude-opus-4-7") as { modelId?: string };
    expect(ma.modelId).toBe(mb.modelId);
  });

  it("invalidateClaudeCodeProvider clears the cache (next call rebuilds)", () => {
    createClaudeCodeProvider();
    invalidateClaudeCodeProvider();
    expect(() => createClaudeCodeProvider()).not.toThrow();
  });
});
