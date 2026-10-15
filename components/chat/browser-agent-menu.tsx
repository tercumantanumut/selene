"use client";

import { useCallback, useMemo, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  Wrench,
  Database,
  ChartBar,
  Trash,
  Plug as PhosphorPlug,
  UserCircle,
  Pencil,
} from "@phosphor-icons/react";
import {
  Brain,
  CalendarClock,
  Copy,
  Cpu,
  Gauge,
  MoreHorizontal,
  Puzzle,
  Sparkles,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { useCharacterActions } from "@/components/character-picker-character-actions-hook";
import { useToolEditor } from "@/components/character-picker-tool-editor-hook";
import type { CharacterSummary } from "@/components/character-picker-types";

interface BrowserAgentMenuCharacter {
  id: string;
  name: string;
  displayName?: string | null;
  tagline?: string | null;
  status?: string;
  metadata?: Record<string, unknown> | null;
  images?: Array<{
    url: string;
    isPrimary: boolean;
    imageType: string;
  }>;
}

interface BrowserAgentMenuProps {
  character: BrowserAgentMenuCharacter;
}

function storeReturnUrl() {
  if (typeof window !== "undefined") {
    sessionStorage.setItem("selene-return-url", window.location.href);
  }
}

export function BrowserAgentMenu({ character }: BrowserAgentMenuProps) {
  const router = useRouter();
  const t = useTranslations("chat");
  const tPicker = useTranslations("picker");
  const tDeps = useTranslations("picker.toolEditor.dependencyWarnings");

  // All hooks must be called unconditionally (Rules of Hooks)
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const characterSummary = useMemo(
    (): CharacterSummary => ({
      id: character.id,
      name: character.name,
      displayName: character.displayName,
      tagline: character.tagline,
      status: (character.status as CharacterSummary["status"]) || "active",
      metadata: character.metadata as CharacterSummary["metadata"],
      images: character.images,
      hasActiveSession: true,
    }),
    [character.id, character.name, character.displayName, character.tagline, character.status, character.metadata, character.images],
  );

  const reloadPage = useCallback(async () => {
    router.refresh();
  }, [router]);

  const charActions = useCharacterActions(tPicker, reloadPage, () => true);
  const toolEditor = useToolEditor(tPicker, tDeps, reloadPage);

  // Prevent hydration mismatch — Radix generates different IDs on server vs client.
  // Only render interactive content after mount so all IDs are client-generated.
  if (!mounted) {
    return (
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground">
        <MoreHorizontal className="h-4 w-4" />
      </div>
    );
  }

  const quickLinks = [
    {
      href: `/agents/${character.id}/memory`,
      label: t("sidebar.agentMemoryShort"),
      icon: Brain,
    },
    {
      href: `/agents/${character.id}/schedules`,
      label: t("sidebar.schedulesShort"),
      icon: CalendarClock,
    },
    {
      href: `/agents/${character.id}/skills`,
      label: t("sidebar.skillsShort"),
      icon: Sparkles,
    },
    { href: "/dashboard", label: t("sidebar.dashboardShort"), icon: ChartBar },
    { href: "/usage", label: t("sidebar.usageShort"), icon: Gauge },
  ];

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label={t("browserWorkspace.agentMenuAriaLabel")}
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-52 font-mono text-sm"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Quick Links */}
          <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-muted-foreground">
            {t("sidebar.quickLinks")}
          </DropdownMenuLabel>
          {quickLinks.map(({ href, label, icon: Icon }) => (
            <DropdownMenuItem key={href} asChild>
              <Link href={href} onClick={storeReturnUrl}>
                <Icon className="mr-2 h-3.5 w-3.5" />
                {label}
              </Link>
            </DropdownMenuItem>
          ))}

          <DropdownMenuSeparator />

          {/* Agent Management */}
          <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-muted-foreground">
            {t("browserWorkspace.agentLabel")}
          </DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={() => charActions.openIdentityEditor(characterSummary)}
          >
            <Pencil className="mr-2 h-3.5 w-3.5" />
            {tPicker("menu.editInfo")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => charActions.openModelDefaults(characterSummary)}
          >
            <Cpu className="mr-2 h-3.5 w-3.5" />
            {tPicker("menu.modelDefaults")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              router.push(`/agents/${character.id}/skills`)
            }
          >
            <Sparkles className="mr-2 h-3.5 w-3.5" />
            {tPicker("menu.manageSkills")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => toolEditor.openToolEditor(characterSummary)}
          >
            <Wrench className="mr-2 h-3.5 w-3.5" />
            {tPicker("menu.manageTools")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              charActions.openFolderManager(characterSummary)
            }
          >
            <Database className="mr-2 h-3.5 w-3.5" />
            {tPicker("menu.syncFolders")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              charActions.openMcpToolEditor(characterSummary)
            }
          >
            <PhosphorPlug className="mr-2 h-3.5 w-3.5" />
            {tPicker("menu.mcpTools")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              charActions.openPluginEditor(characterSummary)
            }
          >
            <Puzzle className="mr-2 h-3.5 w-3.5" />
            {tPicker("menu.plugins")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              charActions.openAvatar3dSelector(characterSummary)
            }
          >
            <UserCircle className="mr-2 h-3.5 w-3.5" />
            {tPicker("menu.avatar3d")}
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem
            disabled={charActions.isDuplicating}
            onSelect={() => charActions.handleDuplicate(character.id)}
          >
            <Copy className="mr-2 h-3.5 w-3.5" />
            {tPicker("menu.duplicate")}
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem
            onSelect={() =>
              charActions.openDeleteDialog(characterSummary)
            }
            className="text-red-600 focus:text-red-600"
          >
            <Trash className="mr-2 h-3.5 w-3.5" />
            {tPicker("menu.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Dialogs — rendered inline, controlled by hooks */}
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
            charActions.avatar3dSelectorCharacter.metadata
              ?.avatarConfig as any
          }
          onAvatarConfigChange={() => {
            void reloadPage();
          }}
        />
      )}

      <DeleteAgentDialog
        open={charActions.deleteDialogOpen}
        onOpenChange={charActions.setDeleteDialogOpen}
        characterToDelete={charActions.characterToDelete}
        isDeleting={charActions.isDeleting}
        onConfirm={(e) => {
          e.preventDefault();
          void charActions.deleteCharacter().then(() => {
            router.push("/");
          });
        }}
      />
    </>
  );
}
