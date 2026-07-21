"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { resilientFetch } from "@/lib/utils/resilient-fetch";

/**
 * Context window status as returned by the API.
 */
export interface ContextStatusInfo {
  percentage: number;
  status: "safe" | "warning" | "critical" | "exceeded";
  currentTokens: number;
  maxInputTokens: number;
  maxTokens: number;
  maxOutputTokens?: number;
  formatted: {
    current: string;
    max: string;
    percentage: string;
  };
  thresholds: {
    warning: number;
    critical: number;
    hardLimit: number;
  };
  shouldCompact: boolean;
  mustCompact: boolean;
  recommendedAction: string;
  model?: {
    id: string;
    provider: string;
  };
}

/** Module-level cache to prevent redundant fetches (e.g. Strict Mode double-mount). */
const statusCache = new Map<string, { data: ContextStatusInfo; timestamp: number }>();
const STALE_TIME_MS = 10_000; // 10 seconds

interface UseContextStatusOptions {
  /** Session ID to track. Null/undefined disables polling. */
  sessionId: string | null | undefined;
  /** Poll interval in ms. Default: 0 (no polling, only manual refresh). */
  pollIntervalMs?: number;
  /** Whether to auto-fetch on mount. Default: true. */
  autoFetch?: boolean;
  /** Skip interval fetches while tab is hidden. Default: true. */
  pauseWhenHidden?: boolean;
}

interface UseContextStatusReturn {
  status: ContextStatusInfo | null;
  isLoading: boolean;
  error: string | null;
  /** Manually refresh the context status. */
  refresh: () => Promise<void>;
  /** Trigger manual compaction and refresh status afterwards. */
  compact: () => Promise<{ success: boolean; compacted: boolean }>;
  isCompacting: boolean;
}

function normalizeStatus(
  value: ContextStatusInfo,
  fallbackThresholds?: ContextStatusInfo["thresholds"]
): ContextStatusInfo {
  return {
    ...value,
    maxInputTokens: value.maxInputTokens ?? value.maxTokens,
    shouldCompact: value.shouldCompact ?? false,
    mustCompact: value.mustCompact ?? false,
    recommendedAction: value.recommendedAction ?? "",
    thresholds: value.thresholds ?? fallbackThresholds ?? {
      warning: 0,
      critical: 0,
      hardLimit: 0,
    },
  };
}

function dispatchContextStatusChanged(sessionId: string, status: ContextStatusInfo): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("seline:context-status-changed", {
    detail: { sessionId, status },
  }));
}

/**
 * Hook to fetch and track context window status for a session.
 *
 * Usage:
 * ```tsx
 * const { status, refresh, compact, isCompacting } = useContextStatus({
 *   sessionId: "abc-123",
 *   pollIntervalMs: 30000, // optional polling
 * });
 * ```
 */
