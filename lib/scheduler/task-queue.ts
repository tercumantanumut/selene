/**
 * Task Queue
 *
 * Priority-based task queue with retry logic and exponential backoff.
 * Executes scheduled tasks by calling the chat API internally.
 * Integrates context sources and delivery handlers.
 */

import { db } from "@/lib/db/sqlite-client";
import { scheduledTaskRuns, scheduledTasks } from "@/lib/db/sqlite-schedule-schema";
import { messages } from "@/lib/db/sqlite-schema";
import { skills } from "@/lib/db/sqlite-skills-schema";
import { and, eq, sql } from "drizzle-orm";
import type { ContextSource, DeliveryMethod, DeliveryConfig } from "@/lib/db/sqlite-schedule-schema";
import { getContextSourceManager } from "./context-sources";
import { getDeliveryRouter } from "./delivery";
import { taskRegistry } from "@/lib/background-tasks/registry";
import type { BackgroundTask } from "@/lib/background-tasks/types";
import { nowISO } from "@/lib/utils/timestamp";
import { getInternalApiBaseUrl } from "@/lib/utils/environment";
import { nextOrderingIndex } from "@/lib/session/message-ordering";
import { INTERNAL_API_SECRET } from "@/lib/config/internal-api-secret";

export interface QueuedTask {
  runId: string;
  taskId: string;
  taskName: string;
  characterId: string;
  userId: string;
  prompt: string;
  contextSources: ContextSource[];
  timeoutMs: number;
  maxRetries: number;
  priority: "high" | "normal" | "low";
  createNewSession: boolean;
  existingSessionId?: string;
  attemptNumber?: number;
}

interface TaskQueueConfig {
  maxConcurrent?: number;
  retryDelayMs?: number;
}

export class TaskQueue {
  private queue: QueuedTask[] = [];
  private processing: Map<string, QueuedTask> = new Map();
  private abortControllers: Map<string, AbortController> = new Map();
  private config: Required<TaskQueueConfig>;
  private isRunning = false;
  private processInterval: NodeJS.Timeout | null = null;

  constructor(config: TaskQueueConfig = {}) {
    this.config = {
      maxConcurrent: config.maxConcurrent ?? 1, // Default to 1 for sequential execution
      retryDelayMs: config.retryDelayMs ?? 5000,
    };
  }

  /**
   * Get the correct base URL for the chat API
   * Handles both development and production Electron environments
   *
   * Port mapping:
   * - Development: port 3000 (Next.js dev server)
   * - Electron Production: port 3456 (standalone server)
   */
  private getChatApiBaseUrl(): string {
    const baseUrl = getInternalApiBaseUrl();
    console.log(`[TaskQueue] Chat API base URL: ${baseUrl}`);

    return baseUrl;
  }

  /**
   * Cancel a running or queued task
   */
  async cancel(runId: string): Promise<boolean> {
    // Check if queued (not yet started)
    const queueIndex = this.queue.findIndex((t) => t.runId === runId);
    if (queueIndex !== -1) {
      this.queue.splice(queueIndex, 1);
      await this.updateRunStatus(runId, "cancelled");
      taskRegistry.updateStatus(runId, "cancelled");
      console.log(`[TaskQueue] Cancelled queued task ${runId}`);
      return true;
    }

    // Check if running
    const controller = this.abortControllers.get(runId);
    if (controller) {
      controller.abort();
      await this.updateRunStatus(runId, "cancelled");
      taskRegistry.updateStatus(runId, "cancelled");
      console.log(`[TaskQueue] Cancelled running task ${runId}`);
      return true;
    }

    return false;
  }

