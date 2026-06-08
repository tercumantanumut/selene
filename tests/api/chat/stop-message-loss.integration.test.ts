/**
 * Stop Message Loss – Integration Test
 *
 * Validates the pre-generated assistantMessageId fix end-to-end:
 *
 *   Turn 1  → user message + assistant reply saved to DB
 *   STOP    → user aborts mid-stream; partial assistant saved with pre-generated ID
 *   Turn 2  → frontend sends all known IDs (incl. the stopped assistant's ID)
 *             → deleteMessagesNotIn runs → stopped assistant message MUST survive
 *
 * Before the fix, the assistant message ID was generated server-side *after* the
 * stream started, so the frontend never learned it.  On the next turn the
 * frontend's keepIds set didn't include the server-created ID and
 * deleteMessagesNotIn silently deleted the stopped assistant message.
 *
 * The fix pre-generates the UUID and passes it via `generateMessageId` in the
 * SSE stream, so both frontend and DB share the same ID.
 *
 * This test exercises the real DB functions (createMessage, deleteMessagesNotIn,
 * getMessages, getInjectedMessageIds) and the convertDBMessagesToUIMessages
 * converter — the full persistence path minus the LLM.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { filterStreamingPartsForPersistence } from "@/app/api/chat/streaming-progress";
import type { StreamingMessageState } from "@/app/api/chat/streaming-state";
import {
  createSession,
  createMessage,
  getMessages,
  getOrCreateLocalUser,
  deleteMessagesNotIn,
  getInjectedMessageIds,
} from "@/lib/db/queries";
import { nextOrderingIndex } from "@/lib/session/message-ordering";
import { convertDBMessagesToUIMessages } from "@/lib/messages/converter";
import { buildRetryMessage } from "@/lib/chat/client-retry";
import { sanitizeMessagesForInit } from "@/components/chat-provider";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part) =>
        part && typeof part === "object" && (part as { type?: string }).type === "text"
    )
    .map((part) => String((part as { text?: unknown }).text || ""))
    .join("\n");
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

function makeStreamingState(parts: any[]): StreamingMessageState {
  return {
    parts,
    toolCallParts: new Map(
      parts
        .filter((part) => part?.type === "tool-call" && typeof part.toolCallId === "string")
        .map((part) => [part.toolCallId, part])
    ),
    loggedIncompleteToolCalls: new Set(),
    lastBroadcastAt: 0,
    lastBroadcastSignature: "",
  };
}

describe("Stop Message Loss Prevention", () => {
  const TEST_USER_ID = "test-stop-msg-loss";
  const TEST_EMAIL = "stop-msg-loss@test.local";

  beforeEach(async () => {
    await getOrCreateLocalUser(TEST_USER_ID, TEST_EMAIL);
  });

  /**
   * Scenario: Normal completion → next turn
   *
   * Verifies the baselene: assistant message persisted with pre-generated ID,
   * next turn's deleteMessagesNotIn keeps it when the frontend includes the ID.
   */
  it("preserves assistant message across turns when frontend includes its ID", async () => {
    const session = await createSession({ title: "Stop Loss - Normal", userId: TEST_USER_ID });
    if (!session) throw new Error("Failed to create session");

    // ── Turn 1: user + assistant ──────────────────────────────────────────

    const userMsg1 = await createMessage({
      id: crypto.randomUUID(),
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "Hello, how are you?" }],
      orderingIndex: await nextOrderingIndex(session.id),
    });
    expect(userMsg1?.id).toBeTruthy();

    // Pre-generated assistant message ID (simulates what the route does)
    const preGeneratedAssistantId = crypto.randomUUID();

    const assistantMsg1 = await createMessage({
      id: preGeneratedAssistantId,
      sessionId: session.id,
      role: "assistant",
      content: [{ type: "text", text: "I'm doing well! How can I help?" }],
      orderingIndex: await nextOrderingIndex(session.id),
    });
    expect(assistantMsg1?.id).toBe(preGeneratedAssistantId);

    // ── Turn 2: user sends new message ────────────────────────────────────
    // Frontend knows: userMsg1.id, preGeneratedAssistantId, userMsg2.id

    const userMsg2Id = crypto.randomUUID();
    const frontendKnownIds = new Set([
      userMsg1!.id,
      preGeneratedAssistantId,
      userMsg2Id,
    ]);

    // deleteMessagesNotIn runs BEFORE the new user message is persisted
    const injectedIds = await getInjectedMessageIds(session.id);
    for (const id of injectedIds) {
      frontendKnownIds.add(id);
    }
    const deleted = await deleteMessagesNotIn(session.id, frontendKnownIds);
    expect(deleted).toBe(0);

    // Persist the new user message
    await createMessage({
      id: userMsg2Id,
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "Tell me a joke" }],
      orderingIndex: await nextOrderingIndex(session.id),
    });

    // ── Verify ────────────────────────────────────────────────────────────

    const allMessages = await getMessages(session.id);
    expect(allMessages).toHaveLength(3);

    const ids = allMessages.map((m) => m.id);
    expect(ids).toContain(userMsg1!.id);
    expect(ids).toContain(preGeneratedAssistantId);
    expect(ids).toContain(userMsg2Id);

    // UI conversion should preserve all messages
    const uiMessages = convertDBMessagesToUIMessages(allMessages as any);
    expect(uiMessages.length).toBeGreaterThanOrEqual(3);
  });

  /**
   * Scenario: STOP mid-stream → partial assistant saved → next turn
   *
   * Simulates the exact abort flow:
   * 1. User sends Turn 1
   * 2. Stream starts, assistant begins generating
   * 3. User clicks STOP → onAbort fires → partial content + interruption marker saved
   * 4. Frontend sends Turn 2 with all known IDs (including the stopped assistant's ID)
   * 5. deleteMessagesNotIn MUST NOT delete the stopped assistant message
   */
  it("preserves stopped assistant message when frontend includes its pre-generated ID", async () => {
    const session = await createSession({
      title: "Stop Loss - Abort",
      userId: TEST_USER_ID,
    });
    if (!session) throw new Error("Failed to create session");

    // ── Turn 1: user message ──────────────────────────────────────────────

    const userMsg1 = await createMessage({
      id: crypto.randomUUID(),
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "Write me a long essay about AI" }],
      orderingIndex: await nextOrderingIndex(session.id),
    });

    // ── STOP: abort mid-stream ────────────────────────────────────────────
    // The route pre-generates the assistant ID before streaming begins
    const preGeneratedAssistantId = crypto.randomUUID();

    // onAbort saves partial assistant content with the pre-generated ID
    const stoppedAssistant = await createMessage({
      id: preGeneratedAssistantId,
      sessionId: session.id,
      role: "assistant",
      content: [
        { type: "text", text: "Artificial Intelligence (AI) has transformed..." },
      ],
      orderingIndex: await nextOrderingIndex(session.id),
      metadata: { interrupted: true },
    });
    expect(stoppedAssistant?.id).toBe(preGeneratedAssistantId);

    // onAbort also saves a system interruption message
    const interruptionMsg = await createMessage({
      sessionId: session.id,
      role: "system",
      content: [
        {
          type: "text",
          text: "[Chat generation was stopped by the user]",
        },
      ],
      orderingIndex: await nextOrderingIndex(session.id),
      metadata: { interruptionType: "chat", interrupted: true },
    });

    // ── Turn 2: frontend sends next message ───────────────────────────────
    // The frontend's message list includes the stopped assistant's ID
    // because it received it via the SSE stream's generateMessageId callback

    const userMsg2Id = crypto.randomUUID();
    const frontendKnownIds = new Set([
      userMsg1!.id,
      preGeneratedAssistantId, // ← THIS is the key: frontend knows this ID
      userMsg2Id,
    ]);

    // Protect injected messages (same as the route does)
    const injectedIds = await getInjectedMessageIds(session.id);
    for (const id of injectedIds) {
      frontendKnownIds.add(id);
    }

    // This is the critical call that previously deleted the stopped assistant
    const deleted = await deleteMessagesNotIn(session.id, frontendKnownIds);

    // The system/interruption message should NOT be deleted either
    // (deleteMessagesNotIn only targets user/assistant roles)
    expect(deleted).toBe(0);

    // Persist the new user message
    await createMessage({
      id: userMsg2Id,
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "Actually, make it about robotics" }],
      orderingIndex: await nextOrderingIndex(session.id),
    });

    // ── Verify all messages survived ──────────────────────────────────────

    const allMessages = await getMessages(session.id);
    const allIds = allMessages.map((m) => m.id);
    const allRoles = allMessages.map((m) => m.role);

    // 4 messages: user1, stopped-assistant, system-interruption, user2
    expect(allMessages).toHaveLength(4);
    expect(allIds).toContain(userMsg1!.id);
    expect(allIds).toContain(preGeneratedAssistantId);
    expect(allIds).toContain(interruptionMsg!.id);
    expect(allIds).toContain(userMsg2Id);

    // The stopped assistant's partial content is intact
    const stoppedMsg = allMessages.find((m) => m.id === preGeneratedAssistantId);
    expect(stoppedMsg).toBeTruthy();
    expect(stoppedMsg!.role).toBe("assistant");
    expect(extractTextFromContent(stoppedMsg!.content)).toContain("Artificial Intelligence");

    // The interruption marker is intact
    const interruptionDbMsg = allMessages.find((m) => m.id === interruptionMsg!.id);
    expect(interruptionDbMsg).toBeTruthy();
    expect(interruptionDbMsg!.role).toBe("system");

    // UI conversion should show all conversational messages
    const uiMessages = convertDBMessagesToUIMessages(allMessages as any);
    const uiIds = uiMessages.map((m) => m.id);
    expect(uiIds).toContain(userMsg1!.id);
    expect(uiIds).toContain(preGeneratedAssistantId);
    expect(uiIds).toContain(userMsg2Id);
  });

  /**
   * Regression test: WITHOUT the fix (server-generated ID unknown to frontend)
   *
   * Demonstrates what would happen if the assistant message ID was NOT included
   * in the frontend's keepIds: deleteMessagesNotIn would silently delete it.
   */
  it("demonstrates the bug: assistant message deleted when its ID is missing from keepIds", async () => {
    const session = await createSession({
      title: "Stop Loss - Bug Demo",
      userId: TEST_USER_ID,
    });
    if (!session) throw new Error("Failed to create session");

    // ── Turn 1: user + stopped assistant ──────────────────────────────────

    const userMsg1 = await createMessage({
      id: crypto.randomUUID(),
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "Hello" }],
      orderingIndex: await nextOrderingIndex(session.id),
    });

    // Server creates assistant message with its own ID (old behavior)
    const serverOnlyAssistantId = crypto.randomUUID();
    const stoppedAssistant = await createMessage({
      id: serverOnlyAssistantId,
      sessionId: session.id,
      role: "assistant",
      content: [{ type: "text", text: "Partial response that got stopped..." }],
      orderingIndex: await nextOrderingIndex(session.id),
      metadata: { interrupted: true },
    });

    // ── Turn 2: frontend does NOT know the assistant's ID ─────────────────
    // (This simulates the old bug — frontend never received the ID)

    const userMsg2Id = crypto.randomUUID();
    const frontendKnownIds_BUG = new Set([
      userMsg1!.id,
      // serverOnlyAssistantId is NOT here — that's the bug
      userMsg2Id,
    ]);

    const deleted = await deleteMessagesNotIn(session.id, frontendKnownIds_BUG);

    // The stopped assistant IS deleted because the frontend doesn't know its ID
    // and it sits after the max kept position (userMsg1)
    expect(deleted).toBe(1);

    const remaining = await getMessages(session.id);
    const remainingIds = remaining.map((m) => m.id);
    expect(remainingIds).toContain(userMsg1!.id);
    expect(remainingIds).not.toContain(serverOnlyAssistantId); // DELETED!
  });

  /**
   * Scenario: STOP mid-stream with tool calls in progress
   *
   * Validates that a stopped assistant message containing partial tool calls
   * is preserved through the next turn's sync.
   */
  it("persists unresolved tool calls once their input is finalized", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = makeStreamingState([
      { type: "text", text: "Working" },
      {
        type: "tool-call",
        toolCallId: "tc-unsealed",
        toolName: "localGrep",
        state: "input-available",
        args: { pattern: "todo" },
      },
    ]);

    const filtered = filterStreamingPartsForPersistence(state);

    expect(filtered).toHaveLength(2);
    expect(filtered[0]).toEqual({ type: "text", text: "Working" });
    expect(filtered[1]).toMatchObject({
      type: "tool-call",
      toolCallId: "tc-unsealed",
      toolName: "localGrep",
      state: "input-available",
      args: { pattern: "todo" },
      active: true,
    });
    expect(typeof (filtered[1] as { timestamp?: unknown }).timestamp).toBe("string");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("keeps sealed tool-call/result pairs in streaming persistence", async () => {
    const state = makeStreamingState([
      { type: "text", text: "Working" },
      {
        type: "tool-call",
        toolCallId: "tc-sealed",
        toolName: "localGrep",
        state: "input-available",
        args: { pattern: "todo" },
      },
      {
        type: "tool-result",
        toolCallId: "tc-sealed",
        toolName: "localGrep",
        state: "output-available",
        status: "success",
        result: { count: 1 },
      },
    ]);

    const filtered = filterStreamingPartsForPersistence(state);

    expect(filtered).toHaveLength(3);
    expect(filtered[1]).toMatchObject({ type: "tool-call", toolCallId: "tc-sealed" });
    expect(filtered[2]).toMatchObject({ type: "tool-result", toolCallId: "tc-sealed" });
  });

  it("preserves stopped assistant with partial tool calls across turns", async () => {
    const session = await createSession({
      title: "Stop Loss - Tool Calls",
      userId: TEST_USER_ID,
    });
    if (!session) throw new Error("Failed to create session");

    // ── Turn 1 ────────────────────────────────────────────────────────────

    const userMsg1 = await createMessage({
      id: crypto.randomUUID(),
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "Search for files matching *.ts" }],
      orderingIndex: await nextOrderingIndex(session.id),
    });

    // Pre-generated assistant message ID
    const preGeneratedId = crypto.randomUUID();

    // Stopped assistant with a partial tool call (sealed by sealDanglingToolCalls)
    const stoppedAssistant = await createMessage({
      id: preGeneratedId,
      sessionId: session.id,
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "tc-stopped-1",
          toolName: "localGrep",
          args: { pattern: "*.ts" },
        },
        {
          type: "tool-result",
          toolCallId: "tc-stopped-1",
          toolName: "localGrep",
          result: {
            status: "error",
            error: "Tool execution was interrupted before completion.",
          },
          status: "error",
          state: "output-error",
        },
        { type: "text", text: "I was searching for TypeScript files when—" },
      ],
      orderingIndex: await nextOrderingIndex(session.id),
      metadata: { interrupted: true },
    });

    // Interruption system message
    await createMessage({
      sessionId: session.id,
      role: "system",
      content: [
        {
          type: "text",
          text: "[Chat generation was stopped by the user]",
        },
      ],
      orderingIndex: await nextOrderingIndex(session.id),
      metadata: { interruptionType: "chat", interrupted: true },
    });

    // ── Turn 2 ────────────────────────────────────────────────────────────

    const userMsg2Id = crypto.randomUUID();
    const frontendKnownIds = new Set([
      userMsg1!.id,
      preGeneratedId,
      userMsg2Id,
    ]);

    const injectedIds = await getInjectedMessageIds(session.id);
    for (const id of injectedIds) {
      frontendKnownIds.add(id);
    }

    const deleted = await deleteMessagesNotIn(session.id, frontendKnownIds);
    expect(deleted).toBe(0);

    await createMessage({
      id: userMsg2Id,
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "Continue the search" }],
      orderingIndex: await nextOrderingIndex(session.id),
    });

    // ── Verify ────────────────────────────────────────────────────────────

    const allMessages = await getMessages(session.id);
    expect(allMessages).toHaveLength(4);

    const stoppedMsg = allMessages.find((m) => m.id === preGeneratedId);
    expect(stoppedMsg).toBeTruthy();
    expect(stoppedMsg!.role).toBe("assistant");

    // Tool call content is preserved
    const toolCallParts = (stoppedMsg!.content as any[]).filter(
      (p) => p.type === "tool-call"
    );
    const toolResultParts = (stoppedMsg!.content as any[]).filter(
      (p) => p.type === "tool-result"
    );
    expect(toolCallParts).toHaveLength(1);
    expect(toolResultParts).toHaveLength(1);
    expect(toolCallParts[0].toolCallId).toBe("tc-stopped-1");

    // UI messages should include the stopped turn
    const uiMessages = convertDBMessagesToUIMessages(allMessages as any);
    const stoppedUiMsg = uiMessages.find((m) => m.id === preGeneratedId);
    expect(stoppedUiMsg).toBeTruthy();
  });

  /**
   * Scenario: Multiple consecutive STOPs
   *
   * User sends Turn 1, stops, then immediately retries and stops again.
   * Both stopped assistant messages should survive the next turn's sync.
   */
  it("preserves multiple consecutive stopped assistant messages", async () => {
    const session = await createSession({
      title: "Stop Loss - Double Stop",
      userId: TEST_USER_ID,
    });
    if (!session) throw new Error("Failed to create session");

    // ── Turn 1: user message ──────────────────────────────────────────────

    const userMsg1 = await createMessage({
      id: crypto.randomUUID(),
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "Explain quantum computing" }],
      orderingIndex: await nextOrderingIndex(session.id),
    });

    // ── First attempt: stopped ────────────────────────────────────────────

    const firstStoppedId = crypto.randomUUID();
    await createMessage({
      id: firstStoppedId,
      sessionId: session.id,
      role: "assistant",
      content: [{ type: "text", text: "Quantum computing is a field that—" }],
      orderingIndex: await nextOrderingIndex(session.id),
      metadata: { interrupted: true },
    });

    await createMessage({
      sessionId: session.id,
      role: "system",
      content: [{ type: "text", text: "[Chat generation was stopped by the user]" }],
      orderingIndex: await nextOrderingIndex(session.id),
      metadata: { interruptionType: "chat", interrupted: true },
    });

    const retryMessage = buildRetryMessage([
      {
        id: userMsg1!.id,
        role: "user",
        parts: [{ type: "text", text: "Explain quantum computing" }],
      } as any,
    ]);
    expect(retryMessage).toEqual({
      id: userMsg1!.id,
      role: "user",
      parts: [{ type: "text", text: "Explain quantum computing" }],
      messageId: userMsg1!.id,
    });

    // ── Second attempt (retry same turn): also stopped ────────────────────
    // In practice, the client resends the same user message rather than
    // regenerating an assistant row that may not exist yet.

    const secondStoppedId = crypto.randomUUID();
    await createMessage({
      id: secondStoppedId,
      sessionId: session.id,
      role: "assistant",
      content: [{ type: "text", text: "Quantum computing leverages—" }],
      orderingIndex: await nextOrderingIndex(session.id),
      metadata: { interrupted: true },
    });

    await createMessage({
      sessionId: session.id,
      role: "system",
      content: [{ type: "text", text: "[Chat generation was stopped by the user]" }],
      orderingIndex: await nextOrderingIndex(session.id),
      metadata: { interruptionType: "chat", interrupted: true },
    });

    // ── Turn 2: user sends follow-up ──────────────────────────────────────

    const userMsg2Id = crypto.randomUUID();
    const frontendKnownIds = new Set([
      userMsg1!.id,
      firstStoppedId,
      secondStoppedId,
      userMsg2Id,
    ]);

    const deleted = await deleteMessagesNotIn(session.id, frontendKnownIds);
    expect(deleted).toBe(0);

    await createMessage({
      id: userMsg2Id,
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "Let me rephrase: what is a qubit?" }],
      orderingIndex: await nextOrderingIndex(session.id),
    });

    // ── Verify ────────────────────────────────────────────────────────────

    const allMessages = await getMessages(session.id);
    // user1, stopped1, system1, stopped2, system2, user2 = 6
    expect(allMessages).toHaveLength(6);

    const ids = allMessages.map((m) => m.id);
    expect(ids).toContain(userMsg1!.id);
    expect(ids).toContain(firstStoppedId);
    expect(ids).toContain(secondStoppedId);
    expect(ids).toContain(userMsg2Id);
  });

  /**
   * Scenario: STOP → Edit previous user message → re-send
   *
   * After stopping, the user edits their original message. assistant-ui sends a
   * truncated message list (up to the edit point + the new version). The old
   * stopped assistant message should be cleaned up since the user is branching.
   */
  it("cleans up stopped assistant when user edits the preceding message", async () => {
    const session = await createSession({
      title: "Stop Loss - Edit Branch",
      userId: TEST_USER_ID,
    });
    if (!session) throw new Error("Failed to create session");

    // ── Turn 1 ────────────────────────────────────────────────────────────

    const userMsg1Id = crypto.randomUUID();
    await createMessage({
      id: userMsg1Id,
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "Original question" }],
      orderingIndex: await nextOrderingIndex(session.id),
    });

    const stoppedId = crypto.randomUUID();
    await createMessage({
      id: stoppedId,
      sessionId: session.id,
      role: "assistant",
      content: [{ type: "text", text: "Partial answer..." }],
      orderingIndex: await nextOrderingIndex(session.id),
      metadata: { interrupted: true },
    });

    await createMessage({
      sessionId: session.id,
      role: "system",
      content: [{ type: "text", text: "[Chat generation was stopped by the user]" }],
      orderingIndex: await nextOrderingIndex(session.id),
      metadata: { interruptionType: "chat", interrupted: true },
    });

    // ── User edits message → frontend sends only the new version ──────────
    // assistant-ui reuses the same message ID for edits
    const editedKeepIds = new Set([userMsg1Id]); // Only the original user msg

    const deleted = await deleteMessagesNotIn(session.id, editedKeepIds);

    // The stopped assistant (idx 2) and system interruption are after maxKeptPosition (idx 0)
    // Only user/assistant roles are deleted, system messages are preserved
    expect(deleted).toBe(1); // Only the assistant message is deleted

    const remaining = await getMessages(session.id);
    const remainingIds = remaining.map((m) => m.id);

    expect(remainingIds).toContain(userMsg1Id);
    expect(remainingIds).not.toContain(stoppedId); // Cleaned up — correct!

    // System message survives (deleteMessagesNotIn only deletes user/assistant)
    const systemMsgs = remaining.filter((m) => m.role === "system");
    expect(systemMsgs).toHaveLength(1);
  });

  it("preserves interrupted browser tool context through converter + sanitizer", async () => {
    const session = await createSession({
      title: "Stop Loss - Browser Tool Context",
      userId: TEST_USER_ID,
    });
    if (!session) throw new Error("Failed to create session");

    await createMessage({
      id: crypto.randomUUID(),
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "Open example.com and summarize" }],
      orderingIndex: await nextOrderingIndex(session.id),
    });

    const browserToolCallId = "tool-browser-stop-1";
    await createMessage({
      id: crypto.randomUUID(),
      sessionId: session.id,
      role: "assistant",
      content: [
        { type: "text", text: "Opening browser now." },
        {
          type: "tool-call",
          toolCallId: browserToolCallId,
          toolName: "chromiumWorkspace",
          state: "input-available",
          args: { action: "open", url: "https://example.com" },
        },
        {
          type: "tool-result",
          toolCallId: browserToolCallId,
          toolName: "chromiumWorkspace",
          state: "output-available",
          result: {
            status: "success",
            data: "Browser session opened. Navigated to: https://example.com",
            pageUrl: "https://example.com",
          },
        },
      ],
      orderingIndex: await nextOrderingIndex(session.id),
      metadata: { interrupted: true },
    });

    const dbMessages = await getMessages(session.id);
    const uiMessages = convertDBMessagesToUIMessages(dbMessages as any);

    // Reproduce the stop/hydration edge shape where tool payload is present as
    // `result` but not `output` on the UI part.
    const assistantWithTool = uiMessages.find(
      (msg) => msg.role === "assistant" && msg.parts.some((part: any) => part.toolCallId === browserToolCallId)
    );
    expect(assistantWithTool).toBeDefined();

    const targetPart = assistantWithTool!.parts.find(
      (part: any) => part.toolCallId === browserToolCallId
    ) as any;
    expect(targetPart).toBeDefined();
    targetPart.result = targetPart.output;
    delete targetPart.output;
    targetPart.state = "input-available";

    const sanitized = sanitizeMessagesForInit(uiMessages as any);
    const sanitizedAssistant = sanitized.find((msg) => msg.id === assistantWithTool!.id);
    expect(sanitizedAssistant).toBeDefined();

    const keptToolPart = sanitizedAssistant!.parts.find(
      (part: any) => part.toolCallId === browserToolCallId
    ) as any;
    expect(keptToolPart).toBeDefined();
    expect(keptToolPart.result).toEqual({
      status: "success",
      data: "Browser session opened. Navigated to: https://example.com",
      pageUrl: "https://example.com",
    });
  });
});
