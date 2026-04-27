import { beforeEach, describe, expect, it, vi } from "vitest";

const aiMocks = vi.hoisted(() => ({
  generateText: vi.fn(async () => ({ text: "Enhanced prompt output" })),
}));

const resolverMocks = vi.hoisted(() => ({
  resolveSessionUtilityModel: vi.fn(() => ({ id: "session-utility" })),
  getSessionProviderTemperature: vi.fn(() => 0.3),
  resolveSessionUtilityModelForSession: vi.fn(async () => ({ id: "session-utility" })),
  getSessionProviderTemperatureForSession: vi.fn(async () => 0.3),
}));

const memoryMocks = vi.hoisted(() => ({
  formatMemoriesForPrompt: vi.fn(() => ({
    markdown: "- Keep outputs concise\n- Keep outputs concise",
    tokenEstimate: 20,
    memoryCount: 2,
  })),
}));

const vectorMocks = vi.hoisted(() => ({
  searchWithRouter: vi.fn(async () => [
    {
      relativePath: "lib/example.ts",
      text: "export function demo() { return true; }",
      chunkIndex: 0,
      score: 0.91,
      startLine: 1,
      endLine: 1,
    },
  ]),
}));

const fileTreeMocks = vi.hoisted(() => ({
  getFileTreeForAgent: vi.fn(async () => []),
  formatFileTreeCompact: vi.fn(() => ""),
}));

vi.mock("ai", () => ({ generateText: aiMocks.generateText }));
vi.mock("@/lib/ai/session-model-resolver", () => resolverMocks);
vi.mock("@/lib/agent-memory/prompt-injection", () => memoryMocks);
vi.mock("@/lib/vectordb", () => vectorMocks);
vi.mock("@/lib/vectordb/client", () => ({ isVectorDBEnabled: () => true }));
vi.mock("@/lib/vectordb/sync-service", () => ({
  getSyncFolders: vi.fn(async () => [{ id: "folder-1" }]),
}));
vi.mock("@/lib/ai/file-tree", () => fileTreeMocks);

import { enhancePromptWithLLM } from "@/lib/ai/prompt-enhancement-v2";

describe("enhancePromptWithLLM stateless memory behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("injects memories on every call (stateless contract)", async () => {
    await enhancePromptWithLLM("Improve this task", "char-1", {
      sessionId: "session-a",
      sessionMetadata: { sessionProvider: "codex", sessionUtilityModel: "gpt-5.1-codex" },
      includeMemories: true,
    });

    await enhancePromptWithLLM("Improve this task", "char-1", {
      sessionId: "session-a",
      sessionMetadata: { sessionProvider: "codex", sessionUtilityModel: "gpt-5.1-codex" },
      includeMemories: true,
    });

    const firstPrompt = aiMocks.generateText.mock.calls[0][0].messages.at(-1).content as string;
    const secondPrompt = aiMocks.generateText.mock.calls[1][0].messages.at(-1).content as string;

    // Under the stateless contract both calls must include the memory block.
    // The normalizer still dedups duplicate bullets within a single payload.
    expect(firstPrompt).toContain("<memories");
    expect(firstPrompt.match(/- Keep outputs concise/g)?.length).toBe(1);

    expect(secondPrompt).toContain("<memories");
    expect(secondPrompt.match(/- Keep outputs concise/g)?.length).toBe(1);
  });

  it("keeps memory injection isolated across different sessions", async () => {
    await enhancePromptWithLLM("Improve this task", "char-1", {
      sessionId: "session-a",
      includeMemories: true,
    });

    await enhancePromptWithLLM("Improve this task", "char-1", {
      sessionId: "session-b",
      includeMemories: true,
    });

    const firstPrompt = aiMocks.generateText.mock.calls[0][0].messages.at(-1).content as string;
    const secondPrompt = aiMocks.generateText.mock.calls[1][0].messages.at(-1).content as string;

    expect(firstPrompt).toContain("<memories");
    expect(secondPrompt).toContain("<memories");
  });

  it("preserves a 6-message dbMessages window (no silent truncation to 3)", async () => {
    const dbMessages = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `WINDOW_MSG_${String(i).padStart(2, "0")} body text`,
      orderingIndex: i + 1,
    }));

    await enhancePromptWithLLM("Improve this", "char-1", {
      sessionId: "session-window",
      dbMessages,
      includeMemories: false,
      includeFileTree: false,
    });

    const prompt = aiMocks.generateText.mock.calls[0][0].messages.at(-1).content as string;
    // All 6 stamps must appear — the old code would clip to just the last 3.
    for (let i = 0; i < 6; i++) {
      expect(prompt).toContain(`WINDOW_MSG_${String(i).padStart(2, "0")}`);
    }
  });

  it("resolves utility model from session metadata", async () => {
    await enhancePromptWithLLM("Improve this task", "char-1", {
      sessionId: "session-a",
      sessionMetadata: { sessionProvider: "codex", sessionUtilityModel: "gpt-5.3-codex-medium" },
      includeMemories: false,
    });

    expect(resolverMocks.resolveSessionUtilityModelForSession).toHaveBeenCalledWith({
      sessionProvider: "codex",
      sessionUtilityModel: "gpt-5.3-codex-medium",
    });
    expect(resolverMocks.getSessionProviderTemperatureForSession).toHaveBeenCalled();
  });
});
