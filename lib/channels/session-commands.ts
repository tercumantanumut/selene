// fallow-ignore-file circular-dependency
/**
 * Channel-agnostic session management commands.
 *
 * Implements the logic behind /sessions, /switch, /delete, /current, /help
 * for external channels (Telegram first). Rendering is plain text so every
 * connector can display it; optional `commandButtons` are provided for
 * connectors with native button support (Telegram inline keyboards) and are
 * safely ignored elsewhere — the text always includes the equivalent typed
 * commands as a fallback.
 *
 * All operations are scoped to sessions that (a) belong to the Selene user
 * linked to the channel connection and (b) were created from the same
 * channel conversation identity (connectionId + peerId + threadId), reusing
 * the platform session lifecycle (soft-delete via status) rather than any
 * channel-specific session state.
 */
import {
  findChannelConversation,
  updateChannelConversation,
  getChannelConnection,
  getSession,
  updateSession,
  listChannelConversationSessions,
} from "@/lib/db/queries";
import { cleanupWorkspace } from "@/lib/workspace/cleanup";
import { getWorkspaceInfo } from "@/lib/workspace/types";
import type { Session, ChannelConversation } from "@/lib/db/sqlite-schema";
import type { ChannelInboundMessage } from "./types";
import { buildConversationKey } from "./utils";
import { taskRegistry } from "@/lib/background-tasks/registry";

export interface SessionCommandResponse {
  text: string;
  commandButtons?: Array<Array<{ label: string; command: string }>>;
}

/** Maximum sessions shown in a /sessions listing. */
const SESSION_LIST_LIMIT = 10;

/** How long a numbered /sessions listing stays valid for /switch N, /delete N. */
const SESSION_INDEX_TTL_MS = 15 * 60_000;

/** How long a /delete confirmation prompt stays valid. */
const DELETE_CONFIRM_TTL_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Numbered-index registry: maps the indexes shown by the latest /sessions
// listing in a conversation to session IDs, so `/switch 2` works. Ephemeral
// UI state only — session data itself always lives in the sessions table.
// ---------------------------------------------------------------------------

interface SessionIndexEntry {
  entries: Array<{ index: number; sessionId: string }>;
  createdAt: number;
}

/**
 * Pending delete confirmations, keyed by conversation. The confirmation is
 * bound to the exact session ID shown in the prompt, so a refreshed /sessions
 * listing (which renumbers indexes) can never redirect a confirm to a
 * different session.
 */
interface PendingDelete {
  sessionId: string;
  createdAt: number;
}

const globalForSessionIndex = globalThis as typeof globalThis & {
  __channelSessionIndexRegistry?: Map<string, SessionIndexEntry>;
  __channelPendingDeleteRegistry?: Map<string, PendingDelete>;
};

function getIndexRegistry(): Map<string, SessionIndexEntry> {
  if (!globalForSessionIndex.__channelSessionIndexRegistry) {
    globalForSessionIndex.__channelSessionIndexRegistry = new Map();
  }
  return globalForSessionIndex.__channelSessionIndexRegistry;
}

function getPendingDeleteRegistry(): Map<string, PendingDelete> {
  if (!globalForSessionIndex.__channelPendingDeleteRegistry) {
    globalForSessionIndex.__channelPendingDeleteRegistry = new Map();
  }
  return globalForSessionIndex.__channelPendingDeleteRegistry;
}

// ---------------------------------------------------------------------------
// Shared context resolution
// ---------------------------------------------------------------------------

interface CommandContext {
  userId: string;
  conversation: ChannelConversation | undefined;
  conversationKey: string;
}

async function resolveContext(message: ChannelInboundMessage): Promise<CommandContext | null> {
  const connection = await getChannelConnection(message.connectionId);
  if (!connection) return null;
  const conversation = await findChannelConversation({
    connectionId: message.connectionId,
    peerId: message.peerId,
    threadId: message.threadId,
  });
  return {
    userId: connection.userId,
    conversation,
    conversationKey: buildConversationKey({
      connectionId: message.connectionId,
      peerId: message.peerId,
      threadId: message.threadId,
    }),
  };
}

function sessionBelongsToConversation(session: Session, message: ChannelInboundMessage): boolean {
  const metadata = (session.metadata ?? {}) as Record<string, unknown>;
  return (
    metadata.channelConnectionId === message.connectionId &&
    metadata.channelPeerId === message.peerId &&
    // Normalize "" / undefined to null so an empty thread id can never be
    // confused with a distinct thread.
    (((metadata.channelThreadId as string | null | undefined) || null) === (message.threadId || null))
  );
}

