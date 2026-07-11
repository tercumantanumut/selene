import { relative } from "path";

const DEFAULT_IGNORED_DIRECTORY_NAMES = [
  // Dependency trees
  "node_modules",
  "bower_components",
  "jspm_packages",
  ".pnpm-store",
  ".yarn",
  "vendor", // PHP Composer / Go
  ".bundle", // Ruby Bundler
  "Pods", // iOS CocoaPods
  ".dart_tool", // Dart/Flutter

  // Source-control and editor metadata
  ".git",
  ".vscode",
  ".idea",

  // Build and generated output
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".astro",
  ".docusaurus",
  ".output",
  ".vercel",
  ".netlify",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "storybook-static",
  "dist-electron",
  "DerivedData",
  ".local-data",

  // Tool and package-manager caches
  ".cache",
  ".parcel-cache",
  ".turbo",
  ".nx",
  ".angular",
  ".vite",
  ".gradle",
  "tmp",
  "temp",

  // Python virtual environments, dependencies, and caches
  ".venv",
  "venv",
  "env",
  ".env",
  ".conda",
  ".direnv",
  "__pypackages__",
  "__pycache__",
  "site-packages",
  ".eggs",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
  ".hypothesis",
  ".ipynb_checkpoints",
];

const DEFAULT_IGNORED_FILE_NAMES = [
  ".DS_Store",
  "Thumbs.db",
  ".eslintcache",
  ".stylelintcache",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];

const DEFAULT_IGNORED_FILE_GLOBS = [
  "*.tsbuildinfo",
  "*.log",
  "*.lock",
  "*.pyc",
  "*.pyo",
  "*.egg-info",
];

const RAW_DEFAULT_IGNORE_PATTERNS = [
  ...DEFAULT_IGNORED_DIRECTORY_NAMES,
  ...DEFAULT_IGNORED_FILE_NAMES,
  ...DEFAULT_IGNORED_FILE_GLOBS,
  ...DEFAULT_IGNORED_DIRECTORY_NAMES.map((name) => `**/${name}/**`),
];

export const DEFAULT_IGNORE_PATTERNS = Array.from(new Set(RAW_DEFAULT_IGNORE_PATTERNS));

