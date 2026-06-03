import { normalizeCodexModel } from "@/lib/auth/codex-models";
import {
  filterCodexInput,
  normalizeOrphanedToolOutputs,
  truncateCodexInput,
  type CodexInputItem,
} from "@/lib/auth/codex-input-utils";

type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "minimal";
type ReasoningSummary = "auto" | "concise" | "detailed";

const REASONING_SUFFIXES = ["none", "low", "medium", "high", "xhigh", "minimal"] as const;

function extractEffortFromModelId(modelId?: string): ReasoningEffort | undefined {
  if (!modelId) return undefined;
  const lower = modelId.toLowerCase();
  for (const suffix of REASONING_SUFFIXES) {
    if (lower.endsWith(`-${suffix}`)) {
      return suffix;
    }
  }
  return undefined;
}

function getReasoningConfig(
  modelName: string | undefined,
  requestedEffort?: ReasoningEffort,
  requestedSummary?: ReasoningSummary,
): { effort: "none" | "low" | "medium" | "high" | "xhigh"; summary: ReasoningSummary } {
  const normalizedName = modelName?.toLowerCase() ?? "";

  const isGpt55 =
    normalizedName.includes("gpt-5.5") || normalizedName.includes("gpt 5.5");
  const isGpt54 =
    isGpt55 ||
    normalizedName.includes("gpt-5.4") ||
    normalizedName.includes("gpt 5.4");
  const isGpt52Codex =
    normalizedName.includes("gpt-5.2-codex") || normalizedName.includes("gpt 5.2 codex");
  const isGpt53Codex =
    normalizedName.includes("gpt-5.3-codex") || normalizedName.includes("gpt 5.3 codex");
  const isGpt52General =
    (normalizedName.includes("gpt-5.2") || normalizedName.includes("gpt 5.2")) && !isGpt52Codex;
  const isGpt53General =
    (normalizedName.includes("gpt-5.3") || normalizedName.includes("gpt 5.3")) && !isGpt53Codex;
  const isCodexMax =
    normalizedName.includes("codex-max") || normalizedName.includes("codex max");
  const isCodexMini =
    normalizedName.includes("codex-mini") ||
    normalizedName.includes("codex mini") ||
    normalizedName.includes("codex_mini") ||
    normalizedName.includes("codex-mini-latest");
  const isCodex = normalizedName.includes("codex") && !isCodexMini;
  const isLightweight =
    !isCodexMini && (normalizedName.includes("nano") || normalizedName.includes("mini"));
  const prefersMediumDefault = isGpt53Codex;

  const isGpt51General =
    (normalizedName.includes("gpt-5.1") || normalizedName.includes("gpt 5.1")) &&
    !isCodex &&
    !isCodexMax &&
    !isCodexMini;

  const supportsXhigh = isGpt54 || isGpt53General || isGpt53Codex || isGpt52General || isGpt52Codex || isCodexMax;
  const supportsNone = isGpt52General || isGpt51General;

  const defaultEffort: ReasoningEffort = isGpt54
      ? "medium"
    : isCodexMini
      ? "medium"
    : prefersMediumDefault
      ? "medium"
    : supportsXhigh
      ? "high"
      : isLightweight
        ? "minimal"
        : "medium";

  let effort = requestedEffort || defaultEffort;

  if (isCodexMini) {
    if (effort === "minimal" || effort === "low" || effort === "none") {
      effort = "medium";
    }
    if (effort === "xhigh") {
      effort = "high";
    }
    if (effort !== "high" && effort !== "medium") {
      effort = "medium";
    }
  }

  if (!supportsXhigh && effort === "xhigh") {
    effort = "high";
  }

  if (!supportsNone && effort === "none") {
    effort = "low";
  }

  if (effort === "minimal") {
    effort = "low";
  }

  return {
    effort,
    summary: requestedSummary || "auto",
  };
}

function resolveTextVerbosity(body: Record<string, any>): "low" | "medium" | "high" {
  const providerOpenAI = body.providerOptions?.openai;
  return (
    body.text?.verbosity ||
    providerOpenAI?.textVerbosity ||
    "medium"
  );
}

function resolveInclude(body: Record<string, any>): string[] {
  const providerOpenAI = body.providerOptions?.openai;
  const base = body.include || providerOpenAI?.include || ["reasoning.encrypted_content"];
  const include = Array.from(new Set(base.filter(Boolean))) as string[];
  if (!include.includes("reasoning.encrypted_content")) {
    include.push("reasoning.encrypted_content");
  }
  return include;
}