  /**
   * Add task to queue
   */
  enqueue(task: QueuedTask): void {
    // Insert based on priority
    const priorityOrder = { high: 0, normal: 1, low: 2 };
    const insertIndex = this.queue.findIndex(
      (t) => priorityOrder[t.priority] > priorityOrder[task.priority]
    );
    
    if (insertIndex === -1) {
      this.queue.push(task);
    } else {
      this.queue.splice(insertIndex, 0, task);
    }

    // Update run status
    void this.updateRunStatus(task.runId, "queued");
    
    console.log(`[TaskQueue] Enqueued task ${task.runId} (priority: ${task.priority}, queue size: ${this.queue.length})`);
  }

  /**
   * Start processing queue
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Process queue every second
    this.processInterval = setInterval(() => this.processQueue(), 1000);
    console.log(`[TaskQueue] Started processing (maxConcurrent: ${this.config.maxConcurrent})`);
  }

  /**
   * Stop processing queue
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    
    if (this.processInterval) {
      clearInterval(this.processInterval);
      this.processInterval = null;
    }

    // Wait for in-flight tasks to complete
    while (this.processing.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    console.log("[TaskQueue] Stopped processing");
  }

  /**
   * Get current queue size
   */
  getQueueSize(): number {
    return this.queue.length;
  }

  /**
   * Process next tasks in queue
   */
  private async processQueue(): Promise<void> {
    if (!this.isRunning) return;

    // Check if we can process more tasks
    while (
      this.queue.length > 0 && 
      this.processing.size < this.config.maxConcurrent
    ) {
      const task = this.queue.shift();
      if (!task) break;

      this.processing.set(task.runId, task);
      this.executeTask(task).catch(console.error);
    }
  }

  /**
   * Execute a single task via the chat API
   */
  private async executeTask(task: QueuedTask): Promise<void> {
    const startTime = Date.now();
    const startedAt = nowISO();

    // Create abort controller for this task
    const controller = new AbortController();
    this.abortControllers.set(task.runId, controller);

    // Track sessionId for cancellation handling
    let sessionId: string | undefined;

    try {
      await this.updateRunStatus(task.runId, "running", { startedAt });

      const unifiedTask: BackgroundTask = {
        type: "scheduled",
        runId: task.runId,
        taskId: task.taskId,
        taskName: task.taskName,
        userId: task.userId,
        characterId: task.characterId,
        status: "running",
        startedAt,
        prompt: task.prompt,
        priority: task.priority,
        attemptNumber: task.attemptNumber ?? 1,
        maxRetries: task.maxRetries,
      };

      const existing = taskRegistry.get(task.runId);
      if (existing) {
        taskRegistry.updateStatus(task.runId, "running", unifiedTask);
      } else {
        taskRegistry.register(unifiedTask);
      }

      console.log(`[TaskQueue] Executing task ${task.runId}`);

      // Resolve context sources if any
      let resolvedPrompt = task.prompt;
      if (task.contextSources && task.contextSources.length > 0) {
        const contextManager = getContextSourceManager();
        const context = await contextManager.resolveContextSources(
          task.contextSources,
          task.userId
        );
        resolvedPrompt = contextManager.applyContext(task.prompt, context);
        console.log(`[TaskQueue] Applied ${task.contextSources.length} context source(s)`);
      }

      // Step 1: Prepare session FIRST (before chat execution)
      sessionId = await this.prepareSession({ ...task, prompt: resolvedPrompt });

      // Step 2: Update run status with sessionId so it's visible in UI
      await this.updateRunStatus(task.runId, "running", { sessionId });
      taskRegistry.updateStatus(task.runId, "running", { sessionId });
      taskRegistry.emitProgress(task.runId, "Session ready", undefined, {
        type: "scheduled",
        taskId: task.taskId,
        taskName: task.taskName,
        userId: task.userId,
        characterId: task.characterId,
        sessionId,
        startedAt,
      });

      // Step 3: Execute the chat (this is the long-running part)
      const result = await this.executeChatAPI(
        { ...task, prompt: resolvedPrompt },
        sessionId,
        controller.signal
      );

      // Check if aborted
      if (controller.signal.aborted) {
        console.log(`[TaskQueue] Task ${task.runId} was cancelled`);
        taskRegistry.updateStatus(task.runId, "cancelled", {
          sessionId,
          durationMs: Date.now() - startTime,
        });
        return;
      }

      // Success
      const durationMs = Date.now() - startTime;
      const completedAt = nowISO();
      await this.updateRunStatus(task.runId, "succeeded", {
        completedAt,
        durationMs,
        resultSummary: result.summary,
        sessionId,
        agentRunId: result.agentRunId,
      });

      console.log(`[TaskQueue] Task ${task.runId} completed in ${durationMs}ms`);

      taskRegistry.updateStatus(task.runId, "succeeded", {
        sessionId,
        durationMs,
        metadata: {
          resultSummary: result.summary,
          agentRunId: result.agentRunId,
        },
      });

      // Deliver results
      await this.deliverResults(task.taskId, task.runId, {
        status: "succeeded",
        summary: result.summary,
        fullText: result.fullText,
        sessionId,
        durationMs,
      });

      // Update linked skill stats for successful scheduler runs.
      await this.updateLinkedSkillStats(task.taskId, task.userId, true);

    } catch (error) {
      if ((error as Error).name === "AbortError" || controller.signal.aborted) {
        console.log(`[TaskQueue] Task ${task.runId} was cancelled`);
        taskRegistry.updateStatus(task.runId, "cancelled", {
          sessionId,
          durationMs: Date.now() - startTime,
        });
        return;
      }
      await this.handleTaskError(task, error, startTime, startedAt, sessionId);
    } finally {
      this.abortControllers.delete(task.runId);
      this.processing.delete(task.runId);
    }
  }

