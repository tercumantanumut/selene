/**
 * Ghost OS IPC Handlers
 *
 * Electron main-process handlers for Ghost OS status, setup, preflight,
 * vision model management, and sidecar lifecycle events.
 *
 * IMPORTANT: These handlers are thin wrappers over lib/ghost-os/setup.ts
 * and lib/ghost-os/preflight.ts. All business logic (binary detection,
 * permission parsing, handshake probe) lives in the lib modules —
 * NOT duplicated here.
 */

import { ipcMain, app, shell, systemPreferences, desktopCapturer } from "electron";
import { execFile } from "child_process";
import type { IpcHandlerContext } from "./ipc-context";
import { debugLog, debugError } from "./debug-logger";
import {
  getGhostOsStatus,
  runGhostSetup,
  resolveGhostBinary,
  isVisionModelInstalled,
} from "@/lib/ghost-os/setup";
import { clearGhostOsConfigCache } from "@/lib/ghost-os/config";
import {
  runGhostOsPreflight,
  type PermissionVerdict,
  type PreflightProgressEvent,
  type PreflightResult,
} from "@/lib/ghost-os/preflight";

/**
 * macOS System Settings deep link for Screen Recording pane.
 * See: https://developer.apple.com/documentation/devicemanagement/systempreferences
 */
const SCREEN_RECORDING_DEEP_LINK =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

/**
 * Safely send IPC event to renderer, checking if sender is still alive.
 */
function safeSend(
  sender: Electron.WebContents,
  channel: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any,
): void {
  if (!sender.isDestroyed()) {
    sender.send(channel, data);
  }
}

/**
 * Probe macOS Screen Recording permission with two-layer detection:
 *
 *  1. `systemPreferences.getMediaAccessStatus("screen")` — what macOS *thinks*
 *     the state is (reads the TCC database).
 *  2. `desktopCapturer.getSources` with a 1x1 thumbnail — what macOS *actually
 *     does* when a process tries to capture. On denied/stale permission,
 *     macOS returns sources with empty thumbnails.
 *
 * If (1) says "granted" but (2) fails, the verdict is `tcc_stale` — the
 * user's TCC entry for Selene.app is out of date and must be removed/re-added.
 */
async function electronPermissionProbe(): Promise<PermissionVerdict> {
  if (process.platform !== "darwin") {
    return { kind: "non-darwin" };
  }

  const tccStatus = systemPreferences.getMediaAccessStatus("screen");

  // Real preflight: ask macOS to actually enumerate screens. On granted
  // permission, thumbnails are real. On denied or stale permission, they're
  // empty 1x1 NativeImages.
  let hasRealAccess = false;
  let realProbeError: string | undefined;
  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false,
    });
    hasRealAccess =
      sources.length > 0 &&
      sources.some((s) => {
        // thumbnail.isEmpty() → true when TCC denied the capture
        try {
          return !s.thumbnail.isEmpty();
        } catch {
          return false;
        }
      });
  } catch (error) {
    realProbeError = error instanceof Error ? error.message : String(error);
  }

  if (tccStatus === "granted" && hasRealAccess) {
    return { kind: "granted" };
  }

  if (tccStatus === "granted" && !hasRealAccess) {
    return {
      kind: "tcc_stale",
      message:
        "macOS reports Screen Recording as granted for Selene, but actual capture fails. " +
        "This is a stale TCC entry (common after app updates or re-installs). Fix: open " +
        "System Settings → Privacy & Security → Screen & System Audio Recording, remove " +
        "the Selene entry with the minus (−) button, then click plus (+) and re-add Selene. " +
        "Relaunch Selene afterwards.",
    };
  }

  if (tccStatus === "denied") {
    return { kind: "denied", reason: "user-denied" };
  }
  if (tccStatus === "not-determined") {
    return { kind: "denied", reason: "never-granted" };
  }
  if (tccStatus === "restricted") {
    return {
      kind: "unknown",
      error:
        "Screen Recording is restricted by MDM/parental controls. " +
        "Contact your device administrator.",
    };
  }

  return {
    kind: "unknown",
    error: `TCC status: ${tccStatus}${realProbeError ? ` (probe error: ${realProbeError})` : ""}`,
  };
}

// ---------------------------------------------------------------------------
// Preflight/setup in-flight tracking — prevents concurrent wizard runs
// ---------------------------------------------------------------------------

interface InFlightOperation {
  abortController: AbortController;
  sender: Electron.WebContents;
  kind: "preflight" | "setup";
}

const globalForGhostOs = globalThis as unknown as {
  __ghostOsInFlight?: InFlightOperation | null;
};

