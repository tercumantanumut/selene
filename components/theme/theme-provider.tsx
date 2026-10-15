"use client";

import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { BackgroundConfig } from "@/lib/personalization/wallpapers";
import { getElectronAPI } from "@/lib/electron/types";
import { DEFAULT_UI_SCALE, normalizeUiScale, uiScaleToZoomFactor } from "@/lib/ui/ui-scale";
import { DEFAULT_THEME_PRESET, type ThemePresetId } from "@/lib/personalization/theme-presets";
import {
  DEFAULT_CHAT_WORKSPACE_MODE,
  isChatWorkspaceMode,
  type ChatWorkspaceMode,
} from "@/lib/chat/workspace-mode";

export type ThemePreference = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

const THEME_STORAGE_KEY = "selene-theme";
const PRESET_STORAGE_KEY = "selene-theme-preset";
const HOMEPAGE_BG_STORAGE_KEY = "selene-homepage-bg";
const CHAT_BG_STORAGE_KEY = "selene-chat-bg";
const CHAT_WORKSPACE_MODE_STORAGE_KEY = "selene-chat-workspace-mode";
const CHAT_REFRESH_DEBUG_STORAGE_KEY = "selene-debug-chat-refresh";
const APP_HEARTBEAT_INTERVAL_MS = 5000;

const shouldDebugThemeLifecycle = (): boolean => {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(CHAT_REFRESH_DEBUG_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
};

const debugThemeLifecycle = (event: string, details?: Record<string, unknown>): void => {
  if (!shouldDebugThemeLifecycle()) return;
  console.debug("[Selene][theme]", event, details ?? {});
};

const touchAppHeartbeat = (source: string): void => {
  if (typeof window === "undefined") return;
  const root = document.documentElement;
  (window as Window & { __seleneAppHeartbeat?: number }).__seleneAppHeartbeat = Date.now();
  root.dataset.seleneAppAlive = "1";
  debugThemeLifecycle("heartbeat", { source });
};


type ThemeContextValue = {
  theme: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemePreference) => void;
  uiScale: number;
  setUiScale: (scale: number) => void;
  themePreset: ThemePresetId;
  setThemePreset: (preset: ThemePresetId) => void;
  homepageBackground: BackgroundConfig;
  setHomepageBackground: (bg: BackgroundConfig) => void;
  chatBackground: BackgroundConfig;
  setChatBackground: (bg: BackgroundConfig) => void;
  chatWorkspaceMode: ChatWorkspaceMode;
  setChatWorkspaceMode: (mode: ChatWorkspaceMode) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

const isThemePreference = (value: string | null): value is ThemePreference =>
  value === "light" || value === "dark" || value === "system";

const getStoredTheme = (): ThemePreference | null => {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : null;
  } catch {
    return null;
  }
};

const getStoredPreset = (): ThemePresetId | null => {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(PRESET_STORAGE_KEY) as ThemePresetId | null;
  } catch {
    return null;
  }
};

const getStoredChatWorkspaceMode = (): ChatWorkspaceMode | null => {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(CHAT_WORKSPACE_MODE_STORAGE_KEY);
    return isChatWorkspaceMode(stored) ? stored : null;
  } catch {
    return null;
  }
};

function getStoredJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

