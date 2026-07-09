/**
 * Task Notifications Hook
 *
 * Subscribes to SSE task events and shows toast notifications.
 * Also updates the active tasks store for the header indicator.
 */

"use client";

import { useEffect, useRef, useCallback } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useUnifiedTasksStore } from "@/lib/stores/unified-tasks-store";
import {
  useSessionSyncStore,
  type SessionActivityIndicator,
  type SessionActivityState,
  type SessionActivityTone,
} from "@/lib/stores/session-sync-store";
import {
  isBackgroundLifecycleTask,
  isBackgroundProcessTask,
  type TaskEvent,
  type TaskProgressEvent,
  type UnifiedTask,
} from "@/lib/background-tasks/types";
import { formatDuration } from "@/lib/utils/timestamp";
import { resilientFetch } from "@/lib/utils/resilient-fetch";

const DEBUG_CHAT =
  typeof process !== "undefined" && process.env.NEXT_PUBLIC_DEBUG_CHAT === "true";

/** Batch interval for progress events — only the latest per-runId is processed each flush. */
const BATCH_FLUSH_MS = 250;

interface SSEMessage {
  type: "connected" | "heartbeat" | "task:started" | "task:completed" | "task:progress";
  data?: TaskEvent;
  timestamp?: string;
}

const MAX_ACTIVITY_LABEL_LENGTH = 64;

function trimLabel(value: string, maxLength = MAX_ACTIVITY_LABEL_LENGTH): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function uniqueIndicators(items: SessionActivityIndicator[]): SessionActivityIndicator[] {
  const byKey = new Map<string, SessionActivityIndicator>();
  for (const item of items) {
    byKey.set(item.key, item);
  }
  return Array.from(byKey.values());
}

function stableIndicatorSort(items: SessionActivityIndicator[]): SessionActivityIndicator[] {
  return [...items].sort((a, b) => {
    const aPriority = a.tone === "critical" ? 4 : a.tone === "warning" ? 3 : a.tone === "info" ? 2 : a.tone === "success" ? 1 : 0;
    const bPriority = b.tone === "critical" ? 4 : b.tone === "warning" ? 3 : b.tone === "info" ? 2 : b.tone === "success" ? 1 : 0;
    if (aPriority !== bPriority) return bPriority - aPriority;
    return a.label.localeCompare(b.label);
  });
}

function buildActivityState(
  sessionId: string,
  runId: string,
  indicators: SessionActivityIndicator[],
  options: {
    isRunning: boolean;
    progressText?: string;
    previous?: SessionActivityState;
  }
): SessionActivityState {
  const sortedIndicators = stableIndicatorSort(uniqueIndicators(indicators));
  const signature = sortedIndicators
    .map((item) => `${item.key}:${item.kind}:${item.tone}:${item.label}:${item.detail ?? ""}`)
    .join("|");

  const previous = options.previous;
  if (
    previous &&
    previous.runId === runId &&
    previous.isRunning === options.isRunning &&
    previous.progressText === options.progressText
  ) {
    const previousSignature = previous.indicators
      .map((item) => `${item.key}:${item.kind}:${item.tone}:${item.label}:${item.detail ?? ""}`)
      .join("|");
    if (previousSignature === signature) {
      return previous;
    }
  }

  return {
    sessionId,
    runId,
    indicators: sortedIndicators,
    progressText: options.progressText,
    isRunning: options.isRunning,
    updatedAt: Date.now(),
  };
}

function compactToolName(value: string, maxLength = 26): string {
  const candidate = value.replace(/^functions\./i, "").replace(/^mcp_?/i, "").replace(/^tool_?/i, "");
  return trimLabel(candidate, maxLength);
}

function normalizeProgressLabel(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();

  const patterns: Array<{ regex: RegExp; label: string }> = [
    { regex: /\b(result from|tool result)\b/i, label: "Tool result" },
    { regex: /\brunning\b/i, label: "Working" },
    { regex: /\bexecuting\b/i, label: "Executing" },
    { regex: /\bworkspace\b/i, label: "Workspace" },
    { regex: /\bpull request\b|\bpr\b/i, label: "PR" },
  ];

  for (const pattern of patterns) {
    if (pattern.regex.test(compact)) {
      return pattern.label;
    }
  }

  if (/\bcomplete(d)?\b/i.test(compact)) {
    return "Complete";
  }

  return trimLabel(compact, 34);
}

function isToolLikePart(part: unknown, type: "tool-call" | "tool-result"): part is Record<string, unknown> {
  return Boolean(part) && typeof part === "object" && (part as Record<string, unknown>).type === type;
}

function getLatestToolPart(
  parts: unknown[]
): { type: "tool-call" | "tool-result"; part: Record<string, unknown> } | null {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (isToolLikePart(part, "tool-result")) {
      return { type: "tool-result", part };
    }
    if (isToolLikePart(part, "tool-call")) {
      return { type: "tool-call", part };
    }
  }
  return null;
}