// ---------------------------------------------------------------------------
// Sidecar lifecycle: forward MCP client-manager events to renderer
// ---------------------------------------------------------------------------

interface SidecarLifecycleForwarder {
  attach: (sender: Electron.WebContents) => () => void;
}

let sidecarLifecycleForwarder: SidecarLifecycleForwarder | null = null;

/**
 * Wire MCPClientManager lifecycle events for the ghost-os server into IPC.
 * Uses a lazy require because `lib/mcp/client-manager` is not available until
 * the Next.js server bootstraps — but this function is invoked on-demand when
 * the renderer subscribes, so the require always resolves by then.
 */
async function getSidecarLifecycleForwarder(): Promise<SidecarLifecycleForwarder> {
  if (sidecarLifecycleForwarder) return sidecarLifecycleForwarder;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { MCPClientManager } = await import("@/lib/mcp/client-manager");
  const manager = MCPClientManager.getInstance();

  const subscribers = new Set<Electron.WebContents>();

  // subscribeLifecycle exists after Part 3d's client-manager changes land
  // (added in this PR); guard so this file type-checks either way.
  const subscribe = (
    manager as unknown as {
      subscribeLifecycle?: (
        serverName: string,
        cb: (event: {
          type: "spawned" | "crashed" | "handshake" | "permission-error" | "disconnected";
          serverName: string;
          detail?: string;
          error?: string;
          pid?: number;
          exitCode?: number | null;
        }) => void,
      ) => () => void;
    }
  ).subscribeLifecycle;

  if (!subscribe) {
    debugError("[GhostOS] MCPClientManager.subscribeLifecycle missing — sidecar lifecycle events disabled");
    sidecarLifecycleForwarder = {
      attach: () => () => {},
    };
    return sidecarLifecycleForwarder;
  }

  // Single subscription to the MCPClientManager; fan out to all WebContents
  subscribe("ghostos", (event) => {
    for (const sender of subscribers) {
      safeSend(sender, "ghostos:sidecarLifecycle", event);
    }
  });

  sidecarLifecycleForwarder = {
    attach: (sender) => {
      subscribers.add(sender);
      sender.once("destroyed", () => subscribers.delete(sender));
      return () => subscribers.delete(sender);
    },
  };
  return sidecarLifecycleForwarder;
}

// ---------------------------------------------------------------------------
// Register handlers
// ---------------------------------------------------------------------------

