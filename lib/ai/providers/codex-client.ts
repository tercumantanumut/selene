/**
 * Codex provider — talks to OpenAI's Codex backend through the local
 * CLIProxyAPI sidecar instead of going to chatgpt.com directly.
 *
 * The sidecar:
 *  - owns the OAuth bearer (Codex CLI client `app_EMoamEEZ73f0CkXaXp7hrann`)
 *  - injects ChatGPT-Account-ID / originator / User-Agent headers
 *  - chooses transport (HTTP SSE today; WS internally if/when it adds it)
 *  - handles inactivity timeouts, retries, account rotation, quota cooldown
 *
 * Selene only needs an `@ai-sdk/openai` client pointed at
 * `http://127.0.0.1:<sidecar>/v1`. The AI SDK chooses chat-completions vs.
 * the Responses API based on model id; both are routed by the sidecar.
 *
 * Subagent capture, plan hooks, plugin hooks, and tool execution all live
 * in selene's shared chat layer and apply to every provider uniformly —
 * nothing Codex-specific lives here.
 */

import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { transformCodexRequest } from "@/lib/auth/codex-request";
import { convertSseToJson, ensureContentType } from "@/lib/auth/codex-response";
import { ensureCliproxyConfig, getCliproxyBaseUrl } from "./cliproxy/config";
import { ensureSidecarReady } from "./cliproxy/sidecar";
import { ensureCodexCredentialBridged } from "./cliproxy/codex-bridge";

type OpenAIProvider = ReturnType<typeof createOpenAI>;

let cached: OpenAIProvider | null = null;

/**
 * A `fetch` that, before every request, makes sure the sidecar is up AND
 * selene's current Codex OAuth token is materialised in the sidecar's
 * auth-dir. Both calls are cheap when nothing has changed (an in-process
 * health check + a no-op fs compare).
 */
function isCodexResponsesRequest(input: RequestInfo | URL): boolean {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  return new URL(url).pathname.endsWith("/responses");
}

async function readRequestBody(input: RequestInfo | URL, init?: RequestInit): Promise<string | null> {
  if (typeof init?.body === "string") return init.body;
  if (input instanceof Request) return input.clone().text();
  return null;
}

function withJsonBody(input: RequestInfo | URL, init: RequestInit | undefined, body: string): [RequestInfo | URL, RequestInit | undefined] {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set("content-type", "application/json");
  headers.delete("content-length");

  if (input instanceof Request && !init) {
    return [
      new Request(input.url, {
        method: input.method,
        headers,
        body,
        signal: input.signal,
      }),
      undefined,
    ];
  }

  return [
    input,
    {
      ...init,
      headers,
      body,
    },
  ];
}

interface CodexFetchInputTransform {
  input: RequestInfo | URL;
  init: RequestInit | undefined;
  isResponsesRequest: boolean;
  expectsStreamResponse: boolean;
}

function requestSignal(input: RequestInfo | URL, init?: RequestInit): AbortSignal | undefined {
  return init?.signal ?? (input instanceof Request ? input.signal : undefined);
}

function isEventStreamContentType(contentType: string | null): boolean {
  return contentType?.toLowerCase().includes("text/event-stream") === true;
}

function looksLikeSse(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("event:") || trimmed.startsWith("data:");
}

async function normalizeNonStreamingCodexResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<Response> {
  if (!response.body) return response;

  const headers = ensureContentType(response.headers);
  if (isEventStreamContentType(response.headers.get("content-type"))) {
    return convertSseToJson(response, headers, signal);
  }

  // Some sidecar/proxy paths have historically returned SSE with a missing or
  // misleading content-type. Non-streaming AI SDK callers need a JSON Responses
  // API object, so sniff a clone and convert only when the body is actually SSE.
  let text: string;
  try {
    text = await response.clone().text();
  } catch {
    return response;
  }

  if (!looksLikeSse(text)) return response;

  const sseResponse = new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  return convertSseToJson(sseResponse, headers, signal);
}

async function transformCodexFetchInput(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<CodexFetchInputTransform> {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== "POST" || !isCodexResponsesRequest(input)) {
    return { input, init, isResponsesRequest: false, expectsStreamResponse: false };
  }

  const rawBody = await readRequestBody(input, init);
  if (!rawBody) return { input, init, isResponsesRequest: true, expectsStreamResponse: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { input, init, isResponsesRequest: true, expectsStreamResponse: false };
  }

  if (!parsed || typeof parsed !== "object" || !("model" in parsed)) {
    return { input, init, isResponsesRequest: true, expectsStreamResponse: false };
  }

  const expectsStreamResponse = (parsed as Record<string, any>).stream === true;
  const transformed = await transformCodexRequest(parsed as Record<string, any>, "");
  const [transformedInput, transformedInit] = withJsonBody(input, init, JSON.stringify(transformed));
  return {
    input: transformedInput,
    init: transformedInit,
    isResponsesRequest: true,
    expectsStreamResponse,
  };
}

function createSidecarFetch(): typeof fetch {
  return async (input, init) => {
    await ensureSidecarReady();
    await ensureCodexCredentialBridged();
    const transformed = await transformCodexFetchInput(input, init);
    const response = await globalThis.fetch(transformed.input, transformed.init);
    if (transformed.isResponsesRequest && !transformed.expectsStreamResponse) {
      return normalizeNonStreamingCodexResponse(response, requestSignal(transformed.input, transformed.init));
    }
    return response;
  };
}

function buildProvider(): OpenAIProvider {
  const { apiKey, port } = ensureCliproxyConfig();
  return createOpenAI({
    name: "codex",
    apiKey,
    baseURL: getCliproxyBaseUrl(port),
    fetch: createSidecarFetch(),
  });
}

/**
 * Returns a function that resolves a Codex model id to a `LanguageModel`
 * compatible with `streamText` / `generateText`. The sidecar is *not*
 * spawned here — boot happens lazily on the first request via the custom
 * fetch.
 */
export function createCodexProvider(): (modelId: string) => LanguageModel {
  if (!cached) cached = buildProvider();
  const provider = cached;
  return (modelId: string): LanguageModel => provider(modelId);
}

/** Drop the cached provider — call after auth state changes. */
export function invalidateCodexProvider(): void {
  cached = null;
}
