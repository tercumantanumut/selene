/**
 * Regression test: Composer draft must anchor the enhancement target.
 *
 * Bug symptom: with >10 session messages, the enhancer would rewrite the prior
 * chat history instead of the fresh composer text. Root causes:
 *   1. Composer text placed under a generic heading, not a machine-readable tag.
 *   2. Session history rendered in a way that mimicked a fresh user request.
 *   3. Double-slice in V2 (.slice(-3)) clipped the route's curated pair window.
 *   4. In-memory session accumulator leaked prior enhance turns into new ones.
 *
 * This test locks the fix: composer text lives inside <composer_prompt>, is
 * rendered BEFORE session history, history is in ascending orderingIndex order
 * inside <session_history>, and the enhancer call carries a single user message
 * (no accumulator across calls).
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
    markdown: "",
    tokenEstimate: 0,
    memoryCount: 0,
  })),
}));

const vectorMocks = vi.hoisted(() => ({
  searchWithRouter: vi.fn(async () => []),
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

/**
 * Build a >10-message synthetic session with distinctive, verbose user/assistant
 * content so the test can assert ordering and position by substring index-of.
 */
function build12MessageSession() {
  const msgs: Array<{ role: "user" | "assistant"; content: string; orderingIndex: number }> = [];
  for (let i = 0; i < 12; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    const stamp = `ORDERED_MSG_${String(i).padStart(2, "0")}`;
    const body = role === "user"
      ? `${stamp} Please refactor the entire OAuth2 module to support PKCE with dynamic client registration.`
      : `${stamp} Here is a detailed plan that touches ten files across the auth layer and introduces a new middleware.`;
    msgs.push({ role, content: body, orderingIndex: i + 1 });
  }
  return msgs;
}

const COMPOSER_TEXT = "fix typo in README";

