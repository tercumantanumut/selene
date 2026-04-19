/** @vitest-environment jsdom */

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// jsdom doesn't implement matchMedia. `use-reduced-motion` (transitively
// imported via CommandOutput's animation chain) calls it in an effect, and
// an uncaught effect error aborts React's commit phase, leaving container
// empty. Shim it before any render.
if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    switch (key) {
      case "exitCode":
        return "Exit code";
      case "output":
        return "Output";
      case "standardError":
        return "Standard Error";
      case "stdErrWarning":
        return " (warning)";
      case "expandOutput":
        return "Expand output";
      case "collapseOutput":
        return "Collapse output";
      case "truncated":
        return `Truncated (${values?.logId ?? ""})`;
      case "error":
        return "Error";
      case "success":
        return "Success";
      case "running":
        return "Running";
      case "copyRetrieval":
        return "Copy retrieval";
      case "clickToExpand":
        return "Click to expand";
      default:
        return key;
    }
  },
}));

vi.mock("@/components/assistant-ui/tool-expansion-context", () => ({
  useToolExpansion: () => null,
}));

import { ClaudeBashToolUI } from "@/components/assistant-ui/claude-code-tools";

describe("ClaudeBashToolUI", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders structured bash errors with stderr details", () => {
    flushSync(() => {
      root.render(
        createElement(ClaudeBashToolUI, {
          toolName: "Bash",
          args: { command: "python -V" },
          result: {
            status: "error",
            error: "Command execution failed",
            stderr: "python: command not found",
            exitCode: 127,
            executionTime: 12,
          },
        }),
      );
    });

    expect(container.textContent).toContain("Command execution failed");
    expect(container.textContent).toContain("python: command not found");
    expect(container.textContent).toContain("Exit code 127");
  });

  it("renders background status calls with a derived process label", () => {
    // Pad stdout past the 500-char auto-collapse threshold so the output
    // block stays mounted and the assertion below can see it.
    const stdout = `installing...\n${"log line ".repeat(80)}`;
    flushSync(() => {
      root.render(
        createElement(ClaudeBashToolUI, {
          toolName: "Bash",
          args: { processId: "bg-123", action: "status" },
          result: {
            status: "running",
            stdout,
          },
        }),
      );
    });

    expect(container.textContent).toContain("check process bg-123");
    expect(container.textContent).toContain("installing...");
  });

  it("normalizes apply_patch heredoc labels for inline diff rendering", () => {
    flushSync(() => {
      root.render(
        createElement(ClaudeBashToolUI, {
          toolName: "Bash",
          args: {
            command:
              "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: foo.ts\n+hi\n*** End Patch\nPATCH",
          },
          result: {
            status: "error",
            inlineDiff: "*** Begin Patch\n*** Add File: foo.ts\n+hi\n*** End Patch\n",
            error: "patch failed",
          },
        }),
      );
    });

    expect(container.textContent).toContain("apply_patch");
    expect(container.textContent).toContain("patch failed");
  });
});