const IMAGE_ASSET_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "cur",
  "gif",
  "heic",
  "heif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "psd",
  "svg",
  "tif",
  "tiff",
  "webp",
]);
const FONT_ASSET_EXTENSIONS = new Set(["eot", "otf", "ttf", "woff", "woff2"]);
const MEDIA_ASSET_EXTENSIONS = new Set([
  "aac",
  "avi",
  "flac",
  "m4a",
  "mkv",
  "mov",
  "mp3",
  "mp4",
  "ogg",
  "wav",
  "webm",
]);
const DEFAULT_BINARY_ASSET_EXTENSIONS = new Set([
  ...IMAGE_ASSET_EXTENSIONS,
  ...FONT_ASSET_EXTENSIONS,
  ...MEDIA_ASSET_EXTENSIONS,
  "7z",
  "gz",
  "pdf",
  "rar",
  "tar",
  "zip",
]);
const IMAGE_ASSET_DIRECTORY_NAMES = new Set([
  "icons",
  "image",
  "images",
  "img",
  "imgs",
  "photos",
  "screenshots",
]);
const FONT_ASSET_DIRECTORY_NAMES = new Set(["font", "fonts", "typefaces"]);
const ASSET_CONTAINER_DIRECTORY_NAMES = new Set([
  "assets",
  "docs",
  "media",
  "public",
  "resources",
  "static",
]);
const DEFAULT_IGNORED_DIRECTORY_NAME_SET = new Set(DEFAULT_IGNORED_DIRECTORY_NAMES);
const DEFAULT_IGNORED_FILE_NAME_SET = new Set(DEFAULT_IGNORED_FILE_NAMES);

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function normalizePattern(pattern: string): string {
  let p = pattern.trim();
  if (!p) return "";
  if (p.startsWith("./")) p = p.slice(2);
  if (p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(pattern: string): RegExp {
  let p = pattern;
  const rootAnchored = p.startsWith("/");
  if (rootAnchored) p = p.slice(1);
  if (!rootAnchored && !p.startsWith("**/")) {
    p = `**/${p}`;
  }

  let out = "";
  for (let i = 0; i < p.length; i += 1) {
    const char = p[i];
    if (char === "*") {
      if (p[i + 1] === "*" && p[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else if (p[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(char);
    }
  }

  return new RegExp(`^${out}$`);
}

function segmentMatcher(pattern: string): (path: string) => boolean {
  const escaped = escapeRegex(pattern);
  const regex = new RegExp(`(^|/)${escaped}(/|$)`);
  return (path) => regex.test(path);
}

function subpathMatcher(pattern: string): (path: string) => boolean {
  const normalized = normalizePath(pattern);
  const escaped = escapeRegex(normalized);
  const regex = new RegExp(`(^|/)${escaped}(/|$)`);
  return (path) => regex.test(path);
}

export function createIgnoreMatcher(patterns: string[], basePath?: string) {
  const matchers = patterns
    .map((raw) => normalizePattern(raw))
    .filter(Boolean)
    .map((pattern) => {
      const hasGlob = /[*?]/.test(pattern);
      const hasSlash = pattern.includes("/");

      if (!hasGlob && !hasSlash) {
        return segmentMatcher(pattern);
      }

      if (!hasGlob && hasSlash) {
        return subpathMatcher(pattern);
      }

      const regex = globToRegex(pattern);
      return (path: string) => regex.test(path);
    });

  return (filePath: string): boolean => {
    const normalized = normalizePath(filePath);
    if (!basePath) {
      return matchers.some((matcher) => matcher(normalized));
    }

    const relativePath = normalizePath(relative(basePath, filePath));
    const scopedPath = relativePath === ".." || relativePath.startsWith("../")
      ? normalized
      : relativePath;

    return matchers.some((matcher) => matcher(scopedPath));
  };
}

function getScopedPathSegments(path: string, basePath?: string): string[] {
  const normalized = normalizePath(path);
  if (!basePath) {
    return normalized.split("/").filter(Boolean);
  }

  const relativePath = normalizePath(relative(basePath, path));
  if (!relativePath || relativePath === ".") {
    return [];
  }

  // Watcher callbacks should stay under basePath. If a platform-specific path
  // representation makes relative() escape the root, fall back to the received
  // path rather than accidentally treating the selected root as ignored.
  const scopedPath = relativePath === ".." || relativePath.startsWith("../")
    ? normalized
    : relativePath;
  return scopedPath.split("/").filter(Boolean);
}

function hasIgnoredDirectorySegment(path: string, basePath?: string): boolean {
  const segments = getScopedPathSegments(path, basePath);
  return segments.some((segment, index) => {
    if (!DEFAULT_IGNORED_DIRECTORY_NAME_SET.has(segment)) {
      return false;
    }

    // ".env" is commonly a file; only auto-ignore it when it appears as a directory segment.
    if (segment === ".env") {
      return index < segments.length - 1;
    }

    return true;
  });
}

function hasIgnoredFileName(path: string): boolean {
  const normalized = normalizePath(path);
  const fileName = normalized.split("/").pop() ?? normalized;
  return DEFAULT_IGNORED_FILE_NAME_SET.has(fileName);
}

function includesAnyExtension(includeExtensions: Set<string>, candidates: Set<string>): boolean {
  for (const extension of candidates) {
    if (includeExtensions.has(extension)) {
      return true;
    }
  }
  return false;
}

function isExcludedAssetDirectory(
  path: string,
  basePath: string | undefined,
  includeExtensions: Set<string>
): boolean {
  // An empty extension filter means "all files", so automatic asset pruning
  // must stay disabled in that mode.
  if (includeExtensions.size === 0) {
    return false;
  }

  const segments = getScopedPathSegments(path, basePath).map((segment) => segment.toLowerCase());
  const shouldPruneImages = !includesAnyExtension(includeExtensions, IMAGE_ASSET_EXTENSIONS);
  const shouldPruneFonts = !includesAnyExtension(includeExtensions, FONT_ASSET_EXTENSIONS);

  return segments.some((segment, index) => {
    const isExcludedAssetType =
      (shouldPruneImages && IMAGE_ASSET_DIRECTORY_NAMES.has(segment)) ||
      (shouldPruneFonts && FONT_ASSET_DIRECTORY_NAMES.has(segment));
    if (!isExcludedAssetType) {
      return false;
    }

    // Avoid treating source folders such as src/icons as binary asset trees.
    // Prune top-level asset folders and those nested under known asset roots.
    return index === 0 || segments
      .slice(0, index)
      .some((parent) => ASSET_CONTAINER_DIRECTORY_NAMES.has(parent));
  });
}

function isBinaryAssetPath(path: string, includeExtensions: Set<string>): boolean {
  // An empty extension filter means "all files".
  if (includeExtensions.size === 0) {
    return false;
  }

  const normalized = normalizePath(path);
  const fileName = normalized.split("/").pop() ?? normalized;
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex < 0) return false;

  const extension = fileName.slice(dotIndex + 1).toLowerCase();
  if (!DEFAULT_BINARY_ASSET_EXTENSIONS.has(extension)) {
    return false;
  }

  return !includeExtensions.has(extension);
}

/**
 * Creates a highly optimized ignore function for vector discovery and file
 * watching. Directory checks happen before recursion so dependency, cache,
 * build, virtualenv, and unrequested asset trees are never traversed.
 */
export function createAggressiveIgnore(
  patterns: string[],
  basePath?: string,
  includeExtensions: string[] = []
) {
  const shouldIgnore = createIgnoreMatcher(patterns, basePath);
  const normalizedIncludeExtensions = new Set(includeExtensions.map((ext) =>
    ext.startsWith(".") ? ext.slice(1).toLowerCase() : ext.toLowerCase()
  ));

  return (path: string) => {
    if (hasIgnoredDirectorySegment(path, basePath)) {
      return true;
    }

    if (isExcludedAssetDirectory(path, basePath, normalizedIncludeExtensions)) {
      return true;
    }

    if (hasIgnoredFileName(path)) {
      return true;
    }

    if (isBinaryAssetPath(path, normalizedIncludeExtensions)) {
      return true;
    }

    return shouldIgnore(path);
  };
}
