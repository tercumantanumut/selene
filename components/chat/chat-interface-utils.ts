import type { UIMessage } from "ai";
import type { ChatWorkspaceTab, OpenChatWorkspaceSession } from "@/lib/stores/chat-workspace-store";
import type { SessionInfo } from "@/components/chat/chat-sidebar/types";

interface SessionCharacterFallback {
    id?: string | null;
    name?: string | null;
}

export const getSessionCharacterId = (session: Pick<SessionInfo, "characterId" | "metadata">) =>
    session.characterId ?? session.metadata?.characterId ?? null;

export const getSessionCharacterName = (
    session: Pick<SessionInfo, "characterId" | "metadata">,
    fallback?: SessionCharacterFallback,
) => {
    const explicitName = session.metadata?.characterName ?? null;
    if (explicitName) {
        return explicitName;
    }

    const sessionCharacterId = getSessionCharacterId(session);
    if (sessionCharacterId && fallback?.id && sessionCharacterId === fallback.id) {
        return fallback.name ?? null;
    }

    return null;
};

export const toOpenChatWorkspaceSession = (
    session: Pick<SessionInfo, "id" | "title" | "characterId" | "updatedAt" | "metadata">,
    fallback?: SessionCharacterFallback,
): OpenChatWorkspaceSession => ({
    sessionId: session.id,
    title: session.title ?? null,
    characterId: getSessionCharacterId(session),
    characterName: getSessionCharacterName(session, fallback),
    updatedAt: session.updatedAt ?? null,
});

const toOpenChatWorkspaceSessionFromTab = (
    tab: Pick<ChatWorkspaceTab, "sessionId" | "title" | "characterId" | "characterName" | "updatedAt">,
): OpenChatWorkspaceSession => ({
    sessionId: tab.sessionId,
    title: tab.title ?? null,
    characterId: tab.characterId ?? null,
    characterName: tab.characterName ?? null,
    updatedAt: tab.updatedAt ?? null,
});

export const resolveCurrentSessionTabData = ({
    sessionId,
    currentSessionRecord,
    persistedTab,
    currentCharacter,
}: {
    sessionId: string | null | undefined;
    currentSessionRecord?: Pick<SessionInfo, "id" | "title" | "characterId" | "updatedAt" | "metadata"> | null;
    persistedTab?: Pick<ChatWorkspaceTab, "sessionId" | "title" | "characterId" | "characterName" | "updatedAt"> | null;
    currentCharacter: { id: string; name: string };
}): OpenChatWorkspaceSession | null => {
    if (!sessionId) return null;
    if (currentSessionRecord) {
        return toOpenChatWorkspaceSession(currentSessionRecord, currentCharacter);
    }
    if (persistedTab) {
        return toOpenChatWorkspaceSessionFromTab(persistedTab);
    }
    // Unknown session identity must remain unset until a session-scoped source appears.
    return {
        sessionId,
        title: null,
        characterId: null,
        characterName: null,
        updatedAt: null,
    };
};

export const shouldSkipEnsureCurrentSessionOpen = ({
    activeSessionId,
    justClosedActiveSessionId,
}: {
    activeSessionId: string | null | undefined;
    justClosedActiveSessionId: string | null;
}) =>
    Boolean(
        activeSessionId &&
        justClosedActiveSessionId &&
        activeSessionId === justClosedActiveSessionId,
    );

export const buildChatSessionUrl = (characterId: string, sessionId: string) =>
    `/chat/${characterId}?sessionId=${sessionId}`;

export const resolveSessionSwitchCharacterId = ({
    targetSession,
    persistedTab,
    currentCharacterId,
}: {
    targetSession?: Pick<SessionInfo, "characterId" | "metadata"> | null;
    persistedTab?: Pick<ChatWorkspaceTab, "characterId"> | null;
    currentCharacterId: string;
}) => {
    const sessionCharacterId = targetSession ? getSessionCharacterId(targetSession) : null;
    return sessionCharacterId ?? persistedTab?.characterId ?? currentCharacterId;
};

const parseSessionTimestamp = (value: string | null | undefined) => {
    const timestamp = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(timestamp) ? timestamp : 0;
};

export const getSessionActivityTimestamp = (session: Pick<SessionInfo, "lastMessageAt" | "updatedAt">) =>
    session.lastMessageAt ?? session.updatedAt;

const compareSessionsByActivity = (left: SessionInfo, right: SessionInfo) => {
    const activityDiff =
        parseSessionTimestamp(getSessionActivityTimestamp(right)) -
        parseSessionTimestamp(getSessionActivityTimestamp(left));
    if (activityDiff !== 0) {
        return activityDiff;
    }

    const updatedDiff = parseSessionTimestamp(right.updatedAt) - parseSessionTimestamp(left.updatedAt);
    if (updatedDiff !== 0) {
        return updatedDiff;
    }

    const createdDiff = parseSessionTimestamp(right.createdAt) - parseSessionTimestamp(left.createdAt);
    if (createdDiff !== 0) {
        return createdDiff;
    }

    return right.id.localeCompare(left.id);
};

export const sortSessionsByUpdatedAt = (sessions: SessionInfo[]) =>
    [...sessions].sort(compareSessionsByActivity);

