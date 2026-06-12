/**
 * Strict runtime validators for `selene-tool-*` postMessages received from
 * the design preview iframe.
 *
 * The iframe is sandboxed but still executes user-authored design code, so
 * any payload arriving from `iframeRef.current.contentWindow` is treated as
 * untrusted: numbers must be finite, hex strings must match a strict pattern,
 * RGB/HSL channels must be in range, and length-bounded strings are clamped.
 *
 * On a validation miss we `console.warn` with the rejected `type` and a brief
 * reason and return `null`. The caller (the parent's `handleMessage`) then
 * skips the store mutation entirely — there is no user-facing error path,
 * the bad event is simply dropped.
 *
 * This module has no React or DOM dependencies so it can be unit-tested in a
 * pure node environment.
 */
import type {
  ColorPickPayload,
  CommentPayload,
  CommentsResolvedPayload,
  IframeRect,
  InspectedElement,
  InspectorSelectPayload,
  MeasurementPayload,
  MeasurementsResolvedPayload,
  PickedColor,
} from "./types";

/** Top-level union of every validated payload we accept. */
export type IframeMessage =
  | InspectorSelectPayload
  | MeasurementPayload
  | ColorPickPayload
  | CommentPayload
  | CommentsResolvedPayload
  | MeasurementsResolvedPayload;

const MAX_TEXT_LENGTH = 2000;
const MAX_SELECTOR_LENGTH = 1000;
/** Allowed clock skew when validating `createdAt` timestamps from the iframe. */
const CREATED_AT_PAST_WINDOW_MS = 24 * 60 * 60 * 1000; // 1 day
const CREATED_AT_FUTURE_WINDOW_MS = 60 * 1000; // 1 minute
const HEX_RE = /^#[0-9a-f]{6}$/i;
const COLOR_PICK_SOURCES: ReadonlyArray<PickedColor["source"]> = [
  "background",
  "foreground",
  "border",
  "gradient",
  "svg-fill",
  "svg-stroke",
  "pseudo-before",
  "pseudo-after",
];

function warnReject(type: string, reason: string): null {
  console.warn(`[design-preview] rejected ${type}: ${reason}`);
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isInRange(value: unknown, min: number, max: number): value is number {
  return isFiniteNumber(value) && value >= min && value <= max;
}

function validateRect(value: unknown): value is IframeRect {
  if (!isObject(value)) return false;
  if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y)) return false;
  if (!isFiniteNumber(value.width) || value.width < 0) return false;
  if (!isFiniteNumber(value.height) || value.height < 0) return false;
  return true;
}

function validateRgb(
  value: unknown,
): value is { r: number; g: number; b: number; a: number } {
  if (!isObject(value)) return false;
  return (
    isInRange(value.r, 0, 255) &&
    isInRange(value.g, 0, 255) &&
    isInRange(value.b, 0, 255) &&
    isInRange(value.a, 0, 1)
  );
}

function validateHsl(
  value: unknown,
): value is { h: number; s: number; l: number; a: number } {
  if (!isObject(value)) return false;
  return (
    isInRange(value.h, 0, 360) &&
    isInRange(value.s, 0, 100) &&
    isInRange(value.l, 0, 100) &&
    isInRange(value.a, 0, 1)
  );
}

function validateHex(value: unknown): value is string {
  return typeof value === "string" && HEX_RE.test(value);
}

function validateCreatedAt(value: unknown, now: number): value is number {
  if (!isFiniteNumber(value) || value <= 0) return false;
  if (value < now - CREATED_AT_PAST_WINDOW_MS) return false;
  if (value > now + CREATED_AT_FUTURE_WINDOW_MS) return false;
  return true;
}

function validateColorChannel(
  value: unknown,
): value is { hex: string; rgb: PickedColor["rgb"]; hsl: PickedColor["hsl"] } {
  if (!isObject(value)) return false;
  if (!validateHex(value.hex)) return false;
  if (!validateRgb(value.rgb)) return false;
  if (!validateHsl(value.hsl)) return false;
  return true;
}

