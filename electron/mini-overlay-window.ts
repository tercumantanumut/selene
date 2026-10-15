import { BrowserWindow, screen } from "electron";
import { debugLog, debugError } from "./debug-logger";
import { getSetting } from "@/lib/settings/settings-manager";
import { uiScaleToZoomFactor } from "@/lib/ui/ui-scale";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ShowOverlayOptions {
  /** Base URL of the embedded Next.js server (e.g. "http://localhost:3000"). */
  baseUrl: string;
  /** Absolute path to the preload script. */
  preloadPath: string;
  sessionId?: string;
  characterId?: string;
  screenshotUrl?: string;
}

// ---------------------------------------------------------------------------
// Singleton state (globalThis for hot-reload safety)
// ---------------------------------------------------------------------------

const G = globalThis as typeof globalThis & {
  __miniOverlayWindow?: BrowserWindow | null;
  __miniOverlayLoadPromise?: Promise<void> | null;
};

function getOverlayWindow(): BrowserWindow | null {
  const win = G.__miniOverlayWindow;
  if (!win || win.isDestroyed()) {
    return null;
  }
  // A window with crashed webContents is unusable — destroy it so the next
  // call creates a fresh one.
  if (win.webContents.isCrashed()) {
    debugLog("[MiniOverlay] webContents crashed — destroying stale window");
    try { win.destroy(); } catch {}
    setOverlayWindow(null);
    return null;
  }
  return win;
}

