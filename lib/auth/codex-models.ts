export const CODEX_MODEL_IDS = [
  // GPT-5.5 (released 2026-04-23 — 1M context, successor to 5.4)
  "gpt-5.5",
  "gpt-5.5-low",
  "gpt-5.5-medium",
  "gpt-5.5-high",
  "gpt-5.5-xhigh",
  // GPT-5.4
  "gpt-5.4",
  "gpt-5.4-low",
  "gpt-5.4-medium",
  "gpt-5.4-high",
  "gpt-5.4-xhigh",
  // GPT-5.4 Mini
  "gpt-5.4-mini",
  "gpt-5.4-mini-low",
  "gpt-5.4-mini-medium",
  "gpt-5.4-mini-high",
  "gpt-5.4-mini-xhigh",
  // GPT-5.3 Codex
  "gpt-5.3-codex",
  "gpt-5.3-codex-low",
  "gpt-5.3-codex-medium",
  "gpt-5.3-codex-high",
  "gpt-5.3-codex-xhigh",
  // GPT-5.3 Codex Spark
  "gpt-5.3-codex-spark",
  "gpt-5.3-codex-spark-low",
  "gpt-5.3-codex-spark-medium",
  "gpt-5.3-codex-spark-high",
  "gpt-5.3-codex-spark-xhigh",
  // GPT-5.2 (general)
  "gpt-5.2",
  "gpt-5.2-none",
  "gpt-5.2-low",
  "gpt-5.2-medium",
  "gpt-5.2-high",
  "gpt-5.2-xhigh",
  // GPT-5.2 Codex
  "gpt-5.2-codex",
  "gpt-5.2-codex-low",
  "gpt-5.2-codex-medium",
  "gpt-5.2-codex-high",
  "gpt-5.2-codex-xhigh",
  // Codex Auto Review
  "codex-auto-review",
  "codex-auto-review-low",
  "codex-auto-review-medium",
  "codex-auto-review-high",
  "codex-auto-review-xhigh",
  // GPT-5.1 Codex Max
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-max-low",
  "gpt-5.1-codex-max-medium",
  "gpt-5.1-codex-max-high",
  "gpt-5.1-codex-max-xhigh",
  // GPT-5.1 Codex
  "gpt-5.1-codex",
  "gpt-5.1-codex-low",
  "gpt-5.1-codex-medium",
  "gpt-5.1-codex-high",
  // GPT-5.1 Codex Mini
  "gpt-5.1-codex-mini",
  "gpt-5.1-codex-mini-medium",
  "gpt-5.1-codex-mini-high",
  // GPT-5.1 (general)
  "gpt-5.1",
  "gpt-5.1-none",
  "gpt-5.1-low",
  "gpt-5.1-medium",
  "gpt-5.1-high",
  "gpt-5.1-chat-latest",
  // Legacy mappings
  "gpt-5-codex",
  "gpt-5-codex-mini",
  "gpt-5-codex-mini-medium",
  "gpt-5-codex-mini-high",
  "codex-mini-latest",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
] as const;

type CodexModelId = (typeof CODEX_MODEL_IDS)[number];

