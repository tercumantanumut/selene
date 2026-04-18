/**
 * Design Library Registry
 *
 * Maintains a list of UI libraries that the design workspace compiler can
 * resolve from node_modules. Each entry carries metadata (description,
 * import examples) that is surfaced to AI agents so they know which
 * packages are safe to import.
 *
 * At startup, `detectAvailableLibraries()` probes node_modules to mark
 * which packages are actually installed.
 *
 * Runtime-installed packages are stored in an isolated sandbox directory
 * (selene-workspace/) with its own package.json and node_modules, so they
 * never mutate the main app's dependency graph.
 */

import fs from "fs/promises";
import { resolve } from "path";
import { getProjectRoot } from "../utils/project-root";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DesignLibrary {
  /** Human-readable display name. */
  name: string;
  /** npm package specifier (used for `require.resolve`). */
  package: string;
  /** Short description of the library's purpose. */
  description: string;
  /** Example import statements the AI can reference. */
  importExamples: string[];
  /** Whether the package is installed and resolvable at runtime. */
  available: boolean;
}

// ---------------------------------------------------------------------------
// Static registry
// ---------------------------------------------------------------------------

/**
 * Libraries that the design workspace compiler can bundle.
 *
 * Only packages that are real dependencies in `package.json` should appear
 * here. The `available` field is set to `false` by default and resolved at
 * runtime via `detectAvailableLibraries()`.
 */
export const DESIGN_LIBRARIES: DesignLibrary[] = [
  {
    name: "Lucide React",
    package: "lucide-react",
    description: "Beautiful & consistent icon library with 1000+ icons",
    importExamples: [
      'import { Heart, Star, ArrowRight, Search, Settings } from "lucide-react"',
    ],
    available: false,
  },
  {
    name: "Framer Motion",
    package: "framer-motion",
    description: "Production-ready motion library for React",
    importExamples: [
      'import { motion, AnimatePresence } from "framer-motion"',
    ],
    available: false,
  },
  {
    name: "Radix UI Alert Dialog",
    package: "@radix-ui/react-alert-dialog",
    description: "Accessible alert dialog primitive",
    importExamples: [
      'import * as AlertDialog from "@radix-ui/react-alert-dialog"',
    ],
    available: false,
  },
  {
    name: "Radix UI Dialog",
    package: "@radix-ui/react-dialog",
    description: "Accessible dialog (modal) primitive",
    importExamples: [
      'import * as Dialog from "@radix-ui/react-dialog"',
    ],
    available: false,
  },
  {
    name: "Radix UI Dropdown Menu",
    package: "@radix-ui/react-dropdown-menu",
    description: "Accessible dropdown menu primitive",
    importExamples: [
      'import * as DropdownMenu from "@radix-ui/react-dropdown-menu"',
    ],
    available: false,
  },
  {
    name: "Radix UI Popover",
    package: "@radix-ui/react-popover",
    description: "Accessible popover primitive",
    importExamples: [
      'import * as Popover from "@radix-ui/react-popover"',
    ],
    available: false,
  },
  {
    name: "Radix UI Select",
    package: "@radix-ui/react-select",
    description: "Accessible select (combobox) primitive",
    importExamples: [
      'import * as Select from "@radix-ui/react-select"',
    ],
    available: false,
  },
  {
    name: "Radix UI Tabs",
    package: "@radix-ui/react-tabs",
    description: "Accessible tabs primitive",
    importExamples: [
      'import * as Tabs from "@radix-ui/react-tabs"',
    ],
    available: false,
  },
  {
    name: "Radix UI Tooltip",
    package: "@radix-ui/react-tooltip",
    description: "Accessible tooltip primitive",
    importExamples: [
      'import * as Tooltip from "@radix-ui/react-tooltip"',
    ],
    available: false,
  },
  {
    name: "Radix UI Scroll Area",
    package: "@radix-ui/react-scroll-area",
    description: "Custom scrollbar primitive",
    importExamples: [
      'import * as ScrollArea from "@radix-ui/react-scroll-area"',
    ],
    available: false,
  },
  {
    name: "Radix UI Switch",
    package: "@radix-ui/react-switch",
    description: "Accessible toggle switch primitive",
    importExamples: [
      'import * as Switch from "@radix-ui/react-switch"',
    ],
    available: false,
  },
  {
    name: "Radix UI Progress",
    package: "@radix-ui/react-progress",
    description: "Accessible progress bar primitive",
    importExamples: [
      'import * as Progress from "@radix-ui/react-progress"',
    ],
    available: false,
  },
  {
    name: "Radix UI Checkbox",
    package: "@radix-ui/react-checkbox",
    description: "Accessible checkbox primitive",
    importExamples: [
      'import * as Checkbox from "@radix-ui/react-checkbox"',
    ],
    available: false,
  },
  {
    name: "Radix UI Avatar",
    package: "@radix-ui/react-avatar",
    description: "Image avatar with fallback primitive",
    importExamples: [
      'import * as Avatar from "@radix-ui/react-avatar"',
    ],
    available: false,
  },
  {
    name: "Radix UI Label",
    package: "@radix-ui/react-label",
    description: "Accessible label primitive",
    importExamples: [
      'import * as Label from "@radix-ui/react-label"',
    ],
    available: false,
  },
  {
    name: "Class Variance Authority",
    package: "class-variance-authority",
    description: "Utility for creating variant-based class name builders",
    importExamples: [
      'import { cva, type VariantProps } from "class-variance-authority"',
    ],
    available: false,
  },
  {
    name: "clsx",
    package: "clsx",
    description: "Tiny utility for constructing className strings conditionally",
    importExamples: [
      'import { clsx } from "clsx"',
    ],
    available: false,
  },
  {
    name: "Tailwind Merge",
    package: "tailwind-merge",
    description: "Merge Tailwind CSS classes without style conflicts",
    importExamples: [
      'import { twMerge } from "tailwind-merge"',
    ],
    available: false,
  },
  {
    name: "Sonner",
    package: "sonner",
    description: "Opinionated toast notification library for React",
    importExamples: [
      'import { toast, Toaster } from "sonner"',
    ],
    available: false,
  },
  {
    name: "Zod",
    package: "zod",
    description: "TypeScript-first schema validation library",
    importExamples: [
      'import { z } from "zod"',
    ],
    available: false,
  },
];

