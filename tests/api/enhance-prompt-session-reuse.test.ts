import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  requireAuth: vi.fn(async () => {}),
  getLocalUser: vi.fn(async () => ({ id: "user-123" })),
}));

const dbMocks = vi.hoisted(() => ({
  getOrCreateCharacterSession: vi.fn(),
  createSession: vi.fn(),
  getSessionByMetadataKey: vi.fn(),
  getSession: vi.fn(),
}));

const messagesMocks = vi.hoisted(() => ({
  getMessages: vi.fn(async () => []),
}));

const characterMocks = vi.hoisted(() => ({
  getCharacter: vi.fn(async () => null),
}));

const observabilityMocks = vi.hoisted(() => ({
  createAgentRun: vi.fn(async () => ({ id: "run-1" })),
  completeAgentRun: vi.fn(async () => {}),
  withRunContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
}));

const enhancementMocks = vi.hoisted(() => ({
  enhancePromptWithLLM: vi.fn(async () => ({
    enhanced: true,
    prompt: "enhanced",
    originalQuery: "input",
    filesFound: 0,
    chunksRetrieved: 0,
    usedLLM: true,
  })),
  enhancePrompt: vi.fn(async () => ({
    enhanced: true,
    prompt: "heuristic",
    originalQuery: "input",
    filesFound: 0,
    chunksRetrieved: 0,
    expandedConcepts: [],
    dependenciesResolved: [],
  })),
}));

vi.mock("@/lib/auth/local-auth", () => authMocks);
vi.mock("@/lib/db/queries", () => dbMocks);
vi.mock("@/lib/db/queries-messages", () => messagesMocks);
vi.mock("@/lib/characters/queries", () => characterMocks);
vi.mock("@/lib/observability", () => observabilityMocks);
vi.mock("@/lib/ai/prompt-enhancement-v2", () => ({
  enhancePromptWithLLM: enhancementMocks.enhancePromptWithLLM,
}));
vi.mock("@/lib/ai/prompt-enhancement", () => ({
  enhancePrompt: enhancementMocks.enhancePrompt,
}));

import { POST } from "@/app/api/enhance-prompt/route";

