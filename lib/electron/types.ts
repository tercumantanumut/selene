/**
 * Type definitions for the Electron API exposed via contextBridge.
 * This allows type-safe access to Electron functionality from the renderer process.
 */

/**
 * Shared error marker for debounced captures. Used in both Electron main and renderer
 * to suppress toast notifications for rapid successive shortcut presses.
 */
export const UNIFIED_CAPTURE_DEBOUNCE_MARKER = "debounced";

interface ElectronWindowAPI {
  minimize: () => void;
  maximize: () => void;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  isFullScreen: () => Promise<boolean>;
  onFullscreenChanged: (callback: (isFullScreen: boolean) => void) => () => void;
}

interface ElectronAppAPI {
  getVersion: () => Promise<string>;
  getName: () => Promise<string>;
  getDataPath: () => Promise<string>;
  getMediaPath: () => Promise<string>;
}

interface ElectronShellAPI {
  openExternal: (url: string) => Promise<void>;
}

interface ElectronDialogAPI {
  selectFolder: () => Promise<string | null>;
}

interface ElectronSettingsAPI {
  get: () => Promise<Record<string, unknown> | null>;
  save: (settings: Record<string, unknown>) => Promise<boolean>;
}

interface ElectronFileAPI {
  read: (filePath: string) => Promise<Buffer | null>;
  write: (filePath: string, data: Buffer | string) => Promise<boolean>;
  delete: (filePath: string) => Promise<boolean>;
  exists: (filePath: string) => Promise<boolean>;
}

interface ElectronIpcAPI {
  send: (channel: string, ...args: unknown[]) => void;
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeAllListeners: (channel: string) => void;
}

interface ModelDownloadProgress {
  modelId: string;
  status: "downloading" | "completed" | "error";
  progress?: number;
  totalFiles?: number;
  downloadedFiles?: number;
  file?: string;
  error?: string;
}

interface ElectronModelAPI {
  getModelsDir: () => Promise<string>;
  checkExists: (modelId: string) => Promise<boolean>;
  download: (modelId: string) => Promise<{ success: boolean; error?: string }>;
  onProgress: (callback: (data: ModelDownloadProgress) => void) => void;
  removeProgressListener: () => void;
  checkFileExists: (opts: { modelId: string; filename: string }) => Promise<boolean>;
  downloadFile: (opts: { modelId: string; repo: string; filename: string }) => Promise<{ success: boolean; error?: string }>;
  parakeetGetStatus: (modelId?: string) => Promise<{
    installed: boolean;
    running: boolean;
    modelId: string | null;
    modelDir: string | null;
    wsBinary: string | null;
    wsAvailable: boolean;
    cpuThreads: number;
    baseDir: string;
  }>;
  parakeetResolvePaths: (modelId?: string) => Promise<{
    success: boolean;
    error?: string;
    modelId?: string;
    modelDir?: string;
    wsBinary?: string | null;
    modelInstalled?: boolean;
    wsAvailable?: boolean;
  }>;
  parakeetDownloadModel: (modelId?: string) => Promise<{
    success: boolean;
    error?: string;
    modelId?: string;
    modelDir?: string;
    wsBinary?: string | null;
  }>;
}

interface ElectronBrowserSessionAPI {
  open: (sessionId: string) => Promise<{ success: boolean; reused?: boolean; error?: string }>;
  close: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
  isOpen: (sessionId: string) => Promise<{ open: boolean }>;
  saveRecording: (options?: { defaultPath?: string }) => Promise<{ success: boolean; filePath?: string; canceled?: boolean }>;
}

interface ElectronLogsAPI {
  subscribe: () => void;
  unsubscribe: () => void;
  getBuffer: () => Promise<{ timestamp: string; level: string; message: string }[]>;
  clear: () => void;
  onEntry: (callback: (entry: { timestamp: string; level: string; message: string }) => void) => () => void;
  onCritical: (callback: (data: { type: string; message: string }) => void) => () => void;
  removeListeners: () => void;
}

export interface ScreenCaptureResult {
  success: boolean;
  imageUrl?: string;
  relativePath?: string;
  width?: number;
  height?: number;
  error?: string;
  permissionStatus: "granted" | "denied" | "restricted" | "not-determined" | "unknown";
}

