import { beforeEach, describe, expect, it } from "vitest";
import {
  createMessage,
  createSession,
  getOrCreateLocalUser,
  updateMessage,
} from "@/lib/db/queries";
import { getSessionMessagesSince } from "@/lib/db/queries-sessions";

describe("messages.updated_at and getSessionMessagesSince", () => {
  const TEST_USER_ID = "updated-at-user";

  beforeEach(async () => {
    await getOrCreateLocalUser(TEST_USER_ID, "updated-at@example.com");
  });

  it("stamps rows on insert and update and returns only rows changed since the cursor", async () => {
    const session = await createSession({ title: "Incremental", userId: TEST_USER_ID });
    if (!session) throw new Error("Failed to create session");

    const first = await createMessage({
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "hello" }],
      orderingIndex: 1,
    });
    const second = await createMessage({
      sessionId: session.id,
      role: "assistant",
      content: [{ type: "text", text: "partial" }],
      orderingIndex: 2,
    });
    if (!first || !second) throw new Error("Failed to create messages");
    expect(first.updatedAt).toBeTruthy();

    const cursor = new Date(Date.now() + 1).toISOString();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await updateMessage(second.id, {
      content: [{ type: "text", text: "partial and more" }],
    });
    expect(updated?.updatedAt && updated.updatedAt > cursor).toBe(true);

    const delta = await getSessionMessagesSince(session.id, cursor);

    expect(delta?.ids).toEqual([first.id, second.id]);
    expect(delta?.messages.map((m) => m.id)).toEqual([second.id]);
    expect(delta?.messages[0].content).toEqual([{ type: "text", text: "partial and more" }]);
  });

  it("returns null for an unknown session", async () => {
    expect(await getSessionMessagesSince("missing-session", new Date().toISOString())).toBeNull();
  });
});
