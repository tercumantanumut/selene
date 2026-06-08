import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/local-auth";
import { onDelegationCompleted } from "@/lib/background-tasks/delegation-completion-signal";
import { hasPendingDelegationCompletions } from "@/lib/ai/tools/delegation-completion-store";

type RouteParams = { params: Promise<{ id: string }> };

function encodeSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    await requireAuth(req);
    const { id: sessionId } = await params;

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

        const notifyPending = () => {
          enqueue(encodeSseEvent("delegation-completed", {
            sessionId,
            hasPending: true,
            emittedAt: Date.now(),
          }));
        };

        const unsubscribe = onDelegationCompleted(sessionId, notifyPending);
        const cleanup = () => {
          if (closed) return;
          closed = true;
          unsubscribe();
          if (heartbeat) {
            clearInterval(heartbeat);
            heartbeat = null;
          }
          try {
            controller.close();
          } catch {
            // The client may already have disconnected.
          }
        };

        req.signal.addEventListener("abort", cleanup, { once: true });
        enqueue(encodeSseEvent("connected", { sessionId }));

        if (hasPendingDelegationCompletions(sessionId)) {
          notifyPending();
        }

        heartbeat = setInterval(() => {
          enqueue(`: heartbeat ${Date.now()}\n\n`);
        }, 30_000);
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
    console.error("[delegation-events] Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
