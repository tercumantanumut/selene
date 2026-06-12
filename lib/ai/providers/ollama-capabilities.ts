/**
 * Ollama Model Capability Detection
 *
 * Dynamically queries Ollama's `/api/show` endpoint to determine model
 * capabilities (thinking, tools, vision, etc.) instead of maintaining
 * hardcoded model lists.
 *
 * Ollama v0.9.0+ returns a `capabilities` array that includes "thinking"
 * for models that support chain-of-thought reasoning. When thinking is
 * supported, Ollama parses model-specific tags server-side (DeepSeek's
 * `<think>`, Qwen's `<think>`, Gemma4's `<|channel>thought`, etc.) and
 * returns structured `delta.reasoning` via the OpenAI-compatible endpoint.
 * The AI SDK natively handles `delta.reasoning` — no client-side middleware needed.
 */

import { loadSettings } from "@/lib/settings/settings-manager";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OllamaShowResponse {
  capabilities?: string[];
  model_info?: Record<string, unknown>;
  parameters?: string;
}

interface CachedContextWindow {
  contextWindow: number | null;
  timestamp: number;
}

interface CachedCapabilities {
  capabilities: string[];
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434";

/** Cache TTL: 10 minutes. Model capabilities don't change at runtime. */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** Negative cache TTL: 60 seconds. Avoids hammering a downed Ollama server. */
const NEGATIVE_CACHE_TTL_MS = 60 * 1000;

/** Timeout for the /api/show request. Keep short to avoid blocking chat. */
const SHOW_REQUEST_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// Cache & in-flight deduplication
// ---------------------------------------------------------------------------

const capabilityCache = new Map<string, CachedCapabilities>();
const contextWindowCache = new Map<string, CachedContextWindow>();

/**
 * In-flight request map to deduplicate concurrent calls for the same model.
 * If two callers request capabilities for "gemma4" simultaneously, the second
 * awaits the first's promise instead of firing a duplicate HTTP request.
 */
const inflightRequests = new Map<string, Promise<string[]>>();

/**
 * Get the Ollama base URL (without /v1 suffix).
 * The OpenAI-compat client uses /v1, but native API endpoints are at root.
 */
function getOllamaBaseUrl(): string {
  const settings = loadSettings();
  const url =
    settings.ollamaBaseUrl ||
    process.env.OLLAMA_BASE_URL ||
    OLLAMA_DEFAULT_BASE_URL;
  // Strip /v1 suffix if present — native API lives at root
  return url.replace(/\/v1\/?$/, "");
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Query Ollama for a model's capabilities.
 *
 * Uses the `/api/show` endpoint which returns model metadata including
 * a `capabilities` array (Ollama v0.9.0+).
 *
 * Results are cached per model name with a 10-minute TTL. Failures are
 * negatively cached for 60 seconds to avoid hammering a downed server.
 * Concurrent requests for the same model are deduplicated.
 *
 * @returns The capabilities array, or empty array on error/old Ollama version.
 */
export async function getOllamaModelCapabilities(
  modelId: string,
): Promise<string[]> {
  // Normalize to lowercase for case-insensitive cache lookups.
  const cacheKey = modelId.toLowerCase();

  // Check cache (covers both positive and negative entries)
  const cached = capabilityCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.capabilities;
  }

  // Deduplicate concurrent requests for the same model
  const inflight = inflightRequests.get(cacheKey);
  if (inflight) return inflight;

  const promise = fetchCapabilities(modelId, cacheKey);
  inflightRequests.set(cacheKey, promise);
  promise.finally(() => inflightRequests.delete(cacheKey));
  return promise;
}

/**
 * Internal: perform the actual /api/show fetch and cache the result.
 */
async function fetchCapabilities(
  modelId: string,
  cacheKey: string,
): Promise<string[]> {
  try {
    const baseUrl = getOllamaBaseUrl();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      SHOW_REQUEST_TIMEOUT_MS,
    );

    const response = await fetch(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(
        `[OLLAMA] /api/show failed for model=${modelId}: ${response.status} ${response.statusText}`,
      );
      cacheNegativeResult(cacheKey);
      return [];
    }

    const data = (await response.json()) as OllamaShowResponse;
    const capabilities = data.capabilities ?? [];

    // Cache the successful result
    capabilityCache.set(cacheKey, {
      capabilities,
      timestamp: Date.now(),
    });

    console.debug(
      `[OLLAMA] Model ${modelId} capabilities: [${capabilities.join(", ")}]`,
    );

    return capabilities;
  } catch (error) {
    // Network error, timeout, or old Ollama version — fail gracefully
    if (error instanceof Error && error.name === "AbortError") {
      console.warn(
        `[OLLAMA] /api/show timed out for model=${modelId}`,
      );
    } else {
      console.warn(
        `[OLLAMA] Failed to fetch capabilities for model=${modelId}:`,
        error instanceof Error ? error.message : error,
      );
    }
    // Negative cache: avoid retrying for NEGATIVE_CACHE_TTL_MS
    cacheNegativeResult(cacheKey);
    return [];
  }
}

