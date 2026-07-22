/** @vitest-environment jsdom */

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values?.count === undefined ? key : `${key}:${values.count}`,
}));

vi.mock("@/components/assistant-ui/tool-expansion-context", () => ({
  useToolExpansion: () => null,
}));

import { ClaudeEditToolUI } from "@/components/assistant-ui/claude-code-tools/claude-edit-tool-ui";

describe("ClaudeEditToolUI", () => {
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

  it("counts and highlights only actual changes in a contextual replacement", () => {
    flushSync(() => {
      root.render(
        createElement(ClaudeEditToolUI, {
          toolName: "Edit",
          args: {
            file_path: "/workspace/example.ts",
            old_string: "line1\nline2\nline3\nline4\nline5\nline6",
            new_string: "line1\nline2\nLINE3\nline4\nline5\nline6",
          },
          result: { status: "success" },
        })
      );
    });

    expect(container.textContent).toContain("+1");
    expect(container.textContent).toContain("-1");
    expect(container.textContent).not.toContain("+6");
    expect(container.textContent).not.toContain("-6");

    const button = container.querySelector("button");
    flushSync(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const diffSpans = Array.from(container.querySelectorAll("pre > span"));
    expect(diffSpans.filter((span) => span.className.includes("text-red-700"))).toHaveLength(1);
    expect(diffSpans.filter((span) => span.className.includes("text-emerald-700"))).toHaveLength(1);

    const contextLine = diffSpans.find((span) => span.textContent === "1 1 |   line1");
    expect(contextLine).toBeDefined();
    expect(contextLine?.className).not.toContain("text-red-700");
    expect(contextLine?.className).not.toContain("text-emerald-700");
  });
});