const UNEXPECTED_CHANGE_RE = /While you are working.*?STOP IMMEDIATELY.*?proceed\./s;
const PATCHED_RULE = 'File changed between reads? Check your recent tool calls first—only halt if unexplained.';

function patchCodexInstructions(raw: string): string {
  const patched = raw.replace(UNEXPECTED_CHANGE_RE, PATCHED_RULE);
  if (patched === raw && !raw.includes(PATCHED_RULE) && raw.length > 500) {
    return raw + '\n\n' + PATCHED_RULE + '\n';
  }
  return patched;
}

export async function transformCodexRequest(
  body: Record<string, any>,
  codexInstructions: string,
): Promise<Record<string, any>> {
  const originalModel = body.model as string | undefined;
  const normalizedModel = normalizeCodexModel(originalModel);

  const shouldStream = body.stream === true;

  body.model = normalizedModel;
  body.store = false;
  // Preserve the AI SDK call mode. `streamText` sends `stream: true` and expects
  // SSE; `generateText` does not and expects a JSON Responses API object. Forcing
  // every Codex request to stream makes non-streaming callers try to parse SSE as
  // JSON, which breaks utility paths such as prompt enhancement.
  body.stream = shouldStream;
  if (codexInstructions) {
    body.instructions = patchCodexInstructions(codexInstructions);
  }

  if (Array.isArray(body.input)) {
    const filtered = filterCodexInput(body.input as CodexInputItem[]) || [];
    const normalized = normalizeOrphanedToolOutputs(filtered);
    body.input = process.env.CODEX_TRUNCATE_PAYLOAD === "true"
      ? truncateCodexInput(normalized)
      : normalized;
    const inputSummary = body.input.map((item: CodexInputItem) => {
      const content = item.content;
      return {
        type: item.type,
        role: item.role,
        name: item.name,
        hasContentArray: Array.isArray(content),
        contentSummary: Array.isArray(content)
          ? content.map((part) => {
              if (typeof part === "string") {
                return { type: "string", preview: part.slice(0, 80) };
              }
              if (!part || typeof part !== "object") {
                return { type: typeof part };
              }
              const typedPart = part as Record<string, unknown>;
              return {
                type: typedPart.type,
                imageUrlPreview:
                  typeof typedPart.image_url === "string"
                    ? typedPart.image_url.slice(0, 120)
                    : undefined,
                imagePreview:
                  typeof typedPart.image === "string"
                    ? typedPart.image.slice(0, 120)
                    : undefined,
                fileUrlPreview:
                  typeof typedPart.url === "string"
                    ? typedPart.url.slice(0, 120)
                    : undefined,
                textPreview:
                  typeof typedPart.text === "string"
                    ? typedPart.text.slice(0, 120)
                    : undefined,
              };
            })
          : typeof content === "string"
            ? content.slice(0, 160)
            : null,
      };
    });
    console.log(`[CODEX] Input summary after transform: ${JSON.stringify(inputSummary)}`);
  }

  const requestedEffort =
    body.reasoning?.effort ||
    body.providerOptions?.openai?.reasoningEffort ||
    extractEffortFromModelId(originalModel);
  const requestedSummary =
    body.reasoning?.summary ||
    body.providerOptions?.openai?.reasoningSummary;

  const reasoningConfig = getReasoningConfig(originalModel || normalizedModel, requestedEffort, requestedSummary);

  body.reasoning = {
    ...body.reasoning,
    ...reasoningConfig,
  };

  // GPT-5.4 and GPT-5.5 don't expose support_verbosity via bundled metadata yet;
  // only send text.verbosity for models we know support it.
  const modelSupportsVerbosity =
    !normalizedModel.startsWith("gpt-5.4") &&
    !normalizedModel.startsWith("gpt-5.5");
  if (modelSupportsVerbosity) {
    body.text = {
      ...body.text,
      verbosity: resolveTextVerbosity(body),
    };
  } else {
    delete body.text;
  }

  body.include = resolveInclude(body);

  delete body.temperature;
  delete body.max_output_tokens;
  delete body.max_completion_tokens;

  console.log(
    `[CODEX] Final request: model=${body.model}, reasoning=${JSON.stringify(body.reasoning)}, ` +
    `text=${JSON.stringify(body.text)}, include=${JSON.stringify(body.include)}, ` +
    `hasInstructions=${!!body.instructions}, stream=${body.stream}`
  );

  return body;
}
