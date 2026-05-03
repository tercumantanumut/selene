"use client";

/**
 * Sprint 7 W7.1.G — Swift Search Engine settings (Experimental).
 *
 * Renders the opt-in toggle, disclosure copy, sidecar health snapshot and
 * engine-selection telemetry stats. Persists the toggle state via
 * `/api/settings` PUT (the same channel `AdvancedVectorSettings` ultimately
 * uses through `formState`). Stats + health are read directly from the
 * server-side modules through dependency-injected loaders so the component
 * stays unit-testable without spawning the actual sidecar.
 *
 * # Why dependency injection
 *
 * `getSwiftEngineSidecar()` and `getEngineSelectionStats()` live in modules
 * that import Node-only APIs (child_process, fs). Direct imports would fail
 * to render in jsdom-based component tests. We accept optional `healthLoader`
 * and `statsLoader` props (default to dynamic imports) so production renders
 * the real values and tests inject stubs.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Cpu } from "lucide-react";

import {
  invalidateSettingsCache,
  useSettings,
} from "@/lib/hooks/use-settings";
import type {
  EngineSelectionEvent,
  EngineSelectionStats,
} from "@/lib/swift-engine/telemetry";
import type { SwiftEngineHealth } from "@/lib/swift-engine/types";

export type HealthLoader = () => Promise<SwiftEngineHealth | null>;
export type StatsLoader = () => Promise<EngineSelectionStats>;

interface SwiftEngineSettingsProps {
  /**
   * Override how the component reads sidecar health. Defaults to a dynamic
   * import of `@/lib/swift-engine/sidecar`. Tests inject a sync stub.
   */
  healthLoader?: HealthLoader;
  /**
   * Override how the component reads engine selection stats. Defaults to a
   * dynamic import of `@/lib/swift-engine/telemetry`. Tests inject a sync stub.
   */
  statsLoader?: StatsLoader;
  /**
   * Override the persistence call. Returns `true` on success, `false`
   * otherwise. Defaults to `fetch("/api/settings", { method: "PUT" })`.
   */
  saveEngine?: (engine: "lance" | "swift") => Promise<boolean>;
}

const POLL_INTERVAL_MS = 5_000;

const DEFAULT_HEALTH_LOADER: HealthLoader = async () => {
  try {
    // Dynamic import: the sidecar module only resolves inside Electron-main
    // because it pulls `child_process`. In the renderer (web) it will throw —
    // we treat that as "no sidecar" and surface an idle-style placeholder.
    const mod = (await import("@/lib/swift-engine/sidecar")) as {
      getSwiftEngineSidecar?: () => { health(): SwiftEngineHealth };
    };
    if (typeof mod.getSwiftEngineSidecar !== "function") return null;
    return mod.getSwiftEngineSidecar().health();
  } catch {
    return null;
  }
};

const DEFAULT_STATS_LOADER: StatsLoader = async () => {
  try {
    const mod = (await import("@/lib/swift-engine/telemetry")) as {
      getEngineSelectionStats: () => EngineSelectionStats;
    };
    return mod.getEngineSelectionStats();
  } catch {
    return {
      totals: { lance: 0, swift: 0 },
      fallbacks: 0,
      totalEvents: 0,
      lastEvent: undefined,
    };
  }
};

const DEFAULT_SAVE_ENGINE = async (engine: "lance" | "swift"): Promise<boolean> => {
  try {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vectorSearchSearchEngine: engine }),
    });
    if (!res.ok) return false;
    void invalidateSettingsCache();
    return true;
  } catch {
    return false;
  }
};

function readEngineFromSettings(
  settings: Record<string, unknown> | null,
): "lance" | "swift" {
  const value = settings?.["vectorSearchSearchEngine"];
  return value === "swift" ? "swift" : "lance";
}

