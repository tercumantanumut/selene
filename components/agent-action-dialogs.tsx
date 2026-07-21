"use client";

/**
 * AgentActionDialogs
 *
 * Renders the set of dialogs driven by useCharacterActions and useToolEditor.
 * Used in BrowserAgentMenu, ChatSidebar, and CharacterPicker to avoid repeating
 * the same ~65-line dialog block in each consumer.
 */

import {
  FolderManagerDialog,
  ToolEditorDialog,
  PluginEditorDialog,
  McpToolEditorDialog,
} from "@/components/character-picker-dialogs";
import {
  IdentityEditorDialog,
  McpRemovalWarningDialog,
  DeleteAgentDialog,
} from "@/components/character-picker-dialogs-2";
import { Avatar3DModelSelector } from "@/components/avatar-3d/avatar-model-selector";
import type { useCharacterActions } from "@/components/character-picker-character-actions-hook";
import type { useToolEditor } from "@/components/character-picker-tool-editor-hook";

type CharActions = ReturnType<typeof useCharacterActions>;
type ToolEditor = ReturnType<typeof useToolEditor>;

interface AgentActionDialogsProps {
  charActions: CharActions;
  toolEditor: ToolEditor;
  /**
   * Called when the user selects a new 3D avatar config.
   * The caller is responsible for any page reload / data refresh.
   */
  onAvatarConfigChange?: (config: { modelUrl: string; bodyType: "M" | "F" }) => void;
  /**
   * Whether to include DeleteAgentDialog.
   * Some consumers render it separately or handle deletion differently.
   * Defaults to true.
   */
  includeDeleteDialog?: boolean;
  /**
   * onConfirmDelete handler — required when includeDeleteDialog is true.
   */
  onConfirmDelete?: (e: React.MouseEvent) => void;
}

export function AgentActionDialogs({
  charActions,
  toolEditor,
  onAvatarConfigChange,
  includeDeleteDialog = true,
  onConfirmDelete,
}: AgentActionDialogsProps) {
  return (
    <>
      <ToolEditorDialog
        open={toolEditor.toolEditorOpen}
        onOpenChange={toolEditor.setToolEditorOpen}
        editingCharacter={toolEditor.editingCharacter}
        availableTools={toolEditor.availableTools}
        selectedTools={toolEditor.selectedTools}
        toolLoadingPreferences={toolEditor.toolLoadingPreferences}
        isSaving={toolEditor.isSaving}
        toolSearchQuery={toolEditor.toolSearchQuery}
        setToolSearchQuery={toolEditor.setToolSearchQuery}
        collapsedCategories={toolEditor.collapsedCategories}
        toolsByCategory={toolEditor.toolsByCategory}
        filteredToolsByCategory={toolEditor.filteredToolsByCategory}
        areDependenciesMet={toolEditor.areDependenciesMet}
        getDependencyWarning={toolEditor.getDependencyWarning}
        toggleCategory={toolEditor.toggleCategory}
        toggleAllInCategory={toolEditor.toggleAllInCategory}
        getSelectedCountInCategory={toolEditor.getSelectedCountInCategory}
        toggleTool={toolEditor.toggleTool}
        setToolLoadingPreference={toolEditor.setToolLoadingPreference}
        onSave={toolEditor.saveTools}
      />

      <PluginEditorDialog
        open={charActions.pluginEditorOpen}
        onOpenChange={charActions.setPluginEditorOpen}
        editingCharacter={charActions.pluginEditingCharacter}
        agentPlugins={charActions.agentPlugins}
        loadingAgentPlugins={charActions.loadingAgentPlugins}
        savingPluginId={charActions.savingPluginId}
        toggleAgentPlugin={charActions.toggleAgentPlugin}
      />

      <McpToolEditorDialog
        open={charActions.mcpToolEditorOpen}
        onOpenChange={charActions.setMcpToolEditorOpen}
        editingCharacter={charActions.mcpEditingCharacter}
        mcpServers={charActions.mcpServers}
        mcpTools={charActions.mcpTools}
        mcpToolPreferences={charActions.mcpToolPreferences}
        onUpdate={charActions.onUpdateMcp}
        onComplete={charActions.saveMcpTools}
      />

      <IdentityEditorDialog
        open={charActions.identityEditorOpen}
        onOpenChange={charActions.setIdentityEditorOpen}
        identityForm={charActions.identityForm}
        setIdentityForm={charActions.setIdentityForm}
        generatedPrompt={charActions.generatedPrompt}
        isSaving={charActions.isSavingIdentity}
        onSave={charActions.saveIdentity}
        defaultTab={charActions.identityEditorDefaultTab}
      />

      <McpRemovalWarningDialog
        open={charActions.mcpRemovalWarningOpen}
        onOpenChange={charActions.setMcpRemovalWarningOpen}
        mcpToolsBeingRemoved={charActions.mcpToolsBeingRemoved}
        isSaving={charActions.isSavingMcp}
        onConfirm={(e) => {
          e.preventDefault();
          charActions.performMcpToolSave();
        }}
      />

      <FolderManagerDialog
        open={charActions.folderManagerOpen}
        onOpenChange={charActions.setFolderManagerOpen}
        folderManagerCharacter={charActions.folderManagerCharacter}
      />

      {charActions.avatar3dSelectorCharacter && (
        <Avatar3DModelSelector
          open={charActions.avatar3dSelectorOpen}
          onOpenChange={charActions.setAvatar3dSelectorOpen}
          characterId={charActions.avatar3dSelectorCharacter.id}
          characterName={
            charActions.avatar3dSelectorCharacter.displayName ||
            charActions.avatar3dSelectorCharacter.name
          }
          currentAvatarConfig={
            charActions.avatar3dSelectorCharacter.metadata?.avatarConfig as any
          }
          onAvatarConfigChange={(config) => {
            onAvatarConfigChange?.(config);
          }}
        />
      )}

      {includeDeleteDialog && (
        <DeleteAgentDialog
          open={charActions.deleteDialogOpen}
          onOpenChange={charActions.setDeleteDialogOpen}
          characterToDelete={charActions.characterToDelete}
          isDeleting={charActions.isDeleting}
          onConfirm={(e) => {
            e.preventDefault();
            onConfirmDelete?.(e);
          }}
        />
      )}
    </>
  );
}
