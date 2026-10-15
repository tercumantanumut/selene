import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/local-auth";
import { getOrCreateLocalUser } from "@/lib/db/queries";
import { loadSettings } from "@/lib/settings/settings-manager";
import { getSkillTelemetryCounters, trackSkillTelemetryEvent } from "@/lib/skills/telemetry";

const telemetrySchema = z.object({
  eventType: z.enum([
    "skill_auto_triggered",
    "skill_manual_run",
    "skill_copy_succeeded",
    "skill_copy_failed",
    "skill_library_opened",
    "skill_library_filtered",
    "skill_library_zero_results",
    "skill_detail_viewed",
    "skill_update_succeeded",
    "skill_update_stale",
    "skill_dashboard_loaded",
  ]),
  characterId: z.string().optional(),
  skillId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const userId = await requireAuth(req);
    const settings = loadSettings();
    const dbUser = await getOrCreateLocalUser(userId, settings.localUserEmail);

    const body = await req.json();
    const parsed = telemetrySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
    }

    await trackSkillTelemetryEvent({
      userId: dbUser.id,
      eventType: parsed.data.eventType,
      characterId: parsed.data.characterId,
      skillId: parsed.data.skillId,
      metadata: parsed.data.metadata,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to record telemetry" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const userId = await requireAuth(req);
    const settings = loadSettings();
    const dbUser = await getOrCreateLocalUser(userId, settings.localUserEmail);
    const hoursRaw = req.nextUrl.searchParams.get("hours");
    const hours = hoursRaw ? Number.parseInt(hoursRaw, 10) : 24;

    const counters = await getSkillTelemetryCounters(dbUser.id, Number.isFinite(hours) ? hours : 24);
    return NextResponse.json(counters);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to load telemetry" }, { status: 500 });
  }
}