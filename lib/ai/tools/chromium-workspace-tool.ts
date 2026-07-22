/**
 * Chromium Workspace Tool
 *
 * Single multi-action tool for embedded browser automation.
 * Actions: open, navigate, click, type, snapshot, extract, evaluate,
 * setViewport, resetViewport, close, replay
 *
 * Each invocation is scoped to the calling agent's sessionId via the session
 * manager. Standalone browser mode uses isolated BrowserContexts; user-chrome
 * mode intentionally shares one persistent browser profile and isolates sessions
 * at the page/tab level.
 *
 * Every action is recorded with full input/output/viewport/domSnapshot for
 * deterministic replay and audit trails.
 *
 * Observation model: accessibility tree snapshots (token-efficient,
 * deterministic, no vision model required).
 */

import { tool, jsonSchema } from "ai";
import {
  getOrCreateSession,
  closeSession,
  setBrowserSessionViewport,
  getBrowserSessionViewport,
  type BrowserSession,
} from "@/lib/browser/session-manager";
import {
  initHistory,
  recordAction,
  finalizeHistory,
  outputsMatch,
  type ReplayResult,
} from "@/lib/browser/action-history";
import {
  DEFAULT_BROWSER_VIEWPORT,
  hasBrowserViewportInput,
  listBrowserViewportPresets,
  type BrowserViewport,
  type BrowserViewportInput,
} from "@/lib/browser/viewport";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ActionType =
  | "open"
  | "navigate"
  | "click"
  | "type"
  | "snapshot"
  | "extract"
  | "evaluate"
  | "setViewport"
  | "resetViewport"
  | "close"
  | "replay";

export interface ChromiumWorkspaceInput extends BrowserViewportInput {
  action: ActionType;
  /** URL to navigate to (open, navigate) */
  url?: string;
  /** CSS selector for element interaction (click, type, extract) */
  selector?: string;
  /** Text to type (type action) */
  text?: string;
  /** JavaScript expression to evaluate (evaluate action) */
  expression?: string;
  /** Timeout in ms for navigation/element waits (default: 30000) */
  timeout?: number;
  /** JSON-stringified execution history to replay (replay action) */
  history?: string;
}

interface ReplayHistoryInput {
  actions: Array<{
    action: string;
    input: Record<string, unknown>;
    expectedOutput?: unknown;
  }>;
  /** Max retries per failed action (default: 1) */
  maxRetries?: number;
  /** Skip actions that fail instead of aborting (default: false) */
  skipFailures?: boolean;
  /** Delay between actions in ms (default: 500) */
  delayBetweenActions?: number;
  /** Verify that outputs match expected (default: false) */
  verifyOutputs?: boolean;
}

interface ActionResult {
  data: unknown;
  pageUrl?: string;
  pageTitle?: string;
  viewport?: BrowserViewport;
  /** Accessibility snapshot captured after action (for history) */
  domSnapshot?: string;
}

// Actions that mutate page state — we capture a snapshot after these
const SNAPSHOT_ACTIONS: Set<string> = new Set([
  "open", "navigate", "click", "type",
]);

// ─── Tool Factory ─────────────────────────────────────────────────────────────

