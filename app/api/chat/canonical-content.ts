import type { DBContentPart, DBToolCallPart, DBToolResultPart } from "@/lib/messages/converter";
import { normalizeToolResultOutput } from "@/lib/ai/tool-result-utils";
import { ToolRegistry } from "@/lib/ai/tool-registry/registry";
import { normalizeToolCallInput } from "./tool-call-utils";
import { cloneContentParts } from "./streaming-state";
import { sanitizeAssistantOutputText } from "./content-sanitizer";

interface StepToolCallLike {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

interface StepToolResultLike {
  toolCallId: string;
  output: unknown;
  toolName?: string;
}

export interface StepLike {
  toolCalls?: StepToolCallLike[];
  toolResults?: StepToolResultLike[];
  text?: string;
}

function hasToolCallLikeParts(parts: DBContentPart[]): boolean {
  return parts.some((part) => part.type === "tool-call" || part.type === "tool-result");
}

function sanitizeAssistantTextParts(
  parts: DBContentPart[],
  hasToolContext: boolean
): DBContentPart[] {
  if (!hasToolContext) {
    return parts;
  }

  const sanitized: DBContentPart[] = [];
  for (const part of parts) {
    if (part.type !== "text") {
      sanitized.push(part);
      continue;
    }

    const cleanedText = sanitizeAssistantOutputText(part.text, {
      hasToolCallLikeParts: hasToolContext,
    });
    if (!cleanedText.trim()) {
      continue;
    }

    sanitized.push({ ...part, text: cleanedText });
  }

  return sanitized;
}

export function buildCanonicalAssistantContentFromSteps(
  steps: StepLike[] | undefined,
  fallbackText?: string
): DBContentPart[] {
  const content: DBContentPart[] = [];
  const toolCallMetadata = new Map<string, { toolName: string; input?: unknown }>();
  const seenToolCalls = new Set<string>();
  const seenToolResults = new Set<string>();
  const seenTexts = new Set<string>();
  const hasAnyToolContext = Boolean(
    steps?.some((step) => (step.toolCalls?.length ?? 0) > 0 || (step.toolResults?.length ?? 0) > 0)
  );

  if (steps && steps.length > 0) {
    for (const step of steps) {
      if (step.toolCalls) {
        for (const call of step.toolCalls) {
          const normalizedInput = normalizeToolCallInput(
            call.input,
            call.toolName,
            call.toolCallId
          );
          if (!normalizedInput) continue;
          if (seenToolCalls.has(call.toolCallId)) continue;
          seenToolCalls.add(call.toolCallId);
          content.push({
            type: "tool-call",
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            args: normalizedInput,
          });
          toolCallMetadata.set(call.toolCallId, {
            toolName: call.toolName,
            input: normalizedInput,
          });
        }
      }

      if (step.toolResults) {
        for (const res of step.toolResults) {
          if (seenToolResults.has(res.toolCallId)) continue;
          seenToolResults.add(res.toolCallId);

          const meta = toolCallMetadata.get(res.toolCallId);
          const toolName = res.toolName || meta?.toolName || "tool";
          const normalized = normalizeToolResultOutput(toolName, res.output, meta?.input, {
            mode: "canonical",
          });
          const status = normalized.status.toLowerCase();
          const state =
            status === "error" || status === "failed"
              ? "output-error"
              : "output-available";

          content.push({
            type: "tool-result",
            toolCallId: res.toolCallId,
            toolName,
            result: normalized.output,
            status: normalized.status,
            timestamp: new Date().toISOString(),
            state,
          });
        }
      }

      if (step.text?.trim()) {
        const cleanedStepText = sanitizeAssistantOutputText(step.text, {
          hasToolCallLikeParts:
            (step.toolCalls?.length ?? 0) > 0 || (step.toolResults?.length ?? 0) > 0,
        });
        const trimmed = cleanedStepText.trim();
        if (trimmed && !seenTexts.has(trimmed)) {
          seenTexts.add(trimmed);
          content.push({ type: "text", text: cleanedStepText });
        }
      }
    }
  }

  if (content.length === 0 && fallbackText?.trim()) {
    const cleanedFallbackText = sanitizeAssistantOutputText(fallbackText, {
      hasToolCallLikeParts: hasAnyToolContext,
    });
    if (cleanedFallbackText.trim()) {
      content.push({ type: "text", text: cleanedFallbackText });
    }
  }

  return content;
}

export function isReconstructedMissingResult(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (obj.reconstructed === true) return true;
  const error = typeof obj.error === "string" ? obj.error : "";
  return error.includes("did not return a persisted result");
}

export function reconcileDbToolCallResultPairs(parts: DBContentPart[]): DBContentPart[] {
  const normalized: DBContentPart[] = [];
  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const part of parts) {
    if (part.type === "tool-result") {
      if (!toolCallIds.has(part.toolCallId)) {
        normalized.push({
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName || "tool",
          args: {
            __reconstructed: true,
            reason: "missing_tool_call_in_history",
          },
          state: "input-available",
        });
        toolCallIds.add(part.toolCallId);
      }
      toolResultIds.add(part.toolCallId);
      normalized.push(part);
      continue;
    }

    if (part.type === "tool-call") {
      toolCallIds.add(part.toolCallId);
    }

    normalized.push(part);
  }

