/**
 * Shared TransformerDevice type and utilities used by both local-embeddings
 * and the cross-encoder reranker.
 */

import { execSync } from "node:child_process";
import os from "node:os";

export type TransformerDevice =
  | "auto"
  | "gpu"
  | "cpu"
  | "wasm"
  | "webgpu"
  | "cuda"
  | "dml"
  | "webnn"
  | "webnn-npu"
  | "webnn-gpu"
  | "webnn-cpu";

const TRANSFORMER_DEVICES: readonly string[] = [
  "auto",
  "gpu",
  "cpu",
  "wasm",
  "webgpu",
  "cuda",
  "dml",
  "webnn",
  "webnn-npu",
  "webnn-gpu",
  "webnn-cpu",
];

function isTransformerDevice(value: string): value is TransformerDevice {
  return TRANSFORMER_DEVICES.includes(value);
}

/**
 * Resolve the preferred inference device based on env var and platform.
 * Pass `runtimeFallbackDevice` from the caller so this stays pure.
 */
export function resolvePreferredDevice(
  runtimeFallbackDevice: TransformerDevice | null
): TransformerDevice {
  if (runtimeFallbackDevice) return runtimeFallbackDevice;

  const configured = process.env.LOCAL_EMBEDDING_DEVICE?.trim().toLowerCase();
  if (configured && isTransformerDevice(configured)) return configured;

  if (process.platform === "win32") return "dml";
  if (process.platform === "linux" && process.arch === "x64") return "cuda";
  return "cpu";
}

export function isRecoverableGpuRuntimeError(error: unknown): boolean {
  const message = String(error ?? "").toLowerCase();
  return (
    message.includes("device instance has been suspended") ||
    message.includes("getdeviceremovedreason") ||
    message.includes("dxgi_error_device_removed") ||
    message.includes("dxgi_error_device_hung") ||
    message.includes("887a0005")
  );
}

// ---------------------------------------------------------------------------
// Apple Silicon generation detection
// ---------------------------------------------------------------------------

export interface AppleSiliconInfo {
  isAppleSilicon: boolean;
  /** 1 = M1, 2 = M2, 3 = M3, 4 = M4, null = unknown */
  generation: number | null;
  /** e.g. "Apple M4 Pro" */
  chipModel: string | null;
  rawCpuModel: string;
}

let _cachedSiliconInfo: AppleSiliconInfo | null = null;

/**
 * Detect Apple Silicon generation at runtime.
 *
 * Fast path: parses `os.cpus()[0].model` (e.g. "Apple M4 Pro").
 * Slow fallback: `sysctl -n hw.cpufamilyname` — maps known family names to
 * generation numbers. Cached after first call.
 *
 * CPU family names by generation (macOS 15 / 2025):
 *   M1: FIRESTORM / ICESTORM
 *   M2: BLIZZARD / AVALANCHE
 *   M3: IBIZA / EVEREST / SAWTOOTH
 *   M4: DONAN / TAHITI
 */
export function detectAppleSiliconInfo(): AppleSiliconInfo {
  if (_cachedSiliconInfo) return _cachedSiliconInfo;

  const rawCpuModel = os.cpus()[0]?.model ?? "";

  if (process.platform !== "darwin") {
    return (_cachedSiliconInfo = {
      isAppleSilicon: false,
      generation: null,
      chipModel: null,
      rawCpuModel,
    });
  }

  // Fast path: parse "Apple M4 Pro" style string from os.cpus()
  const mMatch = rawCpuModel.match(/Apple\s+M(\d+)(?:\s+(\w+))?/);
  if (mMatch) {
    const gen = parseInt(mMatch[1], 10);
    const variant = mMatch[2] ? ` ${mMatch[2]}` : "";
    return (_cachedSiliconInfo = {
      isAppleSilicon: true,
      generation: gen,
      chipModel: `Apple M${gen}${variant}`,
      rawCpuModel,
    });
  }

  // Slower sysctl fallback (works in Electron main process)
  try {
    const familyName = execSync("sysctl -n hw.cpufamilyname", {
      encoding: "utf8",
      timeout: 2000,
    })
      .trim()
      .toUpperCase();

    const generationMap: Record<string, number> = {
      FIRESTORM: 1, ICESTORM: 1,
      BLIZZARD: 2,  AVALANCHE: 2,
      IBIZA: 3,     EVEREST: 3,   SAWTOOTH: 3,
      DONAN: 4,     TAHITI: 4,
    };

    for (const [key, gen] of Object.entries(generationMap)) {
      if (familyName.includes(key)) {
        return (_cachedSiliconInfo = {
          isAppleSilicon: true,
          generation: gen,
          chipModel: `Apple M${gen} (${familyName})`,
          rawCpuModel,
        });
      }
    }

    // Darwin arm64 but unknown generation
    if (process.arch === "arm64") {
      return (_cachedSiliconInfo = {
        isAppleSilicon: true,
        generation: null,
        chipModel: familyName || null,
        rawCpuModel,
      });
    }
  } catch {
    // sysctl unavailable or timed out
  }

  return (_cachedSiliconInfo = {
    isAppleSilicon: process.arch === "arm64",
    generation: null,
    chipModel: null,
    rawCpuModel,
  });
}

/** Returns true if running on M4 or later Apple Silicon. */
export function isM4OrLater(): boolean {
  const info = detectAppleSiliconInfo();
  return info.isAppleSilicon && (info.generation ?? 0) >= 4;
}

/** Reset cached silicon info (for tests). */
function _resetAppleSiliconCache(): void {
  _cachedSiliconInfo = null;
}
