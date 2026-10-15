import { describe, expect, it } from "vitest";

import type { LLMProvider } from "@/lib/ai/provider-types";
import { getClaudeCodeModels } from "@/lib/auth/claudecode-models";
import { buildModelCatalog } from "@/lib/config/model-catalog";
import { formatModelName } from "@/components/assistant-ui/model-selector";

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

const CLAUDE_5_5_MODELS = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", short: "Opus 5.5" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", short: "Sonnet 5.5" },
] as const;

describe("Claude 5.5 model catalog", () => {
  it.each(CLAUDE_5_5_MODELS)("advertises $name in the Claude Code model picker", ({ id, name }) => {
    expect(getClaudeCodeModels()).toContainEqual({ id, name });
  });

  it.each(CLAUDE_5_5_MODELS)(
    "advertises $name for both Anthropic and Claude Code with flagship 1M capabilities",
    ({ id, name }) => {
      const catalog = buildModelCatalog("claudecode", AUTHENTICATED_PROVIDERS, {});
      const entries = catalog.filter((model) => model.id === id);

      expect(entries.map((model) => model.provider)).toEqual(["anthropic", "claudecode"]);
      for (const entry of entries) {
        expect(entry.name).toBe(name);
        expect(entry.tier).toBe("flagship");
        expect(entry.capabilities).toMatchObject({
          vision: true,
          thinking: true,
          toolUse: true,
          streaming: true,
          contextWindow: "1M",
        });
      }
    },
  );

  it.each(CLAUDE_5_5_MODELS)("formats $id as $short in the model selector", ({ id, short }) => {
    expect(formatModelName(id)).toBe(short);
  });

  it("lists Claude Opus 4.8 and Claude Fable 5 for the Anthropic provider too", () => {
    const catalog = buildModelCatalog("anthropic", AUTHENTICATED_PROVIDERS, {});
    const anthropicIds = catalog.filter((m) => m.provider === "anthropic").map((m) => m.id);
    expect(anthropicIds).toContain("claude-opus-4-8");
    expect(anthropicIds).toContain("claude-fable-5");
  });
});
