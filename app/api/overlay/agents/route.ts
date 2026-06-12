import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/local-auth";
import { getOrCreateLocalUser } from "@/lib/db/queries";
import { loadSettings } from "@/lib/settings/settings-manager";
import { getUserCharacters, getUserDefaultCharacter } from "@/lib/characters/queries";
import { getSessionByCharacterId } from "@/lib/db/queries";

export interface OverlayAgent {
  id: string;
  name: string;
  avatarUrl?: string;
  lastSessionId?: string;
  lastSessionTitle?: string;
  lastSessionUpdatedAt?: string;
}

interface OverlayAgentsResponse {
  agents: OverlayAgent[];
  defaultAgentId?: string;
}

export async function GET(req: Request) {
  try {
    const userId = await requireAuth(req);
    const settings = loadSettings();
    const dbUser = await getOrCreateLocalUser(userId, settings.localUserEmail);

    const [allCharacters, defaultCharacter] = await Promise.all([
      // getUserCharacters includes images via `with: { images: true }`
      getUserCharacters(dbUser.id),
      getUserDefaultCharacter(dbUser.id),
    ]);

    // Filter to active characters only
    const characters = allCharacters.filter((c) => c.status === "active");

    const agents: OverlayAgent[] = await Promise.all(
      characters.map(async (character) => {
        const agent: OverlayAgent = {
          id: character.id,
          name: character.name,
        };

        // Attach avatar URL from primary image if available
        if (character.images && character.images.length > 0) {
          const primary = character.images.find((img) => img.isPrimary) ?? character.images[0];
          if (primary) {
            agent.avatarUrl = primary.url;
          }
        }

        // Attach most recent session info if available
        const lastSession = await getSessionByCharacterId(dbUser.id, character.id);
        if (lastSession) {
          agent.lastSessionId = lastSession.id;
          agent.lastSessionTitle = lastSession.title ?? undefined;
          agent.lastSessionUpdatedAt = lastSession.updatedAt ?? undefined;
        }

        return agent;
      })
    );

    return NextResponse.json({
      agents,
      defaultAgentId: defaultCharacter?.id,
    } satisfies OverlayAgentsResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to get agents";
    if (message === "Unauthorized" || message === "Invalid session") {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    console.error("[Overlay Agents API] Error:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