  for (const toolCallId of toolCallIds) {
    if (toolResultIds.has(toolCallId)) continue;
    const callPart = normalized.find(
      (part): part is DBToolCallPart => part.type === "tool-call" && part.toolCallId === toolCallId
    );
    normalized.push({
      type: "tool-result",
      toolCallId,
      toolName: callPart?.toolName || "tool",
      result: {
        status: "error",
        error: "Tool execution did not return a persisted result in conversation history.",
        reconstructed: true,
      },
      status: "error",
      state: "output-error",
      timestamp: new Date().toISOString(),
    });
  }

  return normalized;
}

/**
 * Merge adjacent text parts into a single part separated by `\n\n`.
 *
 * When multi-step runs produce text across consecutive steps (with tool parts
 * in between during streaming but not in the canonical step-built content),
 * the final content can end up with adjacent text parts.  Rendering adjacent
 * text parts without a visual separator creates the "concatenated without
 * space" symptom (e.g. "0 errors.All done.").  Consolidating them here
 * guarantees proper paragraph separation regardless of how the parts arrive.
 */
export function consolidateAdjacentTextParts(parts: DBContentPart[]): DBContentPart[] {
  if (parts.length <= 1) return parts;

  const result: DBContentPart[] = [];
  for (const part of parts) {
    const prev = result[result.length - 1];
    if (part.type === "text" && prev?.type === "text") {
      // Merge into previous text part with paragraph break
      const prevText = prev.text.trimEnd();
      const curText = part.text.trimStart();
      if (prevText && curText) {
        prev.text = `${prevText}\n\n${curText}`;
      } else {
        prev.text = prevText || curText;
      }
    } else {
      result.push(part);
    }
  }
  return result;
}

