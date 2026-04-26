import type {
  DesignWorkspaceConfig,
  DesignWorkspaceCompileReport,
  DesignWorkspaceValidationResult,
} from "./config";
import type { DesignWorkspaceHistory } from "./edit-history";

export interface DesignComponent {
  id: string;
  name: string;
  code: string;
  mode: "tailwind";
  style: "apple-glass" | "default";
  prompt: string;
  createdAt: string;
  updatedAt: string;
  /**
   * When true, this entry is a metadata-only placeholder — `code` has been
   * evicted (or was never hydrated) to bound memory usage across long
   * sessions. Consumers that need the real source must call
   * `fetchComponentFromGallery` (via the bridge) to rehydrate it before
   * rendering a preview or displaying the code panel.
   */
  codeStripped?: boolean;
}

export interface DesignSnapshot {
  id: string;
  componentId: string;
  code: string;
  label?: string;
  createdAt: string;
}

export interface DesignBreakpoint {
  name: string;
  width: number;
  height: number;
}

export const DESIGN_BREAKPOINTS: DesignBreakpoint[] = [
  { name: "responsive", width: 0, height: 0 },
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];

export type DesignWorkspaceStatus = "idle" | "generating" | "editing" | "exporting";

export type DesignPreviewTheme = "light" | "dark" | "system";

/** Element info captured by the in-iframe inspector and sent via postMessage. */
export interface InspectedElement {
  tagName: string;
  id: string;
  className: string;
  textContent: string;
  selector: string;
  boundingRect: { x: number; y: number; width: number; height: number };
  computedStyles: {
    width: string;
    height: string;
    padding: string;
    margin: string;
    display: string;
    position: string;
    color: string;
    backgroundColor: string;
    fontSize: string;
    fontFamily: string;
  };
}

/** Active toolbar mode in the design preview. `null` is the default cursor / no tool. */
export type ActiveTool = "inspect" | "measure" | "eyedropper" | "comment" | null;

export interface Measurement {
  id: string;
  from: { selector: string; rect: { x: number; y: number; width: number; height: number } };
  to: { selector: string; rect: { x: number; y: number; width: number; height: number } };
  distances: { dx: number; dy: number; horizontal: number; vertical: number; euclidean: number };
  createdAt: number;
}

export interface PickedColor {
  id: string;
  hex: string;
  rgb: { r: number; g: number; b: number; a: number };
  hsl: { h: number; s: number; l: number; a: number };
  source: "background" | "foreground";
  element: { selector: string; tagName: string };
  createdAt: number;
}

export interface DesignComment {
  id: string;
  elementSelector: string;
  text: string;
  createdAt: number;
  resolved: boolean;
}

/** Serialisable session state that gets cached when switching sessions. */
export interface DesignWorkspaceSessionState {
  isOpen: boolean;
  status: DesignWorkspaceStatus;
  components: DesignComponent[];
  activeComponentId: string | null;
  snapshots: DesignSnapshot[];
  selectedBreakpoint: DesignBreakpoint;
  previewHtml: string;
  showCode: boolean;
  error: string | null;
  inspectorEnabled: boolean;
  selectedElement: InspectedElement | null;
  selectedElements: InspectedElement[];
  previewTheme: DesignPreviewTheme;
  config: DesignWorkspaceConfig;
  lastValidation: DesignWorkspaceValidationResult | null;
  lastCompileReport: DesignWorkspaceCompileReport | null;
  history: DesignWorkspaceHistory | null;
  activeTool: ActiveTool;
  measurements: Measurement[];
  pickedColors: PickedColor[];
  comments: DesignComment[];
}

export interface DesignWorkspaceState extends DesignWorkspaceSessionState {
  sessionId: string | null;
  open: () => void;
  close: () => void;
  setStatus: (status: DesignWorkspaceStatus) => void;
  addComponent: (component: DesignComponent) => void;
  updateComponent: (id: string, updates: Partial<DesignComponent>) => void;
  removeComponent: (id: string) => void;
  setActiveComponent: (id: string | null) => void;
  setPreviewHtml: (html: string) => void;
  setBreakpoint: (breakpoint: DesignBreakpoint) => void;
  setPreviewTheme: (theme: DesignPreviewTheme) => void;
  toggleCode: () => void;
  toggleInspector: () => void;
  setSelectedElement: (el: InspectedElement | null) => void;
  setSelectedElements: (elements: InspectedElement[]) => void;
  toggleSelectedElement: (el: InspectedElement) => void;
  removeSelectedElement: (selector: string) => void;
  clearSelectedElements: () => void;
  takeSnapshot: (label?: string, id?: string) => void;
  restoreSnapshot: (snapshotId: string) => void;
  clearError: () => void;
  setError: (error: string | null) => void;
  setConfig: (config: DesignWorkspaceConfig) => void;
  updateConfig: (updates: Partial<DesignWorkspaceConfig>) => void;
  setLastValidation: (validation: DesignWorkspaceValidationResult | null) => void;
  setLastCompileReport: (report: DesignWorkspaceCompileReport | null) => void;
  setHistory: (history: DesignWorkspaceHistory | null) => void;
  setActiveSession: (sessionId: string) => void;
  reset: () => void;
  setActiveTool: (tool: ActiveTool) => void;
  addMeasurement: (m: Measurement) => void;
  removeMeasurement: (id: string) => void;
  clearMeasurements: () => void;
  addPickedColor: (c: PickedColor) => void;
  removePickedColor: (id: string) => void;
  clearPickedColors: () => void;
  addComment: (c: DesignComment) => void;
  updateComment: (id: string, patch: Partial<Omit<DesignComment, "id">>) => void;
  removeComment: (id: string) => void;
  resolveComment: (id: string) => void;
  clearComments: () => void;
}