export function createChromiumWorkspaceTool(options: {
  sessionId: string;
  agentId?: string;
}) {
  const { sessionId, agentId } = options;
  const viewportPresetNames = listBrowserViewportPresets();

  return tool({
    description: `Embedded Chromium workspace for browser automation. Single tool, multiple actions.

**Actions:**
- \`open\`: Launch a browser session and navigate to a URL. \`{ action: "open", url: "https://example.com" }\`
- \`navigate\`: Navigate the current page to a new URL. \`{ action: "navigate", url: "https://..." }\`
- \`click\`: Click an element by CSS selector. \`{ action: "click", selector: "button.submit" }\`
- \`type\`: Type text into an input element. \`{ action: "type", selector: "input[name=q]", text: "search query" }\`
- \`snapshot\`: Get an accessibility tree snapshot of the current page (token-efficient observation).
- \`extract\`: Extract text content from an element. \`{ action: "extract", selector: ".content" }\`
- \`evaluate\`: Execute JavaScript in the page context. \`{ action: "evaluate", expression: "document.title" }\`
- \`setViewport\`: Set the active browser viewport. \`{ action: "setViewport", viewportPreset: "mobile", orientation: "portrait" }\`
- \`resetViewport\`: Reset to the default desktop viewport. \`{ action: "resetViewport" }\`
- \`close\`: Close the browser session and return full execution history.
- \`replay\`: Re-execute a recorded action history with optional output verification.

**Responsive viewport controls:** Pass viewport options directly on \`open\`, \`navigate\`, \`snapshot\`, \`extract\`, \`evaluate\`, \`click\`, or \`type\` and they are applied before the action runs. Use \`viewportWidth\` + \`viewportHeight\` for custom CSS pixel dimensions, \`orientation\` for \`portrait\`/\`landscape\`, \`viewportPreset\` for common devices (${viewportPresetNames.join(", ")}), or \`resetViewport: true\` to restore desktop.

**Examples:**
- Mobile portrait open: \`{ action: "open", url: "https://example.com", viewportPreset: "mobile", orientation: "portrait" }\`
- Tablet landscape inspect: \`{ action: "snapshot", viewportPreset: "tablet", orientation: "landscape" }\`
- Custom size: \`{ action: "setViewport", viewportWidth: 1024, viewportHeight: 768 }\`

**Isolation:** Standalone browser mode gives each agent session its own sandboxed browser context (cookies, storage, service workers are isolated). User-chrome mode shares the persistent browser profile and isolates sessions at the page/tab level.
**Observation:** Use \`snapshot\` to observe page state — returns structured accessibility data, not screenshots.
**History:** Every action is recorded with input, output, viewport, and DOM snapshot for replay.
**Replay:** Use \`close\` to get a history, then \`replay\` to deterministically re-execute it.`,

    inputSchema: jsonSchema<ChromiumWorkspaceInput>({
      type: "object",
      title: "ChromiumWorkspaceInput",
      properties: {
        action: {
          type: "string",
          enum: [
            "open", "navigate", "click", "type",
            "snapshot", "extract", "evaluate", "setViewport", "resetViewport", "close", "replay",
          ],
          description: "The browser action to perform",
        },
        url: {
          type: "string",
          description: "URL to navigate to (required for open/navigate)",
        },
        selector: {
          type: "string",
          description: "CSS selector for the target element (required for click/type/extract)",
        },
        text: {
          type: "string",
          description: "Text to type into the element (required for type)",
        },
        expression: {
          type: "string",
          description: "JavaScript expression to evaluate in page context (required for evaluate)",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default: 30000)",
        },
        viewportPreset: {
          type: "string",
          enum: viewportPresetNames,
          description: "Common responsive viewport preset. Can be used with open/navigate/snapshot/extract/evaluate/click/type or action=setViewport. Available presets include mobile, tablet, ipad, ipad-pro, iphone-se, iphone-14, pixel-7, desktop, desktop-wide.",
        },
        viewportWidth: {
          type: "number",
          description: "Custom viewport width in CSS pixels (100-10000). Can be combined with viewportHeight and orientation.",
        },
        viewportHeight: {
          type: "number",
          description: "Custom viewport height in CSS pixels (100-10000). Can be combined with viewportWidth and orientation.",
        },
        orientation: {
          type: "string",
          enum: ["portrait", "landscape"],
          description: "Viewport orientation. If the selected/custom dimensions are in the opposite orientation, width and height are swapped before the action runs.",
        },
        resetViewport: {
          type: "boolean",
          description: "Reset the current session to the default desktop viewport before running this action. Equivalent to action=resetViewport when used alone.",
        },
        history: {
          type: "string",
          description: "JSON-stringified execution history for replay. Shape: { actions: [{ action, input, expectedOutput? }], maxRetries?: number, skipFailures?: boolean, delayBetweenActions?: number, verifyOutputs?: boolean }. Get this from a previous 'close' action result.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    }),

    execute: async (input: ChromiumWorkspaceInput) => {
      if (sessionId === "UNSCOPED") {
        return {
          status: "error" as const,
          error: "chromiumWorkspace requires an active session.",
        };
      }

      const startTime = Date.now();
      const { action, timeout = 30_000 } = input;

      try {
        const result = await executeAction(sessionId, input, timeout, agentId);
        const durationMs = Date.now() - startTime;

        recordAction(sessionId, action, sanitizeInput(input), {
          success: true,
          durationMs,
          output: result.data,
          viewport: result.viewport,
          pageUrl: result.pageUrl,
          pageTitle: result.pageTitle,
          domSnapshot: result.domSnapshot,
          source: "agent",
        });

        return {
          status: "success" as const,
          action,
          durationMs,
          data: result.data,
          pageUrl: result.pageUrl,
          pageTitle: result.pageTitle,
          viewport: result.viewport,
        };
      } catch (err) {
        const durationMs = Date.now() - startTime;
        const errorMsg = err instanceof Error ? err.message : String(err);

        recordAction(sessionId, action, sanitizeInput(input), {
          success: false,
          durationMs,
          viewport: getBrowserSessionViewport(sessionId) ?? undefined,
          error: errorMsg,
          source: "agent",
        });

        return { status: "error" as const, action, durationMs, error: errorMsg };
      }
    },
  });
}

// ─── Action router ────────────────────────────────────────────────────────────

/**
 * Execute a single browser action in a session.
 * Exported for use by the replay API endpoint.
 */
export async function executeAction(
  sessionId: string,
  input: ChromiumWorkspaceInput,
  timeout: number,
  agentId?: string
): Promise<ActionResult> {
  const { action } = input;

  let result: ActionResult;

  switch (action) {
    case "open":
      result = await handleOpen(sessionId, input, timeout, agentId);
      break;
    case "navigate":
      result = await handleNavigate(sessionId, input, timeout);
      break;
    case "click":
      result = await handleClick(sessionId, input, timeout);
      break;
    case "type":
      result = await handleType(sessionId, input, timeout);
      break;
    case "snapshot":
      result = await handleSnapshot(sessionId, input);
      break;
    case "extract":
      result = await handleExtract(sessionId, input, timeout);
      break;
    case "evaluate":
      result = await handleEvaluate(sessionId, input, timeout);
      break;
    case "setViewport":
      result = await handleSetViewport(sessionId, input);
      break;
    case "resetViewport":
      result = await handleResetViewport(sessionId);
      break;
    case "close":
      result = await handleClose(sessionId);
      break;
    case "replay":
      result = await handleReplay(sessionId, input, timeout, agentId);
      break;
    default:
      throw new Error(`Unknown action: ${action}`);
  }

  // Auto-capture DOM snapshot after mutating actions (for replay verification)
  if (SNAPSHOT_ACTIONS.has(action) && !result.domSnapshot) {
    result.domSnapshot = await captureSnapshot(sessionId);
  }

  return result;
}

// ─── Action handlers ──────────────────────────────────────────────────────────

async function handleOpen(
  sessionId: string,
  input: ChromiumWorkspaceInput,
  timeout: number,
  agentId?: string
): Promise<ActionResult> {
  if (!input.url) throw new Error("'url' is required for the 'open' action");

  initHistory(sessionId, agentId);
  const session = await getOrCreateSession(sessionId, input);

  await session.page.goto(input.url, {
    waitUntil: "domcontentloaded",
    timeout,
  });

  return {
    data: `Browser session opened. Navigated to: ${input.url}`,
    pageUrl: session.page.url(),
    pageTitle: await session.page.title(),
    viewport: session.viewport,
  };
}

async function handleNavigate(
  sessionId: string,
  input: ChromiumWorkspaceInput,
  timeout: number
): Promise<ActionResult> {
  if (!input.url) throw new Error("'url' is required for the 'navigate' action");

  const session = await getSessionOrThrow(sessionId, input);

  await session.page.goto(input.url, {
    waitUntil: "domcontentloaded",
    timeout,
  });

  return {
    data: `Navigated to: ${input.url}`,
    pageUrl: session.page.url(),
    pageTitle: await session.page.title(),
    viewport: session.viewport,
  };
}

async function handleClick(
  sessionId: string,
  input: ChromiumWorkspaceInput,
  timeout: number
): Promise<ActionResult> {
  if (!input.selector) throw new Error("'selector' is required for the 'click' action");

  const session = await getSessionOrThrow(sessionId, input);

  await session.page.waitForSelector(input.selector, { timeout });
  await session.page.click(input.selector);

  // Brief wait for any navigation or re-render
  await session.page.waitForLoadState("domcontentloaded").catch(() => {});

  return {
    data: `Clicked element: ${input.selector}`,
    pageUrl: session.page.url(),
    pageTitle: await session.page.title(),
    viewport: session.viewport,
  };
}

async function handleType(
  sessionId: string,
  input: ChromiumWorkspaceInput,
  timeout: number
): Promise<ActionResult> {
  if (!input.selector) throw new Error("'selector' is required for the 'type' action");
  if (!input.text) throw new Error("'text' is required for the 'type' action");

  const session = await getSessionOrThrow(sessionId, input);

  await session.page.waitForSelector(input.selector, { timeout });
  await session.page.fill(input.selector, input.text);

  return {
    data: `Typed "${input.text.slice(0, 50)}${input.text.length > 50 ? "..." : ""}" into ${input.selector}`,
    pageUrl: session.page.url(),
    pageTitle: await session.page.title(),
    viewport: session.viewport,
  };
}

async function handleSnapshot(
  sessionId: string,
  input: ChromiumWorkspaceInput
): Promise<ActionResult> {
  const session = await getSessionOrThrow(sessionId, input);

  const snapshot = await session.page.locator("body").ariaSnapshot();
  const pageUrl = session.page.url();
  const pageTitle = await session.page.title();

  return {
    data: {
      url: pageUrl,
      title: pageTitle,
      viewport: session.viewport,
      accessibilityTree: snapshot,
    },
    pageUrl,
    pageTitle,
    viewport: session.viewport,
    // snapshot action itself IS the domSnapshot
    domSnapshot: snapshot,
  };
}

async function handleExtract(
  sessionId: string,
  input: ChromiumWorkspaceInput,
  timeout: number
): Promise<ActionResult> {
  if (!input.selector) throw new Error("'selector' is required for the 'extract' action");

  const session = await getSessionOrThrow(sessionId, input);

  await session.page.waitForSelector(input.selector, { timeout });
  const textContent = await session.page.$eval(input.selector, (el) => el.textContent ?? "");

  const truncated = textContent.length > 5000
    ? textContent.slice(0, 5000) + `\n\n[... truncated, ${textContent.length} total chars]`
    : textContent;

  return {
    data: truncated,
    pageUrl: session.page.url(),
    pageTitle: await session.page.title(),
    viewport: session.viewport,
  };
}

async function handleEvaluate(
  sessionId: string,
  input: ChromiumWorkspaceInput,
  timeout: number = 60_000
): Promise<ActionResult> {
  if (!input.expression) throw new Error("'expression' is required for the 'evaluate' action");

  const session = await getSessionOrThrow(sessionId, input);

  // Apply a timeout to prevent indefinite blocking from long-running
  // expressions (e.g., those with setTimeout delays for audio playback).
  // Default is 60s (higher than other actions) since evaluate() is
  // commonly used for async operations.
  const evaluateTimeout = Math.max(timeout, 60_000);
  const result = await Promise.race([
    session.page.evaluate((expr: string) => {
      // eslint-disable-next-line no-eval
      return eval(expr);
    }, input.expression),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`evaluate() timed out after ${evaluateTimeout}ms`)),
        evaluateTimeout
      )
    ),
  ]);

  const serialized = typeof result === "string"
    ? result
    : JSON.stringify(result, null, 2);

  return {
    data: serialized?.slice(0, 5000) ?? null,
    pageUrl: session.page.url(),
    pageTitle: await session.page.title(),
    viewport: session.viewport,
  };
}