// ---------------------------------------------------------------------------
// Sandbox directory
// ---------------------------------------------------------------------------

/**
 * Resolve the parent directory for the design workspace sandbox.
 *
 * In packaged Electron builds the project root lives inside the read-only
 * app bundle (`…/Selene.app/Contents/Resources/standalone/`), so creating
 * `selene-workspace/` there fails with ENOENT/EROFS. Electron's main
 * process sets `LOCAL_DATA_PATH` to a user-writable directory
 * (e.g. `~/Library/Application Support/selene/data`) — use that when
 * available. Otherwise (Next dev, tests, headless server runs) fall back
 * to the project root, which is writable in those contexts.
 */
function resolveSandboxRoot(): string {
  const electronDataPath = process.env.LOCAL_DATA_PATH;
  if (electronDataPath && electronDataPath.trim().length > 0) {
    return electronDataPath;
  }
  return getProjectRoot();
}

/** Isolated sandbox directory for design workspace npm installs. */
export const SANDBOX_DIR = resolve(resolveSandboxRoot(), "selene-workspace");
export const SANDBOX_NODE_MODULES = resolve(SANDBOX_DIR, "node_modules");
export const SANDBOX_PACKAGE_JSON = resolve(SANDBOX_DIR, "package.json");

/**
 * Ensure the sandbox directory exists with a minimal package.json.
 * Safe to call multiple times — only creates if missing.
 */
export async function ensureSandboxDir(): Promise<void> {
  await fs.mkdir(SANDBOX_DIR, { recursive: true });
  try {
    await fs.access(SANDBOX_PACKAGE_JSON);
  } catch {
    await fs.writeFile(
      SANDBOX_PACKAGE_JSON,
      JSON.stringify(
        {
          name: "selene-design-workspace-sandbox",
          private: true,
          description: "Isolated npm packages for the Selene design workspace",
          dependencies: {},
        },
        null,
        2,
      ) + "\n",
    );
  }
}

// ---------------------------------------------------------------------------
// Package spec validation
// ---------------------------------------------------------------------------

/**
 * Package spec validation.
 *
 * Philosophy: validation is minimal — only empty strings are rejected.
 * npm is the real validator: the AI reads npm's error messages if a spec
 * resolves to a broken registry entry, a 404 tarball, a missing file:
 * path, or an invalid git ref. Shell injection is impossible because the
 * installer uses `execFile` (no shell interpolation), so freeform specs
 * like `file:`, `link:`, `workspace:*`, `git+https://...`, `github:user/repo`,
 * and remote tarball URLs all pass through to npm unchanged.
 */
export function validatePackageSpec(spec: string): { valid: boolean; spec: string; error?: string } {
  const trimmed = spec.trim();
  if (!trimmed) {
    return { valid: false, spec: "", error: "Empty package specifier" };
  }
  return { valid: true, spec: trimmed };
}

// ---------------------------------------------------------------------------
// Runtime registry (static + dynamically installed)
// ---------------------------------------------------------------------------

