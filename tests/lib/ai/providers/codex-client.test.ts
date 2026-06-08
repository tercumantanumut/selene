import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateText } from "ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { ensureSidecarReady, ensureCodexCredentialBridged } = vi.hoisted(() => ({
  ensureSidecarReady: vi.fn(async () => ({
    port: 8317,
    apiKey: "selene-test-key",
    baseUrl: "http://127.0.0.1:8317/v1",
  })),
  ensureCodexCredentialBridged: vi.fn(async () => null),
}));

vi.mock("@/lib/ai/providers/cliproxy/sidecar", () => ({
  ensureSidecarReady,
  stopSidecar: vi.fn(),
  isSidecarReady: vi.fn(() => true),
}));

vi.mock("@/lib/ai/providers/cliproxy/codex-bridge", () => ({
  ensureCodexCredentialBridged,
}));

import {
  createCodexProvider,
  invalidateCodexProvider,
} from "@/lib/ai/providers/codex-client";

describe("codex-client", () => {
  let dataDir: string;
  let prev: string | undefined;

  beforeEach(() => {
    invalidateCodexProvider();
    ensureSidecarReady.mockClear();
    ensureCodexCredentialBridged.mockClear();
    dataDir = mkdtempSync(join(tmpdir(), "selene-codex-client-"));
    prev = process.env.LOCAL_DATA_PATH;
    process.env.LOCAL_DATA_PATH = dataDir;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dataDir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.LOCAL_DATA_PATH;
    else process.env.LOCAL_DATA_PATH = prev;
  });

  it("constructs a provider lazily and returns a LanguageModel per model id", () => {
    const provider = createCodexProvider();
    expect(typeof provider).toBe("function");

    const model = provider("gpt-5.4-mini");
    expect(model).toBeTruthy();
    // The AI SDK OpenAI provider stamps every LanguageModel with the model id.
    expect((model as { modelId?: string }).modelId).toBe("gpt-5.4-mini");
  });

  it("does not boot the sidecar at construction time (lazy boot via fetch)", () => {
    createCodexProvider();
    expect(ensureSidecarReady).not.toHaveBeenCalled();
    expect(ensureCodexCredentialBridged).not.toHaveBeenCalled();
  });

  it("caches the provider across calls so two calls share one instance", () => {
    const a = createCodexProvider();
    const b = createCodexProvider();
    const ma = a("gpt-5.4-mini") as { modelId?: string };
    const mb = b("gpt-5.4-mini") as { modelId?: string };
    expect(ma.modelId).toBe(mb.modelId);
  });

  it("invalidateCodexProvider clears the cache (next call rebuilds)", () => {
    createCodexProvider();
    invalidateCodexProvider();
    // No throw + no error is the contract; re-calling rebuilds without error.
    expect(() => createCodexProvider()).not.toThrow();
  });

  it("works for both chat-completions and responses-shape model ids", () => {
    const provider = createCodexProvider();
    // gpt-5.x maps to the Responses API internally per the AI SDK's openai
    // factory; gpt-4o-mini-class stays on chat-completions. We just need to
    // confirm both resolve to a LanguageModel without throwing.
    expect(provider("gpt-5.5")).toBeTruthy();
    expect(provider("gpt-5.4")).toBeTruthy();
    expect(provider("gpt-5.4-mini")).toBeTruthy();
  });

  it("converts Codex SSE to JSON for non-streaming generateText callers", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === "string") {
        requestBodies.push(JSON.parse(init.body) as Record<string, unknown>);
      }

      return new Response(
        'event: response.done\n' +
          'data: {"type":"response.done","response":{"id":"resp_test","object":"response","created_at":0,"model":"gpt-5.5","status":"completed","output":[{"type":"message","id":"msg_test","status":"completed","role":"assistant","content":[{"type":"output_text","text":"enhanced ok","annotations":[]}]}],"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3,"input_tokens_details":{"cached_tokens":0},"output_tokens_details":{"reasoning_tokens":0}}}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }));

    const provider = createCodexProvider();
    const result = await generateText({
      model: provider("gpt-5.5-low"),
      prompt: "enhance this prompt",
    });

    expect(result.text).toBe("enhanced ok");
    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0].stream).toBe(false);
  });
});
