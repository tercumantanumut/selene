/** @vitest-environment jsdom */

/**
 * Sprint 7 W7.1.G — SwiftEngineSettings component tests.
 *
 * Mirrors the existing tests/components/* pattern (createRoot + flushSync).
 * Avoids react-testing-library to stay consistent with the rest of the suite.
 */

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Settle pending microtasks + macrotasks + any state updates queued
 * inside effects. React 19 doesn't expose `act` outside the dev build, so we
 * yield to the event loop a few times to drain promise chains and then call
 * `flushSync` to commit any setState batches that fired off as a result.
 */
async function flushAll() {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  }
  flushSync(() => {});
}

import { SwiftEngineSettings } from "@/components/settings/swift-engine-settings";
import type { SwiftEngineHealth } from "@/lib/swift-engine/types";
import type {
  EngineSelectionEvent,
  EngineSelectionStats,
} from "@/lib/swift-engine/telemetry";

// Mock the settings hook so the component doesn't try to fetch /api/settings.
const { mockUseSettings, mockInvalidate } = vi.hoisted(() => ({
  mockUseSettings: vi.fn(),
  mockInvalidate: vi.fn(),
}));

vi.mock("@/lib/hooks/use-settings", () => ({
  useSettings: mockUseSettings,
  invalidateSettingsCache: mockInvalidate,
  fetchSettingsOnce: vi.fn(),
}));

function makeHealth(overrides: Partial<SwiftEngineHealth> = {}): SwiftEngineHealth {
  return {
    state: "ready",
    pid: 12345,
    uptimeMs: 60_000,
    totals: { requests: 7, errors: 1, restarts: 0 },
    ...overrides,
  };
}

function makeStats(overrides: Partial<EngineSelectionStats> = {}): EngineSelectionStats {
  return {
    totals: { lance: 3, swift: 2 },
    fallbacks: 1,
    totalEvents: 5,
    ...overrides,
  };
}

