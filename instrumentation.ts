/**
 * Next.js Instrumentation
 * 
 * This file is executed once when the Next.js server starts.
 * Used for initialization tasks like starting file watchers and background sync.
 * 
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  // Only run on server side
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const shouldLogAiSdkWarnings =
      process.env.AI_SDK_LOG_WARNINGS === "true" || process.env.AI_SDK_LOG_WARNINGS === "1";
    if (!shouldLogAiSdkWarnings) {
      const globalForAiSdk = globalThis as typeof globalThis & {
        AI_SDK_LOG_WARNINGS?: boolean;
      };
      globalForAiSdk.AI_SDK_LOG_WARNINGS = false;
    }

    console.log("[Instrumentation] Initializing server-side services...");

    const parseTruthy = (value?: string) => {
      if (!value) return false;
      const normalized = value.trim().toLowerCase();
      return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
    };

    const parsePositiveNumber = (value: string | undefined, fallback: number) => {
      if (!value) return fallback;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    };

    const memoryWatcherEnabled = parseTruthy(process.env.SELENE_MEMORY_WATCHER);
    if (memoryWatcherEnabled) {
      try {
        const v8 = await import("v8");
        const path = await import("path");
        const fs = await import("fs/promises");

        const globalForMemoryWatcher = globalThis as typeof globalThis & {
          __memoryWatcherInterval?: NodeJS.Timeout;
          __memoryWatcherLastSnapshotAt?: number;
        };

        if (!globalForMemoryWatcher.__memoryWatcherInterval) {
          const intervalMs = parsePositiveNumber(process.env.SELENE_MEMORY_WATCH_INTERVAL_MS, 5000);
          const snapshotEnabled = parseTruthy(process.env.SELENE_HEAP_SNAPSHOT);
          const snapshotCooldownMs = parsePositiveNumber(
            process.env.SELENE_HEAP_SNAPSHOT_COOLDOWN_MS,
            10 * 60 * 1000
          );
          const snapshotDir = process.env.SELENE_HEAP_SNAPSHOT_DIR
            ? process.env.SELENE_HEAP_SNAPSHOT_DIR
            : path.join(process.cwd(), ".local-data", "heapshots");

          let snapshotThreshold = Number(process.env.SELENE_HEAP_SNAPSHOT_THRESHOLD);
          if (!Number.isFinite(snapshotThreshold)) {
            snapshotThreshold = 0.75;
          }
          if (snapshotThreshold > 1) {
            snapshotThreshold = snapshotThreshold / 100;
          }
          snapshotThreshold = Math.min(Math.max(snapshotThreshold, 0.05), 0.95);

          let lastSnapshotAt = globalForMemoryWatcher.__memoryWatcherLastSnapshotAt ?? 0;
          let running = false;

          const toMB = (bytes: number) => Math.round(bytes / 1024 / 1024);

          const checkMemory = async () => {
            const heapStats = v8.getHeapStatistics();
            const heapUsed = heapStats.used_heap_size;
            const heapLimit = heapStats.heap_size_limit;
            const ratio = heapLimit ? heapUsed / heapLimit : 0;
            const memUsage = process.memoryUsage();

            console.log(
              "[MemoryWatcher] heapUsed=%dMB heapTotal=%dMB heapLimit=%dMB rss=%dMB ratio=%s%%",
              toMB(heapUsed),
              toMB(memUsage.heapTotal),
              toMB(heapLimit),
              toMB(memUsage.rss),
              (ratio * 100).toFixed(1)
            );

            if (!snapshotEnabled || ratio < snapshotThreshold) {
              return;
            }

            const now = Date.now();
            if (now - lastSnapshotAt < snapshotCooldownMs) {
              return;
            }

            try {
              await fs.mkdir(snapshotDir, { recursive: true });
              const stamp = new Date().toISOString().replace(/[:.]/g, "-");
              const filePath = path.join(snapshotDir, `heap-${stamp}-pid${process.pid}.heapsnapshot`);
              const savedPath = v8.writeHeapSnapshot(filePath);
              lastSnapshotAt = now;
              globalForMemoryWatcher.__memoryWatcherLastSnapshotAt = lastSnapshotAt;
              console.warn("[MemoryWatcher] Heap snapshot written: %s", savedPath);
            } catch (error) {
              console.error("[MemoryWatcher] Heap snapshot failed:", error);
            }
          };

          const interval = setInterval(() => {
            if (running) return;
            running = true;
            void checkMemory().finally(() => {
              running = false;
            });
          }, intervalMs);

          if (typeof interval.unref === "function") {
            interval.unref();
          }

          globalForMemoryWatcher.__memoryWatcherInterval = interval;

          console.log(
            "[MemoryWatcher] Enabled (interval=%dms, snapshot=%s, threshold=%d%%)",
            intervalMs,
            snapshotEnabled ? "on" : "off",
            Math.round(snapshotThreshold * 100)
          );
        } else {
          console.log("[MemoryWatcher] Already running, skipping.");
        }
      } catch (error) {
        console.error("[MemoryWatcher] Failed to start:", error);
      }
    }
    
    // Initialize settings first
    const { initializeSettings } = await import("@/lib/settings/settings-manager");
    initializeSettings();

    // Pre-resolve the user's shell environment while FDs are still available.
    // The vector sync that follows can exhaust file descriptors (EBADF), so
    // caching the shell PATH now ensures SDK auth can resolve 'node' later.
    if (process.env.SELENE_PRODUCTION_BUILD === "1") {
      try {
        const { getResolvedShellEnvironment } = await import("@/lib/shell-env/resolver");
        const shellEnv = getResolvedShellEnvironment();
        console.log("[Instrumentation] Shell env pre-cached, PATH available:", !!shellEnv.PATH);
      } catch (error) {
        console.error("[Instrumentation] Shell env pre-cache failed:", error);
      }
    }

    // Initialize vector sync system (file watchers + background sync)
    // Delay slightly to allow database to be ready
    setTimeout(async () => {
      try {
        const { initializeVectorSync } = await import("@/lib/vectordb/background-sync");
        await initializeVectorSync();
      } catch (error) {
        console.error("[Instrumentation] Error initializing vector sync:", error);
      }
    }, 2000);

    // Start observability cleanup job for stale runs
    setTimeout(async () => {
      try {
        const { startCleanupJob } = await import("@/lib/observability");
        startCleanupJob();
      } catch (error) {
        console.error("[Instrumentation] Error starting cleanup job:", error);
      }
    }, 3000);

    // Cleanup zombie runs after restart
    setTimeout(async () => {
      try {
        const { hasPendingInteractiveWait } = await import("@/lib/interactive-tool-bridge");
        const { findZombieRuns, markRunAsCancelled } = await import("@/lib/observability");
        const zombies = await findZombieRuns(5);
        let cancelledCount = 0;
        for (const run of zombies) {
          if (hasPendingInteractiveWait(run.sessionId)) {
            continue;
          }
          await markRunAsCancelled(run.id, "server_restart_cleanup", { forceCancelled: true });
          cancelledCount += 1;
        }
        if (cancelledCount > 0) {
          console.warn(`[Instrumentation] Auto-cancelled ${cancelledCount} zombie run(s) on startup`);
        }
      } catch (error) {
        console.error("[Instrumentation] Error cleaning up zombie runs:", error);
      }
    }, 3500);

    // Recover delegation completions persisted before a restart: re-schedule
    // the server-side auto-resume fallback so subagent results delivered
    // while the process was down still reach the initiator autonomously.
    // Runs after zombie-run cleanup so stale run state cannot block resume.
    setTimeout(async () => {
      try {
        const { recoverPendingDelegationAutoResumes } = await import(
          "@/lib/background-tasks/delegation-auto-resume"
        );
        recoverPendingDelegationAutoResumes();
      } catch (error) {
        console.error("[Instrumentation] Error recovering delegation auto-resumes:", error);
      }
    }, 4500);

    // Start scheduled task scheduler
    setTimeout(async () => {
      try {
        const { startScheduler } = await import("@/lib/scheduler/scheduler-service");
        await startScheduler();
        console.log("[Instrumentation] Scheduler service started");
      } catch (error) {
        console.error("[Instrumentation] Error starting scheduler:", error);
      }
    }, 4000);

    // Auto-connect to configured MCP servers
    setTimeout(async () => {
      try {
        const { loadSettings } = await import("@/lib/settings/settings-manager");
        const { MCPClientManager, resolveMCPConfig } = await import("@/lib/mcp/client-manager");

        const settings = loadSettings();
        const mcpConfig = settings.mcpServers?.mcpServers || {};
        const enabledServers = Object.entries(mcpConfig)
          .filter(([_, config]) => (config as any).enabled !== false)
          .map(([name]) => name);

        if (enabledServers.length > 0) {
          console.log(`[Instrumentation] Auto-connecting to ${enabledServers.length} MCP server(s)...`);
          const manager = MCPClientManager.getInstance();
          const env = settings.mcpEnvironment || {};

          for (const serverName of enabledServers) {
            const config = mcpConfig[serverName];
            if (!config) continue;

            try {
              const resolved = await resolveMCPConfig(serverName, config, env);
              await manager.connect(serverName, resolved);
              console.log(`[Instrumentation] MCP server "${serverName}" connected`);
            } catch (error) {
              console.warn(`[Instrumentation] MCP server "${serverName}" failed to connect:`, error);
            }
          }
          console.log("[Instrumentation] MCP auto-connect complete");
        }
      } catch (error) {
        console.error("[Instrumentation] Error auto-connecting MCP servers:", error);
      }
    }, 5000);

    console.log("[Instrumentation] Server-side services initialized");
  }
}
