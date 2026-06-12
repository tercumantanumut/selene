import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/local-auth";
import {
  getOrCreateLocalUser,
  getSessionByCharacterId,
  createSession,
  getSession,
} from "@/lib/db/queries";
import { getCharacter } from "@/lib/characters/queries";
import { loadSettings } from "@/lib/settings/settings-manager";

interface ResolveSessionRequest {
  characterId: string;
  sessionId?: string;
  forceNew?: boolean;
}

interface ResolveSessionResponse {
  sessionId: string;
  isNew: boolean;
  title: string;
}

export async function POST(req: NextRequest) {
  try {
    const userId = await requireAuth(req);
    const settings = loadSettings();
    const dbUser = await getOrCreateLocalUser(userId, settings.localUserEmail);

    const body = await req.json() as Partial<ResolveSessionRequest>;
    const { characterId, sessionId, forceNew = false } = body;

    if (!characterId || typeof characterId !== "string") {
      return NextResponse.json({ error: "characterId is required" }, { status: 400 });
    }

    const character = await getCharacter(characterId);
    if (!character || character.userId !== dbUser.id) {
      return NextResponse.json({ error: "Character not found" }, { status: 404 });
    }

    if (!forceNew && sessionId && typeof sessionId === "string") {
      const requestedSession = await getSession(sessionId);
      if (
        requestedSession &&
        requestedSession.userId === dbUser.id &&
        requestedSession.status === "active" &&
        requestedSession.characterId === characterId
      ) {
        return NextResponse.json({
          sessionId: requestedSession.id,
          isNew: false,
          title: requestedSession.title ?? `Chat with ${character.name}`,
        } satisfies ResolveSessionResponse);
      }
    }

    if (!forceNew) {
      const existingSession = await getSessionByCharacterId(dbUser.id, characterId);
      if (existingSession) {
        return NextResponse.json({
          sessionId: existingSession.id,
          isNew: false,
          title: existingSession.title ?? `Chat with ${character.name}`,
        } satisfies ResolveSessionResponse);
      }
    }

    const newSession = await createSession({
      title: `Chat with ${character.name}`,
      userId: dbUser.id,
      metadata: { characterId, characterName: character.name },
    });

    return NextResponse.json({
      sessionId: newSession.id,
      isNew: true,
      title: newSession.title ?? `Chat with ${character.name}`,
    } satisfies ResolveSessionResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to resolve session";
    if (message === "Unauthorized" || message === "Invalid session") {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    console.error("[Overlay Resolve Session API] Error:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
