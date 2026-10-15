import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(async () => "user-1"),
  getSession: vi.fn(),
  getSessionMessagesFingerprint: vi.fn(),
  checkContextWindow: vi.fn(),
}));

vi.mock("@/lib/auth/local-auth", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/db/queries", () => ({
  getSession: mocks.getSession,
  getSessionMessagesFingerprint: mocks.getSessionMessagesFingerprint,
}));
vi.mock("@/lib/ai/session-model-resolver", () => ({
  getSessionModelIdForSession: vi.fn(async () => "model-1"),
  getSessionProviderForSession: vi.fn(async () => "anthropic"),
}));
vi.mock("@/lib/context-window", () => ({
  ContextWindowManager: { checkContextWindow: mocks.checkContextWindow },
}));

import { GET } from "@/app/api/sessions/[id]/context-status/route";

const call = (id: string) =>
  GET(new Request(`http://localhost/api/sessions/${id}/context-status`) as any, {
    params: Promise.resolve({ id }),
  });

describe("GET /api/sessions/[id]/context-status cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ id: "s", metadata: {}, updatedAt: "t1", summary: null });
    mocks.checkContextWindow.mockResolvedValue({
      usagePercentage: 0.5,
      status: "safe",
      currentTokens: 100,
      maxInputTokens: 200,
      maxTokens: 200,
      maxOutputTokens: 10,
      formatted: {},
      thresholds: {},
      shouldCompact: false,
      mustCompact: false,
      recommendedAction: "",
    });
  });

  it("skips recomputation while the message fingerprint is unchanged", async () => {
    mocks.getSessionMessagesFingerprint.mockResolvedValue("3:2026-01-01");

    const first = await (await call("cache-a")).json();
    const second = await (await call("cache-a")).json();

    expect(mocks.checkContextWindow).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("recomputes when messages change", async () => {
    mocks.getSessionMessagesFingerprint.mockResolvedValueOnce("3:2026-01-01");
    await call("cache-b");
    mocks.getSessionMessagesFingerprint.mockResolvedValueOnce("4:2026-01-02");
    await call("cache-b");

    expect(mocks.checkContextWindow).toHaveBeenCalledTimes(2);
  });
});
