"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations, useLocale } from "next-intl";
import { toast } from "sonner";
import { locales, type Locale } from "@/i18n/config";
import { useTheme } from "@/components/theme/theme-provider";
import { THEME_PRESETS } from "@/lib/personalization/theme-presets";
import { WALLPAPERS, WALLPAPER_CATEGORIES, type BackgroundConfig } from "@/lib/personalization/wallpapers";
import { VIDEO_WALLPAPERS, VIDEO_WALLPAPER_CATEGORIES, getVideoWallpaperById } from "@/lib/personalization/video-wallpapers";
import { Check, X, Image as ImageIcon, Play, Globe } from "lucide-react";
import type { FormState } from "./settings-types";

interface PreferencesSectionProps {
  formState: FormState;
  updateField: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
}

function CategoryFilterBar({
  categories,
  selected,
  allLabel,
  onSelect,
}: {
  categories: Array<{ id: string; label: string }>;
  selected: string;
  allLabel: string;
  onSelect: (id: string) => void;
}) {
  const pillClass = (active: boolean) =>
    `rounded-full px-2.5 py-0.5 font-mono text-[10px] transition-all ${
      active
        ? "bg-terminal-dark text-terminal-cream"
        : "bg-terminal-cream/60 text-terminal-muted hover:text-terminal-dark"
    }`;
  return (
    <div className="flex flex-wrap gap-1">
      <button type="button" onClick={() => onSelect("all")} className={pillClass(selected === "all")}>
        {allLabel}
      </button>
      {categories.map((cat) => (
        <button key={cat.id} type="button" onClick={() => onSelect(cat.id)} className={pillClass(selected === cat.id)}>
          {cat.label}
        </button>
      ))}
    </div>
  );
}

