import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/local-auth";
import { getOrCreateLocalUser, createSession } from "@/lib/db/queries";
import { loadSettings } from "@/lib/settings/settings-manager";
import { callFlux2Generate } from "@/lib/ai/flux2-client";
import { buildCharacterPrompt } from "@/lib/ai/character-tools";
import type { CharacterDraft } from "@/lib/ai/character-tools";

export const maxDuration = 60;

// Default style reference image for consistent character generation
const DEFAULT_STYLE_REFERENCE_URL = process.env.CHARACTER_STYLE_REFERENCE_URL;

const requestSchema = z.object({
  characterDraft: z.object({
    name: z.string().optional(),
    displayName: z.string().optional(),
    tagline: z.string().optional(),
    appearance: z.record(z.string(), z.unknown()).optional().default({}),
    body: z.record(z.string(), z.unknown()).optional().default({}),
    style: z.record(z.string(), z.unknown()).optional().default({}),
    personality: z.record(z.string(), z.unknown()).optional().default({}),
    background: z.record(z.string(), z.unknown()).optional().default({}),
    voice: z.record(z.string(), z.unknown()).optional().default({}),
    imagePrompt: z.string().optional(),
  }).optional(),
  imageType: z.enum(["portrait", "full_body", "avatar"]).default("portrait"),
  artStyle: z.string().optional(),
  // Optional custom prompt - if provided, uses this instead of building from characterDraft
  customPrompt: z.string().optional(),
  // Optional seed for reproducible generation
  seed: z.number().optional(),
  // Optional reference images for style guidance
  referenceImages: z.array(z.string().url()).optional(),
});

export async function POST(req: Request) {
  try {
    // Get local user for offline mode
    const userId = await requireAuth(req);
    const settings = loadSettings();
    const dbUser = await getOrCreateLocalUser(userId, settings.localUserEmail);

    const body = await req.json();
    
    // Validate input
    const parseResult = requestSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parseResult.error.flatten() },
        { status: 400 }
      );
    }

    const { characterDraft, imageType, artStyle, customPrompt, seed, referenceImages } = parseResult.data;

    let fullPrompt: string;

    if (customPrompt) {
      // Use custom prompt directly
      fullPrompt = customPrompt;
    } else if (characterDraft) {
      // Image type modifiers
      const typePrompts = {
        portrait: "portrait, head and shoulders, facing camera, detailed face",
        full_body: "full body shot, standing pose, detailed outfit",
        avatar: "icon style, circular crop, profile picture",
      };

      // Check if we have a rich LLM-generated imagePrompt
      if (characterDraft.imagePrompt && characterDraft.imagePrompt.length > 50) {
        // Use the LLM-generated imagePrompt as the primary prompt
        // Add image type and quality modifiers
        fullPrompt = [
          typePrompts[imageType],
          characterDraft.imagePrompt,
          artStyle || "",
          "high detail, sharp focus, professional quality",
        ]
          .filter(Boolean)
          .join(", ");
      } else {
        // Fallback: Build prompt from structured character data
        const characterDescription = buildCharacterPrompt(characterDraft as CharacterDraft);
        const styleStr = artStyle || "high quality digital art, detailed, professional";

        fullPrompt = [
          typePrompts[imageType],
          characterDescription,
          styleStr,
          "high detail, sharp focus, professional quality",
        ]
          .filter(Boolean)
          .join(", ");
      }
    } else {
      return NextResponse.json(
        { error: "Either characterDraft or customPrompt must be provided" },
        { status: 400 }
      );
    }

    // Dimensions based on image type
    const dimensions = {
      portrait: { width: 768, height: 1024 },
      full_body: { width: 768, height: 1024 },
      avatar: { width: 512, height: 512 },
    };

    const { width, height } = dimensions[imageType];

    // Create a session for tracking (or use existing)
    const session = await createSession({
      title: `Agent: ${characterDraft?.name || "New Agent"}`,
      userId: dbUser.id,
      metadata: { type: "character_creation" },
    });

    // Build reference images array
    // Use provided reference images, or fall back to default style reference if configured
    const effectiveReferenceImages: string[] = [];
    if (referenceImages && referenceImages.length > 0) {
      effectiveReferenceImages.push(...referenceImages);
    } else if (DEFAULT_STYLE_REFERENCE_URL) {
      effectiveReferenceImages.push(DEFAULT_STYLE_REFERENCE_URL);
    }

    // Generate the image
    const result = await callFlux2Generate(
      {
        prompt: fullPrompt,
        width,
        height,
        guidance: 4.5,
        steps: 25,
        seed, // Pass through the seed if provided
        referenceImages: effectiveReferenceImages.length > 0 ? effectiveReferenceImages : undefined,
      },
      session.id
    );

    return NextResponse.json({
      success: true,
      images: result.images,
      seed: result.seed,
      prompt: fullPrompt,
      timeTaken: result.timeTaken,
    });
  } catch (error) {
    console.error("Agent image generation error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to generate image" },
      { status: 500 }
    );
  }
}

