"use client";

import { useCallback, useEffect, useRef, useState, type RefCallback } from "react";

export const THREAD_VIEWPORT_BOTTOM_THRESHOLD_PX = 80;

interface ThreadViewportAutoScrollOptions {
  bottomThresholdPx?: number;
}

function isNearBottom(viewport: HTMLElement, threshold: number) {
  const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
  return distanceFromBottom <= threshold;
}

/**
 * Keeps the thread pinned to the latest content only while the user is following
 * the bottom of the conversation. An upward scroll suspends following immediately,
 * including when it happens inside the near-bottom threshold.
 */
export function useThreadViewportAutoScroll({
  bottomThresholdPx = THREAD_VIEWPORT_BOTTOM_THRESHOLD_PX,
}: ThreadViewportAutoScrollOptions = {}): RefCallback<HTMLDivElement> {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const shouldFollowBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const animationFramePendingRef = useRef(false);
  const animationFrameRef = useRef<number | null>(null);

  const viewportRef = useCallback((element: HTMLDivElement | null) => {
    setViewport(element);
  }, []);

  useEffect(() => {
    if (!viewport) {
      return;
    }

    shouldFollowBottomRef.current = true;
    lastScrollTopRef.current = viewport.scrollTop;

    let pointerIsDown = false;

    const suspendFollowing = () => {
      if (viewport.scrollTop > 0) {
        shouldFollowBottomRef.current = false;
      }
    };

    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        suspendFollowing();
      }
    };

    const handlePointerDown = () => {
      pointerIsDown = true;
    };

    const handlePointerUp = () => {
      pointerIsDown = false;
    };

    const handleScroll = () => {
      const currentScrollTop = viewport.scrollTop;
      const scrolledUp = currentScrollTop < lastScrollTopRef.current - 1;
      const nearBottom = isNearBottom(viewport, bottomThresholdPx);

      if (viewport.scrollHeight <= viewport.clientHeight) {
        shouldFollowBottomRef.current = true;
      } else if (scrolledUp) {
        if (pointerIsDown || !nearBottom) {
          shouldFollowBottomRef.current = false;
        }
      } else if (nearBottom) {
        shouldFollowBottomRef.current = true;
      }

      lastScrollTopRef.current = currentScrollTop;
    };

    const scrollToBottomIfFollowing = () => {
      animationFramePendingRef.current = false;
      animationFrameRef.current = null;
      if (!shouldFollowBottomRef.current) {
        return;
      }

      viewport.scrollTo({ top: viewport.scrollHeight, behavior: "auto" });
      lastScrollTopRef.current = viewport.scrollTop;
    };

    const scheduleScrollToBottom = () => {
      if (!shouldFollowBottomRef.current || animationFramePendingRef.current) {
        return;
      }

      animationFramePendingRef.current = true;
      animationFrameRef.current = requestAnimationFrame(scrollToBottomIfFollowing);
    };

    // Inline-style writes (shimmers, transitions) arrive every frame and do not
    // add content; following them forced a full-thread layout per frame.
    // assistant-ui's own viewport observer ignores them for the same reason.
    const mutationObserver = new MutationObserver((records) => {
      if (records.every((record) => record.type === "attributes" && record.attributeName === "style")) {
        return;
      }
      scheduleScrollToBottom();
    });
    mutationObserver.observe(viewport, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    viewport.addEventListener("wheel", handleWheel, { passive: true });
    viewport.addEventListener("pointerdown", handlePointerDown, { passive: true });
    window.addEventListener("pointerup", handlePointerUp, { passive: true });
    window.addEventListener("pointercancel", handlePointerUp, { passive: true });

    return () => {
      viewport.removeEventListener("scroll", handleScroll);
      viewport.removeEventListener("wheel", handleWheel);
      viewport.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      mutationObserver.disconnect();
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      animationFramePendingRef.current = false;
      animationFrameRef.current = null;
    };
  }, [bottomThresholdPx, viewport]);

  return viewportRef;
}
