// fallow-ignore-file circular-dependency
/**
 * Durable channel delivery outbox.
 *
 * Final assistant replies destined for an external channel (Telegram,
 * WhatsApp, Slack, Discord) are enqueued in the `channel_outbox` table and
 * then delivered by this worker. This decouples delivery from the chat
 * stream's `onFinish` lifetime: if the send fails or times out after a
 * long-running (30-40+ minute) agent execution, the reply is retried with
 * exponential backoff instead of being silently dropped.
 *
 * Delivery status is observable via the outbox row itself
 * (status/attempts/lastError/deliveredAt) and via `[ChannelOutbox]` logs.
 */
import {
  createChannelOutboxEntry,
  claimChannelOutboxEntry,
  finalizeChannelOutboxEntry,
  listDueChannelOutboxEntries,
  resetStaleChannelOutboxEntries,
  findOutboundChannelMessageByMessageId,
  getChannelConversation,
  getChannelConnection,
  getMessageById,
  getSession,
} from "@/lib/db/queries";
import type { ChannelOutboxEntry } from "@/lib/db/sqlite-schema";
import type { DBContentPart } from "@/lib/messages/converter";
import { deliverChannelReply } from "./delivery";
import { getChannelManager } from "./manager";

/** Per-attempt send timeout. A stale TCP connection to the Telegram API can
 * hang a send indefinitely after a long idle run; the race ensures the
 * attempt is recorded as failed and retried on a fresh attempt. */
const ATTEMPT_TIMEOUT_MS = 120_000;

const TIMEOUT_ERROR_MESSAGE = `Channel delivery timed out after ${ATTEMPT_TIMEOUT_MS}ms`;

/** Timeout for the best-effort delivery-failure notice. */
const FAILURE_NOTICE_TIMEOUT_MS = 15_000;

/** Backoff delays between attempts (attempt N failure → wait BACKOFF[N-1]). */
const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000];

/** Maximum delivery attempts before the entry is marked failed and the user
 * is notified that delivery did not succeed. */
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;

/** Sweep interval for retrying due entries. */
const SWEEP_INTERVAL_MS = 30_000;

/** 'delivering' entries not updated for this long are considered orphaned
 * (process crashed mid-send) and reset to 'pending' on the next sweep. */
const STALE_DELIVERING_MS = 10 * 60_000;

/**
 * Enqueue a channel reply for durable delivery and attempt it immediately.
 * No-op for non-channel sessions. Never throws.
 */
export async function deliverChannelReplyDurable(params: {
  sessionId: string;
  messageId: string;
  rawMode?: boolean;
}): Promise<void> {
  try {
    const session = await getSession(params.sessionId);
    const metadata = (session?.metadata ?? {}) as Record<string, unknown>;
    if (!metadata.channelConversationId) {
      return; // Not a channel session — nothing to deliver.
    }

    const entry = await createChannelOutboxEntry({
      sessionId: params.sessionId,
      messageId: params.messageId,
      rawMode: params.rawMode ?? false,
    });

    ensureOutboxWorkerStarted();
    await attemptDelivery(entry);
  } catch (error) {
    // High-severity: the reply is persisted in the session but has no outbox
    // row to retry from. Log identifiers so it can be recovered manually.
    console.error(
      `[ChannelOutbox] CRITICAL: failed to enqueue channel reply (session=${params.sessionId}, message=${params.messageId}) — reply will not be delivered to the channel:`,
      error,
    );
  }
}

/**
 * Attempt delivery of a single outbox entry. Marks the row delivered on
 * success; on failure schedules a retry with backoff or, once attempts are
 * exhausted, marks the row failed and notifies the peer. Never throws.
 */
