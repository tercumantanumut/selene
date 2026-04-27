"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useDesignWorkspaceStore } from "@/lib/design/workspace/store";
import { DESIGN_BREAKPOINTS } from "@/lib/design/workspace/types";
import { computeDesignPreviewFrameLayout } from "@/lib/design/workspace/viewport";
import { rehydrateComponentCode } from "@/components/design/design-workspace-bridge";
import { TOOLS_SCRIPT } from "@/lib/design/workspace/tools-script";
import { Button } from "@/components/ui/button";
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
  InspectedElement,
  Measurement,
  PickedColor,
} from "@/lib/design/workspace/types";

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

type IframeMessage =
  | {
      type: "selene-inspector-select";
      element: InspectedElement;
      action?: "add" | "remove" | "replace";
      multiSelect?: boolean;
    }
  | {
      type: "selene-tool-measure";
      from: Measurement["from"];
      to: Measurement["to"];
      distances: Measurement["distances"];
    }
  | {
      type: "selene-tool-color-pick";
      source: PickedColor["source"];
      background: { hex: string; rgb: PickedColor["rgb"]; hsl: PickedColor["hsl"] };
      foreground: { hex: string; rgb: PickedColor["rgb"]; hsl: PickedColor["hsl"] };
      picked: { hex: string; rgb: PickedColor["rgb"]; hsl: PickedColor["hsl"] };
      element: { selector: string; tagName: string };
    }
  | {
      type: "selene-tool-comment";
      tempId: string;
      elementSelector: string;
      text: string;
      createdAt: number;
    };

function isIframeMessage(value: unknown): value is IframeMessage {
  if (!value || typeof value !== "object") return false;
  const data = value as { type?: unknown };
  return (
    data.type === "selene-inspector-select" ||
    data.type === "selene-tool-measure" ||
    data.type === "selene-tool-color-pick" ||
    data.type === "selene-tool-comment"
  );
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
  const comments = useDesignWorkspaceStore((s) => s.comments);

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

  const syncCommentsToIframe = useCallback(
    (list: DesignComment[]) => {
      postToIframe({ type: "selene-tool-comments-sync", comments: list });
    },
    [postToIframe],
  );

  // Listen for tool postMessages from the iframe — validate source
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      // Only accept messages from our own iframe, not arbitrary windows
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (!isIframeMessage(e.data)) return;
      const data = e.data;

      if (data.type === "selene-inspector-select") {
        try {
          const element = data.element;
          if (!element || typeof element !== "object") return;
          const action = data.action;
          if (action === "add" || action === "remove") {
            toggleSelectedElement(element);
          } else {
            setSelectedElements([element]);
          }
        } catch (err) {
          console.warn("[design-preview] malformed inspector-select message", err);
        }
        return;
      }

      if (data.type === "selene-tool-measure") {
        try {
          if (!data.from || !data.to || !data.distances) return;
          const measurement: Measurement = {
            id: makeId("m"),
            from: data.from,
            to: data.to,
            distances: data.distances,
            createdAt: Date.now(),
          };
          addMeasurement(measurement);
        } catch (err) {
          console.warn("[design-preview] malformed measure message", err);
        }
        return;
      }

      if (data.type === "selene-tool-color-pick") {
        try {
          const sourceData = data.source === "foreground" ? data.foreground : data.background;
          if (!sourceData || !sourceData.rgb || !sourceData.hsl || !data.element) return;
          const picked: PickedColor = {
            id: makeId("c"),
            hex: sourceData.hex,
            rgb: sourceData.rgb,
            hsl: sourceData.hsl,
            source: data.source,
            element: data.element,
            createdAt: Date.now(),
          };
          addPickedColor(picked);
        } catch (err) {
          console.warn("[design-preview] malformed color-pick message", err);
        }
        return;
      }

      if (data.type === "selene-tool-comment") {
        try {
          if (typeof data.elementSelector !== "string" || typeof data.text !== "string") return;
          const comment: DesignComment = {
            id: makeId("cm"),
            elementSelector: data.elementSelector,
            text: data.text,
            createdAt: data.createdAt,
            resolved: false,
          };
          addComment(comment);
          // The `comments` effect below re-syncs to the iframe whenever the
          // list changes — no explicit sync needed here (would double-roundtrip).
        } catch (err) {
          console.warn("[design-preview] malformed comment message", err);
        }
        return;
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [
    addComment,
    addMeasurement,
    addPickedColor,
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

  // Re-sync comments to the iframe whenever the list changes (covers new
  // pins, resolves, deletes, and the post-rebuild handshake on iframe load).
  useEffect(() => {
    syncCommentsToIframe(comments);
  }, [comments, syncCommentsToIframe]);

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
  // comment list so persistent pins reappear on every rebuild.
  const handleIframeLoad = useCallback(() => {
    const state = useDesignWorkspaceStore.getState();
    postToIframe({ type: "selene-tool-set-active", tool: state.activeTool });
    syncCommentsToIframe(state.comments);
  }, [postToIframe, syncCommentsToIframe]);

  const inspectorEnabled = activeTool === "inspect";

  if (!activeComponentId) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Select or create a component to preview
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Breakpoint toolbar */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2" role="tablist" aria-label="Preview breakpoints">
        {DESIGN_BREAKPOINTS.map((bp) => (
          <Button
            key={bp.name}
            variant={selectedBreakpoint.name === bp.name ? "default" : "ghost"}
            size="sm"
            role="tab"
            aria-selected={selectedBreakpoint.name === bp.name}
            aria-label={bp.width ? `${bp.name} breakpoint (${bp.width}px)` : `${bp.name} mode`}
            onClick={() => setBreakpoint(bp)}
            className="gap-1.5"
          >
            {BREAKPOINT_ICONS[bp.name]}
            <span className="capitalize">{bp.name}</span>
            {bp.width > 0 && <span className="text-xs opacity-60">{bp.width}px</span>}
          </Button>
        ))}
        <div className="mx-1 h-5 w-px bg-border" />
        <Button
          variant={inspectorEnabled ? "default" : "ghost"}
          size="sm"
          aria-label="Toggle element inspector"
          aria-pressed={inspectorEnabled}
          onClick={() => setActiveTool(activeTool === "inspect" ? null : "inspect")}
          className="gap-1.5"
        >
          <Crosshair className="h-4 w-4" />
          <span>Inspect</span>
        </Button>
        <div className="mx-1 h-5 w-px bg-border" />
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
          <span>Measure</span>
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
          <span>Pick</span>
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
          <span>Comment</span>
        </Button>
        <div className="mx-1 h-5 w-px bg-border" />
        {PREVIEW_THEME_OPTIONS.map((option) => (
          <Button
            key={option.value}
            variant={previewTheme === option.value ? "default" : "ghost"}
            size="sm"
            aria-label={`${option.label} preview theme`}
            aria-pressed={previewTheme === option.value}
            onClick={() => setPreviewTheme(option.value)}
            className="gap-1.5"
          >
            {option.icon}
            <span>{option.label}</span>
          </Button>
        ))}
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
