import type { DesignComponent, InspectedElement } from "./types";

export const MAX_INSPECT_SELECTIONS = 8;
const MAX_TEXT_LENGTH = 160;
const MAX_CLASS_COUNT = 6;
const INSPECT_CONTEXT_VERSION = 1 as const;

export interface InspectElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InspectSelection {
  tagName: string;
  id: string;
  selector: string;
  textContent: string;
  className: string;
  classes: string[];
  bounds: InspectElementBounds;
  hierarchy: string[];
}

export interface InspectMessageContext {
  version: typeof INSPECT_CONTEXT_VERSION;
  source: "design-workspace-inspector";
  sessionId?: string;
  userId?: string;
  componentId?: string;
  componentName?: string;
  userIntent?: string;
  selectedAt: string;
  elements: InspectSelection[];
}

function clampText(value: string | undefined, maxLength = MAX_TEXT_LENGTH): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "";
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}...` : trimmed;
}

function normalizeClasses(className: string): string[] {
  return className
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_CLASS_COUNT);
}

function normalizeHierarchy(selector: string): string[] {
  return selector
    .split(" > ")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .slice(-6);
}

function toFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function getInspectSelectionKey(selection: Pick<InspectSelection, "selector">): string {
  return selection.selector;
}

export function inspectSelectionFromElement(element: InspectedElement): InspectSelection {
  const selector = clampText(element.selector, 320);
  return {
    tagName: clampText(element.tagName.toLowerCase(), 40),
    id: clampText(element.id, 120),
    selector,
    textContent: clampText(element.textContent),
    className: clampText(element.className, 240),
    classes: normalizeClasses(element.className),
    bounds: {
      x: toFiniteNumber(element.boundingRect.x),
      y: toFiniteNumber(element.boundingRect.y),
      width: toFiniteNumber(element.boundingRect.width),
      height: toFiniteNumber(element.boundingRect.height),
    },
    hierarchy: normalizeHierarchy(selector),
  };
}

export function buildInspectMessageContext(args: {
  selectedElements: InspectedElement[];
  component: Pick<DesignComponent, "id" | "name"> | null;
  sessionId?: string | null;
  userIntent?: string;
}): InspectMessageContext | null {
  const elements = args.selectedElements
    .map(inspectSelectionFromElement)
    .filter((selection) => selection.selector)
    .slice(0, MAX_INSPECT_SELECTIONS);

  if (elements.length === 0) {
    return null;
  }

  return {
    version: INSPECT_CONTEXT_VERSION,
    source: "design-workspace-inspector",
    sessionId: args.sessionId ?? undefined,
    componentId: args.component?.id ?? undefined,
    componentName: clampText(args.component?.name, 120) || undefined,
    userIntent: clampText(args.userIntent, 240) || undefined,
    selectedAt: new Date().toISOString(),
    elements,
  };
}

export function sanitizeInspectMessageContext(value: unknown): InspectMessageContext | null {
  if (!value || typeof value !== "object") return null;

  const raw = value as Partial<InspectMessageContext> & { elements?: unknown[] };
  if (!Array.isArray(raw.elements) || raw.elements.length === 0) return null;

  const elements = raw.elements
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const candidate = entry as Partial<InspectSelection> & { bounds?: Partial<InspectElementBounds> };
      const selector = clampText(candidate.selector, 320);
      const tagName = clampText(candidate.tagName?.toLowerCase(), 40);
      if (!selector || !tagName) return null;

      const className = clampText(candidate.className, 240);
      const classes = Array.isArray(candidate.classes)
        ? candidate.classes.map((value) => clampText(String(value), 80)).filter(Boolean).slice(0, MAX_CLASS_COUNT)
        : normalizeClasses(className);

      return {
        tagName,
        id: clampText(candidate.id, 120),
        selector,
        textContent: clampText(candidate.textContent),
        className,
        classes,
        bounds: {
          x: toFiniteNumber(candidate.bounds?.x),
          y: toFiniteNumber(candidate.bounds?.y),
          width: toFiniteNumber(candidate.bounds?.width),
          height: toFiniteNumber(candidate.bounds?.height),
        },
        hierarchy: Array.isArray(candidate.hierarchy)
          ? candidate.hierarchy.map((part) => clampText(String(part), 120)).filter(Boolean).slice(-6)
          : normalizeHierarchy(selector),
      } satisfies InspectSelection;
    })
    .filter((entry): entry is InspectSelection => entry !== null)
    .slice(0, MAX_INSPECT_SELECTIONS);

  if (elements.length === 0) return null;

  const selectedAt = clampText(raw.selectedAt, 80) || new Date().toISOString();

  return {
    version: INSPECT_CONTEXT_VERSION,
    source: "design-workspace-inspector",
    sessionId: clampText(raw.sessionId, 120) || undefined,
    userId: clampText(raw.userId, 120) || undefined,
    componentId: clampText(raw.componentId, 120) || undefined,
    componentName: clampText(raw.componentName, 120) || undefined,
    userIntent: clampText(raw.userIntent, 240) || undefined,
    selectedAt,
    elements,
  };
}

function attachInspectContextIdentity(
  context: InspectMessageContext | null,
  identity: { sessionId?: string | null; userId?: string | null },
): InspectMessageContext | null {
  if (!context) return null;
  return {
    ...context,
    sessionId: identity.sessionId ?? context.sessionId,
    userId: identity.userId ?? context.userId,
  };
}

export function formatInspectSelectionLabel(selection: Pick<InspectSelection, "tagName" | "textContent" | "classes">): string {
  const classLabel = selection.classes.slice(0, 2).map((name) => `.${name}`).join(" ");
  const textLabel = selection.textContent ? ` \"${selection.textContent}\"` : "";
  return `<${selection.tagName}>${classLabel ? ` ${classLabel}` : ""}${textLabel}`;
}

export function buildInspectPromptText(context: InspectMessageContext | null): string | null {
  if (!context || context.elements.length === 0) return null;

  const lines = ["[Inspect Focus]"];
  if (context.componentName || context.componentId) {
    lines.push(
      `Component: ${context.componentName || "Untitled"}${context.componentId ? ` (${context.componentId})` : ""}`,
    );
  }
  if (context.userIntent) {
    lines.push(`User focus intent: ${context.userIntent}`);
  }
  lines.push(`Selected elements: ${context.elements.length}`);

  context.elements.forEach((selection, index) => {
    const summary = formatInspectSelectionLabel(selection);
    const bounds = `${Math.round(selection.bounds.width)}x${Math.round(selection.bounds.height)} at (${Math.round(selection.bounds.x)}, ${Math.round(selection.bounds.y)})`;
    lines.push(`${index + 1}. ${summary}`);
    lines.push(`   selector: ${selection.selector}`);
    lines.push(`   bounds: ${bounds}`);
    if (selection.hierarchy.length > 0) {
      lines.push(`   hierarchy: ${selection.hierarchy.join(" > ")}`);
    }
  });

  return lines.join("\n");
}
