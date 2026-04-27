/**
 * Unified Task Registry
 *
 * Central registry for all running background tasks.
 * Provides a single source of truth for the "view active tasks" feature.
 */

import { EventEmitter } from "events";
import type {
  UnifiedTask,
  TaskStatus,
  ListActiveTasksOptions,
  ActiveTasksResult,
  TaskEvent,
  TaskProgressEvent,
} from "./types";
import { nowISO, isStale } from "@/lib/utils/timestamp";

const STALE_THRESHOLD_MS = 30 * 60 * 1000;
const DEBUG_TASK_REGISTRY = process.env.DEBUG_TASK_REGISTRY === "true";

const globalForRegistry = globalThis as typeof globalThis & {
  taskRegistry?: TaskRegistry;
};

class TaskRegistry extends EventEmitter {
  private tasks: Map<string, UnifiedTask> = new Map();
  private recentlyCompleted: Map<string, { task: UnifiedTask; completedAt: number }> = new Map();
  private static COMPLETED_TTL_MS = 10 * 60 * 1000; // 10 minutes
  private static MAX_COMPLETED_BUFFER = 200; // size cap to prevent unbounded growth
  private cleanupInterval: NodeJS.Timeout | null = null;
  private cleanupStats = {
    totalCleaned: 0,
    lastCleanupAt: null as string | null,
    cleanupsByReason: {
      stale: 0,
      failed: 0,
      cancelled: 0,
    },
  };

  private constructor() {
    super();
    this.setMaxListeners(100);
    this.startCleanupInterval();
    console.log("[TaskRegistry] Instance created");
  }

  static getInstance(): TaskRegistry {
    if (!globalForRegistry.taskRegistry) {
      globalForRegistry.taskRegistry = new TaskRegistry();
    }
    return globalForRegistry.taskRegistry;
  }

  register(task: UnifiedTask): void {
    // Clear any stale completed entry for reused runIds
    this.recentlyCompleted.delete(task.runId);
    this.tasks.set(task.runId, task);

    const event: TaskEvent = {
      eventType: "task:started",
      task,
      timestamp: nowISO(),
    };

    this.emit("task:started", event);
    this.emit(`task:started:${task.userId}`, event);

    console.log(`[TaskRegistry] Registered ${task.type} task: ${task.runId}`);
  }

  updateStatus(
    runId: string,
    status: TaskStatus,
    updates?: Partial<UnifiedTask>
  ): UnifiedTask | undefined {
    const task = this.tasks.get(runId);
    if (!task) return undefined;

    const shouldComplete = status !== "running" && status !== "queued";
    const updated: UnifiedTask = {
      ...task,
      ...updates,
      status,
      ...(shouldComplete && { completedAt: nowISO() }),
    } as UnifiedTask;

    if (shouldComplete) {
      this.tasks.delete(runId);
      this.recentlyCompleted.set(runId, { task: updated, completedAt: Date.now() });
      // Enforce size cap by evicting oldest entries
      if (this.recentlyCompleted.size > TaskRegistry.MAX_COMPLETED_BUFFER) {
        const excess = this.recentlyCompleted.size - TaskRegistry.MAX_COMPLETED_BUFFER;
        const iter = this.recentlyCompleted.keys();
        for (let i = 0; i < excess; i++) {
          const key = iter.next().value;
          if (key) this.recentlyCompleted.delete(key);
        }
      }
      const event: TaskEvent = {
        eventType: "task:completed",
        task: updated,
        timestamp: nowISO(),
      };
      this.emit("task:completed", event);
      this.emit(`task:completed:${task.userId}`, event);
    } else {
      this.tasks.set(runId, updated);
    }

    console.log(`[TaskRegistry] Updated ${task.type} task ${runId}: ${status}`);
    return updated;
  }

  emitProgress(
    runId: string,
    progressText?: string,
    progressPercent?: number,
    details?: Omit<TaskProgressEvent, "eventType" | "timestamp" | "runId">
  ): void {
    const task = this.tasks.get(runId);
    const progressPreview = progressText?.slice(0, 50);

    if (DEBUG_TASK_REGISTRY) {
      console.log("[TaskRegistry] emitProgress called:", {
        runId,
        progressText: progressPreview,
        hasTask: !!task,
        currentTaskCount: this.tasks.size,
      });
    }

    // Update lastActivityAt for stale detection
    if (task) {
      task.lastActivityAt = nowISO();
      this.tasks.set(runId, task);
    }

    if (!task) {
      if (!details?.userId || !details?.type) {
        console.warn("[TaskRegistry] Progress event dropped; task not in registry and missing details:", {
          runId,
          progressText: progressPreview,
          detailsProvided: !!details,
          availableTasks: Array.from(this.tasks.keys()),
        });
        return;
      }

      console.warn("[TaskRegistry] Task not in registry; emitting progress with provided details:", {
        runId,
        userId: details.userId,
        type: details.type,
      });

      const { userId, type, ...restDetails } = details;
      const event: TaskEvent = {
        eventType: "task:progress",
        runId,
        type,
        userId,
        progressText,
        progressPercent,
        ...restDetails,
        timestamp: nowISO(),
      };

      this.emit("task:progress", event);
      this.emit(`task:progress:${userId}`, event);
      return;
    }

    const { userId: _detailsUserId, type: _detailsType, ...restDetails } = details ?? {};
    const event: TaskEvent = {
      eventType: "task:progress",
      runId,
      type: task.type,
      userId: task.userId,
      characterId: task.characterId,
      sessionId: task.sessionId,
      // SPEC §8: source soloStory routing metadata from the task row when the
      // caller didn't pass overrides via `details`. Allows the lobby UI to
      // filter `task:progress` events by lobbyId without re-querying.
      lobbyId: task.lobbyId,
      cardId: task.cardId,
      progressText,
      progressPercent,
      ...restDetails,
      timestamp: nowISO(),
    };

    if (DEBUG_TASK_REGISTRY) {
      console.log("[TaskRegistry] Emitting task:progress:", {
        runId,
        userId: task.userId,
        type: task.type,
        progressText: progressPreview,
      });
    }

    this.emit("task:progress", event);
    this.emit(`task:progress:${task.userId}`, event);
  }