export function mergeCanonicalAssistantContent(
  streamedParts: DBContentPart[] | undefined,
  stepParts: DBContentPart[]
): DBContentPart[] {
  const rawBase = Array.isArray(streamedParts)
    ? cloneContentParts(streamedParts)
    : [];
  const hasToolContext = hasToolCallLikeParts(rawBase) || hasToolCallLikeParts(stepParts);
  const base = sanitizeAssistantTextParts(rawBase, hasToolContext);
  const sanitizedStepParts = sanitizeAssistantTextParts(stepParts, hasToolContext);

  if (base.length === 0) {
    return consolidateAdjacentTextParts(reconcileDbToolCallResultPairs(sanitizedStepParts));
  }
  if (sanitizedStepParts.length === 0) {
    return consolidateAdjacentTextParts(reconcileDbToolCallResultPairs(base));
  }

  const callIndexById = new Map<string, number>();
  const resultIndexById = new Map<string, number>();

  for (let i = 0; i < base.length; i += 1) {
    const part = base[i];
    if (part.type === "tool-call") {
      callIndexById.set(part.toolCallId, i);
    } else if (part.type === "tool-result") {
      resultIndexById.set(part.toolCallId, i);
    }
  }

  for (const incoming of sanitizedStepParts) {
    if (incoming.type === "tool-call") {
      const existingIdx = callIndexById.get(incoming.toolCallId);
      if (existingIdx === undefined) {
        callIndexById.set(incoming.toolCallId, base.length);
        base.push(incoming);
      } else {
        const existing = base[existingIdx] as DBToolCallPart;
        if (!existing.args && incoming.args) {
          existing.args = incoming.args;
        }
        if (!existing.toolName && incoming.toolName) {
          existing.toolName = incoming.toolName;
        }
        if (!existing.state && incoming.state) {
          existing.state = incoming.state;
        }
      }
      continue;
    }

    if (incoming.type === "tool-result") {
      const existingIdx = resultIndexById.get(incoming.toolCallId);
      if (existingIdx === undefined) {
        resultIndexById.set(incoming.toolCallId, base.length);
        base.push(incoming);
      } else {
        const existing = base[existingIdx] as DBToolResultPart;
        if (isReconstructedMissingResult(existing.result)) {
          base[existingIdx] = incoming;
        } else if (!existing.result && incoming.result) {
          base[existingIdx] = incoming;
        } else if (existing.preliminary && !incoming.preliminary) {
          base[existingIdx] = incoming;
        }
      }
      continue;
    }

    if (incoming.type === "text") {
      const incomingTrimmed = incoming.text.trim();
      if (!incomingTrimmed) continue;

      // Scan existing text parts for overlap with the incoming text.
      // Track how many existing parts the incoming text subsumes.
      let exactMatch = false;
      let existingSupersetOfIncoming = false;
      const subsumedIndices: number[] = [];

      for (let i = 0; i < base.length; i += 1) {
        const part = base[i];
        if (part.type !== "text") continue;
        // Sanitize existing text the same way step text is sanitized so the
        // comparison isn't thrown off by fake tool-call JSON that only exists
        // in the streaming copy (Fix #2: stripFakeToolCallJson divergence).
        const existingTrimmed = sanitizeAssistantOutputText(part.text, {
          hasToolCallLikeParts: hasToolContext,
        }).trim();

        // Skip empty text parts — `"hello".includes("")` is always true in JS,
        // which would cause every non-empty incoming text to count empty parts
        // as "subsumed" and trigger the blob-drop heuristic (Fix #1).
        if (!existingTrimmed) continue;

        if (existingTrimmed === incomingTrimmed) {
          exactMatch = true;
          break;
        }
        if (existingTrimmed.includes(incomingTrimmed)) {
          existingSupersetOfIncoming = true;
          break;
        }
        if (incomingTrimmed.includes(existingTrimmed)) {
          subsumedIndices.push(i);
        }
      }

      if (exactMatch || existingSupersetOfIncoming) {
        // Already covered by existing content — skip incoming.
        continue;
      }

      if (subsumedIndices.length >= 2) {
        // Incoming subsumes multiple existing text parts — this is a
        // concatenated step-text blob produced by the AI SDK (it joins
        // all intra-step text blocks into one string). The streaming
        // state already has the correct, granular representation with
        // individual text parts properly interleaved with tool calls.
        // Dropping the blob prevents double-rendered responses.
        continue;
      }

      if (subsumedIndices.length === 1) {
        // Incoming extends a single existing text part (e.g. streaming
        // captured a truncated prefix, step text has the full version).
        // Replace the existing with the more complete incoming.
        base[subsumedIndices[0]] = incoming;
        continue;
      }

      // No overlap — genuinely new content.
      base.push(incoming);
      continue;
    }

    base.push(incoming);
  }

  return consolidateAdjacentTextParts(reconcileDbToolCallResultPairs(base));
}

/**
 * Sentinel key used inside a stubbed tool-result's `result` payload so replay
 * code (and debugging) can tell the difference between a real result and an
 * ephemeral-history stub.
 */
