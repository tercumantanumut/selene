"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { motion } from "framer-motion";
import { useReducedMotion } from "../hooks/use-reduced-motion";
import { ComputerGraphic } from "../computer-graphic";
import { TypewriterText } from "@/components/ui/typewriter-text";
import { TerminalPrompt } from "@/components/ui/terminal-prompt";
import { useTranslations } from "next-intl";
import { ToolDependencyBadge } from "@/components/ui/tool-dependency-badge";
import { AlertTriangleIcon, ChevronDownIcon, ChevronRightIcon, LockIcon } from "lucide-react";
import { resilientFetch } from "@/lib/utils/resilient-fetch";
import { useSettings } from "@/lib/hooks/use-settings";
import { DEFAULT_ENABLED_TOOLS } from "@/lib/characters/templates/resolve-tools";
import {
  CHARACTER_TOOL_CATALOG,
  mergeCharacterToolCatalog,
  type CharacterToolCatalogItem,
} from "@/lib/characters/tool-catalog";

/** Tool capability definition for the wizard */
interface ToolCapability extends CharacterToolCatalogItem {}


/** Category display order — matches character-picker's CATEGORY_ICONS */
const CATEGORY_ORDER: Record<string, number> = {
  knowledge: 0,
  search: 1,
  "image-generation": 2,
  "image-editing": 3,
  "video-generation": 4,
  analysis: 5,
  utility: 6,
  "custom-comfyui": 7,
};

/** Category translation keys */
const CATEGORY_KEYS: Record<string, string> = {
  knowledge: "knowledge",
  search: "search",
  "image-generation": "imageGeneration",
  "image-editing": "imageEditing",
  "video-generation": "videoGeneration",
  analysis: "analysis",
  utility: "utility",
};

/** Warning from the settings-aware tool resolver */
interface ToolResolutionWarning {
  toolId: string;
  toolName: string;
  reason: string;
  settingsKeys: string[];
  action: string;
}

interface CapabilitiesPageProps {
  agentName: string;
  agentId?: string | null;
  templateId?: string;
  initialEnabledTools?: string[];
  onSubmit: (enabledTools: string[]) => void;
  onBack: () => void;
}