function setOverlayWindow(win: BrowserWindow | null): void {
  G.__miniOverlayWindow = win;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALLOWED_SCREENSHOT_SCHEMES = ["local-media:", "http:", "https:", "/api/"];

function buildOverlayUrl(opts: ShowOverlayOptions): string {
  // Use URL constructor to handle trailing slashes correctly
  const base = new URL("/mini-overlay", opts.baseUrl);
  if (opts.sessionId) base.searchParams.set("sessionId", opts.sessionId);
  if (opts.characterId) base.searchParams.set("characterId", opts.characterId);
  // Validate screenshotUrl before passing to renderer
  if (opts.screenshotUrl) {
    const isAllowed = ALLOWED_SCREENSHOT_SCHEMES.some((scheme) =>
      opts.screenshotUrl!.startsWith(scheme)
    );
    if (isAllowed) {
      base.searchParams.set("screenshotUrl", opts.screenshotUrl);
    } else {
      debugError("[MiniOverlay] Rejected screenshotUrl with disallowed scheme:", opts.screenshotUrl);
    }
  }
  return base.toString();
}

const OVERLAY_WIDTH = 480;
const OVERLAY_HEIGHT = 280;

function createOverlayWindow(opts: ShowOverlayOptions): BrowserWindow {
  const isMac = process.platform === "darwin";

  const win = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    fullscreenable: false,
    maximizable: false,
    show: false,
    roundedCorners: true,
    // macOS: use "panel" for floating behavior with native vibrancy
    ...(isMac
      ? {
          type: "panel" as const,
          hasShadow: true,
          vibrancy: "popover" as const,
          visualEffectState: "active" as const,
        }
      : {}),
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.setZoomFactor(uiScaleToZoomFactor(getSetting("uiScale")));

  // On macOS, the panel window type already floats above fullscreen apps and
  // appears across Spaces. Avoid setVisibleOnAllWorkspaces() here: Electron's
  // docs note that it can temporarily transform process type and hide the Dock,
  // which matches the regression where Selene disappeared from Dock/Cmd+Tab.

  // Position: top center of the primary display, 60 px from the top edge
  positionOverlayWindow(win);

  win.once("ready-to-show", () => {
    win.show();
    win.focus();
    debugLog("[MiniOverlay] Window ready-to-show — shown and focused");
  });

  win.on("closed", () => {
    debugLog("[MiniOverlay] Window closed");
    setOverlayWindow(null);
  });

  return win;
}

/**
 * Position the overlay at the top-center of the primary display.
 */
function positionOverlayWindow(win: BrowserWindow): void {
  const { workArea } = screen.getPrimaryDisplay();
  const x = Math.round(workArea.x + (workArea.width - OVERLAY_WIDTH) / 2);
  const y = workArea.y + 60;
  win.setPosition(x, y);
}

/**
 * Normalize overlay window state before showing.
 * Ensures the window is never fullscreen/maximized and has the correct size,
 * regardless of what happened to the main Selene window.
 */
function normalizeOverlayState(win: BrowserWindow): void {
  if (win.isFullScreen()) {
    debugLog("[MiniOverlay] Window was fullscreen — exiting fullscreen");
    win.setFullScreen(false);
  }
  if (win.isMaximized()) {
    debugLog("[MiniOverlay] Window was maximized — restoring");
    win.unmaximize();
  }
  // Restore intended size in case something changed it
  const [w, h] = win.getSize();
  if (w !== OVERLAY_WIDTH || h !== OVERLAY_HEIGHT) {
    debugLog(`[MiniOverlay] Size was ${w}x${h} — restoring to ${OVERLAY_WIDTH}x${OVERLAY_HEIGHT}`);
    win.setSize(OVERLAY_WIDTH, OVERLAY_HEIGHT);
  }
  positionOverlayWindow(win);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Show the mini overlay window.  Creates the BrowserWindow on the first call
 * and reuses it on subsequent calls.  Always loads the current URL so that
 * session / character / screenshot params are up to date.
 *
 * Serialized: if a load is already in progress, the second call waits for
 * it to complete rather than clobbering the first load.
 */
export async function showOverlay(opts: ShowOverlayOptions): Promise<void> {
  // Serialize concurrent calls — second hotkey press during load waits
  if (G.__miniOverlayLoadPromise) {
    return G.__miniOverlayLoadPromise;
  }

  G.__miniOverlayLoadPromise = (async () => {
    try {
      let win = getOverlayWindow();
      let isReused = !!win;
      if (!win) {
        debugLog("[MiniOverlay] Creating new overlay window");
        win = createOverlayWindow(opts);
        setOverlayWindow(win);
      } else {
        debugLog("[MiniOverlay] Reusing existing overlay window");
      }

      const url = buildOverlayUrl(opts);
      debugLog("[MiniOverlay] Loading URL:", url);

      try {
        await win.loadURL(url);
      } catch (loadErr) {
        // loadURL can fail if the renderer crashed, the window was destroyed
        // during navigation, or the URL is unreachable.  If we were reusing
        // an existing window, destroy it and create a fresh one.
        if (isReused) {
          debugError("[MiniOverlay] loadURL failed on reused window — recreating:", loadErr);
          try { win.destroy(); } catch {}
          setOverlayWindow(null);

          win = createOverlayWindow(opts);
          setOverlayWindow(win);
          isReused = false;
          await win.loadURL(url);  // let this throw if it fails again
        } else {
          throw loadErr;
        }
      }

      // Guard: window may have been destroyed during async loadURL
      if (win.isDestroyed()) {
        debugLog("[MiniOverlay] Window destroyed during loadURL — aborting");
        return;
      }

      // For reused windows, ready-to-show does not fire again after loadURL —
      // explicitly normalize state and show to ensure the hidden window becomes
      // visible without inheriting fullscreen/maximized state.
      if (isReused) {
        normalizeOverlayState(win);
        win.show();
        win.focus();
        debugLog("[MiniOverlay] Reused window normalized, shown and focused after loadURL");
      }
    } catch (err) {
      debugError("[MiniOverlay] Failed to show overlay:", err);
      // If we created a window but loadURL failed, destroy it so we don't
      // leave a blank/broken window around.
      const stale = getOverlayWindow();
      if (stale) {
        try { stale.destroy(); } catch {}
        setOverlayWindow(null);
        debugLog("[MiniOverlay] Destroyed window after load failure");
      }
      throw err;
    }
  })().finally(() => {
    G.__miniOverlayLoadPromise = null;
  });

  return G.__miniOverlayLoadPromise;
}

/**
 * Hide the overlay without destroying it so it can be shown again quickly.
 */
export function hideOverlay(): void {
  const win = getOverlayWindow();
  if (!win) return;
  win.hide();
  debugLog("[MiniOverlay] Window hidden");
}

/**
 * Return the current BrowserWindow instance, or null if it does not exist.
 */
export function getOverlay(): BrowserWindow | null {
  return getOverlayWindow();
}

/**
 * Destroy the overlay window and release all associated resources.
 */
export function destroyMiniOverlay(): void {
  const win = G.__miniOverlayWindow;
  if (!win || win.isDestroyed()) {
    setOverlayWindow(null);
    return;
  }
  try {
    win.destroy();
    debugLog("[MiniOverlay] Window destroyed");
  } catch (err) {
    debugError("[MiniOverlay] Error destroying overlay:", err);
  } finally {
    setOverlayWindow(null);
  }
}
