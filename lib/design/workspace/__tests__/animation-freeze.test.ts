/**
 * Regression coverage for deterministic screenshot captures: animated elements
 * must be frozen to frame zero before computed-style probes and PNG capture.
 */

import { createHash } from "crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/storage/local-storage", () => ({
  saveFile: vi.fn(async (_buf: Buffer, sessionId: string, filename: string) => ({
    localPath: `/mock/${sessionId}/${filename}`,
    url: `/api/media/${sessionId}/${filename}`,
    filePath: `/mock-abs/${sessionId}/${filename}`,
  })),
}));

import { pauseAnimations } from "../screenshot";

const runLive = process.env.RUN_DESIGN_ANIMATION_LIVE === "true";

const FIXTURE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  body { margin: 0; background: white; }
  .spinner {
    width: 96px;
    height: 96px;
    margin: 32px;
    border: 12px solid rgb(219, 234, 254);
    border-top-color: rgb(37, 99, 235);
    border-radius: 9999px;
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
</head>
<body>
  <div class="spinner" aria-label="loading"></div>
</body>
</html>`;

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

describe("pauseAnimations", () => {
  it("injects a capture-time freeze stylesheet after rewinding page animations", async () => {
    const calls: string[] = [];
    const page = {
      evaluate: vi.fn(async () => {
        calls.push("evaluate");
      }),
      addStyleTag: vi.fn(async ({ content }: { content: string }) => {
        calls.push(`style:${content}`);
      }),
    };

    await pauseAnimations(page);

    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect(page.addStyleTag).toHaveBeenCalledWith({
      content: "*,*::before,*::after{animation-play-state:paused!important;transition:none!important;}",
    });
    expect(calls).toEqual([
      "evaluate",
      "style:*,*::before,*::after{animation-play-state:paused!important;transition:none!important;}",
    ]);
  });
});

describe.skipIf(!runLive)("pauseAnimations — live Chromium", () => {
  let available = false;
  let browserMod: typeof import("../browser");

  beforeAll(async () => {
    try {
      browserMod = await import("../browser");
      await browserMod.getSharedBrowser();
      available = true;
    } catch (error) {
      console.warn(
        "[animation-freeze] Skipping — failed to launch shared browser:",
        error instanceof Error ? error.message : error,
      );
      available = false;
    }
  }, 60_000);

  afterAll(async () => {
    if (available && browserMod) {
      await browserMod.disposeBrowser().catch(() => undefined);
    }
  });

  it("freezes CSS animations to frame zero before probes and screenshots", async () => {
    if (!available) return;

    const page = await browserMod.acquirePage();
    try {
      await page.setViewport({ width: 220, height: 160, deviceScaleFactor: 1 });
      await page.setContent(FIXTURE_HTML, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );

      await pauseAnimations(page);

      const probe = await page.evaluate(() => {
        const el = document.querySelector(".spinner");
        if (!el) return null;
        const style = window.getComputedStyle(el);
        return {
          animationPlayState: style.animationPlayState,
          transform: style.transform,
        };
      });
      const first = Buffer.from(
        await page.screenshot({ type: "png", captureBeyondViewport: false }),
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      const second = Buffer.from(
        await page.screenshot({ type: "png", captureBeyondViewport: false }),
      );

      expect(probe?.animationPlayState).toBe("paused");
      expect(["none", "matrix(1, 0, 0, 1, 0, 0)"]).toContain(probe?.transform);
      expect(sha256(first)).toBe(sha256(second));
    } finally {
      await page.close().catch(() => undefined);
    }
  }, 60_000);
});
