import { describe, expect, it } from "vitest";

import {
  DEFAULT_BROWSER_VIEWPORT,
  resolveBrowserViewport,
} from "@/lib/browser/viewport";

describe("Chromium browser viewport resolver", () => {
  it("resolves a mobile preset in portrait orientation", () => {
    const viewport = resolveBrowserViewport({ viewportPreset: "mobile" });

    expect(viewport.preset).toBe("mobile");
    expect(viewport.category).toBe("mobile");
    expect(viewport.orientation).toBe("portrait");
    expect(viewport.width).toBeLessThan(viewport.height);
    expect(viewport.isMobile).toBe(true);
    expect(viewport.hasTouch).toBe(true);
  });

  it("resolves a tablet preset in landscape orientation", () => {
    const viewport = resolveBrowserViewport({
      viewportPreset: "tablet",
      orientation: "landscape",
    });

    expect(viewport.preset).toBe("tablet");
    expect(viewport.category).toBe("tablet");
    expect(viewport.orientation).toBe("landscape");
    expect(viewport.width).toBe(1024);
    expect(viewport.height).toBe(768);
    expect(viewport.width).toBeGreaterThan(viewport.height);
  });

  it("resolves custom dimensions", () => {
    const viewport = resolveBrowserViewport({
      viewportWidth: 1024,
      viewportHeight: 768,
    });

    expect(viewport.category).toBe("custom");
    expect(viewport.source).toBe("custom");
    expect(viewport.width).toBe(1024);
    expect(viewport.height).toBe(768);
    expect(viewport.orientation).toBe("landscape");
  });

  it("respects portrait orientation for custom dimensions by swapping dimensions", () => {
    const viewport = resolveBrowserViewport({
      viewportWidth: 1000,
      viewportHeight: 600,
      orientation: "portrait",
    });

    expect(viewport.width).toBe(600);
    expect(viewport.height).toBe(1000);
    expect(viewport.orientation).toBe("portrait");
  });

  it("treats preset plus custom dimensions as custom dimensions with preset emulation traits", () => {
    const viewport = resolveBrowserViewport({
      viewportPreset: "mobile",
      viewportWidth: 500,
      viewportHeight: 900,
    });

    expect(viewport.preset).toBeUndefined();
    expect(viewport.category).toBe("custom");
    expect(viewport.source).toBe("custom");
    expect(viewport.width).toBe(500);
    expect(viewport.height).toBe(900);
    expect(viewport.isMobile).toBe(true);
    expect(viewport.hasTouch).toBe(true);
  });

  it("preserves preset identity for orientation-only updates", () => {
    const current = resolveBrowserViewport({ viewportPreset: "mobile" });
    const viewport = resolveBrowserViewport({ orientation: "landscape" }, current);

    expect(viewport.preset).toBe("mobile");
    expect(viewport.category).toBe("mobile");
    expect(viewport.source).toBe("preset");
    expect(viewport.orientation).toBe("landscape");
    expect(viewport.width).toBe(844);
    expect(viewport.height).toBe(390);
  });

  it("preserves mobile emulation traits when custom dimensions are based on a mobile viewport", () => {
    const current = resolveBrowserViewport({ viewportPreset: "mobile" });
    const viewport = resolveBrowserViewport({ viewportWidth: 480, viewportHeight: 800 }, current);

    expect(viewport.preset).toBeUndefined();
    expect(viewport.category).toBe("custom");
    expect(viewport.source).toBe("custom");
    expect(viewport.isMobile).toBe(true);
    expect(viewport.hasTouch).toBe(true);
  });

  it("resets back to the default desktop viewport", () => {
    const current = resolveBrowserViewport({ viewportPreset: "mobile" });
    const viewport = resolveBrowserViewport({ resetViewport: true }, current);

    expect(viewport).toEqual(DEFAULT_BROWSER_VIEWPORT);
    expect(viewport.width).toBe(1280);
    expect(viewport.height).toBe(720);
    expect(viewport.orientation).toBe("landscape");
  });

  it("lets reset win over conflicting viewport inputs", () => {
    const current = resolveBrowserViewport({ viewportPreset: "mobile" });
    const viewport = resolveBrowserViewport({
      resetViewport: true,
      viewportPreset: "tablet",
      viewportWidth: 500,
      viewportHeight: 900,
      orientation: "portrait",
    }, current);

    expect(viewport).toEqual(DEFAULT_BROWSER_VIEWPORT);
  });

  it("rejects invalid runtime orientation values", () => {
    expect(() => resolveBrowserViewport({ orientation: "sideways" } as never)).toThrow(
      'orientation must be "portrait" or "landscape"'
    );
  });

  it("rejects viewport areas that are too large", () => {
    expect(() => resolveBrowserViewport({
      viewportWidth: 6000,
      viewportHeight: 6000,
    })).toThrow("Viewport area must be at most");
  });

  it("rejects unknown presets instead of guessing", () => {
    expect(() => resolveBrowserViewport({ viewportPreset: "watch" })).toThrow(
      "Unknown viewport preset"
    );
  });
});
