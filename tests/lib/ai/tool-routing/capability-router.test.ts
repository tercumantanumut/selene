import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isCapabilityRoutingEnabled,
  evaluateRoutingDecision,
  buildRoutingHint,
  DEFAULT_INTENT_MAPPINGS,
  type RoutingContext,
  type RoutingDecision,
} from "@/lib/ai/tool-routing/capability-router";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeContext(overrides: Partial<RoutingContext> = {}): RoutingContext {
  return {
    userMessage: "",
    modelResponse: "",
    activeTools: new Set<string>(),
    allTools: new Set<string>([
      "memorize",
      "webSearch",
      "localGrep",
      "scheduleTask",
      "describeImage",
      "searchTools",
    ]),
    deferredMode: true,
    ...overrides,
  };
}

// ─── Env flag ────────────────────────────────────────────────────────────────

describe("isCapabilityRoutingEnabled", () => {
  const originalEnv = process.env.ENABLE_CAPABILITY_ROUTING_FALLBACK;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ENABLE_CAPABILITY_ROUTING_FALLBACK;
    } else {
      process.env.ENABLE_CAPABILITY_ROUTING_FALLBACK = originalEnv;
    }
  });

  it("returns false when env var is not set", () => {
    delete process.env.ENABLE_CAPABILITY_ROUTING_FALLBACK;
    expect(isCapabilityRoutingEnabled()).toBe(false);
  });

  it("returns false when env var is 'false'", () => {
    process.env.ENABLE_CAPABILITY_ROUTING_FALLBACK = "false";
    expect(isCapabilityRoutingEnabled()).toBe(false);
  });

  it("returns true when env var is 'true'", () => {
    process.env.ENABLE_CAPABILITY_ROUTING_FALLBACK = "true";
    expect(isCapabilityRoutingEnabled()).toBe(true);
  });

  it("returns false when env var is empty string", () => {
    process.env.ENABLE_CAPABILITY_ROUTING_FALLBACK = "";
    expect(isCapabilityRoutingEnabled()).toBe(false);
  });
});

// ─── evaluateRoutingDecision ─────────────────────────────────────────────────

