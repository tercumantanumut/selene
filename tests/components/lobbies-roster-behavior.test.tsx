/** @vitest-environment jsdom */

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SeatCard } from "@/components/lobbies/roster/seat-card";
import {
  buildScopeFromSelection,
  deriveScopeSelection,
  SeatPermissionScopeSheet,
} from "@/components/lobbies/roster/seat-permission-scope-sheet";
import { preflight } from "@/components/lobbies/roster/transition-to-planning-button";
import {
  applyScopeToMcpTools,
  shouldApplyMcpScopeTightening,
} from "@/lib/lobbies/scope-injection";
import type { CharacterSummary } from "@/lib/lobbies/client/character-hooks";
import type { LobbySeat } from "@/lib/lobbies/types";
import type { Tool } from "ai";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const tools = ["readFile", "writeFile", "bash"];
const agent: CharacterSummary = {
  id: "agent-1",
  name: "writer-agent",
  displayName: "Writer Agent",
  tagline: "Writes scenes",
  status: "active",
  isDefault: false,
  metadata: { enabledTools: tools },
};

function seat(overrides: Partial<LobbySeat> = {}): LobbySeat {
  return {
    id: "seat-1",
    lobbyId: "lobby-1",
    role: "Writer",
    agentId: "agent-1",
    permissionScope: { version: 1, mode: "tool_list", allowedTools: [] },
    position: 0,
    status: "ready",
    lockVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("roster permission scope helpers", () => {
  it("treats an empty persisted allowlist as inherit-all for UI selection", () => {
    const selected = deriveScopeSelection(
      { version: 1, mode: "tool_list", allowedTools: [] },
      tools,
    );

    expect([...selected]).toEqual(tools);
  });

  it("round-trips a denied-all scope as no tools selected", () => {
    const selected = deriveScopeSelection(
      {
        version: 1,
        mode: "tool_list",
        allowedTools: tools,
        deniedTools: tools,
      },
      tools,
    );

    expect([...selected]).toEqual([]);
  });

  it("stores None as an explicit deny-all scope instead of the inherit sentinel", () => {
    expect(buildScopeFromSelection(new Set(), tools)).toEqual({
      version: 1,
      mode: "tool_list",
      allowedTools: tools,
      deniedTools: tools,
    });
  });

  it("stores All as the existing inherit-all sentinel", () => {
    expect(buildScopeFromSelection(new Set(tools), tools)).toEqual({
      version: 1,
      mode: "tool_list",
      allowedTools: [],
    });
  });

  it("drops selections outside the agent tool surface", () => {
    expect(
      buildScopeFromSelection(new Set(["writeFile", "unknownTool"]), tools),
    ).toEqual({
      version: 1,
      mode: "tool_list",
      allowedTools: ["writeFile"],
    });
  });
});

describe("roster MCP permission enforcement", () => {
  const mcpTools = {
    readFile: { inputSchema: {} },
    writeFile: { inputSchema: {} },
  } as Record<string, Tool>;

  it("does not tighten MCP tools for the empty inherit-all sentinel", () => {
    const scope = { version: 1, mode: "tool_list", allowedTools: [] } as const;

    expect(shouldApplyMcpScopeTightening(scope)).toBe(false);
  });

  it("denies all MCP tools for an explicit None scope", () => {
    const scope = {
      version: 1,
      mode: "tool_list",
      allowedTools: ["readFile", "writeFile"],
      deniedTools: ["readFile", "writeFile"],
    } as const;

    expect(shouldApplyMcpScopeTightening(scope)).toBe(true);
    expect(applyScopeToMcpTools(mcpTools, scope)).toEqual({
      kept: {},
      denied: ["readFile", "writeFile"],
    });
  });
});

describe("SeatPermissionScopeSheet reseeding", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const onSave = vi.fn();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onSave.mockReset();
  });

  afterEach(() => {
    flushSync(() => {
      root.unmount();
    });
    container.remove();
  });

  function renderSheet(props: {
    initialScope: LobbySeat["permissionScope"];
    scopeVersion: number;
  }) {
    flushSync(() => {
      root.render(
        createElement(SeatPermissionScopeSheet, {
          open: true,
          onOpenChange: vi.fn(),
          seatRole: "Writer",
          agent,
          initialScope: props.initialScope,
          scopeVersion: props.scopeVersion,
          onSave,
        }),
      );
    });
  }

  function allowedCountText(): string | null {
    return (
      Array.from(document.body.querySelectorAll("span")).find((node) =>
        node.textContent?.includes(" of 3 allowed"),
      )?.textContent ?? null
    );
  }

  function renderSameVersionTightenedScope() {
    flushSync(() => {
      root.render(
        createElement(SeatPermissionScopeSheet, {
          open: true,
          onOpenChange: vi.fn(),
          seatRole: "Writer",
          agent,
          initialScope: {
            version: 1,
            mode: "tool_list",
            allowedTools: ["writeFile", "bash"],
          },
          scopeVersion: 1,
          onSave,
        }),
      );
    });
  }

  it("keeps local edits across same-version refetches", () => {
    renderSheet({
      initialScope: { version: 1, mode: "tool_list", allowedTools: [] },
      scopeVersion: 1,
    });

    renderSameVersionTightenedScope();
    expect(allowedCountText()).toBe("3 of 3 allowed");

    renderSheet({
      initialScope: { version: 1, mode: "tool_list", allowedTools: [] },
      scopeVersion: 1,
    });

    expect(allowedCountText()).toBe("3 of 3 allowed");
  });

  it("reseeds while open when the backing server version changes", () => {
    renderSheet({
      initialScope: { version: 1, mode: "tool_list", allowedTools: [] },
      scopeVersion: 1,
    });

    renderSameVersionTightenedScope();
    expect(allowedCountText()).toBe("3 of 3 allowed");

    renderSheet({
      initialScope: {
        version: 1,
        mode: "tool_list",
        allowedTools: ["writeFile"],
      },
      scopeVersion: 2,
    });

    expect(allowedCountText()).toBe("1 of 3 allowed");
  });
});

describe("roster planning preflight", () => {
  it("allows a filled ready seat", () => {
    expect(preflight([seat({ status: "ready" })])).toBeNull();
  });

  it("rejects a filled idle seat to match the server ready_roster contract", () => {
    expect(preflight([seat({ status: "idle" })])).toEqual({
      reason: "At least one filled seat must be in 'ready' status.",
    });
  });
});

describe("SeatCard role edit buffer", () => {
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

  function renderSeat(nextSeat: LobbySeat) {
    flushSync(() => {
      root.render(
        createElement(SeatCard, {
          seat: nextSeat,
          agent,
          isEditable: true,
          onRoleChange: vi.fn(),
          onPickAgent: vi.fn(),
          onEditScope: vi.fn(),
          onRemove: vi.fn(),
        }),
      );
    });
  }

  it("resyncs the role buffer when the seat version changes during editing", () => {
    renderSeat(seat({ role: "Writer", lockVersion: 1 }));

    const editButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Edit role for seat Writer"]',
    );
    expect(editButton).not.toBeNull();

    flushSync(() => {
      editButton?.click();
    });

    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Seat role"]',
    );
    expect(input).not.toBeNull();
    flushSync(() => {
      input!.value = "Draft in progress";
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    renderSeat(seat({ role: "Reviewer", lockVersion: 2 }));

    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Seat role"]')
        ?.value,
    ).toBe("Reviewer");
  });
});
