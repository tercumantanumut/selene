/**
 * MCP Settings Component
 * 
 * UI for configuring MCP servers with a user-friendly card interface,
 * templates, and connection management.
 */

"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
    Loader2, Check, X, RefreshCw, Plus, Trash2, Plug,
    Terminal, Globe, AlertCircle, Info, Edit2, Key, Shield, ExternalLink, Clock
} from "lucide-react";
import { cn } from "@/lib/utils";
import { resilientFetch, resilientPut, resilientPost, resilientPatch } from "@/lib/utils/resilient-fetch";
import type { MCPServerConfig } from "@/lib/mcp/types";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { MCPServerForm } from "@/components/settings/mcp-server-form";
import { MCPTemplateEnvDialog } from "@/components/settings/mcp-template-env-dialog";
import { PREBUILT_TEMPLATES, type MCPTemplate } from "@/components/settings/mcp-settings-constants";
import { openExternalUrl } from "@/lib/electron/types";

type MCPConnectionState =
    | "unauthenticated"
    | "authorization_required"
    | "authorizing"
    | "connected"
    | "expired"
    | "failed"
    | "not_connected";

interface MCPServerStatus {
    serverName: string;
    connected: boolean;
    lastError?: string;
    connectionState?: MCPConnectionState;
    authRequired?: boolean;
    authorizationUrl?: string;
    serverUrl?: string;
    transportType?: "http" | "sse" | "stdio";
    errorStatus?: number | string;
    details?: string;
    recovery?: string;
    toolCount: number;
    tools: string[];
}

interface MCPConnectionResult {
    success?: boolean;
    error?: string;
    toolCount?: number;
    authRequired?: boolean;
    authorizationUrl?: string;
    connectionState?: MCPConnectionState;
    recovery?: string;
    details?: string;
}

interface PluginServerInfo {
    namespacedName: string;
    serverName: string;
    pluginName: string;
    pluginId: string;
    pluginVersion: string;
    connected: boolean;
    toolCount: number;
    tools: string[];
    lastError?: string;
    connectionState?: MCPConnectionState;
    authRequired?: boolean;
    authorizationUrl?: string;
    details?: string;
    recovery?: string;
    config: Record<string, unknown>;
    incomplete?: boolean;
    incompleteReason?: string;
}

