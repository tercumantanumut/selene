"use client";

import { useState, type FC, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { StandaloneMarkdown } from "@/components/ui/standalone-markdown";
import { cn } from "@/lib/utils";

type MarkdownFilePreviewMode = "preview" | "source";

interface MarkdownFilePreviewProps {
  content: string;
  sourceView: ReactNode;
  defaultMode?: MarkdownFilePreviewMode;
  sourceLabel?: string;
  previewNotice?: string;
  className?: string;
  previewClassName?: string;
}

export const MarkdownFilePreview: FC<MarkdownFilePreviewProps> = ({
  content,
  sourceView,
  defaultMode = "preview",
  sourceLabel,
  previewNotice,
  className,
  previewClassName,
}) => {
  const t = useTranslations("assistantUi.markdownFilePreview");
  const hasPreviewContent = content.trim().length > 0;
  const [mode, setMode] = useState<MarkdownFilePreviewMode>(
    hasPreviewContent ? defaultMode : "source"
  );
  const activeMode = hasPreviewContent ? mode : "source";
  const resolvedSourceLabel = sourceLabel ?? t("source");

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex overflow-hidden rounded-md border border-border bg-terminal-cream/60 text-[11px] font-mono shadow-sm dark:bg-terminal-dark/[0.04]">
          <button
            type="button"
            onClick={() => setMode("preview")}
            disabled={!hasPreviewContent}
            className={cn(
              "px-2.5 py-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50",
              activeMode === "preview"
                ? "bg-terminal-dark/10 text-terminal-dark dark:bg-terminal-dark/[0.08]"
                : "text-terminal-muted hover:bg-accent/30"
            )}
          >
            {t("preview")}
          </button>
          <button
            type="button"
            onClick={() => setMode("source")}
            className={cn(
              "border-l border-border px-2.5 py-1 transition-colors",
              activeMode === "source"
                ? "bg-terminal-dark/10 text-terminal-dark dark:bg-terminal-dark/[0.08]"
                : "text-terminal-muted hover:bg-accent/30"
            )}
          >
            {resolvedSourceLabel}
          </button>
        </div>

        {activeMode === "preview" && previewNotice ? (
          <span className="text-[11px] text-terminal-muted">
            {previewNotice}
          </span>
        ) : null}
      </div>

      {activeMode === "preview" ? (
        <div
          className={cn(
            "max-h-96 overflow-y-auto rounded bg-terminal-dark/5 p-3 text-sm leading-6 text-terminal-dark dark:bg-terminal-dark/[0.06] dark:text-terminal-dark/90",
            previewClassName
          )}
        >
          <StandaloneMarkdown content={content} />
        </div>
      ) : (
        sourceView
      )}
    </div>
  );
};
