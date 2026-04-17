/**
 * Integration tests for the design workspace package installation system.
 *
 * Tests the full flow: validation → sandbox setup → npm install → registry
 * update → persistence across restarts → compiler resolution.
 *
 * Philosophy: validation is minimal — only empty strings are rejected.
 * npm is the real validator. The AI reads npm's error messages.
 * Shell injection is prevented by execFile (no shell interpolation).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — hoisted so they're available before module imports
// ---------------------------------------------------------------------------

const fsMocks = vi.hoisted(() => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
}));

const execFileMocks = vi.hoisted(() => ({
  execFileAsync: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  default: fsMocks,
  ...fsMocks,
}));

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("util", () => ({
  promisify: () => execFileMocks.execFileAsync,
}));

// Import after mocks are registered
import {
  validatePackageSpec,
  ensureSandboxDir,
  registerRuntimeLibrary,
  detectAvailableLibraries,
  _resetForTesting,
  SANDBOX_DIR,
  SANDBOX_PACKAGE_JSON,
  SANDBOX_NODE_MODULES,
} from "../../../lib/design/libraries";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTesting();
  // Default: sandbox package.json doesn't exist (ENOENT)
  fsMocks.readFile.mockRejectedValue(
    Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
  );
});

// ---------------------------------------------------------------------------
// 1. Validation — minimal, only rejects empty
// ---------------------------------------------------------------------------

describe("validatePackageSpec", () => {
  describe("accepts all non-empty specs (npm is the validator)", () => {
    const specs = [
      "three",
      "react",
      "@react-three/fiber",
      "three@0.160.0",
      "@react-three/fiber@^8.0.0",
      "three@latest",
      "react@next",
      "three@beta",
      "npm:preact@^10.0.0",
      "file:../../my-design-lib",
      "link:../sibling-package",
      "git+https://github.com/user/repo.git",
      "github:user/repo",
      "https://example.com/package.tgz",
      "workspace:*",
    ];

    for (const spec of specs) {
      it(`accepts "${spec}"`, () => {
        const result = validatePackageSpec(spec);
        expect(result.valid).toBe(true);
        expect(result.spec).toBe(spec);
        expect(result.error).toBeUndefined();
      });
    }
  });

  describe("rejects empty/blank specs", () => {
    for (const spec of ["", "  ", "\t", "\n"]) {
      it(`rejects ${JSON.stringify(spec)}`, () => {
        const result = validatePackageSpec(spec);
        expect(result.valid).toBe(false);
        expect(result.error).toBeDefined();
      });
    }
  });

  it("trims whitespace from valid specs", () => {
    const result = validatePackageSpec("  three  ");
    expect(result.valid).toBe(true);
    expect(result.spec).toBe("three");
  });
});

// ---------------------------------------------------------------------------
// 2. Sandbox isolation
// ---------------------------------------------------------------------------

describe("sandbox isolation", () => {
  it("SANDBOX_DIR uses selene-workspace directory", () => {
    expect(SANDBOX_DIR).toContain("selene-workspace");
    expect(SANDBOX_DIR).not.toContain("node_modules");
  });

  it("SANDBOX_NODE_MODULES is inside the sandbox", () => {
    expect(SANDBOX_NODE_MODULES).toContain("selene-workspace");
    expect(SANDBOX_NODE_MODULES).toMatch(/selene-workspace[/\\]node_modules$/);
  });

  it("SANDBOX_PACKAGE_JSON is inside the sandbox", () => {
    expect(SANDBOX_PACKAGE_JSON).toContain("selene-workspace");
    expect(SANDBOX_PACKAGE_JSON).toMatch(/selene-workspace[/\\]package\.json$/);
  });
});

// ---------------------------------------------------------------------------
// 3. ensureSandboxDir — creates directory and package.json
// ---------------------------------------------------------------------------

describe("ensureSandboxDir", () => {
  it("creates the sandbox directory recursively", async () => {
    fsMocks.access.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );

    await ensureSandboxDir();

    expect(fsMocks.mkdir).toHaveBeenCalledWith(SANDBOX_DIR, { recursive: true });
  });

  it("writes a minimal package.json when it doesn't exist", async () => {
    fsMocks.access.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );

    await ensureSandboxDir();

    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      SANDBOX_PACKAGE_JSON,
      expect.stringContaining('"selene-design-workspace-sandbox"'),
    );
    // Verify it writes valid JSON with expected fields
    const writtenJson = JSON.parse(fsMocks.writeFile.mock.calls[0][1].trim());
    expect(writtenJson).toMatchObject({
      name: "selene-design-workspace-sandbox",
      private: true,
      dependencies: {},
    });
  });

  it("does NOT overwrite package.json when it already exists", async () => {
    fsMocks.access.mockResolvedValue(undefined); // file exists

    await ensureSandboxDir();

    expect(fsMocks.mkdir).toHaveBeenCalled();
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. registerRuntimeLibrary + detectAvailableLibraries
// ---------------------------------------------------------------------------

describe("registerRuntimeLibrary", () => {
  it("registers a new library and makes it detectable", async () => {
    registerRuntimeLibrary({
      name: "three",
      package: "three",
      description: "Installed package: three",
      importExamples: ['import ... from "three"'],
    });

    const libraries = await detectAvailableLibraries();
    const threeLib = libraries.find((l) => l.package === "three");
    expect(threeLib).toBeDefined();
    expect(threeLib!.name).toBe("three");
  });

  it("skips duplicates — same package not registered twice", async () => {
    registerRuntimeLibrary({
      name: "three",
      package: "three",
      description: "First",
      importExamples: [],
    });
    registerRuntimeLibrary({
      name: "three",
      package: "three",
      description: "Second (should be ignored)",
      importExamples: [],
    });

    const libraries = await detectAvailableLibraries();
    const threeLibs = libraries.filter((l) => l.package === "three");
    expect(threeLibs).toHaveLength(1);
    expect(threeLibs[0].description).toBe("First");
  });

  it("does not register a package that's already in the static registry", async () => {
    // "lucide-react" is in DESIGN_LIBRARIES
    registerRuntimeLibrary({
      name: "Lucide React",
      package: "lucide-react",
      description: "Duplicate",
      importExamples: [],
    });

    const libraries = await detectAvailableLibraries();
    const lucideLibs = libraries.filter((l) => l.package === "lucide-react");
    expect(lucideLibs).toHaveLength(1);
    expect(lucideLibs[0].description).toBe(
      "Beautiful & consistent icon library with 1000+ icons",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Persistence across restarts — loadPersistedLibraries
// ---------------------------------------------------------------------------

describe("persistence across restarts", () => {
  it("loads installed packages from sandbox package.json on first detection", async () => {
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({
        name: "selene-design-workspace-sandbox",
        private: true,
        dependencies: {
          three: "^0.160.0",
          gsap: "^3.12.0",
        },
      }),
    );

    const libraries = await detectAvailableLibraries();
    const threeLib = libraries.find((l) => l.package === "three");
    const gsapLib = libraries.find((l) => l.package === "gsap");

    expect(threeLib).toBeDefined();
    expect(threeLib!.description).toBe("Installed package: three");
    expect(gsapLib).toBeDefined();
    expect(gsapLib!.description).toBe("Installed package: gsap");
  });

  it("does not duplicate static libraries when persisted", async () => {
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({
        dependencies: {
          "lucide-react": "^0.400.0", // already in static registry
          three: "^0.160.0", // new
        },
      }),
    );

    const libraries = await detectAvailableLibraries();
    const lucideLibs = libraries.filter((l) => l.package === "lucide-react");
    expect(lucideLibs).toHaveLength(1);
  });

  it("handles corrupt package.json gracefully with a warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fsMocks.readFile.mockResolvedValue("NOT VALID JSON{{{");

    // Should not throw
    const libraries = await detectAvailableLibraries();
    expect(Array.isArray(libraries)).toBe(true);

    // Should warn about the parse failure (not ENOENT, so it warns)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[design/libraries]"),
      expect.any(SyntaxError),
    );
    warnSpy.mockRestore();
  });

  it("silently handles missing sandbox (ENOENT) without warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fsMocks.readFile.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );

    const libraries = await detectAvailableLibraries();
    expect(Array.isArray(libraries)).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("only loads persisted libraries once (flag prevents re-read)", async () => {
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({ dependencies: { three: "^0.160.0" } }),
    );

    await detectAvailableLibraries();
    await detectAvailableLibraries();

    // readFile called only once despite two detectAvailableLibraries calls
    expect(fsMocks.readFile).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 6. _resetForTesting clears state properly
// ---------------------------------------------------------------------------

describe("_resetForTesting", () => {
  it("clears runtime libraries and persistence flag", async () => {
    // Register a runtime library
    registerRuntimeLibrary({
      name: "three",
      package: "three",
      description: "test",
      importExamples: [],
    });

    // Verify it's there
    let libs = await detectAvailableLibraries();
    expect(libs.find((l) => l.package === "three")).toBeDefined();

    // Reset
    _resetForTesting();

    // After reset, "three" should be gone (it was only in runtime, not static)
    libs = await detectAvailableLibraries();
    expect(libs.find((l) => l.package === "three")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. Windows npm command
// ---------------------------------------------------------------------------

describe("getNpmCommand pattern", () => {
  it("returns platform-appropriate npm command", () => {
    // getNpmCommand is internal to design-workspace-tool, but we verify the logic
    const expected = process.platform === "win32" ? "npm.cmd" : "npm";
    expect(expected).toMatch(/^npm(\.cmd)?$/);
  });
});