describe("prompt enhancer — composer anchor & stateless ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    aiMocks.generateText.mockResolvedValue({ text: "enhanced output" });
  });

  it("wraps composer text in <composer_prompt> verbatim", async () => {
    const history = build12MessageSession();

    await enhancePromptWithLLM(COMPOSER_TEXT, "char-x", {
      sessionId: "session-regression",
      dbMessages: history,
      includeMemories: false,
      includeFileTree: false,
    });

    expect(aiMocks.generateText).toHaveBeenCalledTimes(1);
    const userPrompt = aiMocks.generateText.mock.calls[0][0].messages.at(-1).content as string;

    expect(userPrompt).toMatch(/<composer_prompt>[\s\S]*fix typo in README[\s\S]*<\/composer_prompt>/);
  });

  it("places <composer_prompt> BEFORE <session_history>", async () => {
    const history = build12MessageSession();

    await enhancePromptWithLLM(COMPOSER_TEXT, "char-x", {
      sessionId: "session-regression",
      dbMessages: history,
      includeMemories: false,
      includeFileTree: false,
    });

    const userPrompt = aiMocks.generateText.mock.calls[0][0].messages.at(-1).content as string;

    const composerIdx = userPrompt.indexOf("<composer_prompt>");
    const historyIdx = userPrompt.indexOf("<session_history");

    expect(composerIdx).toBeGreaterThanOrEqual(0);
    expect(historyIdx).toBeGreaterThanOrEqual(0);
    expect(composerIdx).toBeLessThan(historyIdx);
  });

  it("places the task instruction ABOVE all tagged sections (highest attention)", async () => {
    const history = build12MessageSession();

    await enhancePromptWithLLM(COMPOSER_TEXT, "char-x", {
      sessionId: "session-regression",
      dbMessages: history,
      includeMemories: false,
      includeFileTree: false,
    });

    const userPrompt = aiMocks.generateText.mock.calls[0][0].messages.at(-1).content as string;

    const taskIdx = userPrompt.indexOf("## Your Task");
    const composerIdx = userPrompt.indexOf("<composer_prompt>");
    const historyIdx = userPrompt.indexOf("<session_history");

    expect(taskIdx).toBeGreaterThanOrEqual(0);
    expect(composerIdx).toBeGreaterThanOrEqual(0);
    expect(historyIdx).toBeGreaterThanOrEqual(0);
    // Task instruction must appear before BOTH composer and history so the
    // model reads "what to do" before it sees "what to read".
    expect(taskIdx).toBeLessThan(composerIdx);
    expect(taskIdx).toBeLessThan(historyIdx);
  });

  it("renders session history in ascending orderingIndex order", async () => {
    const history = build12MessageSession();

    await enhancePromptWithLLM(COMPOSER_TEXT, "char-x", {
      sessionId: "session-regression",
      dbMessages: history,
      includeMemories: false,
      includeFileTree: false,
    });

    const userPrompt = aiMocks.generateText.mock.calls[0][0].messages.at(-1).content as string;

    // Extract the history block
    const historyMatch = userPrompt.match(/<session_history[^>]*>([\s\S]*?)<\/session_history>/);
    expect(historyMatch).not.toBeNull();
    const historyBlock = historyMatch![1];

    // Collect every ORDERED_MSG_XX stamp that actually appears in the block, in
    // the order they appear. Then assert that order is strictly ascending.
    const stampRegex = /ORDERED_MSG_(\d{2})/g;
    const seen: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = stampRegex.exec(historyBlock)) !== null) {
      seen.push(Number(m[1]));
    }

    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    }
  });

  it("caps history at MAX_HISTORY_MESSAGES (6) — no silent truncation to 3", async () => {
    const history = build12MessageSession();

    await enhancePromptWithLLM(COMPOSER_TEXT, "char-x", {
      sessionId: "session-regression",
      dbMessages: history,
      includeMemories: false,
      includeFileTree: false,
    });

    const userPrompt = aiMocks.generateText.mock.calls[0][0].messages.at(-1).content as string;
    const historyMatch = userPrompt.match(/<session_history[^>]*>([\s\S]*?)<\/session_history>/);
    const historyBlock = historyMatch ? historyMatch[1] : "";

    // Count distinct ORDERED_MSG_XX stamps in the rendered block
    const stamps = new Set<string>();
    for (const m of historyBlock.matchAll(/ORDERED_MSG_\d{2}/g)) {
      stamps.add(m[0]);
    }

    // Should include the latest 6 messages (indices 06..11), not just 3.
    expect(stamps.size).toBe(6);
    expect(stamps.has("ORDERED_MSG_11")).toBe(true);
    expect(stamps.has("ORDERED_MSG_06")).toBe(true);
    // The earliest 6 must NOT be present — we keep the latest 6.
    expect(stamps.has("ORDERED_MSG_00")).toBe(false);
  });

  it("renders client conversationContext fallback when DB history is empty", async () => {
    const fallbackHistory = build12MessageSession().map(({ role, content }) => ({ role, content }));

    await enhancePromptWithLLM(COMPOSER_TEXT, "char-x", {
      sessionId: "session-fallback",
      dbMessages: [],
      conversationContext: fallbackHistory,
      includeMemories: false,
      includeFileTree: false,
    });

    const userPrompt = aiMocks.generateText.mock.calls[0][0].messages.at(-1).content as string;
    const historyMatch = userPrompt.match(/<session_history[^>]*>([\s\S]*?)<\/session_history>/);
    expect(historyMatch).not.toBeNull();
    const historyBlock = historyMatch![1];

    expect(historyBlock).toContain("ORDERED_MSG_06");
    expect(historyBlock).toContain("ORDERED_MSG_11");
    expect(historyBlock).not.toContain("ORDERED_MSG_00");
  });

  it("omits session_history gracefully when no chat history exists", async () => {
    await enhancePromptWithLLM(COMPOSER_TEXT, "char-x", {
      sessionId: "session-empty-history",
      dbMessages: [],
      conversationContext: [],
      includeMemories: false,
      includeFileTree: false,
    });

    const userPrompt = aiMocks.generateText.mock.calls[0][0].messages.at(-1).content as string;
    expect(userPrompt).not.toMatch(/<session_history[^>]*>[\s\S]*?<\/session_history>/);
    expect(userPrompt).toContain("<composer_prompt>");
  });

  it("does not emit a bare **User:** line for history ABOVE <composer_prompt>", async () => {
    const history = build12MessageSession();

    await enhancePromptWithLLM(COMPOSER_TEXT, "char-x", {
      sessionId: "session-regression",
      dbMessages: history,
      includeMemories: false,
      includeFileTree: false,
    });

    const userPrompt = aiMocks.generateText.mock.calls[0][0].messages.at(-1).content as string;
    const composerIdx = userPrompt.indexOf("<composer_prompt>");
    const prefix = userPrompt.slice(0, composerIdx);

    // The old renderer prefixed each history turn with `**User:**` / `**Assistant:**`
    // as a freestanding line. Those must not appear in the prefix that precedes
    // the composer tag — that's what fooled the LLM.
    expect(prefix).not.toMatch(/^\*\*User:\*\*/m);
    expect(prefix).not.toMatch(/^\*\*Assistant:\*\*/m);
  });

  it("is stateless: two sequential calls with the same sessionId each send exactly one user message", async () => {
    const history = build12MessageSession();

    await enhancePromptWithLLM("first composer text", "char-x", {
      sessionId: "session-regression",
      dbMessages: history,
      includeMemories: false,
      includeFileTree: false,
    });

    await enhancePromptWithLLM("second composer text", "char-x", {
      sessionId: "session-regression",
      dbMessages: history,
      includeMemories: false,
      includeFileTree: false,
    });

    expect(aiMocks.generateText).toHaveBeenCalledTimes(2);

    for (const call of aiMocks.generateText.mock.calls) {
      const messages = call[0].messages;
      // Stateless: exactly one message per call, role=user, no accumulator.
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("user");
    }

    // Second call must NOT include the first call's enhanced output or request.
    const secondPrompt = aiMocks.generateText.mock.calls[1][0].messages[0].content as string;
    expect(secondPrompt).toContain("second composer text");
    expect(secondPrompt).not.toContain("first composer text");
    expect(secondPrompt).not.toContain("enhanced output");
  });

  it("renders current attachment context as a reference-only section below the composer prompt", async () => {
    await enhancePromptWithLLM(COMPOSER_TEXT, "char-x", {
      sessionId: "session-regression",
      dbMessages: [],
      includeMemories: false,
      includeFileTree: false,
      currentAttachmentContext: "### Current composer attachments\n- [Image: mockup.png | image/png | url: /api/media/mockup.png]",
    });

    const userPrompt = aiMocks.generateText.mock.calls[0][0].messages.at(-1).content as string;
    const composerIdx = userPrompt.indexOf("<composer_prompt>");
    const attachmentIdx = userPrompt.indexOf("<current_attachments");

    expect(attachmentIdx).toBeGreaterThan(composerIdx);
    expect(userPrompt).toMatch(/<current_attachments[^>]*note="[^"]*[Rr]eference only/);
    expect(userPrompt).toContain("mockup.png");
  });

  it("reference sections (session_history / memories / file_tree) are tagged as non-target", async () => {
    memoryMocks.formatMemoriesForPrompt.mockReturnValueOnce({
      markdown: "- User prefers concise output",
      tokenEstimate: 10,
      memoryCount: 1,
    });
    fileTreeMocks.formatFileTreeCompact.mockReturnValueOnce("## File Tree\n- lib/example.ts");

    const history = build12MessageSession();

    await enhancePromptWithLLM(COMPOSER_TEXT, "char-x", {
      sessionId: "session-regression",
      dbMessages: history,
      includeMemories: true,
      includeFileTree: true,
    });

    const userPrompt = aiMocks.generateText.mock.calls[0][0].messages.at(-1).content as string;

    // Every reference section must carry a "reference only / do not rewrite"
    // marker so the model can't mistake it for the enhancement target.
    expect(userPrompt).toMatch(/<session_history[^>]*note="[^"]*[Rr]eference only/);
    expect(userPrompt).toMatch(/<memories[^>]*note="[^"]*[Rr]eference only/);
    // file_tree is optional depending on includeFileTree + content
    if (userPrompt.includes("<file_tree")) {
      expect(userPrompt).toMatch(/<file_tree[^>]*note="[^"]*[Rr]eference only/);
    }
  });
});
