/**
 * Command Execution Validator
 * 
 * Validates commands and paths for execution.
 * By default, command working directories are scoped to synced folders.
 * SELENE_UNSAFE_AGENT_PERMISSIONS=true relaxes that scope for local agents.
 */

import { resolve, normalize, sep, isAbsolute } from "path";
import type { ValidationResult } from "./types";
import { areUnsafeAgentPermissionsEnabled } from "@/lib/config/unsafe-agent-permissions";

const NETWORK_COMMANDS: string[] = [];

/**
 * Validate that a directory is within allowed synced folders
 */
export async function validateExecutionDirectory(
    cwd: string,
    allowedPaths: string[]
): Promise<ValidationResult> {
    // Must be an absolute path
    if (!isAbsolute(cwd)) {
        return {
            valid: false,
            error: "Execution directory must be an absolute path.",
        };
    }

    const normalizedCwd = normalize(cwd);

    if (areUnsafeAgentPermissionsEnabled()) {
        return {
            valid: true,
            resolvedPath: normalizedCwd,
        };
    }

    // Must have allowed paths unless unsafe mode explicitly widens local agent access.
    if (allowedPaths.length === 0) {
        return {
            valid: false,
            error: "No synced folders configured. Add synced folders to enable command execution.",
        };
    }

    // Check if within any allowed folder
    for (const allowedPath of allowedPaths) {
        const resolvedAllowed = resolve(allowedPath);
        const normalizedAllowed = normalize(resolvedAllowed);

        // Check if cwd is the allowed path or a subdirectory
        if (
            normalizedCwd === normalizedAllowed ||
            normalizedCwd.startsWith(normalizedAllowed + sep)
        ) {
            return {
                valid: true,
                resolvedPath: normalizedCwd,
            };
        }
    }

    return {
        valid: false,
        error: `Execution directory must be within synced folders. Allowed: ${allowedPaths.join(", ")}`,
    };
}

/**
 * Extract base command name from a path or command string
 */
function getBaseCommand(command: string): string {
    // Handle both forward and back slashes for cross-platform
    const parts = command.toLowerCase().split(/[\\/]/);
    const baseName = parts[parts.length - 1] || "";
    // Remove common extensions
    return baseName.replace(/\.(exe|cmd|bat|sh|ps1)$/i, "");
}

/**
 * Validate command for dangerous patterns
 */
export function validateCommand(
    command: string,
    args: string[],
    options?: { allowNetwork?: boolean }
): ValidationResult {
    const { allowNetwork = false } = options || {};

    // Check for empty command
    if (!command || command.trim() === "") {
        return {
            valid: false,
            error: "Command cannot be empty.",
        };
    }

    const baseCommand = getBaseCommand(command);

    // Check network commands (blocked by default)
    if (!allowNetwork && NETWORK_COMMANDS.some((cmd) => baseCommand === cmd)) {
        return {
            valid: false,
            error: `Network command '${command}' is blocked. Enable network commands in settings if needed.`,
        };
    }

    return { valid: true };
}

/**
 * Check if a command is in the blocklist (for quick checks)
 */
export function validateShellCommand(command: string): ValidationResult {
    const trimmed = command.trim();
    if (!trimmed) {
        return {
            valid: false,
            error: "Command cannot be empty.",
        };
    }

    return { valid: true };
}

export function isCommandBlocked(command: string): boolean {
    const baseCommand = getBaseCommand(command);
    return NETWORK_COMMANDS.some((cmd) => baseCommand === cmd);
}
