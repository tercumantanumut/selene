import { execFile, type ExecFileOptions } from "child_process";
import fs from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { promisify } from "util";
import {
  DESIGN_LIBRARIES,
  SANDBOX_DIR,
  SANDBOX_NODE_MODULES,
  SANDBOX_PACKAGE_JSON,
  detectAvailableLibraries,
  ensureSandboxDir,
  registerRuntimeLibrary,
  validatePackageSpec,
} from "../libraries";
import { getProjectRoot } from "../../utils/project-root";
import {
  tsconfigAliasMatches,
  type TsconfigPathsConfig,
} from "./tsconfig-paths";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = getProjectRoot();
const IS_WINDOWS = process.platform === "win32";

export interface DependencyValidationResult {
  manifestPackages: string[];
  importedPackages: string[];
  checkedPackages: string[];
  missingManifestPackages: string[];
  missingImportedPackages: string[];
  missingPackages: string[];
}

export interface DependencyInstallResult {
  attempted: boolean;
  success: boolean;
  packages: string[];
  packageNames: string[];
  error?: string;
}

let installLock: Promise<void> | null = null;

/**
 * Resolve the npm command and exec options for the current platform.
 *
 * On Windows, `npm.cmd` is a batch script that requires a shell to execute.
 * Using `execFile` without `shell: true` causes "spawn EINVAL" errors.
 * We use `shell: true` on Windows so `npm.cmd` runs through cmd.exe, which
 * matches the resolution strategy used by the main executor-runtime for
 * environments where a bundled Node/npm-cli.js is unavailable.
 */
function getNpmExecConfig(): { command: string; options: ExecFileOptions } {
  return {
    command: IS_WINDOWS ? "npm.cmd" : "npm",
    options: IS_WINDOWS ? { shell: true } : {},
  };
}

function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))];
}

function normalizePackageName(specifier: string): string | null {
  if (
    !specifier ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("@/") ||
    specifier.startsWith("node:") ||
    specifier.startsWith("http:") ||
    specifier.startsWith("https:") ||
    specifier.startsWith("data:")
  ) {
    return null;
  }

  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return scope && name ? `${scope}/${name}` : null;
  }

  return specifier.split("/")[0] || null;
}

function collectPackageMatches(code: string, pattern: RegExp): string[] {
  const matches: string[] = [];
  for (const match of code.matchAll(pattern)) {
    const packageName = normalizePackageName(match[1] ?? "");
    if (packageName) {
      matches.push(packageName);
    }
  }
  return matches;
}

