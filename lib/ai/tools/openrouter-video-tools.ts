/**
 * OpenRouter video-generation tool.
 *
 * Uses the async /api/v1/videos endpoint: submit → poll → return result.
 * The agent calls action="generate" to kick off a video and action="check"
 * to poll an existing job.  A single call with action="generate" will also
 * poll inline for up to ~5 minutes so the agent gets the final result
 * without needing a second tool call.
 */

import { tool } from "ai";
import { createToolRun, updateToolRun, createImage } from "@/lib/db/queries";
import { withToolLogging } from "@/lib/ai/tool-registry/logging";
import {
  openRouterVideoSchema,
  openRouterVideoModelSchema,
  OPENROUTER_VIDEO_MODELS,
  type OpenRouterVideoInput,
  type OpenRouterVideoModelInput,
  type OpenRouterVideoResult,
} from "@/lib/ai/tools/openrouter-video-schemas";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VideoJob {
  id: string;
  polling_url: string;
}

interface VideoPollResponse {
  status: "processing" | "completed" | "failed";
  unsigned_urls?: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_BASE = "https://openrouter.ai/api/v1";
const API_KEY = () => process.env.OPENROUTER_API_KEY!;

const now = (): string => new Date().toISOString();

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${API_KEY()}`,
    "Content-Type": "application/json",
    "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL || "https://selene.engineer",
    "X-Title": "Selene",
  };
}

// ---------------------------------------------------------------------------
// Submit a video generation request
// ---------------------------------------------------------------------------

async function submitVideoJob(args: OpenRouterVideoInput): Promise<VideoJob> {
  const body: Record<string, unknown> = {
    model: args.model,
    prompt: args.prompt,
  };
  // Image-to-video (action="animate")
  if (args.image_url) body.image_url = args.image_url;
  // Reference-to-video (action="reference")
  if (args.reference_image_urls?.length) body.reference_image_urls = args.reference_image_urls;
  // Frame-to-video controls
  if (args.first_frame_url) body.first_frame_url = args.first_frame_url;
  if (args.last_frame_url) body.last_frame_url = args.last_frame_url;
  // Optional params
  if (args.duration) body.duration = args.duration;
  if (args.aspect_ratio) body.aspect_ratio = args.aspect_ratio;

  const response = await fetch(`${API_BASE}/videos`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(err.error?.message || `HTTP ${response.status}`);
  }

  return (await response.json()) as VideoJob;
}

// ---------------------------------------------------------------------------
// Poll for job completion
// ---------------------------------------------------------------------------

async function pollVideoJob(
  pollingUrl: string,
  maxAttempts = 60,
  intervalMs = 5000,
): Promise<VideoPollResponse> {
  for (let i = 0; i < maxAttempts; i++) {
    const response = await fetch(pollingUrl, {
      headers: { Authorization: `Bearer ${API_KEY()}` },
    });

    if (!response.ok) {
      // Parse error body like submitVideoJob does, preserving provider diagnostics
      let errorMsg = `Polling failed: HTTP ${response.status}`;
      try {
        const err = await response.json() as { error?: { message?: string } };
        if (err.error?.message) errorMsg = `Polling failed (${response.status}): ${err.error.message}`;
      } catch {
        const text = await response.text().catch(() => "");
        if (text) errorMsg = `Polling failed (${response.status}): ${text.slice(0, 200)}`;
      }
      throw new Error(errorMsg);
    }

    const data = (await response.json()) as VideoPollResponse;

    if (data.status === "completed" || data.status === "failed") {
      return data;
    }

    // Still processing — wait before next attempt
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return { status: "failed", error: `Video generation timed out after ${(maxAttempts * intervalMs) / 1000} seconds` };
}

// ---------------------------------------------------------------------------
// Core execution
// ---------------------------------------------------------------------------

async function executeOpenRouterVideo(
  sessionId: string,
  args: OpenRouterVideoInput,
  toolName = "openRouterVideo",
): Promise<OpenRouterVideoResult> {
  const toolRun = await createToolRun({
    sessionId,
    toolName,
    args: args as unknown as Record<string, unknown>,
    status: "running",
  });

  try {
    // --- action: "check" — poll an existing job -------------------------
    if (args.action === "check") {
      // Security: validate polling_url origin to prevent API key exfiltration.
      // Only accept OpenRouter URLs; reject user-controlled external endpoints.
      let pollingUrl: string | null = null;
      if (args.polling_url) {
        const parsed = new URL(args.polling_url);
        if (parsed.origin !== "https://openrouter.ai") {
          throw new Error("Invalid polling_url: must be an OpenRouter URL (https://openrouter.ai)");
        }
        if (parsed.protocol !== "https:") {
          throw new Error("Invalid polling_url: must use HTTPS");
        }
        pollingUrl = args.polling_url;
      } else if (args.job_id) {
        pollingUrl = `${API_BASE}/videos/${args.job_id}`;
      }

      if (!pollingUrl) {
        throw new Error("action=check requires job_id or polling_url from a previous generate call");
      }

      const result = await pollVideoJob(pollingUrl);

      if (result.status === "failed" || !result.unsigned_urls?.length) {
        throw new Error(result.error || "Video generation failed — no output URLs");
      }

      const videoUrls = result.unsigned_urls;
      for (const url of videoUrls) {
        await createImage({
          sessionId,
          toolRunId: toolRun.id,
          role: "generated",
          url,
          localPath: url,
          format: "mp4",
          metadata: {
            prompt: args.prompt,
            mediaType: "video",
            provider: "openrouter",
            model: args.model,
          },
        });
      }

      await updateToolRun(toolRun.id, {
        status: "succeeded",
        result: { videos: videoUrls.map((url) => ({ url })) },
        completedAt: now(),
      });

      return { status: "completed", videoUrls };
    }

    // --- action: "generate" — submit + poll inline -----------------------
    const job = await submitVideoJob(args);

    await updateToolRun(toolRun.id, {
      metadata: { jobId: job.id, pollingUrl: job.polling_url },
    });

    const result = await pollVideoJob(job.polling_url);

    if (result.status === "failed" || !result.unsigned_urls?.length) {
      throw new Error(result.error || "Video generation failed — no output URLs");
    }

    const videoUrls = result.unsigned_urls;
    let savedCount = 0;
    for (const url of videoUrls) {
      try {
        await createImage({
          sessionId,
          toolRunId: toolRun.id,
          role: "generated",
          url,
          localPath: url,
          format: "mp4",
          metadata: {
            prompt: args.prompt,
            mediaType: "video",
            provider: "openrouter",
            model: args.model,
          },
        });
        savedCount++;
      } catch (saveErr) {
        console.warn(`[OpenRouter Video] Failed to save video ${url}:`, saveErr);
      }
    }

    if (savedCount === 0 && videoUrls.length > 0) {
      throw new Error("Video generation succeeded but failed to persist any videos");
    }

    await updateToolRun(toolRun.id, {
      status: "succeeded",
      result: { videos: videoUrls.map((url) => ({ url })), savedCount, totalCount: videoUrls.length },
      completedAt: now(),
    });

    return { status: "completed", videoUrls, jobId: job.id, pollingUrl: job.polling_url };

  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    await updateToolRun(toolRun.id, {
      status: "failed",
      error: msg,
      completedAt: now(),
    });
    return { status: "error", error: msg };
  }
}

interface VideoModelToolConfig {
  toolName: string;
  displayName: string;
  model: string;
  capabilitySummary: string;
  supportedActions: string;
}

const VIDEO_MODEL_DESCRIPTORS: VideoModelToolConfig[] = [
  {
    toolName: "openRouterVideoGrokImagine",
    displayName: "OpenRouter Video — Grok Imagine",
    model: OPENROUTER_VIDEO_MODELS.GROK_IMAGINE_VIDEO,
    capabilitySummary: "text-to-video, image-to-video, and reference-to-video; 1-15s at 24fps.",
    supportedActions: "generate, animate, reference, check",
  },
  {
    toolName: "openRouterVideoKlingV3Pro",
    displayName: "OpenRouter Video — Kling v3.0 Pro",
    model: OPENROUTER_VIDEO_MODELS.KLING_V3_PRO,
    capabilitySummary: "premium text/image video with first-frame and last-frame controls, 3-15s, optional audio.",
    supportedActions: "generate, animate, check; first_frame_url and last_frame_url supported",
  },
  {
    toolName: "openRouterVideoKlingV3Standard",
    displayName: "OpenRouter Video — Kling v3.0 Standard",
    model: OPENROUTER_VIDEO_MODELS.KLING_V3_STANDARD,
    capabilitySummary: "balanced text/image video with first-frame and last-frame controls, 3-15s.",
    supportedActions: "generate, animate, check; first_frame_url and last_frame_url supported",
  },
  {
    toolName: "openRouterVideoKlingO1",
    displayName: "OpenRouter Video — Kling O1",
    model: OPENROUTER_VIDEO_MODELS.KLING_O1,
    capabilitySummary: "cinematic text/image video with first-frame and last-frame controls, 5-10s.",
    supportedActions: "generate, animate, check; first_frame_url and last_frame_url supported",
  },
  {
    toolName: "openRouterVideoVeo31Fast",
    displayName: "OpenRouter Video — Veo 3.1 Fast",
    model: OPENROUTER_VIDEO_MODELS.VEO_31_FAST,
    capabilitySummary: "Google Veo fast model with native audio plus first-frame and last-frame controls.",
    supportedActions: "generate, animate, check; first_frame_url and last_frame_url supported",
  },
  {
    toolName: "openRouterVideoVeo31Lite",
    displayName: "OpenRouter Video — Veo 3.1 Lite",
    model: OPENROUTER_VIDEO_MODELS.VEO_31_LITE,
    capabilitySummary: "cheapest Google Veo option with native audio, 4-8s output.",
    supportedActions: "generate, animate, check",
  },
  {
    toolName: "openRouterVideoHailuo23",
    displayName: "OpenRouter Video — Hailuo 2.3",
    model: OPENROUTER_VIDEO_MODELS.HAILUO_23,
    capabilitySummary: "realistic motion and character animation for text/image video.",
    supportedActions: "generate, animate, check",
  },
  {
    toolName: "openRouterVideoSeedance20Fast",
    displayName: "OpenRouter Video — Seedance 2.0 Fast",
    model: OPENROUTER_VIDEO_MODELS.SEEDANCE_20_FAST,
    capabilitySummary: "speed-prioritized text/image video with first-frame and last-frame controls.",
    supportedActions: "generate, animate, check; first_frame_url and last_frame_url supported",
  },
  {
    toolName: "openRouterVideoSeedance20",
    displayName: "OpenRouter Video — Seedance 2.0",
    model: OPENROUTER_VIDEO_MODELS.SEEDANCE_20,
    capabilitySummary: "character consistency, camera control, first/last-frame controls, and references.",
    supportedActions: "generate, animate, reference, check; first_frame_url and last_frame_url supported",
  },
  {
    toolName: "openRouterVideoWan27",
    displayName: "OpenRouter Video — Wan 2.7",
    model: OPENROUTER_VIDEO_MODELS.WAN_27,
    capabilitySummary: "text/image/reference video with first-frame and last-frame controls.",
    supportedActions: "generate, animate, reference, check; first_frame_url and last_frame_url supported",
  },
];

function createOpenRouterVideoModelTool(sessionId: string, config: VideoModelToolConfig) {
  return tool({
    description: `${config.displayName}: ${config.capabilitySummary}

The selected tool fixes the provider/model to ${config.model}; do not pass a model parameter.

**Supported actions and parameters:** ${config.supportedActions}.

- action="generate" → text-to-video (prompt required)
- action="animate" → image-to-video (prompt + image_url)
- action="reference" → reference-to-video when supported (prompt + reference_image_urls)
- action="check" → poll an existing OpenRouter job with job_id or polling_url

Optional fields are model-dependent: duration, aspect_ratio, first_frame_url, last_frame_url.`,
    inputSchema: openRouterVideoModelSchema,
    execute: withToolLogging(config.toolName, sessionId, (args: OpenRouterVideoModelInput) =>
      executeOpenRouterVideo(sessionId, { ...args, model: config.model } as OpenRouterVideoInput, config.toolName)
    ),
  });
}

export const createOpenRouterGrokImagineVideoTool = (sessionId: string) =>
  createOpenRouterVideoModelTool(sessionId, VIDEO_MODEL_DESCRIPTORS[0]);
export const createOpenRouterKlingV3ProVideoTool = (sessionId: string) =>
  createOpenRouterVideoModelTool(sessionId, VIDEO_MODEL_DESCRIPTORS[1]);
export const createOpenRouterKlingV3StandardVideoTool = (sessionId: string) =>
  createOpenRouterVideoModelTool(sessionId, VIDEO_MODEL_DESCRIPTORS[2]);
export const createOpenRouterKlingO1VideoTool = (sessionId: string) =>
  createOpenRouterVideoModelTool(sessionId, VIDEO_MODEL_DESCRIPTORS[3]);
export const createOpenRouterVeo31FastVideoTool = (sessionId: string) =>
  createOpenRouterVideoModelTool(sessionId, VIDEO_MODEL_DESCRIPTORS[4]);
export const createOpenRouterVeo31LiteVideoTool = (sessionId: string) =>
  createOpenRouterVideoModelTool(sessionId, VIDEO_MODEL_DESCRIPTORS[5]);
export const createOpenRouterHailuo23VideoTool = (sessionId: string) =>
  createOpenRouterVideoModelTool(sessionId, VIDEO_MODEL_DESCRIPTORS[6]);
export const createOpenRouterSeedance20FastVideoTool = (sessionId: string) =>
  createOpenRouterVideoModelTool(sessionId, VIDEO_MODEL_DESCRIPTORS[7]);
export const createOpenRouterSeedance20VideoTool = (sessionId: string) =>
  createOpenRouterVideoModelTool(sessionId, VIDEO_MODEL_DESCRIPTORS[8]);
export const createOpenRouterWan27VideoTool = (sessionId: string) =>
  createOpenRouterVideoModelTool(sessionId, VIDEO_MODEL_DESCRIPTORS[9]);

// ---------------------------------------------------------------------------
// Unified tool creator (Phase 3 — 10 models, 4 actions)
// ---------------------------------------------------------------------------

export function createOpenRouterVideoTool(sessionId: string) {
  const executeWithLogging = withToolLogging(
    "openRouterVideo",
    sessionId,
    (args: OpenRouterVideoInput) => executeOpenRouterVideo(sessionId, args, "openRouterVideo"),
  );

  return tool({
    description: `Generate videos from text, images, or reference images using 10 OpenRouter video models via async polling.

**Actions:**
- action="generate" → text-to-video (all 10 models)
- action="animate" → image-to-video — animate a still image (all 10 models)
- action="reference" → reference-to-video — style/content from reference images (Grok/Seedance/Wan only)
- action="check" → poll an existing job by job_id or polling_url

**Models:**
- Grok Imagine (${OPENROUTER_VIDEO_MODELS.GROK_IMAGINE_VIDEO}) — text/image/reference, 1-15s, 24fps
- Kling v3.0 Pro (${OPENROUTER_VIDEO_MODELS.KLING_V3_PRO}) — premium, 3-15s, first+last frame, optional audio
- Kling v3.0 Standard (${OPENROUTER_VIDEO_MODELS.KLING_V3_STANDARD}) — balanced, 3-15s, first+last frame
- Kling O1 (${OPENROUTER_VIDEO_MODELS.KLING_O1}) — cinematic, 5-10s, first+last frame
- Veo 3.1 Fast (${OPENROUTER_VIDEO_MODELS.VEO_31_FAST}) — mid-tier, native audio, first+last frame
- Veo 3.1 Lite (${OPENROUTER_VIDEO_MODELS.VEO_31_LITE}) — cheapest, 4-8s, native audio
- Hailuo 2.3 (${OPENROUTER_VIDEO_MODELS.HAILUO_23}) — realistic motion, character animation
- Seedance 2.0 Fast (${OPENROUTER_VIDEO_MODELS.SEEDANCE_20_FAST}) — speed-prioritized, first+last frame
- Seedance 2.0 (${OPENROUTER_VIDEO_MODELS.SEEDANCE_20}) — character consistency, camera control, first+last frame, reference
- Wan 2.7 (${OPENROUTER_VIDEO_MODELS.WAN_27}) — text/image/reference, first+last frame

**Optional params:** image_url (for animate), reference_image_urls (for reference), first_frame_url/last_frame_url (frame control), duration, aspect_ratio.

**Note:** action="generate" polls inline (up to 5 min). Use action="check" to poll without waiting.`,

    inputSchema: openRouterVideoSchema,
    execute: executeWithLogging,
  });
}