export const getSessionSignature = (session: SessionInfo) =>
    [
        session.id,
        session.updatedAt,
        session.lastMessageAt ?? "",
        session.title ?? "",
        session.metadata?.channelType ?? "",
        session.metadata?.channelPeerId ?? "",
        session.metadata?.channelPeerName ?? "",
    ].join("|");

export const areSessionsEquivalent = (prev: SessionInfo[], next: SessionInfo[]) => {
    if (prev.length !== next.length) {
        return false;
    }
    for (let index = 0; index < prev.length; index += 1) {
        if (getSessionSignature(prev[index]) !== getSessionSignature(next[index])) {
            return false;
        }
    }
    return true;
};

const isTextPart = (part: UIMessage["parts"][number] | undefined | null): part is { type: "text"; text: string } => {
    return Boolean(
        part &&
        part.type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
    );
};

const getMessageSignature = (message: UIMessage) => {
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const partTypes = parts.map((part) => (part?.type ? String(part.type) : "text")).join(",");
    const textDigest = parts
        .filter(isTextPart)
        .map((part) => {
            const text = part.text || "";
            return `${text.length}:${text.slice(0, 80)}`;
        })
        .join("|");
    return `${message.id || ""}:${message.role}:${partTypes}:${textDigest}`;
};

export const getMessagesSignature = (messages: UIMessage[]) => {
    if (!messages.length) {
        return "0";
    }
    const lastMessage = messages[messages.length - 1];
    return `${messages.length}:${getMessageSignature(lastMessage)}`;
};

interface LivePromptForegroundReconciliationInput {
    liveThreadMessageCount: number;
    persistedConversationMessageCount: number;
    hasInjectedMessages: boolean;
}

export const shouldDeferLivePromptForegroundReconciliation = (
    input: LivePromptForegroundReconciliationInput,
) =>
    input.hasInjectedMessages &&
    input.persistedConversationMessageCount <= input.liveThreadMessageCount;

interface LivePromptForegroundDeferralBypassInput {
    liveThreadMessages: UIMessage[];
    persistedUiMessages: UIMessage[];
    progressAssistantMessageId?: string | null;
}

export const shouldBypassLivePromptForegroundDeferral = (
    input: LivePromptForegroundDeferralBypassInput,
) => {
    const progressAssistantMessageId = input.progressAssistantMessageId?.trim();
    if (!progressAssistantMessageId) {
        return false;
    }

    // The progress event is already describing a message the live thread knows
    // about, so the usual count-based deferral remains safe.
    if (input.liveThreadMessages.some((message) => message.id === progressAssistantMessageId)) {
        return false;
    }

    // A queued (injected) message can rotate the assistant segment mid-run.
    // If the persisted snapshot now contains that new assistant message, the UI
    // must reconcile immediately or it will keep rendering the old branch while
    // the backend continues streaming into the new one.
    return input.persistedUiMessages.some(
        (message) =>
            message.id === progressAssistantMessageId &&
            message.role === "assistant",
    );
};

interface BackgroundRunResolutionInput {
    isForegroundStreaming: boolean;
    hasActiveRun?: boolean;
    runId?: string | null;
    health?: "running" | "stale_suspected" | null;
    shouldResumeBackgroundRun?: boolean;
    latestDeepResearchStatus?: string | null;
    latestDeepResearchRunId?: string | null;
}

interface BackgroundRunResolution {
    activeForegroundRunId: string | null;
    resumedForegroundRunId: string | null;
    deepResearchRunId: string | null;
    trackedRunId: string | null;
    shouldShowBackgroundRun: boolean;
    shouldPollRun: boolean;
    isStaleSuspected: boolean;
}

interface SessionScopedAsyncResultInput {
    activeSessionId: string | null | undefined;
    targetSessionId: string;
    requestId: number;
    latestRequestId: number;
}

export const shouldApplySessionScopedAsyncResult = (
    input: SessionScopedAsyncResultInput,
) =>
    input.activeSessionId === input.targetSessionId &&
    input.requestId === input.latestRequestId;

export const resolveBackgroundRunState = (
    input: BackgroundRunResolutionInput
): BackgroundRunResolution => {
    const activeForegroundRunId =
        !input.isForegroundStreaming && input.hasActiveRun
            ? input.runId ?? null
            : null;

    const resumedForegroundRunId =
        activeForegroundRunId && input.shouldResumeBackgroundRun !== false
            ? activeForegroundRunId
            : null;

    const deepResearchRunId = input.latestDeepResearchStatus === "running"
        ? input.latestDeepResearchRunId ?? null
        : null;

    const trackedRunId = activeForegroundRunId ?? deepResearchRunId;
    const isStaleSuspected = input.health === "stale_suspected";

    return {
        activeForegroundRunId,
        resumedForegroundRunId,
        deepResearchRunId,
        trackedRunId,
        shouldShowBackgroundRun: Boolean(activeForegroundRunId || deepResearchRunId),
        shouldPollRun: Boolean(resumedForegroundRunId || deepResearchRunId || isStaleSuspected),
        isStaleSuspected,
    };
};