export function useContextStatus({
  sessionId,
  pollIntervalMs = 0,
  autoFetch = true,
  pauseWhenHidden = true,
}: UseContextStatusOptions): UseContextStatusReturn {
  const [status, setStatus] = useState<ContextStatusInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const fetchStatus = useCallback(async (force = false) => {
    if (!sessionId) return;

    // Reuse fresh data only for passive mount hydration. Explicit refreshes and
    // active-run polls must hit the API so live delegated-session progress is visible.
    const cached = statusCache.get(sessionId);
    if (!force && cached && Date.now() - cached.timestamp < STALE_TIME_MS) {
      setStatus(cached.data);
      return;
    }

    // Cancel any in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError(null);

    // NOTE: Do NOT wrap this in `deduplicate()`. The abort controller already
    // prevents concurrent request piling. `deduplicate` re-uses the same
    // promise across React StrictMode mount/unmount cycles, which means the
    // second mount can receive the first mount's "Aborted" error result and
    // permanently leave `status` as null (model badge never appears).
    const { data, error: fetchError } = await resilientFetch<ContextStatusInfo>(
      `/api/sessions/${sessionId}/context-status`,
      { signal: controller.signal, retries: 0 }
    );

    // Request was aborted (e.g., component unmounted or new request started)
    if (controller.signal.aborted) return;

    if (fetchError) {
      setError(fetchError);
    } else if (data) {
      const normalized = normalizeStatus(data);
      setStatus(normalized);
      statusCache.set(sessionId, { data: normalized, timestamp: Date.now() });
      dispatchContextStatusChanged(sessionId, normalized);
    }

    setIsLoading(false);
  }, [sessionId]);

  const refresh = useCallback(() => fetchStatus(true), [fetchStatus]);

  const compact = useCallback(async (): Promise<{
    success: boolean;
    compacted: boolean;
  }> => {
    if (!sessionId) return { success: false, compacted: false };

    setIsCompacting(true);

    const { data, error: fetchError } = await resilientFetch<{
      success?: boolean;
      compacted?: boolean;
      status?: ContextStatusInfo;
    }>(`/api/sessions/${sessionId}/context-status`, { method: "POST", retries: 0 });

    if (fetchError) {
      setError(fetchError);
      setIsCompacting(false);
      return { success: false, compacted: false };
    }

    // Update status from the response
    if (data?.status) {
      const normalized = normalizeStatus(data.status, status?.thresholds);
      setStatus(normalized);
      statusCache.set(sessionId, { data: normalized, timestamp: Date.now() });
      dispatchContextStatusChanged(sessionId, normalized);
    }

    setIsCompacting(false);
    return { success: data?.success ?? true, compacted: data?.compacted ?? false };
  }, [sessionId, status?.thresholds]);

  // Auto-fetch on mount / sessionId change
  useEffect(() => {
    if (autoFetch && sessionId) {
      fetchStatus();
    }
    return () => {
      abortRef.current?.abort();
    };
  }, [autoFetch, sessionId, fetchStatus]);

  // Refresh when model config changes (agent defaults, session overrides, etc.)
  useEffect(() => {
    if (!sessionId) return;
    const handler = () => {
      // Invalidate cache so fetchStatus actually hits the API
      // instead of returning stale data with the previous model.
      statusCache.delete(sessionId);
      void fetchStatus();
    };
    window.addEventListener("seline:model-config-changed", handler);
    return () => window.removeEventListener("seline:model-config-changed", handler);
  }, [sessionId, fetchStatus]);

  // Tool-driven compaction happens inside the chat stream. The streamed tool
  // result is rendered in the visible message tree, where expansion/collapse can
  // remount tool UIs and replay old events. Treat it only as a trigger to fetch
  // the authoritative server status so visual tool state cannot rewrite the
  // context meter with stale compacted values.
  useEffect(() => {
    if (!sessionId) return;

    const handleToolResult = (event: Event) => {
      const detail = (event as CustomEvent).detail as { sessionId?: unknown } | undefined;
      if (detail?.sessionId !== sessionId) return;
      statusCache.delete(sessionId);
      void fetchStatus(true);
    };

    const handleStatusChanged = (event: Event) => {
      const detail = (event as CustomEvent).detail as { sessionId?: unknown; status?: ContextStatusInfo } | undefined;
      if (detail?.sessionId !== sessionId || !detail.status) return;
      const normalized = normalizeStatus(detail.status, status?.thresholds);
      setStatus(normalized);
      statusCache.set(sessionId, { data: normalized, timestamp: Date.now() });
    };

    window.addEventListener("seline:compact-session-completed", handleToolResult);
    window.addEventListener("seline:context-status-changed", handleStatusChanged);
    return () => {
      window.removeEventListener("seline:compact-session-completed", handleToolResult);
      window.removeEventListener("seline:context-status-changed", handleStatusChanged);
    };
  }, [fetchStatus, sessionId, status?.thresholds]);

  // Refresh once when tab becomes visible again after being hidden.
  useEffect(() => {
    if (!sessionId || !pauseWhenHidden || typeof document === "undefined") return;

    const onVisibilityChange = () => {
      if (!document.hidden) {
        void fetchStatus(true);
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [sessionId, pauseWhenHidden, fetchStatus]);

  // Optional polling
  useEffect(() => {
    if (!pollIntervalMs || pollIntervalMs <= 0 || !sessionId) return;

    const interval = setInterval(() => {
      if (pauseWhenHidden && typeof document !== "undefined" && document.hidden) {
        return;
      }
      void fetchStatus(true);
    }, pollIntervalMs);

    return () => clearInterval(interval);
  }, [pollIntervalMs, sessionId, pauseWhenHidden, fetchStatus]);

  // Reset when sessionId changes
  useEffect(() => {
    if (!sessionId) {
      setStatus(null);
      setError(null);
      setIsLoading(false);
    }
  }, [sessionId]);

  return {
    status,
    isLoading,
    error,
    refresh,
    compact,
    isCompacting,
  };
}
