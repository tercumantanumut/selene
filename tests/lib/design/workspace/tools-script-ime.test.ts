/** @vitest-environment jsdom */

/**
 * IME guard for the in-iframe comment input.
 *
 * The tools-script string is meant to run inside the preview iframe; in tests
 * we eval it into a fresh JSDOM document per case, simulate the comment-tool
 * flow (click an element to open the input), then dispatch keydown events
 * with different IME / shift modifiers. The handler under test is the inline
 * keydown listener attached to the textarea inside `makeCommentInput` —
 * its behaviour is the user-visible IME contract.
 *
 * Behaviour locked in here:
 *   - Enter while `isComposing: true` -> NO preventDefault, NO postMessage.
 *   - Enter with legacy keyCode=229 -> NO preventDefault, NO postMessage.
 *   - Shift+Enter -> NO preventDefault (newline allowed), NO postMessage.
 *   - Plain Enter -> preventDefault IS called, message IS posted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { TOOLS_SCRIPT } from "@/lib/design/workspace/tools-script";

interface PostedMessage {
  type?: string;
  text?: string;
  elementSelector?: string;
}

let dom: JSDOM | null = null;
let postSpy: ReturnType<typeof vi.fn>;

function bootstrap(): {
  win: Window & typeof globalThis;
  doc: Document;
  target: HTMLElement;
  openCommentInput: () => HTMLTextAreaElement;
} {
  // A brand-new JSDOM per test ensures none of the script's `document`-level
  // listeners or DOM nodes (overlay, comment-layer) leak into the next case.
  dom = new JSDOM(
    `<!doctype html><html><body><div id="target">click me</div></body></html>`,
    { runScripts: "outside-only" },
  );
  const win = dom.window as unknown as Window & typeof globalThis;
  const doc = win.document;
  const target = doc.getElementById("target") as HTMLElement;

  postSpy = vi.fn();
  Object.defineProperty(win, "parent", {
    configurable: true,
    value: { postMessage: postSpy },
  });

  // Polyfill bits jsdom omits.
  if (!win.requestAnimationFrame) {
    (win as unknown as { requestAnimationFrame: typeof requestAnimationFrame }).requestAnimationFrame =
      ((cb: FrameRequestCallback) =>
        setTimeout(() => cb(win.performance.now()), 16) as unknown as number) as typeof requestAnimationFrame;
  }
  if (!(win as unknown as { CSS?: { escape?: (s: string) => string } }).CSS) {
    (win as unknown as { CSS: { escape: (s: string) => string } }).CSS = {
      escape: (s: string) => s,
    };
  }

  // Seed the active tool to "comment" so the click flow opens an input.
  (win as unknown as Record<string, unknown>).__seleneActiveTool = "comment";

  // Eval the script in the JSDOM realm so `window`, `document`, etc. inside
  // the script resolve to the JSDOM realm rather than the host node realm.
  // TOOLS_SCRIPT is already an IIFE; running it once seeds all the state.
  dom.window.eval(TOOLS_SCRIPT);

  function openCommentInput(): HTMLTextAreaElement {
    const click = new win.MouseEvent("click", { bubbles: true, cancelable: true });
    target.dispatchEvent(click);
    const input = doc.querySelector<HTMLTextAreaElement>("#__selene-comment-layer textarea");
    if (!input) throw new Error("comment input was not created");
    return input;
  }

  return { win, doc, target, openCommentInput };
}

function dispatchKeydownOn(
  win: Window,
  input: HTMLTextAreaElement,
  options: { key: string; isComposing?: boolean; shiftKey?: boolean; keyCode?: number },
): { preventDefaultCalled: boolean } {
  const event = new win.KeyboardEvent("keydown", {
    key: options.key,
    bubbles: true,
    cancelable: true,
    shiftKey: options.shiftKey ?? false,
  });
  Object.defineProperty(event, "isComposing", { value: options.isComposing ?? false });
  if (options.keyCode !== undefined) {
    Object.defineProperty(event, "keyCode", { value: options.keyCode });
  }
  let preventDefaultCalled = false;
  const originalPreventDefault = event.preventDefault.bind(event);
  Object.defineProperty(event, "preventDefault", {
    value: () => {
      preventDefaultCalled = true;
      originalPreventDefault();
    },
  });
  input.dispatchEvent(event);
  return { preventDefaultCalled };
}

beforeEach(() => {
  // Each test gets a brand new DOM via `bootstrap()`.
});

afterEach(() => {
  if (dom) {
    dom.window.close();
    dom = null;
  }
});

describe("tools-script comment input — IME guard", () => {
  it("Enter while composing does NOT preventDefault and does NOT post", () => {
    const { win, openCommentInput } = bootstrap();
    const input = openCommentInput();
    input.value = "한";
    const { preventDefaultCalled } = dispatchKeydownOn(win, input, {
      key: "Enter",
      isComposing: true,
    });
    expect(preventDefaultCalled).toBe(false);
    const commentCall = postSpy.mock.calls.find(
      ([msg]) => (msg as PostedMessage).type === "selene-tool-comment",
    );
    expect(commentCall).toBeUndefined();
  });

  it("Enter with keyCode=229 (legacy IME) does NOT preventDefault and does NOT post", () => {
    const { win, openCommentInput } = bootstrap();
    const input = openCommentInput();
    input.value = "한";
    const { preventDefaultCalled } = dispatchKeydownOn(win, input, {
      key: "Enter",
      isComposing: false,
      keyCode: 229,
    });
    expect(preventDefaultCalled).toBe(false);
    const commentCall = postSpy.mock.calls.find(
      ([msg]) => (msg as PostedMessage).type === "selene-tool-comment",
    );
    expect(commentCall).toBeUndefined();
  });

  it("Shift+Enter does NOT preventDefault (newline allowed) and does NOT post", () => {
    const { win, openCommentInput } = bootstrap();
    const input = openCommentInput();
    input.value = "line one";
    const { preventDefaultCalled } = dispatchKeydownOn(win, input, {
      key: "Enter",
      shiftKey: true,
    });
    expect(preventDefaultCalled).toBe(false);
    const commentCall = postSpy.mock.calls.find(
      ([msg]) => (msg as PostedMessage).type === "selene-tool-comment",
    );
    expect(commentCall).toBeUndefined();
  });

  it("plain Enter (no IME) calls preventDefault and posts the comment", () => {
    const { win, openCommentInput } = bootstrap();
    const input = openCommentInput();
    input.value = "looks great";
    const { preventDefaultCalled } = dispatchKeydownOn(win, input, { key: "Enter" });
    expect(preventDefaultCalled).toBe(true);
    const commentCall = postSpy.mock.calls.find(
      ([msg]) => (msg as PostedMessage).type === "selene-tool-comment",
    );
    expect(commentCall).toBeDefined();
    expect((commentCall![0] as PostedMessage).text).toBe("looks great");
  });
});
