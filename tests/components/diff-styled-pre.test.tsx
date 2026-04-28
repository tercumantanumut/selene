/** @vitest-environment jsdom */

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DiffStyledPre } from "@/components/assistant-ui/diff-styled-pre";

describe("DiffStyledPre", () => {
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

  it("styles line-numbered editFile additions and deletions", () => {
    flushSync(() => {
      root.render(
        createElement(DiffStyledPre, {
          lines: [
            "--- file.ts",
            "+++ file.ts",
            "@@ -10,1 +10,1 @@",
            "10 | - old value",
            "10 | + new value",
          ],
        }),
      );
    });

    const spans = Array.from(container.querySelectorAll("span"));
    const deletedLine = spans.find((span) => span.textContent === "10 | - old value");
    const addedLine = spans.find((span) => span.textContent === "10 | + new value");

    expect(deletedLine?.className).toContain("text-red-700");
    expect(addedLine?.className).toContain("text-emerald-700");
  });
});