interface ElectronScreenCaptureAPI {
  onCaptured: (callback: (result: ScreenCaptureResult) => void) => (() => void) | undefined;
  capture: () => Promise<ScreenCaptureResult>;
  register: (accelerator: string, enabled?: boolean) => Promise<{ success: boolean; accelerator: string; error?: string; disabled?: boolean }>;
  registerFromSettings: () => Promise<{ success: boolean; accelerator: string; error?: string; disabled?: boolean }>;
  getRegistered: () => Promise<{ accelerator: string }>;
  clear: () => Promise<{ success: boolean }>;
  checkPermission: () => Promise<{ status: ScreenCaptureResult["permissionStatus"] }>;
}

export type MiniOverlayPhase = "idle" | "recording" | "transcribing" | "refining" | "thinking" | "speaking" | "done" | "compose-pending" | "compose-review" | "error";

export interface ScreenCaptureMetadata {
  capturedAt: string;
  activeWindowTitle?: string;
  activeAppName?: string;
  activeUrl?: string;
  displayIndex?: number;
  originalResolution?: { width: number; height: number };
  captureMode: "fullscreen" | "active-window" | "region" | "display";
}

export interface UnifiedCaptureTriggerPayload {
  mode: "voice+screen" | "voice-only" | "screen-only";
  screenshot?: {
    url: string;
    filePath: string;
  };
  metadata?: ScreenCaptureMetadata;
  startVoice: boolean;
  screenshotError?: string;
  /** Permission status at capture time — allows renderer to show actionable prompts. */
  permissionStatus?: ScreenCaptureResult["permissionStatus"];
  traceId: string;
}

interface ElectronUnifiedCaptureAPI {
  onTriggered: (callback: (payload: UnifiedCaptureTriggerPayload) => void) => (() => void) | undefined;
  trigger: (mode?: "voice+screen" | "voice-only" | "screen-only") => Promise<UnifiedCaptureTriggerPayload>;
  register: (accelerator: string, enabled?: boolean) => Promise<{ success: boolean; accelerator: string; error?: string; disabled?: boolean }>;
  registerFromSettings: () => Promise<{ success: boolean; accelerator: string; error?: string; disabled?: boolean }>;
  getRegistered: () => Promise<{ accelerator: string }>;
  clear: () => Promise<{ success: boolean }>;
}

interface ElectronVoiceHotkeyAPI {
  onTriggered: (callback: () => void) => (() => void) | undefined;
  register: (accelerator: string) => Promise<{ success: boolean; accelerator: string; error?: string }>;
  registerFromSettings: () => Promise<{ success: boolean; accelerator: string; error?: string }>;
  getRegistered: () => Promise<{ accelerator: string }>;
  clear: () => Promise<{ success: boolean }>;
}

export type PermissionStatus =
  | "granted"
  | "denied"
  | "not-determined"
  | "restricted"
  | "unavailable";

export interface PermissionCheckResult {
  screen: PermissionStatus;
  microphone: PermissionStatus;
  accessibility: PermissionStatus;
}

interface ElectronPermissionsAPI {
  check: () => Promise<PermissionCheckResult>;
  requestScreen: () => Promise<void>;
  requestMic: () => Promise<boolean>;
  requestAccessibility: () => Promise<boolean>;
  /** Fires when the main process detects a capture attempt without screen recording permission. */
  onScreenPermissionRequired: (callback: () => void) => (() => void) | undefined;
}

/**
 * Ghost OS wizard stages — mirrored from lib/ghost-os/preflight.ts.
 * Kept as a string union (not an import) so renderer code doesn't pull the
 * main-process module transitively.
 */
export type GhostOsPreflightStage =
  | "binary_located"
  | "permission_preflight"
  | "sidecar_spawn"
  | "mcp_handshake"
  | "first_tool_ping"
  | "complete";

export type GhostOsStageStatus = "running" | "ok" | "failed" | "skipped";

export interface GhostOsSetupProgressEvent {
  /** "preflight" = runPreflight stream; "setup" = runSetup stream */
  kind: "preflight" | "setup";
  stage: GhostOsPreflightStage;
  status: GhostOsStageStatus;
  detail?: string;
  error?: string;
  /** Epoch ms */
  timestamp: number;
}

export type GhostOsPermissionVerdict =
  | { kind: "granted" }
  | { kind: "denied"; reason: "never-granted" | "user-denied" }
  | { kind: "tcc_stale"; message: string }
  | { kind: "wrong-responsible-process"; detectedParent: string }
  | { kind: "unknown"; error: string }
  | { kind: "non-darwin" }
  | { kind: "not-probed" };

