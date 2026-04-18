/**
 * Mid-Stream Injection — Chat instance ownership regression
 * ==========================================================
 *
 * This suite locks the wiring fix in `components/chat-provider.tsx` that
 * caused the production `MessageRepository(performOp/link)` crash to reach
 * users despite the splice logic in `computeInjectionSplice` being correct.
 *
 * ── The bug ─────────────────────────────────────────────────────────────
 *
 * The previous chat-provider wired the transport helpers like this:
 *
 *     const chat = useChat({ id, transport, messages, ... });
 *     // ...
 *     transport.setChatHelpers({
 *       setMessages: chat.setMessages,
 *       getActiveResponseState: () => (chat as any).activeResponse?.state ?? null,
 *       generateId: () => (chat as any).generateId?.() ?? crypto.randomUUID(),
 *     });
 *
 * The problem: `useChat` (from `@ai-sdk/react` v3+) returns a
 * `UseChatHelpers` plain object — NOT the underlying `Chat` instance.
 * `(chat as any).activeResponse` is therefore permanently `undefined`,
 * which means `getActiveResponseState()` always returned `null`. The
 * splice saw a null `activeState`, silently took the no-rotation branch,
 * and appended the injected user without sealing or id-rotation.
 *
 * The very next AI SDK `write()` then took its `pushMessage` branch (because
 * `state.message.id !== lastMessage.id`), concatenating the live
 * `activeResponse.state.message` BY REFERENCE onto the tail. That produced
 * `[... u, a, injected_u, a_live_ref]` — duplicate `a` id. The
 * `MessageRepository` reconciliation loop then crashed walking the parent
 * tree for the second `a`.
 *
 * ── The fix ─────────────────────────────────────────────────────────────
 *
 * `useChat` has an escape hatch: `useChat({ chat: myChatInstance })`. If
 * we construct the `Chat` ourselves and pass it in, we have a direct
 * reference to `myChatInstance.activeResponse`. The helpers-wiring
 * effect now closes over `chatInstance`, and `getActiveResponseState`
 * returns the REAL active response state while a stream is live.
 *
 * ── What this test suite locks ──────────────────────────────────────────
 *
 *   1. `new Chat({...})` from `@ai-sdk/react` exposes `activeResponse`
 *      as an own property (initialised to `undefined`). This is the
 *      property name / access path the chat-provider wiring depends on —
 *      if the SDK renames or hides it behind a private field, this test
 *      fails immediately.
 *   2. `Chat` exposes `state` and `generateId` as accessible properties
 *      on the instance (not hidden behind closures or private fields).
 *      The diagnostic logger and the splice's `helpers.generateId` hook
 *      both rely on direct access.
 *   3. `chat.state.pushMessage`, `chat.state.replaceMessage`, and the
 *      `messages` accessor are directly reachable — required by the
 *      `patchChatState` monkey-patch that powers the mid-stream
 *      collision-detection diagnostics.
 *   4. Constructing `Chat` and reaching into `activeResponse` synchronously
 *      reproduces what the production provider does — if this file fails
 *      to compile or the properties disappear, the regression is loud.
 */

import { describe, it, expect } from "vitest";
import { Chat } from "@ai-sdk/react";
import type { UIMessage } from "ai";

/**
 * Stub transport — `new Chat({...})` requires a transport. We don't need
 * it to do anything (no test starts a stream) but `AbstractChat` asserts
 * on its shape during construction.
 */
function makeStubTransport() {
  return {
    sendMessages: () =>
      new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    reconnectToStream: () => Promise.resolve(null),
  };
}

describe("Chat instance ownership — wiring for mid-stream injection", () => {
  it("exposes activeResponse as an accessible own property on the instance", () => {
    const chat = new Chat<UIMessage>({
      id: "sess-1",
      transport: makeStubTransport() as never,
      messages: [],
      generateId: () => "id-1",
    });

    // `activeResponse` must exist on the instance (set to undefined
    // when no stream is active). If AI SDK migrates to a private field
    // (e.g. `#activeResponse`), the splice's transport-helpers wiring
    // will break silently; catch that here.
    expect("activeResponse" in chat).toBe(true);
    expect((chat as unknown as { activeResponse: unknown }).activeResponse).toBeUndefined();
  });

  it("exposes state.pushMessage, state.replaceMessage, and the messages accessor", () => {
    const chat = new Chat<UIMessage>({
      id: "sess-1",
      transport: makeStubTransport() as never,
      messages: [],
      generateId: () => "id-1",
    });

    const state = (chat as unknown as { state: unknown }).state as {
      pushMessage: unknown;
      replaceMessage: unknown;
      messages: unknown;
    };

    expect(state).toBeDefined();
    expect(typeof state.pushMessage).toBe("function");
    expect(typeof state.replaceMessage).toBe("function");

    // `messages` is a getter (ReactChatState.messages), so it shows up
    // on the prototype's descriptor — not as an own property.
    const proto = Object.getPrototypeOf(state) as object;
    const desc = Object.getOwnPropertyDescriptor(proto, "messages");
    expect(desc).toBeDefined();
    expect(typeof desc!.get).toBe("function");
    expect(typeof desc!.set).toBe("function");
  });

  it("exposes generateId as a callable property on the instance", () => {
    const chat = new Chat<UIMessage>({
      id: "sess-1",
      transport: makeStubTransport() as never,
      messages: [],
      generateId: () => "custom-id-1",
    });

    expect(typeof chat.generateId).toBe("function");
    expect(chat.generateId()).toBe("custom-id-1");
  });

  it("reports status/messages through the same Chat instance we own", () => {
    // The provider passes its `chatInstance` to both the transport
    // wiring (via `chatInstance.activeResponse`) AND to `useChat` (via
    // `{ chat }`). This test verifies that the Chat instance's `messages`
    // and `status` properties reflect state updates — i.e., the instance
    // is the single source of truth the helpers loop back to.
    const chat = new Chat<UIMessage>({
      id: "sess-1",
      transport: makeStubTransport() as never,
      messages: [],
      generateId: () => "id-1",
    });

    expect(chat.messages).toEqual([]);
    expect(chat.status).toBe("ready");

    // Assign messages through the public setter — ReactChatState
    // forwards to its internal array. Our provider's recovery path
    // (`chat.setMessages(...)`) flows through this.
    (chat as unknown as { messages: UIMessage[] }).messages = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] } as UIMessage,
    ];
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0]!.id).toBe("u1");
  });

  /**
   * Regression: the critical shape the chat-provider's
   * transport-helpers effect depends on. If any of these three accessors
   * disappear or move to a private field, the wiring silently breaks
   * (as it did pre-fix) and the crash reproduces.
   */
  it("SHAPE LOCK: all three accessors the transport-helpers effect reaches for are accessible", () => {
    const chat = new Chat<UIMessage>({
      id: "sess-1",
      transport: makeStubTransport() as never,
      messages: [],
      generateId: () => "id-1",
    });

    // 1. chatInstance.activeResponse  — consumed by
    //    `BufferedAssistantChatTransport.spliceInjectedUserMessage`
    //    via `helpers.getActiveResponseState()`.
    expect("activeResponse" in chat).toBe(true);

    // 2. chatInstance.generateId      — consumed by
    //    `helpers.generateId()` to produce the rotated assistant id.
    expect(typeof chat.generateId).toBe("function");

    // 3. chatInstance.state           — consumed by
    //    `patchChatState(chatInstance)` to monkey-patch pushMessage /
    //    replaceMessage for diagnostic logging.
    expect((chat as unknown as { state: unknown }).state).toBeDefined();
  });
});
