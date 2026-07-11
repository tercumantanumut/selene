/** @vitest-environment jsdom */

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    const agent = typeof values?.agent === "string" ? values.agent : "Sub-agent";
    switch (key) {
      case "waiting":
        return `Waiting on ${agent}`;
      case "delegating":
        return `Delegating to ${agent}`;
      case "failed":
        return `${agent} failed`;
      case "stopped":
        return `${agent} stopped`;
      case "done":
        return `${agent} done`;
      case "waitingBadge":
        return "Waiting";
      case "waitingOnDelegation":
        return "Waiting for delegated result";
      case "subagentWorking":
        return "Sub-agent working";
      case "task":
        return "Task";
      case "result":
        return "Result";
      case "error":
        return "Error";
      case "unknownError":
        return "Unknown error";
      case "allResponses":
        return `Responses (${values?.count ?? 0})`;
      default:
        return key;
    }
  },
}));

vi.mock("@/components/assistant-ui/tool-expansion-context", () => ({
  useToolExpansion: () => null,
}));

import { DelegationToolUI } from "@/components/assistant-ui/claude-code-tools/delegation-tool-ui";

describe("DelegationToolUI", () => {
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

  it("shows active pending delegated parts as waiting instead of failed", () => {
    flushSync(() => {
      root.render(
        createElement(DelegationToolUI, {
          toolName: "delegateToSubagent",
          state: "input-available",
          active: true,
          args: { action: "start", agentName: "Reviewer", delegationId: "del-123" },
        })
      );
    });

    expect(container.textContent).toContain("Waiting on Reviewer");
    expect(container.textContent).toContain("Waiting");
    expect(container.textContent).not.toContain("Reviewer failed");
  });

  it("keeps real terminal error results styled as failures", () => {
    flushSync(() => {
      root.render(
        createElement(DelegationToolUI, {
          toolName: "delegateToSubagent",
          args: { action: "observe", agentName: "Reviewer", delegationId: "del-123" },
          result: { status: "error", error: "Delegation not found" },
        })
      );
    });

    expect(container.textContent).toContain("Reviewer failed");
    expect(container.textContent).not.toContain("Waiting for delegated result");
  });

  it("shows explicitly stopped delegations as stopped instead of done", () => {
    flushSync(() => {
      root.render(
        createElement(DelegationToolUI, {
          toolName: "delegateToSubagent",
          args: { action: "stop", agentName: "Reviewer", delegationId: "del-123" },
          result: { status: "stopped", completed: false, running: false, message: "Delegation stopped." },
        })
      );
    });

    expect(container.textContent).toContain("Reviewer stopped");
    expect(container.textContent).not.toContain("Reviewer done");
  });
});
