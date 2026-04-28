"use client";

import type { FC } from "react";
import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { AlertTriangleIcon, Loader2Icon, ZapIcon } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import type { ContextStatusInfo } from "@/lib/hooks/use-context-status";

interface ContextWindowIndicatorProps {
  status: ContextStatusInfo | null;
  isLoading: boolean;
  onCompact?: () => Promise<{ success: boolean; compacted: boolean }>;
  isCompacting?: boolean;
  /** Compact mode for inline display (e.g. in composer). */
  compact?: boolean;
}

/**
 * Visual indicator for context window usage.
 *
 * Shows a progress bar + percentage that changes colour by status:
 * - safe → green
 * - warning → amber
 * - critical → orange
 * - exceeded → red
 *
 * When status is warning/critical/exceeded, shows a compact-now action.
 */
export const ContextWindowIndicator: FC<ContextWindowIndicatorProps> = ({
  status,
  isLoading,
  onCompact,
  isCompacting = false,
  compact: compactMode = false,
}) => {
  const t = useTranslations("chat.contextWindow");

  // Always render a stable-height container to prevent layout shift.
  // When there's nothing to show, render an invisible placeholder.
  if (!status && !isLoading) {
    return <div className="h-3" aria-hidden />;
  }

  // While loading with no previous status, show a placeholder matching loaded height
  if (isLoading && !status) {
    return (
      <div className="flex h-3 items-center gap-1.5 text-[10px] font-mono text-terminal-muted/30">
        <div className="w-12 h-1 rounded-full bg-terminal-dark/5" />
        <span className="tabular-nums">—</span>
      </div>
    );
  }

  if (!status) return <div className="h-3" aria-hidden />;

  const percentage = Math.min(status.percentage, 100);
  const statusKey = status.status;
  const decisionMaxTokens = status.maxInputTokens ?? status.maxTokens;
  const warningPct = Math.round((status.thresholds.warning / decisionMaxTokens) * 100);
  const criticalPct = Math.round((status.thresholds.critical / decisionMaxTokens) * 100);
  const hardPct = Math.round((status.thresholds.hardLimit / decisionMaxTokens) * 100);
  const thresholdsLabel = t("indicator.thresholdsLabel", { warn: warningPct, crit: criticalPct, hard: hardPct });

  const barColor = {
    safe: "bg-terminal-green",
    warning: "bg-amber-500",
    critical: "bg-orange-500",
    exceeded: "bg-red-500",
  }[statusKey];

  const textColor = {
    safe: "text-terminal-muted/60",
    warning: "text-amber-600",
    critical: "text-orange-600",
    exceeded: "text-red-600",
  }[statusKey];

  const showAction = statusKey !== "safe" && onCompact;

  const tooltipText = t("indicator.tooltip", {
    current: status.formatted.current,
    max: status.formatted.max,
    percentage: status.formatted.percentage,
  });

  if (compactMode) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className={cn("flex items-center gap-1.5 cursor-default", textColor)}>
            {/* Micro progress bar */}
            <div className="w-12 h-1 rounded-full bg-terminal-dark/10 overflow-hidden">
              <div
                className={cn("h-full rounded-full transition-all duration-500", barColor)}
                style={{ width: `${percentage}%` }}
              />
            </div>
            <span className="text-[10px] font-mono tabular-nums">
              {status.formatted.percentage}
            </span>
            <span className="text-[9px] font-mono text-terminal-muted/60 tabular-nums">
              {thresholdsLabel}
            </span>
            {statusKey === "exceeded" && (
              <AlertTriangleIcon className="size-3 text-red-500" />
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          className="bg-terminal-dark text-terminal-cream font-mono text-xs max-w-xs"
        >
          <p>{tooltipText}</p>
          <p className="mt-1 text-terminal-cream/80">
            {t("indicator.thresholdsTooltip", { thresholds: thresholdsLabel })}
          </p>
          {showAction && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-1 h-6 px-2 text-[10px] text-terminal-cream hover:text-terminal-green hover:bg-terminal-green/20"
              onClick={(e) => {
                e.stopPropagation();
                onCompact();
              }}
              disabled={isCompacting}
            >
              {isCompacting ? (
                <Loader2Icon className="size-3 animate-spin mr-1" />
              ) : (
                <ZapIcon className="size-3 mr-1" />
              )}
              {t("indicator.compactNow")}
            </Button>
          )}
        </TooltipContent>
      </Tooltip>
    );
  }

  // Full mode — used in sidebar or header
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className={cn("text-[10px] font-mono", textColor)}>
          {t(`status.${statusKey}`, { percentage: status.formatted.percentage })}
        </span>
        {isLoading && <Loader2Icon className="size-3 animate-spin text-terminal-muted/50" />}
      </div>

      {/* Progress bar */}
      <div className="w-full h-1.5 rounded-full bg-terminal-dark/10 overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all duration-500", barColor)}
          style={{ width: `${percentage}%` }}
        />
      </div>

      <div className="flex items-center justify-between text-[10px] font-mono text-terminal-muted/50">
        <span>{status.formatted.current} / {status.formatted.max}</span>
        <span className="tabular-nums">{thresholdsLabel}</span>
        {showAction && (
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "h-5 px-1.5 text-[10px]",
              statusKey === "exceeded"
                ? "text-red-600 hover:text-red-700 hover:bg-red-50"
                : "text-amber-600 hover:text-amber-700 hover:bg-amber-50"
            )}
            onClick={() => onCompact()}
            disabled={isCompacting}
          >
            {isCompacting ? (
              <Loader2Icon className="size-3 animate-spin mr-1" />
            ) : (
              <ZapIcon className="size-3 mr-1" />
            )}
            {t("indicator.compactNow")}
          </Button>
        )}
      </div>
    </div>
  );
};
