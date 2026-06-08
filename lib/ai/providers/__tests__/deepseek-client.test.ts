import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateOpenAICompatible } = vi.hoisted(() => ({
  mockCreateOpenAICompatible: vi.fn(),
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: mockCreateOpenAICompatible,
}));

vi.mock("@/lib/ai/providers/openrouter-client", () => ({
  getAppUrl: vi.fn(() => "http://localhost:3000"),
}));

import {
  getDeepSeekApiKey,
  getDeepSeekClient,
  invalidateDeepSeekClient,
} from "@/lib/ai/providers/deepseek-client";
import {
  DEEPSEEK_CONFIG,
  DEEPSEEK_MODEL_IDS,
  getDeepSeekModels,
  deepseekModelSupportsToolChoice,
} from "@/lib/auth/deepseek-models";

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe("deepseek-client", () => {
  const FAKE_KEY = "ds-test-key-abc123";

  beforeEach(() => {
    vi.clearAllMocks();
    invalidateDeepSeekClient();
    setEnv("DEEPSEEK_API_KEY", undefined);
    mockCreateOpenAICompatible.mockReturnValue(vi.fn());
  });

  afterEach(() => {
    setEnv("DEEPSEEK_API_KEY", undefined);
    vi.unstubAllGlobals();
  });

  describe("getDeepSeekApiKey", () => {
    it("returns undefined when DEEPSEEK_API_KEY is not set", () => {
      expect(getDeepSeekApiKey()).toBeUndefined();
    });

    it("returns the API key from DEEPSEEK_API_KEY", () => {
      setEnv("DEEPSEEK_API_KEY", FAKE_KEY);
      expect(getDeepSeekApiKey()).toBe(FAKE_KEY);
    });
  });

  describe("getDeepSeekClient", () => {
    it("creates an OpenAI-compatible client with DeepSeek base URL", () => {
      setEnv("DEEPSEEK_API_KEY", FAKE_KEY);
      getDeepSeekClient();

      expect(mockCreateOpenAICompatible).toHaveBeenCalledOnce();
      const callArgs = mockCreateOpenAICompatible.mock.calls[0][0];
      expect(callArgs.baseURL).toBe(DEEPSEEK_CONFIG.BASE_URL);
      expect(callArgs.name).toBe("deepseek");
      expect(callArgs.apiKey).toBe(FAKE_KEY);
      expect(callArgs.headers).toEqual({
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "Selene Agent",
      });
    });

    it("reuses the cached client until API key changes", () => {
      setEnv("DEEPSEEK_API_KEY", FAKE_KEY);
      const client1 = getDeepSeekClient();
      const client2 = getDeepSeekClient();

      expect(client1).toBe(client2);
      expect(mockCreateOpenAICompatible).toHaveBeenCalledOnce();

      setEnv("DEEPSEEK_API_KEY", "ds-different-key");
      getDeepSeekClient();
      expect(mockCreateOpenAICompatible).toHaveBeenCalledTimes(2);
    });

    it("strips tool_choice for deepseek-v4-pro before forwarding the request", async () => {
      setEnv("DEEPSEEK_API_KEY", FAKE_KEY);
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      getDeepSeekClient();
      const callArgs = mockCreateOpenAICompatible.mock.calls[0][0];

      await callArgs.fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "deepseek-v4-pro",
          tool_choice: "required",
          tools: [{ type: "function", function: { name: "webSearch" } }],
        }),
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      const forwarded = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      expect(forwarded.tool_choice).toBeUndefined();
      expect(forwarded.toolChoice).toBeUndefined();
      expect(forwarded.thinking).toEqual({ type: "enabled" });
      expect(forwarded.reasoning_effort).toBe(DEEPSEEK_CONFIG.DEFAULT_REASONING_EFFORT);
      expect(forwarded.temperature).toBe(0.4);
    });

    it("preserves tool_choice for deepseek-v4-flash", async () => {
      setEnv("DEEPSEEK_API_KEY", FAKE_KEY);
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      getDeepSeekClient();
      const callArgs = mockCreateOpenAICompatible.mock.calls[0][0];

      await callArgs.fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "deepseek-v4-flash",
          tool_choice: "required",
          tools: [{ type: "function", function: { name: "webSearch" } }],
        }),
      });

      const forwarded = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      expect(forwarded.tool_choice).toBe("required");
      expect(forwarded.thinking).toEqual({ type: "disabled" });
    });
  });
});

describe("deepseek-models", () => {
  it("exports the expected DeepSeek model ids", () => {
    expect(DEEPSEEK_MODEL_IDS).toEqual([
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "deepseek-chat",
      "deepseek-reasoner",
    ]);
  });

  it("returns id/name pairs for all models", () => {
    expect(getDeepSeekModels()).toEqual([
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
      { id: "deepseek-chat", name: "DeepSeek Chat (legacy)" },
      { id: "deepseek-reasoner", name: "DeepSeek Reasoner (legacy)" },
    ]);
  });

  it("scopes tool_choice incompatibility to reasoning models only", () => {
    expect(deepseekModelSupportsToolChoice("deepseek-v4-pro")).toBe(false);
    expect(deepseekModelSupportsToolChoice("deepseek-reasoner")).toBe(false);
    expect(deepseekModelSupportsToolChoice("deepseek-v4-flash")).toBe(true);
    expect(deepseekModelSupportsToolChoice("deepseek-chat")).toBe(true);
  });
});