function deriveProgressSummary(event: TaskProgressEvent): {
  label: string;
  kind: SessionActivityIndicator["kind"];
  tone: SessionActivityTone;
  detail?: string;
  progressText?: string;
} {
  const parts = Array.isArray(event.progressContent) ? event.progressContent : [];
  const latestToolPart = getLatestToolPart(parts);

  if (latestToolPart?.type === "tool-result") {
    const { part } = latestToolPart;
    if (typeof part.toolName === "string") {
      const detail = compactToolName(part.toolName);
      const statusRaw = typeof part.status === "string" ? part.status.toLowerCase() : "";
      const isError = statusRaw === "error" || statusRaw === "failed" || statusRaw === "denied";

      const label = `${isError ? "Tool failed" : "Tool done"}: ${detail}`;
      return {
        label,
        kind: "tool",
        tone: isError ? "warning" : "success",
        progressText: label,
      };
    }
  }

  if (latestToolPart?.type === "tool-call") {
    const { part } = latestToolPart;
    if (typeof part.toolName === "string") {
      const detail = compactToolName(part.toolName);
      const state = typeof part.state === "string" ? part.state : "";

      if (state === "input-streaming" || state === "input-available") {
        const label = `Preparing ${detail}`;
        return {
          label,
          kind: "tool",
          tone: "info",
          progressText: label,
        };
      }

      const label = `Calling ${detail}`;
      return {
        label,
        kind: "tool",
        tone: "info",
        progressText: label,
      };
    }
  }

  const progressText = event.progressText?.trim();
  if (progressText) {
    const lower = progressText.toLowerCase();

    if (lower.includes("hook")) {
      return { label: "Hook", kind: "hook", tone: "info", progressText: "Hook" };
    }
    if (lower.includes("skill")) {
      return { label: "Skill", kind: "skill", tone: "info", progressText: "Skill" };
    }
    if (lower.includes("workspace")) {
      return { label: "Workspace", kind: "workspace", tone: "neutral", progressText: "Workspace" };
    }
    if (lower.includes("pull request") || /\bpr\b/.test(lower)) {
      return { label: "PR", kind: "pr", tone: "info", progressText: "PR" };
    }

    const normalized = normalizeProgressLabel(progressText);
    return {
      label: normalized,
      kind: "tool",
      tone: "info",
      progressText: normalized,
    };
  }

  if (event.taskName) {
    return {
      label: trimLabel(event.taskName, 28),
      kind: "skill",
      tone: "neutral",
      progressText: trimLabel(event.taskName, 28),
    };
  }

  return {
    label: "Working",
    kind: "run",
    tone: "info",
    progressText: "Working",
  };
}

function deriveTaskIndicators(task: UnifiedTask, progressText?: string): SessionActivityIndicator[] {
  const indicators: SessionActivityIndicator[] = [
    {
      key: "run",
      kind: "run",
      label: "Working",
      tone: "info",
    },
  ];

  if (task.type === "scheduled") {
    indicators.push({
      key: "scheduled-task",
      kind: "skill",
      label: trimLabel(task.taskName || "Scheduled task", 28),
      detail: task.attemptNumber ? `Attempt ${task.attemptNumber}` : undefined,
      tone: "neutral",
    });
    if (progressText) {
      indicators.push({
        key: "scheduled-progress",
        kind: "tool",
        label: normalizeProgressLabel(progressText),
        tone: "info",
      });
    }
  }

  if (task.type === "chat") {
    const metadata = (task.metadata && typeof task.metadata === "object")
      ? (task.metadata as Record<string, unknown>)
      : {};

    if (task.pipelineName === "deep-research") {
      indicators.push({
        key: "deep-research",
        kind: "skill",
        label: "Deep research",
        tone: "info",
      });
    }

    if (metadata.isDelegation === true) {
      indicators.push({
        key: "delegation",
        kind: "delegation",
        label: "Delegating",
        tone: "info",
      });
    }

    if (metadata.scheduledRunId) {
      indicators.push({
        key: "scheduled-origin",
        kind: "skill",
        label: "Scheduled run",
        tone: "neutral",
      });
    }

    const toolName = typeof metadata.toolName === "string" ? metadata.toolName : undefined;
    if (toolName) {
      indicators.push({
        key: "tool-name",
        kind: "tool",
        label: "Calling tool",
        detail: compactToolName(toolName),
        tone: "info",
      });
    }

    const hookName = typeof metadata.hookName === "string" ? metadata.hookName : undefined;
    if (hookName) {
      indicators.push({
        key: "hook",
        kind: "hook",
        label: "Hook",
        detail: trimLabel(hookName, 24),
        tone: "info",
      });
    }

    const skillName = typeof metadata.skillName === "string" ? metadata.skillName : undefined;
    if (skillName) {
      indicators.push({
        key: "skill",
        kind: "skill",
        label: "Skill",
        detail: trimLabel(skillName, 24),
        tone: "info",
      });
    }

    if (progressText) {
      indicators.push({
        key: "chat-progress",
        kind: "tool",
        label: normalizeProgressLabel(progressText),
        tone: "info",
      });
    }
  }

  if (task.type === "channel") {
    indicators.push({
      key: "channel",
      kind: "run",
      label: `Channel ${task.channelType}`,
      tone: "neutral",
    });
  }

  return uniqueIndicators(indicators);
}

