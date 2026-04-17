/** @vitest-environment jsdom */

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseDelegationStatus } = vi.hoisted(() => ({
  mockUseDelegationStatus: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string | number>) => {
    switch (key) {
      case "activeDelegations":
        return `${values?.count ?? 0} active delegations`;
      case "taskUnavailable":
        return "Task details unavailable";
      case "openInBrowserTabs":
        return "Open in tabs";
      case "openInSidebar":
        return "Open in sidebar";
      case "openDelegationSession":
        return `Open ${values?.agent ?? "agent"} session`;
      case "openDelegationSessionRich":
        return `Open ${values?.agent ?? "agent"}: ${values?.task ?? ""} (${values?.destination ?? ""})`;
      case "triggerAriaLabel":
        return `${values?.count ?? 0} active delegations, show details`;
      default:
        return key;
    }
  },
}));

vi.mock("@/lib/hooks/use-delegation-status", () => ({
  useDelegationStatus: mockUseDelegationStatus,
}));

import { ActiveDelegationsIndicator } from "@/components/assistant-ui/active-delegations-indicator";

function openPopover(trigger: HTMLElement) {
  flushSync(() => {
    trigger.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    trigger.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    trigger.click();
  });
}

describe("ActiveDelegationsIndicator", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    mockUseDelegationStatus.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => {
      root.unmount();
    });
    container.remove();
    // Clean up any portaled popover content left behind by Radix
    document.body.innerHTML = "";
  });

  it("returns null when there are no running delegations", () => {
    mockUseDelegationStatus.mockReturnValue({
      delegations: [
        {
          delegationId: "del-done",
          sessionId: "session-done",
          delegateAgentId: "agent-done",
          delegateAgent: "Reviewer",
          task: "Finished work",
          running: false,
          elapsed: 1200,
        },
      ],
      isLoading: false,
      error: null,
    });

    flushSync(() => {
      root.render(createElement(ActiveDelegationsIndicator, { characterId: "parent-agent" }));
    });

    expect(container.textContent).toBe("");
  });

  it("renders only the compact trigger by default (no static rows)", () => {
    mockUseDelegationStatus.mockReturnValue({
      delegations: [
        {
          delegationId: "del-123",
          sessionId: "session-123",
          delegateAgentId: "agent-123",
          delegateAgent: "Explore",
          task: "Trace session switch flow",
          running: true,
          elapsed: 65000,
        },
      ],
      isLoading: false,
      error: null,
    });

    flushSync(() => {
      root.render(
        createElement(ActiveDelegationsIndicator, {
          characterId: "parent-agent",
          workspaceMode: "sidebar",
          onOpenSession: vi.fn(),
        }),
      );
    });

    // Only the trigger is visible up-front; the task text should not be
    // rendered in the composer strip until the user hovers.
    expect(container.textContent).toContain("1 active delegations");
    expect(container.textContent).not.toContain("Trace session switch flow");

    // Exactly one button (the trigger) is present in the composer strip.
    const triggerButtons = container.querySelectorAll("button");
    expect(triggerButtons.length).toBe(1);
  });

  it("reveals rows on hover and opens delegation sessions in browser tabs mode", () => {
    const onOpenSession = vi.fn();
    mockUseDelegationStatus.mockReturnValue({
      delegations: [
        {
          delegationId: "del-123",
          sessionId: "session-123",
          delegateAgentId: "agent-123",
          delegateAgent: "Explore",
          task: "Trace session switch flow",
          running: true,
          elapsed: 65000,
        },
      ],
      isLoading: false,
      error: null,
    });

    flushSync(() => {
      root.render(
        createElement(ActiveDelegationsIndicator, {
          characterId: "parent-agent",
          workspaceMode: "browser-tabs",
          onOpenSession,
        }),
      );
    });

    const trigger = container.querySelector("button") as HTMLButtonElement;
    expect(trigger).not.toBeNull();
    openPopover(trigger);

    // Radix portals the popover content into document.body.
    const rowButton = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label^="Open Explore:"]',
    );
    expect(rowButton).not.toBeNull();
    expect(document.body.textContent).toContain("Open in tabs");
    expect(document.body.textContent).toContain("Trace session switch flow");

    flushSync(() => {
      rowButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onOpenSession).toHaveBeenCalledWith("session-123", "agent-123");
  });

  it("falls back to task-unavailable copy and uses sidebar label when workspaceMode is sidebar", () => {
    const onOpenSession = vi.fn();
    mockUseDelegationStatus.mockReturnValue({
      delegations: [
        {
          delegationId: "del-456",
          sessionId: "session-456",
          delegateAgentId: "agent-456",
          delegateAgent: "Reviewer",
          task: "   ",
          running: true,
          elapsed: 4000,
        },
      ],
      isLoading: false,
      error: null,
    });

    flushSync(() => {
      root.render(
        createElement(ActiveDelegationsIndicator, {
          characterId: "parent-agent",
          workspaceMode: "sidebar",
          onOpenSession,
        }),
      );
    });

    const trigger = container.querySelector("button") as HTMLButtonElement;
    openPopover(trigger);

    const rowButton = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label^="Open Reviewer:"]',
    );
    expect(rowButton).not.toBeNull();
    expect(document.body.textContent).toContain("Task details unavailable");
    expect(document.body.textContent).toContain("Open in sidebar");

    flushSync(() => {
      rowButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onOpenSession).toHaveBeenCalledWith("session-456", "agent-456");
  });
});
