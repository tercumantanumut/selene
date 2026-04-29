import type { ChildProcess } from "node:child_process";
import { shutdownParakeetServer } from "@/lib/voice/parakeet-server";

// Shared process registry for local audio extraction work in this Node process.
const activeExtractionProcesses = new Set<ChildProcess>();

export function trackActiveExtractionProcess(child: ChildProcess): void {
  activeExtractionProcesses.add(child);
}

export function untrackActiveExtractionProcess(child: ChildProcess): void {
  activeExtractionProcesses.delete(child);
}

/**
 * Kill active extraction child processes and shut down the persistent Parakeet server.
 * Kept separate from transcription.ts so Electron startup does not load STT/provider code.
 */
export async function cleanupAllVoiceProcesses(): Promise<void> {
  for (const child of activeExtractionProcesses) {
    try {
      child.kill();
    } catch {}
  }
  activeExtractionProcesses.clear();

  await shutdownParakeetServer();
}
