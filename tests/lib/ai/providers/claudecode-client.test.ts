import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createAnthropicMock,
  ensureDarioConfig,
  ensureDarioSidecarReady,
  getDarioBaseUrl,
} = vi.hoisted(() => ({
  createAnthropicMock: vi.fn(),
  ensureDarioConfig: vi.fn(() => ({
    dir: "/tmp/selene-dario",
    apiKey: "selene-dario-test-key",
    port: 8575,
    host: "localhost",
  })),
  ensureDarioSidecarReady: vi.fn(async () => ({
    port: 8575,
    apiKey: "selene-dario-test-key",
    baseUrl: "http://localhost:8575/v1",
  })),
  getDarioBaseUrl: vi.fn((port = 8575, host = "127.0.0.1") => `http://${host}:${port}/v1`),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: createAnthropicMock,
}));

vi.mock("@/lib/ai/providers/dario/config", () => ({
  ensureDarioConfig,
  getDarioBaseUrl,
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
  beforeEach(() => {
    invalidateClaudeCodeProvider();
    createAnthropicMock.mockReset();
    createAnthropicMock.mockImplementation(() => (modelId: string) => ({ modelId }));
    ensureDarioConfig.mockClear();
    ensureDarioSidecarReady.mockClear();
    getDarioBaseUrl.mockClear();
  });

  it("constructs a provider lazily and returns a LanguageModel per modelId", () => {
    const provider = createClaudeCodeProvider();
    expect(typeof provider).toBe("function");

    const model = provider("claude-opus-4-7");
    expect(model).toBeTruthy();
    expect((model as { modelId?: string }).modelId).toBe("claude-opus-4-7");
  });

  it("builds the Anthropic client with the configured Dario host", () => {
    createClaudeCodeProvider();

    expect(getDarioBaseUrl).toHaveBeenCalledWith(8575, "localhost");
    expect(createAnthropicMock).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "selene-dario-test-key",
      baseURL: "http://localhost:8575/v1",
    }));
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
    expect(createAnthropicMock).toHaveBeenCalledTimes(1);
  });

  it("invalidateClaudeCodeProvider clears the cache (next call rebuilds)", () => {
    createClaudeCodeProvider();
    invalidateClaudeCodeProvider();
    expect(() => createClaudeCodeProvider()).not.toThrow();
    expect(createAnthropicMock).toHaveBeenCalledTimes(2);
  });
});