function validateInspectedElement(value: unknown): value is InspectedElement {
  if (!isObject(value)) return false;
  if (typeof value.tagName !== "string") return false;
  if (typeof value.id !== "string") return false;
  if (typeof value.className !== "string") return false;
  if (typeof value.textContent !== "string") return false;
  if (!isNonEmptyString(value.selector, MAX_SELECTOR_LENGTH)) return false;
  if (!validateRect(value.boundingRect)) return false;
  if (!isObject(value.computedStyles)) return false;
  return true;
}

/**
 * Top-level message validator. Returns the narrowed payload on success or
 * `null` on failure (with a `console.warn` describing the rejection reason).
 *
 * Pass `now` to override `Date.now()` for deterministic tests.
 */
export function validateIframeMessage(
  data: unknown,
  now: number = Date.now(),
): IframeMessage | null {
  if (!isObject(data)) return null;
  const type = data.type;
  if (typeof type !== "string") return null;

  switch (type) {
    case "selene-inspector-select":
      return validateInspectorSelect(data);
    case "selene-tool-measure":
      return validateMeasurement(data);
    case "selene-tool-color-pick":
      return validateColorPick(data);
    case "selene-tool-comment":
      return validateComment(data, now);
    case "selene-tool-comments-resolved":
      return validateCommentsResolved(data);
    case "selene-tool-measurements-resolved":
      return validateMeasurementsResolved(data);
    default:
      return null;
  }
}

function validateInspectorSelect(
  data: Record<string, unknown>,
): InspectorSelectPayload | null {
  if (!validateInspectedElement(data.element)) {
    return warnReject("selene-inspector-select", "invalid element");
  }
  const action = data.action;
  if (action !== undefined && action !== "add" && action !== "remove" && action !== "replace") {
    return warnReject("selene-inspector-select", "invalid action");
  }
  const multiSelect = data.multiSelect;
  if (multiSelect !== undefined && typeof multiSelect !== "boolean") {
    return warnReject("selene-inspector-select", "invalid multiSelect");
  }
  return {
    type: "selene-inspector-select",
    element: data.element,
    action,
    multiSelect,
  };
}

function validateMeasurementEndpoint(
  value: unknown,
): { selector: string; rect: IframeRect } | null {
  if (!isObject(value)) return null;
  if (!isNonEmptyString(value.selector, MAX_SELECTOR_LENGTH)) return null;
  if (!validateRect(value.rect)) return null;
  return { selector: value.selector, rect: value.rect };
}

function validateMeasurement(data: Record<string, unknown>): MeasurementPayload | null {
  const from = validateMeasurementEndpoint(data.from);
  if (!from) return warnReject("selene-tool-measure", "invalid from endpoint");
  const to = validateMeasurementEndpoint(data.to);
  if (!to) return warnReject("selene-tool-measure", "invalid to endpoint");
  const distances = data.distances;
  if (!isObject(distances)) {
    return warnReject("selene-tool-measure", "missing distances");
  }
  if (
    !isFiniteNumber(distances.dx) ||
    !isFiniteNumber(distances.dy) ||
    !isFiniteNumber(distances.horizontal) ||
    !isFiniteNumber(distances.vertical) ||
    !isFiniteNumber(distances.euclidean)
  ) {
    return warnReject("selene-tool-measure", "non-finite distance");
  }
  return {
    type: "selene-tool-measure",
    from,
    to,
    distances: {
      dx: distances.dx,
      dy: distances.dy,
      horizontal: distances.horizontal,
      vertical: distances.vertical,
      euclidean: distances.euclidean,
    },
  };
}

