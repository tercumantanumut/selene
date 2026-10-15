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

  it("renders the partial command from in-flight argsText while input is streaming", () => {
    // GPT-5.5/Codex sometimes stalls mid-tool-input. Without partial extraction
    // the tool card shows "(unknown command)" and the user can't tell whether
    // the stream is progressing or stuck. The renderer must surface whatever
    // the model has emitted so far — even if the JSON is unterminated.
    flushSync(() => {
      root.render(
        createElement(ClaudeBashToolUI, {
          toolName: "Bash",
          // No `args` (parser hasn't completed yet) and no `result` (running).
          argsText: '{"command":"cd /workspace && rg \\"Fake[A-Za-z',
        }),
      );
    });

    expect(container.textContent).toContain("cd /workspace && rg");
    expect(container.textContent).toContain("Fake[A-Za-z");
    expect(container.textContent).not.toContain("(unknown command)");
  });

  it("keeps no-newline markers and trailing separators from shifting diff line numbers", () => {
    flushSync(() => {
      root.render(
        createElement(ClaudeBashToolUI, {
          toolName: "Bash",
          args: { command: "apply_patch" },
          result: {
            status: "success",
            inlineDiff: {
              files: [
                {
                  path: "foo.ts",
                  operation: "modify",
                  diff: [
                    "--- foo.ts",
                    "+++ foo.ts",
                    "@@ -1,1 +1,1 @@",
                    "-old",
                    "\\ No newline at end of file",
                    "+new",
                    "\\ No newline at end of file",
                    "",
                  ].join("\n"),
                },
              ],
              rawPatch: "",
            },
          },
        })
      );
    });

    const contentSpans = Array.from(
      container.querySelectorAll<HTMLSpanElement>("span.flex-1")
    );
    const addedContent = contentSpans.find((span) => span.textContent === "new");
    expect(addedContent).toBeDefined();

    const addedRowSpans = addedContent
      ? Array.from(addedContent.parentElement?.querySelectorAll("span") ?? [])
      : [];
    expect(addedRowSpans[0]?.textContent).toBe("");
    expect(addedRowSpans[1]?.textContent).toBe("1");

    const markerRows = contentSpans.filter(
      (span) => span.textContent === "\\ No newline at end of file"
    );
    expect(markerRows).toHaveLength(2);
    for (const marker of markerRows) {
      const spans = Array.from(marker.parentElement?.querySelectorAll("span") ?? []);
      expect(spans[0]?.textContent).toBe("");
      expect(spans[1]?.textContent).toBe("");
    }

    expect(contentSpans.filter((span) => span.textContent === "")).toHaveLength(0);
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
