"use client";

import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { ChevronDown, ChevronRight, Terminal, Check, X, Clock, FileText, FilePlus, FileMinus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { TerminalBlock, TerminalPrompt, TerminalOutput } from "./terminal-prompt";
import { useToolExpansion } from "@/components/assistant-ui/tool-expansion-context";
import type { InlineDiffPayload, InlineDiffFile } from "@/lib/command-execution/types";

interface CommandOutputProps {
    /** The command that was executed */
    command: string;
    /** Command arguments */
    args?: string[];
    /** Working directory */
    cwd?: string;
    /** Standard output from the command */
    stdout?: string;
    /** Standard error from the command */
    stderr?: string;
    /** Optional inline diff payload for apply_patch-style edits */
    inlineDiff?: string | InlineDiffPayload;
    /** Exit code (null if process was killed) */
    exitCode?: number | null;
    /** Execution time in milliseconds */
    executionTime?: number;
    /** Whether the command was successful */
    success?: boolean;
    /** Error message if execution failed */
    error?: string;
    /** Log ID for persistent storage */
    logId?: string;
    /** Whether the output was truncated in context */
    isTruncated?: boolean;
    /** Whether the output should start collapsed */
    defaultCollapsed?: boolean;
    /** CSS class for the container */
    className?: string;
}

function StatusIndicator({ success, error }: { success?: boolean; error?: string }) {
    const t = useTranslations("assistantUi.commandOutput");

    if (error) {
        return (
            <span className="flex items-center gap-1 text-destructive">
                <X className="h-3.5 w-3.5" />
                <span className="text-xs">{t("error")}</span>
            </span>
        );
    }

    if (success) {
        return (
            <span className="flex items-center gap-1 text-terminal-green">
                <Check className="h-3.5 w-3.5" />
                <span className="text-xs">{t("success")}</span>
            </span>
        );
    }

    return (
        <span className="flex items-center gap-1 text-terminal-amber">
            <Clock className="h-3.5 w-3.5" />
            <span className="text-xs">{t("running")}</span>
        </span>
    );
}

function getPatchBody(patchText: string): string[] {
    return patchText
        .replace(/\r\n/g, "\n")
        .split("\n")
        .filter((line) => line.length > 0)
        .filter((line) => !line.startsWith("*** Begin Patch") && !line.startsWith("*** End Patch"));
}

/** Check if inlineDiff is the structured payload vs raw string */
function isStructuredDiff(diff: string | InlineDiffPayload): diff is InlineDiffPayload {
    return typeof diff === "object" && diff !== null && "files" in diff;
}

/** Parse line numbers from unified diff hunk headers like @@ -1,3 +1,5 @@ */
interface DiffLineState {
    oldLine: number;
    newLine: number;
}

function parseHunkHeader(line: string): DiffLineState | null {
    const match = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (!match) return null;
    return { oldLine: parseInt(match[1], 10), newLine: parseInt(match[2], 10) };
}

/** Render a single diff's lines with line-number gutters */
function DiffLines({ diffText }: { diffText: string }) {
    const rawLines = diffText.replace(/\r\n/g, "\n").split("\n");
    while (rawLines.at(-1) === "") {
        rawLines.pop();
    }

    const lines = rawLines.filter((line) => {
        // Skip unified diff file headers (--- a/file, +++ b/file, Index:, diff --git)
        if (line.startsWith("---") || line.startsWith("+++")) return false;
        if (line.startsWith("Index:") || line.startsWith("diff --git")) return false;
        if (line.startsWith("===")) return false;
        return true;
    });

    if (lines.length === 0) return null;

    let state: DiffLineState = { oldLine: 1, newLine: 1 };

    return (
        <div className="font-mono text-xs">
            {lines.map((line, index) => {
                const isHunkHeader = line.startsWith("@@");
                const isNoNewlineMarker = line === "\\ No newline at end of file";
                const isAdd = line.startsWith("+");
                const isDelete = line.startsWith("-");

                if (isHunkHeader) {
                    const parsed = parseHunkHeader(line);
                    if (parsed) state = parsed;
                }

                let oldLineNum = "";
                let newLineNum = "";

                if (isHunkHeader || isNoNewlineMarker) {
                    // Metadata rows do not consume old or new file lines.
                } else if (isAdd) {
                    newLineNum = String(state.newLine);
                    state = { ...state, newLine: state.newLine + 1 };
                } else if (isDelete) {
                    oldLineNum = String(state.oldLine);
                    state = { ...state, oldLine: state.oldLine + 1 };
                } else {
                    // Context line
                    oldLineNum = String(state.oldLine);
                    newLineNum = String(state.newLine);
                    state = { oldLine: state.oldLine + 1, newLine: state.newLine + 1 };
                }

                return (
                    <div
                        key={index}
                        className={cn(
                            "flex items-start border-b border-terminal-border/10 last:border-b-0",
                            isAdd && "bg-green-500/10 text-green-200",
                            isDelete && "bg-red-500/10 text-red-200",
                            isHunkHeader && "bg-blue-500/10 text-blue-200",
                            !isAdd && !isDelete && !isHunkHeader && "text-terminal-text/80",
                        )}
                    >
                        {/* Line number gutters */}
                        <span className="w-10 shrink-0 text-right pr-1 text-terminal-text/30 select-none border-r border-terminal-border/20 py-0.5 tabular-nums">
                            {oldLineNum}
                        </span>
                        <span className="w-10 shrink-0 text-right pr-1 text-terminal-text/30 select-none border-r border-terminal-border/20 py-0.5 tabular-nums">
                            {newLineNum}
                        </span>
                        {/* Change indicator */}
                        <span className="w-5 shrink-0 text-center text-terminal-text/40 py-0.5 select-none">
                            {isAdd ? "+" : isDelete ? "−" : isHunkHeader ? "@@" : " "}
                        </span>
                        {/* Content */}
                        <span className="flex-1 whitespace-pre-wrap break-all py-0.5 pr-3">
                            {isHunkHeader ? line : (isAdd || isDelete ? line.slice(1) : line)}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}

/** Icon for file operation type */
function FileOperationIcon({ operation }: { operation: InlineDiffFile["operation"] }) {
    switch (operation) {
        case "add":
            return <FilePlus className="h-3.5 w-3.5 text-green-400" />;
        case "delete":
            return <FileMinus className="h-3.5 w-3.5 text-red-400" />;
        default:
            return <FileText className="h-3.5 w-3.5 text-blue-400" />;
    }
}

/** Collapsible file section for structured diffs */
function FileDiffSection({ file, defaultExpanded }: { file: InlineDiffFile; defaultExpanded: boolean }) {
    const [isExpanded, setIsExpanded] = useState(defaultExpanded);

    return (
        <div className="border border-terminal-border/30 rounded-md overflow-hidden">
            {/* File header */}
            <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="w-full flex items-center gap-2 px-3 py-1.5 bg-terminal-bg/60 hover:bg-terminal-bg/80 transition-colors text-left"
            >
                {isExpanded ? (
                    <ChevronDown className="h-3.5 w-3.5 text-terminal-text/50 shrink-0" />
                ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-terminal-text/50 shrink-0" />
                )}
                <FileOperationIcon operation={file.operation} />
                <span className="font-mono text-xs text-terminal-text/90 truncate">
                    {file.path}
                </span>
                <span className={cn(
                    "text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ml-auto shrink-0",
                    file.operation === "add" && "bg-green-500/15 text-green-300",
                    file.operation === "delete" && "bg-red-500/15 text-red-300",
                    file.operation === "modify" && "bg-blue-500/15 text-blue-300",
                )}>
                    {file.operation}
                </span>
            </button>
            {/* File diff content */}
            {isExpanded && (
                <div className="max-h-80 overflow-auto border-t border-terminal-border/20">
                    <DiffLines diffText={file.diff} />
                </div>
            )}
        </div>
    );
}

/** Structured diff preview with per-file grouping */
function StructuredDiffPreview({ payload }: { payload: InlineDiffPayload }) {
    if (payload.files.length === 0) {
        // Fall back to raw patch display
        return <LegacyPatchPreview patchText={payload.rawPatch} />;
    }

    return (
        <div className="space-y-1">
            <div className="text-xs text-terminal-text/40 uppercase tracking-wide pl-6 flex items-center gap-2">
                Diff
                <span className="text-terminal-text/25">
                    {payload.files.length} file{payload.files.length !== 1 ? "s" : ""}
                </span>
            </div>
            <div className="mx-6 space-y-1.5">
                {payload.files.map((file) => (
                    <FileDiffSection
                        key={file.path}
                        file={file}
                        defaultExpanded={payload.files.length <= 3}
                    />
                ))}
            </div>
        </div>
    );
}

/** Legacy flat patch preview (fallback for raw string diffs) */
function LegacyPatchPreview({ patchText }: { patchText: string }) {
    const lines = getPatchBody(patchText);

    if (lines.length === 0) return null;

    return (
        <div className="space-y-1">
            <div className="text-xs text-terminal-text/40 uppercase tracking-wide pl-6">Patch</div>
            <div className="mx-6 overflow-hidden rounded-md border border-terminal-border/40 bg-terminal-bg/40">
                <div className="max-h-80 overflow-auto font-mono text-xs">
                    {lines.map((line, index) => {
                        const isAdd = line.startsWith("+") && !line.startsWith("+++");
                        const isDelete = line.startsWith("-") && !line.startsWith("---");
                        const isMeta = line.startsWith("@@") || line.startsWith("*** ");

                        return (
                            <div
                                key={`${index}-${line}`}
                                className={cn(
                                    "flex items-start gap-3 px-3 py-1.5 whitespace-pre-wrap break-all border-b border-terminal-border/20 last:border-b-0",
                                    isAdd && "bg-green-500/10 text-green-200",
                                    isDelete && "bg-red-500/10 text-red-200",
                                    isMeta && "bg-blue-500/10 text-blue-200",
                                    !isAdd && !isDelete && !isMeta && "text-terminal-text/80",
                                )}
                            >
                                <span className="w-4 shrink-0 text-terminal-text/40">
                                    {isAdd ? "+" : isDelete ? "-" : isMeta ? "@" : " "}
                                </span>
                                <span className="flex-1">{line}</span>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

function InlinePatchPreview({ patchText }: { patchText: string | InlineDiffPayload }) {
    if (isStructuredDiff(patchText)) {
        return <StructuredDiffPreview payload={patchText} />;
    }
    return <LegacyPatchPreview patchText={patchText} />;
}

/**
 * CommandOutput component
 *
 * Displays command execution results in a terminal-styled block.
 * Features:
 * - Collapsible output (auto-collapse successful commands)
 * - Status indicators (success/error/running)
 * - Execution time display
 * - Stdout/stderr separation with proper styling
 */
export function CommandOutput({
    command,
    args = [],
    cwd,
    stdout,
    stderr,
    inlineDiff,
    exitCode,
    executionTime,
    success,
    error,
    logId,
    isTruncated,
    defaultCollapsed,
    className,
}: CommandOutputProps) {
    // Auto-collapse successful commands with no stderr
    const t = useTranslations("assistantUi.commandOutput");
    const shouldAutoCollapse = defaultCollapsed ?? (success && !stderr && (stdout?.length ?? 0) > 500);
    const [isCollapsed, setIsCollapsed] = useState(shouldAutoCollapse);

    // React to global expand/collapse signal
    const expansionCtx = useToolExpansion();
    const lastSignalRef = useRef(0);
    useEffect(() => {
      if (!expansionCtx || expansionCtx.signal.counter === 0) return;
      if (expansionCtx.signal.counter === lastSignalRef.current) return;
      lastSignalRef.current = expansionCtx.signal.counter;
      // Note: isCollapsed is the inverse of expanded
      setIsCollapsed(expansionCtx.signal.mode !== "expand");
    }, [expansionCtx?.signal]);

    const fullCommand = [command, ...args].join(" ");
    const shouldHidePlainSuccessOutput = command === "apply_patch" && !!inlineDiff && stdout?.trim() == "Done!";
    const hasOutput = stdout || stderr || error || inlineDiff;

    return (
        <TerminalBlock className={cn("space-y-2", className)}>
            {/* Header with command and status */}
            <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                    <TerminalPrompt
                        symbol="$"
                        prefix={cwd ? cwd.split(/[/\\]/).pop() : undefined}
                        animate={false}
                    >
                        <span className="break-all">{fullCommand}</span>
                    </TerminalPrompt>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                    {/* Execution time */}
                    {executionTime !== undefined && (
                        <span className="text-xs text-terminal-text/60">
                            {executionTime < 1000
                                ? `${executionTime}ms`
                                : `${(executionTime / 1000).toFixed(1)}s`}
                        </span>
                    )}

                    {/* Status indicator */}
                    <StatusIndicator success={success} error={error} />

                    {/* Collapse toggle */}
                    {hasOutput && (
                        <button
                            onClick={() => setIsCollapsed(!isCollapsed)}
                            className="text-terminal-text/60 hover:text-terminal-text transition-colors p-1 -m-1"
                            aria-label={isCollapsed ? t("expandOutput") : t("collapseOutput")}
                        >
                            {isCollapsed ? (
                                <ChevronRight className="h-4 w-4" />
                            ) : (
                                <ChevronDown className="h-4 w-4" />
                            )}
                        </button>
                    )}
                </div>
            </div>

            {/* Exit code if not 0 or null */}
            {exitCode !== null && exitCode !== undefined && exitCode !== 0 && (
                <div className="text-xs text-terminal-amber pl-6">
                    {t("exitCode")} {exitCode}
                </div>
            )}

            {/* Output section */}
            {hasOutput && !isCollapsed && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="space-y-2 pt-2 border-t border-terminal-border/30"
                >
                    {/* Error message */}
                    {error && (
                        <TerminalOutput type="error" className="whitespace-pre-wrap">
                            {error}
                        </TerminalOutput>
                    )}

                    {inlineDiff && <InlinePatchPreview patchText={inlineDiff} />}

                    {/* Stdout */}
                    {stdout && stdout.trim() && !shouldHidePlainSuccessOutput && (
                        <div className="space-y-1">
                            <div className="text-xs text-terminal-text/40 uppercase tracking-wide pl-6">
                                {t("output")}
                            </div>
                            <TerminalOutput className="whitespace-pre-wrap font-mono text-xs max-h-96 overflow-auto">
                                {stdout}
                            </TerminalOutput>
                        </div>
                    )}

                    {/* Stderr (only show if there's actual content) */}
                    {stderr && stderr.trim() && (
                        <div className="space-y-1">
                            <div className={cn(
                                "text-xs uppercase tracking-wide pl-6",
                                success ? "text-terminal-text/40" : "text-destructive/60"
                            )}>
                                {t("standardError")}{success ? t("stdErrWarning") : ""}
                            </div>
                            <TerminalOutput
                                type={success ? "default" : "error"}
                                className="whitespace-pre-wrap font-mono text-xs max-h-48 overflow-auto"
                            >
                                {stderr}
                            </TerminalOutput>
                        </div>
                    )}

                    {/* Truncation warning banner */}
                    {isTruncated && logId && (
                        <div className="mx-6 my-2 p-3 rounded-md bg-terminal-amber/10 border border-terminal-amber/30 flex items-center justify-between gap-4">
                            <div className="flex items-center gap-2 text-terminal-amber">
                                <Clock className="h-4 w-4 shrink-0" />
                                <span className="text-xs font-medium">
                                    {t("truncated", { logId })}
                                </span>
                            </div>
                            <button
                                onClick={() => {
                                    navigator.clipboard.writeText(`executeCommand({ command: "readLog", logId: "${logId}" })`);
                                }}
                                className="text-[10px] uppercase tracking-wider bg-terminal-amber/20 hover:bg-terminal-amber/30 text-terminal-amber px-2 py-1 rounded transition-colors border border-terminal-amber/20 shrink-0"
                            >
                                {t("copyRetrieval")}
                            </button>
                        </div>
                    )}
                </motion.div>
            )}

            {/* Collapsed indicator */}
            {hasOutput && isCollapsed && (
                <button
                    onClick={() => setIsCollapsed(false)}
                    className="text-xs text-terminal-text/40 hover:text-terminal-text/60 transition-colors pl-6"
                >
                    {t("clickToExpand")}
                </button>
            )}
        </TerminalBlock>
    );
}

/**
 * Inline command status for use in chat messages
 */
function CommandStatus({
    command,
    success,
    executionTime,
    error,
}: Pick<CommandOutputProps, "command" | "success" | "executionTime" | "error">) {
    return (
        <div className="inline-flex items-center gap-2 px-2 py-1 rounded bg-terminal-bg/50 border border-terminal-border text-sm font-mono">
            <Terminal className="h-3.5 w-3.5 text-terminal-green" />
            <span className="text-terminal-text/80 truncate max-w-[200px]">{command}</span>
            <StatusIndicator success={success} error={error} />
            {executionTime !== undefined && (
                <span className="text-terminal-text/40 text-xs">
                    {executionTime < 1000 ? `${executionTime}ms` : `${(executionTime / 1000).toFixed(1)}s`}
                </span>
            )}
        </div>
    );
}
