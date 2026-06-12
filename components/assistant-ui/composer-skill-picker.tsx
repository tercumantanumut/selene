"use client";

import type { FC } from "react";
import { useRef } from "react";
import { SearchIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import type { SkillRecord } from "@/lib/skills/types";
import { getRequiredSkillInputs } from "@/lib/skills/skill-picker-utils";
import { SkillIcon } from "@/components/skills/skill-icon";

export interface ComposerSkillLite {
  id: string;
  name: string;
  description: string | null;
  category: string;
  icon?: string | null;
  inputParameters: SkillRecord["inputParameters"];
}

export type SkillPickerMode = "slash" | "spotlight";

export const MAX_SLASH_SKILL_RESULTS = 8;

interface ComposerSkillPickerProps {
  skills: ComposerSkillLite[];
  filteredSkills: ComposerSkillLite[];
  isLoadingSkills: boolean;
  skillPickerMode: SkillPickerMode;
  skillPickerQuery: string;
  selectedSkillIndex: number;
  spotlightShortcutHint: string;
  onSelectSkill: (skill: ComposerSkillLite) => void;
  onQueryChange: (query: string) => void;
  onSelectedIndexChange: (updater: (index: number) => number) => void;
  onClose: () => void;
  /** Called when the spotlight input ref is needed for focus management */
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  /** Called when the picker container ref is needed for outside-click detection */
  pickerRef: React.RefObject<HTMLDivElement | null>;
  /** Ref to the composer textarea, used to return focus after Escape in spotlight mode */
  composerInputRef: React.RefObject<HTMLTextAreaElement | null>;
}

const ComposerSkillPicker: FC<ComposerSkillPickerProps> = ({
  skills,
  filteredSkills,
  isLoadingSkills,
  skillPickerMode,
  skillPickerQuery,
  selectedSkillIndex,
  spotlightShortcutHint,
  onSelectSkill,
  onQueryChange,
  onSelectedIndexChange,
  onClose,
  searchInputRef,
  pickerRef,
  composerInputRef,
}) => {
  const t = useTranslations("assistantUi");

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (filteredSkills.length > 0) {
        onSelectedIndexChange((index) => Math.min(index + 1, filteredSkills.length - 1));
      }
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (filteredSkills.length > 0) {
        onSelectedIndexChange((index) => Math.max(index - 1, 0));
      }
      return;
    }

    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      if (filteredSkills[selectedSkillIndex]) {
        onSelectSkill(filteredSkills[selectedSkillIndex]);
      }
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      requestAnimationFrame(() => composerInputRef.current?.focus());
    }
  };

  return (
    <div
      ref={pickerRef}
      className="absolute bottom-full left-0 right-0 z-50 mb-2 overflow-hidden rounded-xl border border-terminal-border/70 bg-[linear-gradient(160deg,rgba(255,255,255,0.96),rgba(245,240,226,0.96))] shadow-[0_20px_50px_-20px_rgba(28,30,26,0.55)] backdrop-blur"
    >
      <div className="border-b border-terminal-border/50 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="rounded-md border border-terminal-green/30 bg-terminal-green/10 px-1.5 py-0.5 text-[11px] font-mono uppercase tracking-wider text-terminal-green">
              {skillPickerMode === "spotlight" ? t("skillPicker.spotlightLabel") : t("skillPicker.skillsLabel")}
            </div>
            <span className="text-xs font-mono text-terminal-muted">
              {skillPickerMode === "spotlight" ? t("skillPicker.spotlightHint", { shortcut: spotlightShortcutHint }) : t("skillPicker.slashHint")}
            </span>
          </div>
          <span className="text-[11px] font-mono text-terminal-muted/80">
            {isLoadingSkills
              ? t("skillImportOverlay.loadingSkills")
              : t("skillImportOverlay.skillResults", { count: filteredSkills.length })}
          </span>
        </div>
        <div className="relative mt-2">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-3 -translate-y-1/2 text-terminal-muted/70" />
          <input
            ref={searchInputRef}
            type="text"
            value={skillPickerQuery}
            onChange={(event) => {
              onQueryChange(event.target.value);
              onSelectedIndexChange(() => 0);
            }}
            onKeyDown={handleSearchKeyDown}
            className="w-full rounded-md border border-terminal-border/60 bg-white/85 py-1.5 pl-8 pr-3 text-sm font-mono text-terminal-dark outline-none transition-colors placeholder:text-terminal-muted/70 focus:border-terminal-green/50"
            placeholder={t("skillPicker.searchPlaceholder")}
            aria-label={t("skillPicker.searchAriaLabel")}
          />
        </div>
      </div>

      <div className="max-h-64 overflow-y-auto px-2 py-2">
        {skills.length === 0 && !isLoadingSkills ? (
          <div className="px-2 py-8 text-center">
            <p className="text-xs font-mono text-terminal-muted">
              {t("skillPicker.noSkillsYet")}
            </p>
          </div>
        ) : filteredSkills.length === 0 ? (
          <div className="px-2 py-8 text-center">
            <p className="text-xs font-mono text-terminal-muted">
              {t("skillPicker.noMatch", { query: skillPickerQuery })}
            </p>
          </div>
        ) : (
          filteredSkills.map((skill, index) => {
            const requiredInputs = getRequiredSkillInputs(skill.inputParameters);
            return (
              <button
                key={skill.id}
                type="button"
                className={cn(
                  "group flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                  index === selectedSkillIndex
                    ? "bg-terminal-green/15 text-terminal-dark"
                    : "text-terminal-dark/90 hover:bg-terminal-dark/5"
                )}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelectSkill(skill);
                }}
                onMouseEnter={() => onSelectedIndexChange(() => index)}
                aria-selected={index === selectedSkillIndex}
              >
                <SkillIcon
                  icon={skill.icon ?? null}
                  displayName={skill.name}
                  size={24}
                  className="mt-0.5 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold font-mono text-terminal-dark">
                      {skill.name}
                    </span>
                    {skill.category && (
                      <span className="shrink-0 rounded border border-terminal-border/60 px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide text-terminal-muted">
                        {skill.category}
                      </span>
                    )}
                  </div>
                  {skill.description && (
                    <p className="mt-0.5 line-clamp-1 text-xs font-mono text-terminal-muted">
                      {skill.description}
                    </p>
                  )}
                </div>
                {requiredInputs.length > 0 && (
                  <span className="mt-0.5 shrink-0 rounded border border-amber-300/80 bg-amber-50 px-1.5 py-0.5 text-[10px] font-mono text-amber-700">
                    {t("skillPicker.needsInput")}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>

      <div className="flex items-center gap-4 border-t border-terminal-border/50 px-4 py-2 text-[10px] font-mono text-terminal-muted/80">
        <span>{t("skillPicker.navigate")}</span>
        <span>{t("skillPicker.select")}</span>
        <span>{t("skillPicker.close")}</span>
        <span>{t("skillPicker.open")}</span>
      </div>
    </div>
  );
};
