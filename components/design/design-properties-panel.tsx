"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useDesignWorkspaceStore } from "@/lib/design/workspace/store";
import { useShallow } from "zustand/react/shallow";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Code,
  Trash2,
  Save,
  Loader2,
  Check,
  X,
  Copy,
  Crosshair,
  LayoutGrid,
  Settings2,
  PanelRightClose,
  PanelRightOpen,
  Ruler,
  Pipette,
  MessageSquare,
} from "lucide-react";
import type {
  Measurement,
  PickedColor,
  DesignComment,
} from "@/lib/design/workspace/types";
import { cn } from "@/lib/utils";
import {
  requestDesignWorkspaceSettings,
  requestSaveDesign,
  requestUpdateDesignWorkspaceSettings,
} from "./design-api-client";
import { GalleryContent } from "./design-gallery-content";

type RightPanelTab = "designs" | "details";

function formatTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function useActiveComponent() {
  const components = useDesignWorkspaceStore((s) => s.components);
  const activeComponentId = useDesignWorkspaceStore((s) => s.activeComponentId);
  return useMemo(
    () => components.find((c) => c.id === activeComponentId) ?? null,
    [components, activeComponentId],
  );
}

function ActiveDesignLabel() {
  const active = useActiveComponent();
  const componentCount = useDesignWorkspaceStore((s) => s.components.length);

  if (!active) {
    return (
      <div className="px-3 py-2.5 text-xs text-muted-foreground">
        No open designs yet
      </div>
    );
  }

  return (
    <div className="flex w-full items-center gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{active.name}</div>
        <div className="mt-0.5 flex items-center gap-1.5">
          <Badge variant="secondary" className="px-1 py-0 text-[11px]">
            {active.mode}
          </Badge>
          <Badge variant="outline" className="px-1 py-0 text-[11px]">
            {active.style}
          </Badge>
          <span className="text-[11px] text-muted-foreground">
            {formatTime(active.createdAt)}
          </span>
        </div>
      </div>
      {componentCount > 1 && (
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
          {componentCount}
        </span>
      )}
    </div>
  );
}

