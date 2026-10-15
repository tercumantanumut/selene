import { describe, expect, it } from "vitest";
import { useSessionSyncStore, type SessionSyncData } from "@/lib/stores/session-sync-store";

const session = (id: string, title = "t"): SessionSyncData => ({
  id,
  title,
  characterId: "char-1",
  updatedAt: "2026-01-01T00:00:00.000Z",
  messageCount: 2,
});

describe("session-sync-store setSessions", () => {
  it("leaves state untouched when the snapshot is unchanged", () => {
    const store = useSessionSyncStore.getState();
    store.setSessions([session("a"), session("b")], "char-1");
    const before = useSessionSyncStore.getState();

    useSessionSyncStore.getState().setSessions([session("a"), session("b")], "char-1");
    const after = useSessionSyncStore.getState();

    expect(after.lastRefreshAt).toBe(before.lastRefreshAt);
    expect(after.sessionsById).toBe(before.sessionsById);
  });

  it("applies real changes", () => {
    useSessionSyncStore.getState().setSessions([session("a")], "char-1");
    useSessionSyncStore.getState().setSessions([session("a", "renamed")], "char-1");

    expect(useSessionSyncStore.getState().sessionsById.get("a")?.title).toBe("renamed");
  });

  it("applies removals for a character", () => {
    useSessionSyncStore.getState().setSessions([session("a"), session("b")], "char-1");
    useSessionSyncStore.getState().setSessions([session("a")], "char-1");

    expect(useSessionSyncStore.getState().sessionsByCharacter.get("char-1")).toEqual(new Set(["a"]));
  });
});
