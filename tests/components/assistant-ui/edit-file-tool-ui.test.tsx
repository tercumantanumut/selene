/** @vitest-environment jsdom */

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (key === "lines") {
      return `${values?.count} ${values?.count === 1 ? "line" : "lines"}`;
    }
    return key;
  },
}));

vi.mock("@/components/assistant-ui/tool-expansion-context", () => ({
  useToolExpansion: () => null,
}));

import { EditFileToolUI } from "@/components/assistant-ui/edit-file-tool-ui";

describe("EditFileToolUI", () => {
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

  it("shows the same one-line change count in the header and expanded diff", () => {
    flushSync(() => {
      root.render(
        createElement(EditFileToolUI, {
          toolName: "editFile",
          args: {
            filePath: "/workspace/example.txt",
            oldString: "line1\nline2\nline3\nline4\nline5\nline6",
            newString: "line1\nline2\nLINE3\nline4\nline5\nline6",
          },
          result: {
            status: "success",
            filePath: "/workspace/example.txt",
            message: "Edited example.txt (1 line changed)",
            linesChanged: 1,
            diff: "--- example.txt\n+++ example.txt\n@@ -3,1 +3,1 @@\n3 | - line3\n3 | + LINE3",
          },
        })
      );
    });

    expect(container.textContent).toContain("1 line");

    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    flushSync(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Edited example.txt (1 line changed)");
    expect(container.textContent).toContain("@@ -3,1 +3,1 @@");
    expect(container.textContent).toContain("3 | - line3");
    expect(container.textContent).toContain("3 | + LINE3");
    expect(container.textContent).not.toContain("line1");
    expect(container.textContent).not.toContain("line6");
  });

  it("labels editFile calls with an edits array as edited, not created", () => {
    flushSync(() => {
      root.render(
        createElement(EditFileToolUI, {
          toolName: "editFile",
          args: {
            filePath: "/workspace/StepHeading.tsx",
            oldString: "",
            edits: [
              {
                oldString: "body: string;",
                newString: "body?: string;",
              },
            ],
          },
          result: {
            status: "success",
            filePath: "/workspace/StepHeading.tsx",
            message: "Edited StepHeading.tsx (1 line changed)",
            linesChanged: 1,
            diff: "--- StepHeading.tsx\n+++ StepHeading.tsx\n@@ -22,1 +22,1 @@\n22 | -   body: string;\n22 | +   body?: string;",
          },
        })
      );
    });

    expect(container.textContent).toContain("edited");
    expect(container.textContent).not.toContain("created");
  });
});
