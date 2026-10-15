import type { LLMProvider } from "@/lib/ai/providers";

export type ContextScope = "main" | "delegated";

export interface ContextProvenance {
  contextScope?: ContextScope;
  delegationId?: string;
  parentDelegationId?: string;
  providerSessionId?: string;
  provenanceVersion?: 1;
}

export interface ScopedCountOptions {
  provider?: LLMProvider;
  sessionMetadata?: Record<string, unknown> | null;
  /** Scope that belongs to the session being measured. Root sessions use main; worker sessions use delegated. */
  targetScope?: ContextScope;
  scopedMode?: "legacy" | "scoped";
  fallbackEnabled?: boolean;
  fallbackMinConfidence?: number;
  hasDelegatedAnnotations?: boolean;
}

const CLAUDECODE_PROVIDER: LLMProvider = "claudecode";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function readEnvBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (typeof raw !== "string") return defaultValue;
  return TRUE_VALUES.has(raw.trim().toLowerCase());
}

function readEnvNumber(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (typeof raw !== "string" || !raw.trim()) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return defaultValue;
  return parsed;
}

function isScopedCountingEnabled(): boolean {
  return readEnvBool("CONTEXT_SCOPED_COUNTING_ENABLED", false);
}

function isScopedDualCalcEnabled(): boolean {
  return readEnvBool("CONTEXT_SCOPED_COUNTING_DUAL_CALC", true);
}

export function isScopedFallbackEnabled(): boolean {
  return readEnvBool("CONTEXT_SCOPED_FALLBACK_ENABLED", true);
}

export function getScopedFallbackMinConfidence(): number {
  const value = readEnvNumber("CONTEXT_SCOPED_FALLBACK_MIN_CONFIDENCE", 0.85);
  return Math.max(0, Math.min(1, value));
}

export function shouldUseScopedCounting(provider?: LLMProvider): boolean {
  return provider === CLAUDECODE_PROVIDER && isScopedCountingEnabled();
}

export function shouldDualCalculate(provider?: LLMProvider): boolean {
  return provider === CLAUDECODE_PROVIDER && isScopedDualCalcEnabled();
}

export function normalizeProvenance(
  provenance: ContextProvenance | undefined
): ContextProvenance | undefined {
  if (!provenance || !provenance.contextScope) return undefined;
  return {
    contextScope: provenance.contextScope,
    delegationId: provenance.delegationId,
    parentDelegationId: provenance.parentDelegationId,
    providerSessionId: provenance.providerSessionId,
    provenanceVersion: provenance.provenanceVersion ?? 1,
  };
}

// Invariants:
// - Scoped counting is only authoritative for Claude Code when enabled.
// - main scope includes root session user/assistant turns and root-level final delegation results.
// - delegated scope excludes worker chatter/tool traces from root context math.
// - Unknown/low-confidence legacy rows are counted conservatively to avoid undercounting.
