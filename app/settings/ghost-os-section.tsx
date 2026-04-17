"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  CheckCircle2Icon,
  XCircleIcon,
  CircleIcon,
  CircleDotIcon,
  DownloadIcon,
  Loader2Icon,
  RefreshCwIcon,
  MonitorIcon,
  ExternalLinkIcon,
  AlertTriangleIcon,
  PowerIcon,
  PlayIcon,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import {
  getElectronAPI,
  type GhostOsPreflightResult,
  type GhostOsPreflightStage,
  type GhostOsSetupProgressEvent,
  type GhostOsSidecarLifecycleEvent,
  type GhostOsStageStatus,
} from "@/lib/electron/types";

interface GhostOsStatusData {
  installed: boolean;
  version?: string;
  visionModelInstalled: boolean;
  permissions: {
    accessibility: boolean;
    screenRecording: boolean;
    inputMonitoring: boolean;
  };
  binaryPath?: string;
}

/**
 * Ordered list of preflight stages for the checklist UI.
 * Keep this in sync with PreflightStage in lib/ghost-os/preflight.ts.
 */
const PREFLIGHT_STAGES: ReadonlyArray<GhostOsPreflightStage> = [
  "binary_located",
  "permission_preflight",
  "sidecar_spawn",
  "mcp_handshake",
  "first_tool_ping",
] as const;

type StageMap = Partial<
  Record<
    GhostOsPreflightStage,
    {
      status: GhostOsStageStatus;
      detail?: string;
      error?: string;
    }
  >
>;

/**
 * Ghost OS settings section — shows installation status, permissions,
 * vision model state, and a live wizard that probes the real end-to-end
 * sidecar path (not just `ghost doctor` stdout).
 *
 * Key behaviors:
 *  - Revalidates status on window focus + tab visibilitychange so the panel
 *    never renders stale "granted" after the user fixed TCC outside Selene.
 *  - Streams per-stage preflight progress via `ghostos:setupProgress`.
 *  - Subscribes to `ghostos:sidecarLifecycle` to surface permission errors
 *    emitted by MCPClientManager (including TCC-stale detection).
 *  - Renders verdict-specific remediation (denied vs. tcc_stale vs. granted).
 *  - Aborts in-flight preflight on unmount so closing the panel never leaves
 *    a stuck spinner.
 */
