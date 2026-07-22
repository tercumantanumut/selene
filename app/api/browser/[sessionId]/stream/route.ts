/**
 * SSE endpoint for real-time browser screencast frames.
 *
 * GET /api/browser/[sessionId]/stream
 *
 * Streams JPEG frames as Server-Sent Events from the CDP screencast.
 * Each event contains a base64-encoded JPEG frame (~20-40KB at quality 40).
 * At ~3 FPS, this uses ~60-120 KB/s — well within SSE limits.
 *
 * The client connects via EventSource and renders frames on an <img> element.
 */

import { NextRequest } from "next/server";
import { subscribeToFrames, isScreencastActive, getLatestFrame } from "@/lib/browser/screencast";
import { subscribeToActions } from "@/lib/browser/action-history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Screencast SSE can run for extended browser sessions.
export const maxDuration = 86400;

/**
 * HEAD — lightweight probe to check if a screencast is active.
 * Used by BrowserBackdrop to detect when to connect.
 */
export async function HEAD(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const active = isScreencastActive(sessionId);
  return new Response(null, { status: active ? 200 : 404 });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  // Check if there's an active screencast for this session
  if (!isScreencastActive(sessionId)) {
    return new Response(
      JSON.stringify({ error: "No active browser session", sessionId }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribeFrames();
        unsubscribeActions();
        try { controller.close(); } catch { /* already closed */ }
      };

      // Send initial frame immediately if available
      const latest = getLatestFrame(sessionId);
      if (latest) {
        const event = `data: ${JSON.stringify({ data: latest.data, ts: latest.receivedAt, metadata: latest.metadata })}\n\n`;
        controller.enqueue(encoder.encode(event));
      }

      // Subscribe to future frames
      const unsubscribeFrames = subscribeToFrames(sessionId, (frame) => {
        if (closed) return;
        try {
          const event = `data: ${JSON.stringify({ data: frame.data, ts: frame.receivedAt, metadata: frame.metadata })}\n\n`;
          controller.enqueue(encoder.encode(event));
        } catch {
          cleanup();
        }
      });

      // Subscribe to action events for visual indicators
      const unsubscribeActions = subscribeToActions(sessionId, ({ record }) => {
        if (closed) return;
        try {
          const payload = {
            seq: record.seq,
            action: record.action,
            input: record.input,
            viewport: record.viewport,
            source: record.source,
            timestamp: record.timestamp,
            success: record.success,
            durationMs: record.durationMs,
          };
          const event = `event: action\ndata: ${JSON.stringify(payload)}\n\n`;
          controller.enqueue(encoder.encode(event));
        } catch {
          cleanup();
        }
      });

      // Heartbeat: detect session end and close the stream
      // Without this, the SSE connection stays open after the session closes
      // (stopScreencast clears listeners but can't close the ReadableStream controller)
      const heartbeat = setInterval(() => {
        if (!isScreencastActive(sessionId)) {
          // Session ended — send close event and terminate stream
          try {
            controller.enqueue(encoder.encode(`event: session-end\ndata: {}\n\n`));
          } catch { /* ignore */ }
          cleanup();
          return;
        }
        // Keep-alive comment to prevent proxy/CDN timeouts
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          cleanup();
        }
      }, 2000);

      // Clean up when client disconnects
      req.signal.addEventListener("abort", () => cleanup());
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
