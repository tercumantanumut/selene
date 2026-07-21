"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { resilientFetch, resilientPatch } from "@/lib/utils/resilient-fetch";
import { useSettings } from "@/lib/hooks/use-settings";
import {
  CHARACTER_TOOL_CATALOG,
  mergeCharacterToolCatalog,
  type CharacterToolCatalogItem,
} from "@/lib/characters/tool-catalog";
import {
  DEFAULT_DEPENDENCY_STATUS,
  areDependenciesMet as checkDependenciesMet,
  getDependencyWarning as buildDependencyWarning,
  type DependencyStatus,
} from "@/lib/characters/tool-dependency-helpers";
import type { CharacterSummary } from "@/components/character-picker-types";

type ToolDefinition = CharacterToolCatalogItem;

export function useToolEditor(
  t: ReturnType<typeof useTranslations>,
  tDeps: ReturnType<typeof useTranslations>,
  loadCharacters: () => Promise<void>
) {
  const [toolEditorOpen, setToolEditorOpen] = useState(false);
  const [editingCharacter, setEditingCharacter] = useState<CharacterSummary | null>(null);
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [toolLoadingPreferences, setToolLoadingPreferences] = useState<Record<string, "always" | "deferred">>({});
  const [isSaving, setIsSaving] = useState(false);
  const [toolSearchQuery, setToolSearchQuery] = useState("");
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [availableTools, setAvailableTools] = useState<ToolDefinition[]>(CHARACTER_TOOL_CATALOG);
  const [dependencyStatus, setDependencyStatus] = useState<DependencyStatus>(DEFAULT_DEPENDENCY_STATUS);

  const baseTools = useMemo(() => {
    return CHARACTER_TOOL_CATALOG.map((tool) => ({
      ...tool,
      displayName: t.has(`tools.${tool.id}.name`) ? t(`tools.${tool.id}.name`) : tool.id,
      description: t.has(`tools.${tool.id}.description`) ? t(`tools.${tool.id}.description`) : "",
    }));
  }, [t]);

  useEffect(() => {
    setAvailableTools(baseTools);
  }, [baseTools]);

  const toolsByCategory = useMemo(() => {
    return availableTools.reduce((acc, tool) => {
      if (!acc[tool.category]) acc[tool.category] = [];
      acc[tool.category].push(tool);
      return acc;
    }, {} as Record<string, ToolDefinition[]>);
  }, [availableTools]);

  const filteredToolsByCategory = useMemo(() => {
    if (!toolSearchQuery.trim()) return toolsByCategory;
    const query = toolSearchQuery.toLowerCase();
    const filtered: Record<string, ToolDefinition[]> = {};
    for (const [category, tools] of Object.entries(toolsByCategory)) {
      const matchingTools = tools.filter((tool) => {
        const name = (tool.displayName || tool.id).toLowerCase();
        const desc = (tool.description || "").toLowerCase();
        return name.includes(query) || desc.includes(query) || tool.id.toLowerCase().includes(query);
      });
      if (matchingTools.length > 0) {
        filtered[category] = matchingTools;
      }
    }
    return filtered;
  }, [toolsByCategory, toolSearchQuery]);

  useEffect(() => {
    if (!toolEditorOpen) return;
    let cancelled = false;

    const loadTools = async () => {
      try {
        const { data, error } = await resilientFetch<{
          tools?: Array<{
            id: string;
            displayName: string;
            description: string;
            category: string;
            defaultLoadingPolicy?: "required" | "always" | "deferred";
            isRequired?: boolean;
            supportsLoadingPreference?: boolean;
          }>;
        }>("/api/tools?includeDisabled=true&includeAlwaysLoad=true");
        if (error || !data) throw new Error(error || "Failed to load tools");
        if (cancelled) return;

        const mergedList = mergeCharacterToolCatalog(baseTools, data.tools || []).sort((a, b) => {
          if (a.category !== b.category) return a.category.localeCompare(b.category);
          return (a.displayName || a.id).localeCompare(b.displayName || b.id);
        });
        setAvailableTools(mergedList);
      } catch (error) {
        console.error("Failed to load tools", error);
      }
    };

    loadTools();

    return () => {
      cancelled = true;
    };
  }, [toolEditorOpen, baseTools]);

  const { settings: _cachedSettings } = useSettings();

  // Fetch folder counts (non-cached) and merge with cached settings
  useEffect(() => {
    if (!toolEditorOpen) return;
    let cancelled = false;

    const loadFolderStatus = async () => {
      let foldersCount = 0;
      if (editingCharacter?.id) {
        const { data } = await resilientFetch<{ folders?: unknown[] }>(
          `/api/vector-sync?characterId=${editingCharacter.id}`
        );
        if (data) foldersCount = data.folders?.length ?? 0;
      }
      if (cancelled) return;
      setDependencyStatus((prev) => ({
        ...prev,
        syncedFolders: foldersCount > 0,
      }));
    };

    loadFolderStatus();
    return () => { cancelled = true; };
  }, [toolEditorOpen, editingCharacter]);

  // Update dependency status from cached settings
  useEffect(() => {
    if (!toolEditorOpen || !_cachedSettings) return;
    const settingsData = _cachedSettings;

    const webScraperReady = settingsData.webScraperProvider === "local"
      || (typeof settingsData.firecrawlApiKey === "string" && (settingsData.firecrawlApiKey as string).trim().length > 0);
    const hasEmbeddingModel = typeof settingsData.embeddingModel === "string"
      && (settingsData.embeddingModel as string).trim().length > 0;
    const hasOpenRouterKey = typeof settingsData.openrouterApiKey === "string"
      && (settingsData.openrouterApiKey as string).trim().length > 0;
    const embeddingsReady = hasEmbeddingModel || settingsData.embeddingProvider === "local" || hasOpenRouterKey;

    setDependencyStatus((prev) => ({
      ...prev,
      embeddings: embeddingsReady,
      vectorDbEnabled: settingsData.vectorDBEnabled === true,
      webScraper: webScraperReady,
      openrouterKey: typeof settingsData.openrouterApiKey === "string" && (settingsData.openrouterApiKey as string).trim().length > 0,
      comfyuiEnabled: settingsData.comfyuiEnabled === true,
      localGrepEnabled: settingsData.localGrepEnabled !== false,
      devWorkspaceEnabled: settingsData.devWorkspaceEnabled === true,
      screenCaptureEnabled: settingsData.screenCaptureEnabled !== false,
      runwayApiSecret: typeof settingsData.runwayApiSecret === "string" && (settingsData.runwayApiSecret as string).trim().length > 0,
      vertexAIProjectId: typeof settingsData.vertexAIProjectId === "string" && (settingsData.vertexAIProjectId as string).trim().length > 0,
    }));
  }, [toolEditorOpen, _cachedSettings]);

  const areDependenciesMet = (tool: ToolDefinition): boolean =>
    checkDependenciesMet(tool, dependencyStatus);

  const getDependencyWarning = (tool: ToolDefinition): string | null =>
    buildDependencyWarning(tool, dependencyStatus, tDeps);

  const toggleCategory = (category: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  const toggleAllInCategory = (category: string, select: boolean) => {
    const categoryTools = toolsByCategory[category] || [];
    const categoryToolIds = categoryTools.map((t) => t.id);
    const selectableToolIds = categoryTools.filter(areDependenciesMet).map((t) => t.id);
    setSelectedTools((prev) => {
      if (select) {
        return [...new Set([...prev, ...selectableToolIds])];
      } else {
        return prev.filter((id) => !categoryToolIds.includes(id));
      }
    });
    if (!select) {
      setToolLoadingPreferences((prev) => {
        const next = { ...prev };
        for (const id of categoryToolIds) delete next[id];
        return next;
      });
    }
  };

  const getSelectedCountInCategory = (category: string) => {
    const categoryTools = toolsByCategory[category] || [];
    return categoryTools.filter((t) => selectedTools.includes(t.id)).length;
  };

  const toggleTool = (toolId: string) => {
    setSelectedTools((prev) => {
      if (prev.includes(toolId)) {
        setToolLoadingPreferences((prefs) => {
          const next = { ...prefs };
          delete next[toolId];
          return next;
        });
        return prev.filter((t) => t !== toolId);
      }
      return [...prev, toolId];
    });
  };

  const setToolLoadingPreference = (toolId: string, preference: "always" | "deferred") => {
    setToolLoadingPreferences((prev) => ({ ...prev, [toolId]: preference }));
  };

  const openToolEditor = (character: CharacterSummary) => {
    setEditingCharacter(character);
    setSelectedTools(character.metadata?.enabledTools || []);
    setToolLoadingPreferences(character.metadata?.toolLoadingPreferences || {});
    setToolSearchQuery("");
    setCollapsedCategories(new Set());
    setToolEditorOpen(true);
  };

  const saveTools = async () => {
    if (!editingCharacter) return;
    setIsSaving(true);
    try {
      const selectedSet = new Set(selectedTools);
      const prunedLoadingPreferences = Object.fromEntries(
        Object.entries(toolLoadingPreferences).filter(([toolId]) => selectedSet.has(toolId))
      );
      const { error } = await resilientPatch(`/api/characters/${editingCharacter.id}`, {
        metadata: {
          enabledTools: selectedTools,
          toolLoadingPreferences: prunedLoadingPreferences,
        },
      });
      if (!error) {
        setToolEditorOpen(false);
        await loadCharacters();
      } else {
        toast.error(t("saveToolsFailed"));
      }
    } catch (error) {
      console.error("Failed to save tools:", error);
      toast.error(t("saveToolsFailed"));
    } finally {
      setIsSaving(false);
    }
  };

  return {
    // State
    toolEditorOpen,
    setToolEditorOpen,
    editingCharacter,
    setEditingCharacter,
    selectedTools,
    toolLoadingPreferences,
    isSaving,
    setIsSaving,
    toolSearchQuery,
    setToolSearchQuery,
    collapsedCategories,
    availableTools,
    toolsByCategory,
    filteredToolsByCategory,
    // Actions
    openToolEditor,
    saveTools,
    toggleTool,
    setToolLoadingPreference,
    toggleCategory,
    toggleAllInCategory,
    getSelectedCountInCategory,
    areDependenciesMet,
    getDependencyWarning,
  };
}
