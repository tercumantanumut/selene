import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/local-auth";
import { getSession } from "@/lib/db/queries-sessions";
import { getClaudeCodeSubagentSnapshot } from "@/lib/claudecode/subagent-activity-store";

type RouteParams = { params: Promise<{ id: string }> };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const userId = await requireAuth(req);
    const { id: sessionId } = await params;
    const session = await getSession(sessionId);
    if (!session || session.userId !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(getClaudeCodeSubagentSnapshot({ userId, sessionId }));
  } catch (error) {
    console.error("[session-claudecode-subagents] Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
