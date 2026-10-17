import { describe, expect, it } from "vitest";

import {
  finalizeHistory,
  initHistory,
  peekHistory,
  recordAction,
} from "@/lib/browser/action-history";
import { DEFAULT_BROWSER_VIEWPORT } from "@/lib/browser/viewport";

describe("browser action history", () => {
  it("persists the resolved viewport with recorded actions", () => {
    const sessionId = `viewport-history-${Date.now()}-${Math.random()}`;

    initHistory(sessionId);
    recordAction(sessionId, "snapshot", { action: "snapshot" }, {
      success: true,
      durationMs: 12,
      output: "snapshot output",
      viewport: DEFAULT_BROWSER_VIEWPORT,
    });

    const peeked = peekHistory(sessionId);
    expect(peeked?.actions[0].viewport).toEqual(DEFAULT_BROWSER_VIEWPORT);

    const finalized = finalizeHistory(sessionId);
    expect(finalized?.actions[0].viewport).toEqual(DEFAULT_BROWSER_VIEWPORT);
  });
});
