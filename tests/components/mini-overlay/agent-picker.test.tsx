/** @vitest-environment jsdom */

import { createElement, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode, type SVGProps } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string | number>) => {
    if (values && "count" in values) return `${key}:${values.count}`;
    if (values && "time" in values) return `${key}:${values.time}`;
    return key;
  },
}));

vi.mock("lucide-react", () => ({
  ChevronDown: (props: SVGProps<SVGSVGElement>) => createElement("svg", props),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" "),
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: ReactNode; className?: string }) =>
    createElement("div", { className }, children),
}));

vi.mock("@/components/ui/popover", async () => {
  const React = await import("react");

  function Popover({ children }: { children: ReactNode }) {
    return createElement(React.Fragment, null, children);
  }

  function PopoverTrigger({ children }: { children: ReactNode; asChild?: boolean }) {
    return createElement(React.Fragment, null, children);
  }

  const PopoverContent = React.forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
    ({ children, ...props }, ref) => createElement("div", { ...props, ref }, children),
  );

  return {
    Popover,
    PopoverTrigger,
    PopoverContent,
  };
});

import { AgentPicker } from "@/components/mini-overlay/agent-picker";
import type { OverlayAgent } from "@/app/api/overlay/agents/route";

const AGENTS: OverlayAgent[] = [
  {
    id: "agent-1",
    name: "Alpha",
    lastSessionId: "session-1",
    lastSessionUpdatedAt: "2026-03-20T12:00:00.000Z",
  },
  {
    id: "agent-2",
    name: "Beta",
    lastSessionId: "session-2",
    lastSessionUpdatedAt: "2026-03-20T13:00:00.000Z",
  },
];

describe("AgentPicker", () => {
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

  it("keeps overlay picker items in a no-drag region for mouse interaction", () => {
    flushSync(() => {
      root.render(
        createElement(AgentPicker, {
          agents: AGENTS,
          selectedAgent: AGENTS[0],
          onSelectAgent: vi.fn(),
        }),
      );
    });

    const trigger = container.querySelector("button[aria-haspopup='listbox']");
    expect(trigger?.className).toContain("webkit-app-region-no-drag");

    const options = Array.from(container.querySelectorAll("button[role='option']"));
    expect(options).toHaveLength(AGENTS.length);
    for (const option of options) {
      expect(option.className).toContain("webkit-app-region-no-drag");
    }
  });

  it("prevents mouse down blur while still finalizing selection on click", () => {
    const onSelectAgent = vi.fn();

    flushSync(() => {
      root.render(
        createElement(AgentPicker, {
          agents: AGENTS,
          selectedAgent: AGENTS[0],
          onSelectAgent,
        }),
      );
    });

    const targetOption = container.querySelectorAll<HTMLButtonElement>("button[role='option']")[1];
    expect(targetOption).toBeTruthy();

    const mouseDownEvent = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    const clickEvent = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });

    flushSync(() => {
      targetOption.dispatchEvent(mouseDownEvent);
      targetOption.dispatchEvent(clickEvent);
    });

    expect(mouseDownEvent.defaultPrevented).toBe(true);
    expect(onSelectAgent).toHaveBeenCalledWith(AGENTS[1]);
  });
});
