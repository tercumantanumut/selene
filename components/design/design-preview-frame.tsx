"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useDesignWorkspaceStore } from "@/lib/design/workspace/store";
import { DESIGN_BREAKPOINTS } from "@/lib/design/workspace/types";
import { computeDesignPreviewFrameLayout } from "@/lib/design/workspace/viewport";
import { rehydrateComponentCode } from "@/components/design/design-workspace-bridge";
import { TOOLS_SCRIPT } from "@/lib/design/workspace/tools-script";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Monitor,
  Tablet,
  Smartphone,
  Crosshair,
  Maximize,
  Sun,
  Moon,
  SunMoon,
  Ruler,
  Pipette,
  MessageSquare,
} from "lucide-react";
import type {
  DesignComment,
  DesignPreviewTheme,
  Measurement,
  PickedColor,
} from "@/lib/design/workspace/types";
import { validateIframeMessage } from "@/lib/design/workspace/iframe-messages";

const BREAKPOINT_ICONS: Record<string, ReactNode> = {
  responsive: <Maximize className="h-4 w-4" />,
  mobile: <Smartphone className="h-4 w-4" />,
  tablet: <Tablet className="h-4 w-4" />,
  desktop: <Monitor className="h-4 w-4" />,
};

const PREVIEW_THEME_OPTIONS: { value: DesignPreviewTheme; icon: ReactNode; label: string }[] = [
  { value: "light", icon: <Sun className="h-4 w-4" />, label: "Light" },
  { value: "dark", icon: <Moon className="h-4 w-4" />, label: "Dark" },
  { value: "system", icon: <SunMoon className="h-4 w-4" />, label: "System" },
];

/**
 * Apply the selected preview theme to compiled HTML.
 *
 * The compiler outputs `<html lang="en" class="dark">` by default. This
 * function patches the `<html>` tag so that:
 * - "light" removes the `dark` class
 * - "dark" ensures the `dark` class is present
 * - "system" removes the static class and injects a tiny script that reacts
 *   to `prefers-color-scheme` at runtime
 */
function applyPreviewTheme(html: string, theme: DesignPreviewTheme): string {
  if (theme === "light") {
    // Remove the dark class from <html>
    return html.replace(/<html([^>]*)\s+class="dark"/, "<html$1");
  }
  if (theme === "dark") {
    // Ensure dark class is present (it already is by default, but handle edge cases)
    if (/<html[^>]*class="dark"/.test(html)) return html;
    return html.replace(/<html([^>]*)>/, '<html$1 class="dark">');
  }
  // "system" — remove static class, inject media-query script
  const withoutDark = html.replace(/<html([^>]*)\s+class="dark"/, "<html$1");
  const systemScript = `<script>(function(){var h=document.documentElement;function u(){h.classList.toggle('dark',window.matchMedia('(prefers-color-scheme:dark)').matches)}u();window.matchMedia('(prefers-color-scheme:dark)').addEventListener('change',u)})()</script>`;
  if (withoutDark.includes("</head>")) {
    return withoutDark.replace("</head>", systemScript + "</head>");
  }
  return withoutDark.replace(/<body/, systemScript + "<body");
}

