/**
 * Delegation Server-Side Auto-Resume
 *
 * When a subagent delegation completes while the initiator's run is no longer
 * active, the result lands in the delegation completion store and an SSE
 * signal is emitted so an attached frontend can auto-resume the conversation.
 *
 * That path is entirely client-dependent: if no browser tab is connected
 * (laptop asleep, connection dropped, user away), the completion sits in the
 * store until the user manually re-opens the chat. This module closes that
 * gap with a server-side fallback:
 *
 *   1. `scheduleDelegationAutoResume` is called for every completion that was
 *      stored (not delivered to a live run).
 *   2. After a grace period — giving an attached frontend priority so the
 *      user keeps the live-streaming UX — the fallback checks whether the
 *      completions are still pending and no run is active for the session.
 *   3. If so, it POSTs an internal /api/chat resume (mirroring the frontend's
 *      X-Delegation-Auto-Resume request) with the session's full DB history.
 *      Step 0 of that run drains the completion store and injects the
 *      delegation results, letting the initiator continue autonomously.
 */

import { INTERNAL_API_SECRET } from "@/lib/config/internal-api-secret";
import { getInternalApiBaseUrl } from "@/lib/utils/environment";
import {
  hasPendingDelegationCompletions,
  listSessionsWithPendingCompletions,
} from "@/lib/ai/tools/delegation-completion-store";
import { getLivePromptQueueKeyBySession } from "./live-prompt-queue-registry";
import { getMessages } from "@/lib/db/sqlite-queries";
import { convertDBMessagesToUIMessages } from "@/lib/messages/converter";

/** Grace period before the server fallback fires — an attached frontend
 * resumes via SSE within ~1s, so anything still pending after this window
 * means no client is listening. */
const AUTO_RESUME_GRACE_MS = 15_000;

/** When a run is active at fire time we re-check later instead of giving up —
 * the active run may have started before the completion was stored and will
 * not drain it mid-flight. Bounded so a pathological state cannot loop
 * forever; the user's next visit still delivers via the mount-time catch-up. */
const MAX_RESCHEDULES = 20;

/** Watchdog for the internal resume fetch + stream consumption. Long enough
 * for a legitimately long resumed run; short enough that a hung connection
 * cannot wedge the per-session `inFlight` guard forever. */
const RESUME_RUN_TIMEOUT_MS = 2 * 60 * 60 * 1000;

interface AutoResumeState {
  timers: Map<string, ReturnType<typeof setTimeout>>;
  inFlight: Set<string>;
  rescheduleCounts: Map<string, number>;
}

const globalForAutoResume = globalThis as typeof globalThis & {
  delegationAutoResumeState?: AutoResumeState;
};

function getState(): AutoResumeState {
  if (!globalForAutoResume.delegationAutoResumeState) {
    globalForAutoResume.delegationAutoResumeState = {
      timers: new Map(),
      inFlight: new Set(),
      rescheduleCounts: new Map(),
    };
  }
  return globalForAutoResume.delegationAutoResumeState;
}

/**
 * Schedule a server-side auto-resume check for the initiator session.
 * Idempotent per session — multiple completions coalesce into one check,
 * which drains all pending results in a single resumed run.
 */
export function scheduleDelegationAutoResume(
  initiatorSessionId: string,
  characterId: string,
  graceMs = AUTO_RESUME_GRACE_MS,
): void {
  const state = getState();
  if (state.timers.has(initiatorSessionId)) return;

  const timer = setTimeout(() => {
    state.timers.delete(initiatorSessionId);
    void runAutoResume(initiatorSessionId, characterId, graceMs);
  }, graceMs);
  // Do not hold the process open for a pending fallback check.
  timer.unref?.();
  state.timers.set(initiatorSessionId, timer);
}

/**
 * Startup recovery: re-schedule the auto-resume fallback for every session
 * whose persisted completion rows survived a server/app restart. Timers and
 * the in-memory store are process-local, so without this, completions that
 * arrived before a restart would sit in SQLite until the user manually
 * re-opened the chat. Called once from instrumentation after DB init.
 */
export function recoverPendingDelegationAutoResumes(): number {
  let recovered = 0;
  try {
    for (const { initiatorSessionId, characterId } of listSessionsWithPendingCompletions()) {
      scheduleDelegationAutoResume(initiatorSessionId, characterId);
      recovered += 1;
    }
    if (recovered > 0) {
      console.log(
        `[DelegationAutoResume] Recovery: scheduled auto-resume for ${recovered} session(s) with pending completions from a previous process`,
      );
    }
  } catch (error) {
    console.error("[DelegationAutoResume] Recovery scan failed:", error);
  }
  return recovered;
}

