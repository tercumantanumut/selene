/**
 * Regression test for the Codex `functions.tool` phantom-tool bug.
 *
 * Root cause:
 *   The Vercel AI SDK's openai provider defaults `providerOptions.openai.store`
 *   to `true`. When `store` is true and an assistant tool-call part carries
 *   `providerMetadata.openai.itemId` (set automatically from a prior turn's
 *   Responses-API response), the SDK serializes that part as
 *   `{ type: "item_reference", id }` instead of a full
 *   `{ type: "function_call", name, arguments, ... }` item.
 *
 *   Codex CLI sessions never persist these item ids server-side, so the
 *   Codex pipeline strips `item_reference` items in `filterCodexInput`. The
 *   matching `function_call_output` survives at the top level without its
 *   originating call, becomes an orphan, and the old code synthesized a
 *   stand-in call with the literal name `"tool"` — which Codex then reported
 *   as a missing `functions.tool`, wasting reasoning cycles.
 *
 * Fix:
 *   In `app/api/chat/route.ts`, when `provider === "codex"`, pass
 *   `providerOptions: { openai: { store: false } }` to `streamText`. The
 *   `name: "codex"` provider value still maps to the `openai` namespace inside
 *   `@ai-sdk/openai` (see node_modules/@ai-sdk/openai/dist/index.mjs line ~4753
 *   `providerOptionsName = "openai"`), so this setting is honored.
 *
 * This test pins the wiring so it cannot be silently removed.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Codex provider: store=false provider option wiring", () => {
  it("route.ts forwards providerOptions.openai.store=false for Codex", () => {
    const routePath = resolve(process.cwd(), "app/api/chat/route.ts");
    const source = readFileSync(routePath, "utf8");

    // The streamText call must include the Codex-guarded providerOptions block.
    // We assert two invariants:
    //   (a) the configuration literal exists,
    //   (b) it is gated by a `provider === "codex"` check (not a wildcard).
    expect(source).toMatch(/providerOptions:\s*\{\s*openai:\s*\{\s*store:\s*false\s*\}\s*\}/);
    expect(source).toMatch(/provider\s*===\s*["']codex["'][^)]*providerOptions/s);
  });
});
