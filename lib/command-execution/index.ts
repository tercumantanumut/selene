/**
 * Command Execution Module
 * 
 * Sandboxed command execution for Selene.
 * Allows AI tools to run shell commands safely within synced directories.
 */

// Export types
export type {
    ExecuteResult,
    ExecuteCommandToolOptions,
    ExecuteCommandInput,
    ExecuteCommandToolResult,
} from "./types";

// Export executor functions
export {
    executeCommandWithValidation,
    startBackgroundProcess,
    getBackgroundProcess,
    markBackgroundProcessObserved,
    killBackgroundProcess,
    listBackgroundProcesses,
    cleanupBackgroundProcesses,
} from "./executor";