const MODEL_MAP: Record<string, string> = {
  // GPT-5.5
  "gpt-5.5": "gpt-5.5",
  "gpt-5.5-low": "gpt-5.5",
  "gpt-5.5-medium": "gpt-5.5",
  "gpt-5.5-high": "gpt-5.5",
  "gpt-5.5-xhigh": "gpt-5.5",
  // GPT-5.4
  "gpt-5.4": "gpt-5.4",
  "gpt-5.4-low": "gpt-5.4",
  "gpt-5.4-medium": "gpt-5.4",
  "gpt-5.4-high": "gpt-5.4",
  "gpt-5.4-xhigh": "gpt-5.4",
  // GPT-5.4 Mini
  "gpt-5.4-mini": "gpt-5.4-mini",
  "gpt-5.4-mini-low": "gpt-5.4-mini",
  "gpt-5.4-mini-medium": "gpt-5.4-mini",
  "gpt-5.4-mini-high": "gpt-5.4-mini",
  "gpt-5.4-mini-xhigh": "gpt-5.4-mini",
  // GPT-5.3 Codex
  "gpt-5.3-codex": "gpt-5.3-codex",
  "gpt-5.3-codex-low": "gpt-5.3-codex",
  "gpt-5.3-codex-medium": "gpt-5.3-codex",
  "gpt-5.3-codex-high": "gpt-5.3-codex",
  "gpt-5.3-codex-xhigh": "gpt-5.3-codex",
  // GPT-5.3 Codex Spark
  "gpt-5.3-codex-spark": "gpt-5.3-codex-spark",
  "gpt-5.3-codex-spark-low": "gpt-5.3-codex-spark",
  "gpt-5.3-codex-spark-medium": "gpt-5.3-codex-spark",
  "gpt-5.3-codex-spark-high": "gpt-5.3-codex-spark",
  "gpt-5.3-codex-spark-xhigh": "gpt-5.3-codex-spark",
  // GPT-5.2
  "gpt-5.2": "gpt-5.2",
  "gpt-5.2-none": "gpt-5.2",
  "gpt-5.2-low": "gpt-5.2",
  "gpt-5.2-medium": "gpt-5.2",
  "gpt-5.2-high": "gpt-5.2",
  "gpt-5.2-xhigh": "gpt-5.2",
  // GPT-5.2 Codex
  "gpt-5.2-codex": "gpt-5.2-codex",
  "gpt-5.2-codex-low": "gpt-5.2-codex",
  "gpt-5.2-codex-medium": "gpt-5.2-codex",
  "gpt-5.2-codex-high": "gpt-5.2-codex",
  "gpt-5.2-codex-xhigh": "gpt-5.2-codex",
  // Codex Auto Review
  "codex-auto-review": "codex-auto-review",
  "codex-auto-review-low": "codex-auto-review",
  "codex-auto-review-medium": "codex-auto-review",
  "codex-auto-review-high": "codex-auto-review",
  "codex-auto-review-xhigh": "codex-auto-review",
  // GPT-5.1 Codex Max
  "gpt-5.1-codex-max": "gpt-5.1-codex-max",
  "gpt-5.1-codex-max-low": "gpt-5.1-codex-max",
  "gpt-5.1-codex-max-medium": "gpt-5.1-codex-max",
  "gpt-5.1-codex-max-high": "gpt-5.1-codex-max",
  "gpt-5.1-codex-max-xhigh": "gpt-5.1-codex-max",
  // GPT-5.1 Codex
  "gpt-5.1-codex": "gpt-5.1-codex",
  "gpt-5.1-codex-low": "gpt-5.1-codex",
  "gpt-5.1-codex-medium": "gpt-5.1-codex",
  "gpt-5.1-codex-high": "gpt-5.1-codex",
  // GPT-5.1 Codex Mini
  "gpt-5.1-codex-mini": "gpt-5.1-codex-mini",
  "gpt-5.1-codex-mini-medium": "gpt-5.1-codex-mini",
  "gpt-5.1-codex-mini-high": "gpt-5.1-codex-mini",
  // GPT-5.1
  "gpt-5.1": "gpt-5.1",
  "gpt-5.1-none": "gpt-5.1",
  "gpt-5.1-low": "gpt-5.1",
  "gpt-5.1-medium": "gpt-5.1",
  "gpt-5.1-high": "gpt-5.1",
  "gpt-5.1-chat-latest": "gpt-5.1",
  // Legacy mappings
  "gpt-5-codex": "gpt-5.1-codex",
  "gpt-5-codex-mini": "gpt-5.1-codex-mini",
  "gpt-5-codex-mini-medium": "gpt-5.1-codex-mini",
  "gpt-5-codex-mini-high": "gpt-5.1-codex-mini",
  "codex-mini-latest": "gpt-5.1-codex-mini",
  "gpt-5": "gpt-5.1",
  "gpt-5-mini": "gpt-5.1",
  "gpt-5-nano": "gpt-5.1",
};

