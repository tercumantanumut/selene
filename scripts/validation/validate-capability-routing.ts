/**
 * Validation script for the capability routing fallback feature.
 *
 * Validates:
 * 1. Env flag defaults to off
 * 2. Router module is importable and stateless
 * 3. Router produces correct decisions for known intents
 * 4. Router produces no-intervention for ambiguous inputs
 * 5. Prompt hint is only included when flag is on
 * 6. No process-global state in the router
 *
 * Usage: npx tsx scripts/validation/validate-capability-routing.ts
 */

import {
  isCapabilityRoutingEnabled,
  evaluateRoutingDecision,
  buildRoutingHint,
  DEFAULT_INTENT_MAPPINGS,
  type RoutingContext,
} from "../../lib/ai/tool-routing/capability-router";
import {
  getToolExecutionReliabilityBlock,
  TOOL_EXECUTION_RELIABILITY,
} from "../../lib/ai/prompts/shared-blocks";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

function makeContext(overrides: Partial<RoutingContext> = {}): RoutingContext {
  return {
    userMessage: "",
    modelResponse: "",
    activeTools: new Set<string>(),
    allTools: new Set<string>([
      "memorize", "webSearch", "localGrep", "scheduleTask",
      "describeImage", "searchTools",
    ]),
    deferredMode: true,
    ...overrides,
  };
}

// ─── Test 1: Env flag ────────────────────────────────────────────────────────

console.log("\n1. Env flag behavior:");

// Save and clear
const savedEnv = process.env.ENABLE_CAPABILITY_ROUTING_FALLBACK;
delete process.env.ENABLE_CAPABILITY_ROUTING_FALLBACK;

assert(
  isCapabilityRoutingEnabled() === false,
  "Defaults to false when env var is not set"
);

process.env.ENABLE_CAPABILITY_ROUTING_FALLBACK = "false";
assert(
  isCapabilityRoutingEnabled() === false,
  "Returns false when set to 'false'"
);

process.env.ENABLE_CAPABILITY_ROUTING_FALLBACK = "true";
assert(
  isCapabilityRoutingEnabled() === true,
  "Returns true when set to 'true'"
);

// Restore
if (savedEnv === undefined) {
  delete process.env.ENABLE_CAPABILITY_ROUTING_FALLBACK;
} else {
  process.env.ENABLE_CAPABILITY_ROUTING_FALLBACK = savedEnv;
}

// ─── Test 2: Router statelessness ────────────────────────────────────────────

console.log("\n2. Router statelessness:");

const ctx1 = makeContext({
  userMessage: "Remember that I use dark mode",
  modelResponse: "Got it, I'll remember that.",
  allTools: new Set(["memorize", "searchTools"]),
});
const ctx2 = makeContext({
  userMessage: "Tell me a joke",
  modelResponse: "Why did the developer go broke?",
  allTools: new Set(["memorize", "searchTools"]),
});

const r1 = evaluateRoutingDecision(ctx1);
const r2 = evaluateRoutingDecision(ctx2);
const r1Again = evaluateRoutingDecision(ctx1);

assert(
  r1.shouldIntervene === true && r2.shouldIntervene === false,
  "Different inputs produce different independent results"
);

assert(
  r1.suggestedTool === r1Again.suggestedTool && r1.confidence === r1Again.confidence,
  "Same input produces identical result (no accumulated state)"
);

// ─── Test 3: Known intent matching ──────────────────────────────────────────

console.log("\n3. Known intent matching:");

const intents: Array<{ message: string; response: string; expectedTool: string }> = [
  { message: "Remember that I prefer TypeScript strict mode", response: "I've remembered that.", expectedTool: "memorize" },
  { message: "Search the web for latest Next.js features", response: "Based on my knowledge...", expectedTool: "webSearch" },
  { message: "Grep for useState in the codebase", response: "Let me help...", expectedTool: "localGrep" },
  { message: "Remind me to deploy at 9am", response: "I've set that up.", expectedTool: "scheduleTask" },
];

for (const { message, response, expectedTool } of intents) {
  const result = evaluateRoutingDecision(
    makeContext({
      userMessage: message,
      modelResponse: response,
      allTools: new Set([expectedTool, "searchTools"]),
    })
  );
  assert(
    result.shouldIntervene === true && result.suggestedTool === expectedTool,
    `"${message.slice(0, 40)}..." → ${expectedTool}`
  );
}

// ─── Test 4: No intervention for ambiguous messages ─────────────────────────

console.log("\n4. No intervention for ambiguous messages:");

const ambiguous = [
  { message: "Hello", response: "Hi there!" },
  { message: "What do you think?", response: "I think..." },
  { message: "Can you help?", response: "Of course!" },
  { message: "interesting", response: "Tell me more." },
];

for (const { message, response } of ambiguous) {
  const result = evaluateRoutingDecision(
    makeContext({ userMessage: message, modelResponse: response })
  );
  assert(
    result.shouldIntervene === false,
    `"${message}" → no intervention`
  );
}

// ─── Test 5: Prompt hint gating ─────────────────────────────────────────────

console.log("\n5. Prompt hint env gating:");

const savedEnv2 = process.env.ENABLE_CAPABILITY_ROUTING_FALLBACK;

delete process.env.ENABLE_CAPABILITY_ROUTING_FALLBACK;
assert(
  getToolExecutionReliabilityBlock() === "",
  "Prompt block is empty when flag is off"
);

process.env.ENABLE_CAPABILITY_ROUTING_FALLBACK = "true";
assert(
  getToolExecutionReliabilityBlock() === TOOL_EXECUTION_RELIABILITY,
  "Prompt block returns content when flag is on"
);

if (savedEnv2 === undefined) {
  delete process.env.ENABLE_CAPABILITY_ROUTING_FALLBACK;
} else {
  process.env.ENABLE_CAPABILITY_ROUTING_FALLBACK = savedEnv2;
}

// ─── Test 6: buildRoutingHint ───────────────────────────────────────────────

console.log("\n6. buildRoutingHint:");

assert(
  buildRoutingHint({ shouldIntervene: false, suggestedTool: null, confidence: 0, mode: "none", reason: "no-match" }) === null,
  "Returns null for no-intervention"
);

const directHint = buildRoutingHint({ shouldIntervene: true, suggestedTool: "memorize", confidence: 0.8, mode: "direct", reason: "intent" });
assert(
  directHint !== null && directHint.includes("already available"),
  "Direct mode hint mentions tool is available"
);

const discoverHint = buildRoutingHint({ shouldIntervene: true, suggestedTool: "memorize", confidence: 0.8, mode: "discover-first", reason: "intent" });
assert(
  discoverHint !== null && discoverHint.includes("searchTools"),
  "Discover-first mode hint mentions searchTools"
);

// ─── Test 7: Mapping metadata validity ──────────────────────────────────────

console.log("\n7. Mapping metadata validity:");

assert(
  DEFAULT_INTENT_MAPPINGS.length >= 5,
  `Has ${DEFAULT_INTENT_MAPPINGS.length} intent mappings (>= 5)`
);

for (const mapping of DEFAULT_INTENT_MAPPINGS) {
  assert(
    mapping.confidenceThreshold > 0 && mapping.confidenceThreshold <= 1,
    `${mapping.toolName}: valid confidence threshold (${mapping.confidenceThreshold})`
  );
  assert(
    mapping.intentPatterns.length > 0,
    `${mapping.toolName}: has intent patterns`
  );
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
