import { describe, it, expect, vi } from "vitest";
import { createSdkToolResultBridge } from "@/app/api/chat/sdk-tool-result-bridge";

describe("createSdkToolResultBridge", () => {
  it("resolves a waiter that was registered before the result is published", async () => {
    const bridge = createSdkToolResultBridge();
    const pending = bridge.waitFor("call-1");
    bridge.publish("call-1", { ok: true }, "Bash");
    await expect(pending).resolves.toEqual({ output: { ok: true }, toolName: "Bash" });
  });

  it("resolves immediately when the result was published before the wait", async () => {
    const bridge = createSdkToolResultBridge();
    bridge.publish("call-2", "done");
    await expect(bridge.waitFor("call-2")).resolves.toEqual({ output: "done" });
  });

  it("consumes a buffered result (second wait does not see it)", async () => {
    const bridge = createSdkToolResultBridge();
    bridge.publish("call-3", 1);
    await bridge.waitFor("call-3");
    // Second wait should time out → undefined.
    await expect(bridge.waitFor("call-3", { timeoutMs: 250 })).resolves.toBeUndefined();
  });

  it("returns undefined when the timeout elapses", async () => {
    const bridge = createSdkToolResultBridge();
    await expect(bridge.waitFor("never", { timeoutMs: 250 })).resolves.toBeUndefined();
  });

  it("returns undefined immediately for an already-aborted signal", async () => {
    const bridge = createSdkToolResultBridge();
    const controller = new AbortController();
    controller.abort();
    await expect(bridge.waitFor("x", { abortSignal: controller.signal })).resolves.toBeUndefined();
  });

  it("resolves undefined when aborted mid-wait", async () => {
    const bridge = createSdkToolResultBridge();
    const controller = new AbortController();
    const pending = bridge.waitFor("y", { timeoutMs: null, abortSignal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
  });

  it("dispose resolves all pending waiters with undefined", async () => {
    const bridge = createSdkToolResultBridge();
    const a = bridge.waitFor("a", { timeoutMs: null });
    const b = bridge.waitFor("b", { timeoutMs: null });
    bridge.dispose?.();
    await expect(a).resolves.toBeUndefined();
    await expect(b).resolves.toBeUndefined();
  });

  it("ignores publish/wait with an empty toolCallId", async () => {
    const bridge = createSdkToolResultBridge();
    bridge.publish("", { ignored: true });
    await expect(bridge.waitFor("")).resolves.toBeUndefined();
  });
});
