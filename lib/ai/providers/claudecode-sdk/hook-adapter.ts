/**
 * SDK Hook Adapter
 *
 * Bridges Selene's subprocess-based plugin hooks into Claude Agent SDK-native
 * TypeScript callbacks. The SDK expects `Partial<Record<HookEvent, HookCallbackMatcher[]>>`
 * where each callback is an async function — this adapter wraps the existing
 * Selene hook pipeline (which spawns subprocesses with JSON stdin/stdout) into
 * that shape.
 *
 * PreToolUse hooks can block tool execution by returning a deny decision.
 * PostToolUse hooks are fire-and-forget.
 *
 * Stop hooks are NOT registered here — they are dispatched by the shared
 * onFinish/catch callbacks in stream-callbacks.ts and route.ts, which cover
 * all providers uniformly. Registering Stop here too would double-fire for
 * Agent SDK runs.
 */

import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
} from "@anthropic-ai/claude-agent-sdk";
import { runPreToolUseHooks, runPostToolUseHooks } from "@/lib/plugins/hook-integration";
import { getRegisteredHooks } from "@/lib/plugins/hooks-engine";

/**
 * Build SDK-compatible hook callbacks from Selene's registered plugin hooks.
 *
 * Only creates hook entries for events that actually have registered handlers,
 * so the SDK doesn't invoke empty callbacks on every tool call.
 */
export function buildSdkHooksFromSelene(
  sessionId: string,
  allowedPluginNames: Set<string>,
  pluginRoots: Map<string, string>,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};

  // ── PreToolUse → can block tool execution ─────────────────────────────────
  if (getRegisteredHooks("PreToolUse").length > 0) {
    const preToolUseHook: HookCallback = async (input) => {
      const toolName = (input as Record<string, unknown>).tool_name as string ?? "unknown";
      const toolInput = (input as Record<string, unknown>).tool_input as Record<string, unknown> ?? {};

      const result = await runPreToolUseHooks(
        toolName,
        toolInput,
        sessionId,
        allowedPluginNames,
        pluginRoots,
      );

      if (result.blocked) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: result.blockReason ?? "Blocked by Selene plugin hook",
          },
        };
      }
      return {};
    };
    hooks.PreToolUse = [{ hooks: [preToolUseHook] }];
  }

  // ── PostToolUse → fire-and-forget logging ─────────────────────────────────
  if (getRegisteredHooks("PostToolUse").length > 0) {
    const postToolUseHook: HookCallback = async (input) => {
      const rec = input as Record<string, unknown>;
      runPostToolUseHooks(
        (rec.tool_name as string) ?? "unknown",
        (rec.tool_input as Record<string, unknown>) ?? {},
        rec.tool_result ?? rec.tool_response ?? null,
        sessionId,
        allowedPluginNames,
        pluginRoots,
      );
      return {};
    };
    hooks.PostToolUse = [{ hooks: [postToolUseHook] }];
  }

  // Stop hooks are intentionally omitted — see module doc comment.

  return hooks;
}

/**
 * Merge two SDK hook maps. Selene hooks run first, then any explicitly
 * provided SDK hooks. Returns undefined if both inputs are empty/undefined.
 */
export function mergeHooks(
  a?: Partial<Record<HookEvent, HookCallbackMatcher[]>>,
  b?: Partial<Record<HookEvent, HookCallbackMatcher[]>>,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined {
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;

  const merged: Partial<Record<HookEvent, HookCallbackMatcher[]>> = { ...a };
  for (const [event, matchers] of Object.entries(b)) {
    const key = event as HookEvent;
    merged[key] = [...(merged[key] ?? []), ...matchers];
  }
  return merged;
}
