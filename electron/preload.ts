import { contextBridge, ipcRenderer } from "electron";

/**
 * Preload script for secure IPC communication between main and renderer processes.
 * Uses contextBridge to safely expose limited functionality to the renderer.
 */

// Define the API to expose to the renderer process
const electronAPI = {
  // Platform information
  platform: process.platform,

  // Check if running in Electron
  isElectron: true,

  // Window controls (for custom title bar if needed)
  window: {
    minimize: (): void => {
      ipcRenderer.send("window:minimize");
    },
    maximize: (): void => {
      ipcRenderer.send("window:maximize");
    },
    close: (): void => {
      ipcRenderer.send("window:close");
    },
    isMaximized: (): Promise<boolean> => {
      return ipcRenderer.invoke("window:isMaximized");
    },
    isFullScreen: (): Promise<boolean> => {
      return ipcRenderer.invoke("window:isFullScreen");
    },
    onFullscreenChanged: (callback: (isFullScreen: boolean) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, isFullScreen: boolean) => callback(isFullScreen);
      ipcRenderer.on("window:fullscreen-changed", handler);
      return () => {
        ipcRenderer.removeListener("window:fullscreen-changed", handler);
      };
    },
  },

  // App info
  app: {
    getVersion: (): Promise<string> => {
      return ipcRenderer.invoke("app:getVersion");
    },
    getName: (): Promise<string> => {
      return ipcRenderer.invoke("app:getName");
    },
    getDataPath: (): Promise<string> => {
      return ipcRenderer.invoke("app:getDataPath");
    },
    getMediaPath: (): Promise<string> => {
      return ipcRenderer.invoke("app:getMediaPath");
    },
  },

  // Shell operations (opening external links, etc.)
  shell: {
    openExternal: (url: string): Promise<void> => {
      return ipcRenderer.invoke("shell:openExternal", url);
    },
  },

  // Dialog operations
  dialog: {
    selectFolder: (): Promise<string | null> => {
      return ipcRenderer.invoke("dialog:selectFolder");
    },
  },

  // Settings operations
  settings: {
    get: (): Promise<Record<string, unknown> | null> => {
      return ipcRenderer.invoke("settings:get");
    },
    save: (settings: Record<string, unknown>): Promise<boolean> => {
      return ipcRenderer.invoke("settings:save", settings);
    },
  },

  // File operations for local storage
  file: {
    read: (filePath: string): Promise<Buffer | null> => {
      return ipcRenderer.invoke("file:read", filePath);
    },
    write: (filePath: string, data: Buffer | string): Promise<boolean> => {
      return ipcRenderer.invoke("file:write", filePath, data);
    },
    delete: (filePath: string): Promise<boolean> => {
      return ipcRenderer.invoke("file:delete", filePath);
    },
    exists: (filePath: string): Promise<boolean> => {
      return ipcRenderer.invoke("file:exists", filePath);
    },
  },

  // Model download operations
  model: {
    getModelsDir: (): Promise<string> => {
      return ipcRenderer.invoke("model:getModelsDir");
    },
    checkExists: (modelId: string): Promise<boolean> => {
      return ipcRenderer.invoke("model:checkExists", modelId);
    },
    download: (modelId: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke("model:download", modelId);
    },
    onProgress: (callback: (data: { modelId: string; status: string; progress?: number; file?: string; error?: string }) => void): void => {
      ipcRenderer.on("model:downloadProgress", (_event, data) => callback(data));
    },
    removeProgressListener: (): void => {
      ipcRenderer.removeAllListeners("model:downloadProgress");
    },
    // Single-file download for whisper.cpp models (downloads one .bin from a shared HF repo)
    checkFileExists: (opts: { modelId: string; filename: string }): Promise<boolean> => {
      return ipcRenderer.invoke("model:checkFileExists", opts);
    },
    downloadFile: (opts: { modelId: string; repo: string; filename: string }): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke("model:downloadFile", opts);
    },
    getDownloadState: (modelId: string) => ipcRenderer.invoke("model:getDownloadState", modelId),
    cancelDownload: (modelId: string) => ipcRenderer.invoke("model:cancelDownload", modelId),
    /** Run a test embedding to verify the ONNX pipeline is working. */
    validate: (modelId: string): Promise<{
      success: boolean;
      durationMs: number;
      dims: number;
      error?: string;
    }> => ipcRenderer.invoke("model:validate", modelId),
    /** Open the model folder in Finder / Explorer. */
    openFolder: (modelId: string): Promise<{ success: boolean; path: string }> =>
      ipcRenderer.invoke("model:openFolder", modelId),
    /** Clear model files, re-download, and validate. Progress events on "model:redownloadProgress". */
    redownloadAndValidate: (modelId: string): Promise<{
      success: boolean;
      error?: string;
      validation?: { success: boolean; durationMs: number; dims: number; error?: string };
    }> => ipcRenderer.invoke("model:redownloadAndValidate", modelId),
    /** Listen for redownload+validate progress events. */
    onRedownloadProgress: (callback: (data: {
      modelId: string;
      status: string;
      detail?: string;
    }) => void): void => {
      ipcRenderer.on("model:redownloadProgress", (_event, data) => callback(data));
    },
    removeRedownloadProgressListener: (): void => {
      ipcRenderer.removeAllListeners("model:redownloadProgress");
    },
    parakeetGetStatus: (modelId?: string): Promise<{
      installed: boolean;
      running: boolean;
      modelId: string | null;
      modelDir: string | null;
      wsBinary: string | null;
      wsAvailable: boolean;
      cpuThreads: number;
      baseDir: string;
    }> => {
      return ipcRenderer.invoke("parakeet:getStatus", modelId);
    },
    parakeetResolvePaths: (modelId?: string): Promise<{
      success: boolean;
      error?: string;
      modelId?: string;
      modelDir?: string;
      wsBinary?: string | null;
      modelInstalled?: boolean;
      wsAvailable?: boolean;
    }> => {
      return ipcRenderer.invoke("parakeet:resolvePaths", modelId);
    },
    parakeetDownloadModel: (modelId?: string): Promise<{
      success: boolean;
      error?: string;
      modelId?: string;
      modelDir?: string;
      wsBinary?: string | null;
    }> => {
      return ipcRenderer.invoke("parakeet:downloadModel", modelId);
    },
  },

  // Ghost OS operations
  ghostOs: {
    getStatus: (): Promise<{
      installed: boolean;
      version?: string;
      visionModelInstalled: boolean;
      permissions: {
        accessibility: boolean;
        screenRecording: boolean;
        inputMonitoring: boolean;
      };
      binaryPath?: string;
    }> => {
      return ipcRenderer.invoke("ghostos:getStatus");
    },
    runSetup: (): Promise<{
      success: boolean;
      stdout: string;
      stderr: string;
    }> => {
      return ipcRenderer.invoke("ghostos:runSetup");
    },
    downloadVisionModel: (): Promise<{
      success: boolean;
      error?: string;
    }> => {
      return ipcRenderer.invoke("ghostos:downloadVisionModel");
    },

    // -----------------------------------------------------------------------
    // Wizard preflight (new) — streams per-stage progress over
    // "ghostos:setupProgress", returns a PreflightResult with permission
    // verdict (incl. tcc_stale), handshake, and first-tool ping.
    // -----------------------------------------------------------------------
    runPreflight: (): Promise<unknown> => {
      return ipcRenderer.invoke("ghostos:runPreflight");
    },
    cancelPreflight: (): Promise<{ cancelled: boolean }> => {
      return ipcRenderer.invoke("ghostos:cancelPreflight");
    },

    /** Deep-link to System Settings → Privacy → Screen Recording. macOS only. */
    openScreenRecordingSettings: (): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke("ghostos:openScreenRecordingSettings");
    },

    /** Quit + relaunch Selene so the kernel re-reads TCC grants. */
    relaunchApp: (): Promise<{ scheduled: boolean }> => {
      return ipcRenderer.invoke("ghostos:relaunchApp");
    },

    /**
     * Restart ONLY the ghost-os MCP sidecar (kill + respawn the child
     * process), without quitting the whole app. Recovery path for silent
     * stdio hangs — see docs/bug-reports/2026-04-17-ghost-os-mcp-stdio-hang.md.
     */
    reconnectSidecar: (): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke("ghostos:reconnectSidecar");
    },

    /**
     * Subscribe this WebContents to sidecar lifecycle events
     * (spawned / handshake / crashed / permission-error / disconnected).
     * Events arrive on the "ghostos:sidecarLifecycle" channel via onSidecarLifecycle.
     */
    subscribeLifecycle: (): Promise<{ subscribed: boolean; error?: string }> => {
      return ipcRenderer.invoke("ghostos:subscribeLifecycle");
    },

    /**
     * Listen for streaming setup / preflight progress.
     * Each event: { kind: "preflight" | "setup", stage, status, detail?, error?, timestamp }
     */
    onSetupProgress: (
      callback: (event: {
        kind: "preflight" | "setup";
        stage: string;
        status: "running" | "ok" | "failed" | "skipped";
        detail?: string;
        error?: string;
        timestamp: number;
      }) => void,
    ): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) =>
        callback(payload);
      ipcRenderer.on("ghostos:setupProgress", handler);
      return () => {
        ipcRenderer.removeListener("ghostos:setupProgress", handler);
      };
    },

    /**
     * Listen for sidecar lifecycle events emitted by the MCPClientManager.
     * Renderer must call subscribeLifecycle() once before these events arrive.
     */
    onSidecarLifecycle: (
      callback: (event: {
        type: "spawned" | "handshake" | "disconnected" | "crashed" | "permission-error";
        serverName: string;
        detail?: string;
        error?: string;
        pid?: number;
        exitCode?: number | null;
        timestamp: number;
      }) => void,
    ): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) =>
        callback(payload);
      ipcRenderer.on("ghostos:sidecarLifecycle", handler);
      return () => {
        ipcRenderer.removeListener("ghostos:sidecarLifecycle", handler);
      };
    },
  },

  // Browser session window operations
  browserSession: {
    open: (sessionId: string): Promise<{ success: boolean; reused?: boolean; error?: string }> => {
      return ipcRenderer.invoke("browser-session:open", sessionId) as Promise<{ success: boolean; reused?: boolean; error?: string }>;
    },
    close: (sessionId: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke("browser-session:close", sessionId) as Promise<{ success: boolean; error?: string }>;
    },
    isOpen: (sessionId: string): Promise<{ open: boolean }> => {
      return ipcRenderer.invoke("browser-session:is-open", sessionId) as Promise<{ open: boolean }>;
    },
    saveRecording: (options?: { defaultPath?: string }): Promise<{ success: boolean; filePath?: string; canceled?: boolean }> => {
      return ipcRenderer.invoke("browser-session:save-recording", options) as Promise<{ success: boolean; filePath?: string; canceled?: boolean }>;
    },
  },

  // Voice hotkey operations
  voiceHotkey: {
    onTriggered: (callback: () => void): (() => void) | undefined => {
      const handler = () => callback();
      ipcRenderer.on("voice-hotkey:triggered", handler);
      return () => {
        ipcRenderer.removeListener("voice-hotkey:triggered", handler);
      };
    },
    register: (accelerator: string): Promise<{ success: boolean; accelerator: string; error?: string }> => {
      return ipcRenderer.invoke("voice-hotkey:register", accelerator);
    },
    registerFromSettings: (): Promise<{ success: boolean; accelerator: string; error?: string }> => {
      return ipcRenderer.invoke("voice-hotkey:registerFromSettings");
    },
    getRegistered: (): Promise<{ accelerator: string }> => {
      return ipcRenderer.invoke("voice-hotkey:getRegistered");
    },
    clear: (): Promise<{ success: boolean }> => {
      return ipcRenderer.invoke("voice-hotkey:clear");
    },
  },

  screenCapture: {
    onCaptured: (callback: (result: {
      success: boolean;
      imageUrl?: string;
      relativePath?: string;
      width?: number;
      height?: number;
      error?: string;
      permissionStatus: "granted" | "denied" | "restricted" | "not-determined" | "unknown";
    }) => void): (() => void) | undefined => {
      const handler = (_event: Electron.IpcRendererEvent, result: {
        success: boolean;
        imageUrl?: string;
        relativePath?: string;
        width?: number;
        height?: number;
        error?: string;
        permissionStatus: "granted" | "denied" | "restricted" | "not-determined" | "unknown";
      }) => callback(result);
      ipcRenderer.on("screen-capture:captured", handler);
      return () => {
        ipcRenderer.removeListener("screen-capture:captured", handler);
      };
    },
    capture: (): Promise<{
      success: boolean;
      imageUrl?: string;
      relativePath?: string;
      width?: number;
      height?: number;
      error?: string;
      permissionStatus: "granted" | "denied" | "restricted" | "not-determined" | "unknown";
    }> => {
      return ipcRenderer.invoke("screen-capture:capture");
    },
    register: (accelerator: string, enabled = true): Promise<{ success: boolean; accelerator: string; error?: string; disabled?: boolean }> => {
      return ipcRenderer.invoke("screen-capture:register", accelerator, enabled);
    },
    registerFromSettings: (): Promise<{ success: boolean; accelerator: string; error?: string; disabled?: boolean }> => {
      return ipcRenderer.invoke("screen-capture:registerFromSettings");
    },
    getRegistered: (): Promise<{ accelerator: string }> => {
      return ipcRenderer.invoke("screen-capture:getRegistered");
    },
    clear: (): Promise<{ success: boolean }> => {
      return ipcRenderer.invoke("screen-capture:clear");
    },
    checkPermission: (): Promise<{ status: "granted" | "denied" | "restricted" | "not-determined" | "unknown" }> => {
      return ipcRenderer.invoke("screen-capture:check-permission");
    },
  },

  // Unified capture (voice + screen) operations
  unifiedCapture: {
    onTriggered: (callback: (payload: {
      mode: "voice+screen" | "voice-only" | "screen-only";
      screenshot?: { url: string; filePath: string };
      metadata?: {
        capturedAt: string;
        activeWindowTitle?: string;
        activeAppName?: string;
        activeUrl?: string;
        displayIndex?: number;
        originalResolution?: { width: number; height: number };
        captureMode: "fullscreen" | "active-window" | "region" | "display";
      };
      startVoice: boolean;
      screenshotError?: string;
      traceId: string;
    }) => void): (() => void) | undefined => {
      const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) => callback(payload);
      ipcRenderer.on("unified-capture:triggered", handler);
      return () => {
        ipcRenderer.removeListener("unified-capture:triggered", handler);
      };
    },
    trigger: (mode?: "voice+screen" | "voice-only" | "screen-only"): Promise<unknown> => {
      return ipcRenderer.invoke("unified-capture:trigger", mode);
    },
    register: (accelerator: string, enabled = true): Promise<{ success: boolean; accelerator: string; error?: string; disabled?: boolean }> => {
      return ipcRenderer.invoke("unified-capture:register", accelerator, enabled);
    },
    registerFromSettings: (): Promise<{ success: boolean; accelerator: string; error?: string; disabled?: boolean }> => {
      return ipcRenderer.invoke("unified-capture:registerFromSettings");
    },
    getRegistered: (): Promise<{ accelerator: string }> => {
      return ipcRenderer.invoke("unified-capture:getRegistered");
    },
    clear: (): Promise<{ success: boolean }> => {
      return ipcRenderer.invoke("unified-capture:clear");
    },
  },

  // Permission management
  permissions: {
    check: (): Promise<{
      screen: "granted" | "denied" | "not-determined" | "restricted" | "unavailable";
      microphone: "granted" | "denied" | "not-determined" | "restricted" | "unavailable";
      accessibility: "granted" | "denied" | "not-determined" | "restricted" | "unavailable";
    }> => {
      return ipcRenderer.invoke("permission:check");
    },
    requestScreen: (): Promise<void> => {
      return ipcRenderer.invoke("permission:request-screen");
    },
    requestMic: (): Promise<boolean> => {
      return ipcRenderer.invoke("permission:request-mic");
    },
    requestAccessibility: (): Promise<boolean> => {
      return ipcRenderer.invoke("permission:request-accessibility");
    },
    onScreenPermissionRequired: (callback: () => void): (() => void) | undefined => {
      const handler = () => callback();
      ipcRenderer.on("permission:screen-required", handler);
      return () => {
        ipcRenderer.removeListener("permission:screen-required", handler);
      };
    },
  },

  // ComfyUI local backend operations
  comfyui: {
    checkStatus: (backendPath?: string): Promise<{
      dockerInstalled: boolean;
      imageBuilt: boolean;
      containerRunning: boolean;
      apiHealthy: boolean;
      modelsDownloaded: boolean;
      checkpointExists: boolean;
      loraExists: boolean;
    }> => {
      return ipcRenderer.invoke("comfyui:checkStatus", backendPath);
    },
    install: (backendPath: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke("comfyui:install", backendPath);
    },
    downloadModels: (backendPath: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke("comfyui:downloadModels", backendPath);
    },
    start: (backendPath?: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke("comfyui:start", backendPath);
    },
    stop: (backendPath?: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke("comfyui:stop", backendPath);
    },
    getDefaultPath: (): Promise<{ success: boolean; path?: string; error?: string }> => {
      return ipcRenderer.invoke("comfyui:getDefaultPath");
    },
    fullSetup: (): Promise<{ success: boolean; backendPath?: string; error?: string }> => {
      return ipcRenderer.invoke("comfyui:fullSetup");
    },
    detectCustom: (options?: { host?: string; ports?: number[]; useHttps?: boolean }): Promise<{ baseUrl: string | null; source: string; error?: string }> => {
      return ipcRenderer.invoke("comfyuiCustom:detect", options);
    },
    resolveCustom: (override?: { comfyuiBaseUrl?: string; comfyuiHost?: string; comfyuiPort?: number }): Promise<{ baseUrl: string | null; source: string; error?: string }> => {
      return ipcRenderer.invoke("comfyuiCustom:resolve", override);
    },
    onInstallProgress: (callback: (data: {
      stage: string;
      progress: number;
      message: string;
      error?: string;
    }) => void): void => {
      ipcRenderer.on("comfyui:installProgress", (_event, data) => callback(data));
    },
    removeProgressListener: (): void => {
      ipcRenderer.removeAllListeners("comfyui:installProgress");
    },
  },

  // FLUX.2 Klein 4B backend operations
  flux2Klein4b: {
    checkStatus: (backendPath?: string): Promise<{
      dockerInstalled: boolean;
      imageBuilt: boolean;
      containerRunning: boolean;
      apiHealthy: boolean;
      modelsDownloaded: boolean;
    }> => {
      return ipcRenderer.invoke("flux2Klein4b:checkStatus", backendPath);
    },
    start: (backendPath?: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke("flux2Klein4b:start", backendPath);
    },
    stop: (backendPath?: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke("flux2Klein4b:stop", backendPath);
    },
    getDefaultPath: (): Promise<{ success: boolean; path?: string; error?: string }> => {
      return ipcRenderer.invoke("flux2Klein4b:getDefaultPath");
    },
    fullSetup: (): Promise<{ success: boolean; backendPath?: string; error?: string }> => {
      return ipcRenderer.invoke("flux2Klein4b:fullSetup");
    },
    onInstallProgress: (callback: (data: {
      stage: string;
      progress: number;
      message: string;
      error?: string;
    }) => void): void => {
      ipcRenderer.on("flux2Klein4b:installProgress", (_event, data) => callback(data));
    },
    removeProgressListener: (): void => {
      ipcRenderer.removeAllListeners("flux2Klein4b:installProgress");
    },
  },

  // FLUX.2 Klein 9B backend operations
  flux2Klein9b: {
    checkStatus: (backendPath?: string): Promise<{
      dockerInstalled: boolean;
      imageBuilt: boolean;
      containerRunning: boolean;
      apiHealthy: boolean;
      modelsDownloaded: boolean;
    }> => {
      return ipcRenderer.invoke("flux2Klein9b:checkStatus", backendPath);
    },
    start: (backendPath?: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke("flux2Klein9b:start", backendPath);
    },
    stop: (backendPath?: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke("flux2Klein9b:stop", backendPath);
    },
    getDefaultPath: (): Promise<{ success: boolean; path?: string; error?: string }> => {
      return ipcRenderer.invoke("flux2Klein9b:getDefaultPath");
    },
    fullSetup: (): Promise<{ success: boolean; backendPath?: string; error?: string }> => {
      return ipcRenderer.invoke("flux2Klein9b:fullSetup");
    },
    onInstallProgress: (callback: (data: {
      stage: string;
      progress: number;
      message: string;
      error?: string;
    }) => void): void => {
      ipcRenderer.on("flux2Klein9b:installProgress", (_event, data) => callback(data));
    },
    removeProgressListener: (): void => {
      ipcRenderer.removeAllListeners("flux2Klein9b:installProgress");
    },
  },

  // Dev log streaming operations
  logs: {
    subscribe: (): void => {
      ipcRenderer.send("logs:subscribe");
    },
    unsubscribe: (): void => {
      ipcRenderer.send("logs:unsubscribe");
    },
    getBuffer: (): Promise<{ timestamp: string; level: string; message: string }[]> => {
      return ipcRenderer.invoke("logs:getBuffer");
    },
    clear: (): void => {
      ipcRenderer.send("logs:clear");
    },
    onEntry: (callback: (entry: { timestamp: string; level: string; message: string }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, entry: { timestamp: string; level: string; message: string }) => callback(entry);
      ipcRenderer.on("logs:entry", listener);
      return () => ipcRenderer.removeListener("logs:entry", listener);
    },
    onCritical: (callback: (data: { type: string; message: string }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { type: string; message: string }) => callback(data);
      ipcRenderer.on("logs:critical", listener);
      return () => ipcRenderer.removeListener("logs:critical", listener);
    },
    removeListeners: (): void => {
      ipcRenderer.removeAllListeners("logs:entry");
      ipcRenderer.removeAllListeners("logs:critical");
    },
  },

  // Command execution operations
  command: {
    execute: (options: {
      command: string;
      args: string[];
      cwd: string;
      characterId: string;
      timeout?: number;
    }): Promise<{
      success: boolean;
      stdout: string;
      stderr: string;
      exitCode: number | null;
      signal: string | null;
      error?: string;
      executionTime?: number;
    }> => {
      return ipcRenderer.invoke("command:execute", options);
    },
  },

  ipc: {
    send: (channel: string, ...args: unknown[]): void => {
      // Whitelist of allowed channels
      const validChannels = [
        "window:minimize",
        "window:maximize",
        "window:close",
        "logs:subscribe",
        "logs:unsubscribe",
        "logs:clear",
        "mini-overlay:close",
        "mini-overlay:phase-update",
        "mini-overlay:message-sent",
        "mini-overlay:dismiss",
      ];
      if (validChannels.includes(channel)) {
        ipcRenderer.send(channel, ...args);
      }
    },
    invoke: (channel: string, ...args: unknown[]): Promise<unknown> => {
      // Whitelist of allowed channels
      const validChannels = [
        "window:isMaximized",
        "window:isFullScreen",
        "app:getVersion",
        "app:getName",
        "app:getDataPath",
        "app:getMediaPath",
        "shell:openExternal",
        "dialog:selectFolder",
        "settings:get",
        "settings:save",
        "file:read",
        "file:write",
        "file:delete",
        "file:exists",
        "model:getModelsDir",
        "model:checkExists",
        "model:download",
        "model:checkFileExists",
        "model:downloadFile",
        "model:getDownloadState",
        "model:cancelDownload",
        "model:validate",
        "model:openFolder",
        "model:redownloadAndValidate",
        "logs:getBuffer",
        "command:execute",
        "comfyui:checkStatus",
        "comfyui:install",
        "comfyui:downloadModels",
        "comfyui:start",
        "comfyui:stop",
        "comfyui:getDefaultPath",
        "comfyui:fullSetup",
        "comfyuiCustom:detect",
        "comfyuiCustom:resolve",
        "voice-hotkey:register",
        "voice-hotkey:registerFromSettings",
        "voice-hotkey:getRegistered",
        "voice-hotkey:clear",
        "screen-capture:capture",
        "screen-capture:register",
        "screen-capture:registerFromSettings",
        "screen-capture:getRegistered",
        "screen-capture:clear",
        "screen-capture:check-permission",
        "unified-capture:trigger",
        "unified-capture:register",
        "unified-capture:registerFromSettings",
        "unified-capture:getRegistered",
        "unified-capture:clear",
        "permission:check",
        "permission:request-screen",
        "permission:request-mic",
        "permission:request-accessibility",
        "browser-session:open",
        "browser-session:close",
        "browser-session:is-open",
        "browser-session:save-recording",
        "mini-overlay:request-focus-return",
        "mini-overlay:compose-ready",
        "ghostos:getStatus",
        "ghostos:runSetup",
        "ghostos:downloadVisionModel",
        "ghostos:runPreflight",
        "ghostos:cancelPreflight",
        "ghostos:openScreenRecordingSettings",
        "ghostos:relaunchApp",
        "ghostos:reconnectSidecar",
        "ghostos:subscribeLifecycle",
      ];
      if (validChannels.includes(channel)) {
        return ipcRenderer.invoke(channel, ...args);
      }
      return Promise.reject(new Error(`Invalid channel: ${channel}`));
    },
    on: (channel: string, callback: (...args: unknown[]) => void): void => {
      // Whitelist of allowed channels
      const validChannels = ["window:maximized-changed", "window:visibility-changed", "window:fullscreen-changed", "model:downloadProgress", "model:redownloadProgress", "logs:entry", "logs:critical", "comfyui:installProgress", "voice-hotkey:triggered", "screen-capture:captured", "unified-capture:triggered", "overlay:toggle-recording", "overlay:session-updated", "overlay:compose-inject", "overlay:add-screenshot", "permission:screen-required", "ghostos:setupProgress", "ghostos:sidecarLifecycle"];
      if (validChannels.includes(channel)) {
        ipcRenderer.on(channel, (_event, ...args) => callback(...args));
      }
    },
    removeAllListeners: (channel: string): void => {
      const validChannels = ["window:maximized-changed", "window:visibility-changed", "window:fullscreen-changed", "model:downloadProgress", "model:redownloadProgress", "logs:entry", "logs:critical", "comfyui:installProgress", "voice-hotkey:triggered", "screen-capture:captured", "unified-capture:triggered", "overlay:toggle-recording", "overlay:session-updated", "overlay:compose-inject", "overlay:add-screenshot", "permission:screen-required", "ghostos:setupProgress", "ghostos:sidecarLifecycle"];
      if (validChannels.includes(channel)) {
        ipcRenderer.removeAllListeners(channel);
      }
    },
  },
};

// Expose the API to the renderer process
contextBridge.exposeInMainWorld("electronAPI", electronAPI);

// Export the type for use in other files
export type ElectronAPIType = typeof electronAPI;