const BASE_MODEL_LABELS: Record<string, string> = {
  "gpt-5.5": "GPT-5.5",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 Mini",
  "gpt-5.3-codex": "GPT-5.3 Codex",
  "gpt-5.3-codex-spark": "GPT-5.3 Codex Spark",
  "gpt-5.2": "GPT-5.2",
  "codex-auto-review": "Codex Auto Review",
  "gpt-5.2-codex": "GPT-5.2 Codex",
  "gpt-5.1-codex-max": "GPT-5.1 Codex Max",
  "gpt-5.1-codex": "GPT-5.1 Codex",
  "gpt-5.1-codex-mini": "GPT-5.1 Codex Mini",
  "gpt-5.1": "GPT-5.1",
  "gpt-5-codex": "GPT-5 Codex (Legacy)",
  "gpt-5-codex-mini": "GPT-5 Codex Mini (Legacy)",
  "codex-mini-latest": "Codex Mini (Legacy)",
  "gpt-5": "GPT-5 (Legacy)",
  "gpt-5-mini": "GPT-5 Mini (Legacy)",
  "gpt-5-nano": "GPT-5 Nano (Legacy)",
};

function formatReasoningSuffix(suffix: string): string {
  switch (suffix) {
    case "none":
      return "None";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "XHigh";
    default:
      return suffix;
  }
}

export function normalizeCodexModel(model: string | undefined): string {
  if (!model) return "gpt-5.4";

  const modelId = model.includes("/") ? model.split("/").pop()! : model;
  const mapped = MODEL_MAP[modelId];
  if (mapped) {
    return mapped;
  }

  const normalized = modelId.toLowerCase();

  if (normalized.includes("gpt-5.5") || normalized.includes("gpt 5.5")) {
    return "gpt-5.5";
  }
  if (normalized.includes("gpt-5.4-mini") || normalized.includes("gpt 5.4 mini")) {
    return "gpt-5.4-mini";
  }
  if (normalized.includes("gpt-5.4") || normalized.includes("gpt 5.4")) {
    return "gpt-5.4";
  }
  if (normalized.includes("gpt-5.3-codex-spark") || normalized.includes("gpt 5.3 codex spark")) {
    return "gpt-5.3-codex-spark";
  }
  if (normalized.includes("gpt-5.3-codex") || normalized.includes("gpt 5.3 codex")) {
    return "gpt-5.3-codex";
  }
  if (normalized.includes("codex-auto-review") || normalized.includes("codex auto review")) {
    return "codex-auto-review";
  }
  if (normalized.includes("gpt-5.2-codex") || normalized.includes("gpt 5.2 codex")) {
    return "gpt-5.2-codex";
  }
  if (normalized.includes("gpt-5.2") || normalized.includes("gpt 5.2")) {
    return "gpt-5.2";
  }
  if (normalized.includes("gpt-5.1-codex-max") || normalized.includes("gpt 5.1 codex max")) {
    return "gpt-5.1-codex-max";
  }
  if (normalized.includes("gpt-5.1-codex-mini") || normalized.includes("gpt 5.1 codex mini")) {
    return "gpt-5.1-codex-mini";
  }
  if (normalized.includes("codex-mini-latest") || normalized.includes("gpt-5-codex-mini") || normalized.includes("gpt 5 codex mini")) {
    return "codex-mini-latest";
  }
  if (normalized.includes("gpt-5.1-codex") || normalized.includes("gpt 5.1 codex")) {
    return "gpt-5.1-codex";
  }
  if (normalized.includes("gpt-5.1") || normalized.includes("gpt 5.1")) {
    return "gpt-5.1";
  }
  if (normalized.includes("codex")) {
    return "gpt-5.1-codex";
  }
  if (normalized.includes("gpt-5") || normalized.includes("gpt 5")) {
    return "gpt-5.4";
  }

  return "gpt-5.4";
}

function getCodexModelDisplayName(modelId: string): string {
  const match = modelId.match(/-(none|low|medium|high|xhigh)$/);
  const suffix = match?.[1];
  const baseId = suffix ? modelId.slice(0, -match[0].length) : modelId;
  const baseLabel = BASE_MODEL_LABELS[baseId] || baseId;

  if (modelId === "gpt-5.1-chat-latest") {
    return "GPT-5.1 (Chat Latest)";
  }

  if (suffix) {
    return `${baseLabel} (${formatReasoningSuffix(suffix)})`;
  }

  return baseLabel;
}

export function getCodexModels(): Array<{ id: CodexModelId; name: string }> {
  return CODEX_MODEL_IDS.map((id) => ({
    id,
    name: getCodexModelDisplayName(id),
  }));
}
