import { describe, expect, it } from "vitest";

import type { LLMProvider } from "@/lib/ai/provider-types";
import { getClaudeCodeModels } from "@/lib/auth/claudecode-models";
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

describe("Claude 5 model catalog", () => {
  it("advertises Claude Fable 5.1 in the Claude Code model picker", () => {
    expect(getClaudeCodeModels()).toContainEqual({
      id: "claude-fable-5-1",
      name: "Claude Fable 5.1",
    });
  });

  it("advertises Claude Fable 5.1 for both Anthropic and Claude Code with flagship capabilities", () => {
    const catalog = buildModelCatalog("claudecode", AUTHENTICATED_PROVIDERS, {});
    const entries = catalog.filter((model) => model.id === "claude-fable-5-1");

    expect(entries.map((model) => model.provider)).toEqual(["anthropic", "claudecode"]);
    for (const entry of entries) {
      expect(entry.name).toBe("Claude Fable 5.1");
      expect(entry.tier).toBe("flagship");
      expect(entry.capabilities).toMatchObject({
        vision: true,
        thinking: true,
        toolUse: true,
        streaming: true,
        contextWindow: "1M",
      });
    }
  });

  it("advertises Claude Opus 5 in the Claude Code model picker", () => {
    expect(getClaudeCodeModels()).toContainEqual({
      id: "claude-opus-5",
      name: "Claude Opus 5",
    });
  });

  it("advertises Claude Opus 5 for both Anthropic and Claude Code with flagship capabilities", () => {
    const catalog = buildModelCatalog("claudecode", AUTHENTICATED_PROVIDERS, {});
    const entries = catalog.filter((model) => model.id === "claude-opus-5");

    expect(entries.map((model) => model.provider)).toEqual(["anthropic", "claudecode"]);
    for (const entry of entries) {
      expect(entry.name).toBe("Claude Opus 5");
      expect(entry.tier).toBe("flagship");
      expect(entry.capabilities).toMatchObject({
        vision: true,
        thinking: true,
        toolUse: true,
        streaming: true,
        contextWindow: "1M",
      });
    }
  });
});
