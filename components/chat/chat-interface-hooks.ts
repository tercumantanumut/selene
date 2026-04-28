"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { resilientFetch, resilientPost, resilientPatch, resilientDelete } from "@/lib/utils/resilient-fetch";
import {
    convertDBMessagesToUIMessages,
    countVisibleConversationMessages,
    hasLivePromptInjectedMessages,
} from "@/lib/messages/converter";
import { useUnifiedTasksStore } from "@/lib/stores/unified-tasks-store";
import type { TaskEvent } from "@/lib/background-tasks/types";
import { useSessionSync } from "@/lib/hooks/use-session-sync";
import { useSessionSyncNotifier } from "@/lib/hooks/use-session-sync";
import {
    useSessionSyncStore,
    sessionInfoArrayToSyncData,
    type SessionActivityIndicator,
    type SessionActivityState,
} from "@/lib/stores/session-sync-store";
import type { SessionInfo } from "@/components/chat/chat-sidebar/types";

function isCompletionActivityState(activity: SessionActivityState | undefined, runId?: string | null): boolean {
    if (!activity || activity.isRunning) {
        return false;
    }

    if (runId && activity.runId && activity.runId !== runId) {
        return false;
    }

    return activity.indicators.some((indicator: SessionActivityIndicator) => indicator.key === "completed");
}
import type { UIMessage } from "ai";
import type { SessionState, ChannelFilter, DateRangeFilter } from "@/components/chat/chat-interface-types";
import type { DBMessage } from "@/lib/messages/converter";
import {
    sortSessionsByUpdatedAt,
    areSessionsEquivalent,
    getSessionSignature,
    getMessagesSignature,
    shouldDeferLivePromptForegroundReconciliation,
} from "@/components/chat/chat-interface-utils";

// ---------------------------------------------------------------------------
// useBackgroundProcessing
// Manages background run polling, zombie detection, and message refresh.
// ---------------------------------------------------------------------------

interface UseBackgroundProcessingOptions {
    sessionId: string;
    notifySessionUpdate: (id: string, data: Record<string, unknown>) => void;
    setSessionState: React.Dispatch<React.SetStateAction<SessionState>>;
    chatSetMessagesRef: React.MutableRefObject<((msgs: UIMessage[]) => void) | null>;
    liveThreadMessagesRef: React.MutableRefObject<UIMessage[]>;
    activeSessionIdRef: React.MutableRefObject<string>;
    shouldSkipBackgroundRefresh?: () => boolean;
}

export function shouldReloadSessionFromTaskProgress(input: {
    detail: TaskEvent | null | undefined;
    sessionId: string;
    isChannelSession: boolean;
    isProcessingInBackground: boolean;
}): boolean {
    const { detail, sessionId, isChannelSession, isProcessingInBackground } = input;
    if (!detail || detail.eventType !== "task:progress" || detail.sessionId !== sessionId) {
        return false;
    }

    if (isChannelSession || isProcessingInBackground) {
        return true;
    }

    if (detail.type !== "chat") {
        return false;
    }

    const progressContent = Array.isArray(detail.progressContent) ? detail.progressContent : [];
    return progressContent.some((part) => {
        if (!part || typeof part !== "object") return false;
        return (part as { toolName?: unknown }).toolName === "delegateToSubagent";
    });
}