  /**
   * Handle task execution error with retry logic
   */
  private async handleTaskError(
    task: QueuedTask,
    error: unknown,
    startTime: number,
    startedAt: string,
    sessionId?: string
  ): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    const attemptNumber = task.attemptNumber ?? 1;

    // Capture detailed error information for debugging
    const errorType = error instanceof Error ? error.name : "UnknownError";
    const endpoint = `${this.getChatApiBaseUrl()}/api/chat`;

    // Enhanced error logging with context
    if (error instanceof Error && error.message.includes("ECONNREFUSED")) {
      console.error(
        `[TaskQueue] Connection refused for task ${task.runId} (attempt ${attemptNumber}/${task.maxRetries}):`,
        `\n  Task: ${task.taskName}`,
        `\n  URL: ${endpoint}`,
        `\n  Error: ${error.message}`,
        `\n  Environment: NODE_ENV=${process.env.NODE_ENV}, SELENE_PRODUCTION_BUILD=${process.env.SELENE_PRODUCTION_BUILD}`
      );
    } else if (error instanceof Error && error.message.includes("ENOTFOUND")) {
      console.error(
        `[TaskQueue] DNS resolution failed for task ${task.runId}:`,
        `\n  URL: ${endpoint}`,
        `\n  Error: ${error.message}`
      );
    } else {
      console.error(
        `[TaskQueue] Task ${task.runId} failed (attempt ${attemptNumber}/${task.maxRetries}):`,
        `\n  Error type: ${errorType}`,
        `\n  Message: ${errorMessage}`,
        `\n  Endpoint: ${endpoint}`
      );
    }