function validateColorPick(data: Record<string, unknown>): ColorPickPayload | null {
  const source = data.source;
  if (typeof source !== "string" || !COLOR_PICK_SOURCES.includes(source as PickedColor["source"])) {
    return warnReject("selene-tool-color-pick", "invalid source");
  }
  if (!validateColorChannel(data.background)) {
    return warnReject("selene-tool-color-pick", "invalid background");
  }
  if (!validateColorChannel(data.foreground)) {
    return warnReject("selene-tool-color-pick", "invalid foreground");
  }
  if (!validateColorChannel(data.picked)) {
    return warnReject("selene-tool-color-pick", "invalid picked");
  }
  const element = data.element;
  if (!isObject(element)) {
    return warnReject("selene-tool-color-pick", "missing element");
  }
  if (!isNonEmptyString(element.selector, MAX_SELECTOR_LENGTH)) {
    return warnReject("selene-tool-color-pick", "invalid element.selector");
  }
  if (typeof element.tagName !== "string" || element.tagName.length === 0) {
    return warnReject("selene-tool-color-pick", "invalid element.tagName");
  }
  return {
    type: "selene-tool-color-pick",
    source: source as PickedColor["source"],
    background: data.background,
    foreground: data.foreground,
    picked: data.picked,
    element: { selector: element.selector, tagName: element.tagName },
  };
}

