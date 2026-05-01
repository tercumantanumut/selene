import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/local-auth";
import { hasPendingDelegationCompletions } from "@/lib/ai/tools/delegation-completion-store";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: RouteParams) {
  try {
    await requireAuth(req);
    const { id: sessionId } = await params;
    return NextResponse.json({
      hasPending: hasPendingDelegationCompletions(sessionId),
    });
  } catch (error) {
    console.error("[delegation-completions] Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
