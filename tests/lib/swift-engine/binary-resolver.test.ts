import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  resolveBinaryPath,
  getPlatformArchSegment,
} from "@/lib/swift-engine/binary-resolver";

/**
 * Build the platform/arch directory segments the way the resolver does, so
 * tests work on whichever host runs them (CI may be linux-x64, dev darwin-arm64).
 */
function getExpectedPlatformSeg(): string {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  if (process.platform === "win32") return "win32";
  return process.platform;
}

function getExpectedArchSeg(): string {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x86_64";
  return process.arch;
}

function getExpectedPackagedSeg(): string {
  if (process.platform === "darwin") {
    if (process.arch === "arm64") return "macos-arm64";
    if (process.arch === "x64") return "macos-x64";
    return "macos-universal";
  }
  if (process.platform === "linux") return "linux-x64";
  if (process.platform === "win32") return "win32-x64";
  return `${process.platform}-${process.arch}`;
}

const BIN_NAME =
  process.platform === "win32" ? "selene-engine.exe" : "selene-engine";

describe("getPlatformArchSegment", () => {
  it("produces a platform-arch hyphenated segment", () => {
    const seg = getPlatformArchSegment();
    expect(seg).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
  });
});

describe("resolveBinaryPath", () => {
  let tmpRoot: string;
  const ORIGINAL_ENV = { ...process.env };
  const ORIGINAL_RESOURCES = (
    process as NodeJS.Process & { resourcesPath?: string }
  ).resourcesPath;
  const ORIGINAL_CWD = process.cwd();

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "selene-binresolver-"));
    delete process.env.SELENE_ENGINE_BINARY;
    delete process.env.ELECTRON_RESOURCES_PATH;
    delete (process as NodeJS.Process & { resourcesPath?: string })
      .resourcesPath;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      process.chdir(ORIGINAL_CWD);
    } catch {
      /* ignore */
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
    if (ORIGINAL_RESOURCES !== undefined) {
      (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath =
        ORIGINAL_RESOURCES;
    }
  });

  function makeFile(target: string): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "#!/usr/bin/env stub\n", { mode: 0o755 });
  }

  it("explicit path wins when it exists", () => {
    const explicit = path.join(tmpRoot, "stub-engine");
    makeFile(explicit);

    const result = resolveBinaryPath({ explicit });
    expect(result).toEqual({ path: explicit, source: "explicit" });
  });

  it("falls back when explicit path does not exist", () => {
    const explicit = path.join(tmpRoot, "missing-engine");
    // Don't create the file.

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = resolveBinaryPath({ explicit });
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("resolves packaged-resources path when resourcesPath has the binary", () => {
    const resourcesPath = path.join(tmpRoot, "Resources");
    const segment = getExpectedPackagedSeg();
    const expected = path.join(
      resourcesPath,
      "binaries",
      "selene-engine",
      segment,
      BIN_NAME,
    );
    makeFile(expected);

    const result = resolveBinaryPath({ resourcesPath });
    expect(result).toEqual({ path: expected, source: "packaged-resources" });
  });

  it("falls back to ../swiftapp/.build/release-bundle in dev", () => {
    // Set up a fake "selene/" cwd whose sibling "swiftapp/" carries the build.
    const fakeCwd = path.join(tmpRoot, "selene");
    fs.mkdirSync(fakeCwd, { recursive: true });
    process.chdir(fakeCwd);

    const expected = path.join(
      fakeCwd,
      "..",
      "swiftapp",
      ".build",
      "release-bundle",
      getExpectedPlatformSeg(),
      getExpectedArchSeg(),
      BIN_NAME,
    );
    makeFile(expected);

    const result = resolveBinaryPath();
    expect(result).not.toBeNull();
    expect(result!.source).toBe("dev-build");
    // Resolve to canonical paths on macOS where /tmp -> /private/tmp.
    expect(fs.realpathSync(result!.path)).toBe(fs.realpathSync(expected));
  });

  it("uses SELENE_ENGINE_BINARY env var when no other source exists", () => {
    const envPath = path.join(tmpRoot, "via-env", "selene-engine");
    makeFile(envPath);
    process.env.SELENE_ENGINE_BINARY = envPath;

    // Make sure cwd-based dev paths can't accidentally match.
    process.chdir(tmpRoot);

    const result = resolveBinaryPath();
    expect(result).toEqual({ path: envPath, source: "explicit" });
  });

  it("returns null with a warning when no candidate exists", () => {
    process.chdir(tmpRoot);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = resolveBinaryPath();
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});
