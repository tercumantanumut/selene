/**
 * MCP Server Form Component
 *
 * Guided, URL-first MCP server setup. Advanced/static-header and local command
 * options stay available without making every user understand raw config shape.
 */

"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
    AlertTriangle,
    Check,
    Globe,
    Key,
    Lock,
    Plus,
    Server,
    Shield,
    Terminal,
    X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { MCPServerConfig } from "@/lib/mcp/types";

interface MCPServerFormProps {
    initialConfig?: MCPServerConfig;
    initialName?: string;
    environment: Record<string, string>;
    syncedFolders: Array<{ folderPath: string; isPrimary: boolean }>;
    onSave: (name: string, config: MCPServerConfig) => Promise<void>;
    onCancel: () => void;
    existingNames?: string[];
}

type GuidedTransport = "http" | "sse" | "stdio";
type GuidedAuthMode = "oauth" | "none" | "headers";

function inferInitialTransport(config?: MCPServerConfig): GuidedTransport {
    if (config?.command) return "stdio";
    if (config?.type === "sse") return "sse";
    return "http";
}

function inferInitialAuth(config?: MCPServerConfig): GuidedAuthMode {
    if (config?.auth?.type === "headers" || config?.headers) return "headers";
    if (config?.auth?.type === "none") return "none";
    return "oauth";
}

function normalizeUrlForName(value: string): string {
    try {
        const parsed = new URL(value);
        return parsed.hostname
            .replace(/^www\./, "")
            .replace(/\.[a-z]+$/i, "")
            .replace(/[^a-zA-Z0-9_-]/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 32) || "mcp-server";
    } catch {
        return "mcp-server";
    }
}

