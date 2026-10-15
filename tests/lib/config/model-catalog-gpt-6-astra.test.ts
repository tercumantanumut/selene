import { describe, expect, it } from "vitest";

import type { LLMProvider } from "@/lib/ai/provider-types";
import { buildModelCatalog } from "@/lib/config/model-catalog";

const AUTHENTICATED_PROVIDERS = {
  anthropic: true,
  openrouter: true,
  antigravity: true,
  codex: true,
  claudecode: true,
  kimi: true,
  minimax: true,
  blackboxai: true,
  deepseek: true,
  ollama: true,
  vllm: true,
} satisfies Record<LLMProvider, boolean>;

describe("GPT-6 Astra model catalog", () => {
  it("advertises GPT-6 Astra and its reasoning variants for Codex with flagship capabilities", () => {
    const catalog = buildModelCatalog("codex", AUTHENTICATED_PROVIDERS, {});
    const entries = catalog.filter((model) => model.id.startsWith("gpt-6-astra"));

    expect(entries.map((model) => model.id)).toEqual([
      "gpt-6-astra",
      "gpt-6-astra-low",
      "gpt-6-astra-medium",
      "gpt-6-astra-high",
      "gpt-6-astra-xhigh",
      "gpt-6-astra-max",
      "gpt-6-astra-ultra",
    ]);
    for (const entry of entries) {
      expect(entry.provider).toBe("codex");
      expect(entry.tier).toBe("flagship");
      expect(entry.capabilities).toMatchObject({
        vision: true,
        thinking: true,
        toolUse: true,
        streaming: true,
        contextWindow: "272K",
      });
    }
    expect(entries[0]?.name).toBe("GPT-6 Astra");
  });

  it("keeps the Codex default model unchanged", () => {
    const catalog = buildModelCatalog("codex", AUTHENTICATED_PROVIDERS, {});
    const defaults = catalog.filter((model) => model.provider === "codex" && model.isDefault);
    expect(defaults.map((model) => model.id)).toEqual(["gpt-5.4"]);
  });
});