function MeasurementsSection({
  measurements,
  onRemove,
  onClear,
}: {
  measurements: Measurement[];
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/40 p-2.5">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          <Ruler className="h-3 w-3" />
          Measurements ({measurements.length})
        </label>
        <Button
          variant="ghost"
          size="sm"
          className="h-5 px-1.5 text-[11px]"
          onClick={onClear}
          aria-label="Clear all measurements"
        >
          Clear all
        </Button>
      </div>
      {measurements.map((m) => (
        <div key={m.id} className="space-y-1 rounded border border-border/50 bg-background/50 p-1.5 text-[11px]">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
              {m.from.selector} → {m.to.selector}
            </div>
            <button
              onClick={() => onRemove(m.id)}
              className="shrink-0 text-muted-foreground transition-colors hover:text-red-500"
              aria-label="Remove measurement"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-x-2 gap-y-0.5">
            <div className="flex justify-between">
              <span className="text-muted-foreground">dx</span>
              <span className="font-mono">{Math.round(m.distances.dx)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">dy</span>
              <span className="font-mono">{Math.round(m.distances.dy)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">d</span>
              <span className="font-mono">{Math.round(m.distances.euclidean)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">h</span>
              <span className="font-mono">{Math.round(m.distances.horizontal)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">v</span>
              <span className="font-mono">{Math.round(m.distances.vertical)}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function PickedColorsSection({
  colors,
  onRemove,
  onClear,
}: {
  colors: PickedColor[];
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = useCallback(async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((current) => (current === key ? null : current)), 1200);
    } catch {
      // ignore
    }
  }, []);

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/40 p-2.5">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          <Pipette className="h-3 w-3" />
          Picked colors ({colors.length})
        </label>
        <Button
          variant="ghost"
          size="sm"
          className="h-5 px-1.5 text-[11px]"
          onClick={onClear}
          aria-label="Clear all picked colors"
        >
          Clear all
        </Button>
      </div>
      {colors.map((c) => {
        const rgbStr = `rgba(${c.rgb.r}, ${c.rgb.g}, ${c.rgb.b}, ${c.rgb.a})`;
        const hslStr = `hsla(${c.hsl.h}, ${c.hsl.s}%, ${c.hsl.l}%, ${c.hsl.a})`;
        return (
          <div key={c.id} className="space-y-1 rounded border border-border/50 bg-background/50 p-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span
                  className="h-5 w-5 shrink-0 rounded border border-border"
                  style={{ backgroundColor: c.hex }}
                  aria-label={`Swatch ${c.hex}`}
                />
                <Badge variant="outline" className="px-1 py-0 text-[10px]">
                  {c.source}
                </Badge>
              </div>
              <button
                onClick={() => onRemove(c.id)}
                className="text-muted-foreground transition-colors hover:text-red-500"
                aria-label="Remove picked color"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            <div className="grid grid-cols-[auto,1fr,auto] items-center gap-x-1.5 gap-y-0.5 text-[11px]">
              <span className="text-muted-foreground">hex</span>
              <span className="truncate font-mono">{c.hex}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 w-5 p-0"
                aria-label="Copy hex"
                onClick={() => void copy(`${c.id}-hex`, c.hex)}
              >
                {copied === `${c.id}-hex` ? (
                  <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </Button>
              <span className="text-muted-foreground">rgb</span>
              <span className="truncate font-mono">{rgbStr}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 w-5 p-0"
                aria-label="Copy rgb"
                onClick={() => void copy(`${c.id}-rgb`, rgbStr)}
              >
                {copied === `${c.id}-rgb` ? (
                  <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </Button>
              <span className="text-muted-foreground">hsl</span>
              <span className="truncate font-mono">{hslStr}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 w-5 p-0"
                aria-label="Copy hsl"
                onClick={() => void copy(`${c.id}-hsl`, hslStr)}
              >
                {copied === `${c.id}-hsl` ? (
                  <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CommentsSection({
  comments,
  onRemove,
  onResolve,
  onClear,
}: {
  comments: DesignComment[];
  onRemove: (id: string) => void;
  onResolve: (id: string) => void;
  onClear: () => void;
}) {
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/40 p-2.5">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          <MessageSquare className="h-3 w-3" />
          Comments ({comments.length})
        </label>
        <Button
          variant="ghost"
          size="sm"
          className="h-5 px-1.5 text-[11px]"
          onClick={onClear}
          aria-label="Clear all comments"
        >
          Clear all
        </Button>
      </div>
      {comments.map((c, idx) => (
        <div
          key={c.id}
          className={cn(
            "space-y-1 rounded border border-border/50 bg-background/50 p-1.5 text-[11px]",
            c.resolved && "opacity-60",
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-[10px] font-semibold text-white">
                {idx + 1}
              </span>
              {c.resolved && (
                <Badge variant="outline" className="px-1 py-0 text-[10px]">
                  resolved
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-[10px]"
                onClick={() => onResolve(c.id)}
                aria-label={c.resolved ? "Reopen comment" : "Resolve comment"}
              >
                {c.resolved ? "Reopen" : "Resolve"}
              </Button>
              <button
                onClick={() => onRemove(c.id)}
                className="text-muted-foreground transition-colors hover:text-red-500"
                aria-label="Remove comment"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </div>
          <div className={cn("whitespace-pre-wrap", c.resolved && "line-through")}>{c.text}</div>
          <div className="truncate font-mono text-[10px] text-muted-foreground">{c.elementSelector}</div>
        </div>
      ))}
    </div>
  );
}

function DetailsContent() {
  const {
    updateComponent,
    removeComponent,
    showCode,
    toggleCode,
    selectedElements,
    removeSelectedElement,
    clearSelectedElements,
    config,
    updateConfig,
    lastValidation,
    lastCompileReport,
    history: workspaceHistory,
    setConfig,
    sessionId,
    measurements,
    removeMeasurement,
    clearMeasurements,
    pickedColors,
    removePickedColor,
    clearPickedColors,
    comments,
    removeComment,
    resolveComment,
    clearComments,
  } = useDesignWorkspaceStore(
    useShallow((s) => ({
      updateComponent: s.updateComponent,
      removeComponent: s.removeComponent,
      showCode: s.showCode,
      toggleCode: s.toggleCode,
      selectedElements: s.selectedElements,
      removeSelectedElement: s.removeSelectedElement,
      clearSelectedElements: s.clearSelectedElements,
      config: s.config,
      updateConfig: s.updateConfig,
      lastValidation: s.lastValidation,
      lastCompileReport: s.lastCompileReport,
      history: s.history,
      setConfig: s.setConfig,
      sessionId: s.sessionId,
      measurements: s.measurements,
      removeMeasurement: s.removeMeasurement,
      clearMeasurements: s.clearMeasurements,
      pickedColors: s.pickedColors,
      removePickedColor: s.removePickedColor,
      clearPickedColors: s.clearPickedColors,
      comments: s.comments,
      removeComment: s.removeComment,
      resolveComment: s.resolveComment,
      clearComments: s.clearComments,
    })),
  );

  const component = useActiveComponent();

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const [nameValue, setNameValue] = useState("");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const timeoutIds = useRef<ReturnType<typeof setTimeout>[]>([]);
  const nameDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    requestDesignWorkspaceSettings().then((result) => {
      if (!cancelled && result.success && result.data) {
        setConfig(result.data);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [setConfig]);

  useEffect(() => {
    if (component) setNameValue(component.name);
  }, [component?.id, component?.name]);

  useEffect(() => {
    setSaved(false);
    setCopySuccess(false);
    setConfirmDelete(false);
    for (const id of timeoutIds.current) clearTimeout(id);
    timeoutIds.current = [];
  }, [component?.id]);

  useEffect(() => {
    return () => {
      for (const id of timeoutIds.current) clearTimeout(id);
      clearTimeout(nameDebounceRef.current);
      clearTimeout(deleteTimerRef.current);
    };
  }, []);

  const handleSaveDesign = useCallback(async () => {
    if (!component || saving) return;
    setSaving(true);
    setSaved(false);
    try {
      const result = await requestSaveDesign({
        name: component.name,
        code: component.code,
        mode: component.mode,
        style: component.style,
        prompt: component.prompt,
        sessionId: sessionId || undefined,
      });
      if (result.success) {
        setSaved(true);
        const id = setTimeout(() => setSaved(false), 2000);
        timeoutIds.current.push(id);
      }
    } catch (err) {
      console.warn("[design-properties] Save design failed:", err);
    } finally {
      setSaving(false);
    }
  }, [component, saving, sessionId]);

  const handleCopyCode = useCallback(async () => {
    if (!component) return;
    try {
      await navigator.clipboard.writeText(component.code);
      setCopySuccess(true);
      const id = setTimeout(() => setCopySuccess(false), 1500);
      timeoutIds.current.push(id);
    } catch {
      // Clipboard API may be unavailable.
    }
  }, [component]);

  const handleWorkspaceSettingChange = useCallback(async <K extends keyof typeof config>(key: K, value: (typeof config)[K]) => {
    updateConfig({ [key]: value });
    setSettingsSaving(true);
    const result = await requestUpdateDesignWorkspaceSettings({ [key]: value });
    setSettingsSaving(false);
    setSettingsMessage(result.success ? "Workspace settings saved." : result.error || "Failed to save workspace settings.");
    const id = setTimeout(() => setSettingsMessage(null), 2000);
    timeoutIds.current.push(id);
  }, [config, updateConfig]);

  if (!component) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-xs text-muted-foreground">
        Select a design to inspect details
      </div>
    );
  }

  function handleNameChange(value: string) {
    setNameValue(value);
    clearTimeout(nameDebounceRef.current);
    nameDebounceRef.current = setTimeout(() => {
      if (component) updateComponent(component.id, { name: value });
    }, 300);
  }

  function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      clearTimeout(deleteTimerRef.current);
      deleteTimerRef.current = setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    if (component) {
      removeComponent(component.id);
    }
    setConfirmDelete(false);
  }

  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-3">
        {selectedElements.length > 0 && (
          <div className="space-y-2 rounded-md border border-border bg-muted/40 p-2.5">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                <Crosshair className="h-3 w-3" />
                {selectedElements.length === 1 ? "Selected Element" : `Selected Elements (${selectedElements.length})`}
              </label>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-[11px]"
                onClick={clearSelectedElements}
                aria-label="Deselect all elements"
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
            {selectedElements.map((el) => (
              <div key={el.selector} className="space-y-1 rounded border border-border/50 bg-background/50 p-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-baseline gap-1 text-[11px]">
                    <span className="font-medium">&lt;{el.tagName}&gt;</span>
                    {el.id && (
                      <span className="text-blue-600 dark:text-blue-400">#{el.id}</span>
                    )}
                  </div>
                  {selectedElements.length > 1 && (
                    <button
                      onClick={() => removeSelectedElement(el.selector)}
                      className="text-muted-foreground hover:text-red-500 transition-colors"
                      aria-label={`Remove ${el.tagName} from selection`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
                {el.className && (
                  <div className="flex flex-wrap gap-0.5">
                    {el.className
                      .trim()
                      .split(/\s+/)
                      .slice(0, 6)
                      .map((cls, i) => (
                        <Badge key={i} variant="secondary" className="px-1 py-0 text-[11px]">
                          .{cls}
                        </Badge>
                      ))}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[11px]">
                  {(["width", "height", "padding", "margin"] as const).map((prop) => (
                    <div key={prop} className="flex justify-between">
                      <span className="text-muted-foreground capitalize">{prop}</span>
                      <span className="font-mono">{el.computedStyles[prop]}</span>
                    </div>
                  ))}
                </div>
                <pre className="overflow-auto rounded bg-muted p-1 font-mono text-[11px] text-foreground">
                  {el.selector}
                </pre>
              </div>
            ))}
          </div>
        )}

        {measurements.length > 0 && (
          <MeasurementsSection
            measurements={measurements}
            onRemove={removeMeasurement}
            onClear={clearMeasurements}
          />
        )}

        {pickedColors.length > 0 && (
          <PickedColorsSection
            colors={pickedColors}
            onRemove={removePickedColor}
            onClear={clearPickedColors}
          />
        )}

        {comments.length > 0 && (
          <CommentsSection
            comments={comments}
            onRemove={removeComment}
            onResolve={resolveComment}
            onClear={clearComments}
          />
        )}

        <div className="space-y-1">
          <label
            htmlFor="component-name"
            className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
          >
            Name
          </label>
          <Input
            id="component-name"
            value={nameValue}
            onChange={(e) => handleNameChange(e.target.value)}
            className="h-7 text-xs"
          />
        </div>

        <div className="flex items-center gap-1.5">
          <Badge variant="secondary" className="px-1.5 py-0 text-[11px]">
            Tailwind
          </Badge>
          <Badge variant="outline" className="px-1.5 py-0 text-[11px]">
            {component.style}
          </Badge>
        </div>

        <div className="space-y-1">
          <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Prompt
          </label>
          <p className="line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">
            {component.prompt || "No prompt recorded"}
          </p>
        </div>

        <div className="space-y-1">
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={toggleCode}
              className="h-7 flex-1 gap-1.5 text-xs"
            >
              <Code className="h-3.5 w-3.5" />
              {showCode ? "Hide" : "Code"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyCode}
              className="h-7 w-7 p-0"
              aria-label="Copy code"
            >
              {copySuccess ? (
                <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </Button>
          </div>
          {showCode && (
            <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px]">
              {component.code}
            </pre>
          )}
        </div>

        <div className="flex gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-7 flex-1 gap-1.5 text-xs"
            onClick={handleSaveDesign}
            disabled={saving}
          >
            {saving ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : saved ? (
              <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <Save className="h-3 w-3" />
            )}
            {saved ? "Saved" : "Save"}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="h-7 gap-1.5 px-2.5 text-xs"
            onClick={handleDelete}
          >
            <Trash2 className="h-3 w-3" />
            {confirmDelete ? "Confirm" : "Delete"}
          </Button>
        </div>

        <div className="space-y-2 rounded-md border border-border bg-muted/30 p-2.5">
          <div className="flex items-center justify-between">
            <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Workspace Settings
            </label>
            {settingsSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin text-terminal-muted" /> : null}
          </div>
          <div className="grid gap-2 text-[11px]">
            <label className="flex items-center justify-between gap-3 rounded border border-border bg-background/70 px-2 py-1.5">
              <span>Hook preset</span>
              <select
                value={config.postEditHooksPreset}
                onChange={(e) => void handleWorkspaceSettingChange("postEditHooksPreset", e.target.value as typeof config.postEditHooksPreset)}
                className="rounded border border-border bg-background px-2 py-1 text-[11px]"
              >
                <option value="off">off</option>
                <option value="fast">fast</option>
                <option value="strict">strict</option>
              </select>
            </label>
            <label className="flex items-center justify-between gap-3 rounded border border-border bg-background/70 px-2 py-1.5">
              <span>Strict typecheck</span>
              <input
                type="checkbox"
                checked={config.typecheckStrictMode}
                onChange={(e) => void handleWorkspaceSettingChange("typecheckStrictMode", e.target.checked)}
                className="size-4 accent-terminal-green"
              />
            </label>
            <label className="flex items-center justify-between gap-3 rounded border border-border bg-background/70 px-2 py-1.5">
              <span>JSX validation</span>
              <input
                type="checkbox"
                checked={config.jsxValidationEnabled}
                onChange={(e) => void handleWorkspaceSettingChange("jsxValidationEnabled", e.target.checked)}
                className="size-4 accent-terminal-green"
              />
            </label>
            <label className="flex items-center justify-between gap-3 rounded border border-border bg-background/70 px-2 py-1.5">
              <span>Import validation</span>
              <input
                type="checkbox"
                checked={config.postEditImportValidationEnabled}
                onChange={(e) => void handleWorkspaceSettingChange("postEditImportValidationEnabled", e.target.checked)}
                className="size-4 accent-terminal-green"
              />
            </label>
            <label className="flex items-center justify-between gap-3 rounded border border-border bg-background/70 px-2 py-1.5">
              <span>Strict preview check</span>
              <input
                type="checkbox"
                checked={config.postEditPreviewEnabled}
                onChange={(e) => void handleWorkspaceSettingChange("postEditPreviewEnabled", e.target.checked)}
                className="size-4 accent-terminal-green"
              />
            </label>
          </div>
          {settingsMessage ? <div className="text-[11px] text-muted-foreground">{settingsMessage}</div> : null}
        </div>

        {(lastValidation || lastCompileReport || workspaceHistory) && (
          <div className="space-y-2 rounded-md border border-border bg-muted/30 p-2.5 text-[11px]">
            <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Workspace Diagnostics
            </label>
            {lastValidation ? (
              <div>
                <div className="font-medium">Post-edit checks: {lastValidation.passed ? "passed" : "issues found"}</div>
                <div className="text-muted-foreground">{lastValidation.checks?.length ?? 0} checks</div>
              </div>
            ) : null}
            {lastCompileReport ? (
              <div>
                <div className="font-medium">Last compile: {(lastCompileReport.errors?.length ?? 0) === 0 ? "ok" : "failed"}</div>
                {(lastCompileReport.dependencyCheck?.missingPackages?.length ?? 0) > 0 ? (
                  <div className="text-red-600">Missing packages: {lastCompileReport.dependencyCheck!.missingPackages.join(", ")}</div>
                ) : null}
              </div>
            ) : null}
            {workspaceHistory?.actions?.length ? (
              <div className="text-muted-foreground">Session history: {workspaceHistory.actions.length} actions</div>
            ) : null}
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

const TABS: { id: RightPanelTab; icon: typeof LayoutGrid; label: string }[] = [
  { id: "designs", icon: LayoutGrid, label: "Designs" },
  { id: "details", icon: Settings2, label: "Details" },
];

export function DesignPropertiesPanel() {
  const [activeTab, setActiveTab] = useState<RightPanelTab>("designs");
  const [collapsed, setCollapsed] = useState(false);

  function handleTabKeyDown(e: React.KeyboardEvent, index: number) {
    let nextIndex = index;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      nextIndex = (index + 1) % TABS.length;
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      nextIndex = (index - 1 + TABS.length) % TABS.length;
    } else if (e.key === "Home") {
      e.preventDefault();
      nextIndex = 0;
    } else if (e.key === "End") {
      e.preventDefault();
      nextIndex = TABS.length - 1;
    } else {
      return;
    }
    setActiveTab(TABS[nextIndex].id);
    const tablist = (e.currentTarget as HTMLElement).parentElement;
    const buttons = tablist?.querySelectorAll<HTMLButtonElement>("[role='tab']");
    buttons?.[nextIndex]?.focus();
  }

  if (collapsed) {
    return (
      <div className="flex h-full w-10 flex-col items-center border-l border-border bg-background py-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={() => setCollapsed(false)}
          aria-label="Expand panel"
        >
          <PanelRightOpen className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full w-80 flex-col border-l border-border">
      <div className="flex items-center border-b border-border">
        <div className="flex-1">
          <ActiveDesignLabel />
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="mr-1 h-7 w-7 shrink-0 p-0"
          onClick={() => setCollapsed(true)}
          aria-label="Collapse panel"
        >
          <PanelRightClose className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex border-b border-border" role="tablist" aria-label="Panel sections">
        {TABS.map(({ id, icon: Icon, label }, index) => (
          <button
            key={id}
            role="tab"
            id={`panel-tab-${id}`}
            aria-selected={activeTab === id}
            aria-controls={`panel-tabpanel-${id}`}
            tabIndex={activeTab === id ? 0 : -1}
            onClick={() => setActiveTab(id)}
            onKeyDown={(e) => handleTabKeyDown(e, index)}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 py-2 text-[11px] font-medium transition-colors",
              activeTab === id
                ? "border-b-2 border-primary text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      <div
        className="flex-1 overflow-hidden"
        role="tabpanel"
        id={`panel-tabpanel-${activeTab}`}
        aria-labelledby={`panel-tab-${activeTab}`}
      >
        {activeTab === "designs" && <GalleryContent />}
        {activeTab === "details" && <DetailsContent />}
      </div>
    </div>
  );
}