function deriveProgressIndicators(event: TaskProgressEvent): {
  indicators: SessionActivityIndicator[];
  progressText?: string;
} {
  const summary = deriveProgressSummary(event);
  const indicators: SessionActivityIndicator[] = [
    {
      key: "run",
      kind: "run",
      label: "Working",
      tone: "info",
    },
    {
      key: "progress-summary",
      kind: summary.kind,
      label: summary.label,
      detail: summary.detail,
      tone: summary.tone,
    },
  ];

  if (event.taskName && summary.kind !== "skill") {
    indicators.push({
      key: "task-name",
      kind: "skill",
      label: trimLabel(event.taskName, 28),
      tone: "neutral",
    });
  }

  return {
    indicators: uniqueIndicators(indicators),
    progressText: summary.progressText,
  };
}

function isPersistentBackgroundChatTask(task: UnifiedTask): boolean {
  if (isBackgroundLifecycleTask(task) || isBackgroundProcessTask(task)) {
    return true;
  }

  if (task.type !== "chat") {
    return false;
  }

  const metadata =
    task.metadata && typeof task.metadata === "object"
      ? (task.metadata as Record<string, unknown>)
      : {};

  return (
    metadata.deepResearch === true ||
    metadata.suppressFromUI === true ||
    metadata.taskSource === "channel" ||
    typeof metadata.scheduledRunId === "string"
  );
}

function deriveCompletionIndicators(task: UnifiedTask): SessionActivityIndicator[] {
  const indicators: SessionActivityIndicator[] = [];

  if (task.status === "succeeded") {
    indicators.push({
      key: "completed",
      kind: "success",
      label: "Completed",
      tone: "success",
    });
  } else if (task.status === "stale") {
    indicators.push({
      key: "stale",
      kind: "error",
      label: "Needs attention",
      tone: "warning",
    });
  } else if (task.status === "cancelled") {
    indicators.push({
      key: "cancelled",
      kind: "error",
      label: "Cancelled",
      tone: "warning",
    });
  } else {
    indicators.push({
      key: "failed",
      kind: "error",
      label: "Failed",
      tone: "critical",
    });
  }

  if (task.type === "scheduled") {
    indicators.push({
      key: "scheduled-task",
      kind: "skill",
      label: trimLabel(task.taskName || "Scheduled task"),
      tone: "neutral",
    });
  }

  if (task.type === "chat") {
    const metadata = (task.metadata && typeof task.metadata === "object")
      ? (task.metadata as Record<string, unknown>)
      : {};

    if (metadata.isDelegation === true) {
      indicators.push({
        key: "delegation",
        kind: "delegation",
        label: task.status === "succeeded" ? "Delegation done" : "Delegation issue",
        tone: task.status === "succeeded" ? "success" : "warning",
      });
    }

    const resultSummary = typeof metadata.resultSummary === "string" ? metadata.resultSummary : "";
    if (/\bworkspace\b/i.test(resultSummary)) {
      indicators.push({
        key: "workspace",
        kind: "workspace",
        label: "Workspace updated",
        tone: "neutral",
      });
    }

    if (/\bPR\b|pull request/i.test(resultSummary)) {
      indicators.push({
        key: "pr",
        kind: "pr",
        label: "PR updated",
        tone: "info",
      });
    }
  }

  return uniqueIndicators(indicators);
}

function classifyTask(task: UnifiedTask): { isScheduledChat: boolean; isDelegationChat: boolean; displayName: string } {
  const isScheduledChat =
    task.type === "chat" &&
    task.metadata &&
    typeof task.metadata === "object" &&
    "scheduledRunId" in task.metadata;
  const isDelegationChat =
    task.type === "chat" &&
    task.metadata &&
    typeof task.metadata === "object" &&
    "isDelegation" in task.metadata;
  const displayName = isDelegationChat
    ? "Delegation"
    : task.type === "scheduled"
    ? task.taskName || "Scheduled task"
    : task.type === "chat"
    ? "Chat session"
    : "Channel message";
  return { isScheduledChat: Boolean(isScheduledChat), isDelegationChat: Boolean(isDelegationChat), displayName };
}

export function buildReconciledCompletionEvent(task: UnifiedTask): Extract<TaskEvent, { eventType: "task:completed" }> {
  return {
    eventType: "task:completed",
    task: {
      ...task,
      status: task.status === "running" || task.status === "queued" ? "cancelled" : task.status,
      completedAt: task.completedAt ?? new Date().toISOString(),
    },
    timestamp: new Date().toISOString(),
  };
}

