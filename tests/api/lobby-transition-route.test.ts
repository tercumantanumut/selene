import { NextResponse } from "next/server";
import { z, type ZodType } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiHelperMocks = vi.hoisted(() => ({
  withLobbyAuth: vi.fn(async () => ({ userId: "user-1" })),
  assertLobbyOwnershipAndVersion: vi.fn(),
}));

const serviceMocks = vi.hoisted(() => ({
  completeSynthesis: vi.fn(),
  transitionLobbyAbort: vi.fn(),
  transitionLobbyAcceptPlan: vi.fn(),
  transitionLobbyEnterReview: vi.fn(),
  transitionLobbyReadyRoster: vi.fn(),
  transitionLobbyStartSynthesis: vi.fn(),
}));

const orchestratorMocks = vi.hoisted(() => ({
  queueSoloStoryAgentRun: vi.fn(),
}));

vi.mock("@/lib/config/internal-api-secret", () => ({
  INTERNAL_API_SECRET: "test-internal-secret",
}));

vi.mock("@/lib/lobbies/orchestrator", () => orchestratorMocks);

vi.mock("@/lib/lobbies/services", () => serviceMocks);

vi.mock("@/lib/lobbies/api-helpers", () => {
  const permissionScopeV1Schema = z
    .object({
      version: z.literal(1),
      mode: z.literal("tool_list"),
      allowedTools: z.array(z.string()),
      deniedTools: z.array(z.string()).optional(),
      allowedFolderIds: z.array(z.string()).optional(),
    })
    .strict();

  return {
    withLobbyAuth: apiHelperMocks.withLobbyAuth,
    assertLobbyOwnershipAndVersion: apiHelperMocks.assertLobbyOwnershipAndVersion,
    isAuthResponse: (ctx: unknown) => ctx instanceof NextResponse,
    permissionScopeV1Schema,
    expectedVersionField: z.number().int().nonnegative(),
    parseBody: async <T,>(req: Request, schema: ZodType<T>) => {
      const body = await req.json();
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        return {
          ok: false,
          response: NextResponse.json(
            { error: "Invalid input", details: parsed.error.flatten() },
            { status: 400 },
          ),
        };
      }
      return { ok: true, data: parsed.data };
    },
    mapMutationResult: <T,>(result: { ok: true; row: T } | { ok: false; message: string; reason: string }) => {
      if (result.ok) return NextResponse.json(result.row);
      return NextResponse.json({ error: result.message, reason: result.reason }, { status: 422 });
    },
    errorResponse: (error: unknown, fallbackMessage = "Failed") =>
      NextResponse.json(
        { error: error instanceof Error ? error.message : fallbackMessage },
        { status: 500 },
      ),
  };
});

import { POST as transitionPost } from "@/app/api/lobbies/[lobbyId]/transition/route";

describe("lobby transition route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.completeSynthesis.mockResolvedValue({
      ok: true,
      row: { id: "lobby-1", status: "completed" },
    });
    serviceMocks.transitionLobbyStartSynthesis.mockResolvedValue({
      ok: true,
      row: {
        lobby: { id: "lobby-1", lockVersion: 8 },
        synthesisRun: { id: "synthesis-run-1" },
      },
    });
  });

  it("allows internal complete_synthesis without lobby session auth", async () => {
    const response = await transitionPost(
      new Request("http://localhost/api/lobbies/lobby-1/transition", {
        method: "POST",
        headers: { "X-Internal-Auth": "test-internal-secret" },
        body: JSON.stringify({
          action: "complete_synthesis",
          synthesisRunId: "synthesis-run-1",
          outputArtifactId: "artifact-1",
        }),
      }),
      { params: Promise.resolve({ lobbyId: "lobby-1" }) },
    );

    expect(response.status).toBe(200);
    expect(apiHelperMocks.withLobbyAuth).not.toHaveBeenCalled();
    expect(serviceMocks.completeSynthesis).toHaveBeenCalledWith({
      lobbyId: "lobby-1",
      synthesisRunId: "synthesis-run-1",
      outputArtifactId: "artifact-1",
    });
  });

  it("keeps captain auth and versions on start_synthesis while returning immediately after queueing", async () => {
    const response = await transitionPost(
      new Request("http://localhost/api/lobbies/lobby-1/transition", {
        method: "POST",
        body: JSON.stringify({
          action: "start_synthesis",
          expectedVersion: 7,
        }),
      }),
      { params: Promise.resolve({ lobbyId: "lobby-1" }) },
    );

    expect(response.status).toBe(200);
    expect(apiHelperMocks.withLobbyAuth).toHaveBeenCalledTimes(1);
    expect(serviceMocks.transitionLobbyStartSynthesis).toHaveBeenCalledWith({
      lobbyId: "lobby-1",
      userId: "user-1",
      expectedLobbyVersion: 7,
    });
    expect(orchestratorMocks.queueSoloStoryAgentRun).toHaveBeenCalledWith("synthesis-run-1");
  });
});
