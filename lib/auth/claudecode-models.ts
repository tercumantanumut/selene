export const CLAUDECODE_MODEL_IDS = [
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5-20251001",
  "claude-fable-5",
  "claude-opus-4-8",
] as const;

type ClaudeCodeModelId = (typeof CLAUDECODE_MODEL_IDS)[number];

const MODEL_LABELS: Record<string, string> = {
  "claude-opus-4-7": "Claude Opus 4.7",
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-sonnet-4-5-20250929": "Claude Sonnet 4.5",
  "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
  "claude-fable-5": "Claude Fable 5",
  "claude-opus-4-8": "Claude Opus 4.8",
};

function getClaudeCodeModelDisplayName(modelId: string): string {
  return MODEL_LABELS[modelId] || modelId;
}

export function getClaudeCodeModels(): Array<{ id: ClaudeCodeModelId; name: string }> {
  return CLAUDECODE_MODEL_IDS.map((id) => ({
    id,
    name: getClaudeCodeModelDisplayName(id),
  }));
}