/** Test-only: clear all timers and in-flight tracking. */
export function clearDelegationAutoResumeState(): void {
  const state = getState();
  for (const timer of state.timers.values()) {
    clearTimeout(timer);
  }
  state.timers.clear();
  state.inFlight.clear();
  state.rescheduleCounts.clear();
}

function rescheduleWithBudget(
  initiatorSessionId: string,
  characterId: string,
  graceMs: number,
): void {
  const state = getState();
  const count = state.rescheduleCounts.get(initiatorSessionId) ?? 0;
  if (count >= MAX_RESCHEDULES) {
    console.warn(
      `[DelegationAutoResume] ${initiatorSessionId}: reschedule budget exhausted; ` +
      `pending completions will deliver on the next user visit.`,
    );
    state.rescheduleCounts.delete(initiatorSessionId);
    return;
  }
  state.rescheduleCounts.set(initiatorSessionId, count + 1);
  scheduleDelegationAutoResume(initiatorSessionId, characterId, graceMs);
}

async function runAutoResume(
  initiatorSessionId: string,
  characterId: string,
  graceMs: number,
): Promise<void> {
  const state = getState();

  // Nothing pending — an attached frontend (or a newly started run) already
  // drained the completion store. Done.
  if (!hasPendingDelegationCompletions(initiatorSessionId)) {
    state.rescheduleCounts.delete(initiatorSessionId);
    return;
  }

  // A run is currently active for this session (frontend resume in warmup,
  // user just sent a message, or a prior fallback is streaming). If it began
  // after the completion was stored, its step-0 drain will deliver; if it was
  // already mid-flight, re-check after it ends.
  if (getLivePromptQueueKeyBySession(initiatorSessionId)) {
    rescheduleWithBudget(initiatorSessionId, characterId, graceMs);
    return;
  }

  if (state.inFlight.has(initiatorSessionId)) return;
  state.inFlight.add(initiatorSessionId);

  try {
    console.log(
      `[DelegationAutoResume] ${initiatorSessionId}: no client attached — resuming server-side`,
    );

    const dbMessages = await getMessages(initiatorSessionId);
    const activeMessages = dbMessages.filter(
      (message) => !(message as { isCompacted?: boolean }).isCompacted,
    );
    if (activeMessages.length === 0) {
      console.warn(
        `[DelegationAutoResume] ${initiatorSessionId}: session has no messages; skipping resume`,
      );
      return;
    }

    const uiMessages = convertDBMessagesToUIMessages(
      activeMessages as Parameters<typeof convertDBMessagesToUIMessages>[0],
    );
    if (uiMessages.length === 0) {
      console.warn(
        `[DelegationAutoResume] ${initiatorSessionId}: no convertible messages; skipping resume`,
      );
      return;
    }

    // Watchdog: a hung internal fetch/stream would otherwise keep this
    // session in `inFlight` forever, blocking all future fallback attempts.
    // Generous budget — resumed agentic runs can legitimately stream for a
    // long time. On abort, the catch clears inFlight and the post-run
    // re-check reschedules if completions are still pending.
    const watchdog = AbortSignal.timeout(RESUME_RUN_TIMEOUT_MS);

    const response = await fetch(`${getInternalApiBaseUrl()}/api/chat`, {
      method: "POST",
      signal: watchdog,
      headers: {
        "Content-Type": "application/json",
        "X-Session-Id": initiatorSessionId,
        ...(characterId ? { "X-Character-Id": characterId } : {}),
        "X-Internal-Auth": INTERNAL_API_SECRET,
        "X-Delegation-Auto-Resume": "true",
        "X-Task-Source": "delegation-auto-resume",
      },
      body: JSON.stringify({
        messages: uiMessages,
        sessionId: initiatorSessionId,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "").then((t) => t.slice(0, 500));
      console.error(
        `[DelegationAutoResume] ${initiatorSessionId}: chat API returned ${response.status}: ${errorText}`,
      );
      return;
    }

    // Consume the stream to completion so the run finishes and persists.
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    console.log(`[DelegationAutoResume] ${initiatorSessionId}: server-side resume run completed`);
  } catch (error) {
    console.error(
      `[DelegationAutoResume] ${initiatorSessionId}: server-side resume failed:`,
      error,
    );
  } finally {
    state.inFlight.delete(initiatorSessionId);
  }

  // Completions that settled while the resume run was past step 0 (and whose
  // queue append raced the run teardown) may still be pending — re-check.
  if (hasPendingDelegationCompletions(initiatorSessionId)) {
    rescheduleWithBudget(initiatorSessionId, characterId, graceMs);
  } else {
    state.rescheduleCounts.delete(initiatorSessionId);
  }
}
