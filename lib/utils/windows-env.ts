/**
 * Shared Windows environment cleanup utilities.
 *
 * Centralizes Git Bash / MSYS2 / Cygwin PATH filtering logic and the list of
 * MSYS environment variables that should be stripped from child processes.
 */

import { existsSync } from "fs";
import { join } from "path";

/**
 * Git Bash / MSYS2 / Cygwin PATH segment patterns that provide Unix-shell
 * emulation. These are filtered from PATH so child processes don't discover
 * and use bash.exe.
 *
 * We intentionally keep `\\Git\\cmd` (contains git.exe, gitk, etc.) so Git
 * itself still works - only the Unix-emulation layers are removed.
 *
 * The `\\usr\\bin$` pattern is scoped to Git/MSYS paths to avoid accidentally
 * filtering unrelated directories that happen to end in `\\usr\\bin`.
 */
const GIT_BASH_PATH_PATTERNS: RegExp[] = [
  /\\git\\usr\\bin$/i,
  /\\git\\usr\\lib$/i,
  /\\git\\bin$/i,
  /\\git\\mingw\d*\\bin$/i,
  /\\git\\mingw\d*\\lib$/i,
  /\\mingw\d*\\bin$/i,
  /\\msys\d*\\usr\\bin$/i,
  /\\msys\d*\\bin$/i,
  /\\cygwin\d*\\bin$/i,
];

/**
 * Forward-slash MSYS-style path prefix pattern.
 * Matches paths like /mingw64/bin, /usr/bin, etc. that MSYS2 injects.
 */
const MSYS_FORWARD_SLASH_PREFIX = /^\/(?:usr|bin|mingw|msys|etc|tmp|dev|proc)/;

/**
 * MSYS2-style drive path pattern: /c/Users/... -> C:\Users\...
 * Matches paths starting with /<single letter>/ which is how MSYS2 represents
 * Windows drive letters. Without conversion, these valid Windows paths get
 * dropped entirely instead of being preserved.
 */
const MSYS_DRIVE_PATH = /^\/([a-z])\/(.*)/i;

interface NormalizeWindowsEnvironmentOptions {
  filterGitBashPath?: boolean;
  ensureComSpec?: boolean;
  ensureSystemPaths?: boolean;
  pathKey?: "PATH" | "Path";
}

/**
 * Convert an MSYS2-style path (/c/Program Files/...) to a Windows path
 * (C:\Program Files\...). Returns the original string if it's not an MSYS path.
 */
