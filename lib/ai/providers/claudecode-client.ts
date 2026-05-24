/**
 * Claude Code provider — talks Anthropic Messages protocol over the
 * CLIProxyAPI sidecar.
 *
 * The sidecar is the OAuth-bearing process; this module is a thin
 * `createAnthropic` wrapper that points at `http://127.0.0.1:<port>/v1` and
 * lets the existing AI SDK plumbing (streaming, tool_use, caching headers)
 * handle the rest.
 *
 * Selene's subagent capture, plan-mode handling, MCP bridge, and plugin
 * hooks live in shared chat-layer code and apply uniformly across providers.
 * This file deliberately stays small.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import { ensureCliproxyConfig, getCliproxyBaseUrl } from "./cliproxy/config";
import { ensureSidecarReady } from "./cliproxy/sidecar";

type AnthropicProvider = ReturnType<typeof createAnthropic>;

let cached: AnthropicProvider | null = null;

/**
 * A `fetch` that ensures the sidecar is up before every request.
 *
 * When the sidecar is already healthy this is a single in-process check;
 * when it has died, the first request pays the spawn-and-poll cost.
 */
function createSidecarFetch(): typeof fetch {
  return async (input, init) => {
    await ensureSidecarReady();
    return globalThis.fetch(input, init);
  };
}

function buildProvider(): AnthropicProvider {
  const { apiKey, port } = ensureCliproxyConfig();
  return createAnthropic({
    apiKey,
    baseURL: getCliproxyBaseUrl(port),
    fetch: createSidecarFetch(),
  });
}

/**
 * Returns a function that resolves a Claude model id to a `LanguageModel`
 * compatible with `streamText`/`generateText`. The sidecar is *not* spawned
 * here — boot happens lazily on the first request via the custom fetch.
 */
export function createClaudeCodeProvider(): (modelId: string) => LanguageModel {
  if (!cached) cached = buildProvider();
  const provider = cached;
  return (modelId: string): LanguageModel => provider(modelId);
}

/** Drop the cached provider — call after auth state changes. */
export function invalidateClaudeCodeProvider(): void {
  cached = null;
}
