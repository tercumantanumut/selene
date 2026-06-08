import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/local-auth";
import { getSession } from "@/lib/db/queries-sessions";
import {
  getClaudeCodeSubagentSnapshot,
  subscribeToClaudeCodeSubagentActivity,
} from "@/lib/claudecode/subagent-activity-store";

type RouteParams = { params: Promise<{ id: string }> };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function encodeSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const userId = await requireAuth(req);
    const { id: sessionId } = await params;
    const session = await getSession(sessionId);
    if (!session || session.userId !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        const enqueue = (chunk: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            closed = true;
          }
        };

        const unsubscribe = subscribeToClaudeCodeSubagentActivity({ userId, sessionId }, (event, activity) => {
          enqueue(encodeSseEvent(event.type, { event, activity }));
        });
        const cleanup = () => {
          if (closed) return;
          closed = true;
          unsubscribe();
          if (heartbeat) clearInterval(heartbeat);
          try {
            controller.close();
          } catch {
            // The client may already have disconnected.
          }
        };

        req.signal.addEventListener("abort", cleanup, { once: true });
        enqueue(encodeSseEvent("connected", { sessionId }));
        enqueue(encodeSseEvent("snapshot", getClaudeCodeSubagentSnapshot({ userId, sessionId })));
        heartbeat = setInterval(() => enqueue(`: heartbeat ${Date.now()}\n\n`), 30_000);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("[session-claudecode-subagents-events] Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
