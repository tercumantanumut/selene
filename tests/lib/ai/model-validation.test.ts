import { describe, expect, it } from "vitest";
import {
  isModelCompatibleWithProvider,
  validateModelForProvider,
  validateAllModelsForProvider,
  validateSessionModelConfig,
} from "@/lib/ai/model-validation";

// ---------------------------------------------------------------------------
// isModelCompatibleWithProvider
// ---------------------------------------------------------------------------

describe("isModelCompatibleWithProvider", () => {
  describe("anthropic", () => {
    it("accepts claude models with date suffix", () => {
      expect(isModelCompatibleWithProvider("claude-sonnet-4-5-20250929", "anthropic")).toBe(true);
      expect(isModelCompatibleWithProvider("claude-haiku-4-5-20251001", "anthropic")).toBe(true);
      expect(isModelCompatibleWithProvider("claude-3-opus-20240229", "anthropic")).toBe(true);
    });

    it("accepts short Claude IDs (shared with Antigravity)", () => {
      expect(isModelCompatibleWithProvider("claude-sonnet-4-6", "anthropic")).toBe(true);
      expect(isModelCompatibleWithProvider("claude-opus-4-6-thinking", "anthropic")).toBe(true);
    });

    it("rejects non-claude Antigravity models", () => {
      expect(isModelCompatibleWithProvider("gemini-3-flash", "anthropic")).toBe(false);
      expect(isModelCompatibleWithProvider("gpt-oss-120b-medium", "anthropic")).toBe(false);
    });

    it("rejects non-claude models", () => {
      expect(isModelCompatibleWithProvider("gpt-5.1-codex", "anthropic")).toBe(false);
      expect(isModelCompatibleWithProvider("kimi-k2.5", "anthropic")).toBe(false);
      expect(isModelCompatibleWithProvider("llama3.1:8b", "anthropic")).toBe(false);
    });

    it("rejects empty model", () => {
      expect(isModelCompatibleWithProvider("", "anthropic")).toBe(false);
    });
  });

  describe("openrouter", () => {
    it("accepts models with slash (provider/model format)", () => {
      expect(isModelCompatibleWithProvider("openai/gpt-4o", "openrouter")).toBe(true);
      expect(isModelCompatibleWithProvider("google/gemini-2.5-flash", "openrouter")).toBe(true);
      expect(isModelCompatibleWithProvider("x-ai/grok-4.1-fast", "openrouter")).toBe(true);
    });

    it("accepts generic bare IDs", () => {
      expect(isModelCompatibleWithProvider("openrouter/auto", "openrouter")).toBe(true);
    });

    it("rejects bare provider-specific IDs", () => {
      expect(isModelCompatibleWithProvider("gemini-3-flash", "openrouter")).toBe(false);
      expect(isModelCompatibleWithProvider("gpt-5.1-codex", "openrouter")).toBe(false);
      expect(isModelCompatibleWithProvider("kimi-k2.5", "openrouter")).toBe(false);
    });
  });

  describe("antigravity", () => {
    it("accepts exact Antigravity model IDs", () => {
      expect(isModelCompatibleWithProvider("gemini-3-flash", "antigravity")).toBe(true);
      expect(isModelCompatibleWithProvider("claude-sonnet-4-6", "antigravity")).toBe(true);
      expect(isModelCompatibleWithProvider("gpt-oss-120b-medium", "antigravity")).toBe(true);
    });

    it("rejects non-Antigravity models", () => {
      expect(isModelCompatibleWithProvider("claude-sonnet-4-5-20250929", "antigravity")).toBe(false);
      expect(isModelCompatibleWithProvider("gpt-5.1-codex", "antigravity")).toBe(false);
    });

    it("is case-insensitive", () => {
      expect(isModelCompatibleWithProvider("Gemini-3-Flash", "antigravity")).toBe(true);
    });
  });

  describe("codex", () => {
    it("accepts codex models", () => {
      expect(isModelCompatibleWithProvider("gpt-5.1-codex", "codex")).toBe(true);
      expect(isModelCompatibleWithProvider("gpt-5.1-codex-mini", "codex")).toBe(true);
      expect(isModelCompatibleWithProvider("gpt-5.3-codex-medium", "codex")).toBe(true);
    });

    it("rejects non-codex models", () => {
      expect(isModelCompatibleWithProvider("claude-sonnet-4-5-20250929", "codex")).toBe(false);
      expect(isModelCompatibleWithProvider("kimi-k2.5", "codex")).toBe(false);
    });
  });

  describe("claudecode", () => {
    it("accepts Claude Code OAuth models", () => {
      expect(isModelCompatibleWithProvider("claude-sonnet-4-5-20250929", "claudecode")).toBe(true);
      expect(isModelCompatibleWithProvider("claude-haiku-4-5-20251001", "claudecode")).toBe(true);
      expect(isModelCompatibleWithProvider("claude-opus-4-20250929", "claudecode")).toBe(true);
    });

    it("accepts shared Antigravity Claude models", () => {
      expect(isModelCompatibleWithProvider("claude-sonnet-4-6", "claudecode")).toBe(true);
    });

    it("rejects non-claude models", () => {
      expect(isModelCompatibleWithProvider("gpt-5.1-codex", "claudecode")).toBe(false);
    });
  });

  describe("kimi", () => {
    it("accepts Kimi models, including the bare K3 coding API ID", () => {
      expect(isModelCompatibleWithProvider("k3", "kimi")).toBe(true);
      expect(isModelCompatibleWithProvider("kimi-k2.5", "kimi")).toBe(true);
      expect(isModelCompatibleWithProvider("kimi-k2-turbo-preview", "kimi")).toBe(true);
      expect(isModelCompatibleWithProvider("moonshot-v1-8k", "kimi")).toBe(true);
    });

    it("rejects non-Kimi models and K3-like IDs", () => {
      expect(isModelCompatibleWithProvider("claude-sonnet-4-5-20250929", "kimi")).toBe(false);
      expect(isModelCompatibleWithProvider("k3-preview", "kimi")).toBe(false);
    });
  });

  describe("ollama", () => {
    it("accepts any model", () => {
      expect(isModelCompatibleWithProvider("llama3.1:8b", "ollama")).toBe(true);
      expect(isModelCompatibleWithProvider("claude-sonnet-4-5-20250929", "ollama")).toBe(true);
      expect(isModelCompatibleWithProvider("custom-model", "ollama")).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// validateModelForProvider
// ---------------------------------------------------------------------------

describe("validateModelForProvider", () => {
  it("returns valid for empty/null model (means use default)", () => {
    expect(validateModelForProvider("", "anthropic")).toEqual({ valid: true, model: "" });
    expect(validateModelForProvider(null, "anthropic")).toEqual({ valid: true, model: "" });
    expect(validateModelForProvider(undefined, "anthropic")).toEqual({ valid: true, model: "" });
  });

  it("returns valid for compatible model", () => {
    const result = validateModelForProvider("claude-sonnet-4-5-20250929", "anthropic");
    expect(result.valid).toBe(true);
    expect(result.model).toBe("claude-sonnet-4-5-20250929");
    expect(result.error).toBeUndefined();
  });

  it("returns error for incompatible model", () => {
    const result = validateModelForProvider("gpt-5.1-codex", "anthropic");
    expect(result.valid).toBe(false);
    expect(result.model).toBe("gpt-5.1-codex");
    expect(result.error).toContain("not compatible");
    expect(result.error).toContain("anthropic");
  });

  it("trims whitespace", () => {
    const result = validateModelForProvider("  claude-sonnet-4-5-20250929  ", "anthropic");
    expect(result.valid).toBe(true);
    expect(result.model).toBe("claude-sonnet-4-5-20250929");
  });
});

// ---------------------------------------------------------------------------
// validateAllModelsForProvider
// ---------------------------------------------------------------------------

describe("validateAllModelsForProvider", () => {
  it("validates all fields at once", () => {
    const result = validateAllModelsForProvider(
      {
        chatModel: "claude-sonnet-4-5-20250929",
        researchModel: "claude-haiku-4-5-20251001",
        visionModel: "",
        utilityModel: undefined,
      },
      "anthropic",
    );
    expect(result.valid).toBe(true);
    expect(Object.keys(result.errors)).toHaveLength(0);
  });

  it("reports errors for incompatible models", () => {
    const result = validateAllModelsForProvider(
      {
        chatModel: "gpt-5.1-codex",
        researchModel: "claude-sonnet-4-5-20250929",
      },
      "anthropic",
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveProperty("chatModel");
    expect(result.errors.chatModel).toContain("not compatible");
  });

  it("skips undefined fields", () => {
    const result = validateAllModelsForProvider(
      { chatModel: "claude-sonnet-4-5-20250929" },
      "anthropic",
    );
    expect(result.valid).toBe(true);
    expect(result.validFields).toContain("chatModel");
    expect(result.validFields).not.toContain("researchModel");
  });
});

// ---------------------------------------------------------------------------
// validateSessionModelConfig
// ---------------------------------------------------------------------------

describe("validateSessionModelConfig", () => {
  it("validates session models against session provider override", () => {
    const result = validateSessionModelConfig(
      {
        sessionProvider: "codex",
        sessionChatModel: "gpt-5.1-codex",
      },
      "anthropic", // global provider is different
    );
    expect(result.valid).toBe(true);
  });

  it("accepts K3 when selected as a Kimi session model", () => {
    const result = validateSessionModelConfig(
      {
        sessionProvider: "kimi",
        sessionChatModel: "k3",
      },
      "anthropic",
    );

    expect(result.valid).toBe(true);
  });

  it("validates session models against global provider when no session provider", () => {
    const result = validateSessionModelConfig(
      {
        sessionChatModel: "claude-sonnet-4-5-20250929",
      },
      "anthropic",
    );
    expect(result.valid).toBe(true);
  });

  it("rejects session model incompatible with session provider", () => {
    const result = validateSessionModelConfig(
      {
        sessionProvider: "codex",
        sessionChatModel: "claude-sonnet-4-5-20250929",
      },
      "anthropic",
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveProperty("chatModel");
  });

  it("rejects session model incompatible with global provider (no session provider)", () => {
    const result = validateSessionModelConfig(
      {
        sessionChatModel: "gpt-5.1-codex",
      },
      "anthropic",
    );
    expect(result.valid).toBe(false);
  });

  it("validates session utility model against session provider override", () => {
    const result = validateSessionModelConfig(
      {
        sessionProvider: "codex",
        sessionUtilityModel: "gpt-5.3-codex-medium",
      },
      "anthropic",
    );
    expect(result.valid).toBe(true);
  });

  it("validates session transcriber model against session provider override", () => {
    const result = validateSessionModelConfig(
      {
        sessionProvider: "codex",
        sessionTranscriberModel: "gpt-5.3-codex-medium",
      },
      "anthropic",
    );
    expect(result.valid).toBe(true);
  });

  it("rejects utility model incompatible with effective provider", () => {
    const result = validateSessionModelConfig(
      {
        sessionProvider: "anthropic",
        sessionUtilityModel: "gpt-5.1-codex",
      },
      "anthropic",
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveProperty("utilityModel");
  });

  it("rejects transcriber model incompatible with effective provider", () => {
    const result = validateSessionModelConfig(
      {
        sessionProvider: "anthropic",
        sessionTranscriberModel: "gpt-5.1-codex",
      },
      "anthropic",
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveProperty("transcriberModel");
  });
});

// ---------------------------------------------------------------------------
// Cross-provider override scenarios (the core bug fix)
// ---------------------------------------------------------------------------

describe("cross-provider override scenarios", () => {
  it("session override with different provider should not conflict", () => {
    // User has Claude Code as global, but sets gpt-5.3 for a session
    // The session must include the provider override too
    const result = validateSessionModelConfig(
      {
        sessionProvider: "codex",
        sessionChatModel: "gpt-5.3-codex-medium",
      },
      "claudecode",
    );
    expect(result.valid).toBe(true);
  });

  it("session override without provider override rejects cross-provider model", () => {
    // User sets gpt-5.3 in session but doesn't set provider override
    // This should fail because the global provider is claudecode
    const result = validateSessionModelConfig(
      {
        sessionChatModel: "gpt-5.3-codex-medium",
      },
      "claudecode",
    );
    expect(result.valid).toBe(false);
    expect(result.errors.chatModel).toContain("not compatible");
  });

  it("clearing session override (empty model) is always valid", () => {
    const result = validateSessionModelConfig(
      {
        sessionChatModel: "",
      },
      "claudecode",
    );
    expect(result.valid).toBe(true);
  });

  it("no clearing incompatible model log should be needed", () => {
    // The old system would log "Clearing incompatible chatModel" on read.
    // With the new system, incompatible models are rejected at write time.
    // This test verifies that compatible models pass through cleanly.
    const settingsResult = validateAllModelsForProvider(
      {
        chatModel: "claude-sonnet-4-5-20250929",
        researchModel: "claude-haiku-4-5-20251001",
        visionModel: "",
        utilityModel: "",
      },
      "anthropic",
    );
    expect(settingsResult.valid).toBe(true);

    // And an incompatible one is rejected, not silently cleared
    const badResult = validateAllModelsForProvider(
      {
        chatModel: "gpt-5.3-codex-medium",
      },
      "claudecode",
    );
    expect(badResult.valid).toBe(false);
    expect(badResult.errors.chatModel).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("handles case-insensitive matching", () => {
    expect(isModelCompatibleWithProvider("Claude-Sonnet-4-5-20250929", "anthropic")).toBe(true);
    expect(isModelCompatibleWithProvider("GPT-5.1-CODEX", "codex")).toBe(true);
  });

  it("handles whitespace in model IDs", () => {
    expect(isModelCompatibleWithProvider("  claude-sonnet-4-5-20250929  ", "anthropic")).toBe(true);
  });

  it("handles openrouter model with prefix", () => {
    expect(isModelCompatibleWithProvider("openrouter/auto", "openrouter")).toBe(true);
  });

  it("provider switch clears models at write time", () => {
    // Simulate: user was on anthropic with claude model, switches to codex
    // The settings API should clear model fields on provider switch
    // Here we just verify the validation catches the incompatibility
    const result = validateAllModelsForProvider(
      {
        chatModel: "claude-sonnet-4-5-20250929", // leftover from anthropic
      },
      "codex", // new provider
    );
    expect(result.valid).toBe(false);
    expect(result.errors.chatModel).toContain("not compatible");
  });
});