function convertMsysPath(segment: string): string {
  const match = segment.match(MSYS_DRIVE_PATH);
  if (!match) return segment;
  const driveLetter = match[1]!.toUpperCase();
  const rest = match[2]!.replace(/\//g, "\\");
  return `${driveLetter}:\\${rest}`;
}

/**
 * Filter Git Bash / MSYS2 / Cygwin paths from a Windows PATH string.
 * Prevents child processes from discovering bash.exe via PATH scanning.
 * Preserves `\\Git\\cmd` so git.exe, gitk, etc. remain accessible.
 *
 * MSYS2-style drive paths (e.g. /c/Program Files/Git/cmd) are first converted
 * to Windows format before filtering, so valid paths are preserved rather than
 * dropped entirely.
 */
function filterGitBashFromPath(pathStr: string): string {
  return pathStr
    .split(";")
    .map((seg) => seg.trim())
    .filter(Boolean)
    .map((seg) => {
      if (MSYS_FORWARD_SLASH_PREFIX.test(seg)) return null;
      return convertMsysPath(seg);
    })
    .filter((seg): seg is string => {
      if (!seg) return false;
      return !GIT_BASH_PATH_PATTERNS.some((pattern) => pattern.test(seg));
    })
    .join(";");
}

/**
 * MSYS2 / MINGW environment variables that signal a Unix-shell environment.
 * Removing these prevents child processes from detecting Git Bash context.
 */
const MSYS_ENV_VARS: readonly string[] = [
  "SHELL",
  "MSYSTEM",
  "MSYSTEM_CARCH",
  "MSYSTEM_CHOST",
  "MSYSTEM_PREFIX",
  "MINGW_CHOST",
  "MINGW_PACKAGE_PREFIX",
  "MINGW_PREFIX",
  "MSYS",
  "CHERE_INVOKING",
  "ORIGINAL_PATH",
  "ORIGINAL_TEMP",
  "ORIGINAL_TMP",
  "SHLVL",
  "PLINK_PROTOCOL",
  "EXEPATH",
  "HOSTNAME",
  "PS1",
  "BASH_VERSINFO",
  "BASH_VERSION",
  "MACHTYPE",
  "OSTYPE",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "PKG_CONFIG_PATH",
  "ACLOCAL_PATH",
  "MANPATH",
  "INFOPATH",
  "CONFIG_SITE",
] as const;

/**
 * Consolidate PATH/Path case duplicates in the given env.
 * Windows env is case-insensitive, but when spread into a plain object both
 * "PATH" (MSYS2) and "Path" (Windows) can coexist. Node.js sorts
 * lexicographically, so "PATH" (uppercase, MSYS2 value) silently wins.
 * We merge all variants, dedupe by case-insensitive comparison, and normalize
 * to a single path value.
 */
export function consolidatePathKeys(env: Record<string, string | undefined>): string {
  const pathKeys = Object.keys(env).filter((key) => key.toUpperCase() === "PATH");
  let mergedPath = "";

  if (pathKeys.length > 1) {
    const seen = new Set<string>();
    const segments: string[] = [];

    for (const key of pathKeys) {
      for (const segment of (env[key] || "").split(";")) {
        const trimmed = segment.trim();
        const normalized = trimmed.toLowerCase();
        if (trimmed && !seen.has(normalized)) {
          seen.add(normalized);
          segments.push(trimmed);
        }
      }
      delete env[key];
    }

    mergedPath = segments.join(";");
  } else {
    const pathKey = pathKeys[0] || "Path";
    mergedPath = env[pathKey] || "";
    if (pathKey !== "Path") {
      delete env[pathKey];
    }
  }

  return mergedPath;
}

/**
 * Remove MSYS/Git Bash environment variables from the given environment.
 * Only strips env vars - does not touch PATH. Mutates `env` in place.
 */
function stripMsysEnvVars(env: Record<string, string | undefined>): void {
  for (const varName of MSYS_ENV_VARS) {
    delete env[varName];
  }
}

/**
 * Ensure essential Windows system directories are present in PATH.
 *
 * Some launch contexts (Git Bash, npm lifecycle scripts, scheduled tasks,
 * minimal GUI launch) can produce a PATH that is missing critical system
 * directories like System32. This function appends any missing dirs that
 * exist on disk, acting as a safety net after all other PATH manipulation.
 *
 * No-op on non-Windows platforms.
 */
export function ensureWindowsSystemPaths(currentPath: string): string {
  if (process.platform !== "win32") return currentPath;

  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\WINDOWS";
  const essentialDirs = [
    join(systemRoot, "system32"),
    systemRoot,
    join(systemRoot, "System32", "Wbem"),
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
  ];

  const segments = currentPath.split(";").map((segment) => segment.trim()).filter(Boolean);
  const seen = new Set(segments.map((segment) => segment.toLowerCase()));

  for (const dir of essentialDirs) {
    if (!seen.has(dir.toLowerCase()) && existsSync(dir)) {
      segments.push(dir);
      seen.add(dir.toLowerCase());
    }
  }

  return segments.join(";");
}

/**
 * Normalize a Windows environment object into one canonical shape.
 *
 * This is the low-level primitive used by higher-level environment policies.
 * It strips MSYS markers, consolidates PATH/Path, optionally filters Git Bash
 * segments, optionally restores essential Windows system paths, and optionally
 * ensures ComSpec is present.
 */
export function normalizeWindowsEnvironment(
  env: Record<string, string | undefined>,
  options: NormalizeWindowsEnvironmentOptions = {},
): Record<string, string | undefined> {
  if (process.platform !== "win32") {
    return { ...env };
  }

  const normalized = { ...env };
  const pathKey = options.pathKey ?? "Path";

  stripMsysEnvVars(normalized);

  let pathValue = consolidatePathKeys(normalized);
  if (options.filterGitBashPath) {
    pathValue = filterGitBashFromPath(pathValue);
  }
  if (options.ensureSystemPaths !== false) {
    pathValue = ensureWindowsSystemPaths(pathValue);
  }

  delete normalized.PATH;
  delete normalized.Path;
  normalized[pathKey] = pathValue;

  if (options.ensureComSpec !== false && !normalized.ComSpec) {
    const systemRoot = normalized.SystemRoot || normalized.SYSTEMROOT || process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\WINDOWS";
    normalized.ComSpec = `${systemRoot}\\system32\\cmd.exe`;
  }

  return normalized;
}

/**
 * Full Windows environment cleanup: remove MSYS env vars, consolidate PATH
 * case duplicates, and filter Git Bash paths from PATH. Mutates `env` in place.
 *
 * Use this for environments where we control the shell (for example
 * executeCommand via cmd.exe/PowerShell). Do not use this for the Claude Code
 * SDK, where Git Bash must remain available.
 */
function cleanWindowsEnv(env: Record<string, string | undefined>): void {
  const normalized = normalizeWindowsEnvironment(env, {
    filterGitBashPath: true,
    ensureComSpec: true,
    ensureSystemPaths: true,
    pathKey: "Path",
  });

  for (const key of Object.keys(env)) {
    delete env[key];
  }
  Object.assign(env, normalized);
}
