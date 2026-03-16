/**
 * Capability Router
 *
 * A stateless, metadata-driven router that maps explicit user intent patterns
 * to tool names. Used as a generic fallback layer to detect when the model
 * acknowledges a tool-backed action in plain text without actually executing it.
 *
 * Design principles:
 * - Pure functions, no side effects, no global state
 * - Metadata-driven: intent→tool mappings are data, not code
 * - Tool-agnostic: works for any tool, not just memory/search
 * - Supports both deferred and always-load modes
 *
 * Gated by ENABLE_CAPABILITY_ROUTING_FALLBACK env var.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface IntentMapping {
  /** Canonical tool name in the registry */
  toolName: string;
  /** Regex patterns that indicate clear user intent for this tool */
  intentPatterns: RegExp[];
  /** Phrases in model output that indicate acknowledgment without execution */
  acknowledgmentPatterns: RegExp[];
  /** Minimum confidence threshold (0-1) for this mapping to activate */
  confidenceThreshold: number;
}

export interface RoutingDecision {
  /** Whether the router detected a missed tool execution */
  shouldIntervene: boolean;
  /** The tool that should have been called */
  suggestedTool: string | null;
  /** Confidence score (0-1) */
  confidence: number;
  /** Whether the tool needs discovery first (deferred) or is directly available */
  mode: "direct" | "discover-first" | "none";
  /** Human-readable reason for the decision */
  reason: string;
}

export interface RoutingContext {
  /** The latest user message text */
  userMessage: string;
  /** The model's response text (no tool calls) */
  modelResponse: string;
  /** Set of currently active/available tool names */
  activeTools: Set<string>;
  /** Set of all registered tool names (including deferred) */
  allTools: Set<string>;
  /** Set of tools enabled for this agent */
  enabledTools?: Set<string>;
  /** Whether deferred loading is active */
  deferredMode: boolean;
}

// ─── Intent Mappings ─────────────────────────────────────────────────────────

/**
 * Default intent-to-tool mappings.
 *
 * Each entry maps a clear user intent pattern to the tool that should handle it.
 * The acknowledgment patterns detect when the model pretends to have done
 * something without actually calling the tool.
 */