function validateComment(
  data: Record<string, unknown>,
  now: number,
): CommentPayload | null {
  if (typeof data.tempId !== "string" || data.tempId.length === 0) {
    return warnReject("selene-tool-comment", "invalid tempId");
  }
  if (!isNonEmptyString(data.elementSelector, MAX_SELECTOR_LENGTH)) {
    return warnReject("selene-tool-comment", "invalid elementSelector");
  }
  if (typeof data.text !== "string") {
    return warnReject("selene-tool-comment", "text not string");
  }
  if (data.text.length === 0 || data.text.length > MAX_TEXT_LENGTH) {
    return warnReject("selene-tool-comment", "text length out of range");
  }
  if (!validateCreatedAt(data.createdAt, now)) {
    return warnReject("selene-tool-comment", "invalid createdAt");
  }
  return {
    type: "selene-tool-comment",
    tempId: data.tempId,
    elementSelector: data.elementSelector,
    text: data.text,
    createdAt: data.createdAt,
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function validateCommentsResolved(
  data: Record<string, unknown>,
): CommentsResolvedPayload | null {
  if (!isStringArray(data.resolved)) {
    return warnReject("selene-tool-comments-resolved", "invalid resolved");
  }
  if (!isStringArray(data.unresolved)) {
    return warnReject("selene-tool-comments-resolved", "invalid unresolved");
  }
  return {
    type: "selene-tool-comments-resolved",
    resolved: data.resolved,
    unresolved: data.unresolved,
  };
}

function validateMeasurementsResolved(
  data: Record<string, unknown>,
): MeasurementsResolvedPayload | null {
  if (!isStringArray(data.resolved)) {
    return warnReject("selene-tool-measurements-resolved", "invalid resolved");
  }
  if (!isStringArray(data.unresolved)) {
    return warnReject("selene-tool-measurements-resolved", "invalid unresolved");
  }
  return {
    type: "selene-tool-measurements-resolved",
    resolved: data.resolved,
    unresolved: data.unresolved,
  };
}

// ---------------------------------------------------------------------------
// Outbound (parent -> iframe) sync envelope validators
// ---------------------------------------------------------------------------
//
// These don't ride the inbound IframeMessage union — they're used by the
// parent at *send* time to assert we never post a malformed sync envelope to
// the in-iframe handler (which would silently drop it).
//
// Validation is shape-only: ids must be strings, rects/distances must contain
// finite numbers. Caps and content sanitization live in the store / sender.

interface MeasurementSyncCommon {
  id: string;
  from: { selector: string; rect: IframeRect };
  to: { selector: string; rect: IframeRect };
  distances: { dx: number; dy: number; horizontal: number; vertical: number; euclidean: number };
}

export type MeasurementsSyncEnvelope =
  | { type: "selene-tool-measurements-sync"; bootstrap: MeasurementSyncCommon[] }
  | {
      type: "selene-tool-measurements-sync";
      diff: { added: MeasurementSyncCommon[]; removed: string[]; updated: MeasurementSyncCommon[] };
    };

function validateMeasurementSyncEntry(value: unknown): MeasurementSyncCommon | null {
  if (!isObject(value)) return null;
  if (!isNonEmptyString(value.id, MAX_SELECTOR_LENGTH)) return null;
  const from = value.from;
  if (!isObject(from)) return null;
  if (!isNonEmptyString(from.selector, MAX_SELECTOR_LENGTH)) return null;
  if (!validateRect(from.rect)) return null;
  const to = value.to;
  if (!isObject(to)) return null;
  if (!isNonEmptyString(to.selector, MAX_SELECTOR_LENGTH)) return null;
  if (!validateRect(to.rect)) return null;
  const distances = value.distances;
  if (!isObject(distances)) return null;
  if (
    !isFiniteNumber(distances.dx) ||
    !isFiniteNumber(distances.dy) ||
    !isFiniteNumber(distances.horizontal) ||
    !isFiniteNumber(distances.vertical) ||
    !isFiniteNumber(distances.euclidean)
  ) {
    return null;
  }
  return {
    id: value.id,
    from: { selector: from.selector, rect: from.rect },
    to: { selector: to.selector, rect: to.rect },
    distances: {
      dx: distances.dx,
      dy: distances.dy,
      horizontal: distances.horizontal,
      vertical: distances.vertical,
      euclidean: distances.euclidean,
    },
  };
}

/**
 * Validates a `selene-tool-measurements-sync` envelope from any direction.
 * Accepts either `{ bootstrap: [...] }` or `{ diff: { added, removed, updated } }`.
 * Returns the narrowed envelope on success, `null` on miss.
 */
export function validateMeasurementsSync(
  data: unknown,
): MeasurementsSyncEnvelope | null {
  if (!isObject(data)) return null;
  if (data.type !== "selene-tool-measurements-sync") return null;

  if (Array.isArray(data.bootstrap)) {
    const entries: MeasurementSyncCommon[] = [];
    for (const raw of data.bootstrap) {
      const entry = validateMeasurementSyncEntry(raw);
      if (!entry) return warnReject("selene-tool-measurements-sync", "invalid bootstrap entry");
      entries.push(entry);
    }
    return { type: "selene-tool-measurements-sync", bootstrap: entries };
  }

  if (isObject(data.diff)) {
    const diff = data.diff;
    if (!Array.isArray(diff.added)) return warnReject("selene-tool-measurements-sync", "invalid diff.added");
    if (!Array.isArray(diff.removed) || !isStringArray(diff.removed)) {
      return warnReject("selene-tool-measurements-sync", "invalid diff.removed");
    }
    if (!Array.isArray(diff.updated)) return warnReject("selene-tool-measurements-sync", "invalid diff.updated");

    const added: MeasurementSyncCommon[] = [];
    for (const raw of diff.added) {
      const entry = validateMeasurementSyncEntry(raw);
      if (!entry) return warnReject("selene-tool-measurements-sync", "invalid diff.added entry");
      added.push(entry);
    }
    const updated: MeasurementSyncCommon[] = [];
    for (const raw of diff.updated) {
      const entry = validateMeasurementSyncEntry(raw);
      if (!entry) return warnReject("selene-tool-measurements-sync", "invalid diff.updated entry");
      updated.push(entry);
    }
    return {
      type: "selene-tool-measurements-sync",
      diff: { added, removed: diff.removed, updated },
    };
  }

  return warnReject("selene-tool-measurements-sync", "missing bootstrap or diff");
}

/**
 * Convenience boolean wrapper. Useful when callers only care whether the
 * payload is valid; they should still call `validateIframeMessage` to obtain
 * the narrowed payload they intend to act on.
 */
function isIframeMessage(value: unknown): value is IframeMessage {
  return validateIframeMessage(value) !== null;
}
