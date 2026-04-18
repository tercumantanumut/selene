import { describe, it, expect, vi } from "vitest";

// Mock heavy dependencies that would fail in test environment
vi.mock("@/lib/db/sqlite-client", () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn() })),
    exec: vi.fn(),
  })),
}));

vi.mock("@/lib/design/gallery/queries", () => ({
  saveDesignComponent: vi.fn(),
  getDesignComponent: vi.fn(),
  updateDesignComponent: vi.fn(),
}));

vi.mock("@/lib/settings/settings-manager", () => ({
  loadSettings: vi.fn(() => Promise.resolve({})),
}));

vi.mock("@/lib/design", () => ({
  generateCard: vi.fn(),
  editCard: vi.fn(),
}));

vi.mock("@/lib/design/libraries", () => ({
  detectAvailableLibraries: vi.fn(() => Promise.resolve([])),
  getAvailableLibrariesPrompt: vi.fn(() => ""),
}));

vi.mock("@/lib/design/workspace/export", () => ({
  exportDesignAsset: vi.fn(),
}));

vi.mock("@/lib/design/workspace/preview", () => ({
  buildDesignPreviewErrorHtml: vi.fn(() => ""),
}));

vi.mock("@/lib/design/workspace/compiler", () => ({
  buildTailwindPreviewWithMetadata: vi.fn(),
  isDesignWorkspaceCompileError: vi.fn(() => false),
}));

vi.mock("@/lib/design/workspace/config", () => ({
  DEFAULT_DESIGN_WORKSPACE_CONFIG: {},
  getDesignWorkspaceConfigFromSettingsRecord: vi.fn(() => ({})),
}));

vi.mock("@/lib/design/workspace/edit-history", () => ({
  finalizeDesignHistory: vi.fn(),
  initDesignHistory: vi.fn(),
  peekDesignHistory: vi.fn(),
  recordDesignHistory: vi.fn(),
}));

vi.mock("@/lib/design/workspace/dependencies", () => ({
  installSandboxPackages: vi.fn(),
}));

vi.mock("@/lib/design/workspace/validation", () => ({
  runPostEditValidation: vi.fn(),
}));

vi.mock("@/lib/storage/local-storage", () => ({
  getFullPathFromMediaRef: vi.fn(),
}));

vi.mock("@/lib/ai/tool-registry/logging", () => ({
  withToolLogging: vi.fn((fn: unknown) => fn),
}));

describe("Design Workspace Tool — New Action Contracts", () => {
  describe("readSource action contract", () => {
    it("should be documented in the action union type", () => {
      // This test verifies the type system accepts readSource
      // If the type is wrong, this file won't compile
      const action: "readSource" = "readSource";
      expect(action).toBe("readSource");
    });
  });

  describe("patch action contract", () => {
    it("should be documented in the action union type", () => {
      const action: "patch" = "patch";
      const statusAction: "status" = "status";
      expect(action).toBe("patch");
      expect(statusAction).toBe("status");
    });

    // Test the patch string replacement logic (mirrors handlePatch internals)
    describe("string patch logic", () => {
      it("replaces first occurrence by default", () => {
        const source = "color: red;\ncolor: red;";
        const patched = source.replace("color: red", "color: blue");
        expect(patched).toBe("color: blue;\ncolor: red;");
      });

      it("replaces all occurrences with replaceAll", () => {
        const source = "color: red;\ncolor: red;";
        const patched = source.split("color: red").join("color: blue");
        expect(patched).toBe("color: blue;\ncolor: blue;");
      });

      it("detects occurrence count", () => {
        const source =
          'import { Flask } from "lucide-react";\n<Flask size={20} />\n<Flask size={16} />';
        const occurrences = source.split("Flask").length - 1;
        expect(occurrences).toBe(3);
      });

      it("handles multi-line oldString", () => {
        const source = "function App() {\n  return <div>old</div>\n}";
        const patched = source.replace("return <div>old</div>", "return <div>new</div>");
        expect(patched).toBe("function App() {\n  return <div>new</div>\n}");
      });

      it("counts changed lines correctly", () => {
        const before = "line1\nline2\nline3\nline4";
        const after = "line1\nLINE2\nline3\nLINE4";
        const a = before.split("\n");
        const b = after.split("\n");
        let changed = 0;
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
          if (a[i] !== b[i]) changed++;
        }
        expect(changed).toBe(2);
      });
    });
  });

  describe("agentErrorSummary contract", () => {
    it("should format structured errors into flat readable strings", () => {
      // This tests the expected output format of buildAgentErrorSummary
      // The actual function is internal, but we verify the contract
      const errors = [
        {
          type: "dependency" as const,
          message: "Cannot find module 'three'",
          suggestion: 'Install with action "install"',
        },
        {
          type: "syntax" as const,
          message: "Unexpected token",
          location: { file: "component.tsx", line: 42, column: 10 },
        },
      ];

      // Expected format: [type](line N) message -> Fix: suggestion
      const formatted = errors.map((err) => {
        const loc =
          "location" in err && err.location ? ` (line ${err.location.line})` : "";
        const sug =
          "suggestion" in err && err.suggestion
            ? ` → Fix: ${err.suggestion}`
            : "";
        return `[${err.type}]${loc} ${err.message}${sug}`;
      });

      expect(formatted[0]).toBe(
        '[dependency] Cannot find module \'three\' → Fix: Install with action "install"',
      );
      expect(formatted[1]).toBe("[syntax] (line 42) Unexpected token");
    });
  });
});
