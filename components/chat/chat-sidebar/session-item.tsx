"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { KeyboardEvent, MouseEvent } from "react";
import { useFormatter, useTranslations } from "next-intl";
import {
  Archive,
  BarChart2,
  Clock,
  Download,
  ExternalLink,
  GitBranch,
  Link2,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getSessionActivityTimestamp } from "@/components/chat/chat-interface-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useSessionData,
  useSessionHasActiveRun,
} from "@/lib/stores/session-sync-store";
import { CHANNEL_TYPE_ICONS } from "./constants";
import { calendarDaysAgo, parseAsUTC } from "./sidebar-utils";
import type { SessionInfo } from "./types";

interface SessionItemProps {
  session: SessionInfo;
  isCurrent: boolean;
  isEditing: boolean;
  editTitle: string;
  setEditTitle: (title: string) => void;
  onSwitch: () => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onStartEdit: () => void;
  onDelete: () => void;
  onArchive?: () => void;
  onExport: (format: "markdown" | "json" | "text") => void;
  onResetChannel: () => void;
  isPinned?: boolean;
  onPin?: () => void;
}

export function SessionItem({
  session: initialSession,
  isCurrent,
  isEditing,
  editTitle,
  setEditTitle,
  onSwitch,
  onSaveEdit,
  onCancelEdit,
  onStartEdit,
  onDelete,
  onArchive,
  onExport,
  onResetChannel,
  isPinned = false,
  onPin,
}: SessionItemProps) {
  const t = useTranslations("chat");
  const tChannels = useTranslations("channels");
  const formatter = useFormatter();
  const editInputRef = useRef<HTMLInputElement>(null);
  const skipBlurRef = useRef(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // Sync with global store for real-time updates
  const syncedSession = useSessionData(initialSession.id);
  const hasActiveRun = useSessionHasActiveRun(initialSession.id);
  // Merge initial session with synced data
  // Only override fields that are present in syncedSession and relevant for display
  const session = {
    ...initialSession,
    ...(syncedSession
      ? {
          title: syncedSession.title,
          updatedAt: syncedSession.updatedAt,
          lastMessageAt: syncedSession.lastMessageAt,
          messageCount: syncedSession.messageCount,
          channelType: syncedSession.channelType,
        }
      : {}),
  };

  const effectiveChannel = session.channelType ?? session.metadata?.channelType;
  const messageCount = session.messageCount ?? 0;
  const sessionTimestamp = getSessionActivityTimestamp(session);

  const formatSessionDate = useCallback(
    (dateStr: string): string => {
      const date = parseAsUTC(dateStr);
      if (isNaN(date.getTime())) {
        return t("session.invalid");
      }
      const days = calendarDaysAgo(date);
      if (days === 0) {
        return formatter.dateTime(date, {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
      }
      if (days === 1) {
        return t("session.yesterday");
      }
      if (days < 7) {
        return formatter.dateTime(date, { weekday: "short" });
      }
      return formatter.dateTime(date, { month: "short", day: "numeric" });
    },
    [formatter, t]
  );

  const handleCopyLink = useCallback(() => {
    const characterId = session.characterId;
    const url = characterId
      ? `${window.location.origin}/chat/${characterId}?sessionId=${session.id}`
      : `${window.location.origin}/chat?sessionId=${session.id}`;
    void navigator.clipboard.writeText(url).then(() => {
      toast.success(t("sidebar.linkCopied"));
    });
  }, [session.characterId, session.id, t]);

  const handleInputBlur = useCallback(() => {
    if (skipBlurRef.current) {
      skipBlurRef.current = false;
      return;
    }
    onSaveEdit();
  }, [onSaveEdit]);

  const handleInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        onSaveEdit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        onCancelEdit();
      }
    },
    [onSaveEdit, onCancelEdit]
  );

  const handleActionMouseDown = useCallback(() => {
    skipBlurRef.current = true;
  }, []);

  const handleSaveClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onSaveEdit();
    },
    [onSaveEdit]
  );

  const handleCancelClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onCancelEdit();
    },
    [onCancelEdit]
  );

  return (
    <div
      className={cn(
        "group relative flex items-start gap-2.5 rounded-lg px-3 py-2.5 cursor-pointer border border-transparent",
        "transition-all duration-200 ease-out",
        isCurrent
          ? "bg-terminal-green/10 border-terminal-green/35 shadow-[0_1px_2px_rgba(0,0,0,0.22)]"
          : "hover:bg-terminal-dark/8 hover:border-terminal-border/40"
      )}
      role="button"
      aria-current={isCurrent ? "page" : undefined}
      tabIndex={0}
      onClick={() => {
        if (!isEditing) {
          onSwitch();
        }
      }}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !isEditing) {
          e.preventDefault();
          onSwitch();
        }
      }}
    >
      <div className="relative flex-shrink-0">
        {isPinned ? (
          <Pin className="h-4 w-4 text-terminal-amber" />
        ) : (
          <MessageCircle
            className={cn(
              "h-4 w-4 transition-colors duration-200",
              isCurrent ? "text-terminal-green" : "text-terminal-muted"
            )}
          />
        )}
        {hasActiveRun ? (
          <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
        ) : null}
      </div>
      <div className="flex-1 min-w-0 space-y-1">
        {isEditing ? (
          <div className="space-y-2" onClick={(event) => event.stopPropagation()}>
            <Input
              ref={editInputRef}
              type="text"
              value={editTitle}
              onChange={(event) => setEditTitle(event.target.value)}
              onKeyDown={handleInputKeyDown}
              onBlur={handleInputBlur}
              onClick={(event) => event.stopPropagation()}
              placeholder={t("sidebar.edit")}
              className="h-8 text-sm font-mono"
              autoFocus
            />
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-3 text-xs font-mono"
                onMouseDown={handleActionMouseDown}
                onClick={handleSaveClick}
              >
                {t("sidebar.save")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-3 text-xs font-mono"
                onMouseDown={handleActionMouseDown}
                onClick={handleCancelClick}
              >
                {t("sidebar.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p
              className={cn(
                "text-sm font-mono truncate transition-colors duration-200",
                isCurrent ? "text-terminal-dark font-medium" : "text-terminal-muted"
              )}
            >
              {session.title || t("session.untitled")}
            </p>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs font-mono text-terminal-muted/70 min-h-[16px]">
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {formatSessionDate(sessionTimestamp)}
              </span>
              {messageCount > 0 ? (
                <span>{t("sidebar.messageCount", { count: messageCount })}</span>
              ) : null}
              {effectiveChannel ? (
                <Badge className="border border-terminal-dark/10 bg-terminal-cream/80 px-2 py-0.5 text-[10px] font-mono text-terminal-dark">
                  {(() => {
                    const Icon = CHANNEL_TYPE_ICONS[effectiveChannel];
                    return (
                      <>
                        <Icon className="mr-1 h-3 w-3" />
                        {tChannels(`types.${effectiveChannel}`)}
                      </>
                    );
                  })()}
                </Badge>
              ) : null}
              {session.metadata?.workspaceInfo?.branch && (
                <Badge
                  className="border border-terminal-dark/10 bg-emerald-50/80 px-2 py-0.5 text-[10px] font-mono text-emerald-700 gap-1 cursor-default"
                >
                  <GitBranch className="h-2.5 w-2.5" />
                  {session.metadata.workspaceInfo.branch.replace(/^(feature|fix|chore|bugfix|hotfix)\//, "").slice(0, 20)}
                </Badge>
              )}
              {session.metadata?.workspaceInfo?.prNumber && session.metadata?.workspaceInfo?.prUrl && (
                <a
                  className="inline-flex items-center gap-1 border border-blue-200 bg-blue-50/80 px-2 py-0.5 text-[10px] font-mono text-blue-700 rounded-md cursor-pointer hover:bg-blue-100/80"
                  href={session.metadata.workspaceInfo.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ExternalLink className="h-2.5 w-2.5" />
                  PR #{session.metadata.workspaceInfo.prNumber}
                </a>
              )}
            </div>
          </>
        )}
      </div>
      {!isEditing ? (
        mounted ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t("sidebar.moreOptions")}
                title={t("sidebar.moreOptions")}
                className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 text-terminal-muted hover:text-terminal-green hover:bg-terminal-green/10"
                onClick={(event) => event.stopPropagation()}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
              {onPin ? (
                <DropdownMenuItem onSelect={onPin}>
                  {isPinned ? (
                    <PinOff className="h-3.5 w-3.5" />
                  ) : (
                    <Pin className="h-3.5 w-3.5" />
                  )}
                  {isPinned ? t("sidebar.unpin") : t("sidebar.pin")}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onSelect={onStartEdit}>
                <Pencil className="h-3.5 w-3.5" />
                {t("sidebar.rename")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onExport("markdown")}>
                <Download className="h-3.5 w-3.5" />
                {t("sidebar.exportMarkdown")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onExport("json")}>
                <Download className="h-3.5 w-3.5" />
                {t("sidebar.exportJson")}
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href={`/usage?sessionId=${session.id}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                  <BarChart2 className="h-3.5 w-3.5" />
                  {t("sidebar.viewAnalytics")}
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={handleCopyLink}>
                <Link2 className="h-3.5 w-3.5" />
                {t("sidebar.copyLink")}
              </DropdownMenuItem>
              {effectiveChannel ? (
                <DropdownMenuItem onSelect={onResetChannel}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t("sidebar.resetChannel")}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              {onArchive ? (
                <DropdownMenuItem onSelect={onArchive}>
                  <Archive className="h-3.5 w-3.5" />
                  {t("sidebar.archive")}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                className="text-red-600 hover:!text-red-600"
                onSelect={onDelete}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("sidebar.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("sidebar.moreOptions")}
            title={t("sidebar.moreOptions")}
            className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 text-terminal-muted"
            disabled
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        )
      ) : null}
    </div>
  );
}