describe("SwiftEngineSettings", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    mockUseSettings.mockReset();
    mockInvalidate.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  function expand(c: HTMLElement) {
    const headerButton = c.querySelector("button[aria-expanded]") as HTMLButtonElement;
    expect(headerButton).not.toBeNull();
    flushSync(() => {
      headerButton.click();
    });
  }

  function getToggle(c: HTMLElement): HTMLInputElement {
    const t = c.querySelector<HTMLInputElement>('[data-testid="swift-engine-toggle"]');
    if (!t) throw new Error("toggle not found");
    return t;
  }

  it("renders without crashing and starts collapsed", () => {
    mockUseSettings.mockReturnValue({ settings: null, isLoading: false });

    flushSync(() => {
      root.render(
        createElement(SwiftEngineSettings, {
          healthLoader: () => Promise.resolve(makeHealth()),
          statsLoader: () => Promise.resolve(makeStats()),
          saveEngine: vi.fn(),
        }),
      );
    });

    expect(container.querySelector('[data-testid="swift-engine-settings"]')).not.toBeNull();
    // Section is collapsed by default — toggle is not rendered yet.
    expect(container.querySelector('[data-testid="swift-engine-toggle"]')).toBeNull();
    // Header copy is always visible.
    expect(container.textContent).toContain("Swift Search Engine (Experimental)");
  });

  it("toggle reflects the current `vectorSearchSearchEngine` setting (lance → unchecked)", () => {
    mockUseSettings.mockReturnValue({
      settings: { vectorSearchSearchEngine: "lance" },
      isLoading: false,
    });

    flushSync(() => {
      root.render(
        createElement(SwiftEngineSettings, {
          healthLoader: () => Promise.resolve(makeHealth({ state: "idle" })),
          statsLoader: () => Promise.resolve(makeStats()),
          saveEngine: vi.fn(),
        }),
      );
    });

    expand(container);
    const toggle = getToggle(container);
    expect(toggle.checked).toBe(false);
  });

  it("toggle reflects the current `vectorSearchSearchEngine` setting (swift → checked)", () => {
    mockUseSettings.mockReturnValue({
      settings: { vectorSearchSearchEngine: "swift" },
      isLoading: false,
    });

    flushSync(() => {
      root.render(
        createElement(SwiftEngineSettings, {
          healthLoader: () => Promise.resolve(makeHealth()),
          statsLoader: () => Promise.resolve(makeStats()),
          saveEngine: vi.fn(),
        }),
      );
    });

    expand(container);
    const toggle = getToggle(container);
    expect(toggle.checked).toBe(true);
  });

  it("flipping the toggle calls saveEngine with the new value", async () => {
    mockUseSettings.mockReturnValue({
      settings: { vectorSearchSearchEngine: "lance" },
      isLoading: false,
    });

    const saveEngine = vi.fn().mockResolvedValue(true);

    flushSync(() => {
      root.render(
        createElement(SwiftEngineSettings, {
          healthLoader: () => Promise.resolve(makeHealth()),
          statsLoader: () => Promise.resolve(makeStats()),
          saveEngine,
        }),
      );
    });

    expand(container);
    const toggle = getToggle(container);

    // Flip ON.
    flushSync(() => {
      toggle.click();
    });
    await flushAll();

    expect(saveEngine).toHaveBeenCalledTimes(1);
    expect(saveEngine).toHaveBeenCalledWith("swift");

    // Flip OFF.
    flushSync(() => {
      toggle.click();
    });
    await flushAll();
    expect(saveEngine).toHaveBeenCalledWith("lance");
    expect(saveEngine).toHaveBeenCalledTimes(2);
  });

  it("reverts the toggle and shows an error when saveEngine returns false", async () => {
    mockUseSettings.mockReturnValue({
      settings: { vectorSearchSearchEngine: "lance" },
      isLoading: false,
    });

    const saveEngine = vi.fn().mockResolvedValue(false);

    flushSync(() => {
      root.render(
        createElement(SwiftEngineSettings, {
          healthLoader: () => Promise.resolve(makeHealth()),
          statsLoader: () => Promise.resolve(makeStats()),
          saveEngine,
        }),
      );
    });

    expand(container);
    const toggle = getToggle(container);

    flushSync(() => {
      toggle.click();
    });
    // Settle the saveEngine promise + the resulting setState calls.
    await flushAll();

    expect(saveEngine).toHaveBeenCalledWith("swift");
    expect(getToggle(container).checked).toBe(false);
    const err = container.querySelector('[data-testid="swift-engine-save-error"]');
    expect(err?.textContent).toContain("Failed to save");
  });

  it("displays health state from the injected loader", async () => {
    mockUseSettings.mockReturnValue({
      settings: { vectorSearchSearchEngine: "swift" },
      isLoading: false,
    });

    const health = makeHealth({
      state: "degraded",
      totals: { requests: 42, errors: 3, restarts: 2 },
    });

    flushSync(() => {
      root.render(
        createElement(SwiftEngineSettings, {
          healthLoader: () => Promise.resolve(health),
          statsLoader: () => Promise.resolve(makeStats()),
          saveEngine: vi.fn(),
        }),
      );
    });

    expand(container);
    await flushAll();

    const badge = container.querySelector('[data-testid="swift-engine-state-badge"]');
    expect(badge?.textContent).toBe("degraded");

    expect(
      container.querySelector('[data-testid="swift-engine-requests"]')?.textContent,
    ).toContain("42");
    expect(
      container.querySelector('[data-testid="swift-engine-errors"]')?.textContent,
    ).toContain("3");
    expect(
      container.querySelector('[data-testid="swift-engine-restarts"]')?.textContent,
    ).toContain("2");
  });

  it("falls back to idle state when health loader returns null", async () => {
    mockUseSettings.mockReturnValue({
      settings: { vectorSearchSearchEngine: "lance" },
      isLoading: false,
    });

    flushSync(() => {
      root.render(
        createElement(SwiftEngineSettings, {
          healthLoader: () => Promise.resolve(null),
          statsLoader: () => Promise.resolve(makeStats()),
          saveEngine: vi.fn(),
        }),
      );
    });

    expand(container);
    await flushAll();

    const badge = container.querySelector('[data-testid="swift-engine-state-badge"]');
    expect(badge?.textContent).toBe("idle");
  });

  it("displays engine-selection stats and the last event line", async () => {
    mockUseSettings.mockReturnValue({
      settings: { vectorSearchSearchEngine: "swift" },
      isLoading: false,
    });

    const lastEvent: EngineSelectionEvent = {
      engine: "lance",
      outcome: "fallback-unavailable",
      durationMs: 18,
      errorCode: "swift_unavailable:starting",
    };

    flushSync(() => {
      root.render(
        createElement(SwiftEngineSettings, {
          healthLoader: () => Promise.resolve(makeHealth()),
          statsLoader: () =>
            Promise.resolve(
              makeStats({
                totals: { lance: 12, swift: 8 },
                fallbacks: 4,
                totalEvents: 20,
                lastEvent,
              }),
            ),
          saveEngine: vi.fn(),
        }),
      );
    });

    expand(container);
    await flushAll();

    expect(
      container.querySelector('[data-testid="swift-engine-stats-lance"]')?.textContent,
    ).toContain("12");
    expect(
      container.querySelector('[data-testid="swift-engine-stats-swift"]')?.textContent,
    ).toContain("8");
    expect(
      container.querySelector('[data-testid="swift-engine-stats-fallbacks"]')?.textContent,
    ).toContain("4");
    expect(
      container.querySelector('[data-testid="swift-engine-stats-total"]')?.textContent,
    ).toContain("20");

    const last = container.querySelector('[data-testid="swift-engine-stats-last"]');
    expect(last?.textContent).toContain("lance");
    expect(last?.textContent).toContain("fallback-unavailable");
    expect(last?.textContent).toContain("18ms");
    expect(last?.textContent).toContain("swift_unavailable:starting");
  });
});