/**
 * Libraries installed at runtime via the `install` action.
 * On startup, this is populated from the sandbox's package.json.
 * During the session, new installs are appended here.
 */
const runtimeLibraries: DesignLibrary[] = [];

/** Whether we've loaded persisted libraries from the sandbox. */
let _persistedLoaded = false;

/**
 * Load persisted libraries from the sandbox package.json.
 * Called once during detection to restore installs across restarts.
 */
async function loadPersistedLibraries(): Promise<void> {
  if (_persistedLoaded) return;

  try {
    const raw = await fs.readFile(SANDBOX_PACKAGE_JSON, "utf-8");
    const pkg = JSON.parse(raw);
    const deps = pkg.dependencies ?? {};
    for (const [name] of Object.entries(deps)) {
      const exists =
        DESIGN_LIBRARIES.some((l) => l.package === name) ||
        runtimeLibraries.some((l) => l.package === name);
      if (!exists) {
        runtimeLibraries.push({
          name,
          package: name,
          description: `Installed package: ${name}`,
          importExamples: [`import ... from "${name}"`],
          available: false, // Will be resolved by detectAvailableLibraries
        });
      }
    }
    _persistedLoaded = true;
  } catch (err) {
    // Sandbox doesn't exist yet — nothing to load. Set flag so we don't
    // retry on every call (the sandbox will be created on first install).
    _persistedLoaded = true;
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[design/libraries] Failed to load persisted sandbox libraries:", err);
    }
  }
}

/**
 * Register a library at runtime after it has been npm-installed.
 * Skips duplicates (by package name) that already exist in the static
 * or runtime registry.
 */
export function registerRuntimeLibrary(lib: Omit<DesignLibrary, "available">): void {
  const exists =
    DESIGN_LIBRARIES.some((l) => l.package === lib.package) ||
    runtimeLibraries.some((l) => l.package === lib.package);
  if (!exists) {
    runtimeLibraries.push({ ...lib, available: true });
  }
}

/**
 * Reset internal state — only for use in tests.
 * Clears the runtime registry and persistence flag so each test starts clean.
 */
export function _resetForTesting(): void {
  runtimeLibraries.length = 0;
  _persistedLoaded = false;
}

// ---------------------------------------------------------------------------
// Runtime detection
// ---------------------------------------------------------------------------

/**
 * Probe `node_modules` to determine which design libraries are installed.
 *
 * Returns a copy of `DESIGN_LIBRARIES` (plus any runtime-registered
 * libraries) with `available` set to `true` for each package that can be
 * resolved from the project root or sandbox node_modules.
 */
export async function detectAvailableLibraries(): Promise<DesignLibrary[]> {
  // Load persisted sandbox packages on first call
  await loadPersistedLibraries();

  const projectRoot = getProjectRoot();
  const resolvePaths = [projectRoot, SANDBOX_DIR];

  const all = [...DESIGN_LIBRARIES, ...runtimeLibraries];
  const results = await Promise.all(
    all.map(async (lib) => {
      try {
        require.resolve(lib.package, { paths: resolvePaths });
        return { ...lib, available: true };
      } catch {
        return { ...lib, available: false };
      }
    }),
  );
  return results;
}

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

/**
 * Build a markdown block listing available libraries for injection into AI
 * system prompts.
 *
 * Returns an empty string when no libraries are available so callers can
 * unconditionally concatenate the result.
 */
export function getAvailableLibrariesPrompt(
  libraries: DesignLibrary[],
): string {
  const available = libraries.filter((l) => l.available);
  if (available.length === 0) return "";

  // Group Radix primitives into a single section to keep the prompt concise.
  const radix = available.filter((l) => l.package.startsWith("@radix-ui/"));
  const others = available.filter((l) => !l.package.startsWith("@radix-ui/"));

  const sections: string[] = [];

  for (const lib of others) {
    sections.push(
      [
        `### ${lib.name} (\`${lib.package}\`)`,
        lib.description,
        "```tsx",
        ...lib.importExamples,
        "```",
        "",
      ].join("\n"),
    );
  }

  if (radix.length > 0) {
    const radixLines = radix.flatMap((l) => [
      `- **${l.name}** (\`${l.package}\`) — ${l.description}`,
      ...l.importExamples.map((ex) => `  \`${ex}\``),
    ]);
    sections.push(
      [
        "### Radix UI Primitives",
        "Accessible, unstyled UI primitives. Style them with Tailwind.",
        "",
        ...radixLines,
        "",
      ].join("\n"),
    );
  }

  return [
    "## Available Libraries",
    "You can import from these installed libraries:",
    "",
    ...sections,
  ].join("\n");
}