export function CapabilitiesPage({
  agentName,
  agentId,
  templateId,
  initialEnabledTools = DEFAULT_ENABLED_TOOLS,
  onSubmit,
  onBack,
}: CapabilitiesPageProps) {
  const t = useTranslations("characterCreation.capabilities");
  const tDeps = useTranslations("characterCreation.capabilities.dependencyWarnings");
  const [enabledTools, setEnabledTools] = useState<Set<string>>(new Set(initialEnabledTools));
  const [availableTools, setAvailableTools] = useState<ToolCapability[]>(CHARACTER_TOOL_CATALOG);
  const [resolutionWarnings, setResolutionWarnings] = useState<ToolResolutionWarning[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [escapeFlash, setEscapeFlash] = useState(false);
  const prefersReducedMotion = useReducedMotion();
  const hasAnimated = useRef(false);
  const initialToolsRef = useRef(new Set(initialEnabledTools));

  useEffect(() => {
    const baseTools = CHARACTER_TOOL_CATALOG.map((tool) => ({
      ...tool,
      displayName: t.has(`tools.${tool.id}`) ? t(`tools.${tool.id}`) : tool.id,
      description: t.has(`tools.${tool.id}Desc`) ? t(`tools.${tool.id}Desc`) : "",
    }));

    const sortedBaseTools = [...baseTools].sort((a, b) => {
      const catA = CATEGORY_ORDER[a.category] ?? 99;
      const catB = CATEGORY_ORDER[b.category] ?? 99;
      if (catA !== catB) return catA - catB;
      return (a.displayName || a.id).localeCompare(b.displayName || b.id);
    });
    setAvailableTools(sortedBaseTools);

    let cancelled = false;
    const loadTools = async () => {
      try {
        const { data, error } = await resilientFetch<{
          tools?: Array<{ id: string; displayName: string; description: string; category: string }>;
        }>("/api/tools?includeDisabled=true&includeAlwaysLoad=true");
        if (error || !data) throw new Error(error || "Failed to load tools");
        if (cancelled) return;

        const mergedList = mergeCharacterToolCatalog(baseTools, data.tools || [], {
          excludeMcp: true,
        }).sort((a, b) => {
          const catA = CATEGORY_ORDER[a.category] ?? 99;
          const catB = CATEGORY_ORDER[b.category] ?? 99;
          if (catA !== catB) return catA - catB;
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
  }, [t]);

  // Dependency status - tracks what's configured
  const [dependencyStatus, setDependencyStatus] = useState<{
    syncedFolders: boolean;
    embeddings: boolean;
    vectorDbEnabled: boolean;
    webScraper: boolean;
    openrouterKey: boolean;
    comfyuiEnabled: boolean;
    flux2Klein4bEnabled: boolean;
    flux2Klein9bEnabled: boolean;
    localGrepEnabled: boolean;
    devWorkspaceEnabled: boolean;
    screenCaptureEnabled: boolean;
    runwayApiSecret: boolean;
    vertexAIProjectId: boolean;
  }>({
    syncedFolders: false,
    embeddings: false,
    vectorDbEnabled: false,
    webScraper: false,
    openrouterKey: false,
    comfyuiEnabled: false,
    flux2Klein4bEnabled: false,
    flux2Klein9bEnabled: false,
    localGrepEnabled: true,
    devWorkspaceEnabled: false,
    screenCaptureEnabled: true,
    runwayApiSecret: false,
    vertexAIProjectId: false,
  });

  type CapabilityDependencyKey = keyof typeof dependencyStatus;

  // Check dependencies on mount (settings from shared cache, folders from API)
  const { settings: _cachedSettings } = useSettings();

  useEffect(() => {
    const checkFolders = async () => {
      let foldersCount: number | null = null;
      if (agentId) {
        const { data } = await resilientFetch<{ folders?: unknown[] }>(
          `/api/vector-sync?characterId=${agentId}`
        );
        if (data) foldersCount = data.folders?.length ?? 0;
      }
      if (foldersCount !== null) {
        setDependencyStatus((prev) => ({
          ...prev,
          syncedFolders: foldersCount > 0,
        }));
      }
    };
    checkFolders();
  }, [agentId]);

  useEffect(() => {
    if (!_cachedSettings) return;
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
      flux2Klein4bEnabled: settingsData.flux2Klein4bEnabled === true,
      flux2Klein9bEnabled: settingsData.flux2Klein9bEnabled === true,
      localGrepEnabled: settingsData.localGrepEnabled !== false,
      devWorkspaceEnabled: settingsData.devWorkspaceEnabled === true,
      screenCaptureEnabled: settingsData.screenCaptureEnabled !== false,
      runwayApiSecret: typeof settingsData.runwayApiSecret === "string" && (settingsData.runwayApiSecret as string).trim().length > 0,
      vertexAIProjectId: typeof settingsData.vertexAIProjectId === "string" && (settingsData.vertexAIProjectId as string).trim().length > 0,
    }));
  }, [_cachedSettings]);

  // Fetch tool resolution warnings for Selene template
  useEffect(() => {
    if (templateId !== "selene-default") return;

    const fetchResolution = async () => {
      try {
        const { data, error } = await resilientFetch<{
          warnings?: ToolResolutionWarning[];
        }>("/api/tools/resolve?templateId=selene-default");
        if (!error && data?.warnings && data.warnings.length > 0) {
          setResolutionWarnings(data.warnings);
        }
      } catch {
        // Non-critical — warnings are informational only
      }
    };

    fetchResolution();
  }, [templateId]);

  // Compute dirty state: tools have been changed from initial
  const isDirty = useMemo(() => {
    const initial = initialToolsRef.current;
    if (enabledTools.size !== initial.size) return true;
    for (const id of enabledTools) {
      if (!initial.has(id)) return true;
    }
    return false;
  }, [enabledTools]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isDirty) {
          // Don't navigate back — flash a warning and blur active element
          e.preventDefault();
          if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
          }
          setEscapeFlash(true);
          setTimeout(() => setEscapeFlash(false), 1500);
          return;
        }
        onBack();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onBack, isDirty]);

  // Helper to check if tool dependencies are met
  const areDependenciesMet = (tool: ToolCapability): boolean => {
    if (!tool.dependencies || tool.dependencies.length === 0) return true;
    return tool.dependencies.every((dep) => dependencyStatus[dep]);
  };

  // Get dependency warning message
  const getDependencyWarning = (tool: ToolCapability): string | null => {
    if (!tool.dependencies || tool.dependencies.length === 0) return null;
    const unmet = tool.dependencies.filter((dep) => !dependencyStatus[dep]);
    if (unmet.length === 0) return null;
    if (unmet.length === 2 && unmet.includes("syncedFolders") && unmet.includes("embeddings")) {
      return tDeps("both");
    }
    return unmet.map((dep) => tDeps(dep)).join(" + ");
  };

  const toggleTool = (toolId: string) => {
    setEnabledTools((prev) => {
      const next = new Set(prev);
      if (next.has(toolId)) {
        next.delete(toolId);
      } else {
        next.add(toolId);
      }
      return next;
    });
  };

  const toggleCategoryCollapse = useCallback((category: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  }, []);

  const toggleCategorySelectAll = useCallback((category: string, tools: ToolCapability[]) => {
    const toggleableTools = tools.filter((tool) => areDependenciesMet(tool));
    if (toggleableTools.length === 0) return;
    const allEnabled = toggleableTools.every((tool) => enabledTools.has(tool.id));
    setEnabledTools((prev) => {
      const next = new Set(prev);
      if (allEnabled) {
        // Deselect all in this category
        for (const tool of toggleableTools) next.delete(tool.id);
      } else {
        // Select all in this category
        for (const tool of toggleableTools) next.add(tool.id);
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabledTools, dependencyStatus]);

  const handleSubmit = () => {
    onSubmit(Array.from(enabledTools));
  };

  // Group tools by category
  const toolsByCategory = availableTools.reduce((acc, tool) => {
    if (!acc[tool.category]) acc[tool.category] = [];
    acc[tool.category].push(tool);
    return acc;
  }, {} as Record<string, ToolCapability[]>);

  return (
    <div className="flex h-full min-h-full flex-col items-center bg-terminal-cream px-4 py-6 sm:px-8">
      <div className="flex w-full max-w-4xl flex-1 flex-col gap-6 min-h-0">
        {/* Header */}
        <div className="flex items-start gap-8">
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: prefersReducedMotion ? 0 : 0.5 }}
          >
            <ComputerGraphic size="sm" />
          </motion.div>

          <div className="flex-1 space-y-4">
            <TerminalPrompt prefix="step-2" symbol="$" animate={!prefersReducedMotion}>
              <span className="text-terminal-amber">agent.capabilities({agentName})</span>
            </TerminalPrompt>

            <div className="font-mono text-lg text-terminal-dark">
              {!hasAnimated.current ? (
                <TypewriterText
                  text={t("question")}
                  delay={prefersReducedMotion ? 0 : 200}
                  speed={prefersReducedMotion ? 0 : 25}
                  onComplete={() => {
                    hasAnimated.current = true;
                    setShowForm(true);
                  }}
                  showCursor={false}
                />
              ) : (
                <span>{t("question")}</span>
              )}
            </div>
          </div>
        </div>

        {/* Onboarding: Tool resolution warnings for Selene template */}
        {showForm && resolutionWarnings.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: prefersReducedMotion ? 0 : 0.2 }}
            className="rounded-lg border border-terminal-amber/30 bg-terminal-amber/5 p-4"
          >
            <div className="flex items-start gap-2 mb-2">
              <AlertTriangleIcon className="w-4 h-4 text-terminal-amber mt-0.5 flex-shrink-0" />
              <p className="font-mono text-sm text-terminal-dark">
                {resolutionWarnings.length === 1
                  ? t("resolutionWarningSingular")
                  : t("resolutionWarningPlural", { count: resolutionWarnings.length })}
              </p>
            </div>
            <div className="ml-6 space-y-1.5">
              {resolutionWarnings.map((warning) => (
                <div key={warning.toolId} className="font-mono text-xs text-terminal-muted">
                  <span className="text-terminal-dark font-semibold">{warning.toolName}</span>
                  {" — "}
                  <span>{warning.action}</span>
                  {" "}
                  <a
                    href="/settings"
                    className="text-terminal-green hover:underline"
                    onClick={(e) => {
                      e.preventDefault();
                      window.open("/settings", "_blank");
                    }}
                  >
                    {t("configureNow")}
                  </a>
                </div>
              ))}
            </div>
          </motion.div>
        )}

        {/* Tool Selection */}
        {showForm && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: prefersReducedMotion ? 0 : 0.3 }}
            className="flex min-h-0 flex-1 flex-col rounded-lg border border-terminal-border bg-terminal-bg/30"
          >
            {/* Summary count */}
            <div className="flex items-center justify-between border-b border-terminal-border/50 px-5 py-3">
              <span className="font-mono text-sm text-terminal-dark/70">
                {t("toolsSummary", { enabled: enabledTools.size, total: availableTools.length })}
              </span>
              {escapeFlash && (
                <span className="font-mono text-xs text-terminal-amber animate-pulse">
                  {t("unsavedChanges")}
                </span>
              )}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-5 pr-3">
              <div className="space-y-4">
                {Object.entries(toolsByCategory).map(([category, tools]) => {
                  const isCollapsed = collapsedCategories.has(category);
                  const toggleableTools = tools.filter((tool) => areDependenciesMet(tool));
                  const enabledInCategory = tools.filter((tool) => enabledTools.has(tool.id)).length;
                  const allToggleableEnabled = toggleableTools.length > 0 && toggleableTools.every((tool) => enabledTools.has(tool.id));
                  const someToggleableEnabled = toggleableTools.some((tool) => enabledTools.has(tool.id));
                  const categoryLabel = CATEGORY_KEYS[category]
                    ? t(`categories.${CATEGORY_KEYS[category]}`)
                    : category.charAt(0).toUpperCase() + category.slice(1).replace(/-/g, " ");
                  const selectAllChecked: boolean | "mixed" = allToggleableEnabled
                    ? true
                    : someToggleableEnabled
                      ? "mixed"
                      : false;

                  return (
                    <div key={category}>
                      {/* Category header */}
                      <div className="flex items-center gap-2 mb-2">
                        <button
                          type="button"
                          onClick={() => toggleCategoryCollapse(category)}
                          className="flex items-center gap-1.5 text-sm font-mono font-semibold text-terminal-amber hover:text-terminal-amber/80 transition-colors"
                          aria-expanded={!isCollapsed}
                          aria-controls={!isCollapsed ? `category-${category}` : undefined}
                        >
                          {isCollapsed ? (
                            <ChevronRightIcon className="w-4 h-4" />
                          ) : (
                            <ChevronDownIcon className="w-4 h-4" />
                          )}
                          {categoryLabel}
                        </button>
                        <span className="font-mono text-xs text-terminal-dark/50">
                          {enabledInCategory} of {tools.length}
                        </span>
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={selectAllChecked === "mixed" ? "mixed" : selectAllChecked}
                          aria-label={allToggleableEnabled ? t("deselectAllAria", { category: categoryLabel }) : t("selectAllAria", { category: categoryLabel })}
                          onClick={() => toggleCategorySelectAll(category, tools)}
                          disabled={toggleableTools.length === 0}
                          className="ml-auto font-mono text-xs text-terminal-green hover:text-terminal-green/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {allToggleableEnabled ? t("deselectAll") : t("selectAll")}
                        </button>
                      </div>

                      {/* Tools grid — collapsible */}
                      {!isCollapsed && (
                        <div id={`category-${category}`} className="grid gap-2 sm:grid-cols-2">
                          {tools.map((tool) => {
                            const isMet = areDependenciesMet(tool);
                            const warning = getDependencyWarning(tool);
                            const displayName = tool.displayName || (t.has(`tools.${tool.id}`) ? t(`tools.${tool.id}`) : tool.id);
                            const description = tool.description || (t.has(`tools.${tool.id}Desc`) ? t(`tools.${tool.id}Desc`) : "");

                            return (
                              <ToolToggle
                                key={tool.id}
                                tool={tool}
                                displayName={displayName}
                                description={description}
                                enabled={enabledTools.has(tool.id)}
                                disabled={!isMet}
                                warning={warning}
                                onToggle={() => toggleTool(tool.id)}
                              />
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Navigation */}
            <div className="flex flex-col gap-3 border-t border-terminal-border/50 bg-terminal-cream/90 px-5 py-4 backdrop-blur sm:flex-row sm:items-center sm:justify-between">
              <button
                onClick={onBack}
                className="order-2 text-sm font-mono text-terminal-dark/60 transition-colors hover:text-terminal-dark sm:order-1 sm:w-auto"
              >
                {t("back")}
              </button>
              <button
                onClick={handleSubmit}
                className="order-1 w-full rounded bg-terminal-dark px-4 py-2 text-sm font-mono text-terminal-cream transition-colors hover:bg-terminal-dark/90 sm:order-2 sm:w-auto"
              >
                {t("continue")}
              </button>
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
}

/** Individual tool toggle component */
function ToolToggle({
  tool,
  displayName,
  description,
  enabled,
  disabled,
  warning,
  onToggle,
}: {
  tool: ToolCapability;
  displayName: string;
  description: string;
  enabled: boolean;
  disabled?: boolean;
  warning?: string | null;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      role="checkbox"
      aria-checked={enabled}
      aria-label={displayName}
      className={`w-full flex items-center gap-3 p-3 rounded border transition-colors text-left ${disabled
        ? "bg-terminal-bg/10 border-terminal-border/30 opacity-60 cursor-not-allowed"
        : enabled
          ? "bg-terminal-green/10 border-terminal-green/50"
          : "bg-terminal-bg/20 border-terminal-border/50 hover:border-terminal-border"
        }`}
    >
      <div
        className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${disabled
          ? "border-terminal-dark/10 bg-terminal-dark/5"
          : enabled
            ? "bg-terminal-green border-terminal-green text-white"
            : "border-terminal-dark/30"
          }`}
      >
        {enabled && (
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          </svg>
        )}
        {disabled && <LockIcon className="w-3 h-3 text-terminal-dark/30" />}
      </div>
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <div className="font-mono text-sm text-terminal-dark">{displayName}</div>
          {warning && <ToolDependencyBadge warning={warning} />}
        </div>
        <div className="font-mono text-xs text-terminal-dark/60">{description}</div>
      </div>
    </button>
  );
}