async function handleSetViewport(
  sessionId: string,
  input: ChromiumWorkspaceInput
): Promise<ActionResult> {
  if (!hasBrowserViewportInput(input)) {
    throw new Error("setViewport requires viewportPreset, viewportWidth/viewportHeight, orientation, or resetViewport");
  }

  const viewport = await setBrowserSessionViewport(sessionId, input);
  const session = await getSessionOrThrow(sessionId);

  return {
    data: {
      message: `Viewport set to ${viewport.width}×${viewport.height} (${viewport.orientation})`,
      viewport,
    },
    pageUrl: session.page.url(),
    pageTitle: await session.page.title(),
    viewport,
  };
}

async function handleResetViewport(
  sessionId: string
): Promise<ActionResult> {
  const viewport = await setBrowserSessionViewport(sessionId, { resetViewport: true });
  const session = await getSessionOrThrow(sessionId);

  return {
    data: {
      message: `Viewport reset to default desktop ${viewport.width}×${viewport.height}`,
      viewport,
    },
    pageUrl: session.page.url(),
    pageTitle: await session.page.title(),
    viewport,
  };
}

async function handleClose(
  sessionId: string
): Promise<ActionResult> {
  const viewport = getBrowserSessionViewport(sessionId) ?? DEFAULT_BROWSER_VIEWPORT;
  const history = finalizeHistory(sessionId);
  await closeSession(sessionId);

  return {
    data: {
      message: "Browser session closed",
      viewport,
      history: history
        ? {
            sessionId: history.sessionId,
            agentId: history.agentId,
            startedAt: history.startedAt,
            endedAt: history.endedAt,
            totalDurationMs: history.totalDurationMs,
            totalActions: history.actions.length,
            successfulActions: history.actions.filter((a) => a.success).length,
            failedActions: history.actions.filter((a) => !a.success).length,
            actions: history.actions,
          }
        : null,
    },
    viewport,
  };
}