/** Simple fast hash for cache invalidation (djb2). */
function hashCode(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

/** Check if the preview HTML is a loading placeholder (not compiled content). */
function isPlaceholderHtml(html: string): boolean {
  return !html.trim() || html.includes('data-selene-placeholder="true"');
}

/** Escape text for safe inline HTML rendering. */
function escapeForHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Inject the tools script into preview HTML UNCONDITIONALLY.
 *
 * The bootstrap seeds `window.__seleneActiveTool = null`; the parent then
 * activates a specific tool via the `selene-tool-set-active` postMessage on
 * mount (handled by `handleIframeLoad`) and on every subsequent tool switch.
 *
 * Critically, this function does NOT branch on the current active tool — if
 * it did, the `previewSrcDoc` memo would invalidate on every tool switch and
 * remount the entire iframe, defeating the postMessage bus and clobbering
 * any in-iframe state (scroll position, form inputs, etc.).
 */
function injectInspectorScript(html: string): string {
  const scriptTag = `<script>window.__seleneActiveTool = null;</script><script>${TOOLS_SCRIPT}<\/script>`;
  if (html.includes("</body>")) {
    return html.replace("</body>", `${scriptTag}</body>`);
  }
  if (html.includes("</html>")) {
    return html.replace("</html>", `${scriptTag}</html>`);
  }
  return html + scriptTag;
}

/**
 * When the active component is Tailwind mode and the current previewHtml
 * is just the placeholder, trigger server-side compilation via the API.
 *
 * This handles two cases:
 * 1. Component switching — the store rebuilds the placeholder, and this hook
 *    triggers compilation for the newly active Tailwind component.
 * 2. Fallback — if the tool handler's server-side compilation failed, the
 *    bridge sets the placeholder and this hook retries via the API.
 *
 * The generate/edit flow normally provides compiled HTML directly via the
 * tool result bridge, so this hook is a safety net, not the primary path.
 */
function useCompileTailwindPreview() {
  const components = useDesignWorkspaceStore((s) => s.components);
  const activeComponentId = useDesignWorkspaceStore((s) => s.activeComponentId);
  const setPreviewHtml = useDesignWorkspaceStore((s) => s.setPreviewHtml);

  // Track which component+code hash we last compiled to avoid redundant API calls.
  const lastCompiledRef = useRef<string | null>(null);

  useEffect(() => {
    if (!activeComponentId) return;

    const component = components.find((c) => c.id === activeComponentId);
    if (!component) return;

    // Short-circuit: if the component's code was evicted by the LRU hydration
    // path (`codeStripped: true` or empty `code`), POSTing to the compile API
    // with an empty body just produces `400 Component code is required`.
    // Kick off a rehydration instead — the store update from that fetch will
    // re-trigger this effect with full code and we compile then. During the
    // rehydration gap we paint a lightweight "Restoring preview…" placeholder
    // so the iframe isn't flashing a stale or blank state.
    if (!component.code || component.codeStripped) {
      const requestComponentId = activeComponentId;
      setPreviewHtml(
        `<!DOCTYPE html><html><body style="margin:0;padding:16px;font-family:ui-sans-serif,system-ui,sans-serif;background:#0b1220;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;"><div style="text-align:center;font-size:13px;opacity:0.75;">Restoring preview\u2026</div></body></html>`,
      );
      // Fire-and-forget: errors are surfaced by rehydrateComponentCode via
      // setError. The next effect tick picks up the hydrated code.
      void rehydrateComponentCode(requestComponentId);
      return;
    }

    // Build a content-based cache key using component ID + code hash
    const cacheKey = `${activeComponentId}:${hashCode(component.code)}`;

    // Don't re-request the same content we already compiled
    if (lastCompiledRef.current === cacheKey) return;

    // Capture the component ID at request time for stale-response detection.
    const requestComponentId = activeComponentId;
    const requestCode = component.code;
    const controller = new AbortController();

    fetch("/api/design/compile-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: requestCode, name: component.name }),
      signal: controller.signal,
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as {
          html?: string;
          error?: string;
          details?: Array<{ text?: string }>;
        };

        if (!res.ok) {
          const detailText = Array.isArray(data.details)
            ? data.details.map((detail) => detail.text).filter(Boolean).join("\n")
            : "";
          const message = [data.error || `Compile API returned ${res.status}`, detailText]
            .filter(Boolean)
            .join("\n\n");
          throw new Error(message);
        }

        return data;
      })
      .then((data: { html?: string; error?: string }) => {
        const currentId = useDesignWorkspaceStore.getState().activeComponentId;
        if (currentId !== requestComponentId) return;

        if (data.html) {
          lastCompiledRef.current = cacheKey;
          setPreviewHtml(data.html);
        } else if (data.error) {
          const safeError = escapeForHtml(data.error);
          setPreviewHtml(
            `<!DOCTYPE html><html><body style="margin:0;padding:16px;font-family:ui-monospace,monospace;background:#111827;color:#f9fafb;"><pre style="white-space:pre-wrap;color:#ef4444;">Compilation Error:\n${safeError}</pre></body></html>`
          );
        }
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("[design-preview] compilation failed:", err);
        const currentId = useDesignWorkspaceStore.getState().activeComponentId;
        if (currentId !== requestComponentId) return;
        const msg = err instanceof Error ? err.message : "Unknown error";
        const safeMsg = escapeForHtml(msg);
        setPreviewHtml(
          `<!DOCTYPE html><html><body style="margin:0;padding:16px;font-family:ui-monospace,monospace;background:#111827;color:#f9fafb;"><pre style="white-space:pre-wrap;color:#ef4444;">Compilation Failed:\n${safeMsg}</pre></body></html>`
        );
      });

    return () => {
      controller.abort();
    };
  }, [activeComponentId, components, setPreviewHtml]);
}

