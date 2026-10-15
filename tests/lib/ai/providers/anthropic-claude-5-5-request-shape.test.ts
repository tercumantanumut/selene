/**
 * Contract test for the @ai-sdk/anthropic pin.
 *
 * Claude Opus 5.5 / Sonnet 5.5 reject sampling params (temperature/top_p/top_k)
 * and forced tool choice (tool_choice: any|tool) with HTTP 400. The chat route
 * forwards `temperature` and `toolChoice: "required"` unconditionally, so the
 * provider must strip/downgrade them for these model IDs. This guards against a
 * downgrade of @ai-sdk/anthropic below 3.0.127 silently re-breaking both models.
 */
import { describe, expect, it } from "vitest";
import { createAnthropic } from "@ai-sdk/anthropic";

const MINIMAL_RESPONSE = {
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

async function capture(modelId: string) {
  let body: Record<string, unknown> | null = null;
  const provider = createAnthropic({
    apiKey: "test",
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ...MINIMAL_RESPONSE, model: modelId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const result = await provider(modelId).doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    temperature: 0.7,
    tools: [{ type: "function", name: "noop", description: "no-op", inputSchema: { type: "object", properties: {} } }],
    toolChoice: { type: "required" },
  });
  return { body: body as Record<string, unknown> | null, warnings: result.warnings };
}

describe.each(["claude-opus-5-5", "claude-sonnet-5-5"])("@ai-sdk/anthropic request shape for %s", (modelId) => {
  it("does not forward temperature and downgrades required tool choice to auto", async () => {
    const { body, warnings } = await capture(modelId);
    expect(body).not.toBeNull();
    expect(body).not.toHaveProperty("temperature");
    expect(body?.tool_choice).toEqual({ type: "auto" });
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("@ai-sdk/anthropic request shape for claude-sonnet-4-6 (control)", () => {
  it("still forwards temperature and required tool choice", async () => {
    const { body } = await capture("claude-sonnet-4-6");
    expect(body?.temperature).toBe(0.7);
    expect(body?.tool_choice).toEqual({ type: "any" });
  });
});
