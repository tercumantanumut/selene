"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";
import { ArrowLeft, ArrowRight, Loader2, CheckCircle2, AlertCircle, Wifi, WifiOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { resilientFetch, resilientPut } from "@/lib/utils/resilient-fetch";
import { invalidateSettingsCache } from "@/lib/hooks/use-settings";

import type { OnboardingProvider } from "./provider-step";

interface AuthStepProps {
    provider: OnboardingProvider;
    onAuthenticated: () => void;
    onBack: () => void;
    onSkip: () => void;
}

export function AuthStep({ provider, onAuthenticated, onBack, onSkip }: AuthStepProps) {
    const t = useTranslations("onboarding.auth");
    const [apiKey, setApiKey] = useState("");
    const [loading, setLoading] = useState(false);
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [claudeCodePasteMode, setClaudeCodePasteMode] = useState(false);
    const [claudeCodePasteValue, setClaudeCodePasteValue] = useState("");
    const [claudeCodeAutoChecking, setClaudeCodeAutoChecking] = useState(false);
    const [claudeCodeBrowserOpened, setClaudeCodeBrowserOpened] = useState(true);

    // Ollama-specific state
    const [ollamaBaseUrl, setOllamaBaseUrl] = useState("http://localhost:11434");
    const [ollamaTestStatus, setOllamaTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");

    // Kimi device flow state
    const [kimiDeviceCode, setKimiDeviceCode] = useState<string | null>(null);
    const [kimiUserCode, setKimiUserCode] = useState<string | null>(null);
    const [kimiVerificationUrl, setKimiVerificationUrl] = useState<string | null>(null);
    const [kimiPolling, setKimiPolling] = useState(false);
    const kimiAbortRef = useRef(false);

    // Cleanup Kimi polling on unmount
    useEffect(() => {
        return () => {
            kimiAbortRef.current = true;
        };
    }, []);

    // Check if already authenticated for OAuth providers
    useEffect(() => {
        if (provider === "antigravity") {
            void checkOAuthAuth("/api/auth/antigravity");
        } else if (provider === "codex") {
            void checkOAuthAuth("/api/auth/codex");
        } else if (provider === "claudecode") {
            void checkOAuthAuth("/api/auth/claudecode", { forceRefresh: true });
        } else if (provider === "kimi") {
            void checkOAuthAuth("/api/auth/kimi");
        }
    }, [provider]);

    const checkOAuthAuth = async (endpoint: string, options: { forceRefresh?: boolean } = {}) => {
        try {
            const separator = endpoint.includes("?") ? "&" : "?";
            const refreshSuffix = options.forceRefresh ? `${separator}refresh=1` : "";
            const { data } = await resilientFetch<{ authenticated: boolean }>(`${endpoint}${refreshSuffix}${refreshSuffix ? "&" : separator}t=${Date.now()}`, { retries: 0 });
            if (data?.authenticated) {
                setIsAuthenticated(true);
                setClaudeCodePasteMode(false);
                setClaudeCodePasteValue("");
            }
            return !!data?.authenticated;
        } catch (err) {
            console.error(`Failed to check auth for ${endpoint}:`, err);
            return false;
        }
    };

    const waitForClaudeCodeAuthentication = async (attempts = 12, delayMs = 1000) => {
        setClaudeCodeAutoChecking(true);
        try {
            for (let attempt = 0; attempt < attempts; attempt += 1) {
                const authenticated = await checkOAuthAuth("/api/auth/claudecode", { forceRefresh: true });
                if (authenticated) {
                    return true;
                }

                if (attempt < attempts - 1) {
                    await new Promise((resolve) => setTimeout(resolve, delayMs));
                }
            }

            return false;
        } finally {
            setClaudeCodeAutoChecking(false);
        }
    };

    const handleOllamaTest = useCallback(async () => {
        setOllamaTestStatus("testing");
        setError(null);

        try {
            const response = await fetch("/api/ollama/check", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ baseUrl: ollamaBaseUrl }),
            });
            const data = await response.json();

            if (data.ok) {
                setOllamaTestStatus("success");
                // Save ollama settings
                const { error: saveError } = await resilientPut("/api/settings", {
                    llmProvider: "ollama",
                    ollamaBaseUrl: ollamaBaseUrl.replace(/\/?$/, "/v1"),
                });
                if (saveError) {
                    throw new Error(t("errors.failedSaveOllama"));
                }
                invalidateSettingsCache();
                setIsAuthenticated(true);
            } else {
                setOllamaTestStatus("error");
                setError(data.error || t("ollama.cannotReach"));
            }
        } catch (err) {
            setOllamaTestStatus("error");
            setError(err instanceof Error ? err.message : t("ollama.cannotReach"));
        }
    }, [ollamaBaseUrl, t]);

    const handleOAuthLogin = async (config: {
        popupName: string;
        connectingMessage: string;
        authorizeEndpoint: string;
        pollEndpoint: string;
        logLabel: string;
    }) => {
        setLoading(true);
        setError(null);

        const electronAPI = typeof window !== "undefined" && "electronAPI" in window
            ? (window as unknown as { electronAPI?: { isElectron?: boolean; shell?: { openExternal: (url: string) => Promise<void> } } }).electronAPI
            : undefined;
        const isElectron = !!electronAPI?.isElectron;

        let popup: Window | null = null;
        let pollInterval: NodeJS.Timeout | null = null;
        let timeoutId: NodeJS.Timeout | null = null;

        const cleanup = () => {
            if (pollInterval) clearInterval(pollInterval);
            if (timeoutId) clearTimeout(timeoutId);
            setLoading(false);
        };

        try {
            // Open a placeholder popup synchronously
            if (!isElectron) {
                const width = 500;
                const height = 700;
                const left = window.screenX + (window.outerWidth - width) / 2;
                const top = window.screenY + (window.outerHeight - height) / 2;

                popup = window.open(
                    "about:blank",
                    config.popupName,
                    `width=${width},height=${height},left=${left},top=${top}`
                );

                if (popup) {
                    popup.document.write(`<p style='font-family:monospace;padding:20px'>${config.connectingMessage}</p>`);
                }
            }

            // Get the OAuth authorization URL
            const { data: authData, error: authError } = await resilientFetch<{ success: boolean; url: string; error?: string }>(config.authorizeEndpoint, { retries: 1 });

            if (authError || !authData?.success || !authData?.url) {
                popup?.close();
                throw new Error(authData?.error || authError || t("errors.authFailed"));
            }

            if (isElectron && electronAPI?.shell?.openExternal) {
                await electronAPI.shell.openExternal(authData.url);
            } else if (popup) {
                popup.location.href = authData.url;
            } else {
                toast.error(t("popupBlocked"));
                cleanup();
                return;
            }

            // Poll for auth completion
            let pollInFlight = false;
            pollInterval = setInterval(async () => {
                if (pollInFlight) return;
                pollInFlight = true;
                try {
                    const response = await fetch(`${config.pollEndpoint}?t=${Date.now()}`);
                    if (response.ok) {
                        const data = await response.json();
                        if (data.authenticated) {
                            popup?.close();
                            setIsAuthenticated(true);
                            cleanup();
                            return;
                        }
                    }

                    if (popup?.closed) {
                        await new Promise(resolve => setTimeout(resolve, 500));
                        const finalCheck = await fetch(`${config.pollEndpoint}?t=${Date.now()}`);
                        if (finalCheck.ok) {
                            const data = await finalCheck.json();
                            if (data.authenticated) {
                                setIsAuthenticated(true);
                            }
                        }
                        cleanup();
                    }
                } finally {
                    pollInFlight = false;
                }
            }, 1000);

            // Timeout after 5 minutes
            timeoutId = setTimeout(() => {
                popup?.close();
                cleanup();
            }, 5 * 60 * 1000);

        } catch (err) {
            console.error(`${config.logLabel} login failed:`, err);
            setError(err instanceof Error ? err.message : t("errors.authFailed"));
            cleanup();
        }
    };

    const handleAntigravityLogin = () => handleOAuthLogin({
        popupName: "antigravity-auth",
        connectingMessage: t("connectingGoogle"),
        authorizeEndpoint: "/api/auth/antigravity/authorize",
        pollEndpoint: "/api/auth/antigravity",
        logLabel: "Antigravity",
    });

    const handleCodexLogin = () => handleOAuthLogin({
        popupName: "codex-auth",
        connectingMessage: t("connectingOpenAI"),
        authorizeEndpoint: "/api/auth/codex/authorize",
        pollEndpoint: "/api/auth/codex",
        logLabel: "Codex",
    });

    const handleClaudeCodeLogin = async () => {
        setLoading(true);
        setError(null);

        const electronAPI = typeof window !== "undefined" && "electronAPI" in window
            ? (window as unknown as { electronAPI?: { isElectron?: boolean; shell?: { openExternal: (url: string) => Promise<void> } } }).electronAPI
            : undefined;
        const isElectron = !!electronAPI?.isElectron;

        try {
            // Plain fetch — no timeout. The authorize endpoint spawns `dario login`
            // which can take well over 10s on first run; resilientFetch's default
            // 10s timeout would abort the request prematurely.
            const authResponse = await fetch("/api/auth/claudecode/authorize");
            const authData = await authResponse.json();

            if (!authData.success) {
                throw new Error(authData.error || t("errors.authFailed"));
            }

            if (authData.authenticated) {
                setIsAuthenticated(true);
                setClaudeCodePasteMode(false);
                setClaudeCodePasteValue("");
                setLoading(false);
                return;
            }

            if (authData.url) {
                if (isElectron && electronAPI?.shell?.openExternal) {
                    await electronAPI.shell.openExternal(authData.url);
                } else {
                    window.open(authData.url, "_blank");
                }
                setClaudeCodeBrowserOpened(true);
            } else {
                setClaudeCodeBrowserOpened(false);
            }

            const authenticated = await waitForClaudeCodeAuthentication();
            if (authenticated) {
                setLoading(false);
                return;
            }

            // Fall back to manual code entry only when the SDK has not completed the login yet.
            setClaudeCodePasteMode(true);
            setLoading(false);
        } catch (err) {
            console.error("Claude Code login failed:", err);
            setError(err instanceof Error ? err.message : t("errors.authFailed"));
            setLoading(false);
        }
    };

    const handleClaudeCodeAuthCheck = async () => {
        setLoading(true);
        setError(null);

        try {
            const response = await fetch("/api/auth/claudecode/exchange", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code: claudeCodePasteValue }),
            });
            const data = await response.json();

            if (!data.success) {
                throw new Error(data.error || t("errors.claudeCodeNotAuth"));
            }

            setIsAuthenticated(true);
            setClaudeCodePasteMode(false);
            setClaudeCodePasteValue("");
        } catch (err) {
            console.error("Claude Code auth verification failed:", err);
            setError(err instanceof Error ? err.message : t("errors.codeExchangeFailed"));
        } finally {
            setLoading(false);
        }
    };

    const handleKimiDeviceLogin = async () => {
        setLoading(true);
        setError(null);
        kimiAbortRef.current = false;

        try {
            // Initiate device authorization
            const response = await fetch("/api/auth/kimi/device", { method: "POST" });
            const data = await response.json();

            if (!data.success) {
                throw new Error(data.error || t("errors.deviceAuthInitFailed"));
            }

            const verificationUrl = data.verification_uri_complete || data.verification_uri;

            setKimiDeviceCode(data.device_code);
            setKimiUserCode(data.user_code);
            setKimiVerificationUrl(verificationUrl || null);

            // Open the verification URL
            if (verificationUrl) {
                const electronAPI = typeof window !== "undefined" && "electronAPI" in window
                    ? (window as unknown as { electronAPI?: { isElectron?: boolean; shell?: { openExternal: (url: string) => Promise<void> } } }).electronAPI
                    : undefined;

                if (electronAPI?.isElectron && electronAPI?.shell?.openExternal) {
                    await electronAPI.shell.openExternal(verificationUrl);
                } else {
                    window.open(verificationUrl, "_blank");
                }
            }

            // Start polling
            setKimiPolling(true);
            setLoading(false);

            let currentInterval = (data.interval || 5) * 1000;
            const maxAttempts = Math.ceil((5 * 60 * 1000) / currentInterval); // 5 min timeout

            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                if (kimiAbortRef.current) return;

                await new Promise(resolve => setTimeout(resolve, currentInterval));

                if (kimiAbortRef.current) return;

                try {
                    const pollResponse = await fetch("/api/auth/kimi/poll", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ device_code: data.device_code }),
                    });
                    const pollData = await pollResponse.json();

                    if (kimiAbortRef.current) return;

                    if (pollData.status === "success") {
                        setIsAuthenticated(true);
                        setKimiPolling(false);
                        setKimiDeviceCode(null);
                        return;
                    }

                    if (pollData.status === "slow_down") {
                        currentInterval += 5000;
                        continue;
                    }

                    if (pollData.status === "error") {
                        throw new Error(pollData.error || t("errors.deviceAuthInitFailed"));
                    }
                    // status === "pending" — continue polling
                } catch (pollErr) {
                    console.error("Kimi device poll error:", pollErr);
                    // Continue polling unless it's a real error
                    if (pollErr instanceof Error && !pollErr.message.includes("pending")) {
                        if (!kimiAbortRef.current) {
                            setError(pollErr.message);
                            setKimiPolling(false);
                            setKimiDeviceCode(null);
                        }
                        return;
                    }
                }
            }

            // Timeout
            if (!kimiAbortRef.current) {
                setError(t("errors.deviceAuthTimedOut"));
                setKimiPolling(false);
                setKimiDeviceCode(null);
            }
        } catch (err) {
            console.error("Kimi device login failed:", err);
            if (!kimiAbortRef.current) {
                setError(err instanceof Error ? err.message : t("errors.authFailed"));
                setLoading(false);
                setKimiPolling(false);
                setKimiDeviceCode(null);
            }
        }
    };

    const handleApiKeySubmit = async () => {
        if (!apiKey.trim()) {
            setError(t("errors.enterApiKey"));
            return;
        }

        setLoading(true);
        setError(null);

        try {
            // Save the API key to settings
            const keyFieldMap: Record<string, string> = {
                anthropic: "anthropicApiKey",
                openrouter: "openrouterApiKey",
                kimi: "kimiApiKey",
            };
            const keyField = keyFieldMap[provider];
            if (!keyField) {
                throw new Error(t("errors.invalidProvider"));
            }

            const { error: saveError } = await resilientPut("/api/settings", {
                llmProvider: provider,
                [keyField]: apiKey,
            });

            if (saveError) {
                throw new Error(t("errors.failedSaveApiKey"));
            }

            invalidateSettingsCache();
            setIsAuthenticated(true);
        } catch (err) {
            setError(err instanceof Error ? err.message : t("errors.failedSaveApiKey"));
        } finally {
            setLoading(false);
        }
    };

    const persistProviderSelection = async (): Promise<boolean> => {
        const { error: saveError } = await resilientPut("/api/settings", {
            llmProvider: provider,
        });

        if (saveError) {
            setError(t("errors.failedSaveProvider"));
            return false;
        }

        invalidateSettingsCache();
        return true;
    };

    const handleContinue = async () => {
        if (!isAuthenticated) {
            onSkip();
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const providerSaved = await persistProviderSelection();
            if (!providerSaved) {
                return;
            }
            onAuthenticated();
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="flex flex-col items-center justify-center min-h-full px-6 py-12">
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-center max-w-md w-full"
            >
                <h1 className="text-2xl font-bold text-terminal-dark mb-2 font-mono">
                    {t("title")}
                </h1>

                {provider === "ollama" ? (
                    <div className="space-y-4 mt-8">
                        {isAuthenticated ? (
                            <motion.div
                                initial={{ scale: 0.9, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                className="p-6 rounded-xl bg-terminal-green/10 border border-terminal-green"
                            >
                                <CheckCircle2 className="w-12 h-12 text-terminal-green mx-auto mb-4" />
                                <p className="font-mono text-terminal-green font-semibold">
                                    {t("ollama.connected")}
                                </p>
                            </motion.div>
                        ) : (
                            <>
                                <div className="text-left">
                                    <label className="block font-mono text-sm text-terminal-muted mb-2">
                                        {t("ollama.baseUrlLabel")}
                                    </label>
                                    <input
                                        type="text"
                                        value={ollamaBaseUrl}
                                        onChange={(e) => {
                                            setOllamaBaseUrl(e.target.value);
                                            setOllamaTestStatus("idle");
                                        }}
                                        placeholder="http://localhost:11434"
                                        className="w-full rounded-lg border border-terminal-border bg-white px-4 py-3 font-mono text-sm text-terminal-dark placeholder:text-terminal-muted/50 focus:border-terminal-green focus:outline-none focus:ring-2 focus:ring-terminal-green/20"
                                    />
                                </div>

                                {error && (
                                    <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-red-600">
                                        <WifiOff className="w-4 h-4 flex-shrink-0" />
                                        <span className="text-sm font-mono">{error}</span>
                                    </div>
                                )}

                                <Button
                                    onClick={handleOllamaTest}
                                    disabled={ollamaTestStatus === "testing" || !ollamaBaseUrl.trim()}
                                    className="w-full gap-2 bg-terminal-green text-white hover:bg-terminal-green/90 font-mono"
                                >
                                    {ollamaTestStatus === "testing" ? (
                                        <>
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                            {t("connecting")}
                                        </>
                                    ) : (
                                        t("ollama.testConnection")
                                    )}
                                </Button>
                            </>
                        )}
                    </div>
                ) : provider === "antigravity" || provider === "codex" || provider === "claudecode" || provider === "kimi" ? (
                    <div className="space-y-6 mt-8">
                        {isAuthenticated ? (
                            <motion.div
                                initial={{ scale: 0.9, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                className="p-6 rounded-xl bg-terminal-green/10 border border-terminal-green"
                            >
                                <CheckCircle2 className="w-12 h-12 text-terminal-green mx-auto mb-4" />
                                <p className="font-mono text-terminal-green font-semibold">
                                    {t("connectedTo", { name: provider === "antigravity" ? "Antigravity" : provider === "codex" ? "Codex" : provider === "kimi" ? "Kimi" : "Claude Code" })}
                                </p>
                            </motion.div>
                        ) : provider === "kimi" && (kimiPolling || kimiDeviceCode) ? (
                            <div className="space-y-4">
                                <div className="rounded-lg border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 p-6 text-center">
                                    <p className="font-mono text-sm text-terminal-muted mb-3">
                                        {t("kimiDeviceCodePrompt")}
                                    </p>
                                    <p className="font-mono text-3xl font-bold text-terminal-dark tracking-widest mb-4">
                                        {kimiUserCode}
                                    </p>
                                    {kimiPolling && (
                                        <div className="flex items-center justify-center gap-2 text-terminal-muted">
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                            <span className="font-mono text-sm">{t("kimiWaitingAuth")}</span>
                                        </div>
                                    )}
                                </div>
                                {kimiVerificationUrl && (
                                    <Button
                                        onClick={() => window.open(kimiVerificationUrl, "_blank")}
                                        variant="ghost"
                                        className="w-full font-mono text-terminal-green hover:text-terminal-green/80"
                                    >
                                        {t("kimiOpenLoginPage")}
                                    </Button>
                                )}
                            </div>
                        ) : provider === "claudecode" && claudeCodePasteMode ? (
                            <>
                                <div className="text-left space-y-3">
                                    {claudeCodeBrowserOpened ? (
                                        <p className="text-sm text-terminal-muted font-mono">
                                            {t("pasteInstruction")}
                                        </p>
                                    ) : (
                                        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
                                            <p className="text-sm text-amber-700 font-mono">
                                                {"Dario did not return an authentication URL. Retry Claude Code authentication from Settings if this persists."}
                                            </p>
                                        </div>
                                    )}
                                    <label className="block font-mono text-sm text-terminal-muted">
                                        {t("authCodeLabel")}
                                    </label>
                                    <input
                                        type="text"
                                        value={claudeCodePasteValue}
                                        onChange={(e) => setClaudeCodePasteValue(e.target.value)}
                                        placeholder={t("authCodePlaceholder")}
                                        className="w-full rounded-lg border border-terminal-border bg-white px-4 py-3 font-mono text-sm text-terminal-dark placeholder:text-terminal-muted/50 focus:border-terminal-green focus:outline-none focus:ring-2 focus:ring-terminal-green/20"
                                        autoFocus
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter") {
                                                void handleClaudeCodeAuthCheck();
                                            }
                                        }}
                                    />
                                    {claudeCodeBrowserOpened && (
                                        <p className="text-xs text-terminal-muted font-mono">
                                            {t("pasteInstruction")}
                                        </p>
                                    )}
                                </div>

                                {error && (
                                    <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-red-600">
                                        <AlertCircle className="w-4 h-4 flex-shrink-0" />
                                        <span className="text-sm font-mono">{error}</span>
                                    </div>
                                )}

                                <div className="flex gap-2">
                                    <Button
                                        variant="ghost"
                                        onClick={() => {
                                            setClaudeCodePasteMode(false);
                                            setClaudeCodePasteValue("");
                                            setError(null);
                                        }}
                                        disabled={loading}
                                        className="font-mono text-terminal-muted hover:text-terminal-dark"
                                    >
                                        {t("cancel")}
                                    </Button>
                                    <Button
                                        onClick={handleClaudeCodeAuthCheck}
                                        disabled={loading}
                                        className="flex-1 gap-2 bg-terminal-green text-white hover:bg-terminal-green/90 font-mono"
                                    >
                                        {loading ? (
                                            <>
                                                <Loader2 className="w-4 h-4 animate-spin" />
                                                {t("verifying")}
                                            </>
                                        ) : (
                                            t("submitCode")
                                        )}
                                    </Button>
                                </div>
                            </>
                        ) : (
                            <>
                                <Button
                                    onClick={provider === "antigravity" ? handleAntigravityLogin : provider === "codex" ? handleCodexLogin : provider === "kimi" ? handleKimiDeviceLogin : handleClaudeCodeLogin}
                                    disabled={loading || claudeCodeAutoChecking}
                                    className="w-full gap-2 bg-terminal-green text-white hover:bg-terminal-green/90 font-mono py-6"
                                >
                                    {loading || claudeCodeAutoChecking ? (
                                        <>
                                            <Loader2 className="w-5 h-5 animate-spin" />
                                            {claudeCodeAutoChecking && provider === "claudecode" ? t("verifying") : t("connecting")}
                                        </>
                                    ) : provider === "codex" ? (
                                        t("signInOpenAI")
                                    ) : provider === "kimi" ? (
                                        t("signInKimi")
                                    ) : provider === "claudecode" ? (
                                        t("signInAnthropic")
                                    ) : (
                                        t("oauth.button")
                                    )}
                                </Button>
                                {provider === "claudecode" && (
                                    <p className="text-sm text-amber-600 font-mono">
                                        {t("claudecodeLoginHint")}
                                    </p>
                                )}
                                <p className="text-sm text-terminal-muted font-mono">
                                    {t("oauth.hint")}
                                </p>
                            </>
                        )}
                    </div>
                ) : (
                    <div className="space-y-4 mt-8">
                        {isAuthenticated ? (
                            <motion.div
                                initial={{ scale: 0.9, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                className="p-6 rounded-xl bg-terminal-green/10 border border-terminal-green"
                            >
                                <CheckCircle2 className="w-12 h-12 text-terminal-green mx-auto mb-4" />
                                <p className="font-mono text-terminal-green font-semibold">
                                    {t("apiKeySaved")}
                                </p>
                            </motion.div>
                        ) : (
                            <>
                                <div className="text-left">
                                    <label className="block font-mono text-sm text-terminal-muted mb-2">
                                        {t("apiKey.label")}
                                    </label>
                                    <input
                                        type="password"
                                        value={apiKey}
                                        onChange={(e) => setApiKey(e.target.value)}
                                        placeholder={t("apiKey.placeholder")}
                                        className="w-full rounded-lg border border-terminal-border bg-white px-4 py-3 font-mono text-sm text-terminal-dark placeholder:text-terminal-muted/50 focus:border-terminal-green focus:outline-none focus:ring-2 focus:ring-terminal-green/20"
                                    />
                                    <p className="mt-2 text-xs text-terminal-muted font-mono">
                                        {t("apiKey.hint")}
                                    </p>
                                </div>

                                {error && (
                                    <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-red-600">
                                        <AlertCircle className="w-4 h-4 flex-shrink-0" />
                                        <span className="text-sm font-mono">{error}</span>
                                    </div>
                                )}

                                <Button
                                    onClick={handleApiKeySubmit}
                                    disabled={loading || !apiKey.trim()}
                                    className="w-full gap-2 bg-terminal-green text-white hover:bg-terminal-green/90 font-mono"
                                >
                                    {loading ? (
                                        <>
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                            {t("saving")}
                                        </>
                                    ) : (
                                        t("saveApiKey")
                                    )}
                                </Button>
                            </>
                        )}
                    </div>
                )}

                <div className="flex justify-between mt-8">
                    <Button
                        variant="ghost"
                        onClick={onBack}
                        className="gap-2 font-mono text-terminal-muted hover:text-terminal-dark"
                    >
                        <ArrowLeft className="w-4 h-4" />
                        {t("back")}
                    </Button>
                    <div className="flex gap-2">
                        {!isAuthenticated && (
                            <Button
                                variant="ghost"
                                onClick={onSkip}
                                className="font-mono text-terminal-muted hover:text-terminal-dark"
                            >
                                {t("skip")}
                            </Button>
                        )}
                        <Button
                            onClick={handleContinue}
                            disabled={loading}
                            className="gap-2 bg-terminal-green text-white hover:bg-terminal-green/90 font-mono"
                        >
                            {loading ? t("saving") : t("continue")}
                            <ArrowRight className="w-4 h-4" />
                        </Button>
                    </div>
                </div>

                {!isAuthenticated && (
                    <p className="text-xs text-terminal-muted font-mono mt-4">
                        {t("skipHint")}
                    </p>
                )}
            </motion.div>
        </div>
    );
}