async function handleReplay(
  sessionId: string,
  input: ChromiumWorkspaceInput,
  timeout: number,
  agentId?: string
): Promise<ActionResult> {
  if (!input.history) {
    throw new Error("'history' JSON string is required for the 'replay' action");
  }

  let parsed: ReplayHistoryInput;
  try {
    parsed = JSON.parse(input.history);
  } catch {
    throw new Error("'history' must be a valid JSON string");
  }

  if (!parsed.actions?.length) {
    throw new Error("'history.actions' array is required for the 'replay' action");
  }

  const {
    actions,
    maxRetries = 1,
    skipFailures = false,
    delayBetweenActions = 500,
    verifyOutputs = false,
  } = parsed;

  const results: ReplayResult[] = [];
  let aborted = false;

  for (const step of actions) {
    if (aborted) break;

    // Skip close/replay actions during replay
    if (step.action === "close" || step.action === "replay") continue;

    let lastError: string | undefined;
    let replayOutput: unknown = null;
    let success = false;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Build the input for this action. Keep the replay plan action authoritative.
        const sanitizedStepInput = { ...step.input };
        delete sanitizedStepInput.action;
        const stepInput = {
          ...sanitizedStepInput,
          action: step.action as ActionType,
          timeout,
        } as ChromiumWorkspaceInput;

        const result = await executeAction(sessionId, stepInput, timeout, agentId);
        replayOutput = result.data;
        success = true;
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < maxRetries) {
          await sleep(delayBetweenActions);
        }
      }
    }

    const matchResult = verifyOutputs && step.expectedOutput != null
      ? outputsMatch(step.expectedOutput, replayOutput)
      : true;

    results.push({
      action: step.action,
      seq: results.length + 1,
      originalOutput: step.expectedOutput ?? null,
      replayOutput,
      outputMatches: matchResult,
      success,
      error: lastError,
    });

    if (!success && !skipFailures) {
      aborted = true;
    }

    // Delay between actions for page stability
    if (!aborted) {
      await sleep(delayBetweenActions);
    }
  }

  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;
  const verifyCount = verifyOutputs
    ? results.filter((r) => r.outputMatches).length
    : null;

  const viewport = getBrowserSessionViewport(sessionId) ?? DEFAULT_BROWSER_VIEWPORT;

  return {
    data: {
      message: aborted
        ? `Replay aborted after ${results.length} actions`
        : `Replay completed: ${successCount} succeeded, ${failCount} failed`,
      totalActions: results.length,
      successfulActions: successCount,
      failedActions: failCount,
      outputMatchCount: verifyCount,
      aborted,
      viewport,
      results,
    },
    viewport,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getSessionOrThrow(
  sessionId: string,
  viewportInput?: BrowserViewportInput
): Promise<BrowserSession> {
  const session = await getOrCreateSession(sessionId, viewportInput);
  if (!session) {
    throw new Error(
      `No active browser session for this agent. Use action "open" with a URL to start one.`
    );
  }
  return session;
}

/**
 * Capture an accessibility snapshot for history recording.
 * Best-effort — returns undefined on failure (doesn't break the action).
 */
async function captureSnapshot(sessionId: string): Promise<string | undefined> {
  try {
    const session = await getOrCreateSession(sessionId);
    return await session.page.locator("body").ariaSnapshot();
  } catch {
    return undefined;
  }
}

/** Strip potentially large fields from input before recording */
function sanitizeInput(input: ChromiumWorkspaceInput): Record<string, unknown> {
  const params: Record<string, unknown> = { action: input.action };
  if (input.url) params.url = input.url;
  if (input.selector) params.selector = input.selector;
  if (input.text) params.text = input.text.slice(0, 200);
  if (input.expression) params.expression = input.expression.slice(0, 200);
  if (input.timeout) params.timeout = input.timeout;
  if (input.viewportPreset) params.viewportPreset = input.viewportPreset;
  if (input.viewportWidth != null) params.viewportWidth = input.viewportWidth;
  if (input.viewportHeight != null) params.viewportHeight = input.viewportHeight;
  if (input.orientation) params.orientation = input.orientation;
  if (input.resetViewport === true) params.resetViewport = true;
  return params;
}