export function reconcileTaskSnapshotWithStores(
  currentTasks: UnifiedTask[],
  serverTasks: UnifiedTask[],
  callbacks: {
    addTask: (task: UnifiedTask) => void;
    updateTask: (runId: string, updates: Partial<UnifiedTask>) => void;
    completeTask: (task: UnifiedTask) => void;
    dispatchTaskReconciledEvent?: (event: Extract<TaskEvent, { eventType: "task:completed" }>) => void;
  }
): void {
  const serverRunIds = new Set(serverTasks.map((task) => task.runId));
  const sessionSyncState = useSessionSyncStore.getState();

  const applyCompletionState = (
    task: UnifiedTask,
    completionTask: UnifiedTask,
    event: Extract<TaskEvent, { eventType: "task:completed" }>,
  ) => {
    callbacks.completeTask(completionTask);
    // Background shell processes never own the session's active-run marker,
    // so their completion must not clear it or rewrite session activity.
    if (task.sessionId && !isBackgroundProcessTask(task)) {
      sessionSyncState.setActiveRun(task.sessionId, null);
      const previous = sessionSyncState.getSessionActivity(task.sessionId);
      sessionSyncState.setSessionActivity(
        task.sessionId,
        buildActivityState(task.sessionId, completionTask.runId, deriveCompletionIndicators(completionTask), {
          isRunning: false,
          previous,
        })
      );
    }
    if (isBackgroundLifecycleTask(task)) {
      callbacks.dispatchTaskReconciledEvent?.(event);
    }
  };

  const reconciledRunIds = new Set<string>();

  for (const task of currentTasks) {
    if (!serverRunIds.has(task.runId)) {
      const reconciledCompletion = buildReconciledCompletionEvent(task);
      applyCompletionState(task, reconciledCompletion.task, reconciledCompletion);
      reconciledRunIds.add(task.runId);
    }
  }

  for (const task of serverTasks) {
    const existing = currentTasks.find((current) => current.runId === task.runId);
    if (existing) {
      callbacks.updateTask(task.runId, task);
    } else {
      callbacks.addTask(task);
    }

    if (task.sessionId && !isBackgroundProcessTask(task)) {
      sessionSyncState.setActiveRun(task.sessionId, task.runId);
      const previous = sessionSyncState.getSessionActivity(task.sessionId);
      if (previous && !previous.isRunning && previous.runId === task.runId) {
        continue;
      }
      sessionSyncState.setSessionActivity(
        task.sessionId,
        buildActivityState(task.sessionId, task.runId, deriveTaskIndicators(task), {
          isRunning: true,
          previous,
        })
      );
    }
  }

  const currentActiveRuns = new Map(sessionSyncState.activeRuns);
  for (const [sessionId, runId] of currentActiveRuns) {
    if (reconciledRunIds.has(runId)) {
      continue;
    }

    if (!serverTasks.some((t) => t.sessionId === sessionId)) {
      const task = currentTasks.find((current) => current.runId === runId && current.sessionId === sessionId);
      if (task && !isPersistentBackgroundChatTask(task)) {
        const reconciledCompletion = buildReconciledCompletionEvent(task);
        applyCompletionState(task, reconciledCompletion.task, reconciledCompletion);
        reconciledRunIds.add(runId);
      } else if (!task) {
        sessionSyncState.setActiveRun(sessionId, null);
        sessionSyncState.setSessionActivity(sessionId, null);
      }
    }
  }
}

