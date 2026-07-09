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

  it("includes image and attachment references from persisted chat history", async () => {
    dbMocks.getSession.mockResolvedValue({
      id: "chat-session-with-attachments",
      userId: "user-123",
      metadata: {},
      title: "Attachment chat",
    });

    messagesMocks.getMessages.mockResolvedValue([
      {
        role: "user",
        content: [
          { type: "text", text: "Use the uploaded mockup and spec for the enhancement." },
          {
            type: "image",
            image: "/api/media/sessions/chat-session-with-attachments/uploads/mockup.png",
            displayName: "mockup.png",
            mediaType: "image/png",
          },
        ],
        metadata: {
          custom: {
            attachments: [
              {
                name: "spec.pdf",
                contentType: "application/pdf",
                url: "/api/media/sessions/chat-session-with-attachments/uploads/spec.pdf",
                filePath: "/tmp/spec.pdf",
                size: 1234,
              },
            ],
          },
        },
        orderingIndex: 1,
        id: "msg-attachment",
        sessionId: "chat-session-with-attachments",
      },
    ] as never);

    const req = new Request("http://localhost/api/enhance-prompt", {
      method: "POST",
      body: JSON.stringify({
        input: "enhance with all context",
        sessionId: "chat-session-with-attachments",
        useLLM: true,
      }),
      headers: { "content-type": "application/json" },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);

    const llmOptions = enhancementMocks.enhancePromptWithLLM.mock.calls[0][2];
    const dbMessages: Array<{ role: string; content: string }> = llmOptions.dbMessages;
    expect(dbMessages).toHaveLength(1);
    expect(dbMessages[0].content).toContain("Use the uploaded mockup and spec");
    expect(dbMessages[0].content).toContain("[Image: mockup.png");
    expect(dbMessages[0].content).toContain("/api/media/sessions/chat-session-with-attachments/uploads/mockup.png");
    expect(dbMessages[0].content).toContain("[Attachment: spec.pdf");
    expect(dbMessages[0].content).toContain("/tmp/spec.pdf");
  });

  it("passes current composer attachment references to the LLM enhancer", async () => {
    dbMocks.getSession.mockResolvedValue({
      id: "chat-session-current-attachments",
      userId: "user-123",
      metadata: {},
      title: "Current attachment chat",
    });

    const req = new Request("http://localhost/api/enhance-prompt", {
      method: "POST",
      body: JSON.stringify({
        input: "describe this screenshot",
        sessionId: "chat-session-current-attachments",
        useLLM: true,
        currentAttachments: [
          {
            name: "current-screenshot.png",
            contentType: "image/png",
            url: "/api/media/sessions/chat-session-current-attachments/uploads/current-screenshot.png",
            filePath: "/tmp/current-screenshot.png",
            size: 4321,
            status: "complete",
          },
        ],
      }),
      headers: { "content-type": "application/json" },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);

    const llmOptions = enhancementMocks.enhancePromptWithLLM.mock.calls[0][2];
    expect(llmOptions.currentAttachmentContext).toContain("Current composer attachments");
    expect(llmOptions.currentAttachmentContext).toContain("[Image: current-screenshot.png");
    expect(llmOptions.currentAttachmentContext).toContain("/tmp/current-screenshot.png");
    expect(llmOptions.currentAttachmentContext).toContain("status: complete");
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
