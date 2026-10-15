"use client";

import { Loader2, Check, X, GitBranchPlus, Search } from "lucide-react";
import {
  Plug as PhosphorPlug,
  Database,
} from "@phosphor-icons/react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { AnimatedButton } from "@/components/ui/animated-button";
import { ToolDependencyBadge } from "@/components/ui/tool-dependency-badge";
import { FolderSyncManager } from "@/components/vector-search/folder-sync-manager";
import { MCPToolsPage } from "@/components/character-creation/terminal-pages/mcp-tools-page";
import { useTranslations } from "next-intl";
import type { CharacterSummary } from "@/components/character-picker-types";
import type { CharacterToolCatalogItem } from "@/lib/characters/tool-catalog";

const DatabaseIcon = Database;
const Plug = PhosphorPlug;

/** Category icons (labels come from translations) */
const CATEGORY_ICONS: Record<string, string> = {
  knowledge: "\u{1F4DA}",
  search: "\u{1F50D}",
  "image-generation": "\u{1F3A8}",
  "image-editing": "\u270F\uFE0F",
  "video-generation": "\u{1F3AC}",
  analysis: "\u{1F52C}",
  utility: "\u{1F6E0}\uFE0F",
  "custom-comfyui": "CUI",
  browser: "\u{1F310}",
};

type ToolDefinition = CharacterToolCatalogItem;

// ==========================================================================
// WorkflowCreatorDialog
// ==========================================================================

