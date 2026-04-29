/**
 * Terminal Log Manager
 * 
 * Handles persistent storage of command execution outputs in the Electron userData directory.
 * Implements smart truncation (middle-truncation) for LLM context management.
 */

import * as fs from "fs";
import * as path from "path";
import { nanoid } from "nanoid";

/**
 * Configuration for log management
 */
const MAX_CONTEXT_LINES = 500; // Default max lines to keep in context (head + tail)

/**
 * Get the path to the terminal logs directory
 * Uses LOCAL_DATA_PATH (userData/data) which is set in electron/main.ts
 */
function getLogsDir(): string {
    const baseDir = process.env.LOCAL_DATA_PATH || path.join(process.cwd(), ".local-data", "data");
    const logsDir = path.join(baseDir, "logs", "terminal");
    
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }
    
    return logsDir;
}

/**
 * Save full output to a persistent log file
 * @param stdout - Full standard output
 * @param stderr - Full standard error
 * @returns Unique log ID
 */
export function saveTerminalLog(stdout: string, stderr: string): string {
    const logId = nanoid();
    return writeTerminalLog(logId, stdout, stderr);
}

/**
 * Persist output to an existing log file, or create one for the supplied ID.
 */
export function updateTerminalLog(logId: string, stdout: string, stderr: string): string {
    if (!logId) return saveTerminalLog(stdout, stderr);
    return writeTerminalLog(logId, stdout, stderr);
}

function writeTerminalLog(logId: string, stdout: string, stderr: string): string {
    const logsDir = getLogsDir();
    const logPath = path.join(logsDir, `${logId}.log`);

    const cleanStdout = stripAnsiCodes(stdout || "");
    const cleanStderr = stripAnsiCodes(stderr || "");
    const content = `=== STDOUT ===\n${cleanStdout}\n\n=== STDERR ===\n${cleanStderr}`;

    try {
        fs.writeFileSync(logPath, content, "utf8");
        return logId;
    } catch (error) {
        console.error(`[TerminalLogManager] Failed to save log ${logId}:`, error);
        return "";
    }
}

/**
 * Read a full log file by ID
 * @param logId - The log ID to retrieve
 * @returns Full log content or null if not found
 */
export function readTerminalLog(logId: string): string | null {
    if (!logId) return null;

    const logPath = path.join(getLogsDir(), `${logId}.log`);

    try {
        if (fs.existsSync(logPath)) {
            // Defensive sanitize for legacy logs that may still contain ANSI sequences.
            return stripAnsiCodes(fs.readFileSync(logPath, "utf8"));
        }
    } catch (error) {
        console.error(`[TerminalLogManager] Failed to read log ${logId}:`, error);
    }

    return null;
}

/**
 * Strip ANSI escape codes from terminal output
 * Removes color codes, cursor movements, and other terminal control sequences
 */
function stripAnsiCodes(text: string): string {
    // ANSI escape code regex pattern
    // Matches sequences like \x1b[0m, \x1b[1;31m, etc.
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Smart middle-truncation for terminal output
 * Keeps the head and tail of the output to preserve context and exit status.
 * Automatically strips ANSI escape codes for clean LLM consumption.
 */
export function truncateOutput(text: string, maxLines = MAX_CONTEXT_LINES): { 
    content: string; 
    isTruncated: boolean;
    originalLineCount: number;
} {
    if (!text) return { content: "", isTruncated: false, originalLineCount: 0 };
    
    // Strip ANSI codes first for clean output
    const cleanText = stripAnsiCodes(text);
    
    const lines = cleanText.split("\n");
    const originalLineCount = lines.length;
    
    if (originalLineCount <= maxLines) {
        return { content: cleanText, isTruncated: false, originalLineCount };
    }
    
    // Calculate head and tail counts based on maxLines
    const headCount = Math.ceil(maxLines / 2);
    const tailCount = Math.max(0, maxLines - headCount);
    
    const head = lines.slice(0, headCount);
    const tail = tailCount > 0 ? lines.slice(-tailCount) : [];
    
    const truncatedLineCount = originalLineCount - head.length - tail.length;
    
    const truncatedContent = [
        ...head,
        `... [TRUNCATED ${truncatedLineCount} LINES] ...`,
        ...tail
    ].join("\n");
    
    return { 
        content: truncatedContent, 
        isTruncated: true, 
        originalLineCount 
    };
}
