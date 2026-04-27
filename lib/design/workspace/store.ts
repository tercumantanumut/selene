"use client";

import { create } from "zustand";
import {
  DESIGN_BREAKPOINTS,
  type DesignWorkspaceState,
  type DesignWorkspaceSessionState,
  type DesignWorkspaceStatus,
  type DesignComponent,
  type DesignBreakpoint,
  type DesignSnapshot,
  type DesignPreviewTheme,
  type InspectedElement,
  type ActiveTool,
  type Measurement,
  type PickedColor,
  type DesignComment,
} from "./types";
import {
  DEFAULT_DESIGN_WORKSPACE_CONFIG,
  normalizeDesignWorkspaceConfig,
  type DesignWorkspaceCompileReport,
  type DesignWorkspaceConfig,
  type DesignWorkspaceValidationResult,
} from "./config";
import type { DesignWorkspaceHistory } from "./edit-history";
import { buildDesignPreviewHtml } from "./preview";

function buildPreviewMarkup(component: Pick<DesignComponent, "code" | "mode" | "name">): string {
  try {
    return buildDesignPreviewHtml({
      code: component.code,
      componentName: component.name,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Preview unavailable.";
    return `<!DOCTYPE html><html><body style="margin:0;padding:16px;font-family:ui-monospace,monospace;background:#111827;color:#f9fafb;"><pre style="white-space:pre-wrap;">${message}</pre></body></html>`;
  }
}

// ---------------------------------------------------------------------------
// Session cache (module-level, NOT in the store)
// ---------------------------------------------------------------------------
/**
 * Number of inactive sessions retained in memory. Kept small so the app
 * doesn't accumulate every session the user has visited — heavy fields
 * (`code`) are further stripped on cache-out via `stripSessionCodeForCache`.
 */
const MAX_CACHED_SESSIONS = 3;
const sessionCache = new Map<string, DesignWorkspaceSessionState>();

/**
 * Maximum number of components in the live store that keep their full
 * `code` payload. When exceeded, the least recently touched non-active
 * component has its `code` stripped and `codeStripped: true` set. A click
 * or agent action triggers re-hydration via `fetchComponentFromGallery`.
 *
 * Sized at 16 so parallel agent workflows that burst-generate 8+ components
 * in a single turn don't immediately strip the just-authored siblings — the
 * prior limit of 3 caused 4-of-7 and then 7-of-7 components to evict their
 * code mid-turn, which surfaced to the user as `Component code is required`
 * once the preview compile hook re-ran. The eviction path still fires for
 * library-scale browsing (dozens+ components), but typical single-session
 * generation bursts now survive unchanged.
 */
export const MAX_HYDRATED_COMPONENTS = 16;

/**
 * FIFO caps on per-tool collections. Pushing past the cap drops the oldest
 * entry (lowest index) so long sessions can't accumulate unbounded state.
 * Comments get a higher cap because they're meant to persist across the
 * lifetime of a design review.
 */
export const MAX_MEASUREMENTS = 200;
export const MAX_PICKED_COLORS = 200;
export const MAX_COMMENTS = 500;

function pushFifo<T>(arr: readonly T[], entry: T, cap: number): T[] {
  if (arr.length >= cap) {
    // Drop oldest entries to make room for the new one.
    return [...arr.slice(arr.length - cap + 1), entry];
  }
  return [...arr, entry];
}

/**
 * Tracks the order in which components were most recently hydrated
 * (full-code). Newest at the end. Keyed per-session: switching sessions
 * swaps the tracker so eviction accounting doesn't bleed across sessions.
 */
const hydrationOrderBySession = new Map<string, string[]>();
const NO_SESSION_HYDRATION_KEY = "__nosession__";

function getHydrationOrder(sessionId: string | null): string[] {
  const key = sessionId ?? NO_SESSION_HYDRATION_KEY;
  let order = hydrationOrderBySession.get(key);
  if (!order) {
    order = [];
    hydrationOrderBySession.set(key, order);
  }
  return order;
}

function touchHydration(sessionId: string | null, componentId: string): void {
  const order = getHydrationOrder(sessionId);
  const existingIndex = order.indexOf(componentId);
  if (existingIndex !== -1) order.splice(existingIndex, 1);
  order.push(componentId);
}

function untrackHydration(sessionId: string | null, componentId: string): void {
  const order = getHydrationOrder(sessionId);
  const idx = order.indexOf(componentId);
  if (idx !== -1) order.splice(idx, 1);
}

/**
 * Walks the hydration tracker and strips `code` from components beyond the
 * `MAX_HYDRATED_COMPONENTS` limit. Never evicts the active component.
 * Returns the updated component list.
 */
function applyCodeEviction(
  components: DesignComponent[],
  sessionId: string | null,
  activeComponentId: string | null,
): DesignComponent[] {
  const order = getHydrationOrder(sessionId);
  if (order.length <= MAX_HYDRATED_COMPONENTS) return components;

  // Candidates for eviction: oldest first, never the active one.
  const toEvict = new Set<string>();
  let remaining = order.length - MAX_HYDRATED_COMPONENTS;
  for (const id of order) {
    if (remaining <= 0) break;
    if (id === activeComponentId) continue;
    toEvict.add(id);
    remaining -= 1;
  }

  if (toEvict.size === 0) return components;

  // Remove evicted ids from the hydration tracker.
  for (let i = order.length - 1; i >= 0; i -= 1) {
    if (toEvict.has(order[i])) order.splice(i, 1);
  }

  return components.map((c) =>
    toEvict.has(c.id) ? { ...c, code: "", codeStripped: true } : c,
  );
}

/**
 * When caching a session's state, strip heavy `code` payloads from any
 * non-active component. The active component retains its code so restoring
 * the session doesn't flash a blank preview. Consumers rehydrate evicted
 * components on-demand.
 */
function stripSessionCodeForCache(state: DesignWorkspaceSessionState): DesignWorkspaceSessionState {
  const activeId = state.activeComponentId;
  const components = state.components.map((component) => {
    if (component.id === activeId) return component;
    if (!component.code) return { ...component, codeStripped: true };
    return { ...component, code: "", codeStripped: true };
  });
  return { ...state, components };
}

/** Basic LRU eviction: delete the oldest entry when the cache exceeds max. */
function cacheSessionState(sessionId: string, state: DesignWorkspaceSessionState): void {
  // Re-insert to move to "newest" position (Map preserves insertion order)
  sessionCache.delete(sessionId);
  sessionCache.set(sessionId, stripSessionCodeForCache(state));

  if (sessionCache.size > MAX_CACHED_SESSIONS) {
    // Delete the oldest (first) key
    const oldest = sessionCache.keys().next().value;
    if (oldest !== undefined) {
      sessionCache.delete(oldest);
      hydrationOrderBySession.delete(oldest);
    }
  }
}

function extractSessionState(store: DesignWorkspaceState): DesignWorkspaceSessionState {
  return {
    isOpen: store.isOpen,
    status: store.status,
    components: store.components,
    activeComponentId: store.activeComponentId,
    snapshots: store.snapshots,
    selectedBreakpoint: store.selectedBreakpoint,
    previewHtml: store.previewHtml,
    showCode: store.showCode,
    error: store.error,
    inspectorEnabled: store.inspectorEnabled,
    selectedElement: store.selectedElement,
    selectedElements: store.selectedElements,
    previewTheme: store.previewTheme,
    config: store.config,
    lastValidation: store.lastValidation,
    lastCompileReport: store.lastCompileReport,
    history: store.history,
    activeTool: store.activeTool,
    measurements: store.measurements,
    pickedColors: store.pickedColors,
    comments: store.comments,
  };
}

const initialSessionState: DesignWorkspaceSessionState = {
  isOpen: false,
  status: "idle" as DesignWorkspaceStatus,
  components: [] as DesignComponent[],
  activeComponentId: null as string | null,
  snapshots: [] as DesignSnapshot[],
  selectedBreakpoint: DESIGN_BREAKPOINTS[0], // responsive
  previewHtml: "",
  showCode: false,
  error: null,
  inspectorEnabled: false,
  selectedElement: null,
  selectedElements: [],
  previewTheme: "light" as DesignPreviewTheme,
  config: { ...DEFAULT_DESIGN_WORKSPACE_CONFIG },
  lastValidation: null,
  lastCompileReport: null,
  history: null,
  activeTool: null,
  measurements: [],
  pickedColors: [],
  comments: [],
};

const initialState = {
  ...initialSessionState,
  sessionId: null as string | null,
};

export const useDesignWorkspaceStore = create<DesignWorkspaceState>((set, get) => ({
  ...initialState,

  open: () => {
    set({ isOpen: true });
  },

  close: () => {
    set({ isOpen: false });
  },

  setStatus: (status: DesignWorkspaceStatus) => {
    set({ status });
  },

  addComponent: (component: DesignComponent) => {
    const current = get();
    // A full-code insert has a non-empty `code` and is not flagged as a stub.
    // Summary-only inserts (used for replays from historical tool results and
    // for gallery browse entries) leave the existing code intact and skip
    // activation / preview rebuild.
    const hasFullCode = Boolean(component.code) && !component.codeStripped;
    const existingIndex = current.components.findIndex((c) => c.id === component.id);

    if (existingIndex !== -1) {
      const existing = current.components[existingIndex];
      const merged: DesignComponent = hasFullCode
        ? { ...existing, ...component, codeStripped: false }
        : {
            ...existing,
            ...component,
            // Preserve any previously-hydrated code when a summary arrives.
            code: existing.code,
            codeStripped: existing.codeStripped ?? !existing.code,
          };

      const nextComponents = [...current.components];
      nextComponents[existingIndex] = merged;

      if (hasFullCode) touchHydration(current.sessionId, component.id);

      const shouldActivate = hasFullCode;
      const activeAfter = shouldActivate ? component.id : current.activeComponentId;
      const evicted = applyCodeEviction(nextComponents, current.sessionId, activeAfter);

      const nextState: Partial<DesignWorkspaceState> = { components: evicted };

      if (shouldActivate) {
        const isAlreadyActive = current.activeComponentId === component.id;
        nextState.activeComponentId = component.id;
        // Only rebuild the placeholder preview when it would otherwise be
        // missing (activation transition or no existing preview). The
        // placeholder is intentionally code-independent; the real preview
        // is compiled async by `useCompileTailwindPreview`, which observes
        // `code` changes directly and re-fetches `/api/design/compile-preview`.
        // Rebuilding here on code change would just flash the loader.
        if (!isAlreadyActive || !current.previewHtml) {
          const activeComponent = evicted.find((c) => c.id === component.id);
          if (activeComponent && activeComponent.code) {
            nextState.previewHtml = buildPreviewMarkup(activeComponent);
          }
        }
      }

      set(nextState);
      return;
    }

    // Net-new insertion.
    const normalised: DesignComponent = hasFullCode
      ? { ...component, codeStripped: false }
      : { ...component, code: component.code ?? "", codeStripped: true };

    if (hasFullCode) touchHydration(current.sessionId, component.id);

    const shouldActivate = hasFullCode;
    const activeAfter = shouldActivate ? component.id : current.activeComponentId;
    const evicted = applyCodeEviction(
      [...current.components, normalised],
      current.sessionId,
      activeAfter,
    );

    const nextState: Partial<DesignWorkspaceState> = { components: evicted };

    if (shouldActivate) {
      nextState.activeComponentId = component.id;
      const activeComponent = evicted.find((c) => c.id === component.id);
      if (activeComponent && activeComponent.code) {
        nextState.previewHtml = buildPreviewMarkup(activeComponent);
      }
    }

    set(nextState);
  },

  updateComponent: (id: string, updates: Partial<DesignComponent>) => {
    const current = get();
    const now = new Date().toISOString();
    const nextComponents = current.components.map((c) => {
      if (c.id !== id) return c;
      const merged: DesignComponent = { ...c, ...updates, updatedAt: now };
      if (updates.code && !updates.codeStripped) {
        merged.codeStripped = false;
      }
      return merged;
    });

    if (updates.code && !updates.codeStripped) {
      touchHydration(current.sessionId, id);
    }

    const evicted = applyCodeEviction(nextComponents, current.sessionId, current.activeComponentId);
    const nextState: Partial<DesignWorkspaceState> = { components: evicted };

    if (current.activeComponentId === id) {
      const updatedComponent = evicted.find((component) => component.id === id);
      if (updatedComponent && updatedComponent.code) {
        nextState.previewHtml = buildPreviewMarkup(updatedComponent);
      }
    }

    set(nextState);
  },

  removeComponent: (id: string) => {
    const current = get();
    const nextComponents = current.components.filter((c) => c.id !== id);
    const nextSnapshots = current.snapshots.filter((s) => s.componentId !== id);
    untrackHydration(current.sessionId, id);
    const nextState: Partial<DesignWorkspaceState> = {
      components: nextComponents,
      snapshots: nextSnapshots,
    };

    if (current.activeComponentId === id) {
      const fallback = nextComponents[0] ?? null;
      nextState.activeComponentId = fallback?.id ?? null;
      nextState.previewHtml = fallback && fallback.code ? buildPreviewMarkup(fallback) : "";
    }

    set(nextState);
  },

  setActiveComponent: (id: string | null) => {
    const current = get();
    // Normalize invalid IDs to null to prevent impossible state
    const component = id ? current.components.find((c) => c.id === id) : null;
    if (component && component.code) {
      touchHydration(current.sessionId, component.id);
    }
    set({
      activeComponentId: component ? id : null,
      // Leave preview blank when the target is a stub (codeStripped) — the
      // bridge / gallery must rehydrate full code before the preview can be
      // recomputed. This prevents the broken preview iframe issue during
      // large-library browsing.
      previewHtml: component && component.code ? buildPreviewMarkup(component) : "",
      selectedElement: null,
      selectedElements: [],
    });
  },

  setPreviewHtml: (html: string) => {
    set({ previewHtml: html });
  },

  setBreakpoint: (breakpoint: DesignBreakpoint) => {
    set({ selectedBreakpoint: breakpoint });
  },

  setPreviewTheme: (theme: DesignPreviewTheme) => {
    set({ previewTheme: theme });
  },

  toggleCode: () => {
    set({ showCode: !get().showCode });
  },

  toggleInspector: () => {
    const current = get();
    const next: ActiveTool = current.activeTool === "inspect" ? null : "inspect";
    get().setActiveTool(next);
  },

  setActiveTool: (tool: ActiveTool) => {
    const current = get();
    const inspectorEnabled = tool === "inspect";
    // Clear in-progress per-tool state when switching tools.
    set({
      activeTool: tool,
      inspectorEnabled,
      selectedElement: inspectorEnabled ? current.selectedElement : null,
      selectedElements: inspectorEnabled ? current.selectedElements : [],
    });
  },

  setSelectedElement: (el: InspectedElement | null) => {
    set({ selectedElement: el, selectedElements: el ? [el] : [] });
  },

  setSelectedElements: (elements: InspectedElement[]) => {
    const normalized = elements.filter((element, index, source) => {
      const key = element.selector;
      return key ? source.findIndex((candidate) => candidate.selector === key) === index : index === 0;
    });
    set({
      selectedElements: normalized,
      selectedElement: normalized[0] ?? null,
    });
  },

  toggleSelectedElement: (el: InspectedElement) => {
    const current = get().selectedElements;
    const exists = current.some((candidate) => candidate.selector === el.selector);
    const next = exists
      ? current.filter((candidate) => candidate.selector !== el.selector)
      : [...current, el];
    set({
      selectedElements: next,
      selectedElement: next[0] ?? null,
    });
  },

  removeSelectedElement: (selector: string) => {
    const next = get().selectedElements.filter((element) => element.selector !== selector);
    set({
      selectedElements: next,
      selectedElement: next[0] ?? null,
    });
  },

  clearSelectedElements: () => {
    set({ selectedElements: [], selectedElement: null });
  },

  takeSnapshot: (label?: string, id?: string) => {
    const current = get();
    if (!current.activeComponentId) {
      return;
    }

    const component = current.components.find((c) => c.id === current.activeComponentId);
    if (!component) {
      return;
    }

    // Dedup: skip if the last snapshot for this component has identical code
    const lastForComponent = [...current.snapshots]
      .reverse()
      .find((s) => s.componentId === component.id);
    if (lastForComponent && lastForComponent.code === component.code) {
      return;
    }

    const snapshot: DesignSnapshot = {
      id: id ?? crypto.randomUUID(),
      componentId: component.id,
      code: component.code,
      label,
      createdAt: new Date().toISOString(),
    };

    set({ snapshots: [...current.snapshots, snapshot] });
  },

  restoreSnapshot: (snapshotId: string) => {
    const current = get();
    const snapshot = current.snapshots.find((s) => s.id === snapshotId);
    if (!snapshot) {
      set({ error: `Snapshot "${snapshotId}" not found.` });
      return;
    }

    // Verify the target component still exists
    const targetExists = current.components.some((c) => c.id === snapshot.componentId);
    if (!targetExists) {
      set({ error: `Component for snapshot "${snapshotId}" was deleted.` });
      return;
    }

    const now = new Date().toISOString();
    const nextComponents = current.components.map((c) =>
      c.id === snapshot.componentId ? { ...c, code: snapshot.code, updatedAt: now } : c,
    );
    const nextState: Partial<DesignWorkspaceState> = { components: nextComponents, error: null };

    if (current.activeComponentId === snapshot.componentId) {
      const updatedComponent = nextComponents.find((component) => component.id === snapshot.componentId);
      nextState.previewHtml = updatedComponent ? buildPreviewMarkup(updatedComponent) : "";
    }

    set(nextState);
  },

  clearError: () => {
    set({ error: null });
  },

  setError: (error: string | null) => {
    set({ error });
  },

  setConfig: (config: DesignWorkspaceConfig) => {
    set({ config: normalizeDesignWorkspaceConfig(config) });
  },

  updateConfig: (updates: Partial<DesignWorkspaceConfig>) => {
    set({ config: normalizeDesignWorkspaceConfig({ ...get().config, ...updates }) });
  },

  setLastValidation: (validation: DesignWorkspaceValidationResult | null) => {
    set({ lastValidation: validation });
  },

  setLastCompileReport: (report: DesignWorkspaceCompileReport | null) => {
    set({ lastCompileReport: report });
  },

  setHistory: (history: DesignWorkspaceHistory | null) => {
    set({ history });
  },

  setActiveSession: (sessionId: string) => {
    const current = get();

    // Save current session state to cache (if we have a session)
    if (current.sessionId) {
      cacheSessionState(current.sessionId, extractSessionState(current));
    }

    // Restore target session from cache, or initialize fresh. Cached state
    // has `code` stripped from inactive components (see
    // stripSessionCodeForCache) — the bridge / gallery will rehydrate them
    // on demand.
    const cached = sessionCache.get(sessionId);
    if (cached) {
      // Move to newest position in cache
      sessionCache.delete(sessionId);
      set({ ...cached, sessionId });
      // Rebuild hydration tracker from the restored component list so
      // eviction accounting matches the visible state.
      const order: string[] = [];
      for (const component of cached.components) {
        if (component.code && !component.codeStripped) order.push(component.id);
      }
      hydrationOrderBySession.set(sessionId, order);
    } else {
      set({
        ...initialSessionState,
        selectedBreakpoint: { ...DESIGN_BREAKPOINTS[0] },
        sessionId,
      });
      hydrationOrderBySession.set(sessionId, []);
    }
  },

  reset: () => {
    const { sessionId } = get();
    if (sessionId) hydrationOrderBySession.delete(sessionId);
    else hydrationOrderBySession.delete(NO_SESSION_HYDRATION_KEY);
    set({ ...initialState, selectedBreakpoint: { ...DESIGN_BREAKPOINTS[0] } });
  },

  addMeasurement: (m: Measurement) => {
    set({ measurements: pushFifo(get().measurements, m, MAX_MEASUREMENTS) });
  },

  removeMeasurement: (id: string) => {
    set({ measurements: get().measurements.filter((entry) => entry.id !== id) });
  },

  clearMeasurements: () => {
    set({ measurements: [] });
  },

  addPickedColor: (c: PickedColor) => {
    set({ pickedColors: pushFifo(get().pickedColors, c, MAX_PICKED_COLORS) });
  },

  removePickedColor: (id: string) => {
    set({ pickedColors: get().pickedColors.filter((entry) => entry.id !== id) });
  },

  clearPickedColors: () => {
    set({ pickedColors: [] });
  },

  addComment: (c: DesignComment) => {
    set({ comments: pushFifo(get().comments, c, MAX_COMMENTS) });
  },

  updateComment: (id: string, patch: Partial<Omit<DesignComment, "id">>) => {
    set({
      comments: get().comments.map((entry) =>
        entry.id === id ? { ...entry, ...patch } : entry,
      ),
    });
  },

  removeComment: (id: string) => {
    set({ comments: get().comments.filter((entry) => entry.id !== id) });
  },

  resolveComment: (id: string) => {
    set({
      comments: get().comments.map((entry) =>
        entry.id === id ? { ...entry, resolved: !entry.resolved } : entry,
      ),
    });
  },

  clearComments: () => {
    set({ comments: [] });
  },

  markCommentsOrphaned: (unresolvedIds: string[], resolvedIds: string[]) => {
    if (unresolvedIds.length === 0 && resolvedIds.length === 0) return;
    const unresolvedSet = new Set(unresolvedIds);
    const resolvedSet = new Set(resolvedIds);
    set({
      comments: get().comments.map((entry) => {
        if (unresolvedSet.has(entry.id)) {
          // Mark stale if the iframe couldn't find a matching DOM node.
          return entry.orphaned === true ? entry : { ...entry, orphaned: true };
        }
        if (resolvedSet.has(entry.id) && entry.orphaned === true) {
          // Clear stale flag once the selector resolves again. Set to `false`
          // explicitly (not `undefined`) so the cleared state round-trips
          // through the session cache.
          return { ...entry, orphaned: false };
        }
        return entry;
      }),
    });
  },

  markMeasurementsOrphaned: (unresolvedIds: string[], resolvedIds: string[]) => {
    if (unresolvedIds.length === 0 && resolvedIds.length === 0) return;
    const unresolvedSet = new Set(unresolvedIds);
    const resolvedSet = new Set(resolvedIds);
    const current = get().measurements;
    let changed = false;
    const next = current.map((entry) => {
      if (unresolvedSet.has(entry.id)) {
        if (entry.orphaned === true) return entry;
        changed = true;
        return { ...entry, orphaned: true };
      }
      if (resolvedSet.has(entry.id) && entry.orphaned === true) {
        changed = true;
        return { ...entry, orphaned: false };
      }
      return entry;
    });
    // No-op short-circuit — preserve array reference so subscribers don't
    // re-trigger sync effects on a redundant ack from the iframe.
    if (!changed) return;
    set({ measurements: next });
  },
}));