export function GhostOsSection() {
  const t = useTranslations("settings.ghostOs");
  const [status, setStatus] = useState<GhostOsStatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [setupRunning, setSetupRunning] = useState(false);
  const [visionDownloading, setVisionDownloading] = useState(false);
  const [visionProgress, setVisionProgress] = useState(0);

  // Preflight wizard state
  const [preflightRunning, setPreflightRunning] = useState(false);
  const [preflightResult, setPreflightResult] =
    useState<GhostOsPreflightResult | null>(null);
  const [stageMap, setStageMap] = useState<StageMap>({});
  const [sidecarEvents, setSidecarEvents] = useState<
    GhostOsSidecarLifecycleEvent[]
  >([]);

  const mountedRef = useRef(true);
  const operationInProgress =
    setupRunning || visionDownloading || preflightRunning;

  // -------------------------------------------------------------------------
  // Status check (also used as revalidation source)
  // -------------------------------------------------------------------------
  const checkStatus = useCallback(async () => {
    if (!mountedRef.current) return;
    setLoading(true);
    setStatusError(null);
    try {
      const electronAPI = getElectronAPI();
      if (electronAPI?.ghostOs) {
        const result = await electronAPI.ghostOs.getStatus();
        if (mountedRef.current) setStatus(result);
      } else {
        const response = await fetch("/api/ghost-os/status");
        if (response.ok) {
          if (mountedRef.current) setStatus(await response.json());
        } else if (mountedRef.current) {
          setStatusError(t("statusCheckFailed", { code: response.status }));
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      console.error("[GhostOS] Status check failed:", error);
      if (mountedRef.current) setStatusError(msg);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [t]);

  // -------------------------------------------------------------------------
  // Mount — initial check + revalidation on focus / visibilitychange.
  //
  // This is the fix for "stale wizard state": the user may have granted
  // permission in System Settings and then returned to Selene. Without a
  // revalidation hook, the panel would keep showing the pre-grant state until
  // manual refresh. macOS TCC changes take effect on next app launch, but
  // the status poll still reflects user action so the UI doesn't lie.
  // -------------------------------------------------------------------------
  useEffect(() => {
    mountedRef.current = true;
    checkStatus();

    const onFocus = () => {
      if (mountedRef.current) checkStatus();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible" && mountedRef.current) {
        checkStatus();
      }
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      mountedRef.current = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);

      // Abort any in-flight preflight so the wizard doesn't leak a probe
      // after the user navigates away.
      const electronAPI = getElectronAPI();
      electronAPI?.ghostOs?.cancelPreflight?.().catch(() => {
        // Non-fatal — the main process tolerates cancel-while-idle.
      });
    };
  }, [checkStatus]);

  // -------------------------------------------------------------------------
  // Subscribe to streaming setup/preflight progress
  // -------------------------------------------------------------------------
  useEffect(() => {
    const electronAPI = getElectronAPI();
    if (!electronAPI?.ghostOs?.onSetupProgress) return;

    const unsub = electronAPI.ghostOs.onSetupProgress(
      (event: GhostOsSetupProgressEvent) => {
        if (!mountedRef.current) return;
        setStageMap((prev) => ({
          ...prev,
          [event.stage]: {
            status: event.status,
            detail: event.detail,
            error: event.error,
          },
        }));
      },
    );
    return () => {
      unsub?.();
    };
  }, []);

  // -------------------------------------------------------------------------
  // Subscribe to sidecar lifecycle events (spawn / crash / permission-error)
  // -------------------------------------------------------------------------
  useEffect(() => {
    const electronAPI = getElectronAPI();
    if (
      !electronAPI?.ghostOs?.subscribeLifecycle ||
      !electronAPI.ghostOs.onSidecarLifecycle
    ) {
      return;
    }

    electronAPI.ghostOs.subscribeLifecycle().catch((err: unknown) => {
      console.warn("[GhostOS] subscribeLifecycle failed:", err);
    });

    const unsub = electronAPI.ghostOs.onSidecarLifecycle(
      (event: GhostOsSidecarLifecycleEvent) => {
        if (!mountedRef.current) return;
        // Keep only last 20 events to prevent unbounded growth.
        setSidecarEvents((prev) => [event, ...prev].slice(0, 20));

        // Surface permission errors as toasts so the user isn't staring at
        // an opaque "granted" while the kernel silently denied every capture.
        if (event.type === "permission-error") {
          toast.error(t("sidecarPermissionErrorToast"), {
            description: event.error ?? event.detail,
          });
        }
      },
    );
    return () => {
      unsub?.();
    };
  }, [t]);

  // -------------------------------------------------------------------------
  // Vision model download progress
  // -------------------------------------------------------------------------
  useEffect(() => {
    const electronAPI = getElectronAPI();
    if (!electronAPI?.model?.onProgress) return;

    const handleProgress = (data: {
      modelId: string;
      status: string;
      progress?: number;
      error?: string;
    }) => {
      if (data.modelId !== "ghostos-showui-2b") return;
      if (!mountedRef.current) return;

      if (data.status === "downloading" && data.progress !== undefined) {
        setVisionProgress(data.progress);
      } else if (data.status === "completed") {
        setVisionDownloading(false);
        setVisionProgress(100);
        toast.success(t("visionModelDownloaded"));
        checkStatus();
      } else if (data.status === "error") {
        setVisionDownloading(false);
        setVisionProgress(0);
        toast.error(
          t("visionDownloadFailed", { error: data.error || "Unknown error" }),
        );
      }
    };

    electronAPI.model.onProgress(handleProgress);
    return () => {
      electronAPI.model.removeProgressListener();
    };
  }, [checkStatus, t]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------
  const handleSetup = async () => {
    if (operationInProgress) return;
    setSetupRunning(true);
    setStageMap({});
    try {
      const electronAPI = getElectronAPI();
      if (electronAPI?.ghostOs) {
        const result = await electronAPI.ghostOs.runSetup();
        if (result.success) {
          toast.success(t("setupCompleted"));
        } else {
          toast.error(t("setupFailed", { error: result.stderr }));
        }
      } else {
        const response = await fetch("/api/ghost-os/setup", { method: "POST" });
        const result = await response.json();
        if (result.success) toast.success(t("setupCompleted"));
        else toast.error(t("setupFailed", { error: result.stderr }));
      }
      await checkStatus();
    } catch (error) {
      toast.error(t("setupFailedGeneric"));
      console.error("[GhostOS] Setup error:", error);
    } finally {
      if (mountedRef.current) setSetupRunning(false);
    }
  };

  const handleRunPreflight = async () => {
    if (operationInProgress) return;
    const electronAPI = getElectronAPI();
    if (!electronAPI?.ghostOs?.runPreflight) {
      toast.error(t("preflightRequiresDesktop"));
      return;
    }

    setPreflightRunning(true);
    setPreflightResult(null);
    setStageMap({});
    try {
      const result = await electronAPI.ghostOs.runPreflight();
      if (!mountedRef.current) return;
      setPreflightResult(result);
      await checkStatus();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      toast.error(t("preflightFailed"), { description: msg });
      console.error("[GhostOS] Preflight error:", error);
    } finally {
      if (mountedRef.current) setPreflightRunning(false);
    }
  };

  const handleCancelPreflight = async () => {
    const electronAPI = getElectronAPI();
    try {
      await electronAPI?.ghostOs?.cancelPreflight?.();
    } catch {
      // non-fatal
    }
    if (mountedRef.current) setPreflightRunning(false);
  };

  const handleOpenSettings = async () => {
    const electronAPI = getElectronAPI();
    try {
      const result = await electronAPI?.ghostOs?.openScreenRecordingSettings?.();
      if (result && !result.success) {
        toast.error(t("openSettingsFailed"), { description: result.error });
      }
    } catch (error) {
      toast.error(t("openSettingsFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleRelaunch = async () => {
    const electronAPI = getElectronAPI();
    try {
      await electronAPI?.ghostOs?.relaunchApp?.();
    } catch (error) {
      toast.error(t("relaunchFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // ---------------------------------------------------------------------------
  // Reconnect the ghost-os MCP sidecar without quitting the whole app.
  //
  // Wired up as a UI recovery path for the silent stdio-hang class of bugs
  // (see docs/bug-reports/2026-04-17-ghost-os-mcp-stdio-hang.md). Before this
  // the only way out of a wedged sidecar was `relaunchApp` — nuclear.
  // ---------------------------------------------------------------------------
  const [sidecarReconnecting, setSidecarReconnecting] = useState(false);
  const handleReconnectSidecar = async () => {
    if (sidecarReconnecting) return;
    const electronAPI = getElectronAPI();
    if (!electronAPI?.ghostOs?.reconnectSidecar) {
      toast.error(t("reconnectSidecarFailed"), {
        description: t("preflightRequiresDesktop"),
      });
      return;
    }
    setSidecarReconnecting(true);
    try {
      const result = await electronAPI.ghostOs.reconnectSidecar();
      if (!mountedRef.current) return;
      if (result.success) {
        toast.success(t("reconnectSidecarSucceeded"));
        await checkStatus();
      } else {
        toast.error(t("reconnectSidecarFailed"), {
          description: result.error,
        });
      }
    } catch (error) {
      toast.error(t("reconnectSidecarFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (mountedRef.current) setSidecarReconnecting(false);
    }
  };

  const handleDownloadVision = async () => {
    if (operationInProgress) return;
    setVisionDownloading(true);
    setVisionProgress(0);
    try {
      const electronAPI = getElectronAPI();
      if (electronAPI?.ghostOs) {
        const result = await electronAPI.ghostOs.downloadVisionModel();
        if (!result.success && mountedRef.current) {
          setVisionDownloading(false);
          toast.error(
            t("downloadFailedWithError", {
              error: result.error || "Unknown error",
            }),
          );
        }
      } else {
        toast.error(t("visionRequiresDesktop"));
        setVisionDownloading(false);
      }
    } catch (error) {
      toast.error(t("downloadFailed"));
      console.error("[GhostOS] Vision download error:", error);
      if (mountedRef.current) setVisionDownloading(false);
    }
  };

  // -------------------------------------------------------------------------
  // Render helpers
  // -------------------------------------------------------------------------
  const StatusIcon = ({ ok }: { ok: boolean }) =>
    ok ? (
      <CheckCircle2Icon className="h-4 w-4 text-emerald-500" />
    ) : (
      <XCircleIcon className="h-4 w-4 text-red-500" />
    );

  const StageIcon = ({ status }: { status: GhostOsStageStatus | undefined }) => {
    switch (status) {
      case "ok":
        return <CheckCircle2Icon className="h-4 w-4 text-emerald-500" />;
      case "failed":
        return <XCircleIcon className="h-4 w-4 text-red-500" />;
      case "running":
        return <CircleDotIcon className="h-4 w-4 text-blue-500 animate-pulse" />;
      case "skipped":
        return <CircleIcon className="h-4 w-4 text-terminal-muted opacity-40" />;
      default:
        return <CircleIcon className="h-4 w-4 text-terminal-muted opacity-40" />;
    }
  };

  const stageLabel = (stage: GhostOsPreflightStage): string => {
    const map: Record<GhostOsPreflightStage, string> = {
      binary_located: t("stageBinaryLocated"),
      permission_preflight: t("stagePermissionPreflight"),
      sidecar_spawn: t("stageSidecarSpawn"),
      mcp_handshake: t("stageMcpHandshake"),
      first_tool_ping: t("stageFirstToolPing"),
      complete: t("stageComplete"),
    };
    return map[stage];
  };

  if (loading && !status) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-terminal-muted">
        <Loader2Icon className="h-4 w-4 animate-spin" />
        {t("checkingStatus")}
      </div>
    );
  }

  const verdict = preflightResult?.permission;
  const hasPermissionIssue =
    verdict &&
    (verdict.kind === "denied" ||
      verdict.kind === "tcc_stale" ||
      verdict.kind === "wrong-responsible-process");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MonitorIcon className="h-5 w-5" />
          <h3 className="font-mono text-sm font-semibold text-terminal-dark">
            {t("heading")}
          </h3>
          <span className="text-xs text-terminal-muted">{t("subtitle")}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={checkStatus}
          disabled={loading}
          aria-label={t("refreshAriaLabel")}
        >
          <RefreshCwIcon className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Status error */}
      {statusError && !status && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
          <div className="flex items-center gap-2 text-sm text-amber-600">
            <AlertTriangleIcon className="h-4 w-4" />
            <span>{t("statusCheckFailedLabel")}</span>
          </div>
          <p className="text-xs text-terminal-muted">{statusError}</p>
          <Button variant="outline" size="sm" onClick={checkStatus}>
            {t("retry")}
          </Button>
        </div>
      )}

      {/* Installation + permissions */}
      {(status || !statusError) && (
        <div className="rounded-lg border p-3 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm">
              <StatusIcon ok={status?.installed ?? false} />
              <span>{t("installation")}</span>
            </div>
            {status?.installed ? (
              <span className="text-xs text-terminal-muted">
                v{status.version || "unknown"} — {status.binaryPath}
              </span>
            ) : (
              <a
                href="https://github.com/ghostwright/ghost-os"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-blue-500 hover:underline"
              >
                {t("installViaHomebrew")}
                <ExternalLinkIcon className="h-3 w-3" />
              </a>
            )}
          </div>

          {status?.installed && (
            <>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm">
                  <StatusIcon ok={status.permissions.accessibility} />
                  <span>{t("accessibility")}</span>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm">
                  <StatusIcon ok={status.permissions.screenRecording} />
                  <span>{t("screenRecording")}</span>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm">
                  <StatusIcon ok={status.permissions.inputMonitoring} />
                  <span>{t("inputMonitoring")}</span>
                  <span className="text-xs text-terminal-muted">
                    {t("inputMonitoringHint")}
                  </span>
                </div>
              </div>
            </>
          )}

          {status?.installed && (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm">
                <StatusIcon ok={status.visionModelInstalled} />
                <span>{t("visionModel")}</span>
                <span className="text-xs text-terminal-muted">
                  {t("visionModelSize")}
                </span>
              </div>
              {!status.visionModelInstalled && !visionDownloading && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDownloadVision}
                  disabled={operationInProgress}
                >
                  <DownloadIcon className="h-3.5 w-3.5 mr-1" />
                  {t("download")}
                </Button>
              )}
              {visionDownloading && (
                <div className="flex items-center gap-2">
                  <div className="h-1.5 w-24 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all duration-300"
                      style={{ width: `${visionProgress}%` }}
                    />
                  </div>
                  <span className="text-xs text-terminal-muted">
                    {visionProgress}%
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Wizard preflight */}
      {status?.installed && (
        <div className="rounded-lg border p-3 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="font-mono text-sm font-semibold text-terminal-dark">
                {t("wizardHeading")}
              </h4>
              <p className="text-xs text-terminal-muted">
                {t("wizardSubtitle")}
              </p>
            </div>
            <div className="flex gap-2">
              {preflightRunning ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCancelPreflight}
                >
                  {t("preflightCancel")}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRunPreflight}
                  disabled={operationInProgress}
                >
                  <PlayIcon className="h-3.5 w-3.5 mr-1" />
                  {t("runPreflight")}
                </Button>
              )}
            </div>
          </div>

          {(preflightRunning || Object.keys(stageMap).length > 0) && (
            <ul className="space-y-1.5 text-sm">
              {PREFLIGHT_STAGES.map((stage) => {
                const s = stageMap[stage];
                return (
                  <li key={stage} className="flex items-start gap-2">
                    <StageIcon status={s?.status} />
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span>{stageLabel(stage)}</span>
                        {s?.detail && (
                          <span className="text-xs text-terminal-muted font-mono truncate">
                            {s.detail}
                          </span>
                        )}
                      </div>
                      {s?.error && (
                        <p className="text-xs text-red-500 mt-0.5">{s.error}</p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {preflightResult && !preflightRunning && (
            <PermissionVerdictPane
              result={preflightResult}
              onOpenSettings={handleOpenSettings}
              onRelaunch={handleRelaunch}
            />
          )}

          {preflightResult && !preflightRunning && (
            <p className="text-xs text-terminal-muted font-mono border-t pt-2">
              {preflightResult.summary}
            </p>
          )}
        </div>
      )}

      {/* Recent sidecar events */}
      {sidecarEvents.length > 0 && (
        <details className="rounded-lg border p-3">
          <summary className="cursor-pointer text-xs text-terminal-muted font-mono">
            {t("sidecarEventsLabel")} ({sidecarEvents.length})
          </summary>
          <ul className="mt-2 space-y-1 text-xs font-mono max-h-48 overflow-auto">
            {sidecarEvents.map((ev, idx) => (
              <li
                key={`${ev.timestamp}-${idx}`}
                className={`flex items-start gap-2 ${
                  ev.type === "permission-error" || ev.type === "crashed"
                    ? "text-red-500"
                    : ev.type === "handshake"
                      ? "text-emerald-500"
                      : "text-terminal-muted"
                }`}
              >
                <span className="opacity-60">
                  {new Date(ev.timestamp).toLocaleTimeString()}
                </span>
                <span className="font-semibold">{ev.type}</span>
                <span className="opacity-70">{ev.serverName}</span>
                {ev.error && (
                  <span className="truncate" title={ev.error}>
                    — {ev.error}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Actions */}
      {status?.installed && (
        <div className="flex gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={handleSetup}
            disabled={operationInProgress}
          >
            {setupRunning ? (
              <Loader2Icon className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : null}
            {t("runSetup")}
          </Button>
          {/*
            Reconnect sidecar — non-destructive recovery path for a wedged
            MCP child. Always visible once ghost-os is installed so users
            hitting the silent stdio-hang class of bugs have a one-click
            exit that does NOT restart the whole app.
          */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleReconnectSidecar}
            disabled={sidecarReconnecting}
          >
            {sidecarReconnecting ? (
              <Loader2Icon className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <RefreshCwIcon className="h-3.5 w-3.5 mr-1" />
            )}
            {sidecarReconnecting
              ? t("reconnectSidecarRunning")
              : t("reconnectSidecar")}
          </Button>
          {hasPermissionIssue && (
            <>
              <Button variant="outline" size="sm" onClick={handleOpenSettings}>
                <ExternalLinkIcon className="h-3.5 w-3.5 mr-1" />
                {t("openScreenRecordingSettings")}
              </Button>
              <Button variant="outline" size="sm" onClick={handleRelaunch}>
                <PowerIcon className="h-3.5 w-3.5 mr-1" />
                {t("relaunchSelene")}
              </Button>
            </>
          )}
        </div>
      )}

      {!status?.installed && !statusError && (
        <p className="text-xs text-terminal-muted">{t("description")}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PermissionVerdictPane — verdict-specific remediation UI
//
// The TCC-stale path is the critical one: it tells the user exactly what
// the old wizard missed — that re-granting Selene.app won't stick until
// the existing entry is REMOVED (minus button) and re-added. macOS keeps
// a cached bundle signature in the TCC db and will continue denying the
// real Selene.app capture until you purge that stale entry.
// ---------------------------------------------------------------------------
function PermissionVerdictPane({
  result,
  onOpenSettings,
  onRelaunch,
}: {
  result: GhostOsPreflightResult;
  onOpenSettings: () => void;
  onRelaunch: () => void;
}) {
  const t = useTranslations("settings.ghostOs");
  const verdict = result.permission;

  if (verdict.kind === "granted") {
    return (
      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
        <div className="flex items-center gap-2 text-sm text-emerald-600">
          <CheckCircle2Icon className="h-4 w-4" />
          <span className="font-semibold">{t("verdictGrantedTitle")}</span>
        </div>
        <p className="text-xs text-terminal-muted mt-1">
          {t("verdictGrantedBody")}
        </p>
      </div>
    );
  }

  if (verdict.kind === "non-darwin" || verdict.kind === "not-probed") {
    return null;
  }

  if (verdict.kind === "denied") {
    return (
      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
        <div className="flex items-center gap-2 text-sm text-amber-600">
          <AlertTriangleIcon className="h-4 w-4" />
          <span className="font-semibold">{t("verdictDeniedTitle")}</span>
        </div>
        <p className="text-xs text-terminal-muted">{t("verdictDeniedBody")}</p>
        <ol className="text-xs text-terminal-dark space-y-1 list-decimal list-inside">
          <li>{t("verdictDeniedStep1")}</li>
          <li>{t("verdictDeniedStep2")}</li>
          <li>
            <span className="font-semibold">{t("verdictDeniedStep3")}</span>
          </li>
        </ol>
        <div className="flex gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={onOpenSettings}>
            <ExternalLinkIcon className="h-3.5 w-3.5 mr-1" />
            {t("openScreenRecordingSettings")}
          </Button>
          <Button variant="outline" size="sm" onClick={onRelaunch}>
            <PowerIcon className="h-3.5 w-3.5 mr-1" />
            {t("relaunchSelene")}
          </Button>
        </div>
      </div>
    );
  }

  if (verdict.kind === "tcc_stale") {
    return (
      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 space-y-2">
        <div className="flex items-center gap-2 text-sm text-amber-700">
          <AlertTriangleIcon className="h-4 w-4" />
          <span className="font-semibold">{t("verdictTccStaleTitle")}</span>
        </div>
        <p className="text-xs text-terminal-dark">{t("verdictTccStaleBody")}</p>
        <ol className="text-xs text-terminal-dark space-y-1 list-decimal list-inside">
          <li>{t("verdictTccStaleStep1")}</li>
          <li>{t("verdictTccStaleStep2")}</li>
          <li>{t("verdictTccStaleStep3")}</li>
          <li>
            <span className="font-semibold">{t("verdictTccStaleStep4")}</span>
          </li>
        </ol>
        {verdict.message && (
          <p className="text-xs text-terminal-muted italic">
            {verdict.message}
          </p>
        )}
        <div className="flex gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={onOpenSettings}>
            <ExternalLinkIcon className="h-3.5 w-3.5 mr-1" />
            {t("openScreenRecordingSettings")}
          </Button>
          <Button variant="outline" size="sm" onClick={onRelaunch}>
            <PowerIcon className="h-3.5 w-3.5 mr-1" />
            {t("relaunchSelene")}
          </Button>
        </div>
      </div>
    );
  }

  if (verdict.kind === "wrong-responsible-process") {
    return (
      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
        <div className="flex items-center gap-2 text-sm text-amber-600">
          <AlertTriangleIcon className="h-4 w-4" />
          <span className="font-semibold">
            {t("verdictWrongResponsibleProcessTitle")}
          </span>
        </div>
        <p className="text-xs text-terminal-muted">
          {t("verdictWrongResponsibleProcessBody", {
            parent: verdict.detectedParent,
          })}
        </p>
        <div className="flex gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={onOpenSettings}>
            <ExternalLinkIcon className="h-3.5 w-3.5 mr-1" />
            {t("openScreenRecordingSettings")}
          </Button>
          <Button variant="outline" size="sm" onClick={onRelaunch}>
            <PowerIcon className="h-3.5 w-3.5 mr-1" />
            {t("relaunchSelene")}
          </Button>
        </div>
      </div>
    );
  }

  // verdict.kind === "unknown"
  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 space-y-1">
      <div className="flex items-center gap-2 text-sm text-amber-600">
        <AlertTriangleIcon className="h-4 w-4" />
        <span className="font-semibold">{t("verdictUnknownTitle")}</span>
      </div>
      <p className="text-xs text-terminal-muted">{verdict.error}</p>
    </div>
  );
}