describe("evaluateRoutingDecision", () => {
  describe("no-match cases", () => {
    it("returns no intervention for empty user message", () => {
      const result = evaluateRoutingDecision(
        makeContext({ userMessage: "", modelResponse: "Sure!" }),
      );
      expect(result.shouldIntervene).toBe(false);
      expect(result.mode).toBe("none");
    });

    it("returns no intervention for empty model response", () => {
      const result = evaluateRoutingDecision(
        makeContext({ userMessage: "Remember this for me", modelResponse: "" }),
      );
      expect(result.shouldIntervene).toBe(false);
    });

    it("returns no intervention for very short user message", () => {
      const result = evaluateRoutingDecision(
        makeContext({ userMessage: "hi", modelResponse: "Hello!" }),
      );
      expect(result.shouldIntervene).toBe(false);
    });

    it("returns no intervention for ambiguous messages", () => {
      const result = evaluateRoutingDecision(
        makeContext({
          userMessage: "interesting, what do you think?",
          modelResponse: "That's a great point!",
        }),
      );
      expect(result.shouldIntervene).toBe(false);
    });

    it("returns no intervention when no intent patterns match", () => {
      const result = evaluateRoutingDecision(
        makeContext({
          userMessage: "Tell me a joke about programming",
          modelResponse: "Why do programmers prefer dark mode?",
        }),
      );
      expect(result.shouldIntervene).toBe(false);
    });
  });

  describe("memorize intent", () => {
    it("detects 'remember that' intent", () => {
      const result = evaluateRoutingDecision(
        makeContext({
          userMessage: "Remember that I prefer dark mode in all editors",
          modelResponse: "I've remembered your preference for dark mode.",
          allTools: new Set(["memorize", "searchTools"]),
        }),
      );
      expect(result.shouldIntervene).toBe(true);
      expect(result.suggestedTool).toBe("memorize");
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it("detects 'memorize this' intent", () => {
      const result = evaluateRoutingDecision(
        makeContext({
          userMessage: "Memorize this: my API key format is always sk-...",
          modelResponse: "Got it, I'll remember that.",
          allTools: new Set(["memorize", "searchTools"]),
        }),
      );
      expect(result.shouldIntervene).toBe(true);
      expect(result.suggestedTool).toBe("memorize");
    });

    it("detects 'don't forget' intent", () => {
      const result = evaluateRoutingDecision(
        makeContext({
          userMessage: "Don't forget that I always want TypeScript strict mode",
          modelResponse: "Noted! I'll keep that in mind.",
          allTools: new Set(["memorize", "searchTools"]),
        }),
      );
      expect(result.shouldIntervene).toBe(true);
      expect(result.suggestedTool).toBe("memorize");
    });

    it("returns discover-first when memorize is deferred", () => {
      const result = evaluateRoutingDecision(
        makeContext({
          userMessage: "Remember that I use VSCode",
          modelResponse: "I've noted that you use VSCode.",
          activeTools: new Set(["searchTools"]),
          allTools: new Set(["memorize", "searchTools"]),
          deferredMode: true,
        }),
      );
      expect(result.shouldIntervene).toBe(true);
      expect(result.mode).toBe("discover-first");
    });

    it("returns direct when memorize is active", () => {
      const result = evaluateRoutingDecision(
        makeContext({
          userMessage: "Remember that I use VSCode",
          modelResponse: "I've noted that you use VSCode.",
          activeTools: new Set(["memorize", "searchTools"]),
          allTools: new Set(["memorize", "searchTools"]),
          deferredMode: true,
        }),
      );
      expect(result.shouldIntervene).toBe(true);
      expect(result.mode).toBe("direct");
    });
  });

  describe("web search intent", () => {
    it("detects 'search the web for' intent", () => {
      const result = evaluateRoutingDecision(
        makeContext({
          userMessage: "Search the web for the latest React 19 features",
          modelResponse: "Based on my knowledge, React 19 includes...",
          allTools: new Set(["webSearch", "searchTools"]),
        }),
      );
      expect(result.shouldIntervene).toBe(true);
      expect(result.suggestedTool).toBe("webSearch");
    });

    it("detects 'what is the latest' intent", () => {
      const result = evaluateRoutingDecision(
        makeContext({
          userMessage: "What's the latest version of Node.js?",
          modelResponse: "Based on general knowledge, the latest LTS is...",
          allTools: new Set(["webSearch", "searchTools"]),
        }),
      );
      expect(result.shouldIntervene).toBe(true);
      expect(result.suggestedTool).toBe("webSearch");
    });
  });

  describe("grep intent", () => {
    it("detects 'grep for X in the codebase'", () => {
      const result = evaluateRoutingDecision(
        makeContext({
          userMessage: "Grep for useState in the codebase",
          modelResponse: "Let me help you find useState usage...",
          allTools: new Set(["localGrep", "searchTools"]),
        }),
      );
      expect(result.shouldIntervene).toBe(true);
      expect(result.suggestedTool).toBe("localGrep");
    });

    it("detects 'search for X in my code'", () => {
      const result = evaluateRoutingDecision(
        makeContext({
          userMessage: "Search for TODO comments in the project files",
          modelResponse: "Here are some common patterns...",
          allTools: new Set(["localGrep", "searchTools"]),
        }),
      );
      expect(result.shouldIntervene).toBe(true);
      expect(result.suggestedTool).toBe("localGrep");
    });
  });

  describe("scheduling intent", () => {
    it("detects 'remind me' intent", () => {
      const result = evaluateRoutingDecision(
        makeContext({
          userMessage: "Remind me to deploy the app tomorrow at 9am",
          modelResponse: "I've scheduled a reminder for tomorrow at 9am.",
          allTools: new Set(["scheduleTask", "searchTools"]),
        }),
      );
      expect(result.shouldIntervene).toBe(true);
      expect(result.suggestedTool).toBe("scheduleTask");
    });

    it("detects 'every day' pattern", () => {
      const result = evaluateRoutingDecision(
        makeContext({
          userMessage: "Run a health check every day at noon",
          modelResponse: "I've set that up for you.",
          allTools: new Set(["scheduleTask", "searchTools"]),
        }),
      );
      expect(result.shouldIntervene).toBe(true);
      expect(result.suggestedTool).toBe("scheduleTask");
    });
  });

  describe("tool availability filtering", () => {
    it("does not intervene if tool is not registered", () => {
      const result = evaluateRoutingDecision(
        makeContext({
          userMessage: "Remember that I prefer dark mode",
          modelResponse: "Got it!",
          allTools: new Set(["searchTools"]), // memorize not in allTools
        }),
      );
      expect(result.shouldIntervene).toBe(false);
    });

    it("does not intervene if tool is not in enabledTools", () => {
      const result = evaluateRoutingDecision(
        makeContext({
          userMessage: "Remember that I prefer dark mode",
          modelResponse: "Got it, I'll remember that.",
          allTools: new Set(["memorize", "searchTools"]),
          enabledTools: new Set(["searchTools"]), // memorize not enabled
        }),
      );
      expect(result.shouldIntervene).toBe(false);
    });

    it("intervenes when tool is in enabledTools", () => {
      const result = evaluateRoutingDecision(
        makeContext({
          userMessage: "Remember that I prefer dark mode",
          modelResponse: "Got it, I'll remember that.",
          allTools: new Set(["memorize", "searchTools"]),
          enabledTools: new Set(["memorize", "searchTools"]),
        }),
      );
      expect(result.shouldIntervene).toBe(true);
    });
  });

  describe("confidence scoring", () => {
    it("higher confidence when intent + acknowledgment both match", () => {
      const intentOnly = evaluateRoutingDecision(
        makeContext({
          userMessage: "Remember that I use Vim",
          modelResponse: "Okay, using the memorize tool now.",
          allTools: new Set(["memorize", "searchTools"]),
        }),
      );
      const intentPlusAck = evaluateRoutingDecision(
        makeContext({
          userMessage: "Remember that I use Vim",
          modelResponse: "I've remembered your Vim preference.",
          allTools: new Set(["memorize", "searchTools"]),
        }),
      );
      expect(intentPlusAck.confidence).toBeGreaterThan(intentOnly.confidence);
    });
  });

  describe("no cross-session state", () => {
    it("two calls with different contexts produce independent results", () => {
      const ctx1 = makeContext({
        userMessage: "Remember that I use Vim",
        modelResponse: "I've memorized that.",
        allTools: new Set(["memorize", "searchTools"]),
      });
      const ctx2 = makeContext({
        userMessage: "Tell me a joke",
        modelResponse: "Why did the chicken cross the road?",
        allTools: new Set(["memorize", "searchTools"]),
      });
      const r1 = evaluateRoutingDecision(ctx1);
      const r2 = evaluateRoutingDecision(ctx2);
      expect(r1.shouldIntervene).toBe(true);
      expect(r2.shouldIntervene).toBe(false);
    });
  });
});

// ─── buildRoutingHint ────────────────────────────────────────────────────────

describe("buildRoutingHint", () => {
  it("returns null for non-intervening decision", () => {
    const decision: RoutingDecision = {
      shouldIntervene: false,
      suggestedTool: null,
      confidence: 0,
      mode: "none",
      reason: "no-match",
    };
    expect(buildRoutingHint(decision)).toBeNull();
  });

  it("returns discover-first hint for deferred tools", () => {
    const decision: RoutingDecision = {
      shouldIntervene: true,
      suggestedTool: "memorize",
      confidence: 0.8,
      mode: "discover-first",
      reason: "intent-match:memorize+ack-detected",
    };
    const hint = buildRoutingHint(decision);
    expect(hint).toContain("searchTools");
    expect(hint).toContain("memorize");
    expect(hint).toContain("Do not acknowledge");
  });

  it("returns direct hint for active tools", () => {
    const decision: RoutingDecision = {
      shouldIntervene: true,
      suggestedTool: "webSearch",
      confidence: 0.7,
      mode: "direct",
      reason: "intent-match:webSearch",
    };
    const hint = buildRoutingHint(decision);
    expect(hint).toContain("already available");
    expect(hint).toContain("webSearch");
    expect(hint).toContain("Do not acknowledge");
  });
});

// ─── DEFAULT_INTENT_MAPPINGS ─────────────────────────────────────────────────

describe("DEFAULT_INTENT_MAPPINGS", () => {
  it("covers expected tool names", () => {
    const toolNames = DEFAULT_INTENT_MAPPINGS.map((m) => m.toolName);
    expect(toolNames).toContain("memorize");
    expect(toolNames).toContain("webSearch");
    expect(toolNames).toContain("localGrep");
    expect(toolNames).toContain("scheduleTask");
    expect(toolNames).toContain("describeImage");
    expect(toolNames).toContain("searchTools");
  });

  it("all mappings have valid confidence thresholds", () => {
    for (const mapping of DEFAULT_INTENT_MAPPINGS) {
      expect(mapping.confidenceThreshold).toBeGreaterThan(0);
      expect(mapping.confidenceThreshold).toBeLessThanOrEqual(1);
    }
  });

  it("all intent patterns are valid regex", () => {
    for (const mapping of DEFAULT_INTENT_MAPPINGS) {
      for (const pattern of mapping.intentPatterns) {
        expect(pattern).toBeInstanceOf(RegExp);
        // Should not throw
        expect(() => pattern.test("test string")).not.toThrow();
      }
    }
  });
});