  get(runId: string): UnifiedTask | undefined {
    return this.tasks.get(runId);
  }

  list(options: ListActiveTasksOptions = {}): ActiveTasksResult {
    let tasks = Array.from(this.tasks.values());

    if (options.userId) {
      tasks = tasks.filter((t) => t.userId === options.userId);
    }
    if (options.characterId) {
      tasks = tasks.filter((t) => t.characterId === options.characterId);
    }
    if (options.type) {
      tasks = tasks.filter((t) => t.type === options.type);
    }
    if (options.sessionId) {
      tasks = tasks.filter((t) => t.sessionId === options.sessionId);
    }

    tasks.sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );

    const total = tasks.length;

    if (options.limit) {
      tasks = tasks.slice(0, options.limit);
    }

    return { tasks, total };
  }

  count(options: Omit<ListActiveTasksOptions, "limit"> = {}): number {
    return this.list(options).total;
  }

  /**
   * Returns tasks that completed within the TTL window.
   * Used by reconciliation to detect completions missed during SSE disconnects.
   */
  listRecentlyCompleted(options: ListActiveTasksOptions = {}): UnifiedTask[] {
    const now = Date.now();
    const results: UnifiedTask[] = [];

    for (const [, entry] of this.recentlyCompleted) {
      if (now - entry.completedAt > TaskRegistry.COMPLETED_TTL_MS) continue;
      const t = entry.task;
      if (options.userId && t.userId !== options.userId) continue;
      if (options.characterId && t.characterId !== options.characterId) continue;
      if (options.type && t.type !== options.type) continue;
      if (options.sessionId && t.sessionId !== options.sessionId) continue;
      results.push(t);
    }

    results.sort(
      (a, b) => new Date(b.completedAt ?? b.startedAt).getTime() - new Date(a.completedAt ?? a.startedAt).getTime()
    );

    return options.limit ? results.slice(0, options.limit) : results;
  }

  subscribeForUser(
    userId: string,
    handlers: {
      onStarted?: (event: TaskEvent) => void;
      onProgress?: (event: TaskEvent) => void;
      onCompleted?: (event: TaskEvent) => void;
    }
  ): () => void {
    if (handlers.onStarted) {
      this.on(`task:started:${userId}`, handlers.onStarted);
    }
    if (handlers.onProgress) {
      this.on(`task:progress:${userId}`, handlers.onProgress);
    }
    if (handlers.onCompleted) {
      this.on(`task:completed:${userId}`, handlers.onCompleted);
    }

    return () => {
      if (handlers.onStarted) {
        this.off(`task:started:${userId}`, handlers.onStarted);
      }
      if (handlers.onProgress) {
        this.off(`task:progress:${userId}`, handlers.onProgress);
      }
      if (handlers.onCompleted) {
        this.off(`task:completed:${userId}`, handlers.onCompleted);
      }
    };
  }

  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleTasks();
    }, 5 * 60 * 1000);
  }

  private cleanupStaleTasks(): void {
    const staleRunIds: string[] = [];

    for (const [runId, task] of this.tasks) {
      if (isStale(task.lastActivityAt ?? task.startedAt, STALE_THRESHOLD_MS)) {
        staleRunIds.push(runId);
      }
    }

    for (const runId of staleRunIds) {
      this.updateStatus(runId, "stale", {
        error: "Task marked stale by cleanup",
      });
      this.cleanupStats.totalCleaned += 1;
      this.cleanupStats.cleanupsByReason.stale += 1;
    }

    // Prune expired recently-completed entries
    const now = Date.now();
    let expiredCount = 0;
    for (const [runId, entry] of this.recentlyCompleted) {
      if (now - entry.completedAt > TaskRegistry.COMPLETED_TTL_MS) {
        this.recentlyCompleted.delete(runId);
        expiredCount++;
      }
    }

    if (staleRunIds.length > 0 || expiredCount > 0) {
      this.cleanupStats.lastCleanupAt = nowISO();
      if (staleRunIds.length > 0) {
        console.log(
          `[TaskRegistry] Cleaned up ${staleRunIds.length} stale tasks ` +
          `(total: ${this.cleanupStats.totalCleaned})`
        );
      }
      if (expiredCount > 0) {
        console.log(`[TaskRegistry] Pruned ${expiredCount} expired recently-completed entries`);
      }
    }
  }

  getCleanupStats() {
    return { ...this.cleanupStats };
  }

  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.removeAllListeners();
    this.tasks.clear();
    this.recentlyCompleted.clear();
  }
}

export const taskRegistry = TaskRegistry.getInstance();
{ TaskRegistry };
