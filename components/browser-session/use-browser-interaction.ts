"use client";

/**
 * useBrowserInteraction - Manages interactive mode for the browser session viewer.
 *
 * When interactive mode is enabled, user mouse/keyboard events on the screencast
 * image are captured, translated to viewport coordinates, and sent to the
 * interact API endpoint. This lets users directly control the browser the agent is using.
 *
 * Coordinate mapping: the screencast is rendered with object-contain at arbitrary
 * display size. We map against the active browser viewport reported by the
 * screencast metadata so responsive/mobile/tablet viewport changes remain accurate.
 */

import { useCallback, useEffect, useState, type RefObject } from "react";

interface InteractPayload {
  type: "click" | "type" | "keypress" | "scroll" | "navigate";
  x?: number;
  y?: number;
  button?: string;
  clickCount?: number;
  text?: string;
  key?: string;
  modifiers?: number;
  deltaX?: number;
  deltaY?: number;
  url?: string;
}

export interface BrowserViewportSize {
  width: number;
  height: number;
}

interface UseBrowserInteractionOptions {
  sessionId: string;
  imgRef: RefObject<HTMLImageElement | null>;
  /** Active browser viewport in CSS pixels, sourced from screencast metadata. */
  viewportSize?: BrowserViewportSize | null;
  /** Whether interactive mode is currently active */
  enabled: boolean;
  /** Container element ref for attaching non-passive wheel listener */
  containerRef?: RefObject<HTMLElement | null>;
}

interface UseBrowserInteractionReturn {
  /** Attach to the screencast container's onMouseDown */
  handleMouseDown: (e: React.MouseEvent) => void;
  /** Whether a request is in-flight */
  isSending: boolean;
  /** Navigate to a URL */
  navigate: (url: string) => Promise<void>;
}

function getViewportSize(
  img: HTMLImageElement,
  viewportSize?: BrowserViewportSize | null
): BrowserViewportSize | null {
  if (viewportSize?.width && viewportSize.height) return viewportSize;
  if (img.naturalWidth > 0 && img.naturalHeight > 0) {
    return { width: img.naturalWidth, height: img.naturalHeight };
  }
  return null;
}

function getRenderedFrameMetrics(
  img: HTMLImageElement,
  viewportSize?: BrowserViewportSize | null
) {
  const viewport = getViewportSize(img, viewportSize);
  if (!viewport) return null;

  const rect = img.getBoundingClientRect();
  const scale = Math.min(rect.width / viewport.width, rect.height / viewport.height);
  const renderedW = viewport.width * scale;
  const renderedH = viewport.height * scale;
  const offsetX = (rect.width - renderedW) / 2;
  const offsetY = (rect.height - renderedH) / 2;

  return { rect, viewport, renderedW, renderedH, offsetX, offsetY };
}

/**
 * Map a pointer position on the rendered <img> element to browser viewport coordinates.
 *
 * The screencast can be emitted at arbitrary responsive sizes, so we map against
 * active viewport metadata when available and fall back to the image's natural size.
 */
function mapPointToViewport(
  clientX: number,
  clientY: number,
  img: HTMLImageElement,
  viewportSize?: BrowserViewportSize | null
): { x: number; y: number } | null {
  const metrics = getRenderedFrameMetrics(img, viewportSize);
  if (!metrics) return null;

  const { rect, viewport, renderedW, renderedH, offsetX, offsetY } = metrics;
  const mouseX = clientX - rect.left;
  const mouseY = clientY - rect.top;

  if (
    mouseX < offsetX ||
    mouseX > offsetX + renderedW ||
    mouseY < offsetY ||
    mouseY > offsetY + renderedH
  ) {
    return null;
  }

  const viewportX = ((mouseX - offsetX) / renderedW) * viewport.width;
  const viewportY = ((mouseY - offsetY) / renderedH) * viewport.height;

  return { x: Math.round(viewportX), y: Math.round(viewportY) };
}

export function useBrowserInteraction({
  sessionId,
  imgRef,
  viewportSize,
  enabled,
  containerRef,
}: UseBrowserInteractionOptions): UseBrowserInteractionReturn {
  const [isSending, setIsSending] = useState(false);

  const sendInteraction = useCallback(async (payload: InteractPayload) => {
    if (!sessionId) return;

    setIsSending(true);
    try {
      await fetch(`/api/browser/${sessionId}/interact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.error("[BrowserInteraction] Failed to send:", err);
    } finally {
      setIsSending(false);
    }
  }, [sessionId]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!enabled || !imgRef.current) return;

    const pos = mapPointToViewport(e.clientX, e.clientY, imgRef.current, viewportSize);
    if (!pos) return;

    e.preventDefault();

    const button = e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
    void sendInteraction({
      type: "click",
      x: pos.x,
      y: pos.y,
      button,
      clickCount: e.detail || 1,
    });
  }, [enabled, imgRef, sendInteraction, viewportSize]);


  // Non-passive wheel listener attached via useEffect so preventDefault() works.
  useEffect(() => {
    const el = containerRef?.current;
    if (!el || !enabled) return;

    const onWheel = (e: WheelEvent) => {
      const img = imgRef.current;
      if (!img) return;

      const pos = mapPointToViewport(e.clientX, e.clientY, img, viewportSize);
      if (!pos) return;

      e.preventDefault();
      void sendInteraction({
        type: "scroll",
        x: pos.x,
        y: pos.y,
        deltaX: e.deltaX,
        deltaY: e.deltaY,
      });
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [enabled, containerRef, imgRef, sendInteraction, viewportSize]);

  const navigate = useCallback(async (url: string) => {
    if (!url) return;
    const normalizedUrl = url.match(/^https?:\/\//) ? url : `https://${url}`;
    await sendInteraction({ type: "navigate", url: normalizedUrl });
  }, [sendInteraction]);

  return {
    handleMouseDown,
    isSending,
    navigate,
  };
}
