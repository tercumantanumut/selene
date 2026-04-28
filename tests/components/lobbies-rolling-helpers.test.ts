import { describe, expect, it } from "vitest";

import { topoSortCards } from "@/components/lobbies/rolling/dag-overlay";
import {
  isRollingKanbanManualDropTarget,
  projectColumns,
} from "@/components/lobbies/rolling/kanban-board";
import type {
  LobbyCard,
  LobbyCardDependency,
} from "@/lib/db/sqlite-lobbies-schema";

function card(overrides: Partial<LobbyCard> & Pick<LobbyCard, "id" | "column" | "position">): LobbyCard {
  return {
    id: overrides.id,
    lobbyId: "lobby-1",
    column: overrides.column,
    title: overrides.title ?? overrides.id,
    description: "",
    acceptanceCriteria: [],
    assignedSeatId: null,
    position: overrides.position,
    status: overrides.status ?? "pending",
    agentRunId: null,
    output: null,
    failureReason: null,
    reviewNotes: null,
    reviewedByUserId: null,
    attemptCount: 0,
    maxAttempts: 3,
    lockVersion: 1,
    createdBy: "human",
    startedAt: null,
    completedAt: null,
    reviewedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function dependency(cardId: string, dependsOnCardId: string): LobbyCardDependency {
  return {
    lobbyId: "lobby-1",
    cardId,
    dependsOnCardId,
    optional: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("rolling kanban helpers", () => {
  it("does not expose server-controlled columns as manual drop targets", () => {
    const isTarget = (containerId: string) =>
      isRollingKanbanManualDropTarget(true, {
        containerId,
        index: 0,
      });

    expect(isTarget("backlog")).toBe(true);
    expect(isTarget("ready")).toBe(true);
    expect(isTarget("blocked")).toBe(true);
    expect(isTarget("in_progress")).toBe(false);
    expect(isTarget("review")).toBe(false);
    expect(isTarget("done")).toBe(false);
    expect(
      isRollingKanbanManualDropTarget(false, {
        containerId: "backlog",
        index: 0,
      }),
    ).toBe(false);
  });

  it("projects optimistic moves at the queued before-card insertion point", () => {
    const cards = [
      card({ id: "a", column: "ready", position: 0 }),
      card({ id: "b", column: "ready", position: 1 }),
      card({ id: "c", column: "ready", position: 2 }),
    ];
    const optimisticMoves = new Map([
      [
        "c",
        {
          toColumn: "ready",
          beforeCardId: "a",
        },
      ],
    ]);

    expect(projectColumns(cards, optimisticMoves).ready.map((c) => c.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });
});

describe("topoSortCards", () => {
  it("assigns multi-parent nodes max parent depth plus one", () => {
    const cards = [
      card({ id: "root", column: "backlog", position: 0 }),
      card({ id: "parent", column: "backlog", position: 1 }),
      card({ id: "deep-parent", column: "backlog", position: 2 }),
      card({ id: "child", column: "backlog", position: 3 }),
    ];
    const dependencies = [
      dependency("parent", "root"),
      dependency("deep-parent", "parent"),
      dependency("child", "root"),
      dependency("child", "deep-parent"),
    ];

    const { sorted, unsorted } = topoSortCards(cards, dependencies);
    const child = sorted.find((row) => row.card.id === "child");

    expect(unsorted).toEqual([]);
    expect(child?.depth).toBe(3);
  });
});