export interface GhostOsPreflightResult {
  binaryFound: boolean;
  binaryPath?: string;
  binaryVersion?: string;
  permission: GhostOsPermissionVerdict;
  sidecarSpawn: { ok: boolean; error?: string; pid?: number };
  mcpHandshake: {
    ok: boolean;
    error?: string;
    protocolVersion?: string;
    serverName?: string;
  };
  toolPing: { ok: boolean; error?: string; toolCount?: number };
  overallOk: boolean;
  durationMs: number;
  summary: string;
}

export type GhostOsSidecarLifecycleEventType =
  | "spawned"
  | "handshake"
  | "disconnected"
  | "crashed"
  | "permission-error";

export interface GhostOsSidecarLifecycleEvent {
  type: GhostOsSidecarLifecycleEventType;
  serverName: string;
  detail?: string;
  error?: string;
  pid?: number;
  exitCode?: number | null;
  timestamp: number;
}

interface ElectronGhostOsAPI {
  getStatus: () => Promise<{
    installed: boolean;
    version?: string;
    visionModelInstalled: boolean;
    permissions: {
      accessibility: boolean;
      screenRecording: boolean;
      inputMonitoring: boolean;
    };
    binaryPath?: string;
  }>;
  runSetup: () => Promise<{
    success: boolean;
    stdout: string;
    stderr: string;
  }>;
  downloadVisionModel: () => Promise<{
    success: boolean;
    error?: string;
  }>;

  /**
   * Run the full Ghost OS preflight probe. Streams progress via
   * onSetupProgress with `kind: "preflight"`. Returns the final
   * PreflightResult (permission verdict, handshake, tool ping).
   */
  runPreflight: () => Promise<GhostOsPreflightResult>;

  /** Abort an in-flight preflight run. */
  cancelPreflight: () => Promise<{ cancelled: boolean }>;

  /** Deep-link to System Settings → Privacy → Screen Recording. macOS only. */
  openScreenRecordingSettings: () => Promise<{ success: boolean; error?: string }>;

  /** Quit + relaunch Selene so the kernel re-reads TCC grants. */
  relaunchApp: () => Promise<{ scheduled: boolean }>;

  /**
   * Restart ONLY the ghost-os MCP sidecar, without quitting Selene.
   * Recovery path for silent stdio hangs — see
   * docs/bug-reports/2026-04-17-ghost-os-mcp-stdio-hang.md.
   */
  reconnectSidecar: () => Promise<{ success: boolean; error?: string }>;

  /**
   * Subscribe this WebContents to sidecar lifecycle events.
   * Events are delivered via onSidecarLifecycle.
   */
  subscribeLifecycle: () => Promise<{ subscribed: boolean; error?: string }>;

  /**
   * Listen for streaming setup / preflight progress events.
   * Returns an unsubscribe function.
   */
  onSetupProgress: (
    callback: (event: GhostOsSetupProgressEvent) => void,
  ) => () => void;

  /**
   * Listen for sidecar lifecycle events emitted by MCPClientManager.
   * Renderer must call subscribeLifecycle() once before these events arrive.
   * Returns an unsubscribe function.
   */
  onSidecarLifecycle: (
    callback: (event: GhostOsSidecarLifecycleEvent) => void,
  ) => () => void;
}

export interface ElectronAPI {
  platform: NodeJS.Platform;
  isElectron: boolean;
  window: ElectronWindowAPI;
  app: ElectronAppAPI;
  shell: ElectronShellAPI;
  dialog: ElectronDialogAPI;
  settings: ElectronSettingsAPI;
  file: ElectronFileAPI;
  ipc: ElectronIpcAPI;
  model: ElectronModelAPI;
  logs: ElectronLogsAPI;
  browserSession?: ElectronBrowserSessionAPI;
  voiceHotkey?: ElectronVoiceHotkeyAPI;
  screenCapture?: ElectronScreenCaptureAPI;
  unifiedCapture?: ElectronUnifiedCaptureAPI;
  permissions?: ElectronPermissionsAPI;
  ghostOs: ElectronGhostOsAPI;
}

/**
 * Check if the app is running in Electron
 */
export function isElectron(): boolean {
  return typeof window !== "undefined" && "electronAPI" in window;
}

/**
 * Get the Electron API if available
 */
export function getElectronAPI(): ElectronAPI | null {
  if (isElectron()) {
    return (window as unknown as { electronAPI: ElectronAPI }).electronAPI;
  }
  return null;
}

/**
 * Open an external URL in the default browser
 * Works both in Electron and regular browser environments
 */
export async function openExternalUrl(url: string): Promise<void> {
  const electronAPI = getElectronAPI();
  if (electronAPI) {
    await electronAPI.shell.openExternal(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

// This file provides type definitions for use in the renderer process