export function registerGhostOsHandlers(_ctx: IpcHandlerContext): void {
  // -------------------------------------------------------------------------
  // ghostos:getStatus — Check installation, version, permissions
  // Delegates entirely to lib/ghost-os/setup.ts — no duplicated logic.
  // -------------------------------------------------------------------------
  ipcMain.handle("ghostos:getStatus", async () => {
    debugLog("[GhostOS] Checking status...");
    try {
      const status = await getGhostOsStatus();
      debugLog(
        `[GhostOS] Status: installed=${status.installed}, version=${status.version}, vision=${status.visionModelInstalled}`,
      );
      return status;
    } catch (error) {
      debugError("[GhostOS] Status check failed:", error);
      return {
        installed: false,
        visionModelInstalled: false,
        permissions: {
          accessibility: false,
          screenRecording: false,
          inputMonitoring: false,
        },
      };
    }
  });

  // -------------------------------------------------------------------------
  // ghostos:runPreflight — Full wizard probe with streaming progress
  //
  // Replaces the parse-ghost-doctor-stdout approach with a real handshake
  // probe + TCC vs real-capture mismatch detection. Emits
  // `ghostos:setupProgress` events per stage so the UI renders a live
  // checklist instead of a spinner.
  // -------------------------------------------------------------------------
  ipcMain.handle("ghostos:runPreflight", async (event): Promise<PreflightResult> => {
    debugLog("[GhostOS] Running preflight...");

    // Abort any in-flight preflight from a stale wizard run
    if (globalForGhostOs.__ghostOsInFlight) {
      globalForGhostOs.__ghostOsInFlight.abortController.abort();
      globalForGhostOs.__ghostOsInFlight = null;
    }

    const abortController = new AbortController();
    globalForGhostOs.__ghostOsInFlight = {
      abortController,
      sender: event.sender,
      kind: "preflight",
    };

    try {
      const result = await runGhostOsPreflight({
        signal: abortController.signal,
        permissionProbe: electronPermissionProbe,
        onProgress: (progress: PreflightProgressEvent) => {
          safeSend(event.sender, "ghostos:setupProgress", {
            kind: "preflight",
            ...progress,
          });
        },
      });

      debugLog(`[GhostOS] Preflight complete: ${result.summary}`);
      return result;
    } finally {
      if (globalForGhostOs.__ghostOsInFlight?.abortController === abortController) {
        globalForGhostOs.__ghostOsInFlight = null;
      }
    }
  });

  // -------------------------------------------------------------------------
  // ghostos:cancelPreflight — Abort in-flight wizard probe
  // -------------------------------------------------------------------------
  ipcMain.handle("ghostos:cancelPreflight", () => {
    if (globalForGhostOs.__ghostOsInFlight) {
      globalForGhostOs.__ghostOsInFlight.abortController.abort();
      globalForGhostOs.__ghostOsInFlight = null;
      return { cancelled: true };
    }
    return { cancelled: false };
  });

  // -------------------------------------------------------------------------
  // ghostos:runSetup — Run ghost setup command, with streaming progress
  // -------------------------------------------------------------------------
  ipcMain.handle("ghostos:runSetup", async (event) => {
    debugLog("[GhostOS] Running setup...");

    // Stage: binary_located
    safeSend(event.sender, "ghostos:setupProgress", {
      kind: "setup",
      stage: "binary_located",
      status: "running",
      timestamp: Date.now(),
    });

    const binaryPath = await resolveGhostBinary();
    if (!binaryPath) {
      safeSend(event.sender, "ghostos:setupProgress", {
        kind: "setup",
        stage: "binary_located",
        status: "failed",
        error: "ghost binary not found",
        timestamp: Date.now(),
      });
      return {
        success: false,
        stdout: "",
        stderr: "Ghost OS binary not found. Install via: brew install ghostwright/ghost-os/ghost-os",
      };
    }

    safeSend(event.sender, "ghostos:setupProgress", {
      kind: "setup",
      stage: "binary_located",
      status: "ok",
      detail: binaryPath,
      timestamp: Date.now(),
    });

    // Stage: ghost_setup (maps to sidecar_spawn in our stage enum for consistency)
    safeSend(event.sender, "ghostos:setupProgress", {
      kind: "setup",
      stage: "sidecar_spawn",
      status: "running",
      detail: "running `ghost setup`",
      timestamp: Date.now(),
    });

    const result = await runGhostSetup(binaryPath);
    // Clear cached config so MCP pipeline re-detects after setup
    clearGhostOsConfigCache();

    if (result.success) {
      safeSend(event.sender, "ghostos:setupProgress", {
        kind: "setup",
        stage: "sidecar_spawn",
        status: "ok",
        timestamp: Date.now(),
      });
      debugLog("[GhostOS] Setup completed successfully");

      // Follow up with an automatic preflight so the UI sees the end-state
      safeSend(event.sender, "ghostos:setupProgress", {
        kind: "setup",
        stage: "complete",
        status: "ok",
        detail: "setup completed",
        timestamp: Date.now(),
      });
    } else {
      safeSend(event.sender, "ghostos:setupProgress", {
        kind: "setup",
        stage: "sidecar_spawn",
        status: "failed",
        error: result.stderr,
        timestamp: Date.now(),
      });
      debugError("[GhostOS] Setup failed:", result.stderr);
    }

    return result;
  });

  // -------------------------------------------------------------------------
  // ghostos:openScreenRecordingSettings — Deep-link to the right pane
  // -------------------------------------------------------------------------
  ipcMain.handle("ghostos:openScreenRecordingSettings", async () => {
    if (process.platform !== "darwin") {
      return { success: false, error: "macOS only" };
    }
    try {
      await shell.openExternal(SCREEN_RECORDING_DEEP_LINK);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  // -------------------------------------------------------------------------
  // ghostos:relaunchApp — Quit + relaunch so TCC picks up fresh grant
  // -------------------------------------------------------------------------
  ipcMain.handle("ghostos:relaunchApp", () => {
    debugLog("[GhostOS] Relaunching Selene for TCC refresh...");
    // Small delay so the IPC response can flush before we exit
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 100);
    return { scheduled: true };
  });

  // -------------------------------------------------------------------------
  // ghostos:reconnectSidecar — Restart ONLY the ghost-os MCP sidecar,
  // without quitting the whole app.
  //
  // Recovery path for silent stdio hangs: the child process is still alive
  // but has stopped consuming its stdin (pipe deadlock), so every tool call
  // times out until the whole app is relaunched. With the transport's new
  // write timeout + onclose listener, killing/respawning the sidecar is all
  // the user needs — this button wires that up as a one-click action.
  //
  // Returns { success, error?, stderrLogPath? } so the UI can point users
  // at the per-sidecar stderr log if the reconnect itself fails.
  // -------------------------------------------------------------------------
  ipcMain.handle("ghostos:reconnectSidecar", async () => {
    debugLog("[GhostOS] Reconnecting MCP sidecar...");
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { MCPClientManager } = await import("@/lib/mcp/client-manager");
      const manager = MCPClientManager.getInstance();

      // `reconnect` uses the remembered config from the previous connect().
      // If the user has never connected this session (e.g. fresh boot, UI
      // opened before any tool call loaded MCP config), reconnect() returns
      // null and the UI shows a clear error telling them to send any
      // ghost_* call first (which triggers normal lazy connect).
      const status = await (
        manager as unknown as {
          reconnect?: (serverName: string) => Promise<{ connected: boolean; lastError?: string } | null>;
        }
      ).reconnect?.("ghostos");

      if (!status) {
        return {
          success: false,
          error:
            "Ghost OS sidecar has not been started yet in this session. " +
            "Trigger any Ghost OS tool first to register its config, then try Reconnect again.",
        };
      }

      if (!status.connected) {
        return {
          success: false,
          error: status.lastError ?? "Reconnect failed (unknown error)",
        };
      }

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugError("[GhostOS] Reconnect failed:", message);
      return { success: false, error: message };
    }
  });

  // -------------------------------------------------------------------------
  // ghostos:subscribeLifecycle — Begin forwarding sidecar lifecycle events
  //
  // Idempotent: calling twice from the same WebContents is safe. Unsub
  // happens automatically on WebContents destroy.
  // -------------------------------------------------------------------------
  ipcMain.handle("ghostos:subscribeLifecycle", async (event) => {
    try {
      const forwarder = await getSidecarLifecycleForwarder();
      forwarder.attach(event.sender);
      return { subscribed: true };
    } catch (error) {
      debugError("[GhostOS] subscribeLifecycle failed:", error);
      return {
        subscribed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  // -------------------------------------------------------------------------
  // ghostos:downloadVisionModel — Download ShowUI-2B vision model
  // (unchanged from prior revision — streams via model:downloadProgress)
  // -------------------------------------------------------------------------
  ipcMain.handle("ghostos:downloadVisionModel", async (event) => {
    debugLog("[GhostOS] Starting vision model download...");

    try {
      const binaryPath = await resolveGhostBinary();
      if (!binaryPath) {
        return {
          success: false,
          error: "Ghost OS binary not found",
        };
      }

      // Emit initial progress
      safeSend(event.sender, "model:downloadProgress", {
        modelId: "ghostos-showui-2b",
        status: "downloading",
        progress: 0,
        file: "ShowUI-2B",
      });

      const child = execFile(binaryPath, ["setup", "--vision"], {
        timeout: 600000, // 10 minutes for large model download
        env: {
          ...process.env,
          PATH: [
            process.env.PATH || "",
            "/opt/homebrew/bin",
            "/usr/local/bin",
          ].join(":"),
        },
      });

      // Stream stdout for progress indication
      if (child.stdout) {
        child.stdout.on("data", (data: Buffer | string) => {
          const text = data.toString();
          const progressMatch = text.match(/(\d+)%/);
          if (progressMatch) {
            const progress = parseInt(progressMatch[1], 10);
            safeSend(event.sender, "model:downloadProgress", {
              modelId: "ghostos-showui-2b",
              status: "downloading",
              progress,
              file: "ShowUI-2B",
            });
          }
        });
      }

      await new Promise<void>((resolve, reject) => {
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`ghost setup --vision exited with code ${code}`));
        });
        child.on("error", reject);
      });

      // Verify vision model actually got installed (handles ghost setup --vision
      // silently no-oping on older Ghost OS versions)
      const visionInstalled = isVisionModelInstalled();
      if (!visionInstalled) {
        const errorMsg =
          "ghost setup --vision completed but vision model not found. " +
          "Your Ghost OS version may not support --vision. " +
          "Try running: ghost download-vision-model";
        debugError("[GhostOS]", errorMsg);
        safeSend(event.sender, "model:downloadProgress", {
          modelId: "ghostos-showui-2b",
          status: "error",
          progress: 0,
          error: errorMsg,
        });
        return { success: false, error: errorMsg };
      }

      safeSend(event.sender, "model:downloadProgress", {
        modelId: "ghostos-showui-2b",
        status: "completed",
        progress: 100,
        file: "ShowUI-2B",
      });

      debugLog("[GhostOS] Vision model download completed");
      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      debugError("[GhostOS] Vision model download failed:", errorMsg);

      safeSend(event.sender, "model:downloadProgress", {
        modelId: "ghostos-showui-2b",
        status: "error",
        progress: 0,
        error: errorMsg,
      });

      return { success: false, error: errorMsg };
    }
  });
}
