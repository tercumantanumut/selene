/** @vitest-environment jsdom */

/**
 * Cleanup-contract test: when DesignPreviewFrame's `activeTool` flips to
 * `null`, the parent posts BOTH `selene-tool-set-active` (with `tool: null`)
 * AND `selene-tools-cleanup` to the iframe — the second message is a
 * defensive double-tap so any transient overlay (measure anchor, comment
 * composer, hover highlight) is reset by the in-iframe handler.
 *
 * The full component pulls in too many unrelated deps for a unit-environment
 * render (Lucide icons, fetch, ResizeObserver, the design-workspace-bridge
 * chain), so we mock everything heavy and assert the postMessage sequence
 * via a captured stub on `HTMLIFrameElement.prototype.contentWindow`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

// Stub the Lucide icon set — we don't need real SVGs. Vitest's module mock
// can't be a Proxy (it's introspected for explicit exports), so we list the
// icons the component imports explicitly.
vi.mock("lucide-react", () => {
  const stub = (name: string) =>
    function Icon() {
      return createElement("span", { "data-icon": name });
    };
  return {
    Monitor: stub("Monitor"),
    Tablet: stub("Tablet"),
    Smartphone: stub("Smartphone"),
    Crosshair: stub("Crosshair"),
    Maximize: stub("Maximize"),
    Sun: stub("Sun"),
    Moon: stub("Moon"),
    SunMoon: stub("SunMoon"),
    Ruler: stub("Ruler"),
    Pipette: stub("Pipette"),
    MessageSquare: stub("MessageSquare"),
  };
});

// Replace the design-workspace bridge dependency with a no-op so we don't
// pull the API client into the test.
vi.mock("@/components/design/design-workspace-bridge", () => ({
  rehydrateComponentCode: vi.fn(),
}));

// Button stub — we don't render any toolbar buttons in this test.
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    createElement("button", rest, children),
}));

// Polyfill ResizeObserver for jsdom.
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;

import { DesignPreviewFrame } from "@/components/design/design-preview-frame";
import { useDesignWorkspaceStore } from "@/lib/design/workspace/store";

interface PostedMessage {
  type?: string;
  tool?: unknown;
  diff?: unknown;
  bootstrap?: unknown;
  comments?: unknown;
}

let container: HTMLDivElement;
let root: Root;
let posted: PostedMessage[] = [];
let originalContentWindow: PropertyDescriptor | undefined;

beforeEach(() => {
  posted = [];
  container = document.createElement("div");
  document.body.appendChild(container);

  // Patch HTMLIFrameElement.contentWindow to a fake window with a postMessage
  // stub. The component sets `iframeRef.current?.contentWindow.postMessage(...)`.
  originalContentWindow = Object.getOwnPropertyDescriptor(
    HTMLIFrameElement.prototype,
    "contentWindow",
  );
  Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
    configurable: true,
    get() {
      return {
        postMessage: (msg: unknown) => {
          posted.push(msg as PostedMessage);
        },
      };
    },
  });

  // Seed the store with a component so the preview frame doesn't render the
  // "Select or create a component" placeholder.
  const state = useDesignWorkspaceStore.getState();
  state.reset();
  state.addComponent({
    id: "test-comp",
    name: "Test",
    code: "<div>hi</div>",
    mode: "tailwind",
    style: "default",
    prompt: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
});

afterEach(() => {
  if (root) {
    flushSync(() => {
      root.unmount();
    });
  }
  if (container.parentNode) container.parentNode.removeChild(container);
  if (originalContentWindow) {
    Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", originalContentWindow);
  } else {
    delete (HTMLIFrameElement.prototype as unknown as Record<string, unknown>).contentWindow;
  }
  useDesignWorkspaceStore.getState().reset();
});

describe("DesignPreviewFrame cleanup contract", () => {
  it("transitioning activeTool to null posts set-active(null) AND tools-cleanup", () => {
    // Seed activeTool=measure so the cleanup transition can be observed.
    useDesignWorkspaceStore.getState().setActiveTool("measure");

    flushSync(() => {
      root = createRoot(container);
      root.render(createElement(DesignPreviewFrame));
    });

    // Initial mount: a `selene-tool-set-active` for the current tool will
    // have been posted. Drain posts and flip to null.
    posted = [];
    flushSync(() => {
      useDesignWorkspaceStore.getState().setActiveTool(null);
    });

    const setActiveNullPosts = posted.filter(
      (m) => m && m.type === "selene-tool-set-active" && m.tool === null,
    );
    const cleanupPosts = posted.filter((m) => m && m.type === "selene-tools-cleanup");

    expect(setActiveNullPosts.length).toBeGreaterThanOrEqual(1);
    expect(cleanupPosts.length).toBeGreaterThanOrEqual(1);
  });
});
