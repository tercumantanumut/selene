/** @vitest-environment jsdom */

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ActEnvironmentGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
(globalThis as ActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const fetchMocks = vi.hoisted(() => ({
  resilientFetch: vi.fn(),
}));

vi.mock("@/lib/utils/resilient-fetch", () => ({
  resilientFetch: fetchMocks.resilientFetch,
}));

import { useContextStatus, type ContextStatusInfo } from "@/lib/hooks/use-context-status";

function makeStatus(currentTokens: number): ContextStatusInfo {
  return {
    percentage: currentTokens / 2_000,
    status: "safe",
    currentTokens,
    maxInputTokens: 200_000,
    maxTokens: 200_000,
    formatted: {
      current: String(currentTokens),
      max: "200K",
      percentage: `${currentTokens / 2_000}%`,
    },
    thresholds: {
      warning: 150_000,
      critical: 180_000,
      hardLimit: 190_000,
    },
    shouldCompact: false,
    mustCompact: false,
    recommendedAction: "",
  };
}

function Harness({ sessionId }: { sessionId: string }) {
  const { status, refresh } = useContextStatus({
    sessionId,
    pollIntervalMs: 0,
  });

  return createElement(
    "button",
    { type: "button", onClick: () => void refresh() },
    status?.currentTokens ?? "loading",
  );
}

describe("useContextStatus", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    fetchMocks.resilientFetch.mockReset();
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

  it("bypasses the fresh cache for an explicit live refresh", async () => {
    fetchMocks.resilientFetch
      .mockResolvedValueOnce({ data: makeStatus(1_250), error: null, timedOut: false, status: 200 })
      .mockResolvedValueOnce({ data: makeStatus(8_500), error: null, timedOut: false, status: 200 });

    await act(async () => {
      root.render(createElement(Harness, { sessionId: "delegated-live-refresh" }));
    });

    expect(fetchMocks.resilientFetch).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("1250");

    await act(async () => {
      container.querySelector("button")?.click();
    });

    expect(fetchMocks.resilientFetch).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("8500");
  });
});
