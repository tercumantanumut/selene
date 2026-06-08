/**
 * T2.7 regression coverage: a JSX render that references an undefined
 * identifier (e.g. `<UndefinedComponent />`) must surface as a
 * `DesignWorkspaceCompileError` with `report.errors[0].type === "runtime"`
 * — not as a silent screenshot or a 30s preview-ready timeout.
 *
 * The unit half exercises the regex/extractor and the compile-shaped
 * envelope. The live half runs the *real* `captureScreenshot` against a
 * mocked-gallery fixture so we cover the full Puppeteer + esbuild path,
 * including the `window.addEventListener("error", …)` shim in the preview
 * HTML that replaced the previous `window.onerror = … return true`
 * behavior (which silently suppressed Puppeteer's `pageerror`).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/storage/local-storage", () => ({
  saveFile: vi.fn(async (_buf: Buffer, sessionId: string, filename: string) => ({
    localPath: `/mock/${sessionId}/${filename}`,
    url: `/api/media/${sessionId}/${filename}`,
    filePath: `/mock-abs/${sessionId}/${filename}`,
  })),
}));

import { extractRuntimeReferenceError } from "../screenshot";

const runLive = process.env.RUN_DESIGN_RUNTIME_ERROR_LIVE === "true";

describe("extractRuntimeReferenceError", () => {
  it("matches a bare ReferenceError whose message ends in 'is not defined'", () => {
    expect(
      extractRuntimeReferenceError(new ReferenceError("UndefinedComponent is not defined")),
    ).toBe("UndefinedComponent is not defined");
  });

  it("matches an error string already prefixed with 'ReferenceError: '", () => {
    expect(
      extractRuntimeReferenceError("ReferenceError: Missing is not defined\n    at App"),
    ).toBe("Missing is not defined");
  });

  it("returns undefined for non-reference errors", () => {
    expect(extractRuntimeReferenceError(new TypeError("bad type"))).toBeUndefined();
    expect(extractRuntimeReferenceError("Random failure")).toBeUndefined();
  });
});

describe.skipIf(!runLive)("captureScreenshot — live undefined-JSX-identifier", () => {
  const FIXTURE_ID = "cmp_runtime_fixture";
  const FIXTURE_NAME = "Runtime Fixture";
  const FIXTURE_CODE = `
import React from "react";
export default function Fixture() {
  return <UndefinedComponent />;
}
`;

  let available = false;
  let browserMod: typeof import("../browser");
  let captureScreenshot: typeof import("../screenshot").captureScreenshot;

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock("@/lib/design/gallery/service", () => ({
      findWorkspaceDesign: vi.fn(async () => ({
        id: FIXTURE_ID,
        name: FIXTURE_NAME,
        code: FIXTURE_CODE,
      })),
    }));
    try {
      browserMod = await import("../browser");
      await browserMod.getSharedBrowser();
      const screenshotMod = await import("../screenshot");
      captureScreenshot = screenshotMod.captureScreenshot;
      available = true;
    } catch (error) {
      console.warn(
        "[runtime-error-folding] Skipping — failed to launch shared browser:",
        error instanceof Error ? error.message : error,
      );
      available = false;
    }
  }, 60_000);

  afterAll(async () => {
    if (available && browserMod) {
      await browserMod.disposeBrowser().catch(() => undefined);
    }
    vi.doUnmock("@/lib/design/gallery/service");
    vi.resetModules();
  });

  it("rejects with a runtime-tagged compile envelope and never returns a screenshot", async () => {
    if (!available) return;

    let thrown: unknown;
    try {
      await captureScreenshot({
        componentId: FIXTURE_ID,
        sessionId: "sess_runtime_fixture",
        userId: "user_runtime_fixture",
        theme: "light",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    expect(thrown).toBeInstanceOf(Error);

    const error = thrown as Error & {
      report?: {
        errors?: Array<{ type?: string; message?: string }>;
      };
      screenshot?: unknown;
    };

    expect(error.name).toBe("DesignWorkspaceCompileError");
    expect(error.message).toMatch(/UndefinedComponent.*is not defined/);
    expect(error.report?.errors?.[0]?.type).toBe("runtime");
    expect(error.report?.errors?.[0]?.message).toMatch(/UndefinedComponent.*is not defined/);
    // The thrown envelope intentionally carries no screenshot.
    expect(error.screenshot).toBeUndefined();
  }, 60_000);
});