/**
 * Cache a failure so we don't retry immediately. Uses a shorter TTL
 * than successful results so recovery is detected promptly.
 */
function cacheNegativeResult(cacheKey: string): void {
  capabilityCache.set(cacheKey, {
    capabilities: [],
    // Set timestamp so it expires after NEGATIVE_CACHE_TTL_MS, not CACHE_TTL_MS
    timestamp: Date.now() - CACHE_TTL_MS + NEGATIVE_CACHE_TTL_MS,
  });
}

/**
 * Check if an Ollama model supports native thinking (server-side tag parsing).
 *
 * When true, Ollama parses thinking tags internally and returns structured
 * `delta.reasoning` content — no client-side `<think>` middleware is needed.
 */
export async function ollamaModelSupportsThinking(
  modelId: string,
): Promise<boolean> {
  const capabilities = await getOllamaModelCapabilities(modelId);
  return capabilities.includes("thinking");
}

/**
 * Clear the capability cache and in-flight requests.
 * Useful when Ollama server changes or for testing.
 */
export function clearOllamaCapabilityCache(): void {
  capabilityCache.clear();
  contextWindowCache.clear();
  inflightRequests.clear();
}

// ---------------------------------------------------------------------------
// Context Window Detection
// ---------------------------------------------------------------------------

/**
 * Query Ollama for a model's context window size.
 *
 * Uses `/api/show` and inspects:
 * 1. `model_info` object for keys containing `context_length`
 * 2. `parameters` string for `num_ctx` value
 *
 * Results are cached alongside capabilities with the same TTL.
 *
 * @returns The context window size in tokens, or null if unknown.
 */
async function getOllamaModelContextWindow(
  modelId: string,
): Promise<number | null> {
  const cacheKey = modelId.toLowerCase();

  const cached = contextWindowCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.contextWindow;
  }

  try {
    const baseUrl = getOllamaBaseUrl();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      SHOW_REQUEST_TIMEOUT_MS,
    );

    const response = await fetch(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(
        `[OLLAMA] /api/show failed for context window, model=${modelId}: ${response.status}`,
      );
      cacheContextWindow(cacheKey, null, true);
      return null;
    }

    const data = (await response.json()) as OllamaShowResponse;
    let contextWindow: number | null = null;

    // Strategy 1: Check model_info for context_length keys
    if (data.model_info) {
      for (const [key, value] of Object.entries(data.model_info)) {
        if (
          key.toLowerCase().includes("context_length") &&
          typeof value === "number" &&
          value > 0
        ) {
          contextWindow = value;
          break;
        }
      }
    }

    // Strategy 2: Parse parameters string for num_ctx
    if (contextWindow === null && data.parameters) {
      const match = data.parameters.match(/num_ctx\s+(\d+)/);
      if (match) {
        contextWindow = parseInt(match[1], 10);
      }
    }

    cacheContextWindow(cacheKey, contextWindow, false);

    console.debug(
      `[OLLAMA] Model ${modelId} context window: ${contextWindow ?? "unknown"}`,
    );

    return contextWindow;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.warn(
        `[OLLAMA] /api/show timed out for context window, model=${modelId}`,
      );
    } else {
      console.warn(
        `[OLLAMA] Failed to fetch context window for model=${modelId}:`,
        error instanceof Error ? error.message : error,
      );
    }
    cacheContextWindow(cacheKey, null, true);
    return null;
  }
}

/**
 * Cache a context window result. Uses a shorter TTL for negative results.
 */
function cacheContextWindow(
  cacheKey: string,
  contextWindow: number | null,
  isNegative: boolean,
): void {
  contextWindowCache.set(cacheKey, {
    contextWindow,
    timestamp: isNegative
      ? Date.now() - CACHE_TTL_MS + NEGATIVE_CACHE_TTL_MS
      : Date.now(),
  });
}