/**
 * Measures available space in a container and returns dimensions.
 * Uses ResizeObserver for live updates when the pane resizes.
 */
function useContainerSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize((prev) =>
        prev.width === Math.floor(width) && prev.height === Math.floor(height)
          ? prev
          : { width: Math.floor(width), height: Math.floor(height) }
      );
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Window during which a burst of comment changes is coalesced into one diff. */
const COMMENTS_SYNC_DEBOUNCE_MS = 50;

/** Window during which a burst of measurement changes is coalesced. */
const MEASUREMENTS_SYNC_DEBOUNCE_MS = 50;

/** Compute the diff between the parent's current `comments` and the iframe's
 * last-synced view of that list. */
function diffComments(
  current: DesignComment[],
  previous: Map<string, DesignComment>,
): {
  added: DesignComment[];
  removed: string[];
  updated: DesignComment[];
} {
  const added: DesignComment[] = [];
  const updated: DesignComment[] = [];
  const seen = new Set<string>();
  for (const comment of current) {
    seen.add(comment.id);
    const prev = previous.get(comment.id);
    if (!prev) {
      added.push(comment);
    } else if (
      prev.text !== comment.text ||
      prev.elementSelector !== comment.elementSelector ||
      prev.resolved !== comment.resolved ||
      prev.orphaned !== comment.orphaned
    ) {
      updated.push(comment);
    }
  }
  const removed: string[] = [];
  previous.forEach((_, id) => {
    if (!seen.has(id)) removed.push(id);
  });
  return { added, removed, updated };
}

/**
 * Compute the diff between the parent's current `measurements` and the
 * iframe's last-synced view. Mirrors `diffComments`. A measurement is
 * considered "updated" when either endpoint selector or any distance value
 * changes — we re-anchor in-place rather than removing+adding.
 */
export function diffMeasurements(
  current: Measurement[],
  previous: Map<string, Measurement>,
): {
  added: Measurement[];
  removed: string[];
  updated: Measurement[];
} {
  const added: Measurement[] = [];
  const updated: Measurement[] = [];
  const seen = new Set<string>();
  for (const measurement of current) {
    seen.add(measurement.id);
    const prev = previous.get(measurement.id);
    if (!prev) {
      added.push(measurement);
    } else if (
      prev.from.selector !== measurement.from.selector ||
      prev.to.selector !== measurement.to.selector ||
      prev.distances.dx !== measurement.distances.dx ||
      prev.distances.dy !== measurement.distances.dy ||
      prev.distances.horizontal !== measurement.distances.horizontal ||
      prev.distances.vertical !== measurement.distances.vertical ||
      prev.distances.euclidean !== measurement.distances.euclidean ||
      prev.orphaned !== measurement.orphaned
    ) {
      updated.push(measurement);
    }
  }
  const removed: string[] = [];
  previous.forEach((_, id) => {
    if (!seen.has(id)) removed.push(id);
  });
  return { added, removed, updated };
}

/**
 * Toolbar density tiers — narrower than the chosen threshold collapses
 * controls progressively. Tailwind v3 (this codebase) has no
 * `@container` queries, so we drive the breakpoints with a ResizeObserver
 * over the toolbar's own clientWidth.
 *
 *   roomy (>= 720px)        — every label visible (default)
 *   compact (>= 480, < 720) — tools become icon-only, breakpoint+theme keep labels
 *   tight (< 480)           — breakpoints + theme collapse into dropdowns
 *                              and tools stay icon-only
 */
type ToolbarDensity = "roomy" | "compact" | "tight";

