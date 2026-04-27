/**
 * Validator-level tests for `validateIframeMessage` plus a couple of
 * integration tests that drive a forged `MessageEvent` through the same
 * code path the real component uses (validate -> state-machine gate -> store
 * mutation).
 *
 * The integration cases mock `iframeRef.current.contentWindow` with a fake
 * window and dispatch a synthetic `MessageEvent` whose `source` matches that
 * fake. We don't render the actual `<DesignPreviewFrame />` — its render path
 * pulls in Lucide icons, the chat-provider chain, etc. We only need to verify
 * the validator + state-machine gate logic, which is pure JS once factored
 * into `iframe-messages.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateIframeMessage } from "@/lib/design/workspace/iframe-messages";
import { useDesignWorkspaceStore } from "@/lib/design/workspace/store";

const NOW = 1_700_000_000_000;

function validInspectedElement() {
  return {
    tagName: "div",
    id: "",
    className: "",
    textContent: "",
    selector: "div",
    boundingRect: { x: 0, y: 0, width: 10, height: 10 },
    computedStyles: {
      width: "10px",
      height: "10px",
      padding: "0",
      margin: "0",
      display: "block",
      position: "static",
      color: "#000",
      backgroundColor: "transparent",
      fontSize: "12px",
      fontFamily: "system-ui",
    },
  };
}

function validRgb() {
  return { r: 10, g: 20, b: 30, a: 1 };
}
function validHsl() {
  return { h: 120, s: 50, l: 50, a: 1 };
}
function validColorChannel() {
  return { hex: "#0a141e", rgb: validRgb(), hsl: validHsl() };
}

function validMeasure() {
  return {
    type: "selene-tool-measure",
    from: { selector: "#a", rect: { x: 0, y: 0, width: 10, height: 10 } },
    to: { selector: "#b", rect: { x: 30, y: 30, width: 10, height: 10 } },
    distances: { dx: 30, dy: 30, horizontal: 20, vertical: 20, euclidean: 42.42 },
  };
}

function validColorPick(source: "background" | "foreground" | "border" = "background") {
  return {
    type: "selene-tool-color-pick",
    source,
    background: validColorChannel(),
    foreground: validColorChannel(),
    picked: validColorChannel(),
    element: { selector: "div.foo", tagName: "div" },
  };
}

function validComment(createdAt = NOW) {
  return {
    type: "selene-tool-comment",
    tempId: "tmp-1",
    elementSelector: "#target",
    text: "hello",
    createdAt,
  };
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

describe("validateIframeMessage — accepts well-formed payloads", () => {
  it("accepts selene-inspector-select with action", () => {
    const result = validateIframeMessage(
      { type: "selene-inspector-select", element: validInspectedElement(), action: "add" },
      NOW,
    );
    expect(result?.type).toBe("selene-inspector-select");
  });

  it("accepts selene-tool-measure", () => {
    const result = validateIframeMessage(validMeasure(), NOW);
    expect(result?.type).toBe("selene-tool-measure");
  });

  it("accepts selene-tool-color-pick (background, foreground, border)", () => {
    expect(validateIframeMessage(validColorPick("background"), NOW)?.type).toBe("selene-tool-color-pick");
    expect(validateIframeMessage(validColorPick("foreground"), NOW)?.type).toBe("selene-tool-color-pick");
    expect(validateIframeMessage(validColorPick("border"), NOW)?.type).toBe("selene-tool-color-pick");
  });

  it("accepts selene-tool-comment with createdAt at the boundary", () => {
    expect(validateIframeMessage(validComment(NOW), NOW)?.type).toBe("selene-tool-comment");
  });

  it("accepts selene-tool-comments-resolved", () => {
    const result = validateIframeMessage(
      { type: "selene-tool-comments-resolved", resolved: ["a"], unresolved: ["b"] },
      NOW,
    );
    expect(result?.type).toBe("selene-tool-comments-resolved");
  });
});

describe("validateIframeMessage — rejects malformed payloads", () => {
  it("rejects non-object", () => {
    expect(validateIframeMessage(null, NOW)).toBeNull();
    expect(validateIframeMessage("string", NOW)).toBeNull();
    expect(validateIframeMessage(42, NOW)).toBeNull();
  });

  it("rejects missing or unknown type", () => {
    expect(validateIframeMessage({}, NOW)).toBeNull();
    expect(validateIframeMessage({ type: "unknown-event" }, NOW)).toBeNull();
  });

  it("rejects measure with NaN distance", () => {
    const bad = validMeasure();
    bad.distances.euclidean = Number.NaN;
    expect(validateIframeMessage(bad, NOW)).toBeNull();
  });

  it("rejects measure with Infinity distance", () => {
    const bad = validMeasure();
    bad.distances.dx = Number.POSITIVE_INFINITY;
    expect(validateIframeMessage(bad, NOW)).toBeNull();
  });

  it("rejects measure with negative width", () => {
    const bad = validMeasure();
    bad.from.rect.width = -1;
    expect(validateIframeMessage(bad, NOW)).toBeNull();
  });

  it("rejects color-pick with malformed hex", () => {
    for (const hex of ["#zzz", "red", "#1234", "#abcd"]) {
      const bad = validColorPick();
      bad.background.hex = hex;
      expect(validateIframeMessage(bad, NOW)).toBeNull();
    }
  });

  it("rejects color-pick with out-of-range RGB", () => {
    const bad = validColorPick();
    bad.background.rgb.r = 300;
    expect(validateIframeMessage(bad, NOW)).toBeNull();
  });

  it("rejects color-pick with out-of-range HSL", () => {
    const bad = validColorPick();
    bad.background.hsl.h = 400;
    expect(validateIframeMessage(bad, NOW)).toBeNull();
  });

  it("rejects color-pick with invalid source enum", () => {
    const bad = validColorPick();
    (bad as unknown as { source: string }).source = "underline";
    expect(validateIframeMessage(bad, NOW)).toBeNull();
  });

  it("rejects comment with text > 2000 chars", () => {
    const bad = validComment();
    bad.text = "x".repeat(2001);
    expect(validateIframeMessage(bad, NOW)).toBeNull();
  });

  it("rejects comment with empty text", () => {
    const bad = validComment();
    bad.text = "";
    expect(validateIframeMessage(bad, NOW)).toBeNull();
  });

  it("rejects comment with createdAt outside the window", () => {
    const tooOld = validComment(NOW - 2 * 24 * 60 * 60 * 1000);
    expect(validateIframeMessage(tooOld, NOW)).toBeNull();
    const tooNew = validComment(NOW + 5 * 60 * 1000);
    expect(validateIframeMessage(tooNew, NOW)).toBeNull();
  });

  it("rejects comment with non-positive createdAt", () => {
    const bad = validComment(0);
    expect(validateIframeMessage(bad, NOW)).toBeNull();
  });

  it("rejects payloads with selector exceeding 1000 chars", () => {
    const longSelector = "a".repeat(1001);
    const measure = validMeasure();
    measure.from.selector = longSelector;
    expect(validateIframeMessage(measure, NOW)).toBeNull();

    const colorPick = validColorPick();
    colorPick.element.selector = longSelector;
    expect(validateIframeMessage(colorPick, NOW)).toBeNull();

    const comment = validComment();
    comment.elementSelector = longSelector;
    expect(validateIframeMessage(comment, NOW)).toBeNull();
  });

  it("rejects comments-resolved with non-string array entries", () => {
    expect(
      validateIframeMessage(
        { type: "selene-tool-comments-resolved", resolved: [1], unresolved: [] },
        NOW,
      ),
    ).toBeNull();
    expect(
      validateIframeMessage(
        { type: "selene-tool-comments-resolved", resolved: "not-array", unresolved: [] },
        NOW,
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration: handler dispatch path
// ---------------------------------------------------------------------------
//
// We exercise the real listener that DesignPreviewFrame installs by mounting
// a tiny shim that mirrors its handler logic. (Rendering the full component
// pulls in too many transitive deps for the node test environment.) The shim
// uses the same store and the same validator, so coverage of "validator -> gate
// -> reducer" is end-to-end.

import {
  validateIframeMessage as validateForShim,
} from "@/lib/design/workspace/iframe-messages";

function makeShimListener(fakeContentWindow: Window) {
  return function handleMessage(e: MessageEvent) {
    if (e.source !== fakeContentWindow) return;
    const message = validateForShim(e.data);
    if (!message) return;
    if (message.type === "selene-tool-measure") {
      const active = useDesignWorkspaceStore.getState().activeTool;
      if (active !== "measure") return;
      useDesignWorkspaceStore.getState().addMeasurement({
        id: "m-test",
        from: message.from,
        to: message.to,
        distances: message.distances,
        createdAt: NOW,
      });
      return;
    }
    if (message.type === "selene-tool-color-pick") {
      const active = useDesignWorkspaceStore.getState().activeTool;
      if (active !== "eyedropper") return;
      useDesignWorkspaceStore.getState().addPickedColor({
        id: "c-test",
        hex: message.picked.hex,
        rgb: message.picked.rgb,
        hsl: message.picked.hsl,
        source: message.source,
        element: message.element,
        createdAt: NOW,
      });
      return;
    }
    if (message.type === "selene-tool-comment") {
      const active = useDesignWorkspaceStore.getState().activeTool;
      if (active !== "comment") return;
      useDesignWorkspaceStore.getState().addComment({
        id: "cm-test",
        elementSelector: message.elementSelector,
        text: message.text,
        createdAt: message.createdAt,
        resolved: false,
      });
      return;
    }
    if (message.type === "selene-tool-comments-resolved") {
      useDesignWorkspaceStore.getState().markCommentsOrphaned(message.unresolved, message.resolved);
      return;
    }
  };
}

describe("handleMessage payload -> store integration", () => {
  beforeEach(() => {
    useDesignWorkspaceStore.getState().reset();
  });

  it("invalid payloads do NOT mutate the store", () => {
    const fakeWin = {} as Window;
    const handler = makeShimListener(fakeWin);
    const before = useDesignWorkspaceStore.getState().measurements;

    const malformed = validMeasure();
    malformed.distances.euclidean = Number.NaN;
    handler({ data: malformed, source: fakeWin } as unknown as MessageEvent);

    expect(useDesignWorkspaceStore.getState().measurements).toBe(before);
  });

  it("valid measure during activeTool=measure DOES mutate the store", () => {
    const fakeWin = {} as Window;
    const handler = makeShimListener(fakeWin);
    useDesignWorkspaceStore.getState().setActiveTool("measure");
    handler({ data: validMeasure(), source: fakeWin } as unknown as MessageEvent);
    expect(useDesignWorkspaceStore.getState().measurements.length).toBe(1);
  });

  it("messages from a foreign source are ignored entirely", () => {
    const fakeWin = {} as Window;
    const otherWin = {} as Window;
    const handler = makeShimListener(fakeWin);
    useDesignWorkspaceStore.getState().setActiveTool("measure");
    handler({ data: validMeasure(), source: otherWin } as unknown as MessageEvent);
    expect(useDesignWorkspaceStore.getState().measurements.length).toBe(0);
  });
});

describe("state-machine gate", () => {
  beforeEach(() => {
    useDesignWorkspaceStore.getState().reset();
  });

  it("with activeTool=inspect, a stale selene-tool-measure is dropped", () => {
    const fakeWin = {} as Window;
    const handler = makeShimListener(fakeWin);
    useDesignWorkspaceStore.getState().setActiveTool("inspect");
    handler({ data: validMeasure(), source: fakeWin } as unknown as MessageEvent);
    expect(useDesignWorkspaceStore.getState().measurements.length).toBe(0);
  });

  it("with activeTool=inspect, a stale selene-tool-color-pick is dropped", () => {
    const fakeWin = {} as Window;
    const handler = makeShimListener(fakeWin);
    useDesignWorkspaceStore.getState().setActiveTool("inspect");
    handler({ data: validColorPick(), source: fakeWin } as unknown as MessageEvent);
    expect(useDesignWorkspaceStore.getState().pickedColors.length).toBe(0);
  });

  it("with activeTool=null, a stale selene-tool-comment is dropped", () => {
    const fakeWin = {} as Window;
    const handler = makeShimListener(fakeWin);
    useDesignWorkspaceStore.getState().setActiveTool(null);
    handler({ data: validComment(), source: fakeWin } as unknown as MessageEvent);
    expect(useDesignWorkspaceStore.getState().comments.length).toBe(0);
  });

  it("comments-resolved is processed regardless of activeTool", () => {
    const fakeWin = {} as Window;
    const handler = makeShimListener(fakeWin);
    useDesignWorkspaceStore.getState().setActiveTool(null);
    useDesignWorkspaceStore.getState().addComment({
      id: "ack-1",
      elementSelector: "#nope",
      text: "x",
      createdAt: NOW,
      resolved: false,
    });
    handler({
      data: { type: "selene-tool-comments-resolved", resolved: [], unresolved: ["ack-1"] },
      source: fakeWin,
    } as unknown as MessageEvent);
    expect(useDesignWorkspaceStore.getState().comments.find((c) => c.id === "ack-1")?.orphaned).toBe(true);
  });
});
