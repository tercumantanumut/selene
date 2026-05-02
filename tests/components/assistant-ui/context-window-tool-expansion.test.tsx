/** @vitest-environment jsdom */

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => ((key: string, values?: Record<string, string | number>) => {
    if (key === "indicator.tooltip") return `${values?.current}/${values?.max} (${values?.percentage})`;
    if (key === "indicator.thresholdsLabel") return `${values?.warn}/${values?.crit}/${values?.hard}`;
    if (key === "indicator.thresholdsTooltip") return String(values?.thresholds ?? "");
    if (key.startsWith("status.")) return String(values?.percentage ?? "");
    return key;
  }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    createElement("button", props, children),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => createElement("div", null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => createElement("div", null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) => createElement("div", null, children),
}));

import { ContextWindowIndicator } from "@/components/assistant-ui/context-window-indicator";
import { ExpandAllToolsButton } from "@/components/assistant-ui/expand-all-tools-button";
import { ToolExpansionProvider } from "@/components/assistant-ui/tool-expansion-context";
import type { ContextStatusInfo } from "@/lib/hooks/use-context-status";

const highUsageStatus: ContextStatusInfo = {
  percentage: 74.2,
  status: "warning",
  currentTokens: 204_792,
  maxInputTokens: 276_000,
  maxTokens: 276_000,
  formatted: {
    current: "204.8K",
    max: "276K",
    percentage: "74.2%",
  },
  thresholds: {
    warning: 207_000,
    critical: 248_400,
    hardLimit: 262_200,
  },
  shouldCompact: true,
  mustCompact: false,
  recommendedAction: "",
  model: {
    id: "test-model",
    provider: "test-provider",
  },
};

function Harness() {
  return createElement(
    ToolExpansionProvider,
    null,
    createElement(ExpandAllToolsButton),
    createElement(ContextWindowIndicator, {
      status: highUsageStatus,
      isLoading: false,
      compact: true,
    }),
  );
}

describe("context window indicator with tool expansion", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root.render(createElement(Harness));
    });
  });

  afterEach(() => {
    flushSync(() => {
      root.unmount();
    });
    container.remove();
  });

  it("keeps the reported context percentage unchanged when all tools are expanded and collapsed", () => {
    const button = container.querySelector("button");
    expect(button).toBeTruthy();
    expect(container.textContent).toContain("74.2%");
    expect(container.textContent).not.toContain("8.0%");

    flushSync(() => {
      button?.click();
    });

    expect(container.textContent).toContain("74.2%");
    expect(container.textContent).not.toContain("8.0%");

    flushSync(() => {
      button?.click();
    });

    expect(container.textContent).toContain("74.2%");
    expect(container.textContent).not.toContain("8.0%");
  });
});