export function MCPSettings() {
    const t = useTranslations("settings.mcp");
    const [mcpServers, setMcpServers] = useState<Record<string, MCPServerConfig>>({});
    const [environment, setEnvironment] = useState<Record<string, string>>({});
    const [status, setStatus] = useState<MCPServerStatus[]>([]);
    const [pluginServers, setPluginServers] = useState<PluginServerInfo[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [connectingState, setConnectingState] = useState<Record<string, boolean>>({});

    // Plugin server URL editing state
    const [pluginUrlInputs, setPluginUrlInputs] = useState<Record<string, string>>({});
    const [pluginUrlSaving, setPluginUrlSaving] = useState<Record<string, boolean>>({});
    const [pluginUrlErrors, setPluginUrlErrors] = useState<Record<string, string>>({});

    // UI State
    const [showJsonMode, setShowJsonMode] = useState(false);
    const [rawJson, setRawJson] = useState("");
    const [isAddingServer, setIsAddingServer] = useState(false);
    const [editingServer, setEditingServer] = useState<string | null>(null);

    // Env Vars
    const [newEnvKey, setNewEnvKey] = useState("");
    const [showNewEnvInput, setShowNewEnvInput] = useState(false);

    // Template env dialog -- opened when a template with requiredEnv is clicked
    const [pendingTemplate, setPendingTemplate] = useState<MCPTemplate | null>(null);

    // Synced folders for path preview/documentation
    const [syncedFolders, setSyncedFolders] = useState<Array<{ folderPath: string, isPrimary: boolean, characterId: string }>>([]);

    useEffect(() => {
        loadConfig();
        loadSyncedFolders();
    }, []);

    const loadSyncedFolders = async () => {
        const { data, error } = await resilientFetch<{ folders?: Array<{ folderPath: string; isPrimary: boolean; characterId: string }> }>("/api/vector-sync");
        if (data) {
            setSyncedFolders(data.folders || []);
        }
        if (error) {
            console.error("Failed to load synced folders:", error);
        }
    };

    const loadConfig = async () => {
        setIsLoading(true);
        const { data, error } = await resilientFetch<{
            config: { mcpServers?: Record<string, MCPServerConfig> };
            environment?: Record<string, string>;
            status?: MCPServerStatus[];
            pluginServers?: PluginServerInfo[];
        }>("/api/mcp");
        if (data) {
            setMcpServers(data.config.mcpServers || {});
            setRawJson(JSON.stringify({ mcpServers: data.config.mcpServers || {} }, null, 2));
            setEnvironment(data.environment || {});
            setStatus(data.status || []);
            setPluginServers(data.pluginServers || []);
            // Seed URL inputs for incomplete or errored plugin servers
            const urlSeeds: Record<string, string> = {};
            for (const ps of data.pluginServers || []) {
                const cfg = ps.config as { url?: string; command?: string; type?: string };
                const transport = cfg.command ? "stdio" : (cfg.type || "sse");
                const needsUrl = transport === "sse" || transport === "http";
                if (needsUrl && (ps.incomplete || ps.lastError)) {
                    urlSeeds[ps.namespacedName] = cfg.url || "";
                }
            }
            setPluginUrlInputs(prev => ({ ...prev, ...urlSeeds }));
        }
        if (error) {
            console.error("Failed to load MCP config:", error);
            toast.error(t("loadFailed"));
        }
        setIsLoading(false);
    };

    const validateRawMcpJson = (value: unknown): string[] => {
        const errors: string[] = [];
        if (!value || typeof value !== "object" || Array.isArray(value) || !("mcpServers" in value)) {
            return [t("invalidJsonMissingRoot")];
        }

        const servers = (value as { mcpServers?: unknown }).mcpServers;
        if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
            return [t("invalidJsonMcpServersObject")];
        }

        for (const [name, config] of Object.entries(servers)) {
            if (!config || typeof config !== "object" || Array.isArray(config)) {
                errors.push(t("invalidJsonServerObject", { name }));
                continue;
            }

            const server = config as MCPServerConfig;
            if (server.type && !["http", "sse", "stdio"].includes(server.type)) {
                errors.push(t("invalidJsonTransport", { name }));
            }
            if (!server.command && server.enabled !== false) {
                if (!server.url) {
                    errors.push(t("validationUrlRequired"));
                } else {
                    try {
                        const parsed = new URL(server.url.replace(/\$\{[^}]+\}/g, "placeholder"));
                        if (!["http:", "https:"].includes(parsed.protocol)) errors.push(t("validationInvalidUrl"));
                    } catch {
                        errors.push(t("validationInvalidUrl"));
                    }
                }
            }
            if (server.headers && (typeof server.headers !== "object" || Array.isArray(server.headers))) {
                errors.push(t("invalidJsonHeaders", { name }));
            }
            if (server.auth?.type && !["none", "headers", "oauth"].includes(server.auth.type)) {
                errors.push(t("invalidJsonAuth", { name }));
            }
        }

        return errors;
    };

    const saveAll = async (updatedServers = mcpServers, updatedEnv = environment): Promise<boolean> => {
        setIsSaving(true);
        const { error } = await resilientPut("/api/mcp", {
            mcpServers: { mcpServers: updatedServers },
            mcpEnvironment: updatedEnv,
        });
        if (!error) {
            setMcpServers(updatedServers);
            setRawJson(JSON.stringify({ mcpServers: updatedServers }, null, 2));
            setEnvironment(updatedEnv);
            toast.success(t("saved"));
            setIsSaving(false);
            return true;
        } else {
            console.error("Failed to save MCP config:", error);
            toast.error(t("saveFailed"));
            setIsSaving(false);
            return false;
        }
    };

    const openAuthorizationUrl = async (serverName: string, authorizationUrl: string) => {
        try {
            await openExternalUrl(authorizationUrl);
            toast.info(t("authorizationStarted", { server: serverName }));
        } catch (error) {
            console.error(`Failed to open authorization URL for ${serverName}:`, error);
            toast.error(t("authorizationOpenFailed", {
                error: error instanceof Error ? error.message : String(error),
            }));
        }
    };

    const connectServer = async (serverName: string) => {
        setConnectingState(prev => ({ ...prev, [serverName]: true }));
        // Get characterId from the first synced folder if available
        const characterId = syncedFolders[0]?.characterId;

        try {
            const { data, error } = await resilientPost<{
                results: Record<string, MCPConnectionResult>;
            }>("/api/mcp/connect", {
                serverNames: [serverName],
                characterId,
            });

            if (data) {
                const result = data.results[serverName];
                if (result?.success) {
                    toast.success(t("connected", { server: serverName }));
                } else if (result?.authRequired && result.authorizationUrl) {
                    toast.info(t("authorizationRequired", { server: serverName }));
                    await openAuthorizationUrl(serverName, result.authorizationUrl);
                } else if (result?.authRequired) {
                    toast.error(t("authorizationRequiredNoUrl", { server: serverName }));
                } else {
                    toast.error(t("connectFailed", { server: serverName, error: result?.error ?? "" }));
                }
                await loadConfig();
            } else {
                console.error(`Failed to connect to ${serverName}:`, error);
                toast.error(error ? t("connectionFailed", { error }) : t("connectionFailedUnknown"));
            }
        } finally {
            setConnectingState(prev => ({ ...prev, [serverName]: false }));
        }
    };

    const startOAuthAuthorization = async (serverName: string) => {
        setConnectingState(prev => ({ ...prev, [serverName]: true }));
        const characterId = syncedFolders[0]?.characterId;

        try {
            const { data, error } = await resilientPost<MCPConnectionResult & { connected?: boolean }>(
                "/api/mcp/oauth/start",
                { serverName, characterId },
            );

            if (data?.success && data.connected) {
                toast.success(t("connected", { server: serverName }));
            } else if (data?.authorizationUrl) {
                await openAuthorizationUrl(serverName, data.authorizationUrl);
            } else {
                toast.error(t("connectFailed", { server: serverName, error: data?.error ?? error ?? "" }));
            }
            await loadConfig();
        } finally {
            setConnectingState(prev => ({ ...prev, [serverName]: false }));
        }
    };

    // Save URL for an incomplete plugin server, then auto-reconnect
    const handleSavePluginUrl = async (ps: PluginServerInfo) => {
        const url = pluginUrlInputs[ps.namespacedName]?.trim();
        if (!url) {
            setPluginUrlErrors(prev => ({ ...prev, [ps.namespacedName]: t("pluginServerUrlInvalid") }));
            return;
        }
        try {
            new URL(url);
        } catch {
            setPluginUrlErrors(prev => ({ ...prev, [ps.namespacedName]: t("pluginServerUrlInvalid") }));
            return;
        }

        setPluginUrlSaving(prev => ({ ...prev, [ps.namespacedName]: true }));
        setPluginUrlErrors(prev => { const n = { ...prev }; delete n[ps.namespacedName]; return n; });

        const { error } = await resilientPatch("/api/mcp", {
            pluginId: ps.pluginId,
            serverName: ps.serverName,
            url,
        });

        if (error) {
            setPluginUrlErrors(prev => ({ ...prev, [ps.namespacedName]: error }));
            setPluginUrlSaving(prev => ({ ...prev, [ps.namespacedName]: false }));
            return;
        }

        // URL saved, now reconnect
        try {
            await connectServer(ps.namespacedName);
        } finally {
            setPluginUrlSaving(prev => ({ ...prev, [ps.namespacedName]: false }));
        }
    };

    // Handle form save (for both add and edit)
    const handleFormSave = async (name: string, config: MCPServerConfig) => {
        const updatedServers = { ...mcpServers, [name]: config };
        if (await saveAll(updatedServers)) {
            setIsAddingServer(false);
            setEditingServer(null);
            toast.success(editingServer ? t("serverUpdated", { name }) : t("serverAdded", { name }));
            await connectServer(name);
        }
    };

    const handleFormCancel = () => {
        setIsAddingServer(false);
        setEditingServer(null);
    };

    const handleApplyTemplate = async (template: MCPTemplate) => {
        // Guard: if this template is already installed, warn before overwriting
        if (mcpServers[template.id]) {
            if (!confirm(t("templateAlreadyInstalled", { name: template.name }))) return;
        }

        // If template needs env vars, open dialog to collect them first
        if (template.requiredEnv.length > 0) {
            // Check if all required vars already have non-masked values
            const allExist = template.requiredEnv.every((k) => {
                const v = environment[k]?.trim();
                return v && !v.includes("\u2022");
            });
            if (!allExist) {
                setPendingTemplate(template);
                return;
            }
        }

        // No env vars needed (or all already filled) -- install directly
        const updatedServers = { ...mcpServers, [template.id]: template.config };
        if (await saveAll(updatedServers)) {
            toast.success(t("templateAdded", { name: template.name }));
        }
    };

    /** Called by the env dialog after the user fills in credentials */
    const handleTemplateEnvInstall = async (
        template: MCPTemplate,
        envValues: Record<string, string>,
    ) => {
        // Merge collected env values into environment
        const updatedEnv = { ...environment, ...envValues };
        // Add server config
        const updatedServers = { ...mcpServers, [template.id]: template.config };
        // Save both at once
        if (await saveAll(updatedServers, updatedEnv)) {
            setPendingTemplate(null);
            toast.success(t("templateAdded", { name: template.name }));
        } else {
            throw new Error(t("saveFailed"));
        }
    };

    const handleDeleteServer = async (serverName: string) => {
        if (!confirm(t("deleteConfirm", { name: serverName }))) return;

        const updatedServers = { ...mcpServers };
        delete updatedServers[serverName];
        await saveAll(updatedServers);
        // Also disconnect if needed (via reload)
        loadConfig();
    };

    /**
     * Toggle server enabled/disabled state
     * Disconnects server immediately when disabled
     */
    const handleToggleServer = async (serverName: string, enabled: boolean) => {
        const updatedServers = {
            ...mcpServers,
            [serverName]: {
                ...mcpServers[serverName],
                enabled,
            },
        };

        await saveAll(updatedServers);

        // If disabling, the API will handle disconnection
        // Load config to refresh status badges
        if (!enabled) {
            toast.success(t("serverDisabledFeedback", { name: serverName }));
            await loadConfig();
        } else {
            toast.success(t("serverEnabledFeedback", { name: serverName }));
        }
    };

    const getStatusDisplay = (serverName: string) => {
        const s = status.find(st => st.serverName === serverName);
        if (!s) return { badge: "bg-terminal-border text-terminal-muted", icon: AlertCircle, text: t("statusNotConnected") };
        if (s.connected) return { badge: "bg-terminal-green/20 text-terminal-green", icon: Check, text: t("statusConnected") };

        switch (s.connectionState) {
            case "authorization_required":
                return { badge: "bg-yellow-100 text-yellow-700", icon: Shield, text: t("statusAuthorizationRequired") };
            case "authorizing":
                return { badge: "bg-blue-100 text-blue-700", icon: Clock, text: t("statusAuthorizing") };
            case "expired":
                return { badge: "bg-orange-100 text-orange-700", icon: Clock, text: t("statusExpired") };
            case "failed":
                return { badge: "bg-red-100 text-red-600", icon: X, text: t("statusError") };
            default:
                return { badge: "bg-terminal-border text-terminal-muted", icon: AlertCircle, text: t("statusNotConnected") };
        }
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center p-8">
                <Loader2 className="h-6 w-6 animate-spin text-terminal-green" />
            </div>
        );
    }

    return (
        <div className="space-y-8 pb-10">

            {/* 1. Quick Start Templates */}
            <div className="space-y-4">
                <h3 className="font-mono text-sm font-semibold text-terminal-dark border-b border-terminal-border pb-2">
                    {t("recommendedServers")}
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                    {PREBUILT_TEMPLATES.map(template => {
                        const isInstalled = !!mcpServers[template.id];
                        return (
                        <div
                            key={template.id}
                            role="button"
                            tabIndex={0}
                            onClick={() => handleApplyTemplate(template)}
                            onKeyDown={(e) => e.key === "Enter" && handleApplyTemplate(template)}
                            className={cn(
                                "flex flex-col items-start p-3 rounded-md border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 hover:border-terminal-green hover:shadow-sm transition-all text-left cursor-pointer",
                                isInstalled ? "border-terminal-green/50" : "border-terminal-border"
                            )}
                        >
                            <div className="flex items-center justify-between w-full gap-2">
                                <div className="flex items-center gap-2">
                                    <div className="p-1.5 rounded bg-terminal-green/10 text-terminal-green">
                                        {template.config.type === "sse" ? (
                                            <Globe className="h-4 w-4" />
                                        ) : (
                                            <Terminal className="h-4 w-4" />
                                        )}
                                    </div>
                                    <span className="font-mono font-medium text-sm">{t(`templates.${template.id}.name`)}</span>
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                    {isInstalled && (
                                        <Badge variant="outline" className="text-[10px] h-5 px-1.5 bg-terminal-green/10 text-terminal-green border-terminal-green/30">
                                            <Check className="h-3 w-3 mr-1" />
                                            {t("installedBadge")}
                                        </Badge>
                                    )}
                                    {template.requiredEnv.length > 0 && !isInstalled && (
                                        <Badge variant="outline" className="text-[10px] h-5 px-1.5 bg-blue-50 text-blue-700 border-blue-200">
                                            <Key className="h-3 w-3 mr-1" />
                                            {t("authBadge")}
                                        </Badge>
                                    )}
                                </div>
                            </div>
                            <p className="font-mono text-xs text-terminal-muted mt-1 line-clamp-1">{t(`templates.${template.id}.description`)}</p>
                            <div className="flex items-center gap-2 mt-2">
                                <Badge variant="outline" className="text-[10px] h-5 px-1.5 font-normal">
                                    {template.config.type === "sse" ? "sse" : "stdio"}
                                </Badge>
                                {template.difficulty && (
                                    <Badge variant="secondary" className="text-[10px] h-5 px-1.5">
                                        {template.difficulty}
                                    </Badge>
                                )}
                                {template.requiredEnv.length > 0 && (
                                    <Popover>
                                        <PopoverTrigger asChild>
                                            <Button
                                                type="button"
                                                size="sm"
                                                variant="ghost"
                                                className="h-5 px-1.5 text-[10px] text-terminal-muted"
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                <Info className="h-3 w-3 mr-1" />
                                                {t("helpButton")}
                                            </Button>
                                        </PopoverTrigger>
                                        <PopoverContent className="w-72 text-xs">
                                            <div className="space-y-2">
                                                <p className="font-semibold">{t(`templates.${template.id}.name`)}</p>
                                                <p>{t("requiredVariables", { vars: template.requiredEnv.join(", ") })}</p>
                                                {template.setupInstructions && (
                                                    <p className="text-terminal-muted">{t(`templates.${template.id}.setup`)}</p>
                                                )}
                                            </div>
                                        </PopoverContent>
                                    </Popover>
                                )}
                            </div>
                        </div>
                        );
                    })}
                </div>
            </div>

            {/* 2. Plugin-Provided Servers */}
            {pluginServers.length > 0 && (
                <div className="space-y-4">
                    <h3 className="font-mono text-sm font-semibold text-terminal-dark border-b border-terminal-border pb-2">
                        {t("pluginServers")}
                    </h3>
                    <div className="grid gap-3">
                        {pluginServers.map((ps) => {
                            const isConnecting = connectingState[ps.namespacedName];
                            const isSavingUrl = pluginUrlSaving[ps.namespacedName];
                            const isBusy = isConnecting || isSavingUrl;

                            // Determine transport type and whether URL editor should show
                            const cfg = ps.config as { command?: string; url?: string; type?: string };
                            const transportType = cfg.command ? "stdio" : (cfg.type || "sse");
                            const needsUrl = transportType === "sse" || transportType === "http";
                            const showUrlEditor = needsUrl && (ps.incomplete || ps.lastError);

                            const StatusIcon = ps.incomplete
                                ? AlertCircle
                                : ps.connected ? Check : ps.lastError ? X : AlertCircle;
                            const statusBadge = ps.incomplete
                                ? "bg-yellow-100 text-yellow-700"
                                : ps.connected
                                    ? "bg-terminal-green/20 text-terminal-green"
                                    : ps.lastError
                                        ? "bg-red-100 text-red-600"
                                        : "bg-terminal-border text-terminal-muted";

                            return (
                                <div
                                    key={ps.namespacedName}
                                    className={cn(
                                        "flex items-center justify-between p-4 rounded-lg border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 shadow-sm",
                                        ps.incomplete
                                            ? "border-yellow-300/50 opacity-80"
                                            : "border-terminal-border"
                                    )}
                                >
                                    <div className="flex items-center gap-4 flex-1">
                                        <div className={cn("p-2 rounded-full", statusBadge)}>
                                            <StatusIcon className="h-4 w-4" />
                                        </div>
                                        <div className="flex-1">
                                            <div className="flex items-center gap-2">
                                                <h4 className="font-mono font-semibold text-terminal-dark">{ps.serverName}</h4>
                                                <Badge variant="outline" className="text-[10px] h-5 px-1.5 font-normal text-terminal-muted">
                                                    {transportType}
                                                </Badge>
                                                <Badge variant="secondary" className="text-[10px] h-5 px-1.5 font-normal bg-purple-50 text-purple-700 border-purple-200">
                                                    <Plug className="h-3 w-3 mr-1" />
                                                    {t("pluginServerSource", { plugin: ps.pluginName, version: ps.pluginVersion })}
                                                </Badge>
                                                {ps.incomplete && (
                                                    <Badge variant="secondary" className="text-[10px] h-5 px-1.5 font-normal bg-yellow-50 text-yellow-700 border-yellow-200">
                                                        {t("pluginServerIncomplete")}
                                                    </Badge>
                                                )}
                                            </div>

                                            {showUrlEditor ? (
                                                <div className="mt-2 space-y-2">
                                                    <div className="flex items-center gap-2">
                                                        <Globe className="h-4 w-4 text-terminal-muted shrink-0" aria-hidden="true" />
                                                        <Input
                                                            value={pluginUrlInputs[ps.namespacedName] || ""}
                                                            onChange={(e) => setPluginUrlInputs(prev => ({
                                                                ...prev,
                                                                [ps.namespacedName]: e.target.value,
                                                            }))}
                                                            placeholder={t("pluginUrlPlaceholder")}
                                                            className="flex-1 font-mono text-xs"
                                                            disabled={isBusy}
                                                            onKeyDown={(e) => {
                                                                if (e.key === "Enter") handleSavePluginUrl(ps);
                                                            }}
                                                            autoFocus={ps.incomplete}
                                                            aria-label={t("pluginServerUrlFor", { name: ps.serverName })}
                                                        />
                                                        <Button
                                                            size="sm"
                                                            onClick={() => handleSavePluginUrl(ps)}
                                                            disabled={isBusy || !pluginUrlInputs[ps.namespacedName]?.trim()}
                                                            className="shrink-0"
                                                            aria-label={t("pluginSaveUrlFor", { name: ps.serverName })}
                                                        >
                                                            {isBusy ? (
                                                                <Loader2 className="h-4 w-4 animate-spin" />
                                                            ) : (
                                                                <Check className="h-4 w-4" />
                                                            )}
                                                        </Button>
                                                    </div>
                                                    {pluginUrlErrors[ps.namespacedName] ? (
                                                        <p className="text-xs text-red-600 font-mono pl-6">
                                                            {pluginUrlErrors[ps.namespacedName]}
                                                        </p>
                                                    ) : ps.incomplete ? (
                                                        <p className="text-xs text-yellow-700 dark:text-yellow-500 font-mono pl-6">
                                                            {t("pluginServerUrlHint")}
                                                        </p>
                                                    ) : ps.lastError ? (
                                                        <p className="text-xs text-red-600 font-mono pl-6 line-clamp-2" title={ps.lastError}>
                                                            {ps.lastError}
                                                        </p>
                                                    ) : null}
                                                </div>
                                            ) : ps.lastError ? (
                                                <Alert variant="destructive" className="mt-2">
                                                    <AlertCircle className="h-4 w-4" />
                                                    <AlertTitle>{t("connectionFailedTitle")}</AlertTitle>
                                                    <AlertDescription className="text-xs whitespace-pre-wrap font-mono">
                                                        {ps.lastError}
                                                    </AlertDescription>
                                                </Alert>
                                            ) : (
                                                <div className="flex gap-4 mt-1">
                                                    <span className="font-mono text-xs text-terminal-muted">
                                                        {t("pluginServerManaged")}
                                                    </span>
                                                    {ps.connected && (
                                                        <span className="font-mono text-xs text-terminal-green">
                                                            {t("activeTools", { count: ps.toolCount })}
                                                        </span>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-2">
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            className={cn("h-8 px-2", isConnecting && "animate-pulse")}
                                            onClick={() => connectServer(ps.namespacedName)}
                                            disabled={isBusy || Boolean(showUrlEditor && !pluginUrlInputs[ps.namespacedName]?.trim())}
                                            aria-label={t("pluginServerReconnect")}
                                        >
                                            {isConnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4 text-terminal-muted hover:text-terminal-dark" />}
                                        </Button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* 3. Configured Servers List */}
            <div className="space-y-4">
                <div className="flex items-center justify-between border-b border-terminal-border pb-2">
                    <h3 className="font-mono text-sm font-semibold text-terminal-dark">
                        {t("addedServers")}
                    </h3>
                    <Button size="sm" onClick={() => setIsAddingServer(!isAddingServer)} variant={isAddingServer ? "secondary" : "default"}>
                        <Plus className="h-4 w-4 mr-2" />
                        {isAddingServer ? t("cancelAdd") : t("addCustomServer")}
                    </Button>
                </div>

                {/* Add Server Form */}
                {isAddingServer && (
                    <MCPServerForm
                        environment={environment}
                        syncedFolders={syncedFolders}
                        onSave={handleFormSave}
                        onCancel={handleFormCancel}
                        existingNames={Object.keys(mcpServers)}
                    />
                )}

                {/* Server Cards */}
                {Object.keys(mcpServers).length === 0 && !isAddingServer ? (
                    <div className="rounded-lg border border-dashed border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 py-10 text-center">
                        <Plug className="h-8 w-8 text-terminal-muted mx-auto mb-2" />
                        <p className="font-mono text-sm text-terminal-muted">{t("noServersYet")}</p>
                    </div>
                ) : (
                    <div className="grid gap-3">
                        {Object.entries(mcpServers).map(([name, config]) => {
                            const s = getStatusDisplay(name);
                            const StatusIcon = s.icon;
                            const isConnecting = connectingState[name];
                            const currentStatus = status.find(st => st.serverName === name);
                            const isEditing = editingServer === name;
                            const isOAuthServer = !config.command && (
                                config.auth?.type === "oauth" ||
                                (config.type === "http" && config.auth?.type !== "none" && config.auth?.type !== "headers")
                            );

                            if (isEditing) {
                                return (
                                    <MCPServerForm
                                        key={name}
                                        initialConfig={config}
                                        initialName={name}
                                        environment={environment}
                                        syncedFolders={syncedFolders}
                                        onSave={handleFormSave}
                                        onCancel={handleFormCancel}
                                        existingNames={Object.keys(mcpServers).filter(n => n !== name)}
                                    />
                                );
                            }

                            return (
                                <div
                                    key={name}
                                    className={cn(
                                        "flex items-center justify-between p-4 rounded-lg border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 shadow-sm hover:shadow-md transition-all",
                                        config.enabled === false
                                            ? "border-terminal-border/50 opacity-60"
                                            : "border-terminal-border"
                                    )}
                                >
                                    <div className="flex items-center gap-4 flex-1">
                                        <div className={cn("p-2 rounded-full", s.badge)}>
                                            <StatusIcon className="h-4 w-4" />
                                        </div>
                                        <div className="flex-1">
                                            <div className="flex items-center gap-2">
                                                <h4 className="font-mono font-semibold text-terminal-dark">{name}</h4>
                                                <Badge variant="outline" className="text-[10px] h-5 px-1.5 font-normal text-terminal-muted">
                                                    {config.type || (config.command ? "stdio" : "sse")}
                                                </Badge>
                                                {config.enabled === false && (
                                                    <Badge
                                                        variant="secondary"
                                                        className="text-[10px] h-5 px-1.5 font-normal bg-yellow-100 text-yellow-700"
                                                        title={t("disabledTooltip")}
                                                    >
                                                        {t("disabledBadge")}
                                                    </Badge>
                                                )}
                                                {/* Show header count for SSE servers */}
                                                {!config.command && config.headers && Object.keys(config.headers).length > 0 && (
                                                    <Badge variant="outline" className="text-[10px] h-5 px-1.5 font-normal bg-blue-50 text-blue-700 border-blue-200">
                                                        {t("headerCount", { count: Object.keys(config.headers).length })}
                                                    </Badge>
                                                )}
                                                {isOAuthServer && (
                                                    <Badge variant="outline" className="text-[10px] h-5 px-1.5 font-normal bg-yellow-50 text-yellow-700 border-yellow-200">
                                                        <Shield className="h-3 w-3 mr-1" />
                                                        {t("browserAuthBadge")}
                                                    </Badge>
                                                )}
                                            </div>

                                            {currentStatus?.authRequired ? (
                                                <Alert className="mt-2 border-yellow-300 bg-yellow-50/80 text-yellow-900">
                                                    <Shield className="h-4 w-4" />
                                                    <AlertTitle>{s.text}</AlertTitle>
                                                    <AlertDescription className="space-y-2 text-xs">
                                                        <div className="space-y-1 font-mono whitespace-pre-wrap">
                                                            {currentStatus.details && <p>{currentStatus.details}</p>}
                                                            {currentStatus.recovery && <p>{currentStatus.recovery}</p>}
                                                            {currentStatus.lastError && <p>{currentStatus.lastError}</p>}
                                                        </div>
                                                        <Button
                                                            size="sm"
                                                            variant="outline"
                                                            className="h-7 text-[11px]"
                                                            onClick={() => currentStatus.authorizationUrl
                                                                ? openAuthorizationUrl(name, currentStatus.authorizationUrl)
                                                                : startOAuthAuthorization(name)}
                                                            disabled={isConnecting || config.enabled === false}
                                                        >
                                                            <ExternalLink className="mr-2 h-3 w-3" />
                                                            {currentStatus.authorizationUrl ? t("openAuthorization") : t("connectWithBrowser")}
                                                        </Button>
                                                    </AlertDescription>
                                                </Alert>
                                            ) : currentStatus?.lastError ? (
                                                <Alert variant="destructive" className="mt-2">
                                                    <AlertCircle className="h-4 w-4" />
                                                    <AlertTitle>{t("connectionFailedTitle")}</AlertTitle>
                                                    <AlertDescription className="space-y-1 text-xs whitespace-pre-wrap font-mono">
                                                        <p>{currentStatus.lastError}</p>
                                                        {currentStatus.recovery && <p>{currentStatus.recovery}</p>}
                                                    </AlertDescription>
                                                </Alert>
                                            ) : (
                                                <div className="flex gap-4 mt-1">
                                                    <span className="font-mono text-xs text-terminal-muted truncate max-w-[300px]" title={config.command ? `${config.command} ${config.args?.join(" ")}` : config.url}>
                                                        {config.command ? `${config.command} ${config.args?.join(" ")}` : config.url}
                                                    </span>
                                                    {currentStatus?.connected && (
                                                        <span className="font-mono text-xs text-terminal-green">
                                                            {t("activeTools", { count: currentStatus.toolCount })}
                                                        </span>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-2">
                                        <Switch
                                            checked={config.enabled !== false}
                                            onCheckedChange={(checked) => handleToggleServer(name, checked)}
                                            className="data-[state=checked]:bg-terminal-green"
                                            aria-label={config.enabled !== false ? t("disableServer") : t("enableServer")}
                                            disabled={isSaving}
                                        />

                                        {isOAuthServer && (
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                className="h-8 px-2 text-[11px]"
                                                onClick={() => startOAuthAuthorization(name)}
                                                disabled={isConnecting || config.enabled === false}
                                                aria-label={t("connectWithBrowser")}
                                                title={t("connectWithBrowser")}
                                            >
                                                {isConnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
                                            </Button>
                                        )}
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            className={cn("h-8 px-2", isConnecting && "animate-pulse")}
                                            onClick={() => connectServer(name)}
                                            disabled={isConnecting || config.enabled === false}
                                            aria-label={t("reconnectServer")}
                                        >
                                            {isConnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4 text-terminal-muted hover:text-terminal-dark" />}
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            className="h-8 px-2"
                                            onClick={() => setEditingServer(name)}
                                            disabled={config.enabled === false}
                                            aria-label={t("editServer")}
                                        >
                                            <Edit2 className="h-4 w-4 text-terminal-muted hover:text-terminal-dark" />
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            className="h-8 px-2 hover:bg-red-50"
                                            onClick={() => handleDeleteServer(name)}
                                            aria-label={t("deleteServer")}
                                        >
                                            <Trash2 className="h-4 w-4 text-terminal-muted hover:text-red-500" />
                                        </Button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* 3. Environment Variables */}
            <div className="space-y-4">
                <h3 className="font-mono text-sm font-semibold text-terminal-dark border-b border-terminal-border pb-2">
                    {t("environmentVariables")}
                </h3>

                {/* 📁 Available Variables Section */}


                <div className="space-y-2">
                    {Object.keys(environment).length === 0 && (
                        <p className="font-mono text-xs text-terminal-muted italic">{t("noEnvVarsYet")}</p>
                    )}

                    {Object.entries(environment).map(([key, value]) => (
                        <div key={key} className="flex items-center gap-2">
                            <Input value={key} disabled className="w-1/3 font-mono text-xs bg-gray-50" />
                            <Input
                                type="password"
                                value={value}
                                onChange={(e) => setEnvironment({ ...environment, [key]: e.target.value })}
                                placeholder={t("envValuePlaceholder")}
                                className="flex-1 font-mono text-xs"
                                onBlur={() => saveAll(mcpServers, environment)}
                            />
                            <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={t("removeEnvVar")} onClick={() => {
                                const newEnv = { ...environment };
                                delete newEnv[key];
                                setEnvironment(newEnv);
                                saveAll(mcpServers, newEnv);
                            }}>
                                <X className="h-3 w-3" />
                            </Button>
                        </div>
                    ))}

                    {!showNewEnvInput ? (
                        <Button size="sm" variant="outline" onClick={() => setShowNewEnvInput(true)} className="mt-2">
                            <Plus className="h-3 w-3 mr-2" /> {t("addVariable")}
                        </Button>
                    ) : (
                        <div className="flex gap-2 mt-2 items-center animate-in fade-in">
                            <Input
                                value={newEnvKey}
                                onChange={(e) => setNewEnvKey(e.target.value)}
                                placeholder={t("envKeyPlaceholder")}
                                className="w-1/3 font-mono text-xs"
                                autoFocus
                                onKeyDown={(e) => {
                                    if (e.key === "Enter" && newEnvKey) {
                                        setEnvironment({ ...environment, [newEnvKey]: "" });
                                        setNewEnvKey("");
                                        setShowNewEnvInput(false);
                                    }
                                }}
                            />
                            <span className="text-xs text-terminal-muted">=</span>
                            <span className="text-xs text-terminal-muted italic">{t("envValueHint")}</span>
                            <div className="flex gap-1 ml-auto">
                                <Button size="sm" onClick={() => {
                                    if (newEnvKey) {
                                        setEnvironment({ ...environment, [newEnvKey]: "" });
                                        setNewEnvKey("");
                                        setShowNewEnvInput(false);
                                    }
                                }}>{t("addEnvVar")}</Button>
                                <Button size="sm" variant="ghost" onClick={() => setShowNewEnvInput(false)}>{t("cancelEnvVar")}</Button>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* 4. Advanced Mode Toggle */}
            <div className="pt-4 border-t border-terminal-border">
                <Button
                    variant="link"
                    size="sm"
                    onClick={() => setShowJsonMode(!showJsonMode)}
                    className="text-xs text-terminal-muted hover:text-terminal-dark p-0"
                >
                    {showJsonMode ? t("hideAdvancedJson") : t("showAdvancedJson")}
                </Button>

                {showJsonMode && (
                    <div className="mt-4 space-y-2 animate-in fade-in slide-in-from-top-2">
                        <Label>{t("rawJsonSettings")}</Label>
                        <Textarea
                            value={rawJson}
                            onChange={(e) => setRawJson(e.target.value)}
                            className="font-mono text-xs h-48"
                        />
                        <div className="flex justify-end">
                            <Button size="sm" onClick={() => {
                                try {
                                    const parsed = JSON.parse(rawJson);
                                    const validationErrors = validateRawMcpJson(parsed);
                                    if (validationErrors.length > 0) {
                                        toast.error(t("invalidJsonValidationError", { error: validationErrors[0] }));
                                        return;
                                    }
                                    const parsedServers = (parsed as { mcpServers: Record<string, MCPServerConfig> }).mcpServers;
                                    setMcpServers(parsedServers);
                                    saveAll(parsedServers, environment);
                                } catch (e) {
                                    toast.error(t("invalidJsonSyntax"));
                                }
                            }}>{t("applyJson")}</Button>
                        </div>
                        <p className="text-xs text-terminal-muted">{t("jsonKeyHint")}</p>
                    </div>
                )}
            </div>

            {/* Env var collection dialog for templates that need credentials */}
            <MCPTemplateEnvDialog
                template={pendingTemplate}
                existingEnv={environment}
                onInstall={handleTemplateEnvInstall}
                onCancel={() => setPendingTemplate(null)}
            />

        </div>
    );
}
