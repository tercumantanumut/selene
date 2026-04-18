/** @vitest-environment jsdom */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject } from "react";
import type { UIMessage } from "ai";

const { resilientFetchMock } = vi.hoisted(() => ({
  resilientFetchMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
  }),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => ((key: string) => key),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/utils/resilient-fetch", () => ({
  resilientFetch: resilientFetchMock,
  resilientPost: vi.fn(),
  resilientPatch: vi.fn(),
  resilientDelete: vi.fn(),
}));

import { useBackgroundProcessing } from "@/components/chat/chat-interface-hooks";
import { convertDBMessagesToUIMessages } from "@/lib/messages/converter";
import type { SessionState } from "@/components/chat/chat-interface-types";
import type { DBMessage } from "@/lib/messages/converter";

function makeDbMessages(): DBMessage[] {
  return [
    {
      id: "user-1",
      role: "user",
      content: [{ type: "text", text: "Original prompt" }],
      createdAt: "2026-03-14T19:00:00.000Z",
      orderingIndex: 1,
      metadata: {},
    },
    {
      id: "assistant-pre",
      role: "assistant",
      content: [{ type: "text", text: "Working on it" }],
      createdAt: "2026-03-14T19:00:01.000Z",
      orderingIndex: 2,
      metadata: { livePromptInjected: true },
    },
    {
      id: "user-injected",
      role: "user",
      content: [{ type: "text", text: "Also check tests" }],
      createdAt: "2026-03-14T19:00:02.000Z",
      orderingIndex: 3,
      metadata: { livePromptInjected: true },
    },
    {
      id: "assistant-final",
      role: "assistant",
      content: [{ type: "text", text: "Done, including tests" }],
      createdAt: "2026-03-14T19:00:03.000Z",
      orderingIndex: 4,
      metadata: {},
    },
  ];
}

type HookApi = ReturnType<typeof useBackgroundProcessing>;

function Harness(props: {
  hookRef: MutableRefObject<HookApi | null>;
  notifySessionUpdate: (id: string, data: Record<string, unknown>) => void;
  setSessionState: React.Dispatch<React.SetStateAction<SessionState>>;
  chatSetMessagesRef: MutableRefObject<((msgs: UIMessage[]) => void) | null>;
  liveThreadMessagesRef: MutableRefObject<UIMessage[]>;
  activeSessionIdRef: MutableRefObject<string>;
}) {
  props.hookRef.current = useBackgroundProcessing({
    sessionId: "session-1",
    notifySessionUpdate: props.notifySessionUpdate,
    setSessionState: props.setSessionState,
    chatSetMessagesRef: props.chatSetMessagesRef,
    liveThreadMessagesRef: props.liveThreadMessagesRef,
    activeSessionIdRef: props.activeSessionIdRef,
  });

  return null;
}

describe("useBackgroundProcessing live-prompt reconciliation", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    resilientFetchMock.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("reconciles immediately when persisted injected history is ahead of the live thread", async () => {
    const dbMessages = makeDbMessages();
    resilientFetchMock.mockResolvedValue({
      data: { messages: dbMessages },
      error: null,
      status: 200,
    });

    let sessionState: SessionState = { sessionId: "session-1", messages: [] };
    const setSessionState = vi.fn((updater: React.SetStateAction<SessionState>) => {
      sessionState = typeof updater === "function"
        ? updater(sessionState)
        : updater;
    });
    const notifySessionUpdate = vi.fn();
    const chatSetMessages = vi.fn();
    const chatSetMessagesRef = { current: chatSetMessages };
    const liveThreadMessagesRef = {
      current: [{ id: "user-1", role: "user", parts: [{ type: "text", text: "Original prompt" }] }] as UIMessage[],
    };
    const activeSessionIdRef = { current: "session-1" };
    const hookRef = { current: null as HookApi | null };

    await act(async () => {
      root.render(createElement(Harness, {
        hookRef,
        notifySessionUpdate,
        setSessionState,
        chatSetMessagesRef,
        liveThreadMessagesRef,
        activeSessionIdRef,
      }));
    });

    hookRef.current!.isRunActiveRef.current = true;

    await act(async () => {
      await hookRef.current!.refreshMessages();
    });

    const expectedUiMessages = convertDBMessagesToUIMessages(dbMessages as never);
    expect(expectedUiMessages).toHaveLength(4);
    // Injected user messages are now first-class and visible in the UI.
    expect(expectedUiMessages.some((message) =>
      message.parts.some((part: any) => part.type === "text" && part.text === "Also check tests")
    )).toBe(true);

    expect(notifySessionUpdate).toHaveBeenCalledWith("session-1", { messageCount: 4 });
    expect(setSessionState).toHaveBeenCalledTimes(1);
    expect(sessionState.messages).toEqual(expectedUiMessages);
    expect(chatSetMessages).toHaveBeenCalledWith(expectedUiMessages);
  });

  it("defers mid-run injected snapshots, then applies the same DB snapshot once the run finishes", async () => {
    const dbMessages = makeDbMessages();
    const persistedUiMessages = convertDBMessagesToUIMessages(dbMessages as never);

    resilientFetchMock.mockResolvedValue({
      data: { messages: dbMessages },
      error: null,
      status: 200,
    });

    let sessionState: SessionState = { sessionId: "session-1", messages: persistedUiMessages };
    const setSessionState = vi.fn((updater: React.SetStateAction<SessionState>) => {
      sessionState = typeof updater === "function"
        ? updater(sessionState)
        : updater;
    });
    const notifySessionUpdate = vi.fn();
    const chatSetMessages = vi.fn();
    const chatSetMessagesRef = { current: chatSetMessages };
    const liveThreadMessagesRef = { current: persistedUiMessages };
    const activeSessionIdRef = { current: "session-1" };
    const hookRef = { current: null as HookApi | null };

    await act(async () => {
      root.render(createElement(Harness, {
        hookRef,
        notifySessionUpdate,
        setSessionState,
        chatSetMessagesRef,
        liveThreadMessagesRef,
        activeSessionIdRef,
      }));
    });

    hookRef.current!.isRunActiveRef.current = true;

    await act(async () => {
      await hookRef.current!.refreshMessages();
    });

    expect(notifySessionUpdate).toHaveBeenCalledWith("session-1", { messageCount: 4 });
    expect(setSessionState).not.toHaveBeenCalled();
    expect(chatSetMessages).not.toHaveBeenCalled();

    notifySessionUpdate.mockClear();
    hookRef.current!.isRunActiveRef.current = false;

    await act(async () => {
      await hookRef.current!.refreshMessages();
    });

    expect(notifySessionUpdate).toHaveBeenCalledWith("session-1", { messageCount: 4 });
    expect(setSessionState).toHaveBeenCalledTimes(1);
    expect(sessionState.messages).toEqual(persistedUiMessages);
    expect(chatSetMessages).toHaveBeenCalledWith(persistedUiMessages);
  });
});