export function useBackgroundProcessing({
    sessionId,
    notifySessionUpdate,
    setSessionState,
    chatSetMessagesRef,
    liveThreadMessagesRef,
    activeSessionIdRef,
    shouldSkipBackgroundRefresh,
}: UseBackgroundProcessingOptions) {
    const t = useTranslations("chat");
    const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
    const [isProcessingInBackground, setIsProcessingInBackground] = useState(false);
    const [processingRunId, setProcessingRunId] = useState<string | null>(null);
    const [isZombieRun, setIsZombieRun] = useState(false);
    const [isCancellingBackgroundRun, setIsCancellingBackgroundRun] = useState(false);
    const lastMessageSigRef = useRef<string>("");
    const isRunActiveRef = useRef(false);
    const activePollingRunIdRef = useRef<string | null>(null);
    const removeTask = useUnifiedTasksStore((state) => state.removeTask);

    type ClearTrackedRunStateOptions = {
        runId?: string | null;
        refreshMessages?: boolean;
        clearTaskState?: boolean;
    };

    const refreshMessages = useCallback(async () => {
        if (shouldSkipBackgroundRefresh?.()) {
            return;
        }

        const { data, error, status } = await resilientFetch<{ messages: DBMessage[] }>(
            `/api/sessions/${sessionId}/messages`,
            { retries: 0 }
        );
        if (error || !data) {
            console.error("[Background Processing] Failed to fetch messages:", status, error);
            return;
        }

        if (activeSessionIdRef.current !== sessionId) {
            return;
        }

        // Skip update if messages haven't changed (avoids unnecessary re-render).
        // DB messages use `content` (JSON array of parts), not `parts`.
        // The signature must capture content mutations so incremental background
        // streaming updates (tool results filling in, text appending) are detected.
        const sig = data.messages
            .map((m: any) => {
                const parts = m.content ?? m.parts ?? [];
                const lastPart = Array.isArray(parts) ? parts.at(-1) : null;
                const partCount = Array.isArray(parts) ? parts.length : 0;
                // Content fingerprint: length of text/output to detect in-place mutations
                const contentHint = lastPart
                    ? String(lastPart.text?.length ?? lastPart.output?.length ?? lastPart.argsText?.length ?? lastPart.state ?? "")
                    : "";
                return `${m.id}:${partCount}:${lastPart?.type ?? ""}:${contentHint}`;
            })
            .join("|");
        if (sig === lastMessageSigRef.current) return;

        const conversationalMessageCount = countVisibleConversationMessages(data.messages);

        // Defer reconciliation only while persisted history is not yet ahead of the
        // live thread. Once the DB contains an extra visible turn, apply it so the
        // UI cannot snap back to the pre-injection state after completion.
        if (
            isRunActiveRef.current &&
            shouldDeferLivePromptForegroundReconciliation({
                hasInjectedMessages: hasLivePromptInjectedMessages(data.messages),
                persistedConversationMessageCount: conversationalMessageCount,
                liveThreadMessageCount: liveThreadMessagesRef.current.length,
            })
        ) {
            notifySessionUpdate(sessionId, {
                messageCount: conversationalMessageCount,
            });
            return;
        }

        lastMessageSigRef.current = sig;

        const uiMessages = convertDBMessagesToUIMessages(data.messages);

        notifySessionUpdate(sessionId, {
            messageCount: conversationalMessageCount,
        });

        // Update session state for sidebar / session switching
        setSessionState(prev => ({ ...prev, messages: uiMessages }));

        // Update the thread in-place via AI SDK — no remount, no scroll reset!
        if (chatSetMessagesRef.current) {
            chatSetMessagesRef.current(uiMessages);
        }
    }, [sessionId, notifySessionUpdate, setSessionState, chatSetMessagesRef, liveThreadMessagesRef, shouldSkipBackgroundRefresh]);

    // isChatFading is local to this hook's refreshMessages but needs to be surfaced
    // back to the component. We keep a state for it here too.
    const [isChatFading, setIsChatFading] = useState(false);

    // Stable ref so startPollingForCompletion doesn't change identity when
    // refreshMessages recreates (which would cascade through useEffect deps
    // in chat-interface.tsx and cause runaway polling).
    const refreshMessagesRef = useRef(refreshMessages);
    useEffect(() => { refreshMessagesRef.current = refreshMessages; }, [refreshMessages]);

    const consecutiveErrorsRef = useRef<number>(0);
    // Holds the most recent pollOnce closure so the visibility-change handler
    // can trigger an immediate poll without restarting the interval.
    const pollOnceRef = useRef<(() => Promise<void>) | null>(null);

    const clearTrackedRunState = useCallback(async (options: ClearTrackedRunStateOptions = {}) => {
        const runId = options.runId ?? processingRunId;
        console.log("[Background Processing] clearTrackedRunState called:", { runId, refreshMessages: options.refreshMessages, clearTaskState: options.clearTaskState });

        if (pollingIntervalRef.current) {
            clearInterval(pollingIntervalRef.current);
            pollingIntervalRef.current = null;
        }
        activePollingRunIdRef.current = null;

        setIsProcessingInBackground(false);
        setProcessingRunId(null);
        setIsZombieRun(false);
        setIsCancellingBackgroundRun(false);
        isRunActiveRef.current = false;

        if (options.clearTaskState && runId) {
            removeTask(runId);

            const sessionSyncState = useSessionSyncStore.getState();
            if (sessionSyncState.activeRuns.get(sessionId) === runId) {
                sessionSyncState.setActiveRun(sessionId, null);
            }

            const activity = sessionSyncState.getSessionActivity(sessionId);
            if (
                (!activity || activity.runId === runId) &&
                !isCompletionActivityState(activity, runId)
            ) {
                sessionSyncState.setSessionActivity(sessionId, null);
            }
        }

        if (options.refreshMessages) {
            await refreshMessagesRef.current();
        }
    }, [processingRunId, removeTask, sessionId]);

    const resetBackgroundState = useCallback(() => {
        if (pollingIntervalRef.current) {
            clearInterval(pollingIntervalRef.current);
            pollingIntervalRef.current = null;
        }
        activePollingRunIdRef.current = null;
        setIsProcessingInBackground(false);
        setProcessingRunId(null);
        setIsZombieRun(false);
        setIsCancellingBackgroundRun(false);
        isRunActiveRef.current = false;
    }, []);

    const startPollingForCompletion = useCallback((runId: string) => {
        if (activePollingRunIdRef.current === runId && pollingIntervalRef.current) {
            return;
        }
        isRunActiveRef.current = true;
        if (pollingIntervalRef.current) {
            clearInterval(pollingIntervalRef.current);
        }
        activePollingRunIdRef.current = runId;
        setIsZombieRun(false);
        consecutiveErrorsRef.current = 0;

        const pollIntervalMs = 2000;
        const MAX_CONSECUTIVE_ERRORS = 10;

        const pollOnce = async () => {
            try {
                const { data, error, status } = await resilientFetch<{
                    status: string;
                    isZombie?: boolean;
                    health?: "running" | "stale_suspected";
                }>(
                    `/api/agent-runs/${runId}/status`,
                    { retries: 0 }
                );
                if (error || !data) {
                    if (status === 404) {
                        console.warn("[Background Processing] Run vanished during polling, clearing local state:", runId);
                        await clearTrackedRunState({
                            runId,
                            refreshMessages: true,
                            clearTaskState: true,
                        });
                        return;
                    }

                    consecutiveErrorsRef.current += 1;
                    console.error("[Background Processing] Polling error:", error, `(${consecutiveErrorsRef.current}/${MAX_CONSECUTIVE_ERRORS})`);

                    // Too many consecutive errors — likely a network outage.
                    // Stop polling but keep processingRunId so the SSE reconnect
                    // bridge can re-verify run state when connectivity returns.
                    // Do NOT refreshMessages here — the server may still be
                    // running the task and a premature refresh could cause a
                    // ghost branch (stale DB snapshot pushed to thread while
                    // the run is still mutating messages).
                    if (consecutiveErrorsRef.current >= MAX_CONSECUTIVE_ERRORS) {
                        console.warn("[Background Processing] Too many consecutive polling errors — stopping polling, awaiting SSE reconnect to re-verify");
                        if (pollingIntervalRef.current) {
                            clearInterval(pollingIntervalRef.current);
                            pollingIntervalRef.current = null;
                        }
                        activePollingRunIdRef.current = null;
                        // Unblock deferral gates so reconnection can hydrate
                        // messages from DB without being blocked by stale state.
                        isRunActiveRef.current = false;
                    }
                    return;
                }

                // Reset error counter on successful response
                consecutiveErrorsRef.current = 0;

                if (data.status === "running") {
                    setIsZombieRun(Boolean(data.isZombie));
                    if (data.isZombie) {
                        console.warn("[Background Processing] Zombie run detected; keeping recovery polling active", { runId });
                    }
                    if (data.health === "stale_suspected") {
                        console.warn("[Background Processing] Run is stale-suspected but still running", { runId });
                    }
                    // Fetch intermediate messages while still running for live updates
                    await refreshMessagesRef.current();
                    return;
                }
                console.log("[Background Processing] Run completed with status:", data.status);
                await clearTrackedRunState({
                    runId,
                    refreshMessages: true,
                    clearTaskState: true,
                });
            } catch (error) {
                consecutiveErrorsRef.current += 1;
                console.error("[Background Processing] Polling error:", error, `(${consecutiveErrorsRef.current}/${MAX_CONSECUTIVE_ERRORS})`);
                // Same as above: stop polling on persistent errors but keep
                // processingRunId for SSE reconnect re-verification.
                if (consecutiveErrorsRef.current >= MAX_CONSECUTIVE_ERRORS) {
                    console.warn("[Background Processing] Too many consecutive exceptions — stopping polling, awaiting reconnect");
                    if (pollingIntervalRef.current) {
                        clearInterval(pollingIntervalRef.current);
                        pollingIntervalRef.current = null;
                    }
                    activePollingRunIdRef.current = null;
                    // Mirror the error-branch cleanup: unblock deferral gates
                    // so reconnect-triggered message reloads aren't gated by
                    // stale "run active" state.
                    isRunActiveRef.current = false;
                }
            }
        };

        // Expose pollOnce so the visibility-change handler can trigger an
        // immediate poll without restarting the interval.
        pollOnceRef.current = pollOnce;

        // Poll immediately — don't wait for the first interval tick.
        // If the run already completed, this clears the state right away
        // instead of showing "processing" for up to 2 seconds.
        void pollOnce();
        pollingIntervalRef.current = setInterval(pollOnce, pollIntervalMs);
    }, []);

    // When the user returns to this tab while a background run is active, reset
    // the consecutive-error counter (network may be back) and either restart the
    // polling interval (if it was killed by too many errors) or trigger an
    // immediate poll (if the interval is still alive) so the UI updates right away
    // instead of waiting up to 2 s for the next tick.
    useEffect(() => {
        if (!isProcessingInBackground || !processingRunId) return;

        const handleVisibilityChange = () => {
            if (document.visibilityState !== "visible") return;
            consecutiveErrorsRef.current = 0;
            if (!pollingIntervalRef.current) {
                // Polling was killed (e.g. by a network outage) — restart it.
                startPollingForCompletion(processingRunId);
            } else if (pollOnceRef.current) {
                // Interval is alive — just do an immediate poll to avoid lag.
                void pollOnceRef.current();
            }
        };

        document.addEventListener("visibilitychange", handleVisibilityChange);
        return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
    }, [isProcessingInBackground, processingRunId, startPollingForCompletion]);

    // Clear polling interval on unmount to prevent stale updates after navigation
    useEffect(() => {
        return () => {
            if (pollingIntervalRef.current) {
                clearInterval(pollingIntervalRef.current);
                pollingIntervalRef.current = null;
            }
            activePollingRunIdRef.current = null;
        };
    }, []);

    // Safety net: reset isRunActiveRef when background processing ends
    // (covers session switches via clearBackgroundState)
    useEffect(() => {
        if (!isProcessingInBackground) {
            isRunActiveRef.current = false;
        }
    }, [isProcessingInBackground]);

    // Safety net: detect stale "processing in background" state.
    // After reconnection, checkActiveRunRef may set isProcessingInBackground(true)
    // and start polling. If polling quickly detects terminal status, the React
    // state batch from checkActiveRunRef (true) and clearTrackedRunState (false)
    // can race. This effect catches the inconsistency: if the banner is showing
    // but polling has stopped and isRunActiveRef is false, force clear after 3s.
    const processingRunIdRef = useRef(processingRunId);
    processingRunIdRef.current = processingRunId;
    useEffect(() => {
        if (!isProcessingInBackground || !processingRunId) return;
        const timer = setTimeout(async () => {
            // Use refs to read fresh state (not stale closure values)
            if (!pollingIntervalRef.current && !isRunActiveRef.current) {
                // Polling stopped and run is not active — verify with server
                const runId = processingRunIdRef.current;
                if (!runId) return;
                const { data } = await resilientFetch<{ status: string }>(
                    `/api/agent-runs/${runId}/status`,
                    { retries: 0 }
                );
                if (!data) return;
                if (data.status === "running") {
                    // Run is still active but polling died — restart it
                    startPollingForCompletion(runId);
                    return;
                }
                console.warn("[Background Processing] Safety net: clearing stale background state for", runId);
                void clearTrackedRunState({ runId, refreshMessages: true, clearTaskState: true });
            }
        }, 3000);
        return () => clearTimeout(timer);
    }, [isProcessingInBackground, processingRunId, clearTrackedRunState, startPollingForCompletion]);

    const handleCancelBackgroundRun = useCallback(async () => {
        const runId = processingRunId;
        if (!runId) return;
        setIsCancellingBackgroundRun(true);
        try {
            const result = await resilientFetch<{ status?: string }>(
                `/api/agent-runs/${runId}/cancel`,
                { method: "POST", headers: { "Content-Type": "application/json" }, retries: 0 }
            );
            if (result.error) {
                const shouldTreatAsCancelled = result.status === 409 || result.status === 404;
                if (!shouldTreatAsCancelled) {
                    throw new Error("Failed to cancel run");
                }
            }
            toast.success(t("backgroundRun.cancelled"));
            await clearTrackedRunState({
                runId,
                refreshMessages: true,
                clearTaskState: true,
            });
        } catch (err) {
            console.error("Failed to cancel background run:", err);
            toast.error(t("backgroundRun.cancelError"));
        } finally {
            setIsCancellingBackgroundRun(false);
        }
    }, [clearTrackedRunState, processingRunId, t]);

    // Memoize the return object so consumers that use `bg` as a useEffect
    // dependency don't re-fire on every render.  Refs and state-setters are
    // identity-stable and excluded from the dep array on purpose.
    return useMemo(() => ({
        pollingIntervalRef,
        activePollingRunIdRef,
        isProcessingInBackground,
        setIsProcessingInBackground,
        processingRunId,
        setProcessingRunId,
        isZombieRun,
        setIsZombieRun,
        isChatFading,
        isCancellingBackgroundRun,
        setIsCancellingBackgroundRun,
        refreshMessages,
        clearTrackedRunState,
        resetBackgroundState,
        startPollingForCompletion,
        handleCancelBackgroundRun,
        /** Exposed so reloadSessionMessages can skip injected-message pushes mid-run. */
        isRunActiveRef,
    }), [
        isProcessingInBackground,
        processingRunId,
        isZombieRun,
        isChatFading,
        isCancellingBackgroundRun,
        refreshMessages,
        clearTrackedRunState,
        resetBackgroundState,
        handleCancelBackgroundRun,
        // startPollingForCompletion has [] deps — stable
        // refs & state setters are identity-stable
    ]);
}

