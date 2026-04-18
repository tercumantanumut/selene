/**
 * Regression test for the mid-stream user-injection fix.
 *
 * Context: users typing while an assistant is mid-stream used to have their
 * message disappear after the stream ended, accompanied by a
 * `tapClientLookup: Index N out of bounds` crash from `@assistant-ui/store`.
 *
 * Root cause: the converter hid injected-user DB rows AND merged adjacent
 * sealed + continuation assistants, producing a DB→UI shape shorter than
 * the live in-memory thread. When the post-stream force reload pushed the
 * shorter list into `setMessages`, the store's cached cursor pointed past
 * the new end → crash + permanently lost message.
 *
 * Fix: keep injected-user rows as first-class visible messages. The
 * injected user then sits between the two assistants, preventing adjacency
 * (so assistant-ui's branch picker heuristic never fires) and making the
 * DB-derived shape match the live shape byte-for-byte.
 *
 * These tests pin the new converter contract so we don't silently regress.
 */

import { describe, it, expect } from "vitest";
import {
  convertDBMessagesToUIMessages,
  countVisibleConversationMessages,
  hasLivePromptInjectedMessages,
  type DBMessage,
} from "@/lib/messages/converter";

function makeInjectionRows(): DBMessage[] {
  return [
    {
      id: "u1",
      role: "user",
      content: [{ type: "text", text: "do a long task" }],
      createdAt: "2026-04-18T10:00:00.000Z",
      orderingIndex: 1,
    },
    {
      id: "a-sealed",
      role: "assistant",
      content: [{ type: "text", text: "Working..." }],
      createdAt: "2026-04-18T10:00:10.000Z",
      orderingIndex: 2,
      metadata: { livePromptInjected: true },
    },
    {
      id: "u-inj",
      role: "user",
      content: [{ type: "text", text: "Wait, also check X" }],
      createdAt: "2026-04-18T10:00:20.000Z",
      orderingIndex: 3,
      metadata: { livePromptInjected: true },
    },
    {
      id: "a-cont",
      role: "assistant",
      content: [{ type: "text", text: "Checking X now." }],
      createdAt: "2026-04-18T10:00:30.000Z",
      orderingIndex: 4,
    },
  ];
}

describe("converter: live-prompt injection rows are visible and un-merged", () => {
  it("emits 4 UIMessages in DB order", () => {
    const ui = convertDBMessagesToUIMessages(makeInjectionRows());
    expect(ui.map((m) => m.id)).toEqual(["u1", "a-sealed", "u-inj", "a-cont"]);
    expect(ui.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("output shape matches the live in-memory shape (no truncation under assistant-ui cursor)", () => {
    const ui = convertDBMessagesToUIMessages(makeInjectionRows());
    // Live thread during a mid-stream injection holds exactly four entries
    // by id: original user, sealed assistant, injected user, continuation
    // assistant. The DB→UI converter must match that shape so that
    // `handleForegroundRunFinished`'s force reload does not truncate under
    // `@assistant-ui/store`'s cached cursor.
    expect(ui).toHaveLength(4);
    expect(ui.map((m) => ({ id: m.id, role: m.role }))).toEqual([
      { id: "u1", role: "user" },
      { id: "a-sealed", role: "assistant" },
      { id: "u-inj", role: "user" },
      { id: "a-cont", role: "assistant" },
    ]);
  });

  it("produces no adjacent assistant pairs (branch-picker guard)", () => {
    const ui = convertDBMessagesToUIMessages(makeInjectionRows());
    let adjacentAssistantPairs = 0;
    for (let i = 1; i < ui.length; i++) {
      if (ui[i - 1].role === "assistant" && ui[i].role === "assistant") {
        adjacentAssistantPairs++;
      }
    }
    expect(adjacentAssistantPairs).toBe(0);
  });

  it("counts injected users as visible conversation messages (reconciliation parity)", () => {
    // Converter-level count is the reconciliation count — it must equal the
    // live thread length so the deferral predicate in
    // `shouldDeferLivePromptForegroundReconciliation` does not over- or
    // under-shoot once the fix lands.
    expect(countVisibleConversationMessages(makeInjectionRows())).toBe(4);
  });

  it("still flags injected histories via hasLivePromptInjectedMessages", () => {
    // Downstream reconciliation still needs to distinguish injected vs
    // non-injected histories; the helper must return true whenever any row
    // (sealed assistant or injected user) carries the metadata flag.
    expect(hasLivePromptInjectedMessages(makeInjectionRows())).toBe(true);

    const plainRows: DBMessage[] = [
      {
        id: "u1",
        role: "user",
        content: [{ type: "text", text: "hi" }],
        createdAt: "2026-04-18T10:00:00.000Z",
        orderingIndex: 1,
      },
      {
        id: "a1",
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        createdAt: "2026-04-18T10:00:01.000Z",
        orderingIndex: 2,
      },
    ];
    expect(hasLivePromptInjectedMessages(plainRows)).toBe(false);
  });

  it("preserves each assistant segment's text distinctly (no merge)", () => {
    const ui = convertDBMessagesToUIMessages(makeInjectionRows());
    const text = (i: number) =>
      (ui[i].parts as Array<{ type: string; text?: string }>)
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("");
    expect(text(1)).toBe("Working...");
    expect(text(3)).toBe("Checking X now.");
    expect(text(1)).not.toContain("Checking X now.");
  });

  it("handles multiple injections by keeping each injected user visible and each assistant distinct", () => {
    const multiInjectionRows: DBMessage[] = [
      {
        id: "u1",
        role: "user",
        content: [{ type: "text", text: "start" }],
        createdAt: "2026-04-18T10:00:00.000Z",
        orderingIndex: 1,
      },
      {
        id: "a1",
        role: "assistant",
        content: [{ type: "text", text: "working step 1" }],
        createdAt: "2026-04-18T10:00:01.000Z",
        orderingIndex: 2,
        metadata: { livePromptInjected: true },
      },
      {
        id: "u2",
        role: "user",
        content: [{ type: "text", text: "also X" }],
        createdAt: "2026-04-18T10:00:02.000Z",
        orderingIndex: 3,
        metadata: { livePromptInjected: true },
      },
      {
        id: "a2",
        role: "assistant",
        content: [{ type: "text", text: "ok, adding X" }],
        createdAt: "2026-04-18T10:00:03.000Z",
        orderingIndex: 4,
        metadata: { livePromptInjected: true },
      },
      {
        id: "u3",
        role: "user",
        content: [{ type: "text", text: "and Y" }],
        createdAt: "2026-04-18T10:00:04.000Z",
        orderingIndex: 5,
        metadata: { livePromptInjected: true },
      },
      {
        id: "a3",
        role: "assistant",
        content: [{ type: "text", text: "done with X and Y" }],
        createdAt: "2026-04-18T10:00:05.000Z",
        orderingIndex: 6,
      },
    ];

    const ui = convertDBMessagesToUIMessages(multiInjectionRows);
    expect(ui).toHaveLength(6);
    expect(ui.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);

    let adjacentAssistantPairs = 0;
    for (let i = 1; i < ui.length; i++) {
      if (ui[i - 1].role === "assistant" && ui[i].role === "assistant") {
        adjacentAssistantPairs++;
      }
    }
    expect(adjacentAssistantPairs).toBe(0);
  });
});