export function MCPServerForm({
    initialConfig,
    initialName = "",
    environment,
    syncedFolders,
    onSave,
    onCancel,
    existingNames = [],
}: MCPServerFormProps) {
    const t = useTranslations("settings.mcp");
    const [serverName, setServerName] = useState(initialName);
    const [nameEdited, setNameEdited] = useState(Boolean(initialName));
    const [transport, setTransport] = useState<GuidedTransport>(inferInitialTransport(initialConfig));
    const [authMode, setAuthMode] = useState<GuidedAuthMode>(inferInitialAuth(initialConfig));
    const [url, setUrl] = useState(initialConfig?.url || "");
    const [command, setCommand] = useState(initialConfig?.command || "");
    const [args, setArgs] = useState<string[]>(initialConfig?.args || []);
    const [newArg, setNewArg] = useState("");
    const [headers, setHeaders] = useState<Record<string, string>>(initialConfig?.headers || {});
    const [newHeaderKey, setNewHeaderKey] = useState("");
    const [newHeaderValue, setNewHeaderValue] = useState("");
    const [showAdvanced, setShowAdvanced] = useState(Boolean(initialConfig?.headers || initialConfig?.args?.length));
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        if (initialName || nameEdited || !url.trim()) return;
        setServerName(normalizeUrlForName(url));
    }, [initialName, nameEdited, url]);

    useEffect(() => {
        if (transport === "http" && authMode === "none") setAuthMode("oauth");
        if (transport === "stdio") setAuthMode("none");
    }, [transport, authMode]);

    const errors = useMemo(() => {
        const next: string[] = [];
        const trimmedName = serverName.trim();

        if (!trimmedName) {
            next.push(t("validationServerNameRequired"));
        } else if (existingNames.includes(trimmedName) && trimmedName !== initialName) {
            next.push(t("validationServerNameExists"));
        }

        if (transport === "stdio") {
            if (!command.trim()) next.push(t("validationCommandRequired"));
        } else if (!url.trim()) {
            next.push(t("validationUrlRequired"));
        } else {
            try {
                const parsed = new URL(url.replace(/\$\{[^}]+\}/g, "placeholder"));
                if (!["http:", "https:"].includes(parsed.protocol)) {
                    next.push(t("validationInvalidUrl"));
                }
            } catch {
                next.push(t("validationInvalidUrl"));
            }
        }

        if (authMode === "headers" && Object.keys(headers).length === 0) {
            next.push(t("validationHeaderRequired"));
        }

        return next;
    }, [authMode, command, existingNames, headers, initialName, serverName, t, transport, url]);

    const addArg = () => {
        const value = newArg.trim();
        if (!value) return;
        setArgs(prev => [...prev, value]);
        setNewArg("");
    };

    const addHeader = () => {
        const key = newHeaderKey.trim();
        const value = newHeaderValue.trim();
        if (!key || !value) return;
        setHeaders(prev => ({ ...prev, [key]: value }));
        setNewHeaderKey("");
        setNewHeaderValue("");
    };

    const upsertQuickHeader = (key: string, value: string) => {
        setHeaders(prev => ({ ...prev, [key]: value }));
        setShowAdvanced(true);
    };

    const handleSubmit = async () => {
        if (errors.length > 0) return;

        setIsSaving(true);
        try {
            let config: MCPServerConfig;

            if (transport === "stdio") {
                config = {
                    command: command.trim(),
                    args: args.filter(Boolean),
                };
            } else {
                config = {
                    type: transport,
                    url: url.trim(),
                    auth: { type: authMode },
                };

                if (authMode === "headers" && Object.keys(headers).length > 0) {
                    config.headers = headers;
                }
            }

            await onSave(serverName.trim(), config);
        } catch (error) {
            console.error("Failed to save server:", error);
            toast.error(t("saveFailed"));
        } finally {
            setIsSaving(false);
        }
    };

    const transportOptions: Array<{
        id: GuidedTransport;
        icon: typeof Globe;
        label: string;
        hint: string;
    }> = [
        { id: "http", icon: Globe, label: t("streamableHttp"), hint: t("streamableHttpHint") },
        { id: "sse", icon: Server, label: t("legacySse"), hint: t("legacySseHint") },
        { id: "stdio", icon: Terminal, label: t("localCommand"), hint: t("localCommandHint") },
    ];

    const authOptions: Array<{
        id: GuidedAuthMode;
        icon: typeof Shield;
        label: string;
        hint: string;
    }> = [
        { id: "oauth", icon: Shield, label: t("authAutomatic"), hint: t("authAutomaticHint") },
        { id: "none", icon: Check, label: t("authNone"), hint: t("authNoneHint") },
        { id: "headers", icon: Key, label: t("authHeaders"), hint: t("authHeadersHint") },
    ];

    return (
        <div className="space-y-5 rounded-lg border border-terminal-green bg-terminal-green/5 p-4">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h4 className="font-mono text-sm font-semibold text-terminal-dark">
                        {initialName ? t("editServer") : t("addNewServer")}
                    </h4>
                    <p className="mt-1 max-w-2xl font-mono text-xs text-terminal-muted">
                        {t("guidedSubtitle")}
                    </p>
                </div>
                <Badge variant="outline" className="shrink-0 text-[10px]">
                    {t("guidedSetup")}
                </Badge>
            </div>

            <div className="space-y-2">
                <Label>{t("clientMode")}</Label>
                <div className="grid gap-2 md:grid-cols-3">
                    {transportOptions.map(option => {
                        const Icon = option.icon;
                        const selected = transport === option.id;
                        return (
                            <button
                                key={option.id}
                                type="button"
                                onClick={() => setTransport(option.id)}
                                className={cn(
                                    "rounded-md border p-3 text-left transition-colors",
                                    selected
                                        ? "border-terminal-green bg-terminal-green/10"
                                        : "border-terminal-border bg-terminal-cream/80 hover:border-terminal-green/50"
                                )}
                            >
                                <div className="flex items-center gap-2 font-mono text-xs font-semibold text-terminal-dark">
                                    <Icon className="h-4 w-4" />
                                    {option.label}
                                </div>
                                <p className="mt-1 font-mono text-[11px] leading-relaxed text-terminal-muted">
                                    {option.hint}
                                </p>
                            </button>
                        );
                    })}
                </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                    <Label>{t("serverName")}</Label>
                    <Input
                        value={serverName}
                        onChange={(event) => {
                            setNameEdited(true);
                            setServerName(event.target.value);
                        }}
                        placeholder={t("serverNamePlaceholder")}
                        className="font-mono"
                        disabled={Boolean(initialName)}
                    />
                </div>

                {transport !== "stdio" ? (
                    <div className="space-y-2">
                        <Label>{t("serverUrl")}</Label>
                        <Input
                            value={url}
                            onChange={(event) => setUrl(event.target.value)}
                            placeholder={transport === "http" ? "https://api.mobbin.com/mcp" : t("urlPlaceholder")}
                            className="font-mono text-xs"
                        />
                    </div>
                ) : (
                    <div className="space-y-2">
                        <Label>{t("command")}</Label>
                        <Input
                            value={command}
                            onChange={(event) => setCommand(event.target.value)}
                            placeholder={t("commandPlaceholder")}
                            className="font-mono text-xs"
                        />
                    </div>
                )}
            </div>

            {transport !== "stdio" && (
                <div className="space-y-2">
                    <Label>{t("authMethod")}</Label>
                    <div className="grid gap-2 md:grid-cols-3">
                        {authOptions.map(option => {
                            const Icon = option.icon;
                            const selected = authMode === option.id;
                            return (
                                <button
                                    key={option.id}
                                    type="button"
                                    onClick={() => setAuthMode(option.id)}
                                    className={cn(
                                        "rounded-md border p-3 text-left transition-colors",
                                        selected
                                            ? "border-terminal-green bg-terminal-green/10"
                                            : "border-terminal-border bg-terminal-cream/80 hover:border-terminal-green/50"
                                    )}
                                >
                                    <div className="flex items-center gap-2 font-mono text-xs font-semibold text-terminal-dark">
                                        <Icon className="h-4 w-4" />
                                        {option.label}
                                    </div>
                                    <p className="mt-1 font-mono text-[11px] leading-relaxed text-terminal-muted">
                                        {option.hint}
                                    </p>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}

            {authMode === "headers" && transport !== "stdio" && (
                <div className="space-y-3 rounded-md border border-terminal-border bg-terminal-cream/80 p-3">
                    <div className="flex items-center justify-between gap-2">
                        <div>
                            <Label>{t("requestHeaders")}</Label>
                            <p className="mt-1 font-mono text-[11px] text-terminal-muted">
                                {t("headersOnlyWhenNeeded")}
                            </p>
                        </div>
                        <div className="flex flex-wrap justify-end gap-1">
                            <Button type="button" size="sm" variant="outline" className="h-7 text-[10px]" onClick={() => upsertQuickHeader("Authorization", "Bearer ${YOUR_API_KEY}")}>
                                <Shield className="mr-1 h-3 w-3" />
                                {t("bearerToken")}
                            </Button>
                            <Button type="button" size="sm" variant="outline" className="h-7 text-[10px]" onClick={() => upsertQuickHeader("X-API-Key", "${YOUR_API_KEY}")}>
                                <Key className="mr-1 h-3 w-3" />
                                {t("apiKey")}
                            </Button>
                            <Button type="button" size="sm" variant="outline" className="h-7 text-[10px]" onClick={() => upsertQuickHeader("Authorization", "Basic dXNlcm5hbWU6cGFzc3dvcmQ=")}>
                                <Lock className="mr-1 h-3 w-3" />
                                {t("basicAuth")}
                            </Button>
                        </div>
                    </div>

                    <div className="space-y-2">
                        {Object.entries(headers).map(([key, value]) => (
                            <div key={key} className="flex items-center gap-2">
                                <Input value={key} disabled className="w-1/3 font-mono text-xs bg-gray-50" />
                                <Input
                                    type="password"
                                    value={value}
                                    onChange={(event) => setHeaders(prev => ({ ...prev, [key]: event.target.value }))}
                                    placeholder={t("headerValuePlaceholder")}
                                    className="font-mono text-xs"
                                />
                                <Button type="button" size="icon" variant="ghost" className="h-8 w-8" aria-label={t("removeHeader")} onClick={() => {
                                    setHeaders(prev => {
                                        const next = { ...prev };
                                        delete next[key];
                                        return next;
                                    });
                                }}>
                                    <X className="h-3 w-3" />
                                </Button>
                            </div>
                        ))}

                        <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
                            <Input
                                value={newHeaderKey}
                                onChange={(event) => setNewHeaderKey(event.target.value)}
                                placeholder={t("headerNamePlaceholder")}
                                className="font-mono text-xs"
                            />
                            <Input
                                value={newHeaderValue}
                                onChange={(event) => setNewHeaderValue(event.target.value)}
                                placeholder={t("headerValuePlaceholder")}
                                className="font-mono text-xs"
                                onKeyDown={(event) => event.key === "Enter" && addHeader()}
                            />
                            <Button type="button" variant="outline" onClick={addHeader} disabled={!newHeaderKey.trim() || !newHeaderValue.trim()}>
                                <Plus className="mr-2 h-3 w-3" />
                                {t("confirmHeader")}
                            </Button>
                        </div>
                    </div>
                </div>
            )}

            {transport === "stdio" && (
                <div className="space-y-3 rounded-md border border-terminal-border bg-terminal-cream/80 p-3">
                    <div className="flex items-center justify-between">
                        <div>
                            <Label>{t("arguments")}</Label>
                            <p className="mt-1 font-mono text-[11px] text-terminal-muted">
                                {t("localCommandArgsHint")}
                            </p>
                        </div>
                    </div>

                    <div className="space-y-2">
                        {args.map((arg, index) => (
                            <div key={`${arg}-${index}`} className="flex items-center gap-2">
                                <Input
                                    value={arg}
                                    onChange={(event) => setArgs(prev => prev.map((item, i) => i === index ? event.target.value : item))}
                                    className="font-mono text-xs"
                                />
                                <Button type="button" size="icon" variant="ghost" className="h-8 w-8" aria-label={t("removeArg")} onClick={() => setArgs(prev => prev.filter((_, i) => i !== index))}>
                                    <X className="h-3 w-3" />
                                </Button>
                            </div>
                        ))}

                        <div className="flex items-center gap-2">
                            <Input
                                value={newArg}
                                onChange={(event) => setNewArg(event.target.value)}
                                placeholder={t("addArgumentPlaceholder")}
                                className="font-mono text-xs"
                                onKeyDown={(event) => event.key === "Enter" && addArg()}
                            />
                            <Button type="button" variant="outline" onClick={addArg} disabled={!newArg.trim()}>
                                <Plus className="h-3 w-3" />
                            </Button>
                        </div>
                    </div>
                </div>
            )}

            <button
                type="button"
                onClick={() => setShowAdvanced(prev => !prev)}
                className="font-mono text-xs text-terminal-muted underline-offset-4 hover:text-terminal-dark hover:underline"
            >
                {showAdvanced ? t("hideAdvancedOptions") : t("showAdvancedOptions")}
            </button>

            {showAdvanced && (
                <div className="rounded-md border border-terminal-border bg-terminal-bg/30 p-3 font-mono text-[11px] text-terminal-muted">
                    <p className="font-semibold text-terminal-dark">{t("advancedOptions")}</p>
                    <p className="mt-1">{t("advancedOptionsHint")}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                        {Object.keys(environment).map(key => (
                            <Badge key={key} variant="outline" className="font-mono text-[10px]">
                                ${"{" + key + "}"}
                            </Badge>
                        ))}
                        {syncedFolders.length > 0 && (
                            <>
                                <Badge variant="outline" className="font-mono text-[10px]">${"{SYNCED_FOLDER}"}</Badge>
                                <Badge variant="outline" className="font-mono text-[10px]">${"{SYNCED_FOLDERS_ARRAY}"}</Badge>
                            </>
                        )}
                    </div>
                </div>
            )}

            {errors.length > 0 && (
                <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription className="text-xs">
                        <ul className="list-inside list-disc space-y-1">
                            {errors.map((error, index) => <li key={index}>{error}</li>)}
                        </ul>
                    </AlertDescription>
                </Alert>
            )}

            <div className="flex justify-end gap-2 border-t border-terminal-border pt-2">
                <Button variant="ghost" onClick={onCancel} disabled={isSaving}>
                    {t("cancel")}
                </Button>
                <Button onClick={handleSubmit} disabled={errors.length > 0 || isSaving}>
                    {isSaving ? t("saving") : t("saveAndConnect")}
                </Button>
            </div>
        </div>
    );
}