export function SwiftEngineSettings({
  healthLoader = DEFAULT_HEALTH_LOADER,
  statsLoader = DEFAULT_STATS_LOADER,
  saveEngine = DEFAULT_SAVE_ENGINE,
}: SwiftEngineSettingsProps = {}) {
  const { settings } = useSettings();
  const persistedEngine = readEngineFromSettings(settings);

  const [enabled, setEnabled] = useState<boolean>(persistedEngine === "swift");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [health, setHealth] = useState<SwiftEngineHealth | null>(null);
  const [stats, setStats] = useState<EngineSelectionStats>({
    totals: { lance: 0, swift: 0 },
    fallbacks: 0,
    totalEvents: 0,
    lastEvent: undefined,
  });

  // Sync local state when the cached settings change (e.g. another tab saved).
  useEffect(() => {
    setEnabled(persistedEngine === "swift");
  }, [persistedEngine]);

  // Poll sidecar health + telemetry stats while the section is mounted.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    let cancelled = false;
    const tick = async () => {
      try {
        const [h, s] = await Promise.all([healthLoader(), statsLoader()]);
        if (cancelled || !isMountedRef.current) return;
        setHealth(h);
        setStats(s);
      } catch {
        // Defensive: a thrown loader must never crash the settings page.
      }
    };
    void tick();
    const id = setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      isMountedRef.current = false;
      clearInterval(id);
    };
  }, [healthLoader, statsLoader]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      setEnabled(next);
      setSaving(true);
      setSaveError(null);
      const target: "lance" | "swift" = next ? "swift" : "lance";
      try {
        const ok = await saveEngine(target);
        if (!ok) {
          setSaveError("Failed to save Swift engine setting");
          setEnabled(!next);
        }
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "Save failed");
        setEnabled(!next);
      } finally {
        setSaving(false);
      }
    },
    [saveEngine],
  );

  return (
    <div
      data-testid="swift-engine-settings"
      className="rounded-lg border border-terminal-border overflow-hidden"
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 p-4 transition-colors hover:bg-terminal-cream dark:hover:bg-terminal-cream-dark/70"
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse Swift engine settings" : "Expand Swift engine settings"}
      >
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-terminal-muted" />
          <span className="font-mono text-sm text-terminal-dark">
            Swift Search Engine (Experimental)
          </span>
        </div>
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-terminal-muted" />
        ) : (
          <ChevronRight className="w-4 h-4 text-terminal-muted" />
        )}
      </button>

      {expanded && (
        <div className="p-4 space-y-5 border-t border-terminal-border/50 bg-terminal-cream/95 dark:bg-terminal-cream-dark/50">
          <p className="font-mono text-xs text-terminal-muted">
            Experimental retrieval engine that runs a local Swift sidecar
            alongside LanceDB. Currently behind opt-in while we validate parity.
          </p>
          <ul className="list-disc pl-5 space-y-1 font-mono text-xs text-terminal-muted">
            <li>Local-only — no data leaves your device.</li>
            <li>Uses ~50–80&nbsp;MB additional disk for the bundled binary.</li>
            <li>Falls back to LanceDB automatically on failure.</li>
          </ul>

          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              data-testid="swift-engine-toggle"
              checked={enabled}
              disabled={saving}
              onChange={(e) => {
                void handleToggle(e.target.checked);
              }}
              className="size-4 accent-terminal-green"
              aria-label="Enable Swift retrieval engine"
            />
            <span className="font-mono text-sm text-terminal-dark">
              Enable Swift retrieval engine
            </span>
          </label>

          {saveError && (
            <p
              role="alert"
              className="font-mono text-xs text-red-600"
              data-testid="swift-engine-save-error"
            >
              {saveError}
            </p>
          )}

          <HealthRow health={health} />
          <StatsRow stats={stats} />
        </div>
      )}
    </div>
  );
}

function HealthRow({ health }: { health: SwiftEngineHealth | null }) {
  const state = health?.state ?? "idle";
  const totals = health?.totals ?? { requests: 0, errors: 0, restarts: 0 };

  return (
    <section
      aria-label="Swift sidecar health"
      data-testid="swift-engine-health"
      className="space-y-2 p-3 rounded bg-terminal-cream/50"
    >
      <h4 className="font-mono text-xs text-terminal-amber uppercase tracking-wide font-semibold">
        Sidecar status
      </h4>
      <div className="flex items-center gap-3 font-mono text-xs text-terminal-dark">
        <span
          data-testid="swift-engine-state-badge"
          className={`px-2 py-0.5 rounded text-[10px] uppercase tracking-wide ${stateBadgeClass(state)}`}
        >
          {state}
        </span>
        <span data-testid="swift-engine-requests">
          requests: <strong>{totals.requests}</strong>
        </span>
        <span data-testid="swift-engine-errors">
          errors: <strong>{totals.errors}</strong>
        </span>
        <span data-testid="swift-engine-restarts">
          restarts: <strong>{totals.restarts}</strong>
        </span>
      </div>
    </section>
  );
}

function StatsRow({ stats }: { stats: EngineSelectionStats }) {
  return (
    <section
      aria-label="Engine selection telemetry"
      data-testid="swift-engine-stats"
      className="space-y-2 p-3 rounded bg-terminal-cream/50"
    >
      <h4 className="font-mono text-xs text-terminal-amber uppercase tracking-wide font-semibold">
        Engine selection
      </h4>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-terminal-dark">
        <span data-testid="swift-engine-stats-lance">
          lance: <strong>{stats.totals.lance}</strong>
        </span>
        <span data-testid="swift-engine-stats-swift">
          swift: <strong>{stats.totals.swift}</strong>
        </span>
        <span data-testid="swift-engine-stats-fallbacks">
          fallbacks: <strong>{stats.fallbacks}</strong>
        </span>
        <span data-testid="swift-engine-stats-total">
          total: <strong>{stats.totalEvents}</strong>
        </span>
      </div>
      {stats.lastEvent && <LastEventLine event={stats.lastEvent} />}
    </section>
  );
}

function LastEventLine({ event }: { event: EngineSelectionEvent }) {
  return (
    <p
      data-testid="swift-engine-stats-last"
      className="font-mono text-[11px] text-terminal-muted"
    >
      last: <strong>{event.engine}</strong> · {event.outcome}
      {event.durationMs !== undefined ? ` · ${event.durationMs}ms` : ""}
      {event.errorCode ? ` · ${event.errorCode}` : ""}
    </p>
  );
}

function stateBadgeClass(state: string): string {
  switch (state) {
    case "ready":
      return "bg-emerald-100 text-emerald-800";
    case "starting":
      return "bg-amber-100 text-amber-800";
    case "degraded":
      return "bg-orange-100 text-orange-800";
    case "stopped":
      return "bg-rose-100 text-rose-800";
    case "idle":
    default:
      return "bg-slate-100 text-slate-700";
  }
}
