/**
 * Unit tests for `resolveSandboxRoot()` in `lib/design/libraries.ts`.
 *
 * `resolveSandboxRoot` is private but is the entire computation behind the
 * exported `SANDBOX_DIR` constant — so we cover its env-override + fallback
 * behaviour by re-importing the module with different `process.env`
 * configurations and asserting on the resulting `SANDBOX_DIR`.
 *
 * Added in response to commit 0aff3a43 review which flagged that
 * `LOCAL_DATA_PATH` electron-vs-dev branching had no regression test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { basename, resolve } from "path";

const ORIGINAL_LOCAL_DATA_PATH = process.env.LOCAL_DATA_PATH;

async function importLibrariesFresh(): Promise<typeof import("../../../lib/design/libraries")> {
  vi.resetModules();
  return await import("../../../lib/design/libraries");
}

describe("resolveSandboxRoot (via SANDBOX_DIR)", () => {
  beforeEach(() => {
    delete process.env.LOCAL_DATA_PATH;
  });

  afterEach(() => {
    if (ORIGINAL_LOCAL_DATA_PATH === undefined) {
      delete process.env.LOCAL_DATA_PATH;
    } else {
      process.env.LOCAL_DATA_PATH = ORIGINAL_LOCAL_DATA_PATH;
    }
  });

  it("uses LOCAL_DATA_PATH when set (Electron packaged build path)", async () => {
    const electronDataDir = "/tmp/selene-test-electron-data";
    process.env.LOCAL_DATA_PATH = electronDataDir;

    const lib = await importLibrariesFresh();

    expect(lib.SANDBOX_DIR).toBe(resolve(electronDataDir, "selene-workspace"));
    expect(basename(lib.SANDBOX_DIR)).toBe("selene-workspace");
  });

  it("falls back to project root when LOCAL_DATA_PATH is unset (dev / tests / headless)", async () => {
    const lib = await importLibrariesFresh();

    // Should land under the synced repo root, NOT under /tmp.
    expect(lib.SANDBOX_DIR.startsWith("/tmp/")).toBe(false);
    expect(basename(lib.SANDBOX_DIR)).toBe("selene-workspace");
  });

  it("falls back to project root when LOCAL_DATA_PATH is whitespace-only", async () => {
    process.env.LOCAL_DATA_PATH = "   ";

    const lib = await importLibrariesFresh();

    // Whitespace-only env value must NOT be treated as a valid path; the
    // resolver should fall through to the project-root branch.
    expect(lib.SANDBOX_DIR.includes("   ")).toBe(false);
    expect(basename(lib.SANDBOX_DIR)).toBe("selene-workspace");
  });

  it("falls back to project root when LOCAL_DATA_PATH is empty string", async () => {
    process.env.LOCAL_DATA_PATH = "";

    const lib = await importLibrariesFresh();

    expect(basename(lib.SANDBOX_DIR)).toBe("selene-workspace");
    // node_modules / package.json paths must remain consistent with SANDBOX_DIR
    expect(lib.SANDBOX_NODE_MODULES).toBe(resolve(lib.SANDBOX_DIR, "node_modules"));
    expect(lib.SANDBOX_PACKAGE_JSON).toBe(resolve(lib.SANDBOX_DIR, "package.json"));
  });
});