export const EPHEMERAL_STUB_MARKER = "ephemeralStub";

interface MediaRef {
  url: string;
  mimeType?: string;
}

type EphemeralLookup = (toolName: string) => boolean;

function defaultEphemeralLookup(toolName: string): boolean {
  if (!toolName) return false;
  try {
    const registered = ToolRegistry.getInstance().get(toolName);
    return registered?.metadata.ephemeralResults === true;
  } catch {
    // Registry may not be initialised in test contexts — treat as non-ephemeral.
    return false;
  }
}

function pushMediaRef(collected: MediaRef[], seen: Map<string, MediaRef>, ref: MediaRef) {
  if (!ref.url || typeof ref.url !== "string") return;
  const existing = seen.get(ref.url);
  if (!existing) {
    seen.set(ref.url, ref);
    collected.push(ref);
    return;
  }
  // Upgrade the existing entry in-place if we've now learned a richer mimeType
  // (e.g. `images[]` is seen first without a mimeType, but `content[]` carries one).
  if (!existing.mimeType && ref.mimeType) {
    existing.mimeType = ref.mimeType;
  }
}

function collectMediaRefs(
  value: unknown,
  collected: MediaRef[],
  seenUrls: Map<string, MediaRef>,
  seenObjects: WeakSet<object>,
  depth = 0,
): void {
  if (depth > 8) return;
  if (value === null || value === undefined) return;

  if (typeof value === "string") {
    // Only capture recognised hosted / media references — never raw URL strings
    // stashed in random fields, to avoid false positives.
    if (value.startsWith("/api/media/")) {
      pushMediaRef(collected, seenUrls, { url: value });
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectMediaRefs(item, collected, seenUrls, seenObjects, depth + 1);
    }
    return;
  }

  if (typeof value === "object") {
    if (seenObjects.has(value)) return;
    seenObjects.add(value);
    const obj = value as Record<string, unknown>;

    // Recognise explicit media shapes produced by formatMCPToolResult /
    // Selene's media tools: { url, mimeType }, { type: "image", url, mimeType }, etc.
    const url = typeof obj.url === "string" ? obj.url : undefined;
    if (url && (url.startsWith("/api/media/") || url.startsWith("http"))) {
      const mimeType =
        typeof obj.mimeType === "string"
          ? obj.mimeType
          : typeof obj.mediaType === "string"
            ? obj.mediaType
            : typeof obj.contentType === "string"
              ? obj.contentType
              : undefined;
      pushMediaRef(collected, seenUrls, { url, mimeType });
    }

    for (const val of Object.values(obj)) {
      collectMediaRefs(val, collected, seenUrls, seenObjects, depth + 1);
    }
  }
}

function getString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Build the compact stub stored in persistent history for an ephemeral
 * tool-result. The model has already seen the full result in the current
 * streaming turn — on replay it only needs to know the tool ran, the final
 * status, and any media refs (so later tool calls can pass the URL along).
 *
 * NOTE on i18n: `summary` is intentionally English. It is fed back to the
 * LLM as replay context only — it is never rendered in the UI (the chat
 * card extracts media from `mediaRefs` directly; see
 * `components/assistant-ui/tool-call-group.tsx#extractMediaFromResult` and
 * `lib/channels/delivery.ts#extractImageUrlsFromToolResult`). Locale
 * resolution would have to happen at the persistence boundary which is
 * request-scope agnostic; keeping English here matches every other
 * server-side log/diagnostic string in this file.
 */
