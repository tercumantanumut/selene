/**
 * Observability Cleanup Job
 * 
 * Background job to report stale agent runs that may need recovery.
 * It must not fail running long-lived agents based on timestamp age alone.
 */

import { hasPendingInteractiveWait } from "@/lib/interactive-tool-bridge";
import { findStaleRuns } from "./queries";

// Default cleanup interval: 15 minutes
const DEFAULT_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

// Stale threshold: 30 minutes
const STALE_THRESHOLD_MINUTES = 30;

let cleanupIntervalId: NodeJS.Timeout | null = null;
let isRunning = false;

/**
 * Run cleanup and log results
 */
async function runCleanup(): Promise<void> {
  if (isRunning) {
    console.log("[ObservabilityCleanup] Cleanup already running, skipping");
    return;
  }

  isRunning = true;
  console.log("[ObservabilityCleanup] Starting stale run cleanup...");

  try {
    const staleRuns = await findStaleRuns(STALE_THRESHOLD_MINUTES);
    const staleRunIds: string[] = [];
    const interactiveWaitRunIds: string[] = [];

    for (const run of staleRuns) {
      if (hasPendingInteractiveWait(run.sessionId)) {
        interactiveWaitRunIds.push(run.id);
        continue;
      }
      staleRunIds.push(run.id);
    }

    if (staleRunIds.length > 0 || interactiveWaitRunIds.length > 0) {
      console.warn("[ObservabilityCleanup] Stale running runs detected; leaving them running for long-run recovery", {
        staleRunIds,
        interactiveWaitRunIds,
      });
    } else {
      console.log("[ObservabilityCleanup] No stale runs found");
    }
  } catch (error) {
    console.error("[ObservabilityCleanup] Error during cleanup:", error);
  } finally {
    isRunning = false;
  }
}

/**
 * Start the cleanup job scheduler
 */
export function startCleanupJob(intervalMs: number = DEFAULT_CLEANUP_INTERVAL_MS): void {
  if (cleanupIntervalId) {
    console.log("[ObservabilityCleanup] Cleanup job already running");
    return;
  }

  console.log(
    `[ObservabilityCleanup] Starting cleanup job (interval: ${intervalMs / 60000}m, report threshold: ${STALE_THRESHOLD_MINUTES}m)`
  );

  // Run immediately on start
  runCleanup().catch(console.error);

  // Schedule periodic cleanup
  cleanupIntervalId = setInterval(runCleanup, intervalMs);
}

/**
 * Stop the cleanup job scheduler
 */
function stopCleanupJob(): void {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
    console.log("[ObservabilityCleanup] Cleanup job stopped");
  }
}

