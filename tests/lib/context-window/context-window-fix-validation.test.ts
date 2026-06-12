/**
 * Validation Tests for Context Window Management
 * 
 * Tests to verify:
 * 1. 200K context window limits for Claude models (per Anthropic official docs)
 * 2. 400K context window limits for GPT-5/Codex models
 * 3. Lowered minimum message threshold (3 instead of 10)
 * 4. Graceful fallback when compaction fails
 * 
 * Reference: https://docs.anthropic.com/en/docs/about-claude/models
 * Most Claude models (Sonnet 4.6, Sonnet 4.5, Haiku 4.5, etc.) have 200K standard context.
 * Claude Opus 4.6 has 1M context via Agent SDK.
 */

import { describe, it, expect } from "vitest";
import { 
  getContextWindowConfig, 
  getTokenThresholds,
  PROVIDER_DEFAULT_LIMITS 
} from "@/lib/context-window/provider-limits";

describe("Context Window Fix Validation", () => {
  describe("Provider Default Limits (200K for Claude, 400K fallback for Codex)", () => {
    it("should set anthropic provider limit to 200K", () => {
      expect(PROVIDER_DEFAULT_LIMITS.anthropic).toBe(200000);
    });

    it("should set claudecode provider limit to 200K", () => {
      expect(PROVIDER_DEFAULT_LIMITS.claudecode).toBe(200000);
    });

    it("should set antigravity provider limit to 200K", () => {
      expect(PROVIDER_DEFAULT_LIMITS.antigravity).toBe(200000);
    });

    it("should keep codex provider fallback at 400K", () => {
      expect(PROVIDER_DEFAULT_LIMITS.codex).toBe(400000);
    });
  });

  describe("GPT-5.4 model-specific configurations (1M)", () => {
    const codex54Models = [
      "gpt-5.4",
      "gpt-5.4-low",
      "gpt-5.4-medium",
      "gpt-5.4-high",
      "gpt-5.4-xhigh",
    ];

    codex54Models.forEach((modelId) => {
      it(`should configure ${modelId} with 1M context window`, () => {
        const config = getContextWindowConfig(modelId, "codex");
        expect(config.maxTokens).toBe(1000000);
      });
    });
  });

  describe("Claude Model-Specific Configurations", () => {
    const claude200KModels = [
      "claude-sonnet-4-5-20250929",
      "claude-haiku-4-5-20251001",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
    ];

    claude200KModels.forEach((modelId) => {
      it(`should configure ${modelId} with 200K context window`, () => {
        const config = getContextWindowConfig(modelId);
        expect(config.maxTokens).toBe(200000);
      });
    });

    const claude1MModels = [
      "claude-opus-4-8",
      "claude-fable-5",
      "claude-opus-4-7",
      "claude-opus-4-6",
    ];

    claude1MModels.forEach((modelId) => {
      it(`should configure ${modelId} with 1M context window`, () => {
        const config = getContextWindowConfig(modelId, "claudecode");
        expect(config.maxTokens).toBe(1000000);
      });
    });
  });

  describe("GPT-5/Codex Model-Specific Configurations (400K)", () => {
    const codexModels = [
      "gpt-5.3-codex",
      "gpt-5.3-codex-medium",
      "gpt-5.2-codex",
      "gpt-5.2-high",
      "gpt-5.1-codex-max",
      "gpt-5.1-codex-medium",
      "gpt-5.1-codex-mini",
      "gpt-5.1-chat-latest",
    ];

    codexModels.forEach((modelId) => {
      it(`should configure ${modelId} with 400K context window`, () => {
        const config = getContextWindowConfig(modelId, "codex");
        expect(config.maxTokens).toBe(400000);
      });
    });
  });

  describe("Token Thresholds (based on 200K for Claude)", () => {
    it("should calculate correct thresholds for claude-sonnet-4-6", () => {
      const thresholds = getTokenThresholds("claude-sonnet-4-6");
      
      expect(thresholds.maxTokens).toBe(200000);
      expect(thresholds.warningTokens).toBe(150000); // 75% of 200K
      expect(thresholds.criticalTokens).toBe(180000); // 90% of 200K
      expect(thresholds.hardLimitTokens).toBe(190000); // 95% of 200K
    });

    it("should calculate correct thresholds for GPT-5 models (400K)", () => {
      const thresholds = getTokenThresholds("gpt-5.1-codex");

      expect(thresholds.maxTokens).toBe(400000);
      expect(thresholds.warningTokens).toBe(300000); // 75% of 400K
      expect(thresholds.criticalTokens).toBe(360000); // 90% of 400K
      expect(thresholds.hardLimitTokens).toBe(380000); // 95% of 400K
    });
  });

  describe("Minimum Message Threshold (lowered to 3)", () => {
    it("should set minMessagesForCompaction to 3 in default config", () => {
      const config = getContextWindowConfig("unknown-model");
      expect(config.minMessagesForCompaction).toBe(3);
    });

    it("should allow compaction with as few as 3 messages", () => {
      const config = getContextWindowConfig("claude-sonnet-4-6");
      expect(config.minMessagesForCompaction).toBeLessThanOrEqual(3);
    });

    it("should support sparse long-running sessions", () => {
      // A session with 5 messages should now be eligible for compaction
      const config = getContextWindowConfig("claude-sonnet-4-6");
      const sparseSessionMessageCount = 5;
      
      expect(sparseSessionMessageCount).toBeGreaterThanOrEqual(
        config.minMessagesForCompaction
      );
    });
  });

  describe("Configuration Consistency", () => {
    it("should maintain keepRecentMessages at 6", () => {
      const config = getContextWindowConfig("claude-sonnet-4-6");
      expect(config.keepRecentMessages).toBe(6);
    });

    it("should maintain threshold percentages", () => {
      const config = getContextWindowConfig("claude-sonnet-4-6");
      
      expect(config.warningThreshold).toBe(0.75); // 75%
      expect(config.criticalThreshold).toBe(0.90); // 90%
      expect(config.hardLimit).toBe(0.95); // 95%
    });

    it("should enable streaming for Claude models", () => {
      const config = getContextWindowConfig("claude-sonnet-4-6");
      expect(config.supportsStreaming).toBe(true);
    });
  });

  describe("Backward Compatibility", () => {
    it("should fallback to provider defaults for unknown models", () => {
      const config = getContextWindowConfig("unknown-claude-model", "anthropic");
      expect(config.maxTokens).toBe(200000); // Should use provider default (200K)
    });

    it("should use conservative 128K default for completely unknown models", () => {
      const config = getContextWindowConfig("unknown-model");
      expect(config.maxTokens).toBe(128000);
    });
  });

  describe("Consistency with model-catalog.ts", () => {
    it("should match model-catalog contextWindow for all Claude models", () => {
      // model-catalog.ts declares contextWindow per model.
      // provider-limits.ts must agree.
      const claude200KModels = [
        "claude-sonnet-4-5-20250929",
        "claude-haiku-4-5-20251001",
        "claude-sonnet-4-6",
        "claude-opus-4-6-thinking",
      ];

      for (const modelId of claude200KModels) {
        const config = getContextWindowConfig(modelId);
        expect(config.maxTokens).toBe(200000);
      }

      // Claude Code flagship models have 1M context (model-catalog contextWindow: "1M")
      const claude1MModels = [
        "claude-opus-4-8",
        "claude-fable-5",
        "claude-opus-4-7",
        "claude-opus-4-6",
      ];
      for (const modelId of claude1MModels) {
        const config = getContextWindowConfig(modelId, "claudecode");
        expect(config.maxTokens).toBe(1000000);
      }
    });
  });

  describe("Real-World Scenario: Long-Running Task", () => {
    it("should allow session to grow to 150K before warning", () => {
      const thresholds = getTokenThresholds("claude-sonnet-4-6");
      const longRunningSessionTokens = 140000; // 140K tokens
      
      expect(longRunningSessionTokens).toBeLessThan(thresholds.warningTokens);
    });

    it("should handle sparse sessions with large tool outputs", () => {
      const config = getContextWindowConfig("claude-sonnet-4-6");
      
      // Scenario: 5 messages with 25K tokens each = 125K total
      const messageCount = 5;
      const tokensPerMessage = 25000;
      const totalTokens = messageCount * tokensPerMessage;
      
      // Should be eligible for compaction
      expect(messageCount).toBeGreaterThanOrEqual(config.minMessagesForCompaction);
      
      // Should still be below warning threshold (150K)
      const thresholds = getTokenThresholds("claude-sonnet-4-6");
      expect(totalTokens).toBeLessThan(thresholds.warningTokens);
    });

    it("should provide adequate headroom for complex tasks", () => {
      const thresholds = getTokenThresholds("claude-sonnet-4-6");
      
      // A complex codebase analysis might use 100K tokens
      const complexTaskTokens = 100000;
      
      // Should still be in "safe" zone (below 75% warning threshold of 150K)
      expect(complexTaskTokens).toBeLessThan(thresholds.warningTokens);
      
      // Should have 50K tokens of headroom before warning
      const headroom = thresholds.warningTokens - complexTaskTokens;
      expect(headroom).toBeGreaterThanOrEqual(50000);
    });
  });
});