async function attemptDelivery(entry: ChannelOutboxEntry): Promise<void> {
  const shortId = entry.id.slice(0, 8);
  const startedAt = Date.now();

  // Atomically claim the entry (status pending → delivering, attempts+1 in
  // SQL). If another worker (inline attempt vs sweep, or another process)
  // already claimed or delivered it, skip — this is what prevents duplicate
  // sends of the same message.
  let claimed: ChannelOutboxEntry | undefined;
  try {
    claimed = await claimChannelOutboxEntry(entry.id);
  } catch (error) {
    console.error(`[ChannelOutbox] ${shortId} claim failed:`, error);
    return;
  }
  if (!claimed) {
    return; // Already claimed/delivered elsewhere.
  }
  const attempt = claimed.attempts;

  try {
    // Dedup: a previous attempt may have actually landed (e.g. send timed out
    // locally but reached Telegram). The outbound channel_messages record is
    // only created after a confirmed send.
    const alreadySent = await findOutboundChannelMessageByMessageId(entry.messageId);
    if (alreadySent) {
      await finalizeChannelOutboxEntry(entry.id, attempt, {
        status: "delivered",
        deliveredAt: new Date().toISOString(),
      });
      console.log(`[ChannelOutbox] ${shortId} already delivered (dedup), marked delivered`);
      return;
    }

    const session = await getSession(entry.sessionId);
    if (!session) {
      throw new Error(`Session ${entry.sessionId} not found`);
    }
    // Sessions deleted/archived after the run started must not keep emitting
    // channel messages. Terminal state, no retries, no failure notice.
    if (session.status !== "active") {
      await finalizeChannelOutboxEntry(entry.id, attempt, {
        status: "failed",
        lastError: `Session is ${session.status}; delivery suppressed`,
      });
      console.log(`[ChannelOutbox] ${shortId} suppressed (session ${session.status})`);
      return;
    }
    const message = await getMessageById(entry.messageId);
    if (!message) {
      throw new Error(`Message ${entry.messageId} not found`);
    }

    console.log(`[ChannelOutbox] ${shortId} delivery attempt ${attempt}/${MAX_ATTEMPTS} (session ${entry.sessionId.slice(0, 8)})`);

    await withTimeout(
      deliverChannelReply({
        sessionId: entry.sessionId,
        messageId: entry.messageId,
        content: (message.content ?? []) as DBContentPart[],
        sessionMetadata: (session.metadata ?? {}) as Record<string, unknown>,
        rawMode: entry.rawMode,
      }),
      ATTEMPT_TIMEOUT_MS,
      TIMEOUT_ERROR_MESSAGE,
    );

    await finalizeChannelOutboxEntry(entry.id, attempt, {
      status: "delivered",
      deliveredAt: new Date().toISOString(),
      lastError: null,
    });
    console.log(`[ChannelOutbox] ${shortId} delivered on attempt ${attempt} in ${Date.now() - startedAt}ms`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[ChannelOutbox] ${shortId} attempt ${attempt}/${MAX_ATTEMPTS} failed after ${Date.now() - startedAt}ms:`, errorMessage);

    if (attempt >= MAX_ATTEMPTS) {
      await finalizeChannelOutboxEntry(entry.id, attempt, {
        status: "failed",
        lastError: errorMessage,
      }).catch((err) => console.error("[ChannelOutbox] Failed to mark entry failed:", err));
      // Fire-and-forget with its own timeout: the notice must never block
      // the sweep loop on the same stale connection that broke delivery.
      void withTimeout(
        notifyDeliveryFailure(entry, errorMessage),
        FAILURE_NOTICE_TIMEOUT_MS,
        "Failure notice timed out",
      ).catch((err) => console.error("[ChannelOutbox] Failure notice not sent:", err));
      return;
    }

    // The timeout race cannot cancel the in-flight send: a timed-out attempt
    // may still land late and record its channel_messages row. Give it extra
    // time before retrying so the next attempt's dedup check can see it —
    // delivery is at-least-once, this narrows the duplicate window.
    const baseDelay = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
    const delayMs = errorMessage === TIMEOUT_ERROR_MESSAGE ? Math.max(baseDelay, 60_000) : baseDelay;
    await finalizeChannelOutboxEntry(entry.id, attempt, {
      status: "pending",
      lastError: errorMessage,
      nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
    }).catch((err) => console.error("[ChannelOutbox] Failed to schedule retry:", err));
    console.log(`[ChannelOutbox] ${shortId} retry scheduled in ${Math.round(delayMs / 1000)}s`);
  }
}

/**
 * Best-effort notice to the peer that the reply could not be delivered.
 * The response itself remains persisted in the session.
 */
async function notifyDeliveryFailure(entry: ChannelOutboxEntry, errorMessage: string): Promise<void> {
  try {
    const session = await getSession(entry.sessionId);
    const metadata = (session?.metadata ?? {}) as Record<string, unknown>;
    const conversationId = metadata.channelConversationId as string | undefined;
    if (!conversationId) return;
    const conversation = await getChannelConversation(conversationId);
    if (!conversation) return;
    const connection = await getChannelConnection(conversation.connectionId);
    if (!connection) return;

    await getChannelManager().sendMessage(connection.id, {
      peerId: conversation.peerId,
      threadId: conversation.threadId,
      text: `⚠️ I finished your request, but delivering the full response failed after ${MAX_ATTEMPTS} attempts (${errorMessage}). The response is saved in the session — open the web app to read it, or send any message here to continue.`,
    });
  } catch (error) {
    console.error("[ChannelOutbox] Failed to send delivery-failure notice:", error);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Background worker — retries due entries and recovers orphaned ones.
// Guarded on globalThis so HMR / repeated imports don't stack intervals.
// ---------------------------------------------------------------------------

const globalForOutbox = globalThis as typeof globalThis & {
  __channelOutboxWorkerStarted?: boolean;
  __channelOutboxSweepInFlight?: boolean;
};

export function ensureOutboxWorkerStarted(): void {
  if (globalForOutbox.__channelOutboxWorkerStarted) return;
  globalForOutbox.__channelOutboxWorkerStarted = true;

  // Recover entries orphaned by a previous process (crash mid-send or
  // restart between enqueue and delivery).
  void sweepOutbox();

  const timer = setInterval(() => {
    void sweepOutbox();
  }, SWEEP_INTERVAL_MS);
  // Don't keep the process alive just for the sweeper.
  timer.unref?.();
}

async function sweepOutbox(): Promise<void> {
  if (globalForOutbox.__channelOutboxSweepInFlight) return;
  globalForOutbox.__channelOutboxSweepInFlight = true;
  try {
    const staleBefore = new Date(Date.now() - STALE_DELIVERING_MS).toISOString();
    const reset = await resetStaleChannelOutboxEntries(staleBefore);
    if (reset > 0) {
      console.warn(`[ChannelOutbox] Reset ${reset} orphaned 'delivering' entr${reset === 1 ? "y" : "ies"} to pending`);
    }

    const due = await listDueChannelOutboxEntries();
    for (const entry of due) {
      await attemptDelivery(entry);
    }
  } catch (error) {
    console.error("[ChannelOutbox] Sweep failed:", error);
  } finally {
    globalForOutbox.__channelOutboxSweepInFlight = false;
  }
}
