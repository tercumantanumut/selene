"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { X, Keyboard } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

const MODIFIER_MAP: Record<string, string> = {
  CommandOrControl: isMac ? "⌘" : "Ctrl",
  Command: isMac ? "⌘" : "Cmd",
  Control: isMac ? "⌃" : "Ctrl",
  Alt: isMac ? "⌥" : "Alt",
  Shift: isMac ? "⇧" : "Shift",
};

const KEY_DISPLAY: Record<string, string> = {
  Return: "Enter", Enter: "↵", Backspace: "⌫", Delete: "⌦", Tab: "⇥",
  Space: "Space", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  Escape: "Esc",
};

function acceleratorToDisplayKeys(accelerator: string): string[] {
  if (!accelerator) return [];
  return accelerator.split("+").map((part) => {
    if (MODIFIER_MAP[part]) return MODIFIER_MAP[part];
    if (KEY_DISPLAY[part]) return KEY_DISPLAY[part];
    return part;
  });
}

function keysToAccelerator(e: KeyboardEvent): string | null {
  const modifierKeys = new Set(["Control", "Meta", "Alt", "Shift"]);
  if (modifierKeys.has(e.key) || e.key === "Escape") return null;

  const parts: string[] = [];
  if (e.ctrlKey && e.metaKey) {
    parts.push("CommandOrControl");
  } else if (e.metaKey) {
    // On Mac, Cmd maps to CommandOrControl. On Windows/Linux, Meta/Super key
    parts.push(isMac ? "CommandOrControl" : "Super");
  } else if (e.ctrlKey) {
    parts.push("CommandOrControl");
  }
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");

  // Require at least one modifier — bare keys would intercept all typing globally
  if (parts.length === 0) return null;

  const specialKeys: Record<string, string> = {
    Enter: "Return", Backspace: "Backspace", Delete: "Delete", Tab: "Tab",
    " ": "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  };
  for (let i = 1; i <= 12; i++) specialKeys[`F${i}`] = `F${i}`;

  const mainKey = specialKeys[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  if (!mainKey) return null;

  parts.push(mainKey);
  return parts.join("+");
}

interface ShortcutRecorderProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export function ShortcutRecorder({
  id,
  value,
  onChange,
  placeholder,
  disabled = false,
  className,
}: ShortcutRecorderProps) {
  const t = useTranslations("settings.shortcutRecorder");
  const resolvedPlaceholder = placeholder ?? t("placeholder");
  const [recording, setRecording] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const stopRecording = useCallback(() => setRecording(false), []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { stopRecording(); return; }
      const accelerator = keysToAccelerator(e);
      if (accelerator) { onChange(accelerator); stopRecording(); }
    },
    [onChange, stopRecording]
  );

  useEffect(() => {
    if (!recording) return;
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [recording, handleKeyDown]);

  useEffect(() => {
    if (!recording) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        stopRecording();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [recording, stopRecording]);

  const displayKeys = acceleratorToDisplayKeys(value);

  return (
    <div
      ref={containerRef}
      id={id}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={recording ? t("ariaRecording") : t("ariaShortcut", { value: value || t("none") })}
      aria-pressed={recording}
      onClick={() => !disabled && setRecording(true)}
      onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !disabled) setRecording(true); }}
      className={cn(
        "flex h-9 w-full items-center gap-1.5 rounded-md px-3 py-1 text-sm",
        "bg-muted/30 transition-all duration-200 ease-out",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20",
        recording && "ring-2 ring-primary/40 bg-muted/50",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-muted/40",
        className
      )}
    >
      {recording ? (
        <span className="text-muted-foreground text-xs italic flex-1">{t("pressShortcut")}</span>
      ) : displayKeys.length > 0 ? (
        <span className="flex flex-1 flex-wrap items-center gap-1">
          {displayKeys.map((key, i) => (
            <kbd key={i} className="bg-muted rounded px-1.5 py-0.5 text-xs font-mono leading-none">
              {key}
            </kbd>
          ))}
        </span>
      ) : (
        <span className="flex flex-1 items-center gap-1.5 text-muted-foreground text-xs">
          <Keyboard className="h-3.5 w-3.5 shrink-0" />
          {resolvedPlaceholder}
        </span>
      )}

      {value && !recording && !disabled && (
        <button
          type="button"
          aria-label={t("clearShortcut")}
          onClick={(e) => { e.stopPropagation(); onChange(""); }}
          className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
