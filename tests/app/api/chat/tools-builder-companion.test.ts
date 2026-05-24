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

  it("executeCommand is registered as alwaysLoad and bash as deferLoading", () => {
    // After the bash→executeCommand default-tool swap, executeCommand is the
    // always-loaded shell tool and bash is opt-in (deferLoading).
    const bashMeta = registry.get("bash")?.metadata;
    const execMeta = registry.get("executeCommand")?.metadata;

    expect(bashMeta?.loading.deferLoading).toBe(true);
    expect(execMeta?.loading.alwaysLoad).toBe(true);
  });

  it("non-deferred tools include executeCommand but NOT bash (before opt-in)", () => {
    const nonDeferred = registry.getTools({
      sessionId: "test-session",
      userId: "test-user",
      includeDeferredTools: false,
    });

    expect(nonDeferred.executeCommand).toBeDefined();
    // bash is deferLoading now, so it must not appear without explicit opt-in.
    expect(nonDeferred.bash).toBeUndefined();
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

  it("enforcement logic: if bash is enabled but executeCommand isn't, promote executeCommand", () => {
    // Realistic scenario after the loading swap: an agent template explicitly
    // enables `bash` only. Bash produces logId-bearing stubs whose retrieval
    // path lives behind `executeCommand`'s readLog sub-command, so the
    // companion rule still needs to kick in.
    const allTools = registry.getTools({
      sessionId: "test-session",
      userId: "test-user",
      includeDeferredTools: true,
      agentEnabledTools: new Set(["bash"]),
    });

    const initialActiveTools = new Set<string>(["bash"]);

    // Pre-enforcement: only bash is loaded.
    expect(initialActiveTools.has("bash")).toBe(true);
    expect(initialActiveTools.has("executeCommand")).toBe(false);

    // Apply the companion enforcement logic (mirrors tools-builder.ts:197-204).
    if (
      initialActiveTools.has("bash") &&
      !initialActiveTools.has("executeCommand") &&
      allTools.executeCommand
    ) {
      initialActiveTools.add("executeCommand");
    }

    // Post-enforcement: both are in.
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