    if (attemptNumber < task.maxRetries) {
      // Retry with exponential backoff
      const retryDelay = this.config.retryDelayMs * Math.pow(2, attemptNumber - 1);
      console.log(`[TaskQueue] Task ${task.runId} will retry in ${retryDelay}ms (attempt ${attemptNumber + 1}/${task.maxRetries})`);

      await this.updateRunStatus(task.runId, "pending", {
        error: errorMessage,
        attemptNumber: attemptNumber + 1,
      });
      taskRegistry.updateStatus(task.runId, "queued", {
        error: errorMessage,
        attemptNumber: attemptNumber + 1,
      });

      setTimeout(() => {
        this.enqueue({ ...task, attemptNumber: attemptNumber + 1 });
      }, retryDelay);

    } else {
      // Final failure
      const durationMs = Date.now() - startTime;
      const completedAt = nowISO();
      await this.updateRunStatus(task.runId, "failed", {
        completedAt,
        durationMs,
        error: errorMessage,
      });

      console.error(`[TaskQueue] Task ${task.runId} failed permanently: ${errorMessage}`);

      taskRegistry.updateStatus(task.runId, "failed", {
        sessionId,
        durationMs,
        error: errorMessage,
      });

      // Deliver failure notification
      await this.deliverResults(task.taskId, task.runId, {
        status: "failed",
        error: errorMessage,
        durationMs,
      });

      await this.updateLinkedSkillStats(task.taskId, task.userId, false);
    }
  }

  /**
   * Deliver task results via configured delivery method
   */
  private async deliverResults(
    taskId: string,
    runId: string,
    result: {
      status: "succeeded" | "failed";
      summary?: string;
      fullText?: string;
      sessionId?: string;
      error?: string;
      durationMs?: number;
    }
  ): Promise<void> {
    try {
      // Get task config for delivery settings
      const task = await db.query.scheduledTasks.findFirst({
        where: eq(scheduledTasks.id, taskId),
      });

      if (!task) return;

      const deliveryMethod = (task.deliveryMethod || "session") as DeliveryMethod;
      const deliveryConfig = (task.deliveryConfig || {}) as DeliveryConfig;

      // Skip if no external delivery
      if (deliveryMethod === "session") return;

      const baseUrl = this.getChatApiBaseUrl();
      const deliveryRouter = getDeliveryRouter();

      await deliveryRouter.deliver(deliveryMethod, deliveryConfig, {
        taskId,
        taskName: task.name,
        runId,
        status: result.status,
        summary: result.fullText ?? result.summary,
        sessionId: result.sessionId,
        sessionUrl: result.sessionId
          ? `${baseUrl}/chat/${task.characterId}?sessionId=${result.sessionId}`
          : undefined,
        error: result.error,
        durationMs: result.durationMs,
        metadata: {},
      });
    } catch (error) {
      console.error(`[TaskQueue] Delivery failed for task ${taskId}:`, error);
      // Don't fail the task if delivery fails
    }
  }

  /**
   * Prepare a session for task execution
   * Creates or retrieves the session and adds the user message
   * This is separated from chat execution so we can emit "started" event early
   */
  private async prepareSession(task: QueuedTask): Promise<string> {
    // Import dynamically to avoid circular dependencies
    const { createSession, createMessage } = await import("@/lib/db/queries");
    const { getCharacterFull } = await import("@/lib/characters/queries");

    // Get or create session
    let sessionId: string;
    if (task.existingSessionId && !task.createNewSession) {
      sessionId = task.existingSessionId;
    } else {
      const character = await getCharacterFull(task.characterId);

      // Best-effort: propagate channel delivery metadata into the scheduled run session
      // so the LLM can format outputs correctly for Telegram/Slack/WhatsApp.
      let channelType: string | undefined;
      try {
        const scheduledTask = await db.query.scheduledTasks.findFirst({
          where: eq(scheduledTasks.id, task.taskId),
        });
        const deliveryConfig = (scheduledTask?.deliveryConfig || {}) as Record<string, unknown>;
        channelType = typeof deliveryConfig.channelType === "string" ? deliveryConfig.channelType : undefined;
      } catch {
        // Ignore lookup failures; session will still run.
      }

      const session = await createSession({
        title: `Scheduled: ${character?.name || "Agent"} - ${new Date().toLocaleDateString()}`,
        userId: task.userId,
        metadata: {
          characterId: task.characterId,
          scheduledTaskId: task.taskId,
          scheduledRunId: task.runId,
          isScheduledRun: true,
          ...(channelType ? { channelType } : {}),
        },
      });
      sessionId = session.id;
    }

    const existingPrompt = await db.query.messages.findFirst({
      where: and(
        eq(messages.sessionId, sessionId),
        eq(messages.role, "user"),
        sql`json_extract(${messages.metadata}, '$.scheduledRunId') = ${task.runId}`
      ),
    });

    if (!existingPrompt) {
      await createMessage({
        sessionId,
        role: "user",
        content: [{ type: "text", text: task.prompt }],
        metadata: {
          isScheduledPrompt: true,
          scheduledTaskId: task.taskId,
          scheduledRunId: task.runId,
        },
        orderingIndex: await nextOrderingIndex(sessionId),
      });
    }

    return sessionId;
  }

  /**
   * Execute the chat API call for a prepared session
   * This is the long-running part that actually runs the agent
   */
  private async executeChatAPI(
    task: QueuedTask,
    sessionId: string,
    signal?: AbortSignal
  ): Promise<{
    agentRunId?: string;
    summary?: string;
    fullText?: string;
  }> {
    const { getSession } = await import("@/lib/db/queries");

    // Make internal API call to chat endpoint
    // This triggers the full agent execution with all tools
    const baseUrl = this.getChatApiBaseUrl();

    // Combine timeout and cancellation signals
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), task.timeoutMs);

    // Use provided signal or timeout
    const effectiveSignal = signal || timeoutController.signal;

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Id": sessionId,
        "X-Character-Id": task.characterId,
        "X-Scheduled-Run": "true",
        "X-Scheduled-Run-Id": task.runId,
        "X-Scheduled-Task-Id": task.taskId,
        "X-Scheduled-Task-Name": task.taskName,
        // Internal auth bypass for scheduled tasks
        "X-Internal-Auth": INTERNAL_API_SECRET,
      },
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content: task.prompt,
          },
        ],
        sessionId,
      }),
      signal: effectiveSignal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Chat API returned ${response.status}: ${await response.text()}`);
    }

    // Consume the streaming response (we don't need to parse it, just wait for completion)
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    // Get the session to extract the agent run ID and summary
    const updatedSession = await getSession(sessionId);
    const agentRunId = (updatedSession?.metadata as Record<string, unknown>)?.lastAgentRunId as string | undefined;

    // Extract summary from last assistant message
    const { getMessages } = await import("@/lib/db/queries");
    const messages = await getMessages(sessionId);
    const lastAssistantMessage = messages.filter(m => m.role === "assistant").pop();
    let summary: string | undefined;
    let fullText: string | undefined;

    if (lastAssistantMessage?.content) {
      const content = lastAssistantMessage.content as Array<{ type: string; text?: string }>;
      const textParts = content.filter(p => p.type === "text" && p.text);
      fullText = textParts.map(p => p.text).join("\n");
      summary = fullText.slice(0, 500);
    }

    return {
      agentRunId,
      summary,
      fullText,
    };
  }

  private async updateLinkedSkillStats(taskId: string, userId: string, succeeded: boolean): Promise<void> {
    const task = await db.query.scheduledTasks.findFirst({
      where: eq(scheduledTasks.id, taskId),
    });

    if (!task?.skillId) {
      return;
    }

    await db
      .update(skills)
      .set({
        runCount: sql`${skills.runCount} + 1`,
        successCount: succeeded ? sql`${skills.successCount} + 1` : sql`${skills.successCount}`,
        lastRunAt: nowISO(),
        updatedAt: nowISO(),
      })
      .where(and(eq(skills.id, task.skillId), eq(skills.userId, userId)));
  }

  private async updateRunStatus(
    runId: string,
    status: "pending" | "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timeout",
    data: Record<string, unknown> = {}
  ): Promise<void> {
    await db.update(scheduledTaskRuns)
      .set({ status, ...data })
      .where(eq(scheduledTaskRuns.id, runId));
  }
}
