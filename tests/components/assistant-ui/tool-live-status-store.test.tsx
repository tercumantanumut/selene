/** @vitest-environment jsdom */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useLiveToolStatuses } from "@/components/assistant-ui/tool-live-status";

type ActEnvironmentGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
(globalThis as ActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

function emitProgress(sessionId: string, toolCallId: string, command: string) {
  window.dispatchEvent(
    new CustomEvent("background-task-progress", {
      detail: {
        eventType: "task:progress",
        runId: "run-1",
        type: "chat",
        userId: "u",
        sessionId,
        timestamp: new Date().toISOString(),
        progressContent: [
          {
            type: "tool-call",
            toolCallId,
            toolName: "Bash",
            state: "input-available",
            args: { command },
          },
        ],
      },
    })
  );
}

describe("useLiveToolStatuses shared store", () => {
  let container: HTMLDivElement;
  let root: Root;
  const renders: Record<string, number> = {};
  const latest: Record<string, Record<string, unknown>> = {};

  function Probe({ name, ids }: { name: string; ids: string[] }) {
    const statuses = useLiveToolStatuses("session-1", ids);
    renders[name] = (renders[name] ?? 0) + 1;
    latest[name] = statuses;
    return null;
  }

  beforeEach(() => {
    container = document.createElement("div");
    root = createRoot(container);
    for (const key of Object.keys(renders)) delete renders[key];
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("re-renders only subscribers whose tool calls changed", () => {
    const idsA = ["call-a"];
    const idsB = ["call-b"];
    act(() => {
      root.render(
        createElement("div", null,
          createElement(Probe, { name: "a", ids: idsA }),
          createElement(Probe, { name: "b", ids: idsB })
        )
      );
    });
    const baseA = renders.a;
    const baseB = renders.b;

    act(() => emitProgress("session-1", "call-a", "ls"));

    expect(renders.a).toBe(baseA + 1);
    expect(renders.b).toBe(baseB);
    expect(latest.a["call-a"]).toMatchObject({ toolCallId: "call-a", phase: "preparing" });
    expect(latest.b).toEqual({});
  });

  it("ignores events for other sessions and identical repeats", () => {
    const ids = ["call-c"];
    act(() => root.render(createElement(Probe, { name: "c", ids })));

    act(() => emitProgress("session-1", "call-c", "pwd"));
    const afterFirst = renders.c;
    const firstSnapshot = latest.c;

    act(() => emitProgress("session-1", "call-c", "pwd"));
    act(() => emitProgress("other-session", "call-c", "rm"));

    expect(renders.c).toBe(afterFirst);
    expect(latest.c).toBe(firstSnapshot);
  });
});