const resolveTheme = (theme: ThemePreference): ResolvedTheme => {
  if (theme !== "system") return theme;
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

const applyTheme = (theme: ThemePreference): ResolvedTheme => {
  const resolved = resolveTheme(theme);
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
  root.dataset.theme = theme;
  debugThemeLifecycle("apply-theme", { theme, resolved });
  return resolved;
};

const applyPreset = (preset: ThemePresetId): void => {
  const root = document.documentElement;
  if (preset === "ember") {
    delete root.dataset.themePreset;
  } else {
    root.dataset.themePreset = preset;
  }
  debugThemeLifecycle("apply-preset", { preset });
};

const DEFAULT_BG: BackgroundConfig = { type: "none" };

export function ThemeProvider({
  initialTheme,
  initialUiScale = DEFAULT_UI_SCALE,
  initialChatWorkspaceMode = DEFAULT_CHAT_WORKSPACE_MODE,
  children,
}: {
  initialTheme: ThemePreference;
  initialUiScale?: number;
  initialChatWorkspaceMode?: ChatWorkspaceMode;
  children: ReactNode;
}) {
  const [theme, setTheme] = useState<ThemePreference>(initialTheme);
  const [uiScale, setUiScaleState] = useState(() => normalizeUiScale(initialUiScale));
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(initialTheme));
  const [themePreset, setThemePresetState] = useState<ThemePresetId>(DEFAULT_THEME_PRESET);
  const [homepageBackground, setHomepageBgState] = useState<BackgroundConfig>(DEFAULT_BG);
  const [chatBackground, setChatBgState] = useState<BackgroundConfig>(DEFAULT_BG);
  const [chatWorkspaceMode, setChatWorkspaceModeState] = useState<ChatWorkspaceMode>(initialChatWorkspaceMode);

  useEffect(() => {
    const stored = getStoredTheme();
    setTheme(stored ?? initialTheme);
    const storedPreset = getStoredPreset();
    if (storedPreset) setThemePresetState(storedPreset);
    setHomepageBgState(getStoredJson(HOMEPAGE_BG_STORAGE_KEY, DEFAULT_BG));
    setChatBgState(getStoredJson(CHAT_BG_STORAGE_KEY, DEFAULT_BG));
    setChatWorkspaceModeState(getStoredChatWorkspaceMode() ?? initialChatWorkspaceMode);
  }, [initialTheme, initialChatWorkspaceMode]);

  useEffect(() => {
    setResolvedTheme(applyTheme(theme));
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Ignore storage errors
    }
  }, [theme]);

  useEffect(() => {
    const normalizedScale = normalizeUiScale(uiScale);
    const zoomFactor = uiScaleToZoomFactor(normalizedScale);
    const root = document.documentElement;
    root.dataset.uiScale = String(normalizedScale);

    const electronAPI = getElectronAPI();
    if (electronAPI?.window.setZoomFactor) {
      // Electron's native page zoom scales the complete renderer, including
      // fixed layers and Radix portals. Avoid applying CSS zoom as well.
      root.style.setProperty("--ui-scale-factor", "1");
      void electronAPI.window.setZoomFactor(zoomFactor, false).catch((error) => {
        console.warn("[Theme] Failed to apply Electron UI scale:", error);
      });
      return;
    }

    // Browser fallback. Root-level zoom includes portaled overlays under body.
    root.style.setProperty("--ui-scale-factor", String(zoomFactor));
  }, [uiScale]);

  useEffect(() => {
    applyPreset(themePreset);
    try {
      window.localStorage.setItem(PRESET_STORAGE_KEY, themePreset);
    } catch {
      // Ignore
    }
  }, [themePreset]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(CHAT_WORKSPACE_MODE_STORAGE_KEY, chatWorkspaceMode);
    } catch {
      // Ignore
    }
  }, [chatWorkspaceMode]);

  useEffect(() => {
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => setResolvedTheme(applyTheme("system"));
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, [theme]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleFocus = () => touchAppHeartbeat("window-focus");
    const handleVisibility = () => {
      if (!document.hidden) {
        touchAppHeartbeat("visibility-visible");
      }
    };

    touchAppHeartbeat("mount");
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    const intervalId = window.setInterval(() => touchAppHeartbeat("interval"), APP_HEARTBEAT_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
      delete document.documentElement.dataset.seleneAppAlive;
    };
  }, []);

  const setUiScale = (scale: number) => {
    const normalizedScale = normalizeUiScale(scale);
    const electronAPI = getElectronAPI();
    if (electronAPI?.window.setZoomFactor) {
      void electronAPI.window
        .setZoomFactor(uiScaleToZoomFactor(normalizedScale), true)
        .catch((error) => {
          console.warn("[Theme] Failed to broadcast Electron UI scale:", error);
        });
    }
    setUiScaleState(normalizedScale);
  };

  const setThemePreset = (preset: ThemePresetId) => {
    setThemePresetState(preset);
  };

  const setHomepageBackground = (bg: BackgroundConfig) => {
    setHomepageBgState(bg);
    try {
      window.localStorage.setItem(HOMEPAGE_BG_STORAGE_KEY, JSON.stringify(bg));
    } catch {
      // Ignore
    }
  };

  const setChatBackground = (bg: BackgroundConfig) => {
    setChatBgState(bg);
    try {
      window.localStorage.setItem(CHAT_BG_STORAGE_KEY, JSON.stringify(bg));
    } catch {
      // Ignore
    }
  };

  const setChatWorkspaceMode = (mode: ChatWorkspaceMode) => {
    setChatWorkspaceModeState(mode);
  };

  const value = useMemo(
    () => ({
      theme,
      resolvedTheme,
      setTheme,
      uiScale,
      setUiScale,
      themePreset,
      setThemePreset,
      homepageBackground,
      setHomepageBackground,
      chatBackground,
      setChatBackground,
      chatWorkspaceMode,
      setChatWorkspaceMode,
    }),
    [theme, resolvedTheme, uiScale, themePreset, homepageBackground, chatBackground, chatWorkspaceMode]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