// ---------------------------------------------------------------------------
// useSessionManager
// Manages session CRUD operations: load, create, switch, delete, rename, etc.
// ---------------------------------------------------------------------------

interface UseSessionManagerOptions {
    character: { id: string; name: string };
    initialNextCursor: string | null;
    initialSessions: SessionInfo[];
    sessionId: string;
    setSessionState: React.Dispatch<React.SetStateAction<SessionState>>;
    resetBackgroundState: () => void;
}

export function useSessionManager({
    character,
    initialNextCursor,
    initialSessions,
    sessionId,
    setSessionState,
    resetBackgroundState,
}: UseSessionManagerOptions) {
    const router = useRouter();
    const tc = useTranslations("common");
    const t = useTranslations("chat");
    const { syncSessions, updateSession: notifySessionUpdate, notifySessionDeleted: notifySessionRemoval } = useSessionSync();
    const sessionSyncNotifier = useSessionSyncNotifier();
    const setSyncSessions = useSessionSyncStore((state) => state.setSessions);

    const [sessions, setSessions] = useState<SessionInfo[]>(() => sortSessionsByUpdatedAt(initialSessions));
    const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor);
    const [hasMoreSessions, setHasMoreSessions] = useState(Boolean(initialNextCursor));
    const [totalSessionCount, setTotalSessionCount] = useState(0);
    const [searchQuery, setSearchQuery] = useState("");
    const [channelFilter, setChannelFilter] = useState<ChannelFilter>("all");
    const [dateRange, setDateRange] = useState<DateRangeFilter>("all");
    const [loadingSessions, setLoadingSessions] = useState(false);
    const [isLoading, setIsLoading] = useState(false);

    const nextCursorRef = useRef<string | null>(initialNextCursor);
    const userLoadedMoreRef = useRef(false);
    const filterKeyRef = useRef(`${searchQuery}|${channelFilter}|${dateRange}`);
    const filtersRef = useRef({ searchQuery, channelFilter, dateRange });
    const switchRequestIdRef = useRef(0);
    filtersRef.current = { searchQuery, channelFilter, dateRange };

    // Sync sessions to global store whenever local sessions change
    useEffect(() => {
        if (sessions.length > 0) {
            setSyncSessions(sessionInfoArrayToSyncData(sessions), character.id);
        }
    }, [sessions, character.id, setSyncSessions]);

    const refreshSessionTimestamp = useCallback((
        targetSessionId: string,
        options?: { includeActivity?: boolean }
    ) => {
        const nextUpdatedAt = new Date().toISOString();
        const updates = options?.includeActivity
            ? { updatedAt: nextUpdatedAt, lastMessageAt: nextUpdatedAt }
            : { updatedAt: nextUpdatedAt };

        notifySessionUpdate(targetSessionId, updates);
        setSessions((prev) => {
            let updated = false;
            const next = prev.map((session) => {
                if (session.id !== targetSessionId) return session;
                updated = true;
                return { ...session, ...updates };
            });
            if (!updated) return prev;
            return sortSessionsByUpdatedAt(next);
        });
    }, []);

    const loadSessions = useCallback(async (options?: {
        silent?: boolean;
        append?: boolean;
        overrideCursor?: string | null;
        preserveExtra?: boolean;
        signal?: AbortSignal;
    }) => {
        const silent = options?.silent ?? false;
        const append = options?.append ?? false;
        const preserveExtra = options?.preserveExtra ?? false;
        const cursor = options?.overrideCursor !== undefined
            ? options.overrideCursor
            : (append ? nextCursorRef.current : null);
        try {
            if (!silent) setLoadingSessions(true);
            const { searchQuery, channelFilter, dateRange } = filtersRef.current;
            const params = new URLSearchParams({ characterId: character.id, limit: "20" });
            if (cursor) params.set("cursor", cursor);
            if (searchQuery.trim()) params.set("search", searchQuery.trim());
            if (channelFilter !== "all") params.set("channelType", channelFilter);
            if (dateRange !== "all") params.set("dateRange", dateRange);
            const { data, error } = await resilientFetch<{ sessions: SessionInfo[]; nextCursor?: string; totalCount?: number }>(
                `/api/sessions?${params.toString()}`,
                { retries: 0, signal: options?.signal }
            );
            if (error || !data) return false;
            const pageSessions = sortSessionsByUpdatedAt((data.sessions || []) as SessionInfo[]);
            syncSessions(pageSessions);
            setSessions((prev) => {
                if (!append) {
                    if (preserveExtra && prev.length > pageSessions.length) {
                        const freshById = new Map(pageSessions.map((s) => [s.id, s]));
                        const prevIds = new Set(prev.map((s) => s.id));
                        const newOnes = pageSessions.filter((s) => !prevIds.has(s.id));
                        const refreshed = prev.map((s) => freshById.get(s.id) ?? s);
                        return sortSessionsByUpdatedAt([...newOnes, ...refreshed]);
                    }
                    return areSessionsEquivalent(prev, pageSessions) ? prev : pageSessions;
                }
                const existingIds = new Set(prev.map((session) => session.id));
                const merged = [...prev, ...pageSessions.filter((session) => !existingIds.has(session.id))];
                return sortSessionsByUpdatedAt(merged);
            });
            if (!preserveExtra) {
                nextCursorRef.current = data.nextCursor ?? null;
                setNextCursor(data.nextCursor ?? null);
                setHasMoreSessions(Boolean(data.nextCursor));
            }
            setTotalSessionCount(typeof data.totalCount === "number" ? data.totalCount : pageSessions.length);
            return true;
        } catch (err) {
            console.error("Failed to load sessions:", err);
            return false;
        } finally {
            if (!silent) setLoadingSessions(false);
        }
    }, [character.id]);

    const fetchSessionMessages = useCallback(async (targetSessionId: string) => {
        const { data, error } = await resilientFetch<{ messages: DBMessage[] }>(
            `/api/sessions/${targetSessionId}`,
            { retries: 0 }
        );
        if (error || !data) {
            if (error) console.error("Failed to fetch session messages:", error);
            return null;
        }

        const dbMessages = (data.messages || []) as DBMessage[];
        const uiMessages = convertDBMessagesToUIMessages(dbMessages);
        const conversationalMessageCount = countVisibleConversationMessages(dbMessages);
        const hasInjectedMessages = hasLivePromptInjectedMessages(dbMessages);

        return { uiMessages, conversationalMessageCount, hasInjectedMessages };
    }, []);

    const loadMoreSessions = useCallback(async () => {
        if (!hasMoreSessions || loadingSessions) return;
        userLoadedMoreRef.current = true;
        await loadSessions({ append: true });
    }, [hasMoreSessions, loadingSessions, loadSessions]);

    useEffect(() => {
        const filterKey = `${searchQuery}|${channelFilter}|${dateRange}`;
        if (filterKey === filterKeyRef.current) return;
        filterKeyRef.current = filterKey;
        userLoadedMoreRef.current = false;
        nextCursorRef.current = null;
        setNextCursor(null);
        setHasMoreSessions(true);
        const timeout = setTimeout(() => {
            void loadSessions({ overrideCursor: null });
        }, 250);
        return () => clearTimeout(timeout);
    }, [searchQuery, channelFilter, dateRange, loadSessions]);

    // Session switches should not trigger an App Router navigation because that remounts
    // the chat shell and restarts ambient video backgrounds.
    const replaceSessionUrl = useCallback((targetSessionId: string, targetCharacterId?: string | null) => {
        const resolvedCharacterId = targetCharacterId ?? character.id;
        const chatPathSuffix = `/chat/${resolvedCharacterId}`;
        const nextUrl = `${chatPathSuffix}?sessionId=${targetSessionId}`;
        if (typeof window !== "undefined") {
            const currentPath = window.location.pathname.replace(/\/$/, "");
            if (currentPath.endsWith(chatPathSuffix)) {
                window.history.replaceState(window.history.state, "", nextUrl);
                return;
            }
        }
        router.replace(nextUrl, { scroll: false });
    }, [character.id, router]);

    const switchSession = useCallback(async (
        newSessionId: string,
        options?: { characterId?: string | null },
    ): Promise<boolean> => {
        // Guard: clicking the same session while a run is active must be a no-op.
        // clearBackgroundState() would drop processingRunId / isProcessingInBackground,
        // making the UI think nothing is running and allowing a new message to be sent
        // while the old run is still executing server-side.
        if (newSessionId === sessionId && (!options?.characterId || options.characterId === character.id)) {
            return true;
        }
        try {
            const requestId = ++switchRequestIdRef.current;
            setIsLoading(true);
            const sessionPayload = await fetchSessionMessages(newSessionId);
            if (!sessionPayload) return false;
            if (requestId !== switchRequestIdRef.current) return false;
            resetBackgroundState();
            setSessionState({ sessionId: newSessionId, messages: sessionPayload.uiMessages });
            notifySessionUpdate(newSessionId, {
                messageCount: sessionPayload.conversationalMessageCount,
            });
            replaceSessionUrl(newSessionId, options?.characterId);
            return true;
        } catch (err) {
            console.error("Failed to switch session:", err);
            return false;
        } finally {
            setIsLoading(false);
        }
    }, [character.id, sessionId, fetchSessionMessages, notifySessionUpdate, replaceSessionUrl, resetBackgroundState, setSessionState]);

    const createNewSession = useCallback(async (): Promise<SessionInfo | null> => {
        try {
            setIsLoading(true);
            const { data: createData, error } = await resilientPost<{ session: SessionInfo }>(
                "/api/sessions",
                { forceNew: true, metadata: { characterId: character.id, characterName: character.name } }
            );
            if (!error && createData) {
                const { session } = createData;
                resetBackgroundState();
                setSessionState({ sessionId: session.id, messages: [] });
                syncSessions([session]);
                await loadSessions();
                replaceSessionUrl(session.id);
                return session;
            }
            return null;
        } catch (err) {
            console.error("Failed to create new session:", err);
            return null;
        } finally {
            setIsLoading(false);
        }
    }, [character.id, character.name, loadSessions, router, resetBackgroundState, setSessionState]);

    const resetChannelSession = useCallback(async (sessionToResetId: string, options?: { archiveOld?: boolean }) => {
        try {
            setIsLoading(true);
            const { data, error } = await resilientPost<{ session: { id: string } }>(
                `/api/sessions/${sessionToResetId}/reset-channel`,
                { archiveOld: options?.archiveOld ?? false }
            );
            if (error || !data) throw new Error("Failed to reset channel session");
            const { session } = data;
            if (session?.id) {
                await loadSessions();
                await switchSession(session.id);
            }
        } catch (err) {
            console.error("Failed to reset channel session:", err);
            toast.error(t("channelSession.resetError"));
        } finally {
            setIsLoading(false);
        }
    }, [loadSessions, switchSession, t]);

    const deleteSession = useCallback(async (sessionToDeleteId: string) => {
        try {
            const { error } = await resilientDelete(`/api/sessions/${sessionToDeleteId}`);
            if (!error) {
                notifySessionRemoval(sessionToDeleteId);
                if (sessionToDeleteId === sessionId) {
                    const remainingSessions = sessions.filter((s) => s.id !== sessionToDeleteId);
                    if (remainingSessions.length > 0) {
                        await switchSession(remainingSessions[0].id);
                    } else {
                        await createNewSession();
                    }
                }
                await loadSessions();
            }
        } catch (err) {
            console.error("Failed to delete session:", err);
        }
    }, [sessionId, sessions, switchSession, createNewSession, loadSessions]);

    const renameSession = useCallback(async (sessionToRenameId: string, newTitle: string): Promise<boolean> => {
        const trimmed = newTitle.trim();
        const normalizedTitle = trimmed.length > 0 ? trimmed : null;
        const optimisticUpdatedAt = new Date().toISOString();
        let found = false;
        let changed = false;
        setSessions((prev) => {
            const next = prev.map((session) => {
                if (session.id !== sessionToRenameId) return session;
                found = true;
                if (session.title === normalizedTitle) return session;
                changed = true;
                return { ...session, title: normalizedTitle, updatedAt: optimisticUpdatedAt };
            });
            if (!found || !changed) return prev;
            return sortSessionsByUpdatedAt(next);
        });
        if (!found) {
            toast.error(tc("error"));
            await loadSessions();
            return false;
        }
        if (!changed) return true;
        notifySessionUpdate(sessionToRenameId, { title: normalizedTitle, updatedAt: optimisticUpdatedAt });
        try {
            const { error } = await resilientPatch(`/api/sessions/${sessionToRenameId}`, { title: normalizedTitle });
            if (error) throw new Error("Failed to rename session");
            return true;
        } catch (err) {
            console.error("Failed to rename session:", err);
            toast.error(tc("error"));
            await loadSessions();
            return false;
        }
    }, [loadSessions, tc]);

    const exportSession = useCallback(async (sessionToExportId: string, format: "markdown" | "json" | "text") => {
        try {
            const { data, error } = await resilientFetch<{ content: string; filename: string }>(
                `/api/sessions/${sessionToExportId}/export?format=${format}`
            );
            if (error || !data) throw new Error("Failed to export session");
            const content = typeof data.content === "string" ? data.content : "";
            const filename = typeof data.filename === "string" ? data.filename : `session-${sessionToExportId}.${format === "markdown" ? "md" : format}`;
            const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = filename;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            URL.revokeObjectURL(url);
            toast.success(t("sidebar.exportSuccess"));
        } catch (error) {
            console.error("Failed to export session:", error);
            toast.error(t("sidebar.exportError"));
        }
    }, [t]);

    const pinSession = useCallback(async (sessionToPinId: string) => {
        const currentSession = sessions.find((s) => s.id === sessionToPinId);
        const isPinned = currentSession?.metadata?.pinned === true;
        try {
            await resilientPatch(`/api/sessions/${sessionToPinId}`, { metadata: { pinned: !isPinned } });
            await loadSessions({ silent: true, overrideCursor: null, preserveExtra: userLoadedMoreRef.current });
            toast.success(t(isPinned ? "sidebar.unpin" : "sidebar.pin"));
        } catch (error) {
            console.error("Failed to pin session:", error);
        }
    }, [sessions, loadSessions, t]);

    const archiveSession = useCallback(async (sessionToArchiveId: string) => {
        try {
            await resilientPatch(`/api/sessions/${sessionToArchiveId}`, { status: "archived" });
            toast.success(t("sidebar.archiveSuccess"));
            if (sessionToArchiveId === sessionId) {
                const remaining = sessions.filter((s) => s.id !== sessionToArchiveId);
                if (remaining.length > 0) {
                    await switchSession(remaining[0].id);
                } else {
                    router.replace(`/chat/${character.id}`, { scroll: false });
                }
            }
            await loadSessions({ silent: true, overrideCursor: null, preserveExtra: userLoadedMoreRef.current });
        } catch (error) {
            console.error("Failed to archive session:", error);
            toast.error(t("sidebar.archiveError"));
        }
    }, [sessionId, sessions, switchSession, loadSessions, router, character.id, t]);

    const restoreSession = useCallback(async (sessionToRestoreId: string) => {
        try {
            await resilientPatch(`/api/sessions/${sessionToRestoreId}`, { status: "active" });
            toast.success(t("sidebar.restore"));
            await loadSessions({ silent: true, overrideCursor: null, preserveExtra: userLoadedMoreRef.current });
        } catch (error) {
            console.error("Failed to restore session:", error);
            toast.error(t("sidebar.archiveError"));
        }
    }, [loadSessions, t]);

    return {
        sessions,
        setSessions,
        nextCursor,
        hasMoreSessions,
        totalSessionCount,
        searchQuery,
        setSearchQuery,
        channelFilter,
        setChannelFilter,
        dateRange,
        setDateRange,
        loadingSessions,
        isLoading,
        userLoadedMoreRef,
        refreshSessionTimestamp,
        notifySessionUpdate,
        loadSessions,
        fetchSessionMessages,
        loadMoreSessions,
        switchSession,
        createNewSession,
        resetChannelSession,
        deleteSession,
        renameSession,
        exportSession,
        pinSession,
        archiveSession,
        restoreSession,
    };
}
