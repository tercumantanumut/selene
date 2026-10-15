/** @vitest-environment jsdom */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { useThreadViewportAutoScroll } from "@/components/assistant-ui/thread-viewport-auto-scroll";

function ViewportHarness({ update }: { update: string }) {
  const viewportRef = useThreadViewportAutoScroll();

  return createElement(
    "div",
    { ref: viewportRef, "data-testid": "viewport" },
    createElement("span", null, update),
  );
}

describe("useThreadViewportAutoScroll", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(update: string) {
    await act(async () => {
      root.render(createElement(ViewportHarness, { update }));
      await Promise.resolve();
    });
  }

  function configureViewport(viewport: HTMLDivElement) {
    let scrollHeight = 1_000;
    let scrollTop = 600;
    const clientHeight = 400;

    Object.defineProperties(viewport, {
      clientHeight: {
        configurable: true,
        get: () => clientHeight,
      },
      scrollHeight: {
        configurable: true,
        get: () => scrollHeight,
      },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
    });

    const scrollTo = vi.fn((options: ScrollToOptions) => {
      const requestedTop = typeof options.top === "number" ? options.top : scrollTop;
      scrollTop = Math.min(requestedTop, scrollHeight - clientHeight);
      viewport.dispatchEvent(new Event("scroll"));
    });
    viewport.scrollTo = scrollTo;

    return {
      scrollTo,
      getScrollTop: () => scrollTop,
      setScrollTop: (value: number) => {
        scrollTop = value;
        viewport.dispatchEvent(new Event("scroll"));
      },
      userScrollTo: (value: number) => {
        viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: value < scrollTop ? -100 : 100 }));
        scrollTop = value;
        viewport.dispatchEvent(new Event("scroll"));
      },
      growContent: (amount = 40) => {
        scrollHeight += amount;
      },
      shrinkContent: (amount = 40) => {
        scrollHeight -= amount;
        scrollTop = Math.min(scrollTop, scrollHeight - clientHeight);
        viewport.dispatchEvent(new Event("scroll"));
      },
      getBottomScrollTop: () => scrollHeight - clientHeight,
    };
  }

  it("keeps following frequent live updates only while the user stays near the bottom", async () => {
    await render("step 0");
    const viewport = container.querySelector<HTMLDivElement>("[data-testid='viewport']");
    expect(viewport).not.toBeNull();

    const geometry = configureViewport(viewport!);
    geometry.setScrollTop(geometry.getBottomScrollTop());
    geometry.scrollTo.mockClear();

    for (let index = 1; index <= 3; index += 1) {
      geometry.growContent();
      await render(`step ${index}`);
    }

    expect(geometry.scrollTo).toHaveBeenCalledTimes(3);
    expect(geometry.getScrollTop()).toBe(geometry.getBottomScrollTop());

    geometry.scrollTo.mockClear();
    geometry.shrinkContent(60);
    await render("step completed");

    expect(geometry.scrollTo).toHaveBeenCalledTimes(1);
    expect(geometry.getScrollTop()).toBe(geometry.getBottomScrollTop());

    geometry.scrollTo.mockClear();
    geometry.userScrollTo(400);

    for (let index = 4; index <= 50; index += 1) {
      geometry.growContent();
      await render(`step ${index}`);
    }

    expect(geometry.scrollTo).not.toHaveBeenCalled();
    expect(geometry.getScrollTop()).toBe(400);
  });

  it("suspends on an upward scroll within the threshold and resumes after returning near the bottom", async () => {
    await render("stream 0");
    const viewport = container.querySelector<HTMLDivElement>("[data-testid='viewport']");
    expect(viewport).not.toBeNull();

    const geometry = configureViewport(viewport!);
    geometry.setScrollTop(geometry.getBottomScrollTop());

    geometry.userScrollTo(geometry.getBottomScrollTop() - 20);
    geometry.scrollTo.mockClear();
    geometry.growContent();
    await render("stream 1");

    expect(geometry.scrollTo).not.toHaveBeenCalled();

    geometry.userScrollTo(geometry.getBottomScrollTop() - 40);
    geometry.scrollTo.mockClear();
    geometry.growContent();
    await render("stream 2");

    expect(geometry.scrollTo).toHaveBeenCalledTimes(1);
    expect(geometry.getScrollTop()).toBe(geometry.getBottomScrollTop());
  });

  it("resumes following after an explicit jump to the latest message", async () => {
    await render("message 0");
    const viewport = container.querySelector<HTMLDivElement>("[data-testid='viewport']");
    expect(viewport).not.toBeNull();

    const geometry = configureViewport(viewport!);
    geometry.setScrollTop(geometry.getBottomScrollTop());
    geometry.userScrollTo(300);
    geometry.setScrollTop(geometry.getBottomScrollTop());

    geometry.scrollTo.mockClear();
    geometry.growContent();
    await render("message 1");

    expect(geometry.scrollTo).toHaveBeenCalledTimes(1);
    expect(geometry.getScrollTop()).toBe(geometry.getBottomScrollTop());
  });
});