function NoneOptionButton({
  isActive,
  label,
  onClick,
}: {
  isActive: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative flex h-16 items-center justify-center rounded-lg border transition-all ${
        isActive
          ? "border-terminal-green bg-terminal-green/10"
          : "border-terminal-border hover:border-terminal-green/40"
      }`}
    >
      <span className="font-mono text-[10px] text-terminal-muted">{label}</span>
      {isActive && (
        <div className="absolute -right-1 -top-1">
          <div className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-terminal-green text-white">
            <Check className="h-2 w-2" />
          </div>
        </div>
      )}
    </button>
  );
}

export function PreferencesSection({ formState, updateField }: PreferencesSectionProps) {
  const t = useTranslations("settings");
  const router = useRouter();
  const currentLocale = useLocale() as Locale;
  const { themePreset, setThemePreset, homepageBackground, setHomepageBackground, chatBackground, setChatBackground } = useTheme();
  const [bgTab, setBgTab] = useState<"homepage" | "chat">("homepage");
  const [bgMediaType, setBgMediaType] = useState<"images" | "videos">("images");
  const [wallpaperCategory, setWallpaperCategory] = useState<string>("all");
  const [videoCategory, setVideoCategory] = useState<string>("all");
  const [isLocaleSwitching, startLocaleTransition] = useTransition();

  const handleLocaleChange = (newLocale: Locale) => {
    if (newLocale === currentLocale) return;
    startLocaleTransition(async () => {
      // Surface failures to the user via a toast — silently swallowing the
      // error left the radio visually reverted with no explanation, which
      // looks like the click "did nothing." Use sonner (the app-wide toast
      // system) rather than window.alert, which is too harsh for Electron.
      // The `t()` key is defined on both en.json and tr.json under
      // `settings.preferences.language`.
      const errorMessage = t("preferences.language.updateError");
      try {
        const response = await fetch("/api/locale", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ locale: newLocale }),
          // Same-origin + no-cache so the Set-Cookie header is applied immediately.
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) {
          console.error("[locale] Failed to update locale", await response.text());
          toast.error(errorMessage);
          return;
        }
        // Re-render server components with the new locale — no full page reload,
        // which avoids Electron/Chrome protocol-upgrade edge cases.
        router.refresh();
      } catch (error) {
        console.error("[locale] Network error while updating locale", error);
        toast.error(errorMessage);
      }
    });
  };

  const activeBg = bgTab === "homepage" ? homepageBackground : chatBackground;
  const setActiveBg = bgTab === "homepage" ? setHomepageBackground : setChatBackground;

  const filteredWallpapers = wallpaperCategory === "all"
    ? WALLPAPERS
    : WALLPAPERS.filter((w) => w.category === wallpaperCategory);

  const filteredVideos = videoCategory === "all"
    ? VIDEO_WALLPAPERS
    : VIDEO_WALLPAPERS.filter((v) => v.category === videoCategory);

  const handleSelectWallpaper = (wallpaperId: string, url: string) => {
    setActiveBg({ type: "wallpaper", wallpaperId, url, opacity: 30, blur: 0 });
  };

  const handleSelectVideo = (videoId: string) => {
    setActiveBg({ type: "video", videoId, opacity: 30, blur: 0 });
  };

  const handleClearBackground = () => {
    setActiveBg({ type: "none" });
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-mono text-lg font-semibold text-terminal-dark">{t("preferences.title")}</h2>
        <p className="mt-1 font-mono text-sm text-terminal-muted">
          {t("preferences.description")}
        </p>
      </div>

      <div>
        <label className="mb-2 block font-mono text-sm text-terminal-muted">{t("preferences.theme.label")}</label>
        <div className="space-y-3">
          {(["dark", "light", "system"] as const).map((theme) => (
            <label key={theme} className="flex items-center gap-3">
              <input
                type="radio"
                name="theme"
                value={theme}
                checked={formState.theme === theme}
                onChange={(e) => updateField("theme", e.target.value as "dark" | "light" | "system")}
                className="size-4 accent-terminal-green"
              />
              <span className="font-mono capitalize text-terminal-dark">{t(`preferences.theme.${theme}`)}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Theme Palette Presets */}
      <div className="space-y-3 rounded border border-terminal-border bg-terminal-cream/30 p-4">
        <div>
          <h3 className="font-mono text-base font-semibold text-terminal-dark">{t("preferences.colorPalette.heading")}</h3>
          <p className="mt-1 font-mono text-xs text-terminal-muted">
            {t("preferences.colorPalette.description")}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {THEME_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => setThemePreset(preset.id)}
              className={`group/preset relative flex flex-col items-center gap-1.5 rounded-lg border p-3 transition-all ${
                themePreset === preset.id
                  ? "border-terminal-green bg-terminal-green/10 shadow-sm"
                  : "border-terminal-border hover:border-terminal-green/40 hover:bg-terminal-cream/50"
              }`}
            >
              <div className="flex gap-1">
                {preset.swatches.map((color, i) => (
                  <div
                    key={i}
                    className="h-5 w-5 rounded-full border border-black/10 shadow-sm"
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
              <span className="font-mono text-[11px] font-medium text-terminal-dark">{preset.label}</span>
              {themePreset === preset.id && (
                <div className="absolute -right-1 -top-1">
                  <div className="flex h-4 w-4 items-center justify-center rounded-full bg-terminal-green text-white">
                    <Check className="h-2.5 w-2.5" />
                  </div>
                </div>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Background Wallpapers */}
      <div className="space-y-3 rounded border border-terminal-border bg-terminal-cream/30 p-4">
        <div>
          <h3 className="font-mono text-base font-semibold text-terminal-dark">{t("preferences.backgrounds.heading")}</h3>
          <p className="mt-1 font-mono text-xs text-terminal-muted">
            {t("preferences.backgrounds.description")}
          </p>
        </div>

        {/* Tab selector */}
        <div className="flex gap-1 rounded-lg bg-terminal-cream/60 p-1" role="tablist">
          {(["homepage", "chat"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={bgTab === tab}
              onClick={() => setBgTab(tab)}
              className={`flex-1 rounded-md px-3 py-1.5 font-mono text-xs font-medium transition-all ${
                bgTab === tab
                  ? "bg-terminal-dark text-terminal-cream shadow-sm"
                  : "text-terminal-muted hover:text-terminal-dark"
              }`}
            >
              {t(`preferences.backgrounds.${tab}`)}
            </button>
          ))}
        </div>

        {/* Current background preview */}
        {activeBg.type !== "none" && (
          <div className="relative overflow-hidden rounded-lg border border-terminal-border">
            <div className="h-20 w-full bg-terminal-cream" style={(() => {
              if (activeBg.type === "video" && activeBg.videoId) {
                const vid = getVideoWallpaperById(activeBg.videoId);
                return vid ? {
                  backgroundImage: `url(${vid.posterUrl})`,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                  opacity: (activeBg.opacity ?? 30) / 100,
                  filter: activeBg.blur ? `blur(${activeBg.blur}px)` : undefined,
                } : undefined;
              }
              if (activeBg.url) return {
                backgroundImage: `url(${activeBg.url})`,
                backgroundSize: "cover",
                backgroundPosition: "center",
                opacity: (activeBg.opacity ?? 30) / 100,
                filter: activeBg.blur ? `blur(${activeBg.blur}px)` : undefined,
              };
              if (activeBg.color) return { backgroundColor: activeBg.color };
              return undefined;
            })()} />
            <button
              type="button"
              onClick={handleClearBackground}
              aria-label={t("preferences.backgrounds.clearBackground")}
              className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70"
            >
              <X className="h-3 w-3" />
            </button>
            <div className="absolute bottom-2 left-2 flex items-center gap-1.5">
              {activeBg.type === "video" ? (
                <Play className="h-3 w-3 text-white/80" />
              ) : (
                <ImageIcon className="h-3 w-3 text-white/80" />
              )}
              <span className="font-mono text-[10px] text-white/80">
                {activeBg.type === "wallpaper" ? t("preferences.backgrounds.wallpaper") : activeBg.type === "video" ? t("preferences.backgrounds.videoLabel") : activeBg.type === "color" ? t("preferences.backgrounds.color") : t("preferences.backgrounds.customUrl")}
              </span>
            </div>
          </div>
        )}

        {/* Opacity slider */}
        {activeBg.type !== "none" && (
          <div className="flex items-center gap-3">
            <label htmlFor="bg-opacity-slider" className="font-mono text-xs text-terminal-muted whitespace-nowrap">{t("preferences.backgrounds.opacity")}</label>
            <input
              id="bg-opacity-slider"
              type="range"
              min={5}
              max={100}
              value={activeBg.opacity ?? 30}
              onChange={(e) => setActiveBg({ ...activeBg, opacity: Number(e.target.value) })}
              className="flex-1 accent-terminal-green"
            />
            <span className="w-8 text-right font-mono text-xs text-terminal-muted">{activeBg.opacity ?? 30}%</span>
          </div>
        )}

        {/* Media type toggle (Images / Videos) */}
        <div className="flex gap-1 rounded-lg bg-terminal-cream/60 p-1" role="tablist">
          {(["images", "videos"] as const).map((type) => (
            <button
              key={type}
              type="button"
              role="tab"
              aria-selected={bgMediaType === type}
              onClick={() => setBgMediaType(type)}
              className={`flex-1 rounded-md px-3 py-1.5 font-mono text-xs font-medium transition-all ${
                bgMediaType === type
                  ? "bg-terminal-dark text-terminal-cream shadow-sm"
                  : "text-terminal-muted hover:text-terminal-dark"
              }`}
            >
              {type === "images" ? t("preferences.backgrounds.images") : t("preferences.backgrounds.videos")}
            </button>
          ))}
        </div>

        {bgMediaType === "images" ? (
          <>
            {/* Image category filter */}
            <CategoryFilterBar
              categories={WALLPAPER_CATEGORIES}
              selected={wallpaperCategory}
              allLabel={t("preferences.backgrounds.all")}
              onSelect={setWallpaperCategory}
            />

            {/* Wallpaper grid */}
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {/* None option */}
              <NoneOptionButton
                isActive={activeBg.type === "none"}
                label={t("preferences.backgrounds.none")}
                onClick={handleClearBackground}
              />
              {filteredWallpapers.map((wp) => (
                <button
                  key={wp.id}
                  type="button"
                  onClick={() => handleSelectWallpaper(wp.id, wp.url)}
                  className={`relative h-16 overflow-hidden rounded-lg border transition-all ${
                    activeBg.wallpaperId === wp.id
                      ? "border-terminal-green ring-1 ring-terminal-green"
                      : "border-terminal-border hover:border-terminal-green/40"
                  }`}
                >
                  <img
                    src={wp.thumbnailUrl}
                    alt={wp.label}
                    loading="lazy"
                    className="h-full w-full object-cover"
                    style={{ backgroundColor: wp.dominantColor }}
                  />
                  {activeBg.wallpaperId === wp.id && (
                    <div className="absolute -right-0.5 -top-0.5">
                      <div className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-terminal-green text-white">
                        <Check className="h-2 w-2" />
                      </div>
                    </div>
                  )}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            {/* Video category filter */}
            <CategoryFilterBar
              categories={VIDEO_WALLPAPER_CATEGORIES}
              selected={videoCategory}
              allLabel={t("preferences.backgrounds.all")}
              onSelect={setVideoCategory}
            />

            {/* Video wallpaper grid */}
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {/* None option */}
              <NoneOptionButton
                isActive={activeBg.type === "none"}
                label={t("preferences.backgrounds.none")}
                onClick={handleClearBackground}
              />
              {filteredVideos.map((vid) => (
                <button
                  key={vid.id}
                  type="button"
                  onClick={() => handleSelectVideo(vid.id)}
                  className={`group relative h-16 overflow-hidden rounded-lg border transition-all ${
                    activeBg.videoId === vid.id
                      ? "border-terminal-green ring-1 ring-terminal-green"
                      : "border-terminal-border hover:border-terminal-green/40"
                  }`}
                  title={vid.label}
                >
                  <img
                    src={vid.posterUrl}
                    alt={vid.label}
                    loading="lazy"
                    className="h-full w-full object-cover"
                    style={{ backgroundColor: vid.dominantColor }}
                  />
                  {/* Play icon overlay */}
                  <div className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 transition-opacity group-hover:opacity-100">
                    <Play className="h-4 w-4 fill-white text-white" />
                  </div>
                  {/* Duration badge */}
                  <span className="absolute bottom-0.5 right-0.5 rounded bg-black/60 px-1 py-px font-mono text-[8px] text-white">
                    {vid.duration}s
                  </span>
                  {activeBg.videoId === vid.id && (
                    <div className="absolute -right-0.5 -top-0.5">
                      <div className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-terminal-green text-white">
                        <Check className="h-2 w-2" />
                      </div>
                    </div>
                  )}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div>
        <label className="mb-2 block font-mono text-sm text-terminal-muted">{t("preferences.language.label")}</label>
        <div className="space-y-3">
          {locales.map((locale) => (
            <label
              key={locale}
              className={`flex items-center gap-3 ${isLocaleSwitching ? "opacity-60" : ""}`}
            >
              <input
                type="radio"
                name="language"
                value={locale}
                checked={currentLocale === locale}
                disabled={isLocaleSwitching}
                onChange={() => handleLocaleChange(locale)}
                className="size-4 accent-terminal-green"
              />
              <span className="font-mono text-terminal-dark">{t(`preferences.language.${locale}`)}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Tool Loading Mode */}
      <div className="space-y-4 rounded border border-terminal-border bg-terminal-cream/30 p-4">
        <div>
          <label className="mb-2 block font-mono text-sm text-terminal-muted">
            {t("preferences.toolLoading.label")}
          </label>
          <div className="space-y-3">
            <label className="flex items-start gap-3">
              <input
                type="radio"
                name="toolLoadingMode"
                value="deferred"
                checked={formState.toolLoadingMode === "deferred"}
                onChange={() => updateField("toolLoadingMode", "deferred")}
                className="mt-1 size-4 accent-terminal-green"
              />
              <div>
                <span className="font-mono text-terminal-dark">{t("preferences.toolLoading.deferred")}</span>
                <p className="font-mono text-xs text-terminal-muted">{t("preferences.toolLoading.deferredHelper")}</p>
              </div>
            </label>
            <label className="flex items-start gap-3">
              <input
                type="radio"
                name="toolLoadingMode"
                value="always"
                checked={formState.toolLoadingMode === "always" || !formState.toolLoadingMode}
                onChange={() => updateField("toolLoadingMode", "always")}
                className="mt-1 size-4 accent-terminal-green"
              />
              <div>
                <span className="font-mono text-terminal-dark">{t("preferences.toolLoading.always")}</span>
                <p className="font-mono text-xs text-terminal-muted">{t("preferences.toolLoading.alwaysHelper")}</p>
              </div>
            </label>
          </div>
        </div>

        <div className="border-t border-terminal-border pt-4">
          <label className="mb-2 block font-mono text-sm text-terminal-muted">
            {t("preferences.toolDisplay.label")}
          </label>
          <div className="space-y-3">
            <label className="flex items-start gap-3">
              <input
                type="radio"
                name="toolDisplayMode"
                value="compact"
                checked={formState.toolDisplayMode === "compact"}
                onChange={() => updateField("toolDisplayMode", "compact")}
                className="mt-1 size-4 accent-terminal-green"
              />
              <div>
                <span className="font-mono text-terminal-dark">{t("preferences.toolDisplay.compact")}</span>
                <p className="font-mono text-xs text-terminal-muted">{t("preferences.toolDisplay.compactHelper")}</p>
              </div>
            </label>
            <label className="flex items-start gap-3">
              <input
                type="radio"
                name="toolDisplayMode"
                value="detailed"
                checked={formState.toolDisplayMode === "detailed"}
                onChange={() => updateField("toolDisplayMode", "detailed")}
                className="mt-1 size-4 accent-terminal-green"
              />
              <div>
                <span className="font-mono text-terminal-dark">{t("preferences.toolDisplay.detailed")}</span>
                <p className="font-mono text-xs text-terminal-muted">{t("preferences.toolDisplay.detailedHelper")}</p>
              </div>
            </label>
          </div>
          {formState.devWorkspaceEnabled && (
            <p className="mt-3 rounded border border-terminal-green/30 bg-terminal-green/10 px-3 py-2 font-mono text-xs text-terminal-dark">
              {t("preferences.toolDisplay.devWorkspaceOverride")}
            </p>
          )}
        </div>
      </div>

      <div className="space-y-4 rounded border border-terminal-border bg-terminal-cream/30 p-4">
        <div>
          <h3 className="font-mono text-base font-semibold text-terminal-dark">{t("localGrep.heading")}</h3>
          <p className="mt-1 font-mono text-xs text-terminal-muted">{t("localGrep.description")}</p>
          <p className="mt-2 font-mono text-xs text-terminal-muted">{t("localGrep.tip")}</p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="flex items-center justify-between rounded border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 px-3 py-2">
            <span className="font-mono text-sm text-terminal-dark">{t("localGrep.enableLabel")}</span>
            <input
              type="checkbox"
              checked={formState.localGrepEnabled}
              onChange={(e) => updateField("localGrepEnabled", e.target.checked)}
              className="size-4 accent-terminal-green"
            />
          </label>
          <label className="flex items-center justify-between rounded border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 px-3 py-2">
            <span className="font-mono text-sm text-terminal-dark">{t("localGrep.gitignoreLabel")}</span>
            <input
              type="checkbox"
              checked={formState.localGrepRespectGitignore}
              onChange={(e) => updateField("localGrepRespectGitignore", e.target.checked)}
              className="size-4 accent-terminal-green"
            />
          </label>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="mb-1 block font-mono text-xs text-terminal-muted">{t("localGrep.maxResultsLabel")}</label>
            <input
              type="number"
              min={1}
              max={100}
              value={formState.localGrepMaxResults}
              onChange={(e) => updateField("localGrepMaxResults", Number(e.target.value) || 20)}
              className="w-full rounded border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 px-3 py-2 font-mono text-sm text-terminal-dark focus:border-terminal-green focus:outline-none focus:ring-1 focus:ring-terminal-green"
            />
          </div>
          <div>
            <label className="mb-1 block font-mono text-xs text-terminal-muted">{t("localGrep.contextLinesLabel")}</label>
            <input
              type="number"
              min={0}
              max={10}
              value={formState.localGrepContextLines}
              onChange={(e) => updateField("localGrepContextLines", Number(e.target.value) || 2)}
              className="w-full rounded border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 px-3 py-2 font-mono text-sm text-terminal-dark focus:border-terminal-green focus:outline-none focus:ring-1 focus:ring-terminal-green"
            />
          </div>
        </div>
      </div>

      {/* Post-Edit Hooks */}
      <div className="space-y-4 rounded border border-terminal-border bg-terminal-cream/30 p-4">
        <div>
          <h3 className="font-mono text-base font-semibold text-terminal-dark">{t("preferences.postEditHooks.heading")}</h3>
          <p className="mt-1 font-mono text-xs text-terminal-muted">
            {t("preferences.postEditHooks.description")}
          </p>
        </div>

        <div>
          <label className="mb-2 block font-mono text-sm text-terminal-dark">{t("preferences.postEditHooks.profileLabel")}</label>
          <div className="space-y-2">
            <label className="flex items-start gap-3">
              <input
                type="radio"
                name="postEditHooksPreset"
                value="off"
                checked={formState.postEditHooksPreset === "off"}
                onChange={() => {
                  updateField("postEditHooksPreset", "off");
                  updateField("postEditHooksEnabled", false);
                  updateField("postEditTypecheckEnabled", false);
                  updateField("postEditLintEnabled", false);
                }}
                className="mt-1 size-4 accent-terminal-green"
              />
              <div>
                <span className="font-mono text-terminal-dark">{t("preferences.postEditHooks.off")}</span>
                <p className="font-mono text-xs text-terminal-muted">{t("preferences.postEditHooks.offDesc")}</p>
              </div>
            </label>
            <label className="flex items-start gap-3">
              <input
                type="radio"
                name="postEditHooksPreset"
                value="fast"
                checked={formState.postEditHooksPreset === "fast"}
                onChange={() => {
                  updateField("postEditHooksPreset", "fast");
                  updateField("postEditHooksEnabled", true);
                  updateField("postEditTypecheckEnabled", true);
                  updateField("postEditLintEnabled", false);
                  updateField("postEditTypecheckScope", "auto");
                  updateField("postEditRunInPatchTool", false);
                }}
                className="mt-1 size-4 accent-terminal-green"
              />
              <div>
                <span className="font-mono text-terminal-dark">{t("preferences.postEditHooks.fast")}</span>
                <p className="font-mono text-xs text-terminal-muted">{t("preferences.postEditHooks.fastDesc")}</p>
              </div>
            </label>
            <label className="flex items-start gap-3">
              <input
                type="radio"
                name="postEditHooksPreset"
                value="strict"
                checked={formState.postEditHooksPreset === "strict"}
                onChange={() => {
                  updateField("postEditHooksPreset", "strict");
                  updateField("postEditHooksEnabled", true);
                  updateField("postEditTypecheckEnabled", true);
                  updateField("postEditLintEnabled", true);
                  updateField("postEditTypecheckScope", "all");
                  updateField("postEditRunInPatchTool", true);
                }}
                className="mt-1 size-4 accent-terminal-green"
              />
              <div>
                <span className="font-mono text-terminal-dark">{t("preferences.postEditHooks.strict")}</span>
                <p className="font-mono text-xs text-terminal-muted">{t("preferences.postEditHooks.strictDesc")}</p>
              </div>
            </label>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="flex items-center justify-between rounded border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 px-3 py-2">
            <span className="font-mono text-sm text-terminal-dark">{t("preferences.postEditHooks.enableHooks")}</span>
            <input
              type="checkbox"
              checked={formState.postEditHooksEnabled}
              onChange={(e) => updateField("postEditHooksEnabled", e.target.checked)}
              className="size-4 accent-terminal-green"
            />
          </label>
          <label className="flex items-center justify-between rounded border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 px-3 py-2">
            <span className="font-mono text-sm text-terminal-dark">{t("preferences.postEditHooks.includePatches")}</span>
            <input
              type="checkbox"
              checked={formState.postEditRunInPatchTool}
              onChange={(e) => updateField("postEditRunInPatchTool", e.target.checked)}
              className="size-4 accent-terminal-green"
            />
          </label>
          <label className="flex items-center justify-between rounded border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 px-3 py-2">
            <span className="font-mono text-sm text-terminal-dark">{t("preferences.postEditHooks.typecheck")}</span>
            <input
              type="checkbox"
              checked={formState.postEditTypecheckEnabled}
              onChange={(e) => updateField("postEditTypecheckEnabled", e.target.checked)}
              className="size-4 accent-terminal-green"
            />
          </label>
          <label className="flex items-center justify-between rounded border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 px-3 py-2">
            <span className="font-mono text-sm text-terminal-dark">{t("preferences.postEditHooks.eslint")}</span>
            <input
              type="checkbox"
              checked={formState.postEditLintEnabled}
              onChange={(e) => updateField("postEditLintEnabled", e.target.checked)}
              className="size-4 accent-terminal-green"
            />
          </label>
        </div>

        <div>
          <label className="mb-1 block font-mono text-sm text-terminal-dark">{t("preferences.postEditHooks.typecheckScopeLabel")}</label>
          <p className="mb-2 font-mono text-xs text-terminal-muted">
            {t("preferences.postEditHooks.typecheckScopeDesc")}
          </p>
          <select
            value={formState.postEditTypecheckScope}
            onChange={(e) => updateField("postEditTypecheckScope", e.target.value as FormState["postEditTypecheckScope"])}
            className="w-full rounded border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 px-3 py-2 font-mono text-sm text-terminal-dark focus:border-terminal-green focus:outline-none focus:ring-1 focus:ring-terminal-green"
          >
            <option value="auto">{t("preferences.postEditHooks.scopeAuto")}</option>
            <option value="app">{t("preferences.postEditHooks.scopeApp")}</option>
            <option value="lib">{t("preferences.postEditHooks.scopeLib")}</option>
            <option value="electron">{t("preferences.postEditHooks.scopeElectron")}</option>
            <option value="tooling">{t("preferences.postEditHooks.scopeTooling")}</option>
            <option value="all">{t("preferences.postEditHooks.scopeAll")}</option>
          </select>
        </div>
      </div>

      {/* Prompt Caching */}
      <div className="space-y-4">
        <h3 className="font-mono text-base font-semibold text-terminal-dark">
          {t("preferences.promptCaching.heading")}
        </h3>
        <p className="font-mono text-xs text-terminal-muted">
          {t("preferences.promptCaching.description")}
        </p>

        {/* Enable/Disable Toggle */}
        <div className="flex items-center justify-between">
          <div>
            <label className="font-mono text-sm text-terminal-dark">
              {t("preferences.promptCaching.enableLabel")}
            </label>
            <p className="mt-1 font-mono text-xs text-terminal-muted">
              {t("preferences.promptCaching.enableDesc")}
            </p>
          </div>
          <input
            type="checkbox"
            checked={formState.promptCachingEnabled ?? true}
            onChange={(e) => updateField("promptCachingEnabled", e.target.checked)}
            className="size-5 accent-terminal-green"
          />
        </div>

      </div>

      {/* RTK (Rust Token Killer) */}
      <div className="space-y-4 rounded border border-terminal-border bg-terminal-cream/30 p-4">
        <div>
          <h3 className="font-mono text-base font-semibold text-terminal-dark">
            {t("preferences.rtk.heading")}
          </h3>
          <p className="font-mono text-xs text-terminal-muted">
            {t("preferences.rtk.description")}
          </p>
        </div>

        <label className="flex items-center justify-between gap-3">
          <div>
            <span className="font-mono text-sm text-terminal-dark">{t("preferences.rtk.enableLabel")}</span>
            <p className="mt-1 font-mono text-xs text-terminal-muted">
              {t("preferences.rtk.enableDesc")}
            </p>
          </div>
          <input
            type="checkbox"
            checked={formState.rtkEnabled}
            onChange={(e) => updateField("rtkEnabled", e.target.checked)}
            className="size-5 accent-terminal-green"
          />
        </label>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="mb-1 block font-mono text-xs text-terminal-muted">{t("preferences.rtk.verbosityLabel")}</label>
            <select
              value={String(formState.rtkVerbosity)}
              onChange={(e) => updateField("rtkVerbosity", Number(e.target.value) as 0 | 1 | 2 | 3)}
              className="w-full rounded border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 px-3 py-2 font-mono text-sm text-terminal-dark focus:border-terminal-green focus:outline-none focus:ring-1 focus:ring-terminal-green"
            >
              <option value="0">0 (quiet)</option>
              <option value="1">1 (-v)</option>
              <option value="2">2 (-vv)</option>
              <option value="3">3 (-vvv)</option>
            </select>
          </div>

          <label className="flex items-center gap-3 md:pt-6">
            <input
              type="checkbox"
              checked={formState.rtkUltraCompact}
              onChange={(e) => updateField("rtkUltraCompact", e.target.checked)}
              className="size-4 accent-terminal-green"
            />
            <span className="font-mono text-sm text-terminal-dark">{t("preferences.rtk.ultraCompact")}</span>
          </label>
        </div>
      </div>

      {/* Developer Workspace (Git Worktree Integration) */}
      <div className="space-y-4 rounded border border-terminal-border bg-terminal-cream/30 p-4">
        <div>
          <h3 className="font-mono text-base font-semibold text-terminal-dark">
            {t("preferences.devWorkspace.heading")}
          </h3>
          <p className="mt-1 font-mono text-xs text-terminal-muted">
            {t("preferences.devWorkspace.description")}
          </p>
        </div>

        <label className="flex items-center justify-between gap-3">
          <div>
            <span className="font-mono text-sm text-terminal-dark">{t("preferences.devWorkspace.enableLabel")}</span>
            <p className="mt-1 font-mono text-xs text-terminal-muted">
              {t("preferences.devWorkspace.enableDesc")}
            </p>
          </div>
          <input
            type="checkbox"
            checked={formState.devWorkspaceEnabled}
            onChange={(e) => updateField("devWorkspaceEnabled", e.target.checked)}
            className="size-5 accent-terminal-green"
          />
        </label>

        {formState.devWorkspaceEnabled && (
          <div className="space-y-4 border-t border-terminal-border pt-4">
            <label className="flex items-center justify-between gap-3">
              <div>
                <span className="font-mono text-sm text-terminal-dark">{t("preferences.devWorkspace.autoCleanLabel")}</span>
                <p className="mt-1 font-mono text-xs text-terminal-muted">
                  {t("preferences.devWorkspace.autoCleanDesc")}
                </p>
              </div>
              <input
                type="checkbox"
                checked={formState.devWorkspaceAutoCleanup}
                onChange={(e) => updateField("devWorkspaceAutoCleanup", e.target.checked)}
                className="size-5 accent-terminal-green"
              />
            </label>

            {formState.devWorkspaceAutoCleanup && (
              <div>
                <label className="mb-1 block font-mono text-xs text-terminal-muted">
                  {t("preferences.devWorkspace.cleanupDaysLabel")}
                </label>
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={formState.devWorkspaceAutoCleanupDays}
                  onChange={(e) => updateField("devWorkspaceAutoCleanupDays", Math.max(1, Math.min(30, Number(e.target.value))))}
                  className="w-24 rounded border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 px-3 py-2 font-mono text-sm text-terminal-dark focus:border-terminal-green focus:outline-none focus:ring-1 focus:ring-terminal-green"
                />
              </div>
            )}

            <div className="rounded border border-dashed border-terminal-border bg-terminal-cream/50 p-3">
              <p className="font-mono text-xs text-terminal-muted">
                <strong className="text-terminal-dark">{t("preferences.devWorkspace.recommendedServers")}</strong>{" "}
                {t.rich("preferences.devWorkspace.recommendedServersDesc", {
                  worktreeTools: () => <code className="rounded bg-terminal-border/30 px-1">worktree-tools-mcp</code>,
                  githubMcp: () => <code className="rounded bg-terminal-border/30 px-1">github-mcp-server</code>,
                  strong: (chunks) => <strong className="text-terminal-dark">{chunks}</strong>,
                })}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* 3D Avatar */}
      <div className="space-y-4 rounded border border-terminal-border bg-terminal-cream/30 p-4">
        <div>
          <h3 className="font-mono text-base font-semibold text-terminal-dark">
            {t("preferences.avatar3d.heading")}
          </h3>
          <p className="mt-1 font-mono text-xs text-terminal-muted">
            {t("preferences.avatar3d.description")}
          </p>
        </div>

        <label className="flex items-center justify-between gap-3">
          <div>
            <span className="font-mono text-sm text-terminal-dark">{t("preferences.avatar3d.enableLabel")}</span>
            <p className="mt-1 font-mono text-xs text-terminal-muted">
              {t("preferences.avatar3d.enableDesc")}
            </p>
          </div>
          <input
            type="checkbox"
            checked={formState.avatar3dEnabled}
            onChange={(e) => updateField("avatar3dEnabled", e.target.checked)}
            className="size-5 accent-terminal-green"
          />
        </label>
      </div>

      {/* Emotion Detection */}
      <div className="space-y-4 rounded border border-terminal-border bg-terminal-cream/30 p-4">
        <div>
          <h3 className="font-mono text-base font-semibold text-terminal-dark">
            {t("preferences.emotionDetection.heading")}
          </h3>
          <p className="mt-1 font-mono text-xs text-terminal-muted">
            {t("preferences.emotionDetection.description")}
          </p>
        </div>

        <label className="flex items-center justify-between gap-3">
          <div>
            <span className="font-mono text-sm text-terminal-dark">{t("preferences.emotionDetection.enableLabel")}</span>
            <p className="mt-1 font-mono text-xs text-terminal-muted">
              {t("preferences.emotionDetection.enableDesc")}
            </p>
          </div>
          <input
            type="checkbox"
            checked={formState.emotionDetectionEnabled}
            onChange={(e) => updateField("emotionDetectionEnabled", e.target.checked)}
            className="size-5 accent-terminal-green"
          />
        </label>
      </div>

      {/* Browser Automation */}
      <div className="space-y-4 rounded border border-terminal-border bg-terminal-cream/30 p-4">
        <div>
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-terminal-muted" />
            <h3 className="font-mono text-base font-semibold text-terminal-dark">
              {t("preferences.browserAutomation.heading")}
            </h3>
          </div>
          <p className="mt-1 font-mono text-xs text-terminal-muted">
            {t("preferences.browserAutomation.description")}
          </p>
        </div>

        <div className="space-y-2">
          <label className="flex items-start gap-3">
            <input
              type="radio"
              name="chromiumBrowserMode"
              value="standalone"
              checked={formState.chromiumBrowserMode === "standalone"}
              onChange={() => updateField("chromiumBrowserMode", "standalone")}
              className="mt-1 size-4 accent-terminal-green"
            />
            <div>
              <span className="font-mono text-terminal-dark">{t("preferences.browserAutomation.standalone")}</span>
              <p className="font-mono text-xs text-terminal-muted">{t("preferences.browserAutomation.standaloneDesc")}</p>
            </div>
          </label>
          <label className="flex items-start gap-3">
            <input
              type="radio"
              name="chromiumBrowserMode"
              value="user-chrome"
              checked={formState.chromiumBrowserMode === "user-chrome"}
              onChange={() => updateField("chromiumBrowserMode", "user-chrome")}
              className="mt-1 size-4 accent-terminal-green"
            />
            <div>
              <span className="font-mono text-terminal-dark">{t("preferences.browserAutomation.userChrome")}</span>
              <p className="font-mono text-xs text-terminal-muted">{t("preferences.browserAutomation.userChromeDesc")}</p>
            </div>
          </label>
        </div>

        {formState.chromiumBrowserMode === "user-chrome" && (
          <div className="space-y-3 border-t border-terminal-border pt-4">
            <div>
              <label className="mb-1 block font-mono text-xs text-terminal-muted">
                {t("preferences.browserAutomation.profilePathLabel")}
              </label>
              <input
                type="text"
                value={formState.chromiumUserProfilePath}
                onChange={(e) => updateField("chromiumUserProfilePath", e.target.value)}
                placeholder={t("preferences.browserAutomation.profilePathPlaceholder")}
                className="w-full rounded border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 px-3 py-2 font-mono text-sm text-terminal-dark placeholder:text-terminal-muted/50 focus:border-terminal-green focus:outline-none focus:ring-1 focus:ring-terminal-green"
              />
            </div>

            <div className="rounded border border-dashed border-amber-400/50 bg-amber-50/30 dark:bg-amber-900/10 p-3">
              <p className="font-mono text-xs text-terminal-muted">
                <strong className="text-amber-600 dark:text-amber-400">&#9888; {t("preferences.browserAutomation.noteLabel")}</strong>{" "}
                {t("preferences.browserAutomation.noteText")}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
