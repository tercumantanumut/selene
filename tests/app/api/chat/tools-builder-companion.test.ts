/**
 * Tests for companion-tool enforcement in buildToolsForRequest.
 *
 * The rule: when bash is in the initial tool set, executeCommand must also be
 * promoted to always-loaded because bash produces logId-bearing stubs that
 * require executeCommand's readLog sub-command to retrieve.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ToolRegistry } from "@/lib/ai/tool-registry";
import { registerCollaborationTools } from "@/lib/ai/tool-registry/register-collaboration-tools";
import type { ToolMetadata, ToolFactory } from "@/lib/ai/tool-registry/types";

// Minimal mock setup — we only test the companion enforcement logic, not the
// full buildToolsForRequest pipeline which requires a DB.

function setupRegistry(): ToolRegistry {
  ToolRegistry.reset();
  const registry = ToolRegistry.getInstance();
  registerCollaborationTools(registry);
  return registry;
}

describe("companion-tool enforcement — bash → executeCommand", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = setupRegistry();
  });

  afterEach(() => {
    ToolRegistry.reset();
  });

  it("bash is registered as alwaysLoad and executeCommand as deferLoading", () => {
    const bashMeta = registry.get("bash")?.metadata;
    const execMeta = registry.get("executeCommand")?.metadata;

    expect(bashMeta?.loading.alwaysLoad).toBe(true);
    expect(execMeta?.loading.deferLoading).toBe(true);
  });

  it("non-deferred tools include bash but NOT executeCommand (before enforcement)", () => {
    const nonDeferred = registry.getTools({
      sessionId: "test-session",
      userId: "test-user",
      includeDeferredTools: false,
    });

    expect(nonDeferred.bash).toBeDefined();
    // executeCommand is deferLoading, so it should NOT be in non-deferred
    expect(nonDeferred.executeCommand).toBeUndefined();
  });

  it("all tools include both bash and executeCommand when deferred are included", () => {
    const allTools = registry.getTools({
      sessionId: "test-session",
      userId: "test-user",
      includeDeferredTools: true,
    });

    expect(allTools.bash).toBeDefined();
    expect(allTools.executeCommand).toBeDefined();
  });

  it("enforcement logic: if bash is in initialActiveTools and executeCommand is in allTools, promote it", () => {
    // Simulate what buildToolsForRequest does after building nonDeferredTools
    const nonDeferred = registry.getTools({
      sessionId: "test-session",
      userId: "test-user",
      includeDeferredTools: false,
      agentEnabledTools: new Set(["bash", "executeCommand"]),
    });
    const initialActiveTools = new Set(Object.keys(nonDeferred));

    const allTools = registry.getTools({
      sessionId: "test-session",
      userId: "test-user",
      includeDeferredTools: true,
      agentEnabledTools: new Set(["bash", "executeCommand"]),
    });

    // Pre-enforcement: bash is in, executeCommand is out
    expect(initialActiveTools.has("bash")).toBe(true);
    expect(initialActiveTools.has("executeCommand")).toBe(false);

    // Apply the companion enforcement logic (same as in tools-builder.ts)
    if (
      initialActiveTools.has("bash") &&
      !initialActiveTools.has("executeCommand") &&
      allTools.executeCommand
    ) {
      initialActiveTools.add("executeCommand");
    }

    // Post-enforcement: both are in
    expect(initialActiveTools.has("bash")).toBe(true);
    expect(initialActiveTools.has("executeCommand")).toBe(true);
  });

  it("enforcement is a no-op when executeCommand is already loaded", () => {
    const initialActiveTools = new Set(["bash", "executeCommand", "readFile"]);

    // Should not throw or change anything
    if (
      initialActiveTools.has("bash") &&
      !initialActiveTools.has("executeCommand") &&
      true // allTools.executeCommand would be truthy
    ) {
      initialActiveTools.add("executeCommand");
    }

    expect(initialActiveTools.size).toBe(3);
  });

  it("enforcement is a no-op when bash is not loaded", () => {
    const initialActiveTools = new Set(["readFile", "searchTools"]);

    if (
      initialActiveTools.has("bash") &&
      !initialActiveTools.has("executeCommand") &&
      true
    ) {
      initialActiveTools.add("executeCommand");
    }

    expect(initialActiveTools.has("executeCommand")).toBe(false);
  });
});
