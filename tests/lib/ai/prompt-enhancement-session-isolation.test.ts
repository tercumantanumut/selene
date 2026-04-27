/**
 * Prompt enhancement is stateless — two enhance calls sharing a sessionId do
 * NOT share any in-memory state (message accumulator, memory signatures, etc).
 *
 * This test locks the Option B contract: every enhance click builds a fresh
 * request from scratch. If a future change reintroduces an in-memory session
 * store, this test will fail, forcing an explicit design decision.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const aiMocks = vi.hoisted(() => ({
  generateText: vi.fn(async () => ({ text: "enhanced output" })),
}));

const resolverMocks = vi.hoisted(() => ({
  resolveSessionUtilityModelForSession: vi.fn(async () => ({ id: "session-utility" })),
  getSessionProviderTemperatureForSession: vi.fn(async () => 0.3),
}));

const memoryMocks = vi.hoisted(() => ({
  formatMemoriesForPrompt: vi.fn(() => ({
    markdown: "- Keep outputs concise",
    tokenEstimate: 10,
    memoryCount: 1,
  })),
}));

vi.mock("ai", () => ({ generateText: aiMocks.generateText }));
vi.mock("@/lib/ai/session-model-resolver", () => resolverMocks);
vi.mock("@/lib/agent-memory/prompt-injection", () => memoryMocks);
vi.mock("@/lib/vectordb", () => ({ searchWithRouter: vi.fn(async () => []) }));
vi.mock("@/lib/vectordb/client", () => ({ isVectorDBEnabled: () => true }));
vi.mock("@/lib/vectordb/sync-service", () => ({
  getSyncFolders: vi.fn(async () => [{ id: "folder-1" }]),
}));
vi.mock("@/lib/ai/file-tree", () => ({
  getFileTreeForAgent: vi.fn(async () => []),
  formatFileTreeCompact: vi.fn(() => ""),
}));

import { enhancePromptWithLLM } from "@/lib/ai/prompt-enhancement-v2";
import * as enhancementLLM from "@/lib/ai/prompt-enhancement-llm";

describe("prompt enhancement is stateless", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not export any in-memory session store API", () => {
    // The accumulator + memory-signature helpers are intentionally gone.
    // If you're adding them back, you're also reintroducing the composer-anchor
    // regression — stop and reconsider.
    expect((enhancementLLM as Record<string, unknown>).getEnhancementSession).toBeUndefined();
    expect((enhancementLLM as Record<string, unknown>).addSessionMessage).toBeUndefined();
    expect((enhancementLLM as Record<string, unknown>).clearPromptEnhancementSession).toBeUndefined();
    expect((enhancementLLM as Record<string, unknown>).getSessionMemorySignature).toBeUndefined();
    expect((enhancementLLM as Record<string, unknown>).setSessionMemorySignature).toBeUndefined();
  });

  it("sends exactly one user message per call, regardless of shared sessionId", async () => {
    await enhancePromptWithLLM("first request", "char-1", { sessionId: "shared" });
    await enhancePromptWithLLM("second request", "char-1", { sessionId: "shared" });
    await enhancePromptWithLLM("third request", "char-1", { sessionId: "shared" });

    expect(aiMocks.generateText).toHaveBeenCalledTimes(3);
    for (const call of aiMocks.generateText.mock.calls) {
      const messages = call[0].messages as Array<{ role: string; content: string }>;
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("user");
    }

    // Third call must not contain text from the first or second.
    const thirdContent = aiMocks.generateText.mock.calls[2][0].messages[0].content as string;
    expect(thirdContent).toContain("third request");
    expect(thirdContent).not.toContain("first request");
    expect(thirdContent).not.toContain("second request");
    expect(thirdContent).not.toContain("enhanced output");
  });

  it("injects memories freshly on every call (no signature cache)", async () => {
    await enhancePromptWithLLM("request a", "char-1", {
      sessionId: "shared",
      includeMemories: true,
    });
    await enhancePromptWithLLM("request b", "char-1", {
      sessionId: "shared",
      includeMemories: true,
    });

    const firstContent = aiMocks.generateText.mock.calls[0][0].messages[0].content as string;
    const secondContent = aiMocks.generateText.mock.calls[1][0].messages[0].content as string;

    // Under the stateless contract, every call re-injects memories. Compare
    // to the old behavior, where the second call would dedupe and omit them.
    expect(firstContent).toContain("Keep outputs concise");
    expect(secondContent).toContain("Keep outputs concise");
  });
});
