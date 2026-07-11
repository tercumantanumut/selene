/**
 * Global registry for pending interactive tool questions.
 *
 * When the Claude Code SDK agent calls AskUserQuestion / AskFollowupQuestion,
 * a PreToolUse hook blocks execution and registers a pending wait here.
 * The client POSTs to /api/chat/tool-result with the user's answers,
 * which resolves the wait and unblocks the SDK agent.
 *
 * An EventEmitter (`interactiveBridgeEvents`) notifies subscribers (e.g.
 * channel integrations) when a question is pending or resolved so they can
 * render the question in Telegram / Slack / Discord / WhatsApp.
 */

import { EventEmitter } from "events";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InteractiveWaitSubmitted {
  kind: "submitted";
  answers: Record<string, string>;
}

interface InteractiveWaitInterrupted {
  kind: "interrupted";
  reason: "aborted" | "stale";
}

export type InteractiveWaitResult = InteractiveWaitSubmitted | InteractiveWaitInterrupted;

interface PendingInteractiveWait {
  resolve: (result: InteractiveWaitResult) => void;
  promise: Promise<InteractiveWaitResult>;
  questions: unknown;
  createdAt: number;
  abortCleanup?: () => void;
}

// ---------------------------------------------------------------------------
// Global state — survives Next.js HMR re-evaluations in dev mode.
// Without this, the streaming chat route and the tool-result route can
// end up with different module instances (different Maps), so the tool-result
// endpoint never finds the pending wait registered by the streaming route.
// Same pattern as lib/vectordb/file-watcher.ts (globalThis.fileWatchers).
// ---------------------------------------------------------------------------

const globalForBridge = globalThis as unknown as {
  interactiveBridgeEvents?: EventEmitter;
  interactivePendingWaits?: Map<string, PendingInteractiveWait>;
  interactiveUserAnswers?: Map<string, Record<string, string>>;
};

if (!globalForBridge.interactiveBridgeEvents) {
  globalForBridge.interactiveBridgeEvents = new EventEmitter();
}
if (!globalForBridge.interactivePendingWaits) {
  globalForBridge.interactivePendingWaits = new Map<string, PendingInteractiveWait>();
}
if (!globalForBridge.interactiveUserAnswers) {
  globalForBridge.interactiveUserAnswers = new Map<string, Record<string, string>>();
}

export const interactiveBridgeEvents = globalForBridge.interactiveBridgeEvents;
const pendingWaits = globalForBridge.interactivePendingWaits;

function makeKey(sessionId: string, toolUseId: string): string {
  return `${sessionId}__${toolUseId}`;
}

/**
 * Register a wait for user input. Returns a Promise that resolves when
 * `resolveInteractiveWait` is called with the same key.
 */
export function registerInteractiveWait(
  sessionId: string,
  toolUseId: string,
  questions: unknown,
  options?: { abortSignal?: AbortSignal },
): Promise<InteractiveWaitResult> {
  const key = makeKey(sessionId, toolUseId);

  // Duplicate registrations for the same tool call should share the same wait.
  // Resolving the previous waiter as an empty answer made ExitPlanMode look like
  // an explicit rejection, which caused the SDK to re-enter plan mode.
  const existing = pendingWaits.get(key);
  if (existing) {
    return existing.promise;
  }

  const abortSignal = options?.abortSignal;
  let settled = false;
  let abortCleanup: (() => void) | undefined;
  let resolvePromise!: (result: InteractiveWaitResult) => void;

  const promise = new Promise<InteractiveWaitResult>((resolve) => {
    resolvePromise = resolve;
  });

  const finish = (result: InteractiveWaitResult) => {
    if (settled) return;
    settled = true;
    pendingWaits.delete(key);
    abortCleanup?.();
    resolvePromise(result);
    interactiveBridgeEvents.emit("resolved", { sessionId, toolUseId });
  };

  if (abortSignal?.aborted) {
    finish({ kind: "interrupted", reason: "aborted" });
    return promise;
  }

  if (abortSignal) {
    const onAbort = () => {
      finish({ kind: "interrupted", reason: "aborted" });
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
    abortCleanup = () => abortSignal.removeEventListener("abort", onAbort);
  }

  pendingWaits.set(key, {
    resolve: finish,
    promise,
    questions,
    createdAt: Date.now(),
    abortCleanup,
  });
  interactiveBridgeEvents.emit("pending", { sessionId, toolUseId, questions });

  return promise;
}

/**
 * Resolve a pending wait with the user's answers. Returns true if a wait
 * was found and resolved, false if the key was unknown (already resolved
 * or timed out).
 */
export function resolveInteractiveWait(
  sessionId: string,
  toolUseId: string,
  answers: Record<string, string>,
): boolean {
  const key = makeKey(sessionId, toolUseId);
  const entry = pendingWaits.get(key);
  if (!entry) return false;
  entry.resolve({ kind: "submitted", answers });
  return true;
}

interface PendingInteractivePrompt {
  sessionId: string;
  toolUseId: string;
  questions: unknown;
  createdAt: number;
}

function getPendingInteractivePrompt(
  sessionId: string,
  toolUseId: string,
): unknown | undefined {
  const entry = pendingWaits.get(makeKey(sessionId, toolUseId));
  return entry?.questions;
}

export function getPendingInteractivePrompts(sessionId: string): PendingInteractivePrompt[] {
  const pending: PendingInteractivePrompt[] = [];
  const prefix = `${sessionId}__`;

  for (const [key, entry] of pendingWaits.entries()) {
    if (!key.startsWith(prefix)) continue;
    pending.push({
      sessionId,
      toolUseId: key.slice(prefix.length),
      questions: entry.questions,
      createdAt: entry.createdAt,
    });
  }

  return pending.sort((a, b) => a.createdAt - b.createdAt);
}

export function hasPendingInteractiveWait(sessionId: string): boolean {
  return getPendingInteractivePrompts(sessionId).length > 0;
}

// ---------------------------------------------------------------------------
// User answer store — keyed the same way
// After the PreToolUse hook resolves, we store the user's answers here so
// extractSdkToolResultsFromUserMessage can override the SDK's auto-answer.
// ---------------------------------------------------------------------------

const userAnswers = globalForBridge.interactiveUserAnswers;

export function storeUserAnswer(
  sessionId: string,
  toolUseId: string,
  answers: Record<string, string>,
): void {
  userAnswers.set(makeKey(sessionId, toolUseId), answers);
}

/**
 * Pop (retrieve and delete) the user's stored answer for a tool call.
 * Returns undefined if no user answer was stored.
 */
export function popUserAnswer(
  sessionId: string,
  toolUseId: string,
): Record<string, string> | undefined {
  const key = makeKey(sessionId, toolUseId);
  const answers = userAnswers.get(key);
  if (answers) userAnswers.delete(key);
  return answers;
}

// ---------------------------------------------------------------------------
// Optional cleanup
// ---------------------------------------------------------------------------

export function cleanupStaleEntries(maxAgeMs?: number): void {
  if (!Number.isFinite(maxAgeMs)) {
    return;
  }

  const thresholdMs = maxAgeMs as number;
  const now = Date.now();
  for (const [key, entry] of pendingWaits) {
    if (thresholdMs <= 0 || now - entry.createdAt > thresholdMs) {
      pendingWaits.delete(key);
      entry.resolve({ kind: "interrupted", reason: "stale" });
    }
  }
  for (const [key] of userAnswers) {
    // userAnswers don't have timestamps, but they should be consumed quickly.
    // We'll just let them accumulate — the Map stays small because popUserAnswer
    // deletes entries on retrieval.
  }
}
