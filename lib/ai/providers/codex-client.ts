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
function createSidecarFetch(): typeof fetch {
  return async (input, init) => {
    await ensureSidecarReady();
    await ensureCodexCredentialBridged();
    return globalThis.fetch(input, init);
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
