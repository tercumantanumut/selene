import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/local-auth";
import { getOrCreateLocalUser } from "@/lib/db/queries";
import { loadSettings } from "@/lib/settings/settings-manager";
import {
  getCharacter,
  getCharacterFull,
  getCharacterStats,
  updateCharacter,
  deleteCharacter,
} from "@/lib/characters/queries";
import {
  updateCharacterSchema,
  agentMetadataSchema,
} from "@/lib/characters/validation";
import { z } from "zod";
import { detachAgentFromWorkflows } from "@/lib/agents/workflows";
import { validateAgentModelConfig } from "@/lib/ai/model-validation";
import { ToolRegistry, registerAllTools, isRequiredTool } from "@/lib/ai/tool-registry";

type RouteParams = { params: Promise<{ id: string }> };

// GET - Get a single character with all related data
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const userId = await requireAuth(req);
    const settings = loadSettings();
    const dbUser = await getOrCreateLocalUser(userId, settings.localUserEmail);
    const { id } = await params;

    const character = await getCharacter(id);
    if (!character) {
      return NextResponse.json({ error: "Character not found" }, { status: 404 });
    }

    // Check ownership
    if (character.userId !== dbUser.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (req.nextUrl.searchParams.get("stats") === "true") {
      const stats = await getCharacterStats(dbUser.id, id);
      return NextResponse.json({ stats });
    }

    // Get full character with all related data
    const fullCharacter = await getCharacterFull(id);

    return NextResponse.json({ character: fullCharacter });
  } catch (error) {
    console.error("Get character error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to get character" },
      { status: 500 }
    );
  }
}

// Update schema for PATCH - includes metadata for B2B agent configuration
const updateSchema = z.object({
  character: updateCharacterSchema.optional(),
  // B2B agent metadata (enabledTools, purpose, etc.)
  metadata: agentMetadataSchema.optional(),
});

function validateToolLoadingPreferences(
  preferences: Record<string, "always" | "deferred"> | undefined
): string[] {
  if (!preferences) return [];

  registerAllTools();
  const registry = ToolRegistry.getInstance();
  const errors: string[] = [];

  for (const [toolId, preference] of Object.entries(preferences)) {
    const registered = registry.get(toolId);
    if (!registered) {
      errors.push(`Unknown tool loading preference: ${toolId}`);
      continue;
    }

    if (preference === "deferred" && isRequiredTool(toolId, registered.metadata)) {
      errors.push(`${registered.metadata.displayName} (${toolId}) is required for agent operation and cannot be deferred.`);
    }
  }

  return errors;
}

// PATCH - Update a character
export async function PATCH(req: Request, { params }: RouteParams) {
  try {
    const userId = await requireAuth(req);
    const settings = loadSettings();
    const dbUser = await getOrCreateLocalUser(userId, settings.localUserEmail);
    const { id } = await params;

    // Check ownership
    const existing = await getCharacter(id);
    if (!existing) {
      return NextResponse.json({ error: "Character not found" }, { status: 404 });
    }
    if (existing.userId !== dbUser.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();
    const parseResult = updateSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parseResult.error.flatten() },
        { status: 400 }
      );
    }

    const { character: charData, metadata } = parseResult.data;

    if (metadata?.modelConfig) {
      const validation = validateAgentModelConfig(metadata.modelConfig, settings.llmProvider);
      if (!validation.valid) {
        return NextResponse.json(
          {
            error: "Incompatible agent model configuration",
            details: validation.errors,
          },
          { status: 400 },
        );
      }
    }

    const toolPreferenceErrors = validateToolLoadingPreferences(metadata?.toolLoadingPreferences);
    if (toolPreferenceErrors.length > 0) {
      return NextResponse.json(
        {
          error: "Invalid tool loading preferences",
          details: toolPreferenceErrors,
        },
        { status: 422 },
      );
    }

    // Update in parallel
    const promises: Promise<unknown>[] = [];

    // Handle character data and metadata updates
    if (charData || metadata) {
      const updateData: Parameters<typeof updateCharacter>[1] = { ...charData };
      if (metadata) {
        // Merge metadata with existing metadata
        const existingMetadata = (existing.metadata as Record<string, unknown>) ?? {};
        (updateData as { metadata?: Record<string, unknown> }).metadata = { ...existingMetadata, ...metadata };
      }
      promises.push(updateCharacter(id, updateData));
    }

    await Promise.all(promises);

    const updated = await getCharacterFull(id);
    return NextResponse.json({ success: true, character: updated });
  } catch (error) {
    console.error("Update character error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update character" },
      { status: 500 }
    );
  }
}

// DELETE - Delete a character
export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const userId = await requireAuth(req);
    const settings = loadSettings();
    const dbUser = await getOrCreateLocalUser(userId, settings.localUserEmail);
    const { id } = await params;

    const existing = await getCharacter(id);
    if (!existing) {
      return NextResponse.json({ error: "Character not found" }, { status: 404 });
    }
    if (existing.userId !== dbUser.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Clean up resources before deleting (using dynamic imports to avoid worker spawn issues)
    try {
      // Stop all file watchers for this character's sync folders
      const { getSyncFolders } = await import("@/lib/vectordb/sync-service");
      const { stopWatching } = await import("@/lib/vectordb/file-watcher");

      const syncFolders = await getSyncFolders(id);
      for (const folder of syncFolders) {
        try {
          await stopWatching(folder.id);
        } catch (error) {
          console.warn(`[DeleteCharacter] Failed to stop watcher for folder ${folder.id}:`, error);
        }
      }

      // Remove git worktrees for any workspace-sourced folders BEFORE the
      // character row is deleted (CASCADE will drop the DB rows, but the
      // worktree directories on disk would otherwise leak).
      const { cleanupWorkspace } = await import("@/lib/workspace/cleanup");
      const workspaceFolders = syncFolders.filter((f) => f.source === "workspace");
      for (const folder of workspaceFolders) {
        try {
          await cleanupWorkspace({
            syncFolderId: folder.id,
            worktreePath: folder.folderPath,
            trigger: "character-delete",
          });
        } catch (error) {
          console.warn(
            `[DeleteCharacter] Failed to clean up workspace folder ${folder.id}:`,
            error,
          );
        }
      }

      // Delete vector database table
      try {
        const { deleteAgentTable } = await import("@/lib/vectordb/collections");
        await deleteAgentTable(id);
      } catch (error) {
        console.warn(`[DeleteCharacter] Failed to delete vector table for character ${id}:`, error);
      }
    } catch (error) {
      console.warn("[DeleteCharacter] Error during cleanup, continuing with deletion:", error);
    }

    // Delete the character (CASCADE will delete related data)
    try {
      await detachAgentFromWorkflows(dbUser.id, id);
    } catch (error) {
      console.warn("[DeleteCharacter] Failed to detach agent from workflows, continuing:", error);
    }

    // Delete the character (CASCADE will delete related data)
    await deleteCharacter(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete character error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete character" },
      { status: 500 }
    );
  }
}
