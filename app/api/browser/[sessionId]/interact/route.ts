/**
 * POST /api/browser/[sessionId]/interact
 *
 * Receives user interactions from the browser session viewer and forwards
 * them to the Playwright page via CDP input dispatch. Records each
 * interaction in the action history with source: "user".
 *
 * Supported interaction types:
 *  - click: { type: "click", x, y, button?, clickCount? }
 *  - type: { type: "type", text }
 *  - keypress: { type: "keypress", key, modifiers? }
 *  - scroll: { type: "scroll", x, y, deltaX, deltaY }
 *  - navigate: { type: "navigate", url }
 */

import { NextRequest, NextResponse } from "next/server";
import { getBrowserSession } from "@/lib/browser/session-manager";
import { recordAction, initHistory } from "@/lib/browser/action-history";
import {
  dispatchClick,
  dispatchType,
  dispatchKeyPress,
  dispatchScroll,
} from "@/lib/browser/input-dispatcher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface InteractionPayload {
  type: "click" | "type" | "keypress" | "scroll" | "navigate";
  // click
  x?: number;
  y?: number;
  button?: "left" | "right" | "middle";
  clickCount?: number;
  // type
  text?: string;
  // keypress
  key?: string;
  modifiers?: number;
  // scroll
  deltaX?: number;
  deltaY?: number;
  // navigate
  url?: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  // Verify request is from same origin (prevent external CSRF)
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host && !origin.includes(host.split(":")[0])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { sessionId } = await params;

  const session = getBrowserSession(sessionId);
  if (!session) {
    return NextResponse.json(
      { error: "No active browser session", sessionId },
      { status: 404 }
    );
  }

  let payload: InteractionPayload;
  try {
    payload = await req.json() as InteractionPayload;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  if (!payload.type) {
    return NextResponse.json(
      { error: "Missing 'type' field" },
      { status: 400 }
    );
  }

  // Input size limits
  if (payload.text && payload.text.length > 5000) {
    return NextResponse.json(
      { error: "Text input exceeds 5000 character limit" },
      { status: 400 }
    );
  }
  if (payload.url && payload.url.length > 8192) {
    return NextResponse.json(
      { error: "URL exceeds maximum length" },
      { status: 400 }
    );
  }

  // Ensure history is initialized (may not be if session was created by another path)
  initHistory(sessionId);

  const startTime = Date.now();
  // `session` is guaranteed non-null here (guarded above), capture for closure use
  const activeSession = session;

  async function capturePageState(): Promise<{ pageUrl: string; pageTitle: string }> {
    return {
      pageUrl: activeSession.page.url(),
      pageTitle: await activeSession.page.title(),
    };
  }

  try {
    let actionDescription: string;
    let pageUrl: string | undefined;
    let pageTitle: string | undefined;

    switch (payload.type) {
      case "click": {
        if (payload.x == null || payload.y == null) {
          return NextResponse.json({ error: "click requires x and y" }, { status: 400 });
        }
        await dispatchClick(sessionId, session.page, payload.x, payload.y, {
          button: payload.button,
          clickCount: payload.clickCount,
        });
        actionDescription = `User clicked at (${Math.round(payload.x)}, ${Math.round(payload.y)})`;
        break;
      }

      case "type": {
        if (!payload.text) {
          return NextResponse.json({ error: "type requires text" }, { status: 400 });
        }
        await dispatchType(sessionId, session.page, payload.text);
        actionDescription = `User typed "${payload.text.slice(0, 50)}${payload.text.length > 50 ? "..." : ""}"`;
        break;
      }

      case "keypress": {
        if (!payload.key) {
          return NextResponse.json({ error: "keypress requires key" }, { status: 400 });
        }
        await dispatchKeyPress(sessionId, session.page, payload.key, {
          modifiers: payload.modifiers,
        });
        actionDescription = `User pressed ${payload.key}`;
        break;
      }

      case "scroll": {
        if (payload.x == null || payload.y == null || payload.deltaX == null || payload.deltaY == null) {
          return NextResponse.json({ error: "scroll requires x, y, deltaX, deltaY" }, { status: 400 });
        }
        await dispatchScroll(sessionId, session.page, payload.x, payload.y, payload.deltaX, payload.deltaY);
        actionDescription = `User scrolled at (${Math.round(payload.x)}, ${Math.round(payload.y)})`;
        break;
      }

      case "navigate": {
        if (!payload.url) {
          return NextResponse.json({ error: "navigate requires url" }, { status: 400 });
        }
        // Validate URL scheme — only allow http/https
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(payload.url);
        } catch {
          return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
        }
        if (!["http:", "https:"].includes(parsedUrl.protocol)) {
          return NextResponse.json(
            { error: `URL scheme "${parsedUrl.protocol}" not allowed. Use http:// or https://` },
            { status: 400 }
          );
        }
        // Block cloud metadata / internal addresses (but allow localhost for local dev)
        const hostname = parsedUrl.hostname;
        if (
          hostname === "169.254.169.254" ||
          hostname === "metadata.google.internal" ||
          hostname === "0.0.0.0"
        ) {
          return NextResponse.json(
            { error: "Navigation to internal addresses is not allowed" },
            { status: 400 }
          );
        }
        // Use Playwright's goto for proper navigation (handles redirects, waits for load)
        await session.page.goto(payload.url, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        actionDescription = `User navigated to ${payload.url}`;
        break;
      }

      default:
        return NextResponse.json(
          { error: `Unknown interaction type: ${payload.type}` },
          { status: 400 }
        );
    }

    ({ pageUrl, pageTitle } = await capturePageState());
    const durationMs = Date.now() - startTime;

    // Record in action history with source: "user"
    recordAction(sessionId, payload.type, payload as unknown as Record<string, unknown>, {
      success: true,
      durationMs,
      output: actionDescription,
      viewport: activeSession.viewport,
      pageUrl,
      pageTitle,
      source: "user",
    });

    return NextResponse.json({
      success: true,
      action: payload.type,
      durationMs,
      description: actionDescription,
      pageUrl,
      pageTitle,
    });
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);

    recordAction(sessionId, payload.type, payload as unknown as Record<string, unknown>, {
      success: false,
      durationMs,
      viewport: activeSession.viewport,
      error: errorMsg,
      source: "user",
    });

    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 500 }
    );
  }
}
