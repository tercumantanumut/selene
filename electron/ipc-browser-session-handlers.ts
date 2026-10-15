import { BrowserWindow, ipcMain } from "electron";
import * as path from "path";
import * as fs from "fs";
import { debugLog, debugError } from "./debug-logger";
import type { IpcHandlerContext } from "./ipc-context";
import { getSetting } from "@/lib/settings/settings-manager";
import { uiScaleToZoomFactor } from "@/lib/ui/ui-scale";
import {
  getWindowBackgroundColor,
  currentElectronThemePreference,
  resolveWindowsWindowIconPath,
} from "./window-manager";

// ---------------------------------------------------------------------------
// Browser session windows — one per sessionId
// ---------------------------------------------------------------------------

const sessionWindows = new Map<string, BrowserWindow>();

/**
 * Register IPC handlers for dedicated browser session windows.
 */
export function registerBrowserSessionHandlers(ctx: IpcHandlerContext): void {
  ipcMain.handle("browser-session:open", async (_event, sessionId: string) => {
    if (!sessionId) return { success: false, error: "No sessionId provided" };

    // If window already exists, focus it
    const existing = sessionWindows.get(sessionId);
    if (existing && !existing.isDestroyed()) {
      if (!existing.isVisible()) {
        existing.show();
      }
      existing.focus();
      return { success: true, reused: true };
    }

    let win: BrowserWindow | null = null;
    try {
      const windowsIconPath =
        process.platform === "win32" ? resolveWindowsWindowIconPath() : undefined;
      let shown = false;
      const showWindow = () => {
        if (!win || shown || win.isDestroyed()) return;
        shown = true;
        win.show();
        win.focus();
      };

      win = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 800,
        minHeight: 500,
        title: `Browser Session`,
        backgroundColor: getWindowBackgroundColor(currentElectronThemePreference),
        autoHideMenuBar: true,
        ...(windowsIconPath ? { icon: windowsIconPath } : {}),
        webPreferences: {
          preload: path.join(__dirname, "preload.js"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        },
        show: false,
      });

      win.webContents.setZoomFactor(uiScaleToZoomFactor(getSetting("uiScale")));
      sessionWindows.set(sessionId, win);

      // Attach ready-to-show BEFORE loadURL — the event fires on first paint,
      // which happens during loadURL. If we await loadURL first, the event has
      // already fired and the window stays hidden forever.
      win.once("ready-to-show", showWindow);
      // Some Chromium/Next loads paint late enough that ready-to-show can be
      // unreliable. did-finish-load is a safe fallback for the dedicated window.
      win.webContents.once("did-finish-load", showWindow);

      // Load the dedicated browser session page
      const baseUrl = ctx.isDev
        ? (process.env.ELECTRON_DEV_URL || "http://127.0.0.1:3000")
        : `${ctx.prodUseHttps ? "https" : "http"}://127.0.0.1:${ctx.prodServerPort}`;

      await win.loadURL(`${baseUrl}/browser-session?sessionId=${sessionId}`);
      // Final fallback: if both events were missed, still surface the window.
      showWindow();

      win.on("closed", () => {
        sessionWindows.delete(sessionId);
        debugLog(`[BrowserSession] Window closed for session ${sessionId.slice(0, 8)}…`);
      });

      debugLog(`[BrowserSession] Opened window for session ${sessionId.slice(0, 8)}…`);
      return { success: true };
    } catch (error) {
      // loadURL can fail transiently on slower startup; ensure stale hidden windows
      // are never kept in the reuse map.
      sessionWindows.delete(sessionId);
      if (win && !win.isDestroyed()) {
        win.destroy();
      }
      debugError(`[BrowserSession] Failed to open window:`, error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle("browser-session:close", (_event, sessionId: string) => {
    const win = sessionWindows.get(sessionId);
    if (win && !win.isDestroyed()) {
      win.close(); // The "closed" event handler owns map cleanup
      return { success: true };
    }
    return { success: false, error: "No window found" };
  });

  ipcMain.handle("browser-session:is-open", (_event, sessionId: string) => {
    const win = sessionWindows.get(sessionId);
    return { open: !!win && !win.isDestroyed() };
  });

  ipcMain.handle("browser-session:save-recording", async (event, options: { defaultPath?: string; data?: number[] }) => {
    const { dialog } = await import("electron");

    // Parent the dialog to the calling window
    const parentWin = BrowserWindow.fromWebContents(event.sender) ?? undefined;

    const result = await dialog.showSaveDialog(parentWin as BrowserWindow, {
      title: "Save Browser Recording",
      defaultPath: options?.defaultPath || "browser-recording.webm",
      filters: [
        { name: "WebM Video", extensions: ["webm"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });

    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }

    // If data is provided, write directly to the user-chosen path
    // (bypasses the sandboxed file:write handler)
    if (options?.data) {
      try {
        fs.writeFileSync(result.filePath, Buffer.from(options.data));
        debugLog(`[BrowserSession] Recording saved to: ${result.filePath}`);
        return { success: true, filePath: result.filePath };
      } catch (error) {
        debugError(`[BrowserSession] Failed to save recording:`, error);
        return { success: false, error: String(error) };
      }
    }

    return { success: true, filePath: result.filePath };
  });
}

/**
 * Close all browser session windows. Called on app quit.
 */
export function closeAllBrowserSessionWindows(): void {
  for (const [, win] of sessionWindows) {
    if (!win.isDestroyed()) {
      win.destroy(); // Force-destroy on quit — no beforeunload
    }
  }
  sessionWindows.clear();
  debugLog("[BrowserSession] All session windows closed");
}
