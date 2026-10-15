/**
 * Kimi (Moonshot) Client
 *
 * Lazy-initialized OpenAI-compatible client for the Moonshot Kimi API.
 * Supports dual auth: OAuth (via Kimi device flow) or API key (env vars).
 * OAuth is preferred when available and uses the Kimi coding endpoint.
 * Includes a custom fetch wrapper that sets Kimi's currently required
 * fixed generation parameters.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { KIMI_CONFIG } from "@/lib/auth/kimi-models";
import { isKimiOAuthAuthenticated, getKimiAccessToken, getKimiDeviceHeaders, KIMI_OAUTH_CONFIG } from "@/lib/auth/kimi-auth";
import { getAppUrl } from "./openrouter-client";

// ---- Configuration -----------------------------------------------------------

const KIMI_FIXED_TEMPERATURE = 0.6;
const KIMI_THINKING_TEMPERATURE = 1.0;
// K3 is always-thinking (max effort) upstream. Do not send
// `thinking: { type: "disabled" }`, which conflicts with that contract.
const KIMI_ALWAYS_THINKING_MODELS = new Set([
  "k3",
  "kimi-k2.7-code",
  "kimi-k2.7-code-highspeed",
]);
// Kimi's coding endpoint enforces temperature 1.0 for these always-thinking
// model families. K3 is included here based on the API error contract:
// "invalid temperature: only 1 is allowed for this model".
const KIMI_THINKING_TEMPERATURE_MODELS = new Set([
  "k3",
  "kimi-k2.7-code",
  "kimi-k2.7-code-highspeed",
]);

export function getKimiApiKey(): string | undefined {
  return process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKimiAlwaysThinkingModel(model: unknown): boolean {
  return typeof model === "string" && KIMI_ALWAYS_THINKING_MODELS.has(model.toLowerCase());
}

export function normalizeKimiChatCompletionBody(body: unknown): unknown {
  if (!isRecord(body)) {
    return body;
  }

  const normalized = { ...body };

  if (isKimiAlwaysThinkingModel(normalized.model)) {
    // Always-thinking models reject an explicit disabled-thinking request.
    delete normalized.thinking;
  } else {
    // Non-thinking mode: reasoning outputs should not persist in history.
    normalized.thinking = { type: "disabled" };
  }

  // Kimi's coding backend validates temperature per model family. Always-
  // thinking coding models require exactly 1.0.
  normalized.temperature = typeof normalized.model === "string" &&
    KIMI_THINKING_TEMPERATURE_MODELS.has(normalized.model.toLowerCase())
    ? KIMI_THINKING_TEMPERATURE
    : KIMI_FIXED_TEMPERATURE;
  normalized.top_p = 0.95;
  normalized.n = 1;
  normalized.presence_penalty = 0.0;
  normalized.frequency_penalty = 0.0;

  return normalized;
}

// ---- Custom fetch ------------------------------------------------------------

/**
 * Custom fetch wrapper for Kimi API.
 * Enforces required parameter values for Kimi's current OpenAI-compatible APIs.
 */
async function kimiCustomFetch(
  url: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

  // Inject device headers directly into every request when using OAuth.
  // SDK-level headers may not propagate User-Agent reliably through Node.js HTTP/2.
  if (isKimiOAuthAuthenticated()) {
    const deviceHeaders = getKimiDeviceHeaders();
    const existingHeaders = new Headers(init?.headers);
    for (const [key, value] of Object.entries(deviceHeaders)) {
      existingHeaders.set(key, value);
    }
    init = { ...init, headers: existingHeaders };
  }

  if (init?.body && typeof init.body === "string" && urlStr.includes("/chat/completions")) {
    try {
      init = { ...init, body: JSON.stringify(normalizeKimiChatCompletionBody(JSON.parse(init.body))) };
    } catch {
      // Not JSON, pass through unchanged
    }
  }
  return globalThis.fetch(url, init);
}

// ---- Lazy singleton ----------------------------------------------------------

let _kimiClient: ReturnType<typeof createOpenAICompatible> | null = null;
let _kimiClientApiKey: string | undefined = undefined;
let _kimiClientIsOAuth: boolean = false;
let _kimiClientBaseURL: string | undefined = undefined;

export function getKimiApiBaseUrl(modelId: string, isOAuth: boolean): string {
  // K3 is configured upstream on the Kimi Code endpoint for both OAuth and
  // API-key authentication. OAuth already uses this endpoint for all models.
  return isOAuth || modelId.toLowerCase() === "k3"
    ? KIMI_CONFIG.CODING_BASE_URL
    : KIMI_CONFIG.BASE_URL;
}

export function getKimiClient(modelId: string): ReturnType<typeof createOpenAICompatible> {
  const isOAuth = isKimiOAuthAuthenticated();
  const apiKey = isOAuth ? (getKimiAccessToken() ?? undefined) : getKimiApiKey();
  const baseURL = getKimiApiBaseUrl(modelId, isOAuth);
  const extraHeaders = isOAuth ? getKimiDeviceHeaders() : {};

  // Recreate client if authentication or the model's endpoint changed.
  if (_kimiClient && (
    _kimiClientApiKey !== apiKey ||
    _kimiClientIsOAuth !== isOAuth ||
    _kimiClientBaseURL !== baseURL
  )) {
    _kimiClient = null;
  }

  if (!_kimiClient) {
    _kimiClientApiKey = apiKey;
    _kimiClientIsOAuth = isOAuth;
    _kimiClientBaseURL = baseURL;
    _kimiClient = createOpenAICompatible({
      name: "kimi",
      baseURL,
      apiKey: apiKey || "",
      headers: {
        ...extraHeaders,
        "HTTP-Referer": getAppUrl(),
        "X-Title": "Selene Agent",
      },
      fetch: kimiCustomFetch,
    });
  }

  return _kimiClient;
}

export function invalidateKimiClient(): void {
  _kimiClient = null;
  _kimiClientApiKey = undefined;
  _kimiClientIsOAuth = false;
  _kimiClientBaseURL = undefined;
}
