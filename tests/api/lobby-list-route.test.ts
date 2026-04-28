import { NextResponse } from "next/server";
import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiHelperMocks = vi.hoisted(() => ({
  withLobbyAuth: vi.fn(async () => ({ userId: "user-1" })),
}));

const lobbiesQueryMocks = vi.hoisted(() => ({
  listLobbiesForUser: vi.fn(),
}));

vi.mock("@/lib/lobbies/api-helpers", () => ({
  withLobbyAuth: apiHelperMocks.withLobbyAuth,
  isAuthResponse: (ctx: unknown) => ctx instanceof NextResponse,
  errorResponse: (error: unknown, fallbackMessage: string) =>
    NextResponse.json(
      { error: error instanceof Error ? error.message : fallbackMessage },
      { status: 500 },
    ),
  lobbyConfigV1Schema: z.object({ version: z.literal(1) }).strict(),
  parseBody: vi.fn(),
  permissionScopeV1Schema: z
    .object({
      version: z.literal(1),
      mode: z.literal("tool_list"),
      allowedTools: z.array(z.string()),
    })
    .strict(),
}));

vi.mock("@/lib/lobbies/queries", () => ({
  createLobby: vi.fn(),
  createSeat: vi.fn(),
  getLobbyTemplate: vi.fn(),
  listLobbiesForUser: lobbiesQueryMocks.listLobbiesForUser,
}));

vi.mock("@/lib/db/queries-sessions", () => ({
  createSession: vi.fn(),
}));

import { GET as listLobbiesGet } from "@/app/api/lobbies/route";

describe("GET /api/lobbies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lobbiesQueryMocks.listLobbiesForUser.mockResolvedValue({
      lobbies: [],
      nextCursor: null,
    });
  });

  it("forwards composite cursors unchanged to the repository", async () => {
    const response = await listLobbiesGet({
      nextUrl: new URL(
        "http://localhost/api/lobbies?cursor=2026-04-28T00%3A00%3A00.000Z%7Clobby-b&limit=2",
      ),
    } as never);

    expect(response.status).toBe(200);
    expect(lobbiesQueryMocks.listLobbiesForUser).toHaveBeenCalledWith({
      userId: "user-1",
      status: undefined,
      cursor: "2026-04-28T00:00:00.000Z|lobby-b",
      limit: 2,
    });
  });
});