export const DEFAULT_INTENT_MAPPINGS: IntentMapping[] = [
  {
    toolName: "memorize",
    intentPatterns: [
      /\b(?:remember|memorize|save|store|note)\s+(?:that|this|the|my|for)\b/i,
      /\b(?:remember|memorize)\b.*\b(?:future|always|from now|going forward)\b/i,
      /\bdon'?t\s+forget\b/i,
      /\bkeep\s+(?:in mind|note|track)\b/i,
    ],
    acknowledgmentPatterns: [
      /\bi(?:'ve|'ll| have| will)\s+(?:remembered|memorized|noted|stored|saved)\b/i,
      /\b(?:got it|noted|will remember|i'll keep)\b/i,
      /\b(?:saved|stored|remembered)\s+(?:that|this|your|the)\b/i,
    ],
    confidenceThreshold: 0.7,
  },
  {
    toolName: "webSearch",
    intentPatterns: [
      // Explicit web-context search: "search the web", "look up online", "google for"
      /\b(?:search|look up|google|find|check)\s+(?:the web|online|internet)\b/i,
      // "search for X" without code/file context (avoid matching grep-like requests)
      /\bsearch\s+for\b(?!.*\b(?:code|files?|codebase|project|repo)\b)/i,
      /\bwhat(?:'s| is)\s+(?:the latest|current|new)\b/i,
    ],
    acknowledgmentPatterns: [
      /\bbased on (?:my|general) knowledge\b/i,
      /\bi don'?t have (?:access|the ability) to (?:search|browse)\b/i,
    ],
    confidenceThreshold: 0.6,
  },
  {
    toolName: "localGrep",
    intentPatterns: [
      /\b(?:grep|search|find|look)\b.*\b(?:code|files?|codebase|project|repo)\b/i,
      /\b(?:grep|rg)\s+/i,
      /\b(?:search|find|look)\s+(?:for|in|through)\b.*\b(?:code|files?|codebase|project|repo)\b/i,
    ],
    acknowledgmentPatterns: [],
    confidenceThreshold: 0.6,
  },
  {
    toolName: "scheduleTask",
    intentPatterns: [
      /\b(?:schedule|remind|set a reminder|create a task|set up a cron)\b/i,
      /\bremind me\b/i,
      /\bevery\s+(?:day|week|month|morning|evening|hour|minute)\b/i,
      /\b(?:run|do|execute|check)\b.*\bevery\s+(?:day|week|month|morning|evening|hour|minute)\b/i,
    ],
    acknowledgmentPatterns: [
      /\bi(?:'ve| have)\s+(?:scheduled|set|created)\s+(?:a |the )?(?:reminder|task|schedule)\b/i,
    ],
    confidenceThreshold: 0.6,
  },
  {
    toolName: "describeImage",
    intentPatterns: [
      /\b(?:analyze|describe|look at|examine|what(?:'s| is) in)\s+(?:this|the|my)\s+(?:image|photo|picture|screenshot)\b/i,
    ],
    acknowledgmentPatterns: [],
    confidenceThreshold: 0.6,
  },
  {
    toolName: "searchTools",
    intentPatterns: [
      /\b(?:generate|create|make)\s+(?:an?\s+)?(?:image|picture|photo|video)\b/i,
      /\b(?:edit|modify|transform)\s+(?:this|the|my)\s+(?:image|photo|picture)\b/i,
    ],
    acknowledgmentPatterns: [
      /\bi (?:can'?t|don'?t have|am unable to)\s+(?:generate|create|make|edit)\s+(?:images?|pictures?|photos?|videos?)\b/i,
    ],
    confidenceThreshold: 0.5,
  },
];

// ─── Core Router ─────────────────────────────────────────────────────────────

/**
 * Check if the env flag is enabled.
 * Reads once per call — no caching, no module-level side effects.
 */
export function isCapabilityRoutingEnabled(): boolean {
  return process.env.ENABLE_CAPABILITY_ROUTING_FALLBACK === "true";
}

/**
 * Evaluate whether the model's response indicates a missed tool execution.
 *
 * Pure function — no side effects, no state mutation.
 *
 * @param ctx - The routing context (user message, model response, tool state)
 * @param mappings - Intent mappings to check (defaults to DEFAULT_INTENT_MAPPINGS)
 * @returns A routing decision indicating whether intervention is needed
 */
export function evaluateRoutingDecision(
  ctx: RoutingContext,
  mappings: IntentMapping[] = DEFAULT_INTENT_MAPPINGS,
): RoutingDecision {
  const noIntervention: RoutingDecision = {
    shouldIntervene: false,
    suggestedTool: null,
    confidence: 0,
    mode: "none",
    reason: "no-match",
  };

  // Skip empty user message
  const userMessage = ctx.userMessage.trim();
  if (!userMessage) {
    return noIntervention;
  }

  // Skip if message is very short (likely casual, not an action request)
  if (userMessage.length < 8) {
    return noIntervention;
  }

  // Proactive mode: modelResponse is empty (called before model runs).
  // In this mode, we rely only on intent patterns — acknowledgment scoring is skipped.
  const isProactive = !ctx.modelResponse.trim();

  // Can the agent actually discover deferred tools? Only if searchTools is active.
  const canDiscoverTools =
    ctx.activeTools.has("searchTools") &&
    (!ctx.enabledTools || ctx.enabledTools.has("searchTools"));

  let bestMatch: {
    mapping: IntentMapping;
    intentConfidence: number;
    ackConfidence: number;
    mode: "direct" | "discover-first";
  } | null = null;

  for (const mapping of mappings) {
    // Check if user message matches intent patterns
    const intentMatch = mapping.intentPatterns.some((pattern) =>
      pattern.test(userMessage),
    );
    if (!intentMatch) continue;

    // Check if tool is available for this agent (enabledTools filter)
    if (ctx.enabledTools && !ctx.enabledTools.has(mapping.toolName)) {
      continue;
    }

    // Determine mode based on tool availability — skip if tool not reachable
    const isActive = ctx.activeTools.has(mapping.toolName);
    const isRegistered = ctx.allTools.has(mapping.toolName);
    let mode: "direct" | "discover-first";
    if (isActive) {
      mode = "direct";
    } else if (isRegistered && ctx.deferredMode && canDiscoverTools) {
      mode = "discover-first";
    } else {
      // Tool not available — skip this mapping, try others
      continue;
    }

    // Base intent confidence from pattern match.
    // In proactive mode (no model response yet), we start slightly higher
    // because intent match is the only signal and must clear the threshold alone.
    let intentConfidence = isProactive ? 0.7 : 0.6;

    // Boost confidence if multiple patterns match
    const matchCount = mapping.intentPatterns.filter((p) =>
      p.test(userMessage),
    ).length;
    if (matchCount > 1) {
      intentConfidence = Math.min(intentConfidence + 0.15, 0.95);
    }

    // Check if model response contains acknowledgment without tool execution
    // (skipped in proactive mode — no model response to check)
    let ackConfidence = 0;
    if (!isProactive && mapping.acknowledgmentPatterns.length > 0) {
      const ackMatch = mapping.acknowledgmentPatterns.some((pattern) =>
        pattern.test(ctx.modelResponse),
      );
      if (ackMatch) {
        ackConfidence = 0.3;
      }
    }

    const totalConfidence = Math.min(intentConfidence + ackConfidence, 1.0);

    if (totalConfidence >= mapping.confidenceThreshold) {
      // Compare using clamped totals consistently
      const bestMatchTotal = bestMatch
        ? Math.min(bestMatch.intentConfidence + bestMatch.ackConfidence, 1.0)
        : -1;
      if (!bestMatch || totalConfidence > bestMatchTotal) {
        bestMatch = {
          mapping,
          intentConfidence,
          ackConfidence,
          mode,
        };
      }
    }
  }

  if (!bestMatch) {
    return noIntervention;
  }

  const { mapping, intentConfidence, ackConfidence, mode } = bestMatch;
  const totalConfidence = Math.min(intentConfidence + ackConfidence, 1.0);

  return {
    shouldIntervene: true,
    suggestedTool: mapping.toolName,
    confidence: totalConfidence,
    mode,
    reason: `intent-match:${mapping.toolName}` +
      (ackConfidence > 0 ? "+ack-detected" : ""),
  };
}

/**
 * Build a concise system-level hint for the model, encouraging it to use
 * the identified tool instead of acknowledging in plain text.
 *
 * Returns null if no intervention is needed.
 */
export function buildRoutingHint(decision: RoutingDecision): string | null {
  if (!decision.shouldIntervene || !decision.suggestedTool) {
    return null;
  }

  if (decision.mode === "discover-first") {
    return (
      `[Capability Routing] The user's request requires the "${decision.suggestedTool}" tool. ` +
      `This tool is available but not yet loaded. Use searchTools to discover and enable it, ` +
      `then call it to fulfill the request. Do not acknowledge the action in plain text — execute it.`
    );
  }

  return (
    `[Capability Routing] The user's request requires the "${decision.suggestedTool}" tool, ` +
    `which is already available. Call it directly to fulfill the request. ` +
    `Do not acknowledge the action in plain text — execute it.`
  );
}
