"use client";

/**
 * useActionIndicators — Manages visual action indicator overlays for the browser session viewer.
 *
 * Receives action SSE events (via addAction), maps viewport coordinates to display
 * coordinates on the screencast image, and maintains a time-limited queue of indicators
 * that auto-remove after their animation completes.
 */

import { useCallback, useRef, useState, useEffect, type RefObject } from "react";
import type { BrowserViewportSize } from "./use-browser-interaction";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ActionIndicator {
  id: string;
  action: string;
  x?: number;
  y?: number;
  source: "agent" | "user";
  timestamp: number;
  input: Record<string, unknown>;
}

export interface ActionSSEData {
  seq: number;
  action: string;
  input: Record<string, unknown>;
  source?: "agent" | "user";
  timestamp?: string;
  success?: boolean;
  durationMs?: number;
}

interface UseActionIndicatorsOptions {
  sessionId: string;
  imgRef: RefObject<HTMLImageElement | null>;
  containerRef: RefObject<HTMLElement | null>;
  viewportSize?: BrowserViewportSize | null;
  enabled: boolean;
}

interface UseActionIndicatorsReturn {
  indicators: ActionIndicator[];
  addAction: (data: ActionSSEData) => void;
  clearIndicators: () => void;
}

// ─── Duration map ─────────────────────────────────────────────────────────────

const ANIMATION_DURATIONS: Record<string, number> = {
  click: 700,
  scroll: 500,
  type: 1000,
  navigate: 700,
};

function getAnimationDuration(action: string): number {
  return ANIMATION_DURATIONS[action] ?? 700;
}

// ─── Coordinate mapping ───────────────────────────────────────────────────────

/**
 * Maps viewport coordinates (from the browser) to display coordinates
 * relative to the rendered screencast image element.
 *
 * This is the inverse of mapToViewport in use-browser-interaction.ts.
 */
function viewportToDisplay(
  viewportX: number,
  viewportY: number,
  img: HTMLImageElement,
  container: HTMLElement | null,
  viewportSize?: BrowserViewportSize | null
): { x: number; y: number } | null {
  const viewport = viewportSize?.width && viewportSize.height
    ? viewportSize
    : img.naturalWidth > 0 && img.naturalHeight > 0
      ? { width: img.naturalWidth, height: img.naturalHeight }
      : null;

  if (!viewport) return null;

  const rect = img.getBoundingClientRect();
  const containerRect = container?.getBoundingClientRect();

  const scale = Math.min(rect.width / viewport.width, rect.height / viewport.height);
  const renderedW = viewport.width * scale;
  const renderedH = viewport.height * scale;
  const offsetX = (rect.width - renderedW) / 2;
  const offsetY = (rect.height - renderedH) / 2;
  const baseX = containerRect ? rect.left - containerRect.left : 0;
  const baseY = containerRect ? rect.top - containerRect.top : 0;

  const displayX = baseX + (viewportX / viewport.width) * renderedW + offsetX;
  const displayY = baseY + (viewportY / viewport.height) * renderedH + offsetY;

  return { x: displayX, y: displayY };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

let indicatorCounter = 0;

export function useActionIndicators({
  imgRef,
  containerRef,
  viewportSize,
  enabled,
}: UseActionIndicatorsOptions): UseActionIndicatorsReturn {
  const [indicators, setIndicators] = useState<ActionIndicator[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const clearIndicators = useCallback(() => {
    for (const timer of timersRef.current.values()) {
      clearTimeout(timer);
    }
    timersRef.current.clear();
    setIndicators([]);
  }, []);

  // M4: Use a ref for enabled so addAction never holds a stale closure
  const enabledRef = useRef(enabled);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  // Cleanup all timers on unmount
  useEffect(() => clearIndicators, [clearIndicators]);

  useEffect(() => {
    if (enabled) return;
    clearIndicators();
  }, [enabled, clearIndicators]);

  const addAction = useCallback(
    (data: ActionSSEData) => {
      if (!enabledRef.current) return;

      const img = imgRef.current;
      if (!img) return;

      const id = `action-${++indicatorCounter}`;
      const source = data.source ?? "agent";

      // Map coordinates if present
      let x: number | undefined;
      let y: number | undefined;

      const inputX = data.input?.x;
      const inputY = data.input?.y;

      if (typeof inputX === "number" && typeof inputY === "number") {
        const display = viewportToDisplay(inputX, inputY, img, containerRef.current, viewportSize);
        if (display) {
          x = display.x;
          y = display.y;
        }
      }

      // Agent clicks use selectors, not coordinates — show centered ripple
      if (data.action === "click" && x == null && y == null) {
        if (img) {
          const rect = img.getBoundingClientRect();
          const containerRect = containerRef.current?.getBoundingClientRect();
          const baseX = containerRect ? rect.left - containerRect.left : 0;
          const baseY = containerRect ? rect.top - containerRect.top : 0;
          x = baseX + rect.width / 2;
          y = baseY + rect.height / 2;
        }
      }

      const indicator: ActionIndicator = {
        id,
        action: data.action,
        x,
        y,
        source,
        timestamp: Date.now(),
        input: data.input ?? {},
      };

      setIndicators((prev) => {
        const next = [...prev, indicator];
        // Cap at 30 to prevent memory issues during action bursts
        return next.length > 30 ? next.slice(-30) : next;
      });

      // Schedule removal after animation duration
      const duration = getAnimationDuration(data.action);
      const timer = setTimeout(() => {
        setIndicators((prev) => prev.filter((i) => i.id !== id));
        timersRef.current.delete(id);
      }, duration);

      timersRef.current.set(id, timer);
    },
    [containerRef, imgRef, viewportSize]
  );

  return { indicators, addAction, clearIndicators };
}
