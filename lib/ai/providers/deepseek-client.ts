/**
 * DeepSeek Client
 *
 * Lazy-initialized OpenAI-compatible client for the DeepSeek API.
 * Uses the OpenAI format endpoint at https://api.deepseek.com.
 *
 * Features:
 * - Thinking mode routing based on model: V4 Pro + legacy reasoner enable
 *   thinking with `reasoning_effort: "high"`; V4 Flash + legacy chat disable
 *   thinking for deterministic / fast responses.
 * - Prompt caching is enabled automatically on disk for overlapping prefixes.
 * - Supports tool calls, JSON output, and streaming.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  DEEPSEEK_CONFIG,
  deepseekModelHasThinkingEnabled,
  deepseekModelHasThinkingDisabled,
  deepseekModelSupportsToolChoice,
} from "@/lib/auth/deepseek-models";
import { getAppUrl } from "./openrouter-client";

// ---- Configuration -----------------------------------------------------------

export function getDeepSeekApiKey(): string | undefined {
  return process.env.DEEPSEEK_API_KEY;
}

// ---- Custom fetch ------------------------------------------------------------

/**
 * Custom fetch wrapper for DeepSeek API.
 * Injects thinking-mode configuration based on the requested model.
 */
async function deepseekCustomFetch(
  url: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const urlStr =
    typeof url === "string"
      ? url
      : url instanceof URL
      ? url.toString()
      : url.url;

  if (
    init?.body &&
    typeof init.body === "string" &&
    urlStr.includes("/chat/completions")
  ) {
    try {
      const body = JSON.parse(init.body);
      const modelId = typeof body.model === "string" ? body.model : "";

      if (!deepseekModelSupportsToolChoice(modelId)) {
        delete body.tool_choice;
        delete body.toolChoice;
      }

      if (deepseekModelHasThinkingEnabled(modelId)) {
        // Thinking-enabled models: surface reasoning with high effort budget.
        body.thinking = { type: "enabled" };
        body.reasoning_effort = DEEPSEEK_CONFIG.DEFAULT_REASONING_EFFORT;
      } else if (deepseekModelHasThinkingDisabled(modelId)) {
        // Explicitly disable thinking for fast / deterministic responses.
        body.thinking = { type: "disabled" };
      }

      // Use a slightly lower temperature when tools are present for more
      // deterministic tool-selection behavior.
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      if (typeof body.temperature !== "number") {
        body.temperature = hasTools ? 0.4 : DEEPSEEK_CONFIG.DEFAULT_TEMPERATURE;
      }

      init = { ...init, body: JSON.stringify(body) };
    } catch {
      // Not JSON — pass through unchanged.
    }
  }

  return globalThis.fetch(url, init);
}

// ---- Lazy singleton ----------------------------------------------------------

let _deepseekClient: ReturnType<typeof createOpenAICompatible> | null = null;
let _deepseekClientApiKey: string | undefined = undefined;

export function getDeepSeekClient(): ReturnType<typeof createOpenAICompatible> {
  const apiKey = getDeepSeekApiKey();

  // Recreate client if API key changed
  if (_deepseekClient && _deepseekClientApiKey !== apiKey) {
    _deepseekClient = null;
  }

  if (!_deepseekClient) {
    _deepseekClientApiKey = apiKey;
    _deepseekClient = createOpenAICompatible({
      name: "deepseek",
      baseURL: DEEPSEEK_CONFIG.BASE_URL,
      apiKey: apiKey || "",
      headers: {
        "HTTP-Referer": getAppUrl(),
        "X-Title": "Selene Agent",
      },
      fetch: deepseekCustomFetch,
    });
  }

  return _deepseekClient;
}

export function invalidateDeepSeekClient(): void {
  _deepseekClient = null;
  _deepseekClientApiKey = undefined;
}