function makeEphemeralStubResult(
  toolName: string,
  original: unknown,
): Record<string, unknown> {
  const mediaRefs: MediaRef[] = [];
  collectMediaRefs(
    original,
    mediaRefs,
    new Map<string, MediaRef>(),
    new WeakSet<object>(),
  );

  let status: string = "success";
  let originalSummary: string | undefined;
  let errorMessage: string | undefined;

  if (original && typeof original === "object" && !Array.isArray(original)) {
    const obj = original as Record<string, unknown>;
    const rawStatus = getString(obj.status);
    if (rawStatus) status = rawStatus.toLowerCase();
    originalSummary = getString(obj.summary);
    errorMessage = getString(obj.error);
  }

  const summary =
    originalSummary ??
    (errorMessage
      ? `${toolName} failed (ephemeral — full result omitted from replay history)`
      : mediaRefs.length > 0
        ? `${toolName} returned ${mediaRefs.length} media ref(s) (ephemeral — full result omitted from replay history)`
        : `${toolName} completed (ephemeral — full result omitted from replay history)`);

  const stub: Record<string, unknown> = {
    status,
    summary,
    [EPHEMERAL_STUB_MARKER]: true,
    toolName,
  };
  if (mediaRefs.length > 0) stub.mediaRefs = mediaRefs;
  if (errorMessage) stub.error = errorMessage;
  return stub;
}

/**
 * Rewrite tool-result parts for tools flagged `ephemeralResults: true`
 * into compact stubs before persistence. The stub preserves status + any
 * hosted media URLs so replay context stays lean while subsequent tool
 * calls can still reference the produced media.
 *
 * Called at the canonical-write boundary (stream-callbacks.ts) — AFTER the
 * current turn has streamed (so the model saw the full result once) and
 * BEFORE the row hits the messages table.
 */
export function stubEphemeralToolResults(
  parts: DBContentPart[],
  ephemeralLookup: EphemeralLookup = defaultEphemeralLookup,
): DBContentPart[] {
  let anyStubbed = false;
  const rewritten: DBContentPart[] = [];
  for (const part of parts) {
    if (part.type !== "tool-result") {
      rewritten.push(part);
      continue;
    }

    const toolName = part.toolName || "tool";
    if (!ephemeralLookup(toolName)) {
      rewritten.push(part);
      continue;
    }

    // Avoid double-stubbing if this part was already stubbed (e.g. replayed
    // through a secondary persist path).
    const existingResult = part.result as Record<string, unknown> | undefined;
    if (
      existingResult &&
      typeof existingResult === "object" &&
      !Array.isArray(existingResult) &&
      existingResult[EPHEMERAL_STUB_MARKER] === true
    ) {
      rewritten.push(part);
      continue;
    }

    anyStubbed = true;
    const stub = makeEphemeralStubResult(toolName, part.result ?? part.output);
    rewritten.push({
      ...part,
      result: stub,
      // Drop legacy `output` field so stubs aren't half-rewritten on rows that
      // used the older shape.
      output: undefined,
      status: typeof stub.status === "string" ? stub.status : part.status,
    });
  }

  if (anyStubbed) {
    console.debug(
      `[CHAT API] Ephemeral stub applied to tool-result(s) before persistence (ephemeralResults metadata honored).`,
    );
  }

  return rewritten;
}

export function countCanonicalTruncationMarkers(parts: DBContentPart[]): number {
  let count = 0;
  for (const part of parts) {
    if (part.type !== "tool-result") continue;
    const result = part.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) continue;
    const obj = result as Record<string, unknown>;
    if (obj.truncated === true) {
      count += 1;
      continue;
    }
    if (typeof obj.truncatedContentId === "string" && obj.truncatedContentId.startsWith("trunc_")) {
      count += 1;
      continue;
    }
  }
  return count;
}

export function isAbortLikeTerminationError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  return (
    lower.includes("abort") ||
    lower.includes("terminated") ||
    lower.includes("interrupted") ||
    lower.includes("controller was closed") ||
    lower.includes("connection reset") ||
    lower.includes("socket hang up")
  );
}

export function shouldTreatStreamErrorAsCancellation(args: {
  errorMessage: string;
  isCreditError: boolean;
  streamAborted: boolean;
  classificationRecoverable: boolean;
  classificationReason?: string;
}): boolean {
  const {
    errorMessage,
    isCreditError,
    streamAborted,
    classificationRecoverable,
    classificationReason,
  } = args;

  if (isCreditError) return false;
  if (streamAborted) return true;
  if (classificationReason === "user_abort") return true;

  return classificationRecoverable && isAbortLikeTerminationError(errorMessage);
}
