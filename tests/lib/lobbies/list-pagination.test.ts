import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db/sqlite-client";
import { lobbies } from "@/lib/db/sqlite-lobbies-schema";
import { sessions, users } from "@/lib/db/sqlite-schema-base";
import {
  decodeLobbyListCursor,
  listLobbiesForUser,
} from "@/lib/lobbies/queries";

const TEST_USER_ID = "test-lobby-pagination-user";
const TEST_SESSION_PREFIX = "test-lobby-pagination-session-";
const TEST_LOBBY_PREFIX = "test-lobby-pagination-";
const SHARED_UPDATED_AT = "2026-04-28T00:00:00.000Z";

async function seedLobby(id: string, title: string): Promise<void> {
  const sessionId = `${TEST_SESSION_PREFIX}${id}`;
  await db.insert(sessions).values({
    id: sessionId,
    userId: TEST_USER_ID,
    title: `${title} session`,
    status: "active",
  });
  await db.insert(lobbies).values({
    id,
    userId: TEST_USER_ID,
    sessionId,
    title,
    goal: `Goal for ${title}`,
    status: "roster",
    config: { version: 1 },
    updatedAt: SHARED_UPDATED_AT,
  });
}

describe("listLobbiesForUser pagination", () => {
  const lobbyIds = [
    `${TEST_LOBBY_PREFIX}a`,
    `${TEST_LOBBY_PREFIX}b`,
    `${TEST_LOBBY_PREFIX}c`,
  ];

  beforeAll(async () => {
    await db.insert(users).values({
      id: TEST_USER_ID,
      email: `${TEST_USER_ID}@example.com`,
    });
    await seedLobby(lobbyIds[0], "Alpha");
    await seedLobby(lobbyIds[1], "Beta");
    await seedLobby(lobbyIds[2], "Gamma");
  });

  afterAll(async () => {
    await db.delete(lobbies).where(inArray(lobbies.id, lobbyIds));
    await db.delete(sessions).where(
      inArray(
        sessions.id,
        lobbyIds.map((id) => `${TEST_SESSION_PREFIX}${id}`),
      ),
    );
    await db.delete(users).where(eq(users.id, TEST_USER_ID));
  });

  it("uses updatedAt plus id so same-timestamp boundary rows are not skipped", async () => {
    const firstPage = await listLobbiesForUser({
      userId: TEST_USER_ID,
      limit: 2,
    });

    expect(firstPage.lobbies.map((lobby) => lobby.id)).toEqual([
      `${TEST_LOBBY_PREFIX}c`,
      `${TEST_LOBBY_PREFIX}b`,
    ]);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(decodeLobbyListCursor(firstPage.nextCursor!)).toEqual({
      updatedAt: SHARED_UPDATED_AT,
      id: `${TEST_LOBBY_PREFIX}b`,
    });

    const secondPage = await listLobbiesForUser({
      userId: TEST_USER_ID,
      limit: 2,
      cursor: firstPage.nextCursor!,
    });

    expect(secondPage.lobbies.map((lobby) => lobby.id)).toEqual([
      `${TEST_LOBBY_PREFIX}a`,
    ]);
    expect(secondPage.nextCursor).toBeNull();
  });
});
