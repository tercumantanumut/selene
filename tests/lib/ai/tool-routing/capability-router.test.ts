import { describe, it, expect, afterEach } from "vitest";
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
    // searchTools is always-loaded in practice — include it in activeTools by default
    // so discover-first path is reachable for deferred tools
    activeTools: new Set<string>(["searchTools"]),
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

  // ── Proactive mode (empty modelResponse) — the actual production path ──

  describe("proactive mode (empty modelResponse)", () => {
    it("detects memorize intent proactively", () => {
      const result = evaluateRoutingDecision(
        makeContext({
          userMessage: "Remember that I prefer dark mode in all editors",
          modelResponse: "", // proactive: no model response yet
          allTools: new Set(["memorize", "searchTools"]),
        }),
      );
      expect(result.shouldIntervene).toBe(true);
      expect(result.suggestedTool).toBe("memorize");
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it("detects web search intent proactively", () => {
      const result = evaluateRoutingDecision(
        makeContext({
          userMessage: "Search the web for the latest React 19 features",
          modelResponse: "",
          allTools: new Set(["webSearch", "searchTools"]),
        }),
      );
      expect(result.shouldIntervene).toBe(true);
      expect(result.suggestedTool).toBe("webSearch");
    });

    it("detects grep intent proactively", () => {
      const result = evaluateRoutingDecision(
        makeContext({
          userMessage: "Grep for useState in the codebase",
          modelResponse: "",
          allTools: new Set(["localGrep", "searchTools"]),
        }),
      );
      expect(result.shouldIntervene).toBe(true);
      expect(result.suggestedTool).toBe("localGrep");
    });

    it("detects schedule intent proactively", () => {
      const result = evaluateRoutingDecision(
        makeContext({
          userMessage: "Remind me to deploy the app tomorrow at 9am",
          modelResponse: "",
          allTools: new Set(["scheduleTask", "searchTools"]),
        }),
      );
      expect(result.shouldIntervene).toBe(true);
      expect(result.suggestedTool).toBe("scheduleTask");
    });

    it("does not intervene for ambiguous messages in proactive mode", () => {
      const result = evaluateRoutingDecision(
        makeContext({
          userMessage: "What do you think about this approach?",
          modelResponse: "",
        }),
      );
      expect(result.shouldIntervene).toBe(false);
    });

    it("skips ack scoring in proactive mode", () => {
      // In proactive mode, confidence comes from intent patterns only (no ack boost)
      const proactive = evaluateRoutingDecision(
        makeContext({
          userMessage: "Remember that I use Vim",
          modelResponse: "",
          allTools: new Set(["memorize", "searchTools"]),
        }),
      );
      const reactive = evaluateRoutingDecision(
        makeContext({
          userMessage: "Remember that I use Vim",
          modelResponse: "I've remembered your Vim preference.",
          allTools: new Set(["memorize", "searchTools"]),
        }),
      );
      // Reactive with ack should have higher confidence
      expect(reactive.confidence).toBeGreaterThan(proactive.confidence);
      // But proactive should still clear the threshold
      expect(proactive.shouldIntervene).toBe(true);
    });
  });

  // ── Reactive mode (with modelResponse) ──

  describe("memorize intent (reactive)", () => {
    it("detects 'remember that' intent with acknowledgment", () => {
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

  describe("web search intent (reactive)", () => {
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

  describe("grep intent (reactive)", () => {
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

  describe("scheduling intent (reactive)", () => {
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

  // ── Tool availability filtering ──

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

    it("treats undefined enabledTools as all tools enabled", () => {
      const result = evaluateRoutingDecision(
        makeContext({
          userMessage: "Remember that I prefer dark mode",
          modelResponse: "",
          allTools: new Set(["memorize", "searchTools"]),
          enabledTools: undefined, // no filter
        }),
      );
      expect(result.shouldIntervene).toBe(true);
    });

    it("does not intervene when deferredMode=false and tool is not active", () => {
      const result = evaluateRoutingDecision(
        makeContext({
          userMessage: "Remember that I prefer dark mode",
          modelResponse: "",
          activeTools: new Set(["searchTools"]), // memorize not active
          allTools: new Set(["memorize", "searchTools"]),
          deferredMode: false, // deferred is off — can't discover
        }),
      );
      expect(result.shouldIntervene).toBe(false);
    });

    it("does not suggest discover-first when searchTools is not active", () => {
      const result = evaluateRoutingDecision(
        makeContext({
          userMessage: "Remember that I prefer dark mode",
          modelResponse: "",
          activeTools: new Set([]), // searchTools not active — can't discover
          allTools: new Set(["memorize", "searchTools"]),
          deferredMode: true,
        }),
      );
      // memorize is registered and deferred mode is on, but searchTools
      // is not active so discover-first is impossible
      expect(result.shouldIntervene).toBe(false);
    });

    it("does not suggest discover-first when searchTools is disabled via enabledTools", () => {
      const result = evaluateRoutingDecision(
        makeContext({
          userMessage: "Remember that I prefer dark mode",
          modelResponse: "",
          activeTools: new Set(["searchTools"]),
          allTools: new Set(["memorize", "searchTools"]),
          enabledTools: new Set(["memorize"]), // searchTools not enabled
          deferredMode: true,
        }),
      );
      expect(result.shouldIntervene).toBe(false);
    });
  });

  // ── Confidence scoring ──

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

    it("multi-pattern match boosts confidence", () => {
      // "grep" matches both the generic and the specific grep pattern
      const singleMatch = evaluateRoutingDecision(
        makeContext({
          userMessage: "Search for TODO comments in the project files",
          modelResponse: "",
          allTools: new Set(["localGrep", "searchTools"]),
        }),
      );
      const multiMatch = evaluateRoutingDecision(
        makeContext({
          userMessage: "Grep for TODO comments in the codebase",
          modelResponse: "",
          allTools: new Set(["localGrep", "searchTools"]),
        }),
      );
      // Both should intervene, but the grep-specific match should have higher confidence
      expect(singleMatch.shouldIntervene).toBe(true);
      expect(multiMatch.shouldIntervene).toBe(true);
      expect(multiMatch.confidence).toBeGreaterThanOrEqual(singleMatch.confidence);
    });
  });

  // ── Overlapping intent / false positive tests ──

  describe("false positive resistance", () => {
    it("does not trigger memorize for rhetorical 'remember when'", () => {
      const result = evaluateRoutingDecision(
        makeContext({
          userMessage: "Remember when we talked about the API design?",
          modelResponse: "",
          allTools: new Set(["memorize", "searchTools"]),
        }),
      );
      // "remember when" doesn't match "remember that/this/the/my/for"
      expect(result.shouldIntervene).toBe(false);
    });

    it("currently triggers scheduleTask for 'create a task management app' (known false positive)", () => {
      const result = evaluateRoutingDecision(
        makeContext({
          userMessage: "Help me create a task management application",
          modelResponse: "",
          allTools: new Set(["scheduleTask", "searchTools"]),
        }),
      );
      // Known limitation: "create a task" pattern matches even inside
      // "create a task management application". This is a false positive
      // that the current regex-based approach cannot distinguish.
      // If this regresses or improves, this test will catch it.
      // To fix: refine scheduleTask patterns to exclude development contexts.
      expect(result.shouldIntervene).toBe(true);
      expect(result.suggestedTool).toBe("scheduleTask");
    });

    it("prefers localGrep over webSearch when message mentions code/files", () => {
      // "Search for X in the project files" matches both webSearch's "search for"
      // and localGrep's "search...files" patterns.
      // When only localGrep is available, it should select localGrep.
      const result = evaluateRoutingDecision(
        makeContext({
          userMessage: "Search for TODO comments in the project files",
          modelResponse: "",
          allTools: new Set(["localGrep", "searchTools"]), // no webSearch
        }),
      );
      expect(result.shouldIntervene).toBe(true);
      expect(result.suggestedTool).toBe("localGrep");
    });

    it("picks highest confidence when both webSearch and localGrep match", () => {
      // When both tools are available, localGrep should win due to multi-pattern match
      const result = evaluateRoutingDecision(
        makeContext({
          userMessage: "Search for TODO comments in the project files",
          modelResponse: "",
          allTools: new Set(["localGrep", "webSearch", "searchTools"]),
        }),
      );
      expect(result.shouldIntervene).toBe(true);
      expect(result.suggestedTool).toBe("localGrep");
    });
  });

  // ── No cross-session state ──

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
        expect(() => pattern.test("test string")).not.toThrow();
      }
    }
  });

  it("no intent patterns use global or sticky flags (safe for concurrent use)", () => {
    for (const mapping of DEFAULT_INTENT_MAPPINGS) {
      for (const pattern of mapping.intentPatterns) {
        expect(pattern.global).toBe(false);
        expect(pattern.sticky).toBe(false);
      }
      for (const pattern of mapping.acknowledgmentPatterns) {
        expect(pattern.global).toBe(false);
        expect(pattern.sticky).toBe(false);
      }
    }
  });
});
