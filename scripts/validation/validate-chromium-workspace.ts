#!/usr/bin/env tsx
/**
 * Chromium Workspace Validation Script
 *
 * Validates concurrent session isolation, ownership, and teardown.
 *
 * Modes:
 *   --dry-run   Mock browser — validates session manager logic, maps, and
 *               teardown without spawning real Chromium processes.
 *   --live      Real Playwright — spawns actual browser contexts and verifies
 *               true isolation (cookies, storage, navigation).
 *
 * Usage:
 *   npx tsx scripts/validation/validate-chromium-workspace.ts --dry-run
 *   npx tsx scripts/validation/validate-chromium-workspace.ts --live
 */

const isDryRun = process.argv.includes("--dry-run");
const isLive = process.argv.includes("--live");

if (!isDryRun && !isLive) {
  console.error("Usage: validate-chromium-workspace.ts [--dry-run | --live]");
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    failed++;
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(60 - title.length)}`);
}

// ─── Dry-Run Tests ────────────────────────────────────────────────────────────

async function runDryRunTests(): Promise<void> {
  console.log("🧪 Chromium Workspace Validation (DRY RUN — no real browser)\n");

  // Test 1: Session manager module loads
  section("1. Module Loading");
  const sessionManager = await import("../../lib/browser/session-manager");
  assert(typeof sessionManager.getOrCreateSession === "function", "getOrCreateSession is exported");
  assert(typeof sessionManager.closeSession === "function", "closeSession is exported");
  assert(typeof sessionManager.shutdownAll === "function", "shutdownAll is exported");
  assert(typeof sessionManager.getActiveSessionCount === "function", "getActiveSessionCount is exported");

  // Test 2: Action history module loads
  section("2. Action History Module");
  const history = await import("../../lib/browser/action-history");
  assert(typeof history.initHistory === "function", "initHistory is exported");
  assert(typeof history.recordAction === "function", "recordAction is exported");
  assert(typeof history.finalizeHistory === "function", "finalizeHistory is exported");
  assert(typeof history.peekHistory === "function", "peekHistory is exported");
  assert(typeof history.buildReplayPlan === "function", "buildReplayPlan is exported");

  // Test 3: History tracking works in isolation
  section("3. Action History Isolation");
  const sessionA = "dry-run-session-A";
  const sessionB = "dry-run-session-B";

  history.initHistory(sessionA);
  history.initHistory(sessionB);

  history.recordAction(sessionA, "navigate", { url: "https://a.com" }, {
    success: true, durationMs: 100, output: "Navigated to a.com",
  });
  history.recordAction(sessionB, "navigate", { url: "https://b.com" }, {
    success: true, durationMs: 120, output: "Navigated to b.com",
  });
  history.recordAction(sessionA, "click", { selector: "#btn" }, {
    success: false, durationMs: 50, error: "Element not found",
  });

  const peekA = history.peekHistory(sessionA);
  const peekB = history.peekHistory(sessionB);

  assert(peekA !== null, "Session A history exists");
  assert(peekA!.actions.length === 2, "Session A has 2 actions");
  assert(peekB !== null, "Session B history exists");
  assert(peekB!.actions.length === 1, "Session B has 1 action (isolated)");
  assert(peekA!.actions[0].action === "navigate", "Session A first action is navigate");
  assert(peekA!.actions[1].success === false, "Session A second action is a failure");

  // Test 4: Finalize removes history
  section("4. History Finalization");
  const finalA = history.finalizeHistory(sessionA);
  assert(finalA !== null, "finalizeHistory returns the history");
  assert(finalA!.endedAt !== undefined, "endedAt is set");
  assert(finalA!.actions.length === 2, "Finalized history has 2 actions");

  const peekAfterFinalize = history.peekHistory(sessionA);
  assert(peekAfterFinalize === null, "History is removed after finalize");

  // Session B still exists
  const peekBStill = history.peekHistory(sessionB);
  assert(peekBStill !== null, "Session B history still exists (not affected by A's finalize)");

  // Cleanup B
  history.finalizeHistory(sessionB);

  // Test 5: Replay plan generation
  section("5. Replay Plan");
  const replayPlan = history.buildReplayPlan(finalA!);
  assert(replayPlan.length === 1, "Replay plan only includes successful actions");
  assert(replayPlan[0].action === "navigate", "Replay plan first action is navigate");

  // Test 6: Tool factory loads
  section("6. Tool Factory");
  const { createChromiumWorkspaceTool } = await import("../../lib/ai/tools/chromium-workspace-tool");
  assert(typeof createChromiumWorkspaceTool === "function", "createChromiumWorkspaceTool is exported");

  const toolInstance = createChromiumWorkspaceTool({ sessionId: "test-session" });
  assert(typeof toolInstance === "object", "Tool instance is created");
  assert("execute" in toolInstance, "Tool has execute method");

  // Test 7: Viewport resolver
  section("7. Viewport Resolver");
  const { resolveBrowserViewport, DEFAULT_BROWSER_VIEWPORT } = await import("../../lib/browser/viewport");
  const mobile = resolveBrowserViewport({ viewportPreset: "mobile" });
  assert(mobile.width < mobile.height && mobile.isMobile, "Mobile preset resolves to portrait touch viewport");
  const tabletLandscape = resolveBrowserViewport({ viewportPreset: "tablet", orientation: "landscape" });
  assert(tabletLandscape.width === 1024 && tabletLandscape.height === 768, "Tablet landscape orientation is respected");
  const custom = resolveBrowserViewport({ viewportWidth: 1024, viewportHeight: 768 });
  assert(custom.width === 1024 && custom.height === 768, "Custom dimensions are resolved");
  const reset = resolveBrowserViewport({ resetViewport: true }, mobile);
  assert(reset.width === DEFAULT_BROWSER_VIEWPORT.width && reset.height === DEFAULT_BROWSER_VIEWPORT.height, "Reset restores default desktop viewport");

  // Test 8: Output matching for replay verification
  section("8. Output Matching");
  assert(typeof history.outputsMatch === "function", "outputsMatch is exported");
  assert(history.outputsMatch("hello", "hello") === true, "Identical strings match");
  assert(history.outputsMatch({ a: 1 }, { a: 1 }) === true, "Identical objects match");
  assert(history.outputsMatch("hello", "world") === false, "Different strings don't match");
  assert(history.outputsMatch(null, null) === true, "Null values match");
  assert(history.outputsMatch(null, undefined) === true, "Null and undefined match");

  // Test 9: Replay plan includes expected output
  section("9. Replay Plan Expected Outputs");
  assert("expectedOutput" in replayPlan[0], "Replay plan includes expectedOutput field");
}

// ─── Live Tests ───────────────────────────────────────────────────────────────

async function runLiveTests(): Promise<void> {
  console.log("🧪 Chromium Workspace Validation (LIVE — real Playwright browser)\n");

  // Temporarily enable the feature
  process.env.ENABLE_CHROMIUM_WORKSPACE = "true";

  const {
    getOrCreateSession,
    closeSession,
    getActiveSessionCount,
    shutdownAll,
  } = await import("../../lib/browser/session-manager");
  const { initHistory, finalizeHistory } = await import("../../lib/browser/action-history");
  const { executeAction } = await import("../../lib/ai/tools/chromium-workspace-tool");

  // Test 1: Create concurrent sessions
  section("1. Concurrent Session Creation");
  const sessionIds = ["live-A", "live-B", "live-C"];

  const sessions = await Promise.all(
    sessionIds.map((id) => getOrCreateSession(id))
  );

  assert(sessions.length === 3, "3 sessions created concurrently");
  assert(getActiveSessionCount() === 3, "Active session count is 3");

  // Verify all sessions have distinct contexts
  const contextSet = new Set(sessions.map((s) => s.context));
  assert(contextSet.size === 3, "All 3 sessions have distinct BrowserContexts");

  // Test 2: Navigate in isolation
  section("2. Navigation Isolation");
  await sessions[0].page.goto("https://example.com", { waitUntil: "domcontentloaded" });
  await sessions[1].page.goto("https://httpbin.org/html", { waitUntil: "domcontentloaded" });
  await sessions[2].page.goto("https://example.com", { waitUntil: "domcontentloaded" });

  const urlA = sessions[0].page.url();
  const urlB = sessions[1].page.url();
  const urlC = sessions[2].page.url();

  assert(urlA.includes("example.com"), "Session A navigated to example.com");
  assert(urlB.includes("httpbin.org"), "Session B navigated to httpbin.org");
  assert(urlC.includes("example.com"), "Session C navigated to example.com");

  // Test 3: Cookie isolation
  section("3. Cookie Isolation");
  await sessions[0].context.addCookies([{
    name: "session_owner",
    value: "agent_A",
    domain: "example.com",
    path: "/",
  }]);

  const cookiesA = await sessions[0].context.cookies("https://example.com");
  const cookiesC = await sessions[2].context.cookies("https://example.com");

  assert(cookiesA.some((c) => c.name === "session_owner" && c.value === "agent_A"),
    "Session A has its cookie");
  assert(!cookiesC.some((c) => c.name === "session_owner"),
    "Session C does NOT see Session A's cookie (isolated)");

  // Test 4: Close individual session
  section("4. Individual Session Teardown");
  initHistory("live-B");
  finalizeHistory("live-B");
  await closeSession("live-B");

  assert(getActiveSessionCount() === 2, "Active count dropped to 2 after closing B");

  // Verify A and C are still alive
  const titleA = await sessions[0].page.title();
  assert(typeof titleA === "string", "Session A is still functional after B closed");

  // Test 5: Recreate a closed session ID
  section("5. Session Recreate After Close");
  const recreatedB = await getOrCreateSession("live-B");
  assert(getActiveSessionCount() === 3, "Closed session ID can be recreated");
  await recreatedB.page.goto("https://example.com", { waitUntil: "domcontentloaded" });
  assert(recreatedB.page.url().includes("example.com"), "Recreated session can navigate successfully");

  // Test 6: Responsive viewport controls
  section("6. Responsive Viewport Controls");
  const viewportSessionId = "live-viewport";
  const viewportUrl = `data:text/html,${encodeURIComponent(
    '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>viewport test</body></html>'
  )}`;
  const readViewport = async () => {
    const result = await executeAction(viewportSessionId, {
      action: "evaluate",
      expression: "({ width: window.innerWidth, height: window.innerHeight, screenWidth: screen.width, screenHeight: screen.height })",
    }, 30_000);
    return JSON.parse(String(result.data)) as { width: number; height: number; screenWidth: number; screenHeight: number };
  };

  await executeAction(viewportSessionId, {
    action: "open",
    url: viewportUrl,
    viewportPreset: "mobile",
    orientation: "portrait",
  }, 30_000);
  let dims = await readViewport();
  assert(dims.width === 390 && dims.height === 844, "Mobile portrait viewport is applied before open/navigation");

  await executeAction(viewportSessionId, {
    action: "setViewport",
    viewportPreset: "tablet",
    orientation: "landscape",
  }, 30_000);
  dims = await readViewport();
  assert(dims.width === 1024 && dims.height === 768, "Tablet landscape viewport is applied");

  await executeAction(viewportSessionId, {
    action: "setViewport",
    viewportWidth: 901,
    viewportHeight: 701,
  }, 30_000);
  dims = await readViewport();
  assert(dims.width === 901 && dims.height === 701, "Custom viewport dimensions are applied");

  await executeAction(viewportSessionId, { action: "resetViewport" }, 30_000);
  dims = await readViewport();
  assert(dims.width === 1280 && dims.height === 720, "Reset restores the default desktop viewport");

  // Test 7: Shutdown all
  section("7. Full Shutdown");
  await shutdownAll();
  assert(getActiveSessionCount() === 0, "All sessions closed");

  // Restore env
  delete process.env.ENABLE_CHROMIUM_WORKSPACE;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    if (isDryRun) {
      await runDryRunTests();
    } else {
      await runLiveTests();
    }

    console.log(`\n${"═".repeat(60)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log(`${"═".repeat(60)}`);

    if (failed > 0) {
      process.exit(1);
    } else {
      console.log("\n🎉 All validations passed!");
      process.exit(0);
    }
  } catch (err) {
    console.error("\n💥 Validation crashed:", err);
    process.exit(2);
  }
}

main();