function useToolbarDensity(): {
  density: ToolbarDensity;
  ref: React.RefObject<HTMLDivElement | null>;
} {
  const ref = useRef<HTMLDivElement | null>(null);
  const [density, setDensity] = useState<ToolbarDensity>("roomy");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const w = entry.contentRect.width;
      const next: ToolbarDensity = w < 480 ? "tight" : w < 720 ? "compact" : "roomy";
      setDensity((prev) => (prev === next ? prev : next));
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);

  return { density, ref };
}

export function DesignPreviewFrame() {
  const activeComponentId = useDesignWorkspaceStore((s) => s.activeComponentId);
  const previewHtml = useDesignWorkspaceStore((s) => s.previewHtml);
  const selectedBreakpoint = useDesignWorkspaceStore((s) => s.selectedBreakpoint);
  const setBreakpoint = useDesignWorkspaceStore((s) => s.setBreakpoint);
  const activeTool = useDesignWorkspaceStore((s) => s.activeTool);
  const setActiveTool = useDesignWorkspaceStore((s) => s.setActiveTool);
  const previewTheme = useDesignWorkspaceStore((s) => s.previewTheme);
  const setPreviewTheme = useDesignWorkspaceStore((s) => s.setPreviewTheme);
  const toggleSelectedElement = useDesignWorkspaceStore((s) => s.toggleSelectedElement);
  const setSelectedElements = useDesignWorkspaceStore((s) => s.setSelectedElements);
  const addMeasurement = useDesignWorkspaceStore((s) => s.addMeasurement);
  const addPickedColor = useDesignWorkspaceStore((s) => s.addPickedColor);
  const addComment = useDesignWorkspaceStore((s) => s.addComment);
  const markCommentsOrphaned = useDesignWorkspaceStore((s) => s.markCommentsOrphaned);
  const markMeasurementsOrphaned = useDesignWorkspaceStore((s) => s.markMeasurementsOrphaned);
  const comments = useDesignWorkspaceStore((s) => s.comments);
  const measurements = useDesignWorkspaceStore((s) => s.measurements);

  // Auto-compile Tailwind components when switching or on first load
  useCompileTailwindPreview();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const available = useContainerSize(containerRef);

  const postToIframe = useCallback((message: unknown) => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(message, "*");
  }, []);

  // The iframe's view of the comments list. Keyed by id so diffing is O(n).
  // Reset to empty whenever the iframe rebuilds (handleIframeLoad) and updated
  // after every successful diff post.
  const lastSyncedCommentsRef = useRef<Map<string, DesignComment>>(new Map());
  const commentsSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCommentsRef = useRef<DesignComment[] | null>(null);

  // Same pattern for measurements — see comment-sync block above.
  const lastSyncedMeasurementsRef = useRef<Map<string, Measurement>>(new Map());
  const measurementsSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingMeasurementsRef = useRef<Measurement[] | null>(null);

  const flushCommentsDiff = useCallback(() => {
    commentsSyncTimerRef.current = null;
    const next = pendingCommentsRef.current;
    pendingCommentsRef.current = null;
    if (!next) return;
    const diff = diffComments(next, lastSyncedCommentsRef.current);
    if (diff.added.length === 0 && diff.removed.length === 0 && diff.updated.length === 0) {
      return;
    }
    postToIframe({ type: "selene-tool-comments-sync", diff });
    // After successful post, snapshot the new state.
    const snapshot = new Map<string, DesignComment>();
    for (const c of next) snapshot.set(c.id, c);
    lastSyncedCommentsRef.current = snapshot;
  }, [postToIframe]);

  const scheduleCommentsDiff = useCallback(
    (next: DesignComment[]) => {
      pendingCommentsRef.current = next;
      if (commentsSyncTimerRef.current !== null) {
        clearTimeout(commentsSyncTimerRef.current);
      }
      commentsSyncTimerRef.current = setTimeout(flushCommentsDiff, COMMENTS_SYNC_DEBOUNCE_MS);
    },
    [flushCommentsDiff],
  );

  // Send a full bootstrap of the current comments list (used on iframe rebuild).
  // Drops any pending debounce so we don't immediately overwrite the bootstrap
  // with a partial diff against an empty `lastSyncedCommentsRef`.
  const bootstrapCommentsToIframe = useCallback(
    (list: DesignComment[]) => {
      if (commentsSyncTimerRef.current !== null) {
        clearTimeout(commentsSyncTimerRef.current);
        commentsSyncTimerRef.current = null;
      }
      pendingCommentsRef.current = null;
      lastSyncedCommentsRef.current = new Map();
      postToIframe({ type: "selene-tool-comments-sync", bootstrap: list });
      const snapshot = new Map<string, DesignComment>();
      for (const c of list) snapshot.set(c.id, c);
      lastSyncedCommentsRef.current = snapshot;
    },
    [postToIframe],
  );

  // --- Measurements sync (mirrors comments) ---
  const flushMeasurementsDiff = useCallback(() => {
    measurementsSyncTimerRef.current = null;
    const next = pendingMeasurementsRef.current;
    pendingMeasurementsRef.current = null;
    if (!next) return;
    const diff = diffMeasurements(next, lastSyncedMeasurementsRef.current);
    if (diff.added.length === 0 && diff.removed.length === 0 && diff.updated.length === 0) {
      return;
    }
    postToIframe({ type: "selene-tool-measurements-sync", diff });
    const snapshot = new Map<string, Measurement>();
    for (const m of next) snapshot.set(m.id, m);
    lastSyncedMeasurementsRef.current = snapshot;
  }, [postToIframe]);

  const scheduleMeasurementsDiff = useCallback(
    (next: Measurement[]) => {
      pendingMeasurementsRef.current = next;
      if (measurementsSyncTimerRef.current !== null) {
        clearTimeout(measurementsSyncTimerRef.current);
      }
      measurementsSyncTimerRef.current = setTimeout(
        flushMeasurementsDiff,
        MEASUREMENTS_SYNC_DEBOUNCE_MS,
      );
    },
    [flushMeasurementsDiff],
  );

  const bootstrapMeasurementsToIframe = useCallback(
    (list: Measurement[]) => {
      if (measurementsSyncTimerRef.current !== null) {
        clearTimeout(measurementsSyncTimerRef.current);
        measurementsSyncTimerRef.current = null;
      }
      pendingMeasurementsRef.current = null;
      lastSyncedMeasurementsRef.current = new Map();
      postToIframe({ type: "selene-tool-measurements-sync", bootstrap: list });
      const snapshot = new Map<string, Measurement>();
      for (const m of list) snapshot.set(m.id, m);
      lastSyncedMeasurementsRef.current = snapshot;
    },
    [postToIframe],
  );

  // Listen for tool postMessages from the iframe — validate source AND payload.
  // The state-machine gate inside each branch reads the active tool via
  // `getState()` so we don't have to re-subscribe the listener whenever
  // `activeTool` flips; the listener stays mounted for the lifetime of the
  // component and reacts to whichever tool is active when the event fires.
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const message = validateIframeMessage(e.data);
      if (!message) return;

      if (message.type === "selene-inspector-select") {
        const action = message.action;
        if (action === "add" || action === "remove") {
          toggleSelectedElement(message.element);
        } else {
          setSelectedElements([message.element]);
        }
        return;
      }

      if (message.type === "selene-tool-measure") {
        const active = useDesignWorkspaceStore.getState().activeTool;
        if (active !== "measure") {
          console.warn(
            `[design-preview] rejecting stale selene-tool-measure — activeTool=${String(active)}`,
          );
          return;
        }
        const measurement: Measurement = {
          id: makeId("m"),
          from: message.from,
          to: message.to,
          distances: message.distances,
          createdAt: Date.now(),
        };
        addMeasurement(measurement);
        return;
      }

      if (message.type === "selene-tool-color-pick") {
        const active = useDesignWorkspaceStore.getState().activeTool;
        if (active !== "eyedropper") {
          console.warn(
            `[design-preview] rejecting stale selene-tool-color-pick — activeTool=${String(active)}`,
          );
          return;
        }
        // Selection of which channel's RGB/hex/hsl to record:
        // - foreground (Shift-click) → message.foreground
        // - border / gradient / svg-* / pseudo-* → message.picked, since the
        //   detected paint is the picked colour in those tiers (the iframe
        //   already wrote the same rgba to .picked).
        // - background → message.background (legacy default).
        const sourceData =
          message.source === "foreground"
            ? message.foreground
            : message.source === "background"
              ? message.background
              : message.picked;
        const picked: PickedColor = {
          id: makeId("c"),
          hex: sourceData.hex,
          rgb: sourceData.rgb,
          hsl: sourceData.hsl,
          source: message.source,
          element: message.element,
          createdAt: Date.now(),
        };
        addPickedColor(picked);
        return;
      }

      if (message.type === "selene-tool-comment") {
        const active = useDesignWorkspaceStore.getState().activeTool;
        if (active !== "comment") {
          console.warn(
            `[design-preview] rejecting stale selene-tool-comment — activeTool=${String(active)}`,
          );
          return;
        }
        const comment: DesignComment = {
          id: makeId("cm"),
          elementSelector: message.elementSelector,
          text: message.text,
          createdAt: message.createdAt,
          resolved: false,
        };
        addComment(comment);
        // The `comments` effect below re-syncs to the iframe whenever the
        // list changes — no explicit sync needed here (would double-roundtrip).
        return;
      }

      if (message.type === "selene-tool-comments-resolved") {
        markCommentsOrphaned(message.unresolved, message.resolved);
        return;
      }

      if (message.type === "selene-tool-measurements-resolved") {
        markMeasurementsOrphaned(message.unresolved, message.resolved);
        return;
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [
    addComment,
    addMeasurement,
    addPickedColor,
    markCommentsOrphaned,
    markMeasurementsOrphaned,
    setSelectedElements,
    toggleSelectedElement,
  ]);

  // When activeTool changes, tell the iframe to switch modes without rebuilding.
  // On the transition to `null`, also send an explicit cleanup as a defensive
  // double-tap so any transient overlay (measure anchor, comment composer,
  // hover highlight) is reset. The in-iframe handler treats cleanup as a soft
  // deactivate — it does NOT remove the listeners, so the bus stays live for
  // the next activation without needing an iframe remount.
  useEffect(() => {
    postToIframe({ type: "selene-tool-set-active", tool: activeTool });
    if (activeTool === null) {
      postToIframe({ type: "selene-tools-cleanup" });
    }
  }, [activeTool, postToIframe]);

  // Re-sync comments to the iframe whenever the list changes — but as a
  // diff against the iframe's last-synced view, debounced to coalesce
  // rapid-fire edits within ~50ms.
  useEffect(() => {
    scheduleCommentsDiff(comments);
  }, [comments, scheduleCommentsDiff]);

  // Same loop for measurements.
  useEffect(() => {
    scheduleMeasurementsDiff(measurements);
  }, [measurements, scheduleMeasurementsDiff]);

  // Cancel any pending debounce when the component unmounts.
  useEffect(() => {
    return () => {
      if (commentsSyncTimerRef.current !== null) {
        clearTimeout(commentsSyncTimerRef.current);
        commentsSyncTimerRef.current = null;
      }
      if (measurementsSyncTimerRef.current !== null) {
        clearTimeout(measurementsSyncTimerRef.current);
        measurementsSyncTimerRef.current = null;
      }
    };
  }, []);

  // Workspace-level keyboard shortcuts: V/M/I/C
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // If the iframe currently has focus (e.g. user is typing in the in-iframe
      // comment input), don't hijack keys here.
      if (document.activeElement === iframeRef.current) return;
      // Skip when typing in form fields in the parent document.
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
        if (target.closest && target.closest('[contenteditable="true"]')) return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "v") {
        setActiveTool(null);
      } else if (key === "m") {
        setActiveTool(activeTool === "measure" ? null : "measure");
      } else if (key === "i") {
        setActiveTool(activeTool === "eyedropper" ? null : "eyedropper");
      } else if (key === "c") {
        setActiveTool(activeTool === "comment" ? null : "comment");
      } else {
        return;
      }
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTool, setActiveTool]);

  // Apply selected theme to the preview HTML
  const themedPreviewHtml = applyPreviewTheme(previewHtml, previewTheme);
  const layout = useMemo(
    () =>
      computeDesignPreviewFrameLayout({
        breakpoint: selectedBreakpoint,
        availableWidth: available.width,
        availableHeight: available.height,
      }),
    [selectedBreakpoint, available.width, available.height],
  );
  // The injected script is independent of `activeTool` — tool switches go
  // through the `selene-tool-set-active` postMessage bus, never through a
  // srcDoc rebuild. Keeping `activeTool` out of the deps here is what makes
  // measure → eyedropper → comment toggling preserve iframe identity.
  const previewSrcDoc = useMemo(
    () => injectInspectorScript(themedPreviewHtml),
    [themedPreviewHtml],
  );

  // After the iframe rebuilds (srcDoc change), re-sync state once it has
  // booted the tools script: re-broadcast the active tool and the full
  // comment list so persistent pins reappear on every rebuild. The bootstrap
  // resets `lastSyncedCommentsRef` so subsequent diffs are computed against
  // the freshly-seeded iframe view.
  const handleIframeLoad = useCallback(() => {
    const state = useDesignWorkspaceStore.getState();
    postToIframe({ type: "selene-tool-set-active", tool: state.activeTool });
    bootstrapCommentsToIframe(state.comments);
    // Bootstrap measurements after comments — resolve order is deterministic
    // for the iframe ack pipeline.
    bootstrapMeasurementsToIframe(state.measurements);
  }, [postToIframe, bootstrapCommentsToIframe, bootstrapMeasurementsToIframe]);

  const inspectorEnabled = activeTool === "inspect";
  const { density: toolbarDensity, ref: toolbarRef } = useToolbarDensity();
  const showLabels = toolbarDensity === "roomy";
  const collapseToDropdowns = toolbarDensity === "tight";

  // Resolve the current theme + breakpoint metadata for dropdown trigger labels.
  const activeThemeOption =
    PREVIEW_THEME_OPTIONS.find((o) => o.value === previewTheme) ?? PREVIEW_THEME_OPTIONS[0];
  const activeBreakpointMeta = selectedBreakpoint;
  const activeBreakpointIcon = BREAKPOINT_ICONS[selectedBreakpoint.name];

  if (!activeComponentId) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Select or create a component to preview
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Toolbar — responsive: full labels at >=720px, icon-only tools at
          >=480px, breakpoint + theme collapse to dropdowns below 480px. */}
      <div
        ref={toolbarRef}
        className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2"
        role="toolbar"
        aria-label="Design preview toolbar"
      >
        {/* Breakpoints */}
        {collapseToDropdowns ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5"
                aria-label={`Breakpoint: ${activeBreakpointMeta.name}`}
                title={`Breakpoint: ${activeBreakpointMeta.name}`}
              >
                {activeBreakpointIcon}
                <span className="capitalize">{activeBreakpointMeta.name}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" role="group" aria-label="Preview breakpoints">
              <DropdownMenuLabel>Breakpoint</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {DESIGN_BREAKPOINTS.map((bp) => (
                <DropdownMenuItem
                  key={bp.name}
                  onSelect={() => setBreakpoint(bp)}
                  aria-pressed={selectedBreakpoint.name === bp.name}
                  className="gap-1.5"
                >
                  {BREAKPOINT_ICONS[bp.name]}
                  <span className="capitalize">{bp.name}</span>
                  {bp.width > 0 && (
                    <span className="ml-auto text-xs opacity-60">{bp.width}px</span>
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <div
            className="flex items-center gap-2"
            role="group"
            aria-label="Preview breakpoints"
          >
            {DESIGN_BREAKPOINTS.map((bp) => (
              <Button
                key={bp.name}
                variant={selectedBreakpoint.name === bp.name ? "default" : "ghost"}
                size="sm"
                aria-pressed={selectedBreakpoint.name === bp.name}
                aria-label={bp.width ? `${bp.name} breakpoint (${bp.width}px)` : `${bp.name} mode`}
                title={bp.width ? `${bp.name} (${bp.width}px)` : bp.name}
                onClick={() => setBreakpoint(bp)}
                className="gap-1.5"
              >
                {BREAKPOINT_ICONS[bp.name]}
                {showLabels && <span className="capitalize">{bp.name}</span>}
                {showLabels && bp.width > 0 && (
                  <span className="text-xs opacity-60">{bp.width}px</span>
                )}
              </Button>
            ))}
          </div>
        )}

        <div className="mx-1 h-5 w-px bg-border" />

        {/* Tools — always rendered as buttons (never collapsed into a dropdown);
            labels drop below `roomy`. */}
        <div className="flex items-center gap-2" role="group" aria-label="Design tools">
          <Button
            variant={inspectorEnabled ? "default" : "ghost"}
            size="sm"
            aria-label="Toggle element inspector"
            aria-pressed={inspectorEnabled}
            title="Inspect"
            onClick={() => setActiveTool(activeTool === "inspect" ? null : "inspect")}
            className="gap-1.5"
          >
            <Crosshair className="h-4 w-4" />
            {showLabels && <span>Inspect</span>}
          </Button>
          <Button
            variant={activeTool === "measure" ? "default" : "ghost"}
            size="sm"
            aria-label="Measure (M)"
            aria-pressed={activeTool === "measure"}
            title="Measure (M)"
            onClick={() => setActiveTool(activeTool === "measure" ? null : "measure")}
            className="gap-1.5"
          >
            <Ruler className="h-4 w-4" />
            {showLabels && <span>Measure</span>}
          </Button>
          <Button
            variant={activeTool === "eyedropper" ? "default" : "ghost"}
            size="sm"
            aria-label="Pick color (I)"
            aria-pressed={activeTool === "eyedropper"}
            title="Pick color (I)"
            onClick={() => setActiveTool(activeTool === "eyedropper" ? null : "eyedropper")}
            className="gap-1.5"
          >
            <Pipette className="h-4 w-4" />
            {showLabels && <span>Pick</span>}
          </Button>
          <Button
            variant={activeTool === "comment" ? "default" : "ghost"}
            size="sm"
            aria-label="Comment (C)"
            aria-pressed={activeTool === "comment"}
            title="Comment (C)"
            onClick={() => setActiveTool(activeTool === "comment" ? null : "comment")}
            className="gap-1.5"
          >
            <MessageSquare className="h-4 w-4" />
            {showLabels && <span>Comment</span>}
          </Button>
        </div>

        <div className="mx-1 h-5 w-px bg-border" />

        {/* Theme selector */}
        {collapseToDropdowns ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5"
                aria-label={`Preview theme: ${activeThemeOption.label}`}
                title={`Theme: ${activeThemeOption.label}`}
              >
                {activeThemeOption.icon}
                <span>{activeThemeOption.label}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" role="group" aria-label="Preview theme">
              <DropdownMenuLabel>Preview theme</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {PREVIEW_THEME_OPTIONS.map((option) => (
                <DropdownMenuItem
                  key={option.value}
                  onSelect={() => setPreviewTheme(option.value)}
                  aria-pressed={previewTheme === option.value}
                  className="gap-1.5"
                >
                  {option.icon}
                  <span>{option.label}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <div className="flex items-center gap-2" role="group" aria-label="Preview theme">
            {PREVIEW_THEME_OPTIONS.map((option) => (
              <Button
                key={option.value}
                variant={previewTheme === option.value ? "default" : "ghost"}
                size="sm"
                aria-label={`${option.label} preview theme`}
                aria-pressed={previewTheme === option.value}
                title={`${option.label} theme`}
                onClick={() => setPreviewTheme(option.value)}
                className="gap-1.5"
              >
                {option.icon}
                {showLabels && <span>{option.label}</span>}
              </Button>
            ))}
          </div>
        )}
      </div>

      {/* Preview area — measured container */}
      <div
        ref={containerRef}
        className="flex flex-1 items-start justify-center overflow-auto bg-muted/30 p-6"
      >
        <div
          style={{
            width: layout.scaledWidth,
            height: layout.scaledHeight,
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: layout.viewportWidth,
              height: layout.viewportHeight,
              transform: `scale(${layout.scale})`,
              transformOrigin: "top left",
            }}
          >
            <iframe
              ref={iframeRef}
              srcDoc={previewSrcDoc}
              sandbox="allow-scripts allow-same-origin allow-popups allow-modals"
              className="h-full w-full border-0"
              style={{ background: "transparent" }}
              title="Design preview"
              onLoad={handleIframeLoad}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