function extractImportedPackages(componentCode: string): string[] {
  return uniqueStrings([
    ...collectPackageMatches(
      componentCode,
      /\b(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["'`]([^"'`]+)["'`]/g,
    ),
    ...collectPackageMatches(componentCode, /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g),
    ...collectPackageMatches(componentCode, /\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g),
  ]);
}

async function readSandboxManifestPackages(): Promise<string[]> {
  await ensureSandboxDir();

  try {
    const raw = await fs.readFile(SANDBOX_PACKAGE_JSON, "utf8");
    const parsed = JSON.parse(raw) as { dependencies?: Record<string, string> };
    return Object.keys(parsed.dependencies ?? {});
  } catch {
    return [];
  }
}

/**
 * Check whether a package is installed by looking for its directory on disk.
 *
 * `require.resolve` is unreliable here because Next.js / Turbopack shims it in
 * the bundled server runtime, so dynamically-installed packages are invisible to
 * it even though they exist on disk.  A direct filesystem check is immune to
 * bundler transformations and works consistently across dev, production, and
 * Electron builds.
 */
function canResolvePackage(packageName: string, nodeModulesDirs: string[]): boolean {
  for (const dir of nodeModulesDirs) {
    if (existsSync(join(dir, packageName, "package.json"))) {
      return true;
    }
    // Some packages may not have package.json at the expected path (e.g.
    // symlinked workspaces) — fall back to checking the directory itself.
    if (existsSync(join(dir, packageName))) {
      return true;
    }
  }
  return false;
}

/**
 * Optional context the `import` action threads through so the dependency
 * check matches the resolver's actual capabilities:
 *
 *   - `tsconfigPaths` — when present, any imported specifier matching a
 *     tsconfig paths rule is treated as resolvable (the compiler installs
 *     `createTsconfigPathsPlugin` which rewrites those specifiers to
 *     real on-disk files). Without this, a synced-repo import like
 *     `@/lib/utils` would surface as a missing npm package because
 *     `normalizePackageName` only filters the literal `@/` prefix and a
 *     repo using `~/` or any other custom alias would slip through.
 *
 *   - `extraNodePaths` — additional `node_modules` roots esbuild's
 *     `nodePaths` falls back to. The `import` action passes the synced
 *     repo's `node_modules` so packages installed only there (e.g.
 *     `framer-motion` in a customer app) count as resolved without
 *     forcing a sandbox install. Sandbox order is preserved for
 *     classification — these are AFTER `SANDBOX_NODE_MODULES`.
 *
 * Both are intentionally optional. `generate` / `edit` / `patch` keep the
 * historical behavior because they don't have a real on-disk source file
 * (the LLM emits TSX) and leaning on synced-repo node_modules would make
 * those flows non-deterministic.
 */
export interface ValidateWorkspaceDependenciesOptions {
  tsconfigPaths?: TsconfigPathsConfig;
  extraNodePaths?: readonly string[];
}

export async function validateWorkspaceDependencies(
  componentCode: string,
  options: ValidateWorkspaceDependenciesOptions = {},
): Promise<DependencyValidationResult> {
  const manifestPackages = await readSandboxManifestPackages();
  const importedPackages = extractImportedPackages(componentCode);
  const knownWorkspacePackages = new Set(DESIGN_LIBRARIES.map((library) => library.package));

  const PROJECT_NODE_MODULES = join(PROJECT_ROOT, "node_modules");
  // Search list mirrors the esbuild build option — sandbox first so the
  // curated copy wins on collisions, then synced-repo `node_modules`
  // (only set for the `import` action), then the host project's own
  // node_modules as the universal fallback. Duplicates from the caller
  // are filtered so nodePaths surface noise (`/path` passed twice) does
  // not double the per-package stat cost.
  const importResolutionDirs = uniqueStrings([
    SANDBOX_NODE_MODULES,
    ...(options.extraNodePaths ?? []),
    PROJECT_NODE_MODULES,
  ]);

  const missingManifestPackages = manifestPackages.filter(
    (packageName) => !canResolvePackage(packageName, [SANDBOX_NODE_MODULES]),
  );

  // An imported package belongs to the workspace if it appears in the sandbox
  // manifest OR the known design-library registry.  No hardcoded package names
  // — the LLM decides what to install; this layer only validates resolution.
  const manifestSet = new Set(manifestPackages);
  const importedWorkspacePackages = importedPackages.filter((packageName) => {
    // Rev-J3 — when a tsconfig paths rule covers the specifier, esbuild
    // will resolve it via `createTsconfigPathsPlugin` and never consult
    // the workspace dependency list, so flagging it as a workspace
    // package would just produce a false-positive missing-package error.
    if (
      options.tsconfigPaths &&
      tsconfigAliasMatches(packageName, options.tsconfigPaths)
    ) {
      return false;
    }
    return manifestSet.has(packageName) || knownWorkspacePackages.has(packageName);
  });

  const missingImportedPackages = importedWorkspacePackages.filter(
    (packageName) => !canResolvePackage(packageName, importResolutionDirs),
  );

  const missingPackages = uniqueStrings([
    ...missingManifestPackages,
    ...missingImportedPackages,
  ]);

  return {
    manifestPackages,
    importedPackages,
    checkedPackages: uniqueStrings([...manifestPackages, ...importedWorkspacePackages]),
    missingManifestPackages,
    missingImportedPackages,
    missingPackages,
  };
}

function extractPackageNames(specs: string[]): string[] {
  return specs.map((spec) => {
    if (spec.startsWith("@")) {
      const slashIndex = spec.indexOf("/");
      if (slashIndex === -1) {
        return spec;
      }

      const afterSlash = spec.slice(slashIndex + 1);
      const versionIndex = afterSlash.indexOf("@");
      return versionIndex === -1 ? spec : spec.slice(0, slashIndex + 1 + versionIndex);
    }

    const versionIndex = spec.indexOf("@");
    return versionIndex === -1 ? spec : spec.slice(0, versionIndex);
  });
}

export async function installSandboxPackages(
  packages: string[],
): Promise<DependencyInstallResult> {
  const specs = uniqueStrings(
    packages
      .map((packageName) => validatePackageSpec(packageName))
      .filter((result) => result.valid)
      .map((result) => result.spec),
  );

  if (specs.length === 0) {
    return {
      attempted: false,
      success: true,
      packages: [],
      packageNames: [],
    };
  }

  const packageNames = extractPackageNames(specs);

  const doInstall = async () => {
    await ensureSandboxDir();
    const { command, options: platformOptions } = getNpmExecConfig();
    await execFileAsync(
      command,
      ["install", "--save", "--ignore-scripts", ...specs],
      {
        cwd: SANDBOX_DIR,
        timeout: 120_000,
        env: { ...process.env, NODE_ENV: "development" },
        ...platformOptions,
      },
    );
  };

  const myInstall = (installLock ?? Promise.resolve())
    .catch(() => {})
    .then(doInstall);
  installLock = myInstall;

  try {
    await myInstall;
  } catch (error) {
    return {
      attempted: true,
      success: false,
      packages: specs,
      packageNames,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  for (const packageName of packageNames) {
    registerRuntimeLibrary({
      name: packageName,
      package: packageName,
      description: `Installed package: ${packageName}`,
      importExamples: [`import ... from "${packageName}"`],
    });
  }

  await detectAvailableLibraries();

  return {
    attempted: true,
    success: true,
    packages: specs,
    packageNames,
  };
}
