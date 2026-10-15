"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { MessageCircle, PlusCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { AnimatedCard } from "@/components/ui/animated-card";
import { AnimatedButton } from "@/components/ui/animated-button";
import { ToolBadge, getTopTools } from "@/components/ui/tool-badge";
import { useTranslations } from "next-intl";
import { getCharacterInitials } from "@/components/assistant-ui/character-context";
import { AgentOverflowMenu } from "@/components/character-picker-agent-overflow-menu";
import { getAgentAccentColor } from "@/lib/personalization/accent-colors";
import { GradientBackground } from "@/components/ui/noisy-gradient-backgrounds";
import type { GradientColor } from "@/components/ui/noisy-gradient-backgrounds";
import type { CharacterSummary } from "@/components/character-picker-types";

export function AgentCardInWorkflow({
  character,
  role,
  t,
  hasActiveSession,
  onContinueChat,
  onNewChat,
  onEditIdentity,
  onEditModelDefaults,
  onManageSkills,
  onEditTools,
  onEditFolders,
  onEditMcp,
  onEditPlugins,
  onEditAvatar3d,
  onDuplicate,
  isDuplicating = false,
  addToWorkflowLabel,
  onAddToWorkflow,
  canAddToWorkflow,
  onDelete,
  onRemoveFromWorkflow,
  removeFromWorkflowLabel,
  router,
  dataAnimateCard,
}: {
  character: CharacterSummary;
  role?: "initiator" | "subagent";
  t: ReturnType<typeof useTranslations>;
  hasActiveSession: (charId: string, initialStatus?: boolean) => boolean;
  onContinueChat: (id: string) => void;
  onNewChat: (id: string) => void;
  onEditIdentity: (c: CharacterSummary) => void;
  onEditModelDefaults: (c: CharacterSummary) => void;
  onManageSkills: (c: CharacterSummary) => void;
  onEditTools: (c: CharacterSummary) => void;
  onEditFolders: (c: CharacterSummary) => void;
  onEditMcp: (c: CharacterSummary) => void;
  onEditPlugins: (c: CharacterSummary) => void;
  onEditAvatar3d: (c: CharacterSummary) => void;
  onDuplicate: (characterId: string) => void;
  isDuplicating?: boolean;
  addToWorkflowLabel?: string;
  onAddToWorkflow?: (c: CharacterSummary) => void;
  canAddToWorkflow?: boolean;
  onDelete: (c: CharacterSummary) => void;
  onRemoveFromWorkflow?: () => void;
  removeFromWorkflowLabel?: string;
  router: ReturnType<typeof useRouter>;
  dataAnimateCard?: boolean;
}) {
  const initials = getCharacterInitials(character.name);
  const enabledTools = character.metadata?.enabledTools || [];
  const topTools = getTopTools(enabledTools, 3);
  const purpose = character.metadata?.purpose;
  const isSystemAgent = character.metadata?.isSystemAgent === true;
  const primaryImage = character.images?.find((img) => img.isPrimary);
  const avatarImage = character.images?.find((img) => img.imageType === "avatar");
  const imageUrl = avatarImage?.url || primaryImage?.url;

  // Deterministic accent color based on character ID (or manual override from metadata)
  const accentColor = useMemo(
    () => getAgentAccentColor(character.id, (character.metadata as Record<string, unknown>)?.accentColor as string | undefined),
    [character.id, character.metadata]
  );

  // Generate noisy gradient colors for avatar (same look as onboarding path cards)
  const avatarGradientColors = useMemo((): GradientColor[] => {
    const hex = accentColor.hex;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const dr = Math.max(0, Math.round(r * 0.3));
    const dg = Math.max(0, Math.round(g * 0.3));
    const db = Math.max(0, Math.round(b * 0.3));
    return [
      { color: `rgba(${dr},${dg},${db},1)`, stop: "0%" },
      { color: `rgba(${r},${g},${b},1)`, stop: "60%" },
      { color: `rgba(${Math.min(255, r + 30)},${Math.min(255, g + 30)},${Math.min(255, b + 30)},1)`, stop: "100%" },
    ];
  }, [accentColor.hex]);

  return (
    <AnimatedCard
      data-animate-card={dataAnimateCard ? true : undefined}
      hoverLift
      className={cn(
        "group relative w-full overflow-hidden flex flex-col min-h-[180px]",
        "border border-terminal-border/30 bg-terminal-cream/50 shadow-sm"
      )}
    >
      {/* Subtle accent gradient strip at top */}
      <div
        className="h-[2px] w-full"
        style={{
          background: `linear-gradient(90deg, ${accentColor.hex}60, ${accentColor.hex}15, transparent 80%)`,
        }}
      />

      <div className="flex-1 p-4 pb-2">
        <AgentOverflowMenu
          character={character}
          onEditIdentity={onEditIdentity}
          onEditModelDefaults={onEditModelDefaults}
          onManageSkills={onManageSkills}
          onEditTools={onEditTools}
          onEditFolders={onEditFolders}
          onEditMcp={onEditMcp}
          onEditPlugins={onEditPlugins}
          onEditAvatar3d={onEditAvatar3d}
          onNavigateDashboard={() => router.push("/dashboard")}
          onDuplicate={onDuplicate}
          isDuplicating={isDuplicating}
          addToWorkflowLabel={addToWorkflowLabel}
          onAddToWorkflow={onAddToWorkflow}
          showAddToWorkflow={Boolean(onAddToWorkflow)}
          canAddToWorkflow={canAddToWorkflow}
          onDelete={onDelete}
          onRemoveFromWorkflow={onRemoveFromWorkflow}
          removeFromWorkflowLabel={removeFromWorkflowLabel}
        />

        <div className="flex min-h-9 items-center gap-3">
          <div className="relative">
            {imageUrl ? (
              <Avatar className="h-14 w-14">
                <AvatarImage src={imageUrl} alt={character.name} />
                <AvatarFallback className="relative overflow-hidden">
                  <GradientBackground
                    colors={avatarGradientColors}
                    gradientOrigin="bottom-middle"
                    gradientSize="150% 150%"
                    noiseIntensity={0.9}
                    noisePatternAlpha={45}
                    noisePatternSize={60}
                    noisePatternRefreshInterval={0}
                    className="rounded-full"
                  />
                </AvatarFallback>
              </Avatar>
            ) : (
              <div className="relative h-14 w-14 shrink-0 rounded-full overflow-hidden">
                <GradientBackground
                  colors={avatarGradientColors}
                  gradientOrigin="bottom-middle"
                  gradientSize="150% 150%"
                  noiseIntensity={0.9}
                  noisePatternAlpha={45}
                  noisePatternSize={60}
                  noisePatternRefreshInterval={0}
                  className="rounded-full"
                />
                <span className="relative z-10 flex h-full w-full items-center justify-center" />
              </div>
            )}
            {hasActiveSession(character.id, character.hasActiveSession) && (
              <div className="absolute -right-1 -top-1 z-10">
                <div className="flex h-4 w-4 items-center justify-center rounded-full bg-green-500 shadow-md">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
                  </span>
                </div>
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1 pr-6">
            <div className="flex items-center gap-2">
              <p className="truncate font-mono text-sm font-medium text-terminal-dark">
                {character.displayName || character.name}
              </p>
              {isSystemAgent && (
                <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] font-medium text-slate-400">
                  {t("systemBadge")}
                </span>
              )}
              {role && (
                <Badge
                  variant="outline"
                  className={`shrink-0 text-[10px] font-mono ${
                    role === "initiator"
                      ? "border-terminal-green/30 bg-terminal-green/10 text-terminal-green"
                      : "border-terminal-border bg-terminal-muted/10 text-terminal-muted"
                  }`}
                >
                  {role === "initiator" ? t("workflows.initiator") : t("workflows.subagent")}
                </Badge>
              )}
            </div>
            {character.tagline && (
              <p className="line-clamp-1 font-mono text-xs text-terminal-muted">{character.tagline}</p>
            )}
          </div>
        </div>

        <p className={cn(
          "mt-1.5 line-clamp-2 pl-0.5 font-mono text-[11px] text-terminal-muted/80",
          !purpose && "invisible"
        )}>
          {purpose || "\u00A0"}
        </p>

        <div className="mt-1.5 flex items-center gap-1 min-h-[24px]">
          {topTools.map((toolId) => (
            <ToolBadge key={toolId} toolId={toolId} size="sm" />
          ))}
          {enabledTools.length > 3 && (
            <span className="font-mono text-[10px] text-terminal-muted">+{enabledTools.length - 3}</span>
          )}
        </div>


      </div>

      <div className="flex justify-start gap-1.5 px-4 pb-3 pt-0">
        <AnimatedButton
          size="sm"
          className="inline-flex h-7 gap-1.5 bg-terminal-dark px-3 font-mono text-xs text-terminal-cream hover:bg-terminal-dark/90"
          onClick={() => onContinueChat(character.id)}
        >
          <MessageCircle className="h-3 w-3" />
          {hasActiveSession(character.id, character.hasActiveSession) ? t("resumeChat") : t("startChat")}
        </AnimatedButton>
        <AnimatedButton
          size="sm"
          variant="outline"
          className="h-7 w-7 px-0 font-mono text-xs text-terminal-dark hover:bg-terminal-dark/5"
          onClick={() => onNewChat(character.id)}
          aria-label={t("startNew")}
        >
          <PlusCircle className="h-3 w-3" />
        </AnimatedButton>
      </div>
    </AnimatedCard>
  );
}
