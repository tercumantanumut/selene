import type { DBContentPart, DBToolCallPart, DBToolResultPart } from "@/lib/messages/converter";
import { normalizeToolResultOutput } from "@/lib/ai/tool-result-utils";
import { ToolRegistry } from "@/lib/ai/tool-registry/registry";
import { buildOutputStub, deriveOutline } from "@/lib/ai/output-stub";
import { storeFullContent } from "@/lib/ai/truncated-content-store";
import { toStructuredToolName } from "@/lib/messages/tool-name-placeholder";
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

interface StepReasoningPartLike {
  type?: string;
  text?: string;
}

export interface StepLike {
  toolCalls?: StepToolCallLike[];
  toolResults?: StepToolResultLike[];
  text?: string;
  /**
   * Structured reasoning parts emitted by thinking-mode providers. The
   * ai-sdk `StepResult` exposes `reasoning: ReasoningPart[]`; we only need
   * the concatenated text for persistence.
   */
  reasoning?: StepReasoningPartLike[];
  /** Convenience field from ai-sdk matching `StepResult.reasoningText`. */
  reasoningText?: string;
}

function hasToolCallLikeParts(parts: DBContentPart[]): boolean {
  return parts.some((part) => part.type === "tool-call" || part.type === "tool-result");
}

function sanitizeAssistantTextParts(
  parts: DBContentPart[],
  hasToolContext: boolean
): DBContentPart[] {
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

function extractStepReasoningText(step: StepLike): string {
  if (typeof step.reasoningText === "string" && step.reasoningText.trim().length > 0) {
    return step.reasoningText;
  }
  if (Array.isArray(step.reasoning) && step.reasoning.length > 0) {
    return step.reasoning
      .filter(
        (part): part is StepReasoningPartLike & { text: string } =>
          typeof part?.text === "string" && part.text.length > 0
      )
      .map((part) => part.text)
      .join("");
  }
  return "";
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
  const seenReasoning = new Set<string>();
  const hasAnyToolContext = Boolean(
    steps?.some((step) => (step.toolCalls?.length ?? 0) > 0 || (step.toolResults?.length ?? 0) > 0)
  );

  if (steps && steps.length > 0) {
    for (const step of steps) {
      // Reasoning is emitted first so the canonical shape places thinking
      // before the tool_calls / text that follow from that reasoning block.
      // The openai-compatible adapter concatenates all `reasoning` parts on
      // the assistant message into a single `reasoning_content` field —
      // ordering within the message is effectively cosmetic, but keeping
      // thinking → action reads naturally when debugging persisted history.
      const reasoningText = extractStepReasoningText(step);
      if (reasoningText && !seenReasoning.has(reasoningText)) {
        seenReasoning.add(reasoningText);
        content.push({ type: "reasoning", text: reasoningText });
      }

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
          const toolName = toStructuredToolName(res.toolName || meta?.toolName);
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
          toolName: toStructuredToolName(part.toolName),
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
      toolName: toStructuredToolName(callPart?.toolName),
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
  const baseReasoningTexts = new Set<string>();

  for (let i = 0; i < base.length; i += 1) {
    const part = base[i];
    if (part.type === "tool-call") {
      callIndexById.set(part.toolCallId, i);
    } else if (part.type === "tool-result") {
      resultIndexById.set(part.toolCallId, i);
    } else if (part.type === "reasoning" && typeof part.text === "string" && part.text.length > 0) {
      baseReasoningTexts.add(part.text);
    }
  }

  for (const incoming of sanitizedStepParts) {
    if (incoming.type === "reasoning") {
      const text = typeof incoming.text === "string" ? incoming.text : "";
      if (!text.length || baseReasoningTexts.has(text)) {
        continue;
      }
      baseReasoningTexts.add(text);
      base.push(incoming);
      continue;
    }

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
 * Extract the primary text payload of a tool result for stubbing.
 * Mirrors the field-priority used by `limitToolOutput` so stubs see the
 * same text the projection sees. Falls back to a stringified object.
 */
function extractPrimaryText(original: unknown): string {
  if (typeof original === "string") return original;
  if (!original || typeof original !== "object" || Array.isArray(original)) {
    try {
      return JSON.stringify(original);
    } catch {
      return String(original);
    }
  }
  const obj = original as Record<string, unknown>;
  const candidates = [
    "content",
    "text",
    "result",
    "results",
    "output",
    "markdown",
    "stdout",
    "data",
    "body",
  ];
  for (const key of candidates) {
    const val = obj[key];
    if (typeof val === "string" && val.length > 0) return val;
    if (val && typeof val === "object") {
      try {
        return JSON.stringify(val);
      } catch {
        /* fall through */
      }
    }
  }
  try {
    return JSON.stringify(obj);
  } catch {
    return "";
  }
}

// A primary text this small isn't worth storing for retrieval — the outline
// + compact summary already fits everything the model could ask for.
const EPHEMERAL_STORE_MIN_CHARS = 400;

/**
 * Build the compact stub stored in persistent history for an ephemeral
 * tool-result. Produces a retrieval-friendly shape:
 *   - `summary`: rich outline string (buildOutputStub) that includes the
 *     contentId + ready-to-paste retrieveFullContent examples.
 *   - `truncatedContentId`: the trunc_XXX ID a future turn can retrieve
 *     within the TruncatedContentStore TTL window (1h, session-scoped,
 *     in-memory — survives within a live server but NOT across restarts).
 *   - `truncated: true` so existing truncation-aware code paths recognise it.
 *   - `mediaRefs`: hosted media URLs preserved so follow-up tool calls can
 *     still reference them even after the content expires.
 *
 * Storing a fresh contentId here (rather than carrying one forward from
 * projection) is intentional: the projection's contentId is scoped to the
 * model's live turn and may be gone by the time canonical history is read.
 * Always minting one at canonical-write time guarantees any surviving
 * stub in-session has a valid handle.
 *
 * NOTE on i18n: `summary` is intentionally English (see original comment
 * — server-side log/diagnostic convention; never rendered in the UI).
 */
function makeEphemeralStubResult(
  toolName: string,
  original: unknown,
  sessionId?: string,
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

  // Try to store the full primary text so the model can retrieve it
  // on replay. Fails gracefully if sessionId is missing or the payload
  // is too small to be worth storing.
  let contentId: string | undefined;
  let richSummary: string | undefined;
  if (!errorMessage) {
    const primaryText = extractPrimaryText(original);
    if (primaryText.length >= EPHEMERAL_STORE_MIN_CHARS) {
      if (sessionId) {
        try {
          // storeFullContent returns null when the backing store is
          // unavailable; treat null the same as an exception.
          const stored = storeFullContent(
            sessionId,
            `${toolName} (ephemeral)`,
            primaryText,
            primaryText.length,
          );
          if (stored) contentId = stored;
        } catch (err) {
          console.warn(
            `[CanonicalContent] Failed to store ephemeral content for ${toolName}: ${String(err)}`,
          );
        }
      }
      try {
        richSummary = buildOutputStub({
          toolName,
          originalText: primaryText,
          outline: deriveOutline(primaryText),
          retrievalId: contentId,
          idType: "contentId",
          previewTokens: 0,
        });
      } catch (err) {
        console.warn(
          `[CanonicalContent] Failed to build rich stub for ${toolName}: ${String(err)}`,
        );
      }
    }
  }

  const fallbackSummary =
    errorMessage
      ? `${toolName} failed (ephemeral — full result omitted from replay history)`
      : mediaRefs.length > 0
        ? `${toolName} returned ${mediaRefs.length} media ref(s) (ephemeral — full result omitted from replay history)`
        : `${toolName} completed (ephemeral — full result omitted from replay history)`;

  const summary = richSummary ?? originalSummary ?? fallbackSummary;

  const stub: Record<string, unknown> = {
    status,
    summary,
    [EPHEMERAL_STUB_MARKER]: true,
    toolName,
  };
  if (contentId) {
    stub.truncated = true;
    stub.truncatedContentId = contentId;
    stub.contentId = contentId;
  }
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
export interface StubEphemeralToolResultsOptions {
  /**
   * Current session ID. When provided, the ephemeral stub will persist the
   * full primary text via the TruncatedContentStore so the model can retrieve
   * it later via `retrieveFullContent({ contentId: "trunc_..." })`. Without
   * sessionId the stub still rewrites (reducing replay cost) but no contentId
   * is attached — callers from scripts/tests may safely omit it.
   */
  sessionId?: string;
  ephemeralLookup?: EphemeralLookup;
}

export function stubEphemeralToolResults(
  parts: DBContentPart[],
  optionsOrLookup?: StubEphemeralToolResultsOptions | EphemeralLookup,
): DBContentPart[] {
  // Support both the legacy (parts, lookup) signature used by scripts and
  // tests, and the new (parts, { sessionId, ephemeralLookup }) shape.
  let ephemeralLookup: EphemeralLookup = defaultEphemeralLookup;
  let sessionId: string | undefined;
  if (typeof optionsOrLookup === "function") {
    ephemeralLookup = optionsOrLookup;
  } else if (optionsOrLookup && typeof optionsOrLookup === "object") {
    if (optionsOrLookup.ephemeralLookup) ephemeralLookup = optionsOrLookup.ephemeralLookup;
    sessionId = optionsOrLookup.sessionId;
  }

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
    const stub = makeEphemeralStubResult(toolName, part.result ?? part.output, sessionId);
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
    // Ephemeral stubs legitimately carry truncated + truncatedContentId at the
    // canonical layer (they replace a large ephemeral result with a retrieval
    // handle). Skip them — they are NOT projection leakage.
    if (obj[EPHEMERAL_STUB_MARKER] === true) continue;
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
