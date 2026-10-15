"use client";

import { useMemo } from "react";
import { AvatarFallback } from "@/components/ui/avatar";
import { GradientBackground } from "@/components/ui/noisy-gradient-backgrounds";
import type { GradientColor } from "@/components/ui/noisy-gradient-backgrounds";
import { getAgentAccentColor, buildAgentGradientColors } from "@/lib/personalization/accent-colors";

interface AgentAvatarFallbackProps {
  characterId: string;
}

/**
 * AvatarFallback with a deterministic gradient derived from the character's ID.
 * Drop-in replacement for the repeated pattern across sidebar and chat views.
 */
export function AgentAvatarFallback({ characterId }: AgentAvatarFallbackProps) {
  const accentColor = useMemo(() => getAgentAccentColor(characterId), [characterId]);

  const gradientColors = useMemo(
    (): GradientColor[] => buildAgentGradientColors(accentColor.hex) as GradientColor[],
    [accentColor.hex],
  );

  return (
    <AvatarFallback className="relative overflow-hidden">
      <GradientBackground
        colors={gradientColors}
        gradientOrigin="bottom-middle"
        gradientSize="150% 150%"
        noiseIntensity={0.9}
        noisePatternAlpha={45}
        noisePatternSize={60}
        noisePatternRefreshInterval={0}
        className="rounded-full"
      />
    </AvatarFallback>
  );
}