export function WorkflowCreatorDialog({
  open,
  onOpenChange,
  newWorkflowName,
  setNewWorkflowName,
  newWorkflowInitiatorId,
  setNewWorkflowInitiatorId,
  newWorkflowSubagentIds,
  setNewWorkflowSubagentIds,
  allStandaloneCharacters,
  creatingWorkflow,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  newWorkflowName: string;
  setNewWorkflowName: (v: string) => void;
  newWorkflowInitiatorId: string;
  setNewWorkflowInitiatorId: (v: string) => void;
  newWorkflowSubagentIds: Set<string>;
  setNewWorkflowSubagentIds: (fn: (prev: Set<string>) => Set<string>) => void;
  allStandaloneCharacters: CharacterSummary[];
  creatingWorkflow: boolean;
  onSubmit: () => void;
}) {
  const t = useTranslations("picker");
  const tc = useTranslations("common");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl bg-terminal-cream">
        <DialogHeader>
          <DialogTitle className="font-mono text-terminal-dark flex items-center gap-2">
            <GitBranchPlus className="h-5 w-5 text-terminal-green" />
            {t("workflows.create")}
          </DialogTitle>
          <DialogDescription className="font-mono text-terminal-muted">
            {t("workflows.createDescription")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="font-mono text-xs text-terminal-muted uppercase tracking-wider">
              {t("workflows.nameLabel")}
            </Label>
            <input
              type="text"
              value={newWorkflowName}
              onChange={(event) => setNewWorkflowName(event.target.value)}
              placeholder={t("workflows.namePlaceholder")}
              className="mt-1 w-full rounded border border-terminal-border bg-white px-3 py-2 font-mono text-sm text-terminal-dark focus:border-terminal-green focus:outline-none"
            />
          </div>

          <div>
            <Label className="font-mono text-xs text-terminal-muted uppercase tracking-wider">
              {t("workflows.mainAgentLabel")}
            </Label>
            <select
              value={newWorkflowInitiatorId}
              onChange={(event) => setNewWorkflowInitiatorId(event.target.value)}
              className="mt-1 w-full rounded border border-terminal-border bg-white px-3 py-2 font-mono text-sm text-terminal-dark focus:border-terminal-green focus:outline-none"
            >
              <option value="">{t("workflows.selectMainAgent")}</option>
              {allStandaloneCharacters.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.displayName || agent.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label className="font-mono text-xs text-terminal-muted uppercase tracking-wider">
              {t("workflows.subagentsLabel")}
            </Label>
            <div className="mt-1 max-h-48 overflow-y-auto rounded border border-terminal-border/50 bg-terminal-bg/10 p-2 space-y-1">
              {allStandaloneCharacters
                .filter((agent) => agent.id !== newWorkflowInitiatorId)
                .map((agent) => {
                  const checked = newWorkflowSubagentIds.has(agent.id);
                  return (
                    <label
                      key={agent.id}
                      className="flex items-center gap-2 rounded px-2 py-1 hover:bg-terminal-bg/30 cursor-pointer"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(value) => {
                          setNewWorkflowSubagentIds((prev) => {
                            const next = new Set(prev);
                            if (value) next.add(agent.id);
                            else next.delete(agent.id);
                            return next;
                          });
                        }}
                      />
                      <span className="font-mono text-xs text-terminal-dark">
                        {agent.displayName || agent.name}
                      </span>
                    </label>
                  );
                })}
              {allStandaloneCharacters.filter((agent) => agent.id !== newWorkflowInitiatorId).length === 0 && (
                <p className="font-mono text-xs text-terminal-muted px-2 py-1">
                  {t("workflows.noSubagentOptions")}
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <AnimatedButton
            variant="outline"
            className="font-mono"
            onClick={() => onOpenChange(false)}
            disabled={creatingWorkflow}
          >
            {tc("cancel")}
          </AnimatedButton>
          <AnimatedButton
            className="font-mono bg-terminal-green text-white hover:bg-terminal-green/90"
            onClick={onSubmit}
            disabled={creatingWorkflow || !newWorkflowInitiatorId}
          >
            {creatingWorkflow ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              t("workflows.create")
            )}
          </AnimatedButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ==========================================================================
// ToolEditorDialog
// ==========================================================================

export function ToolEditorDialog({
  open,
  onOpenChange,
  editingCharacter,
  selectedTools,
  toolLoadingPreferences,
  isSaving,
  toolSearchQuery,
  setToolSearchQuery,
  collapsedCategories,
  filteredToolsByCategory,
  toolsByCategory,
  availableTools,
  areDependenciesMet,
  getDependencyWarning,
  toggleCategory,
  toggleAllInCategory,
  getSelectedCountInCategory,
  toggleTool,
  setToolLoadingPreference,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingCharacter: CharacterSummary | null;
  selectedTools: string[];
  toolLoadingPreferences: Record<string, "always" | "deferred">;
  isSaving: boolean;
  toolSearchQuery: string;
  setToolSearchQuery: (v: string) => void;
  collapsedCategories: Set<string>;
  filteredToolsByCategory: Record<string, ToolDefinition[]>;
  toolsByCategory: Record<string, ToolDefinition[]>;
  availableTools: ToolDefinition[];
  areDependenciesMet: (tool: ToolDefinition) => boolean;
  getDependencyWarning: (tool: ToolDefinition) => string | null;
  toggleCategory: (category: string) => void;
  toggleAllInCategory: (category: string, select: boolean) => void;
  getSelectedCountInCategory: (category: string) => number;
  toggleTool: (toolId: string) => void;
  setToolLoadingPreference: (toolId: string, preference: "always" | "deferred") => void;
  onSave: () => void;
}) {
  const t = useTranslations("picker");
  const tc = useTranslations("common");
  const selectedSet = new Set(selectedTools);
  const requiredCount = availableTools.filter((tool) => selectedSet.has(tool.id) && tool.isRequired).length;
  const alwaysCount = availableTools.filter((tool) => {
    if (!selectedSet.has(tool.id) || tool.isRequired) return false;
    return (toolLoadingPreferences[tool.id] ?? tool.defaultLoadingPolicy ?? "deferred") === "always";
  }).length;
  const deferredCount = Math.max(selectedTools.length - requiredCount - alwaysCount, 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl bg-terminal-cream max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="font-mono text-terminal-dark">
            {t("configureTools")}
          </DialogTitle>
          <DialogDescription className="font-mono text-terminal-muted">
            {t("toolEditor.subtitle", { name: editingCharacter?.displayName || editingCharacter?.name || "", count: selectedTools.length })}
            <span className="mt-1 block text-[11px] text-terminal-muted/80">
              {selectedTools.length} enabled · {alwaysCount} always loaded · {deferredCount} deferred · {requiredCount} required
            </span>
            <span className="mt-1 block text-[11px] text-terminal-muted/80">
              Always-loaded tools use initial context. Deferred tools remain available through Search Tools.
            </span>
          </DialogDescription>
        </DialogHeader>

        {/* Search Input */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-terminal-muted" />
          <input
            type="text"
            value={toolSearchQuery}
            onChange={(e) => setToolSearchQuery(e.target.value)}
            placeholder={t("toolEditor.searchPlaceholder")}
            className="w-full pl-10 pr-10 py-2 bg-terminal-bg/30 border border-terminal-border rounded-lg font-mono text-sm text-terminal-dark placeholder:text-terminal-muted focus:outline-none focus:ring-2 focus:ring-terminal-green/50 focus:border-terminal-green"
          />
          {toolSearchQuery && (
            <button
              onClick={() => setToolSearchQuery("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-terminal-muted hover:text-terminal-dark transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Scrollable Tool Categories */}
        <div className="flex-1 overflow-y-auto space-y-3 py-2 pr-1 min-h-0">
          {Object.entries(CATEGORY_ICONS).map(([category, icon]) => {
            const tools = filteredToolsByCategory[category];
            if (!tools || tools.length === 0) return null;

            const isCollapsed = collapsedCategories.has(category);
            const selectedCount = getSelectedCountInCategory(category);
            const totalCount = (toolsByCategory[category] || []).length;
            const selectableIds = (toolsByCategory[category] || []).filter(areDependenciesMet).map((tl) => tl.id);
            const selectableSelectedCount = selectableIds.filter((id) => selectedTools.includes(id)).length;
            const allSelected = selectableIds.length > 0 && selectableSelectedCount === selectableIds.length;
            const categoryLabel = t.has(`toolEditor.categories.${category}`)
              ? t(`toolEditor.categories.${category}`)
              : category.replace(/-/g, " ");

            return (
              <div key={category} className="border border-terminal-border/50 rounded-lg overflow-hidden">
                <div className="w-full flex items-center justify-between px-3 py-2 bg-terminal-bg/20">
                  <button
                    type="button"
                    onClick={() => toggleCategory(category)}
                    className="flex items-center gap-2 hover:bg-terminal-bg/30 rounded px-1 py-0.5 -mx-1 transition-colors"
                  >
                    {isCollapsed ? (
                      <span className="w-4 h-4 text-terminal-muted inline-block">&#8250;</span>
                    ) : (
                      <span className="w-4 h-4 text-terminal-muted inline-block">&#8964;</span>
                    )}
                    <span className="text-sm">{icon}</span>
                    <span className="font-mono text-sm font-medium text-terminal-dark">
                      {categoryLabel}
                    </span>
                    <span className="font-mono text-xs text-terminal-muted">
                      ({selectedCount}/{totalCount})
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleAllInCategory(category, !allSelected)}
                    className="px-2 py-0.5 text-xs font-mono text-terminal-green hover:bg-terminal-green/10 rounded transition-colors"
                  >
                    {allSelected ? t("toolEditor.deselectAll") : t("toolEditor.selectAll")}
                  </button>
                </div>

                {!isCollapsed && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 p-2">
                    {tools.map((tl) => {
                      const isSelected = selectedTools.includes(tl.id) || tl.isRequired === true;
                      const dependenciesMet = areDependenciesMet(tl);
                      const warning = dependenciesMet ? null : getDependencyWarning(tl);
                      const canToggle = !tl.isRequired && (dependenciesMet || isSelected);
                      const effectiveLoadingPreference = toolLoadingPreferences[tl.id] ?? tl.defaultLoadingPolicy ?? "deferred";

                      return (
                        <div
                          key={tl.id}
                          className={`flex items-start gap-2 p-2 rounded transition-colors ${canToggle ? "cursor-pointer" : "cursor-not-allowed opacity-60"} ${isSelected
                            ? "bg-terminal-green/10 border border-terminal-green/30"
                            : "bg-terminal-bg/10 border border-transparent hover:border-terminal-border/50"
                            } ${warning ? "border border-terminal-amber/30" : ""}`}
                        >
                          <Checkbox
                            id={`tool-${tl.id}`}
                            checked={isSelected}
                            onCheckedChange={() => toggleTool(tl.id)}
                            disabled={!canToggle}
                            className="mt-0.5"
                          />
                          <div className="flex-1 min-w-0">
                            <Label
                              htmlFor={`tool-${tl.id}`}
                              className="font-mono text-xs text-terminal-dark cursor-pointer block truncate"
                              title={tl.displayName || tl.id}
                            >
                              {tl.displayName || tl.id}
                            </Label>
                            <p
                              className="text-[10px] font-mono text-terminal-muted line-clamp-2"
                              title={tl.description || ""}
                            >
                              {tl.description || ""}
                            </p>
                            {warning && (
                              <div className="mt-1">
                                <ToolDependencyBadge warning={warning} />
                              </div>
                            )}
                            {isSelected && (
                              <div className="mt-2" onClick={(event) => event.stopPropagation()}>
                                {tl.isRequired ? (
                                  <span className="inline-flex rounded border border-terminal-amber/40 bg-terminal-amber/10 px-2 py-0.5 font-mono text-[10px] text-terminal-amber">
                                    Required · locked active
                                  </span>
                                ) : tl.supportsLoadingPreference !== false ? (
                                  <label className="block font-mono text-[10px] text-terminal-muted">
                                    Initial loading
                                    <select
                                      value={effectiveLoadingPreference === "always" ? "always" : "deferred"}
                                      onChange={(event) => setToolLoadingPreference(tl.id, event.target.value as "always" | "deferred")}
                                      className="mt-1 w-full rounded border border-terminal-border bg-terminal-cream px-2 py-1 font-mono text-[11px] text-terminal-dark"
                                    >
                                      <option value="always">Always loaded</option>
                                      <option value="deferred">Deferred</option>
                                    </select>
                                  </label>
                                ) : null}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {Object.keys(filteredToolsByCategory).length === 0 && (
            <div className="text-center py-8 text-terminal-muted font-mono text-sm">
              {t("toolEditor.noResults", { query: toolSearchQuery })}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex justify-between items-center pt-3 border-t border-terminal-border/50">
          <span className="text-xs font-mono text-terminal-muted">
            {t("toolEditor.footerCount", { selected: selectedTools.length, total: availableTools.length })}
          </span>
          <div className="flex gap-2">
            <AnimatedButton
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="font-mono"
            >
              {tc("cancel")}
            </AnimatedButton>
            <AnimatedButton
              onClick={onSave}
              disabled={isSaving}
              className="gap-2 bg-terminal-green hover:bg-terminal-green/90 text-white font-mono"
            >
              {isSaving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Check className="w-4 h-4" />
              )}
              {tc("save")}
            </AnimatedButton>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ==========================================================================
// PluginEditorDialog
// ==========================================================================

export function PluginEditorDialog({
  open,
  onOpenChange,
  editingCharacter,
  agentPlugins,
  loadingAgentPlugins,
  savingPluginId,
  toggleAgentPlugin,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingCharacter: CharacterSummary | null;
  agentPlugins: Array<{
    id: string;
    name: string;
    description: string;
    version: string;
    enabledForAgent: boolean;
  }>;
  loadingAgentPlugins: boolean;
  savingPluginId: string | null;
  toggleAgentPlugin: (pluginId: string, enabled: boolean) => void;
}) {
  const t = useTranslations("picker");
  const tc = useTranslations("common");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl bg-terminal-cream max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="font-mono text-terminal-dark flex items-center gap-2">
            <Plug className="w-5 h-5 text-terminal-green" />
            {t("plugins.title")}
          </DialogTitle>
          <DialogDescription className="font-mono text-terminal-muted">
            {t("plugins.subtitle", {
              name: editingCharacter?.displayName || editingCharacter?.name || "",
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-2 pr-1 min-h-0">
          {loadingAgentPlugins ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-terminal-green" />
            </div>
          ) : agentPlugins.length === 0 ? (
            <div className="rounded border border-dashed border-terminal-border/60 p-4 text-center font-mono text-sm text-terminal-muted">
              {t("plugins.empty")}
            </div>
          ) : (
            agentPlugins.map((plugin) => (
              <div
                key={plugin.id}
                className="rounded border border-terminal-border/50 bg-terminal-bg/10 p-3"
              >
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-mono text-sm text-terminal-dark truncate">
                      {plugin.name}
                    </p>
                    <p className="font-mono text-xs text-terminal-muted mt-0.5">
                      v{plugin.version}
                    </p>
                    <p className="font-mono text-xs text-terminal-muted mt-1 line-clamp-2">
                      {plugin.description}
                    </p>
                  </div>
                  <Switch
                    checked={plugin.enabledForAgent}
                    onCheckedChange={(checked) => toggleAgentPlugin(plugin.id, checked)}
                    disabled={savingPluginId === plugin.id}
                  />
                </div>
              </div>
            ))
          )}
        </div>

        <div className="flex justify-end pt-3 border-t border-terminal-border/50">
          <AnimatedButton
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="font-mono"
          >
            {tc("close")}
          </AnimatedButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ==========================================================================
// FolderManagerDialog
// ==========================================================================

export function FolderManagerDialog({
  open,
  onOpenChange,
  folderManagerCharacter,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folderManagerCharacter: CharacterSummary | null;
}) {
  const t = useTranslations("picker");
  const tc = useTranslations("common");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[96vw] sm:max-w-[72rem] bg-terminal-cream max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono text-terminal-dark flex items-center gap-2">
            <DatabaseIcon className="w-5 h-5 text-terminal-green" />
            {t("syncedFoldersTitle")}
          </DialogTitle>
          <DialogDescription className="font-mono text-terminal-muted">
            {t("syncedFoldersSubtitle", {
              name: folderManagerCharacter?.displayName || folderManagerCharacter?.name || "",
            })}
          </DialogDescription>
        </DialogHeader>
        {folderManagerCharacter && (
          <FolderSyncManager characterId={folderManagerCharacter.id} />
        )}
        <div className="flex justify-end mt-4">
          <AnimatedButton
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="font-mono"
          >
            {tc("close")}
          </AnimatedButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ==========================================================================
// McpToolEditorDialog
// ==========================================================================

export function McpToolEditorDialog({
  open,
  onOpenChange,
  editingCharacter,
  mcpServers,
  mcpTools,
  mcpToolPreferences,
  onUpdate,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingCharacter: CharacterSummary | null;
  mcpServers: string[];
  mcpTools: string[];
  mcpToolPreferences: Record<string, { enabled: boolean; loadingMode: "always" | "deferred"; displayMode: "compact" | "detailed" }>;
  onUpdate: (servers: string[], tools: string[], prefs: Record<string, { enabled: boolean; loadingMode: "always" | "deferred"; displayMode: "compact" | "detailed" }>) => void;
  onComplete: () => void;
}) {
  const t = useTranslations("picker");
  const tc = useTranslations("common");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl bg-terminal-cream h-[90vh] flex flex-col p-0 overflow-hidden [&>button:has(.sr-only)]:hidden">
        <div className="flex items-center justify-between px-6 pt-6 pb-4 flex-shrink-0 border-b border-terminal-border/20">
          <div>
            <DialogTitle className="font-mono text-terminal-dark flex items-center gap-2">
              <Plug className="w-5 h-5 text-purple-500" />
              {t("mcpToolsTitle")}
            </DialogTitle>
            <DialogDescription className="font-mono text-terminal-muted mt-1">
              {editingCharacter?.displayName || editingCharacter?.name}
            </DialogDescription>
          </div>
          <button
            onClick={() => onOpenChange(false)}
            className="rounded-sm p-1.5 opacity-70 hover:opacity-100 hover:bg-terminal-border/30 transition-all"
            aria-label={tc("close")}
          >
            <X className="h-5 w-5 text-terminal-dark" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {editingCharacter && (
            <MCPToolsPage
              embedded
              enabledMcpServers={mcpServers}
              enabledMcpTools={mcpTools}
              mcpToolPreferences={mcpToolPreferences}
              onUpdate={onUpdate}
              onComplete={onComplete}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ==========================================================================
// Re-exports from character-picker-dialogs-2
// (AddToWorkflowDialog, WorkflowActionDialog)
// ==========================================================================

export {
  AddToWorkflowDialog,
  WorkflowActionDialog,
} from "@/components/character-picker-dialogs-2";
