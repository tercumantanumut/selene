import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/local-auth";
import { killTrackedBackgroundProcess } from "@/lib/background-tasks/background-process-task";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteParams = { params: Promise<{ processId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  let userId: string;
  try {
    userId = await requireAuth(request);
  } catch {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { processId } = await params;
  const result = killTrackedBackgroundProcess(processId, userId);
  if (!result.ok) {
    return Response.json({ ok: false, error: result.error }, { status: 404 });
  }

  return Response.json({ ok: true, task: result.task ?? null });
}
