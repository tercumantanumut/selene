/**
 * Whether the app window can currently be seen.
 *
 * In Electron the renderer runs with backgroundThrottling disabled, which also
 * keeps `document.hidden` false while the window is minimized or hidden. The
 * main process reports those states over IPC instead; outside Electron this
 * falls back to the Page Visibility API.
 */
import { getElectronAPI } from "@/lib/electron/types";

let electronHidden = false;
let initialized = false;
const listeners = new Set<(hidden: boolean) => void>();

function ensureInitialized(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  getElectronAPI()?.window.onHiddenChanged?.((hidden) => {
    electronHidden = hidden;
    for (const listener of listeners) listener(isAppHidden());
  });
}

export function isAppHidden(): boolean {
  ensureInitialized();
  return electronHidden || (typeof document !== "undefined" && document.hidden);
}

/** Notified when the Electron window is minimized/hidden or shown again. */
export function onAppHiddenChange(listener: (hidden: boolean) => void): () => void {
  ensureInitialized();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
