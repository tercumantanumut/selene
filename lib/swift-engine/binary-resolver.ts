/**
 * Resolution of the bundled selene-engine binary path.
 *
 * Honored sources, in order:
 *   1. options.explicit (tests + dev-mode override)
 *   2. process.resourcesPath/binaries/selene-engine/<platformArch>/selene-engine
 *      (packaged Electron build)
 *   3. Dev fallbacks:
 *        - process.cwd()/../swiftapp/.build/release-bundle/<platform>/<arch>/selene-engine
 *        - process.cwd()/.build/release-bundle/<platform>/<arch>/selene-engine
 *   4. SELENE_ENGINE_BINARY env var
 *
 * Mirrors the resourcesPath pattern used by lib/mcp/stdio-transport.ts but
 * adapted for a NATIVE binary (not Node).
 */

import * as fs from "fs";
import * as path from "path";
import type { SwiftEngineBinaryCandidate } from "./types";

/** Map Node.js platform/arch tuples to the on-disk layout used by build-swift-engine.sh. */
export function getPlatformArchSegment(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin") {
    if (arch === "arm64") return "macos-arm64";
    if (arch === "x64") return "macos-x64";
    return "macos-universal";
  }
  if (platform === "linux") {
    return "linux-x64";
  }
  if (platform === "win32") {
    return "win32-x64";
  }
  return `${platform}-${arch}`;
}

/** Map Node.js platform to the build-swift-engine.sh "platform" segment. */
function getPlatformSegment(): string {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  if (process.platform === "win32") return "win32";
  return process.platform;
}

/** Map Node.js arch to the build-swift-engine.sh "arch" segment. */
function getArchSegment(): string {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x86_64";
  return process.arch;
}

function getBinaryName(): string {
  return process.platform === "win32" ? "selene-engine.exe" : "selene-engine";
}

function isExistingFile(p: string): boolean {
  try {
    const stat = fs.statSync(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

export interface ResolveBinaryOptions {
  /** Explicit override path (used by tests and dev configs). */
  explicit?: string;
  /**
   * Override the implicit resourcesPath. Production callers normally rely on
   * process.resourcesPath, but tests can pass this explicitly.
   */
  resourcesPath?: string;
}

/**
 * Resolve the selene-engine binary location, returning null + warning if no
 * candidate exists. Caller decides whether to fall back to LanceDB.
 */
export function resolveBinaryPath(
  options: ResolveBinaryOptions = {},
): SwiftEngineBinaryCandidate | null {
  const binaryName = getBinaryName();

  // 1. Explicit override wins.
  if (options.explicit) {
    if (isExistingFile(options.explicit)) {
      return { path: options.explicit, source: "explicit" };
    }
    console.warn(
      `[SwiftEngine] explicit binary path not found: ${options.explicit}`,
    );
  }

  // 2. Packaged Electron resources path.
  const resourcesPath =
    options.resourcesPath ??
    process.env.ELECTRON_RESOURCES_PATH ??
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

  if (resourcesPath) {
    const platformArch = getPlatformArchSegment();
    const candidate = path.join(
      resourcesPath,
      "binaries",
      "selene-engine",
      platformArch,
      binaryName,
    );
    if (isExistingFile(candidate)) {
      return { path: candidate, source: "packaged-resources" };
    }
  }

  // 3. Dev-mode fallbacks.
  const platformSeg = getPlatformSegment();
  const archSeg = getArchSegment();
  const devCandidates = [
    path.join(
      process.cwd(),
      "..",
      "swiftapp",
      ".build",
      "release-bundle",
      platformSeg,
      archSeg,
      binaryName,
    ),
    path.join(
      process.cwd(),
      ".build",
      "release-bundle",
      platformSeg,
      archSeg,
      binaryName,
    ),
  ];

  for (const candidate of devCandidates) {
    if (isExistingFile(candidate)) {
      return { path: candidate, source: "dev-build" };
    }
  }

  // 4. SELENE_ENGINE_BINARY env var (last so explicit options.explicit beats it).
  const envOverride = process.env.SELENE_ENGINE_BINARY;
  if (envOverride && isExistingFile(envOverride)) {
    return { path: envOverride, source: "explicit" };
  }

  console.warn(
    `[SwiftEngine] no selene-engine binary found. Tried: ` +
      `resourcesPath=${resourcesPath ?? "<unset>"}, ` +
      `cwd=${process.cwd()}, ` +
      `SELENE_ENGINE_BINARY=${envOverride ?? "<unset>"}`,
  );
  return null;
}
