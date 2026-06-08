"use client";

import { cn } from "@/lib/utils";

const ADDITION_CLASSES =
  "text-emerald-700 bg-emerald-100/60 border-l-2 border-emerald-500 dark:text-emerald-200 dark:bg-emerald-500/[0.15] dark:border-emerald-400";
const DELETION_CLASSES =
  "text-red-700 bg-red-100/60 border-l-2 border-red-500 dark:text-red-200 dark:bg-red-500/[0.15] dark:border-red-400";
const NEUTRAL_CLASSES = "text-terminal-muted dark:text-terminal-muted/80";

function getDiffLineKind(line: string): "addition" | "deletion" | "neutral" {
  if (line.startsWith("+ ")) return "addition";
  if (line.startsWith("- ")) return "deletion";

  const numberedDiffMatch = line.match(/^\s*\d+\s+\|\s([+-])\s/);
  if (numberedDiffMatch?.[1] === "+") return "addition";
  if (numberedDiffMatch?.[1] === "-") return "deletion";

  return "neutral";
}

interface DiffStyledPreProps {
  /** Pre-split diff lines. Plain or line-numbered +/- entries get styled. */
  lines: string[];
  /** Wrap in the standard diff container div. Default true. */
  container?: boolean;
  /** Extra className for the outer container div. */
  className?: string;
}

/**
 * Shared styled diff renderer.
 * Applies green/red highlighting to added/removed lines.
 * Used by EditFileToolUI, ClaudeEditToolUI, ClaudeWriteToolUI, PatchFileToolUI.
 */
export function DiffStyledPre({ lines, container = true, className }: DiffStyledPreProps) {
  const pre = (
    <pre className="text-terminal-dark dark:text-terminal-dark/90 whitespace-pre-wrap break-all font-mono text-[11px]">
      {lines.map((line, i) => {
        const lineKind = getDiffLineKind(line);

        return (
          <span
            key={i}
            className={cn(
              "block rounded-sm px-1",
              lineKind === "addition" && ADDITION_CLASSES,
              lineKind === "deletion" && DELETION_CLASSES,
              lineKind === "neutral" && NEUTRAL_CLASSES
            )}
          >
            {line}
          </span>
        );
      })}
    </pre>
  );

  if (!container) return pre;

  return (
    <div className={cn("rounded bg-terminal-dark/5 dark:bg-terminal-dark/[0.06] p-2 overflow-x-auto", className)}>
      {pre}
    </div>
  );
}
