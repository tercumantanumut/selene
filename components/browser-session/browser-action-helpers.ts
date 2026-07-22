/**
 * Shared browser-action utilities used by both ChromiumWorkspaceToolUI
 * and BrowserSessionViewer.
 */

import {
  Globe,
  CursorClick,
  TextT,
  TreeStructure,
  Code,
  Eye,
  X,
  Play,
  ArrowRight,
  ArrowClockwise,
} from "@phosphor-icons/react";

// ─── Action icon mapping ──────────────────────────────────────────────────────

const ACTION_ICONS: Record<string, typeof Globe> = {
  open: Globe,
  navigate: ArrowRight,
  click: CursorClick,
  type: TextT,
  snapshot: TreeStructure,
  extract: Eye,
  replay: Play,
  evaluate: Code,
  setViewport: Eye,
  resetViewport: ArrowClockwise,
  close: X,
};

export function getActionIcon(action: string) {
  return ACTION_ICONS[action] ?? Globe;
}

export function getActionLabel(action: string): string {
  const labels: Record<string, string> = {
    open: "Open",
    navigate: "Navigate",
    click: "Click",
    type: "Type",
    snapshot: "Snapshot",
    extract: "Extract",
    evaluate: "Evaluate",
    setViewport: "Set Viewport",
    resetViewport: "Reset Viewport",
    close: "Close",
    replay: "Replay",
  };
  return labels[action] ?? action;
}

export function truncateUrl(url: string, maxLen: number): string {
  try {
    const u = new URL(url);
    const display = u.hostname + u.pathname;
    return display.length > maxLen ? display.slice(0, maxLen) + "..." : display;
  } catch {
    return url.slice(0, maxLen);
  }
}
