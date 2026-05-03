/**
 * Shared types for Phase 1 Swift engine integration.
 *
 * Sprint 7 ships the Swift CLI (binaries/selene-engine/<platform>/selene-engine)
 * as an Electron sidecar. This file defines the interface boundary used by
 * three subsystems:
 *
 *   1. lib/swift-engine/sidecar.ts         (W7.1.E)   — owns spawn/health/restart
 *   2. lib/vectordb/swift-engine-adapter.ts (W7.1.C)  — pipes search calls
 *   3. lib/vectordb/file-watcher.ts         (W7.1.D)  — emits index.notifyChange
 *
 * The sidecar exposes a single `sendRequest(method, params)` JSON-RPC entrypoint.
 * Higher-level adapters wrap that with typed signatures matching production
 * MCP tool schemas in the Swift package's SeleneEngineMCP/ToolDefinitions.swift.
 *
 * Phase 1 ship constraint: SEARCH_ENGINE config defaults to "lance" so this
 * code path is opt-in only until Phase 0 parity gate stays green and the
 * sidecar telemetry shows healthy adoption.
 */

export type SwiftEngineSearchMode = "lance" | "swift";

/** Lifecycle state surfaced by the supervisor. */
export type SwiftEngineSidecarState =
  | "idle"          // never started yet
  | "starting"      // spawn issued, awaiting initialize handshake
  | "ready"         // initialize handshake completed
  | "degraded"      // recoverable error; supervisor will restart
  | "stopped";      // intentionally torn down (no restart)

/** Single-shot health snapshot. */
export interface SwiftEngineHealth {
  state: SwiftEngineSidecarState;
  pid: number | null;
  uptimeMs: number;
  lastError?: string;
  /** Counts since this process started (not since this sidecar instance). */
  totals: {
    requests: number;
    errors: number;
    restarts: number;
  };
  /** Build manifest, populated from binaries/.../build-manifest.json. */
  manifest?: {
    sha256: string;
    arch: string;
    swiftVersion: string;
    builtAt: string;
  };
}

/** Options for spawning the sidecar. Mostly for tests; production uses defaults. */
export interface SwiftEngineSpawnOptions {
  /**
   * Override the binary path. In production this is resolved automatically
   * from process.resourcesPath (packaged) or the dev-mode build output dir.
   */
  binaryPath?: string;
  /** Override SELENE_DATA_DIR. Defaults to <app userData>/swift-engine. */
  dataDir?: string;
  /**
   * Maximum time to wait for the initialize handshake before declaring the
   * sidecar dead and falling back to LanceDB. Default: 5000ms.
   */
  startupTimeoutMs?: number;
  /**
   * Maximum time per request before the supervisor cancels and counts an
   * error. Default: 30000ms (matches Hummingbird transport idle window).
   */
  requestTimeoutMs?: number;
  /**
   * Auto-restart on unexpected exit. Default: true. Set false in tests that
   * intentionally kill the process to assert restart-once behavior.
   */
  autoRestart?: boolean;
}

/** Generic JSON-RPC request envelope. */
export interface SwiftEngineRequest<TParams = unknown> {
  method: string;
  params: TParams;
}

/** Generic JSON-RPC response. */
export interface SwiftEngineResponse<TResult = unknown> {
  result?: TResult;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * Supervisor surface. Singleton accessor lives in lib/swift-engine/sidecar.ts.
 */
export interface SwiftEngineSidecar {
  /** Lifecycle entry — idempotent. */
  start(options?: SwiftEngineSpawnOptions): Promise<void>;
  /** Send a JSON-RPC request over stdio MCP. Throws if the sidecar is dead. */
  sendRequest<TParams = unknown, TResult = unknown>(
    request: SwiftEngineRequest<TParams>,
  ): Promise<SwiftEngineResponse<TResult>>;
  /** Returns true once the initialize handshake has completed. */
  isReady(): boolean;
  /** Lifecycle exit — also called from app.before-quit. */
  dispose(): Promise<void>;
  /** Snapshot — cheap, safe to call from any thread. */
  health(): SwiftEngineHealth;
}

/** Errors raised when the sidecar can't service a request. */
export class SwiftEngineUnavailableError extends Error {
  readonly state: SwiftEngineSidecarState;
  constructor(state: SwiftEngineSidecarState, message: string) {
    super(`SwiftEngineUnavailable[${state}]: ${message}`);
    this.name = "SwiftEngineUnavailableError";
    this.state = state;
  }
}

/**
 * Resolution order for the bundled binary, mirroring claude-login-process.ts:180.
 *
 * 1. Explicit `binaryPath` (tests + dev-mode override)
 * 2. `process.resourcesPath/binaries/selene-engine/<platform>/selene-engine` (packaged)
 * 3. `process.cwd()/.build/release-bundle/<platform>/<arch>/selene-engine` (dev)
 */
export interface SwiftEngineBinaryCandidate {
  path: string;
  source: "explicit" | "packaged-resources" | "dev-build";
}