/**
 * List active sessions owned by the linked user that were created from this
 * channel conversation identity, most recently updated first. Filtering is
 * done in SQL so sessions are found even for users with many active sessions.
 */
async function listConversationSessions(
  userId: string,
  message: ChannelInboundMessage,
  limit = SESSION_LIST_LIMIT,
): Promise<Session[]> {
  return listChannelConversationSessions({
    userId,
    connectionId: message.connectionId,
    peerId: message.peerId,
    threadId: message.threadId,
    limit,
  });
}

/**
 * Resolve a session reference from command args: a numbered index from the
 * latest /sessions listing, or a session ID prefix (min 6 chars).
 */
async function resolveSessionRef(
  ref: string,
  context: CommandContext,
  message: ChannelInboundMessage,
): Promise<{ session?: Session; error?: string }> {
  const registry = getIndexRegistry();

  // Numeric refs are tried as a numbered index from the latest /sessions
  // listing first. If that fails and the ref is long enough to be an ID
  // prefix (UUID prefixes can be all digits), fall through to prefix lookup.
  if (/^\d+$/.test(ref)) {
    const listing = registry.get(context.conversationKey);
    const listingValid = listing && Date.now() - listing.createdAt <= SESSION_INDEX_TTL_MS;
    const entry = listingValid ? listing.entries.find((e) => e.index === Number(ref)) : undefined;
    if (entry) {
      const session = await getSession(entry.sessionId);
      if (!session) return { error: "That session no longer exists." };
      if (session.userId !== context.userId || !sessionBelongsToConversation(session, message)) {
        return { error: "That session does not belong to this conversation." };
      }
      return { session };
    }
    if (ref.length < 6) {
      return listingValid
        ? { error: `No session #${ref} in the last /sessions listing.` }
        : { error: "The session list has expired. Run /sessions first, then use the listed numbers." };
    }
    // Long numeric ref: fall through to ID-prefix resolution below.
  }

  if (ref.length >= 6) {
    // Full session ID: resolve directly, then enforce ownership + scope.
    // This also finds sessions beyond the listing window.
    if (ref.length >= 32) {
      const session = await getSession(ref);
      if (session) {
        if (session.userId !== context.userId || !sessionBelongsToConversation(session, message)) {
          return { error: "That session does not belong to this conversation." };
        }
        return { session };
      }
    }
    const sessions = await listConversationSessions(context.userId, message, 50);
    const matches = sessions.filter((s) => s.id.startsWith(ref));
    if (matches.length === 1) return { session: matches[0] };
    if (matches.length > 1) return { error: `Session ID prefix "${ref}" is ambiguous.` };
    return { error: `No session found matching "${ref}". Run /sessions to see available sessions.` };
  }

  return { error: "Specify a session by number (from /sessions) or an ID prefix of at least 6 characters." };
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "unknown";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "unknown";
  const diffMs = Date.now() - then;
  if (diffMs < 60_000) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function sessionAgentName(session: Session): string {
  const metadata = (session.metadata ?? {}) as Record<string, unknown>;
  return typeof metadata.characterName === "string" && metadata.characterName
    ? metadata.characterName
    : "Agent";
}

function sessionLabel(session: Session): string {
  const title = (session.summary && session.summary.trim())
    ? session.summary.trim()
    : (session.title?.trim() || "Untitled session");
  return title.length > 60 ? `${title.slice(0, 57)}…` : title;
}

function sessionHasActiveRun(sessionId: string): boolean {
  return taskRegistry.list({ type: "chat", sessionId }).tasks.length > 0;
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

export async function handleSessionsListCommand(
  message: ChannelInboundMessage,
): Promise<SessionCommandResponse> {
  const context = await resolveContext(message);
  if (!context) return { text: "Channel connection not found." };

  const sessions = await listConversationSessions(context.userId, message);
  if (sessions.length === 0) {
    return { text: "No sessions found for this chat yet. Send a message or use /new to start one." };
  }

  const entries = sessions.map((session, i) => ({ index: i + 1, sessionId: session.id }));
  getIndexRegistry().set(context.conversationKey, { entries, createdAt: Date.now() });

  const currentSessionId = context.conversation?.sessionId;
  const lines = sessions.map((session, i) => {
    const markers = [
      session.id === currentSessionId ? "◀ current" : null,
      sessionHasActiveRun(session.id) ? "⏳ running" : null,
    ].filter(Boolean).join(", ");
    return [
      `${i + 1}. ${sessionLabel(session)}${markers ? ` (${markers})` : ""}`,
      `   ${sessionAgentName(session)} · ${session.messageCount ?? 0} msgs · ${formatRelativeTime(session.lastMessageAt ?? session.updatedAt)} · id ${session.id.slice(0, 8)}`,
    ].join("\n");
  });

  // Buttons carry the session ID prefix (stable across process restarts and
  // listing refreshes) rather than the mutable numbered index.
  const switchButtons = sessions
    .filter((session) => session.id !== currentSessionId)
    .slice(0, 5)
    .map((session) => {
      const index = entries.find((e) => e.sessionId === session.id)!.index;
      return [{
        label: `Switch to ${index}. ${sessionLabel(session).slice(0, 24)}`,
        command: `/switch ${session.id.slice(0, 8)}`,
      }];
    });

  return {
    text: [
      `📂 Sessions in this chat (${sessions.length}):`,
      "",
      lines.join("\n"),
      "",
      "Use /switch <n> to switch, /delete <n> to archive, /current for details.",
    ].join("\n"),
    commandButtons: switchButtons.length > 0 ? switchButtons : undefined,
  };
}

export async function handleSwitchCommand(
  message: ChannelInboundMessage,
  args: string,
): Promise<SessionCommandResponse> {
  const ref = args.trim();
  if (!ref) return { text: "Usage: /switch <n|session-id> — run /sessions to see available sessions." };

  const context = await resolveContext(message);
  if (!context) return { text: "Channel connection not found." };
  if (!context.conversation) {
    return { text: "No conversation is set up in this chat yet. Send a message first." };
  }

  const { session, error } = await resolveSessionRef(ref, context, message);
  if (!session) return { text: error ?? "Session not found." };

  if (session.status !== "active") {
    return { text: `Session "${sessionLabel(session)}" is ${session.status} and cannot be switched to.` };
  }
  if (session.id === context.conversation.sessionId) {
    return { text: `Already on "${sessionLabel(session)}".` };
  }

  await updateChannelConversation(context.conversation.id, { sessionId: session.id });

  // Ensure the session points back at this conversation so outbound delivery
  // (which resolves the conversation via session metadata) keeps working.
  const metadata = (session.metadata ?? {}) as Record<string, unknown>;
  if (metadata.channelConversationId !== context.conversation.id) {
    await updateSession(session.id, {
      metadata: { ...metadata, channelConversationId: context.conversation.id },
    });
  }

  return {
    text: [
      `✅ Switched to "${sessionLabel(session)}"`,
      `${sessionAgentName(session)} · ${session.messageCount ?? 0} msgs · id ${session.id.slice(0, 8)}`,
      "Your next message continues this session.",
    ].join("\n"),
  };
}

export async function handleDeleteCommand(
  message: ChannelInboundMessage,
  args: string,
): Promise<SessionCommandResponse> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const ref = parts[0] ?? "";
  const confirmed = parts[1]?.toLowerCase() === "confirm";

  if (!ref) return { text: "Usage: /delete <n|session-id|current> — run /sessions to see available sessions." };

  const context = await resolveContext(message);
  if (!context) return { text: "Channel connection not found." };

  let session: Session | undefined;
  if (ref.toLowerCase() === "current") {
    if (!context.conversation) return { text: "No active session in this chat." };
    const current = await getSession(context.conversation.sessionId);
    // Defense in depth: same ownership + conversation-scope checks as
    // numbered/prefix refs, so a stale conversation row can never expose an
    // unrelated owned session to deletion.
    if (
      !current ||
      current.userId !== context.userId ||
      current.status !== "active" ||
      !sessionBelongsToConversation(current, message)
    ) {
      return { text: "No active session in this chat." };
    }
    session = current;
  } else {
    const resolved = await resolveSessionRef(ref, context, message);
    if (!resolved.session) return { text: resolved.error ?? "Session not found." };
    session = resolved.session;
  }

  if (session.status === "deleted") {
    return { text: "That session is already deleted." };
  }

  if (sessionHasActiveRun(session.id)) {
    return { text: `Session "${sessionLabel(session)}" has a run in progress. Use /stop first, then delete it.` };
  }

  const isCurrent = session.id === context.conversation?.sessionId;
  const pendingRegistry = getPendingDeleteRegistry();

  if (confirmed) {
    // The confirmation must match the session that was shown in the prompt.
    // Indexes are mutable (a refreshed /sessions renumbers them), so the
    // pending-delete registry binds the confirm to an exact session ID.
    const pending = pendingRegistry.get(context.conversationKey);
    const pendingValid = pending && Date.now() - pending.createdAt <= DELETE_CONFIRM_TTL_MS;
    if (!pendingValid || pending.sessionId !== session.id) {
      pendingRegistry.delete(context.conversationKey);
      // Fall through to (re-)prompt instead of deleting.
    } else {
      pendingRegistry.delete(context.conversationKey);

      // Match the web app's DELETE /api/sessions/[id]: clean up any
      // tool-created workspace, then soft-delete. Never block deletion on
      // cleanup failure (boot-time orphan sweep is the safety net).
      try {
        const metadata = (session.metadata ?? {}) as Record<string, unknown>;
        const workspaceInfo = getWorkspaceInfo(metadata);
        if (workspaceInfo && workspaceInfo.type !== "local") {
          await cleanupWorkspace({
            syncFolderId: workspaceInfo.syncFolderId,
            worktreePath: workspaceInfo.worktreePath,
            trigger: "session-delete",
          });
        }
      } catch (cleanupErr) {
        console.warn("[SessionCommands] Workspace cleanup failed (continuing with delete):", cleanupErr);
      }

      await updateSession(session.id, { status: "deleted" });

      return {
        text: [
          `🗑 Deleted "${sessionLabel(session)}".`,
          isCurrent
            ? "That was the current session — your next message starts a fresh one, or use /switch to pick another."
            : undefined,
        ].filter(Boolean).join("\n"),
      };
    }
  }

  // Prompt for confirmation, binding it to this exact session ID. The confirm
  // command uses the ID prefix (not a mutable index) for the same reason.
  pendingRegistry.set(context.conversationKey, { sessionId: session.id, createdAt: Date.now() });
  const idRef = session.id.slice(0, 8);

  return {
    text: [
      `⚠️ Delete session "${sessionLabel(session)}"?`,
      `${sessionAgentName(session)} · ${session.messageCount ?? 0} msgs · id ${idRef}`,
      isCurrent ? "This is the current session — your next message will start a fresh one." : "",
      "",
      `Send "/delete ${idRef} confirm" to proceed, or /cancel to abort.`,
    ].filter(Boolean).join("\n"),
    commandButtons: [
      [
        { label: "🗑 Confirm delete", command: `/delete ${idRef} confirm` },
        { label: "Cancel", command: "/cancel" },
      ],
    ],
  };
}

export async function handleCurrentCommand(
  message: ChannelInboundMessage,
): Promise<SessionCommandResponse> {
  const context = await resolveContext(message);
  if (!context) return { text: "Channel connection not found." };
  if (!context.conversation) {
    return { text: "No active session in this chat. Send a message or use /new to start one." };
  }

  const session = await getSession(context.conversation.sessionId);
  if (!session || session.userId !== context.userId || session.status !== "active") {
    return { text: "No active session in this chat. Send a message or use /new to start one." };
  }

  return {
    text: [
      `📋 Current session`,
      `Title: ${sessionLabel(session)}`,
      `Agent: ${sessionAgentName(session)}`,
      `Messages: ${session.messageCount ?? 0}`,
      `Last activity: ${formatRelativeTime(session.lastMessageAt ?? session.updatedAt)}`,
      `Run: ${sessionHasActiveRun(session.id) ? "⏳ in progress" : "idle"}`,
      `ID: ${session.id.slice(0, 8)}`,
    ].join("\n"),
  };
}

export function handleHelpCommand(): SessionCommandResponse {
  return {
    text: [
      "📚 Available commands:",
      "/sessions — list recent sessions in this chat (/list works too)",
      "/switch <n> — switch to a listed session",
      "/current — show the active session",
      "/delete <n> — delete a session (asks for confirmation)",
      "/new — start a fresh session",
      "/status — channel, session & provider info",
      "/stop — stop the active run",
      "/tts on|off — toggle voice replies",
      "/compact — compact the session (coming soon)",
      "/help — show this message",
    ].join("\n"),
  };
}

export async function handleCancelCommand(
  message: ChannelInboundMessage,
): Promise<SessionCommandResponse> {
  const context = await resolveContext(message);
  if (context) getPendingDeleteRegistry().delete(context.conversationKey);
  return { text: "Cancelled." };
}
