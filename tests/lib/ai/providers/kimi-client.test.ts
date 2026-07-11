import { describe, expect, it } from "vitest";
import { KIMI_MODEL_IDS } from "@/lib/auth/kimi-models";
import { normalizeKimiChatCompletionBody } from "@/lib/ai/providers/kimi-client";

describe("kimi client request normalization", () => {
  it("includes the current Kimi K2.7 code models", () => {
    expect(KIMI_MODEL_IDS).toContain("kimi-k2.7-code");
    expect(KIMI_MODEL_IDS).toContain("kimi-k2.7-code-highspeed");
  });

  it("keeps tool requests at Kimi's fixed 0.6 temperature", () => {
    const normalized = normalizeKimiChatCompletionBody({
      model: "kimi-k2.6",
      messages: [],
      tools: [{ type: "function", function: { name: "search" } }],
      temperature: 0.85,
    });

    expect(normalized).toMatchObject({
      temperature: 0.6,
      top_p: 0.95,
      n: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      thinking: { type: "disabled" },
    });
  });

  it("does not disable thinking and uses temperature 1.0 for forced-thinking Kimi K2.7 code models", () => {
    const normalized = normalizeKimiChatCompletionBody({
      model: "kimi-k2.7-code",
      messages: [],
      thinking: { type: "disabled" },
      temperature: 0.2,
    });

    expect(normalized).toMatchObject({
      model: "kimi-k2.7-code",
      temperature: 1.0,
    });
    expect(normalized).not.toHaveProperty("thinking");
  });

  it("uses temperature 1.0 for Kimi K2.7 Code HighSpeed too", () => {
    const normalized = normalizeKimiChatCompletionBody({
      model: "kimi-k2.7-code-highspeed",
      messages: [],
      temperature: 0.6,
    });

    expect(normalized).toMatchObject({
      model: "kimi-k2.7-code-highspeed",
      temperature: 1.0,
    });
    expect(normalized).not.toHaveProperty("thinking");
  });
});
