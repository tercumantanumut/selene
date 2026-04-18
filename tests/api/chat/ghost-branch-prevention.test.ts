/**
 * Ghost Branch Prevention – Unit Tests
 *
 * Tests for the DB-level behavior that causes ghost branches when injected
 * messages are loaded mid-run during background processing.
 *
 * The ghost branch occurs when:
 *   1. A live prompt is injected mid-run (prepareStep splits the assistant message)
 *   2. The frontend reloads messages before isRunActiveRef is armed
 *   3. assistant-ui sees the split assistant + injected user as a branch fork
 *
 * These tests validate the DB message structure after injection and ensure the
 * injected messages are correctly marked with livePromptInjected metadata.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createSession,
  createMessage,
  getMessages,
  getOrCreateLocalUser,
  deleteMessagesNotIn,
  getInjectedMessageIds,
  getSessionWithMessages,
} from "@/lib/db/queries";
import { nextOrderingIndex } from "@/lib/session/message-ordering";
import {
  convertDBMessagesToUIMessages,
  countVisibleConversationMessages,
} from "@/lib/messages/converter";
import { createSyncStreamingMessage } from "@/app/api/chat/streaming-progress";
import type { StreamingMessageState } from "@/app/api/chat/streaming-state";

describe("Ghost Branch Prevention", () => {
  const TEST_USER_ID = "test-ghost-branch";
  const TEST_EMAIL = "ghost-branch@test.local";

  beforeEach(async () => {
    await getOrCreateLocalUser(TEST_USER_ID, TEST_EMAIL);
  });

  /**
   * Validates the core message structure after a live prompt injection.
   * prepareStep creates:
   *   - Pre-injection assistant (sealed, tagged livePromptInjected)
   *   - Injected user message (tagged livePromptInjected)
   *   - Post-injection assistant (new message, no injection tag)
   */
  it("should correctly structure messages after live prompt injection", async () => {
    const session = await createSession({ title: "Ghost Branch - Structure", userId: TEST_USER_ID });
    if (!session) throw new Error("Failed to create session");

    // Original user message
    await createMessage({
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "Original prompt" }],
      orderingIndex: await nextOrderingIndex(session.id),
    });

    // Pre-injection assistant (sealed by prepareStep, tagged)
    const preInjectionAssistant = await createMessage({
      sessionId: session.id,
      role: "assistant",
      content: [{ type: "text", text: "I was working on your request..." }],
      orderingIndex: await nextOrderingIndex(session.id),
      metadata: { livePromptInjected: true },
    });

    // Injected user message (created by prepareStep)
    const injectedUser = await createMessage({
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "Also check the other file" }],
      orderingIndex: await nextOrderingIndex(session.id),
      metadata: { livePromptInjected: true },
    });

    // Post-injection assistant (continuation after injection)
    const postInjectionAssistant = await createMessage({
      sessionId: session.id,
      role: "assistant",
      content: [{ type: "text", text: "Sure, I'll also check that file." }],
      orderingIndex: await nextOrderingIndex(session.id),
    });

    const allMessages = await getMessages(session.id);
    expect(allMessages).toHaveLength(4);

    // Verify ordering is correct
    expect(allMessages[0].role).toBe("user");
    expect(allMessages[1].role).toBe("assistant");
    expect(allMessages[2].role).toBe("user");
    expect(allMessages[3].role).toBe("assistant");

    // Verify injection metadata
    const msg1Meta = typeof allMessages[1].metadata === "string"
      ? JSON.parse(allMessages[1].metadata) : allMessages[1].metadata;
    expect(msg1Meta?.livePromptInjected).toBe(true);

    const msg2Meta = typeof allMessages[2].metadata === "string"
      ? JSON.parse(allMessages[2].metadata) : allMessages[2].metadata;
    expect(msg2Meta?.livePromptInjected).toBe(true);

    // Post-injection assistant should NOT have injection metadata
    const msg3Meta = typeof allMessages[3].metadata === "string"
      ? JSON.parse(allMessages[3].metadata) : allMessages[3].metadata;
    expect(msg3Meta?.livePromptInjected).not.toBe(true);
  });

  /**
   * getInjectedMessageIds should return both the sealed assistant and injected
   * user messages, so deleteMessagesNotIn doesn't delete them.
   */
  it("should return injected message IDs for both assistant and user injection messages", async () => {
    const session = await createSession({ title: "Ghost Branch - InjectedIds", userId: TEST_USER_ID });
    if (!session) throw new Error("Failed to create session");

    await createMessage({
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "Original" }],
      orderingIndex: await nextOrderingIndex(session.id),
    });

    const preAssistant = await createMessage({
      sessionId: session.id,
      role: "assistant",
      content: [{ type: "text", text: "Working..." }],
      orderingIndex: await nextOrderingIndex(session.id),
      metadata: { livePromptInjected: true },
    });

    const injectedUser = await createMessage({
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "Injected follow-up" }],
      orderingIndex: await nextOrderingIndex(session.id),
      metadata: { livePromptInjected: true },
    });

    const postAssistant = await createMessage({
      sessionId: session.id,
      role: "assistant",
      content: [{ type: "text", text: "Acknowledged." }],
      orderingIndex: await nextOrderingIndex(session.id),
    });

    const injectedIds = await getInjectedMessageIds(session.id);

    expect(injectedIds).toContain(preAssistant!.id);
    expect(injectedIds).toContain(injectedUser!.id);
    // Post-injection assistant should NOT be in injected IDs
    expect(injectedIds).not.toContain(postAssistant!.id);
  });

  /**
   * deleteMessagesNotIn should NOT delete injection-tagged messages even when
   * the frontend doesn't know about them (they were created server-side).
   */
  it("should protect injected messages from deleteMessagesNotIn when added to keepIds", async () => {
    const session = await createSession({ title: "Ghost Branch - DeleteProtection", userId: TEST_USER_ID });
    if (!session) throw new Error("Failed to create session");

    const originalUser = await createMessage({
      id: crypto.randomUUID(),
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "Original" }],
      orderingIndex: await nextOrderingIndex(session.id),
    });

    const preAssistant = await createMessage({
      sessionId: session.id,
      role: "assistant",
      content: [{ type: "text", text: "Pre-injection content" }],
      orderingIndex: await nextOrderingIndex(session.id),
      metadata: { livePromptInjected: true },
    });

    const injectedUser = await createMessage({
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "Mid-run instruction" }],
      orderingIndex: await nextOrderingIndex(session.id),
      metadata: { livePromptInjected: true },
    });

    const postAssistant = await createMessage({
      id: crypto.randomUUID(),
      sessionId: session.id,
      role: "assistant",
      content: [{ type: "text", text: "Post-injection content" }],
      orderingIndex: await nextOrderingIndex(session.id),
    });

    // Frontend only knows about original user + post-injection assistant
    const frontendIds = new Set([originalUser!.id, postAssistant!.id]);

    // Add injected IDs (what the route does)
    const injectedIds = await getInjectedMessageIds(session.id);
    for (const id of injectedIds) {
      frontendIds.add(id);
    }

    const deleted = await deleteMessagesNotIn(session.id, frontendIds);
    expect(deleted).toBe(0);

    const remaining = await getMessages(session.id);
    expect(remaining).toHaveLength(4);
  });

  /**
   * UI conversion renders all four rows (original user + sealed assistant +
   * injected user + continuation assistant). Because the injected user sits
   * BETWEEN the two assistants, they are not adjacent, so assistant-ui's
   * sibling branch heuristic ("← 2 / 2 →" picker) does not fire — the
   * ghost-branch defense moves from "hide+merge" to "natural separator".
   */
  it("should render injected user messages and both assistant segments as distinct UIMessages", async () => {
    const session = await createSession({ title: "Ghost Branch - UIConversion", userId: TEST_USER_ID });
    if (!session) throw new Error("Failed to create session");

    await createMessage({
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "Original prompt" }],
      orderingIndex: await nextOrderingIndex(session.id),
    });

    await createMessage({
      sessionId: session.id,
      role: "assistant",
      content: [{ type: "text", text: "Pre-injection" }],
      orderingIndex: await nextOrderingIndex(session.id),
      metadata: { livePromptInjected: true },
    });

    await createMessage({
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "Injected mid-run" }],
      orderingIndex: await nextOrderingIndex(session.id),
      metadata: { livePromptInjected: true },
    });

    await createMessage({
      sessionId: session.id,
      role: "assistant",
      content: [{ type: "text", text: "Post-injection" }],
      orderingIndex: await nextOrderingIndex(session.id),
    });

    const dbMessages = await getMessages(session.id);
    const sessionWithMessages = await getSessionWithMessages(session.id);
    const uiMessages = convertDBMessagesToUIMessages(dbMessages as any);

    // DB-level `messageCount` column still excludes injected users (sidebar
    // semantics — a live-prompt injection does not add a new "turn" to the
    // conversation list). This is independent from the converter count.
    expect(sessionWithMessages?.session.messageCount).toBe(3);

    // Converter-level count includes injected users so reconciliation
    // predicates compare against the same shape the live thread holds.
    expect(countVisibleConversationMessages(dbMessages as any)).toBe(4);

    // UI-level: four distinct UIMessages in DB order — the injected user sits
    // between the two assistants, preventing adjacency and the branch picker.
    expect(uiMessages).toHaveLength(4);
    expect(uiMessages.map(m => m.role)).toEqual(["user", "assistant", "user", "assistant"]);

    // Both assistant segments remain distinct (no merge).
    const assistant1Text = uiMessages[1].parts
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("");
    const assistant2Text = uiMessages[3].parts
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("");
    expect(assistant1Text).toContain("Pre-injection");
    expect(assistant2Text).toContain("Post-injection");
    expect(assistant1Text).not.toContain("Post-injection");

    // The injected user message IS visible in UI.
    const hasInjectedUser = uiMessages.some(m =>
      m.parts.some((p: any) => p.type === "text" && p.text === "Injected mid-run")
    );
    expect(hasInjectedUser).toBe(true);

    // Branch-picker guard: no adjacent same-role pairs.
    let adjacentAssistantPairs = 0;
    for (let i = 1; i < uiMessages.length; i++) {
      if (uiMessages[i - 1].role === "assistant" && uiMessages[i].role === "assistant") {
        adjacentAssistantPairs++;
      }
    }
    expect(adjacentAssistantPairs).toBe(0);
  });

  /**
   * Multiple injections in a single run should all be handled correctly.
   */
  it("should handle multiple live prompt injections in a single run", async () => {
    const session = await createSession({ title: "Ghost Branch - MultiInjection", userId: TEST_USER_ID });
    if (!session) throw new Error("Failed to create session");

    await createMessage({
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "Start task" }],
      orderingIndex: await nextOrderingIndex(session.id),
    });

    // First injection
    await createMessage({
      sessionId: session.id,
      role: "assistant",
      content: [{ type: "text", text: "Working on step 1..." }],
      orderingIndex: await nextOrderingIndex(session.id),
      metadata: { livePromptInjected: true },
    });

    await createMessage({
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "Also do X" }],
      orderingIndex: await nextOrderingIndex(session.id),
      metadata: { livePromptInjected: true },
    });

    // Second injection
    await createMessage({
      sessionId: session.id,
      role: "assistant",
      content: [{ type: "text", text: "Got it, doing X and step 2..." }],
      orderingIndex: await nextOrderingIndex(session.id),
      metadata: { livePromptInjected: true },
    });

    await createMessage({
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "And Y too" }],
      orderingIndex: await nextOrderingIndex(session.id),
      metadata: { livePromptInjected: true },
    });

    // Final assistant response
    await createMessage({
      sessionId: session.id,
      role: "assistant",
      content: [{ type: "text", text: "Done with everything including X and Y." }],
      orderingIndex: await nextOrderingIndex(session.id),
    });

    const dbMessages = await getMessages(session.id);
    expect(dbMessages).toHaveLength(6);

    const injectedIds = await getInjectedMessageIds(session.id);
    // 4 injected: 2 sealed assistants + 2 injected users
    expect(injectedIds).toHaveLength(4);

    const uiMessages = convertDBMessagesToUIMessages(dbMessages as any);

    // All 6 rows render as distinct UIMessages in DB order:
    //   [user, assistant, user, assistant, user, assistant]
    // The injected users separate the assistant segments, so no two
    // assistants are adjacent → assistant-ui's branch picker does not fire.
    expect(uiMessages).toHaveLength(6);
    expect(uiMessages.map(m => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);

    // Each assistant segment retains its own text (no merge).
    const textOf = (i: number) =>
      uiMessages[i].parts
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("");
    expect(textOf(1)).toContain("Working on step 1...");
    expect(textOf(3)).toContain("Got it, doing X and step 2...");
    expect(textOf(5)).toContain("Done with everything including X and Y.");

    // Injected user content IS visible.
    const hasInjectedContent = uiMessages.some(m =>
      m.parts.some((p: any) =>
        p.type === "text" && (p.text === "Also do X" || p.text === "And Y too")
      )
    );
    expect(hasInjectedContent).toBe(true);

    // Branch-picker guard: no adjacent same-role pairs.
    let adjacentAssistantPairs = 0;
    for (let i = 1; i < uiMessages.length; i++) {
      if (uiMessages[i - 1].role === "assistant" && uiMessages[i].role === "assistant") {
        adjacentAssistantPairs++;
      }
    }
    expect(adjacentAssistantPairs).toBe(0);
  });

  /**
   * The ordering gap that occurs after injections should be detectable but
   * not cause issues with message retrieval.
   */
  it("should handle ordering gaps from deleted messages gracefully", async () => {
    const session = await createSession({ title: "Ghost Branch - OrderingGap", userId: TEST_USER_ID });
    if (!session) throw new Error("Failed to create session");

    // Create messages with non-contiguous ordering (simulating post-cleanup state)
    await createMessage({
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "Message 1" }],
      orderingIndex: 1,
    });

    await createMessage({
      sessionId: session.id,
      role: "assistant",
      content: [{ type: "text", text: "Message 2" }],
      orderingIndex: 2,
    });

    // Big gap (simulating many allocations that were deleted)
    await createMessage({
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "Message 3" }],
      orderingIndex: 1364,
    });

    await createMessage({
      sessionId: session.id,
      role: "assistant",
      content: [{ type: "text", text: "Message 4" }],
      orderingIndex: 1365,
    });

    const messages = await getMessages(session.id);
    expect(messages).toHaveLength(4);

    // Messages should be in correct order regardless of gap
    expect(messages[0].content[0].text).toBe("Message 1");
    expect(messages[1].content[0].text).toBe("Message 2");
    expect(messages[2].content[0].text).toBe("Message 3");
    expect(messages[3].content[0].text).toBe("Message 4");

    // UI conversion should work fine
    const uiMessages = convertDBMessagesToUIMessages(messages as any);
    expect(uiMessages).toHaveLength(4);
  });

  /**
   * Simulates the exact ghost branch scenario: messages loaded before
   * isRunActiveRef is set, then loaded again after. The injected messages
   * should produce a consistent message set both times.
   */
  it("should produce consistent UI messages regardless of load timing", async () => {
    const session = await createSession({ title: "Ghost Branch - Consistency", userId: TEST_USER_ID });
    if (!session) throw new Error("Failed to create session");

    await createMessage({
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "Original" }],
      orderingIndex: await nextOrderingIndex(session.id),
    });

    await createMessage({
      sessionId: session.id,
      role: "assistant",
      content: [{ type: "text", text: "Pre-injection segment" }],
      orderingIndex: await nextOrderingIndex(session.id),
      metadata: { livePromptInjected: true },
    });

    await createMessage({
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "Follow-up instruction" }],
      orderingIndex: await nextOrderingIndex(session.id),
      metadata: { livePromptInjected: true },
    });

    await createMessage({
      sessionId: session.id,
      role: "assistant",
      content: [{ type: "text", text: "Post-injection segment" }],
      orderingIndex: await nextOrderingIndex(session.id),
    });

    // Load 1: simulating early load (before isRunActiveRef is set)
    const dbMessages1 = await getMessages(session.id);
    const uiMessages1 = convertDBMessagesToUIMessages(dbMessages1 as any);

    // Load 2: simulating late load (after run completes)
    const dbMessages2 = await getMessages(session.id);
    const uiMessages2 = convertDBMessagesToUIMessages(dbMessages2 as any);

    // Both loads should produce identical UI message sets
    expect(uiMessages1.length).toBe(uiMessages2.length);
    expect(uiMessages1.map(m => m.id)).toEqual(uiMessages2.map(m => m.id));
    expect(uiMessages1.map(m => m.role)).toEqual(uiMessages2.map(m => m.role));
  });

  /**
   * Edge case: injection happens but the run is cancelled before post-injection
   * assistant content is generated. The sealed assistant and injected user should
   * still be in the DB.
   */
  it("should preserve injection artifacts even when run is cancelled before post-injection content", async () => {
    const session = await createSession({ title: "Ghost Branch - Cancelled", userId: TEST_USER_ID });
    if (!session) throw new Error("Failed to create session");

    await createMessage({
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "Start" }],
      orderingIndex: await nextOrderingIndex(session.id),
    });

    const sealedAssistant = await createMessage({
      sessionId: session.id,
      role: "assistant",
      content: [{ type: "text", text: "Was working but then cancelled" }],
      orderingIndex: await nextOrderingIndex(session.id),
      metadata: { livePromptInjected: true },
    });

    const injectedUser = await createMessage({
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "Do something else" }],
      orderingIndex: await nextOrderingIndex(session.id),
      metadata: { livePromptInjected: true },
    });

    // No post-injection assistant — run was cancelled

    const messages = await getMessages(session.id);
    expect(messages).toHaveLength(3);

    const injectedIds = await getInjectedMessageIds(session.id);
    expect(injectedIds).toContain(sealedAssistant!.id);
    expect(injectedIds).toContain(injectedUser!.id);

    // UI should show all three rows (original user + sealed assistant +
    // injected user). There's no continuation assistant because the run
    // was cancelled.
    const uiMessages = convertDBMessagesToUIMessages(messages as any);
    expect(uiMessages).toHaveLength(3);
    expect(uiMessages.map(m => m.role)).toEqual(["user", "assistant", "user"]);
    const injectedText = uiMessages[2].parts
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("");
    expect(injectedText).toContain("Do something else");
  });

  it("creates a distinct post-injection assistant row after background progress already persisted the pre-split row", async () => {
    const session = await createSession({ title: "Ghost Branch - Rotated Assistant Id", userId: TEST_USER_ID });
    if (!session) throw new Error("Failed to create session");

    await createMessage({
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "Research auth" }],
      orderingIndex: await nextOrderingIndex(session.id),
    });

    let assistantMessageId = crypto.randomUUID();
    const streamingState: StreamingMessageState = {
      parts: [{ type: "text", text: "Pre-injection assistant segment" }],
      toolCallParts: new Map(),
      loggedIncompleteToolCalls: new Set(),
      lastBroadcastAt: 0,
      lastBroadcastSignature: "",
      pendingBroadcast: false,
      isCreating: false,
    };

    const syncStreamingMessage = createSyncStreamingMessage({
      sessionId: session.id,
      userId: TEST_USER_ID,
      eventCharacterId: "character-test",
      scheduledRunId: null,
      scheduledTaskId: null,
      scheduledTaskName: null,
      getAgentRunId: () => "run-test",
      streamingState,
      getAssistantMessageId: () => assistantMessageId,
    });

    await syncStreamingMessage(true);

    const preSplitId = streamingState.messageId;
    expect(preSplitId).toBe(assistantMessageId);

    await createMessage({
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "Queued follow-up" }],
      orderingIndex: await nextOrderingIndex(session.id),
      metadata: { livePromptInjected: true },
    });

    streamingState.messageId = undefined;
    streamingState.parts = [{ type: "text", text: "Post-injection assistant segment" }];
    streamingState.toolCallParts = new Map();
    streamingState.loggedIncompleteToolCalls = new Set();
    streamingState.lastBroadcastAt = 0;
    streamingState.lastBroadcastSignature = "";
    streamingState.pendingBroadcast = false;
    streamingState.isCreating = false;
    assistantMessageId = crypto.randomUUID();

    await syncStreamingMessage(true);

    const persisted = await getMessages(session.id);
    const assistants = persisted.filter((message) => message.role === "assistant");

    expect(assistants).toHaveLength(2);
    expect(assistants[0]?.id).toBe(preSplitId);
    expect(assistants[1]?.id).toBe(assistantMessageId);
    expect((assistants[1]?.content as Array<{ type: string; text?: string }>)[0]?.text).toBe(
      "Post-injection assistant segment"
    );
  });
});