export function useTaskNotifications() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const t = useTranslations("schedules.notifications");
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const connectedUserIdRef = useRef<string | null>(null);
  const hasConnectedOnceRef = useRef(false);
  const wasDisconnectedRef = useRef(false);
  const pendingReconnectRef = useRef(false);
  const disconnectedAtRef = useRef<number | null>(null);
  const lastEventReceivedAtRef = useRef<number | null>(null);
  // Layer 2: Progress event batching — dedup per-runId, flush on timer
  const progressBatchRef = useRef<Map<string, TaskEvent>>(new Map());
  const batchFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Layer 5: Visibility-aware budget — drop progress events when window is hidden
  const isWindowVisibleRef = useRef(true);
  const reconcileOnFocusRef = useRef<(() => Promise<void>) | null>(null);
  const stalenessCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const addTask = useUnifiedTasksStore((state) => state.addTask);
  const updateTask = useUnifiedTasksStore((state) => state.updateTask);
  const completeTask = useUnifiedTasksStore((state) => state.completeTask);
  const buildSessionUrl = useCallback((task: UnifiedTask) => {
    if (task.sessionId && task.characterId) {
      return `/chat/${task.characterId}?sessionId=${task.sessionId}`;
    }
    return undefined;
  }, []);
  const buildScheduleUrl = useCallback((task: UnifiedTask) => {
    if (task.type !== "scheduled") return undefined;
    return `/agents/${task.characterId}/schedules?highlight=${task.taskId}&run=${task.runId}&expandHistory=true`;
  }, []);
  const dispatchLifecycleEvent = useCallback((eventName: "background-task-started" | "background-task-completed", event: TaskEvent) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(eventName, { detail: event }));
  }, []);
  const dispatchTaskReconciledEvent = useCallback((event: TaskEvent) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("background-task-reconciled", { detail: event }));
  }, []);
  const shouldShowChatToast = useCallback((task: UnifiedTask) => {
    if (typeof window === "undefined") return true;
    if (task.type !== "chat") return true;

    const metadata =
      task.metadata && typeof task.metadata === "object"
        ? (task.metadata as Record<string, unknown>)
        : {};

    // Background chat work needs completion toasts even when the user is focused
    // on the originating session. Foreground chat runs still suppress duplicate
    // notifications for the active session.
    if (
      metadata.isDelegation === true ||
      metadata.deepResearch === true ||
      metadata.suppressFromUI === true ||
      metadata.taskSource === "channel" ||
      typeof metadata.scheduledRunId === "string"
    ) {
      return true;
    }

    const { pathname, search } = window.location;
    if (!pathname.startsWith("/chat/")) return true;
    if (!task.sessionId) return true;
    const params = new URLSearchParams(search);
    const sessionId = params.get("sessionId");
    return !sessionId || sessionId !== task.sessionId;
  }, []);

  // Use refs for handlers to avoid stale closures in EventSource callbacks
  const handleTaskStartedRef = useRef<(event: TaskEvent) => void>(() => {});
  const handleTaskCompletedRef = useRef<(event: TaskEvent) => void>(() => {});
  const handleTaskProgressRef = useRef<(event: TaskEvent) => void>(() => {});

  // Update refs when dependencies change
  useEffect(() => {
    handleTaskStartedRef.current = (event: TaskEvent) => {
      if (event.eventType !== "task:started") return;
      const task = event.task;
      if (isBackgroundProcessTask(task)) {
        // Background shell processes have their own indicator UI. Track them
        // in the store, but never overwrite the session's active-run marker
        // (that belongs to the actual chat run) and never toast for them.
        addTask(task);
        return;
      }
      const { isScheduledChat, isDelegationChat, displayName } = classifyTask(task);
      if (isScheduledChat) {
        return;
      }
      console.log("[TaskNotifications] Task started:", displayName, task.runId);

      addTask(task);
      if (task.sessionId) {
        const sessionSyncState = useSessionSyncStore.getState();
        sessionSyncState.setActiveRun(task.sessionId, task.runId);
        const previous = sessionSyncState.getSessionActivity(task.sessionId);
        sessionSyncState.setSessionActivity(
          task.sessionId,
          buildActivityState(task.sessionId, task.runId, deriveTaskIndicators(task), {
            isRunning: true,
            previous,
          })
        );
      }
      // Only dispatch background lifecycle event for actual background tasks
      // (scheduled runs, delegations). Plain foreground chat tasks should NOT
      // trigger the background-processing indicator in the active session.
      const isActualBackgroundTask = task.type === "scheduled" || isDelegationChat;
      if (isActualBackgroundTask) {
        dispatchLifecycleEvent("background-task-started", event);
      }

      if (isDelegationChat) return;

      const runningKey =
        task.type === "scheduled"
          ? "taskRunning"
          : task.type === "chat"
          ? "chatRunning"
          : "taskRunningGeneric";
      if (shouldShowChatToast(task)) {
        toast.info(t(runningKey, { taskName: displayName }), {
          description: t("taskStartedAt", {
            time: new Date(task.startedAt).toLocaleTimeString(),
          }),
          action: buildSessionUrl(task)
            ? {
                label: t("viewTask"),
                onClick: () => {
                  const url = buildSessionUrl(task);
                  if (url) router.push(url);
                },
              }
            : undefined,
          duration: 5000,
        });
      }
    };

    handleTaskCompletedRef.current = (event: TaskEvent) => {
      if (event.eventType !== "task:completed") return;
      const task = event.task;
      if (isBackgroundProcessTask(task)) {
        // Background shell process settled. Update the store so the indicator
        // reflects the final state, but do NOT clear the session's active run
        // (a chat run may still be streaming) and do NOT dispatch the
        // chat-completion lifecycle event (it triggers message reloads).
        progressBatchRef.current.delete(task.runId);
        completeTask(task);
        if (task.status === "failed") {
          const metadata =
            task.metadata && typeof task.metadata === "object"
              ? (task.metadata as Record<string, unknown>)
              : {};
          const command = typeof metadata.command === "string" ? metadata.command : undefined;
          const description = [command, task.error]
            .filter((part): part is string => Boolean(part))
            .join(" — ")
            .slice(0, 140);
          toast.error(t("processFailed"), {
            description: description || undefined,
            duration: 10000,
          });
        }
        return;
      }
      const { isScheduledChat, isDelegationChat, displayName } = classifyTask(task);
      if (isScheduledChat) {
        return;
      }
      console.log("[TaskNotifications] Task completed:", displayName, task.status);

      // Evict any pending batched progress for this run so the stale event
      // cannot overwrite the completion state when the batch flushes.
      progressBatchRef.current.delete(task.runId);

      completeTask(task);
      if (task.sessionId) {
        const sessionSyncState = useSessionSyncStore.getState();
        sessionSyncState.setActiveRun(task.sessionId, null);
        const previous = sessionSyncState.getSessionActivity(task.sessionId);
        sessionSyncState.setSessionActivity(
          task.sessionId,
          buildActivityState(task.sessionId, task.runId, deriveCompletionIndicators(task), {
            isRunning: false,
            previous,
          })
        );
      }
      // Dispatch for all chat/scheduled/delegation completions. For foreground
      // chat runs that completed while the client was disconnected (network
      // interruption), this is the ONLY signal that triggers message reload
      // and terminal UI cleanup in the chat interface. For runs that completed
      // normally (stream delivered everything), the extra reload is a no-op.
      const shouldDispatchCompletion = task.type === "chat" || task.type === "scheduled" || isDelegationChat;
      if (shouldDispatchCompletion) {
        dispatchLifecycleEvent("background-task-completed", event);
      }

      if (isDelegationChat) return;

      if (task.status === "succeeded") {
        const completedKey = task.type === "chat" ? "chatCompleted" : "taskCompleted";
        if (shouldShowChatToast(task)) {
          toast.success(t(completedKey, { taskName: displayName }), {
            description:
              task.metadata && typeof task.metadata === "object"
                ? (task.metadata as { resultSummary?: string }).resultSummary?.slice(0, 100)
                : undefined,
            action: buildSessionUrl(task)
              ? {
                  label: t("viewTask"),
                  onClick: () => {
                    const url = buildSessionUrl(task);
                    if (url) router.push(url);
                  },
                }
              : undefined,
            duration: 8000,
          });
        }
      } else if (task.status === "failed") {
        const errorMessage = task.error?.toLowerCase() ?? "";
        const isCreditError =
          errorMessage.includes("credit") ||
          errorMessage.includes("insufficient") ||
          errorMessage.includes("quota");
        if (isCreditError) {
          toast.error(t("taskCreditExhausted"), {
            description: t("taskCreditExhaustedDescription"),
            duration: 15000,
          });
        } else {
          const scheduleUrl = buildScheduleUrl(task);
          toast.error(t("taskFailed", { taskName: displayName }), {
            description: task.error?.slice(0, 100),
            action: scheduleUrl
              ? {
                  label: t("viewDetails"),
                  onClick: () => router.push(scheduleUrl),
                }
              : undefined,
            duration: 10000,
          });
        }
      } else if (task.status === "stale") {
        const duration = task.durationMs ? formatDuration(task.durationMs) : "30m";
        toast.warning(t("taskStale"), {
          description: t("taskStaleDescription", {
            taskName: displayName,
            duration,
          }),
          duration: 8000,
        });
      }
    };

    handleTaskProgressRef.current = (event: TaskEvent) => {
      if (event.eventType === "task:progress") {
        if (event.sessionId || event.characterId) {
          updateTask(event.runId, {
            ...(event.sessionId ? { sessionId: event.sessionId } : {}),
            ...(event.characterId ? { characterId: event.characterId } : {}),
          });
        }

        if (event.sessionId) {
          const sessionSyncState = useSessionSyncStore.getState();
          const previous = sessionSyncState.getSessionActivity(event.sessionId);

          // Guard: don't overwrite a completion state with a stale progress
          // event.  This happens when a batched progress event flushes after
          // task:completed has already been processed for the same run.
          const runAlreadyCompleted =
            previous && !previous.isRunning && previous.runId === event.runId;
          if (!runAlreadyCompleted) {
            const progressState = deriveProgressIndicators(event);
            const progressEvent = event as TaskProgressEvent;
            const hasProgressContent =
              Array.isArray(progressEvent.progressContent) &&
              progressEvent.progressContent.length > 0;
            const hasAssistantMessageId =
              typeof progressEvent.assistantMessageId === "string" &&
              progressEvent.assistantMessageId.length > 0;

            // Keep the active-run marker while the server is still streaming
            // progress content for the current run.
            const isSameRunStillActive =
              previous?.runId === event.runId && previous.isRunning;
            if (hasProgressContent || hasAssistantMessageId || isSameRunStillActive) {
              sessionSyncState.setActiveRun(event.sessionId, event.runId);
            }

            sessionSyncState.setSessionActivity(
              event.sessionId,
              buildActivityState(
                event.sessionId,
                event.runId,
                progressState.indicators,
                {
                  isRunning: true,
                  progressText: progressState.progressText ?? event.progressText,
                  previous,
                }
              )
            );
          }
        }
      }
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("background-task-progress", { detail: event }));
      }
    };
  }, [
    addTask,
    updateTask,
    completeTask,
    t,
    router,
    buildSessionUrl,
    buildScheduleUrl,
    dispatchLifecycleEvent,
    shouldShowChatToast,
  ]);

  const buildReconciledCompletionEvent = useCallback((task: UnifiedTask): Extract<TaskEvent, { eventType: "task:completed" }> => ({
    eventType: "task:completed",
    task: {
      ...task,
      status: task.status === "running" || task.status === "queued" ? "cancelled" : task.status,
      completedAt: task.completedAt ?? new Date().toISOString(),
    },
    timestamp: new Date().toISOString(),
  }), []);

  // Connect to SSE endpoint
  useEffect(() => {
    if (isLoading || !user?.id) {
      return;
    }

    if (eventSourceRef.current && connectedUserIdRef.current === user.id) {
      return;
    }

    console.log("[TaskNotifications] Connecting to event stream for user:", user.id);

    const cleanupConnection = () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (stalenessCheckRef.current) {
        clearInterval(stalenessCheckRef.current);
        stalenessCheckRef.current = null;
      }
      connectedUserIdRef.current = null;
    };

    const scheduleReconnect = () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      const attempt = reconnectAttemptsRef.current + 1;
      reconnectAttemptsRef.current = attempt;
      // Cap at 10s (was 30s), add ±20% jitter to prevent reconnect storms
      const baseDelay = Math.min(10000, 1000 * Math.pow(2, Math.min(attempt, 3)));
      const jitter = baseDelay * (0.8 + Math.random() * 0.4); // ±20%
      reconnectTimeoutRef.current = setTimeout(() => {
        reconnectTimeoutRef.current = null;
        if (user?.id) {
          cleanupConnection();
          connect();
        }
      }, jitter);
    };

    const reconcileTasks = async (showToast: boolean) => {
      try {
        const { data, error } = await resilientFetch<{ tasks: UnifiedTask[]; recentlyCompleted?: UnifiedTask[] }>("/api/tasks/active");
        if (!data) {
          if (error) console.warn("[TaskNotifications] Failed to fetch active tasks:", error);
          return;
        }
        const tasks = data.tasks;
        const currentTasks = useUnifiedTasksStore.getState().tasks;

        reconcileTaskSnapshotWithStores(currentTasks, tasks, {
          addTask: (task) => {
            console.log(`[TaskNotifications] Adding missing task: ${task.runId}`);
            addTask(task);
          },
          updateTask,
          completeTask: (task) => {
            console.log(`[TaskNotifications] Removing stale task: ${task.runId}`);
            completeTask(task);
          },
          dispatchTaskReconciledEvent,
        });

        // Phase 2: Process recently-completed tasks that the frontend may have
        // missed during SSE disconnect. Only replay completions that are NOT
        // already in the client-side "seen" set (store.recentlyCompleted) to
        // prevent duplicate toasts and events on reconnect or initial mount.
        if (data.recentlyCompleted?.length) {
          const storeState = useUnifiedTasksStore.getState();
          const activeRunIds = new Set(storeState.tasks.map((t) => t.runId));
          const seenCompletionIds = new Set(storeState.recentlyCompleted.map((t) => t.runId));
          for (const completedTask of data.recentlyCompleted) {
            // Only fire if:
            // 1. Not still active in client store (still processing)
            // 2. Not already seen/completed on client side (dedup)
            // 3. Not in the server's active tasks (still running)
            if (
              !activeRunIds.has(completedTask.runId) &&
              !seenCompletionIds.has(completedTask.runId) &&
              !tasks.some((t) => t.runId === completedTask.runId)
            ) {
              console.log(`[TaskNotifications] Reconciling recently-completed task: ${completedTask.runId}`);
              const event: TaskEvent = {
                eventType: "task:completed",
                task: completedTask,
                timestamp: completedTask.completedAt ?? new Date().toISOString(),
              };
              handleTaskCompletedRef.current(event);
              // Mark as seen immediately to prevent TOCTOU race with concurrent SSE events
              seenCompletionIds.add(completedTask.runId);
            }
          }
        }

        if (showToast && tasks.length > 0) {
          toast.success(t("taskReconnected"), {
            description: t("taskReconnectedDescription", { count: tasks.length }),
            duration: 5000,
          });
        }

        // Notify chat-interface that task store has been reconciled so it can
        // re-check for active runs it might have missed during SSE disconnect.
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("sse-tasks-reconciled"));
        }
      } catch (error) {
        console.error("[TaskNotifications] Failed to reconcile state:", error);
      }
    };

    const connect = () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      const eventSource = new EventSource("/api/tasks/events");
      eventSourceRef.current = eventSource;
      connectedUserIdRef.current = user.id;

      eventSource.onopen = () => {
        reconnectAttemptsRef.current = 0;
        lastEventReceivedAtRef.current = Date.now();
        console.log("[TaskNotifications] SSE connection opened");
        // Don't toast or reconcile here — wait for first actual message
        // to confirm the connection is fully functional (not just TCP open).
        if (hasConnectedOnceRef.current && wasDisconnectedRef.current) {
          pendingReconnectRef.current = true;
          disconnectedAtRef.current = disconnectedAtRef.current ?? Date.now();
        }
        hasConnectedOnceRef.current = true;
      };

      eventSource.onmessage = (event) => {
        try {
          lastEventReceivedAtRef.current = Date.now();

          // Confirm reconnection on first actual message (not just TCP open).
          // This ensures the full SSE pipeline is working before we toast/reconcile.
          if (pendingReconnectRef.current) {
            pendingReconnectRef.current = false;
            const disconnectDuration = Date.now() - (disconnectedAtRef.current ?? Date.now());
            disconnectedAtRef.current = null;
            wasDisconnectedRef.current = false;
            // Only show toast for outages >3s — skip brief hiccups
            const showToast = disconnectDuration > 3000;
            console.log(`[TaskNotifications] Reconnection confirmed after ${Math.round(disconnectDuration / 1000)}s (toast: ${showToast})`);
            void reconcileTasks(showToast);
          }

          const message: SSEMessage = JSON.parse(event.data);
          if (DEBUG_CHAT) console.log("[TaskNotifications] Received message:", message.type);

          switch (message.type) {
            case "connected":
              if (DEBUG_CHAT) console.log("[TaskNotifications] Connected to event stream");
              break;
            case "heartbeat":
              break;
            case "task:started":
              if (message.data) {
                handleTaskStartedRef.current(message.data);
              }
              break;
            case "task:completed":
              if (message.data) {
                handleTaskCompletedRef.current(message.data);
              }
              break;
            case "task:progress":
              if (message.data) {
                // Layer 2: Batch progress events — keep only latest per runId
                const runId = "runId" in message.data ? (message.data as TaskProgressEvent).runId : undefined;
                if (runId) {
                  progressBatchRef.current.set(runId, message.data);
                  if (batchFlushTimerRef.current === null) {
                    batchFlushTimerRef.current = setTimeout(() => {
                      batchFlushTimerRef.current = null;
                      const batch = progressBatchRef.current;
                      progressBatchRef.current = new Map();
                      // Layer 5: Skip processing when window is hidden —
                      // reconcileTasks on focus-regain will resync state.
                      if (!isWindowVisibleRef.current) return;
                      for (const evt of batch.values()) {
                        handleTaskProgressRef.current(evt);
                      }
                    }, BATCH_FLUSH_MS);
                  }
                } else {
                  // No runId — process immediately (shouldn't happen, but safe fallback)
                  handleTaskProgressRef.current(message.data);
                }
              }
              break;
          }
        } catch (error) {
          console.error("[TaskNotifications] Failed to parse message:", error);
        }
      };

      eventSource.onerror = (error) => {
        const msSinceLastMessage =
          lastEventReceivedAtRef.current === null
            ? null
            : Date.now() - lastEventReceivedAtRef.current;
        console.warn("[TaskNotifications] Connection error:", {
          error,
          readyState: eventSource.readyState,
          msSinceLastMessage,
          reconnectAttempts: reconnectAttemptsRef.current,
        });

        eventSource.close();
        wasDisconnectedRef.current = true;
        disconnectedAtRef.current = disconnectedAtRef.current ?? Date.now();

        if (eventSourceRef.current === eventSource) {
          eventSourceRef.current = null;
        }

        scheduleReconnect();
      };

      // Proactive staleness detection: if no message received for 35s
      // (~2.3x the 15s server heartbeat), the connection is likely dead but the
      // browser hasn't fired onerror yet. Force reconnect.
      // Using 35s instead of 25s to tolerate GC pauses and CPU stalls.
      if (stalenessCheckRef.current) {
        clearInterval(stalenessCheckRef.current);
      }
      stalenessCheckRef.current = setInterval(() => {
        const last = lastEventReceivedAtRef.current;
        if (last === null) return;
        const silenceMs = Date.now() - last;
        if (silenceMs > 35_000 && eventSourceRef.current?.readyState === EventSource.OPEN) {
          console.warn(`[TaskNotifications] SSE stale (${Math.round(silenceMs / 1000)}s silence), forcing reconnect`);
          eventSourceRef.current.close();
          wasDisconnectedRef.current = true;
          disconnectedAtRef.current = disconnectedAtRef.current ?? Date.now();
          eventSourceRef.current = null;
          scheduleReconnect();
        }
      }, 10_000);
    };

    void reconcileTasks(false).then(() => {
      connect();
    });

    return () => {
      if (DEBUG_CHAT) console.log("[TaskNotifications] Cleaning up SSE connection");
      cleanupConnection();
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (batchFlushTimerRef.current !== null) {
        clearTimeout(batchFlushTimerRef.current);
        batchFlushTimerRef.current = null;
      }
      progressBatchRef.current.clear();
      reconnectAttemptsRef.current = 0;
      if (stalenessCheckRef.current) {
        clearInterval(stalenessCheckRef.current);
        stalenessCheckRef.current = null;
      }
    };
  }, [isLoading, user?.id]);

  // Layer 5: Visibility-aware budget
  // When window loses focus, progress events are still batched but the flush
  // discards them. On focus-regain, reconcile from server.
  useEffect(() => {
    const setVisible = (visible: boolean) => {
      const wasHidden = !isWindowVisibleRef.current;
      isWindowVisibleRef.current = visible;
      if (visible && wasHidden) {
        // Reconcile task state after returning from background
        resilientFetch<{ tasks: UnifiedTask[]; recentlyCompleted?: UnifiedTask[] }>("/api/tasks/active").then(({ data }) => {
          if (!data) return;
          const store = useUnifiedTasksStore.getState();
          const syncStore = useSessionSyncStore.getState();
          const serverRunIds = new Set(data.tasks.map((t) => t.runId));
          const recentlyCompletedMap = new Map(
            (data.recentlyCompleted ?? []).map((t) => [t.runId, t])
          );
          // Remove tasks that completed while hidden — use real completion
          // data from recentlyCompleted when available
          for (const task of store.tasks) {
            if (!serverRunIds.has(task.runId)) {
              const realCompletion = recentlyCompletedMap.get(task.runId);
              store.completeTask(realCompletion ?? task);
              if (task.sessionId && !isBackgroundProcessTask(task)) {
                syncStore.setActiveRun(task.sessionId, null);
                syncStore.setSessionActivity(task.sessionId, null);
              }
            }
          }
          // Add/update tasks that started or progressed while hidden
          for (const task of data.tasks) {
            const existing = store.tasks.find((t) => t.runId === task.runId);
            if (existing) store.updateTask(task.runId, task);
            else store.addTask(task);
          }
        });
      }
    };

    // Browser-level visibility (fallback, works even outside Electron)
    const handleVisibility = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", handleVisibility);

    // Electron-specific: window blur/focus (more reliable on macOS)
    const electronAPI = (window as unknown as { electronAPI?: { ipc?: { on?: (ch: string, cb: (...args: unknown[]) => void) => void } } }).electronAPI;
    if (electronAPI?.ipc?.on) {
      electronAPI.ipc.on("window:visibility-changed", (visible: unknown) => {
        if (typeof visible === "boolean") setVisible(visible);
      });
    }

    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      const api = (window as unknown as { electronAPI?: { ipc?: { removeAllListeners?: (ch: string) => void } } }).electronAPI;
      api?.ipc?.removeAllListeners?.("window:visibility-changed");
    };
  }, []);
}
