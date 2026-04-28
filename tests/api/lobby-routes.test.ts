import { NextResponse } from "next/server";
import { z, type ZodType } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiHelperMocks = vi.hoisted(() => ({
  withLobbyAuth: vi.fn(async () => ({ userId: "user-1" })),
}));

const lobbiesQueryMocks = vi.hoisted(() => ({
  createLobby: vi.fn(),
  createSeat: vi.fn(),
  getLobbyTemplate: vi.fn(),
  listLobbiesForUser: vi.fn(),
  createLobbyTemplate: vi.fn(),
  listLobbyTemplatesForUser: vi.fn(),
}));

const sessionMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
}));

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

  const lobbyConfigV1Schema = z
    .object({
      version: z.literal(1),
      maxParallel: z.number().int().positive().optional(),
      defaultMaxAttempts: z.number().int().positive().optional(),
      plannerCharacterId: z.string().optional(),
      synthesizerCharacterId: z.string().optional(),
      plannerPromptOverride: z.string().optional(),
      synthesisPromptOverride: z.string().optional(),
    })
    .strict();

  return {
    withLobbyAuth: apiHelperMocks.withLobbyAuth,
    isAuthResponse: (ctx: unknown) => ctx instanceof NextResponse,
    permissionScopeV1Schema,
    lobbyConfigV1Schema,
    parseBody: async <T,>(req: Request, schema: ZodType<T>) => {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return {
          ok: false,
          response: NextResponse.json(
            { error: "Invalid JSON body." },
            { status: 400 },
          ),
        };
      }

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
    errorResponse: (error: unknown, fallbackMessage: string) =>
      NextResponse.json(
        { error: error instanceof Error ? error.message : fallbackMessage },
        { status: 500 },
      ),
  };
});
vi.mock("@/lib/lobbies/queries", () => lobbiesQueryMocks);
vi.mock("@/lib/db/queries-sessions", () => sessionMocks);

import { POST as createLobbyPost } from "@/app/api/lobbies/route";
import { POST as createTemplatePost } from "@/app/api/lobby-templates/route";

describe("lobby API routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    sessionMocks.createSession.mockResolvedValue({ id: "session-1" });
    lobbiesQueryMocks.createLobby.mockResolvedValue({
      id: "lobby-1",
      config: { version: 1 },
    });
    lobbiesQueryMocks.createSeat.mockImplementation(async (input) => ({
      id: `seat-${input.position}`,
      ...input,
    }));
  });

  it("materializes template prompts into lobby config while preserving explicit config", async () => {
    lobbiesQueryMocks.getLobbyTemplate.mockResolvedValue({
      id: "template-1",
      userId: null,
      visibility: "public",
      defaultSeats: [],
      planningPrompt: "template planning prompt",
      synthesisPrompt: "template synthesis prompt",
    });

    const response = await createLobbyPost(
      new Request("http://localhost/api/lobbies", {
        method: "POST",
        body: JSON.stringify({
          title: "Build it",
          goal: "Ship a thing",
          templateId: "template-1",
          config: {
            version: 1,
            maxParallel: 2,
            plannerPromptOverride: "captain planning prompt",
          },
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(lobbiesQueryMocks.createLobby).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: "template-1",
        config: {
          version: 1,
          plannerPromptOverride: "captain planning prompt",
          synthesisPromptOverride: "template synthesis prompt",
          maxParallel: 2,
        },
      }),
    );
  });

  it("rejects template default seats that try to pin arbitrary agents", async () => {
    const response = await createTemplatePost(
      new Request("http://localhost/api/lobby-templates", {
        method: "POST",
        body: JSON.stringify({
          name: "Unsafe template",
          defaultSeats: [
            {
              role: "Worker",
              required: true,
              position: 0,
              agentId: "character-from-another-user",
              permissionScope: {
                version: 1,
                mode: "tool_list",
                allowedTools: ["readFile"],
              },
            },
          ],
          planningPrompt: "plan",
          synthesisPrompt: "synth",
          config: { version: 1 },
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Invalid input" });
    expect(lobbiesQueryMocks.createLobbyTemplate).not.toHaveBeenCalled();
  });
});
