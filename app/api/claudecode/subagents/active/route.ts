import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/local-auth";
import { getClaudeCodeSubagentSnapshot } from "@/lib/claudecode/subagent-activity-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const userId = await requireAuth(req);
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("sessionId") || undefined;
    return NextResponse.json(getClaudeCodeSubagentSnapshot({ userId, sessionId }));
  } catch (error) {
    console.error("[claudecode-subagents-active] Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