describe("POST /api/enhance-prompt session reuse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.getSession.mockResolvedValue(null);
    messagesMocks.getMessages.mockResolvedValue([]);
  });

  it("reuses stable metadata-keyed session for non-character enhance requests", async () => {
    dbMocks.getSessionByMetadataKey.mockResolvedValue({
      id: "existing-session",
      metadata: {
        type: "prompt-enhancement",
        key: "prompt-enhancement:user-123",
      },
    });

    const req = new Request("http://localhost/api/enhance-prompt", {
      method: "POST",
      body: JSON.stringify({ input: "Improve this", useLLM: true }),
      headers: { "content-type": "application/json" },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expect(dbMocks.getSessionByMetadataKey).toHaveBeenCalledWith(
      "user-123",
      "prompt-enhancement",
      "prompt-enhancement:user-123"
    );
    expect(dbMocks.createSession).not.toHaveBeenCalled();
    expect(enhancementMocks.enhancePromptWithLLM).toHaveBeenCalled();

    const llmOptions = enhancementMocks.enhancePromptWithLLM.mock.calls[0][2];
    expect(llmOptions.sessionId).toBe("existing-session");
  });

  it("creates metadata-keyed session when none exists", async () => {
    dbMocks.getSessionByMetadataKey.mockResolvedValue(null);
    dbMocks.createSession.mockResolvedValue({
      id: "new-session",
      metadata: {
        type: "prompt-enhancement",
        key: "prompt-enhancement:user-123",
      },
    });

    const req = new Request("http://localhost/api/enhance-prompt", {
      method: "POST",
      body: JSON.stringify({ input: "Improve this", useLLM: true }),
      headers: { "content-type": "application/json" },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expect(dbMocks.createSession).toHaveBeenCalledWith({
      title: "Prompt Enhancement",
      userId: "user-123",
      metadata: {
        type: "prompt-enhancement",
        key: "prompt-enhancement:user-123",
      },
    });
  });

  it("uses provided sessionId when it belongs to the current user", async () => {
    dbMocks.getSession.mockResolvedValue({
      id: "chat-session-1",
      userId: "user-123",
      metadata: { sessionProvider: "codex", sessionUtilityModel: "gpt-5.3-codex-medium" },
    });

    const req = new Request("http://localhost/api/enhance-prompt", {
      method: "POST",
      body: JSON.stringify({
        input: "Improve this",
        sessionId: "chat-session-1",
        useLLM: true,
      }),
      headers: { "content-type": "application/json" },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expect(dbMocks.getSession).toHaveBeenCalledWith("chat-session-1");
    expect(dbMocks.getSessionByMetadataKey).not.toHaveBeenCalled();
    expect(dbMocks.createSession).not.toHaveBeenCalled();

    const llmOptions = enhancementMocks.enhancePromptWithLLM.mock.calls[0][2];
    expect(llmOptions.sessionId).toBe("chat-session-1");
    expect(llmOptions.sessionMetadata).toEqual({
      sessionProvider: "codex",
      sessionUtilityModel: "gpt-5.3-codex-medium",
    });
  });

  it("passes dbMessages in ascending orderingIndex order for a >10-message session", async () => {
    dbMocks.getSession.mockResolvedValue({
      id: "chat-session-long",
      userId: "user-123",
      metadata: {},
      title: "Long chat",
    });

    // Build 12 messages and deliberately return them in REVERSE order from
    // the (mocked) DB to prove the route re-sorts defensively. `orderingIndex`
    // is the canonical source of truth — insertion order must be ignored.
    const fullHistory = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `CHRONO_${String(i).padStart(2, "0")} message body` }],
      metadata: null,
      orderingIndex: i + 1,
      id: `msg-${i}`,
      sessionId: "chat-session-long",
    }));
    messagesMocks.getMessages.mockResolvedValue([...fullHistory].reverse() as never);

    const req = new Request("http://localhost/api/enhance-prompt", {
      method: "POST",
      body: JSON.stringify({
        input: "fix typo in README",
        sessionId: "chat-session-long",
        useLLM: true,
      }),
      headers: { "content-type": "application/json" },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);

    const llmOptions = enhancementMocks.enhancePromptWithLLM.mock.calls[0][2];
    const dbMessages: Array<{ role: string; content: string }> = llmOptions.dbMessages;

    // The route's pair-walk keeps the last 3 user/assistant pairs — up to 6 messages.
    expect(dbMessages.length).toBeGreaterThan(3);
    expect(dbMessages.length).toBeLessThanOrEqual(6);

    // Every surviving message must be from the tail of the chronological list,
    // and they must be in strict ascending CHRONO_XX order.
    const stamps = dbMessages.map((m) => {
      const match = m.content.match(/CHRONO_(\d{2})/);
      return match ? Number(match[1]) : -1;
    });
    for (const s of stamps) expect(s).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i]).toBeGreaterThan(stamps[i - 1]);
    }

    // The LAST surviving message should correspond to the highest orderingIndex.
    expect(stamps[stamps.length - 1]).toBe(11);
  });

  it("falls through to metadata-keyed session when provided sessionId is not owned by user", async () => {
    dbMocks.getSession.mockResolvedValue({
      id: "chat-session-1",
      userId: "someone-else",
      metadata: {},
    });
    dbMocks.getSessionByMetadataKey.mockResolvedValue({
      id: "fallback-session",
      metadata: { type: "prompt-enhancement", key: "prompt-enhancement:user-123" },
    });

    const req = new Request("http://localhost/api/enhance-prompt", {
      method: "POST",
      body: JSON.stringify({
        input: "Improve this",
        sessionId: "chat-session-1",
        useLLM: true,
      }),
      headers: { "content-type": "application/json" },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expect(enhancementMocks.enhancePromptWithLLM).toHaveBeenCalled();
    const llmOptions = enhancementMocks.enhancePromptWithLLM.mock.calls[0][2];
    expect(llmOptions.sessionId).toBe("fallback-session");
  });
});
