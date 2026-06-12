"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

export function ClaudeCodeAuthFlow({
  loading,
  success,
  onSubmit,
  onCancel,
  onComplete,
  browserOpened = true,
  diagnosticOutput,
}: {
  loading: boolean;
  success: boolean;
  onSubmit: (code: string) => void;
  onCancel: () => void;
  onComplete: () => void;
  /** Whether the browser was successfully opened with the auth URL */
  browserOpened?: boolean;
  /** Diagnostic output from the login process when browser failed to open */
  diagnosticOutput?: string[];
}) {
  const t = useTranslations("settings.api.auth");
  const [code, setCode] = useState("");

  if (success) {
    return (
      <div className="mt-3 space-y-3 border-t border-terminal-border pt-3">
        <div className="rounded-lg border border-terminal-green bg-terminal-green/10 p-4">
          <div className="flex items-center gap-2">
            <svg className="h-5 w-5 text-terminal-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <p className="font-mono text-sm font-semibold text-terminal-green">
              {t("authSuccess") || "Authentication successful!"}
            </p>
          </div>
          <p className="mt-2 font-mono text-xs text-terminal-dark">
            {t("authSuccessDesc") || "Your Claude Code connection is now active. You can now select Claude Code as your provider."}
          </p>
        </div>
        <div className="flex justify-end">
          <button
            onClick={onComplete}
            className="rounded border border-terminal-green bg-terminal-green px-4 py-2 font-mono text-sm text-white hover:bg-terminal-green/90"
          >
            {t("done") || "Done"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-4 border-t border-terminal-border pt-3">
      <div className="space-y-2">
        <p className="font-mono text-sm font-semibold text-terminal-dark">
          {t("authFlowTitle") || "Complete Authentication"}
        </p>
        {browserOpened ? (
          <ol className="ml-4 list-decimal space-y-1.5 font-mono text-xs text-terminal-muted">
            <li>{t("authStep1") || "A browser window has opened with the Anthropic authentication page"}</li>
            <li>{t("authStep2") || "Sign in with your Anthropic account if prompted"}</li>
            <li>{t("authStep3") || "Authorize the Claude Code application"}</li>
            <li>{t("authStep4") || "Copy the authorization code and paste it below"}</li>
          </ol>
        ) : (
          <div className="space-y-2">
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-600 dark:bg-amber-900/20">
              <p className="font-mono text-xs text-amber-700 dark:text-amber-400">
                {t("noAuthUrl") || "Dario did not return an authentication URL. Review the diagnostic output below, then retry Claude Code authentication."}
              </p>
            </div>
            {diagnosticOutput && diagnosticOutput.length > 0 && (
              <details className="rounded border border-terminal-border">
                <summary className="cursor-pointer px-3 py-1.5 font-mono text-xs text-terminal-muted">
                  {t("diagnosticDetails") || "Diagnostic details"}
                </summary>
                <pre className="max-h-24 overflow-auto px-3 py-2 font-mono text-[10px] text-terminal-muted">
                  {diagnosticOutput.join("\n")}
                </pre>
              </details>
            )}
          </div>
        )}
      </div>

      <div>
        <label htmlFor="auth-code" className="mb-1.5 block font-mono text-xs font-medium text-terminal-dark">
          {t("authCodeLabel") || "Authorization Code"}
        </label>
        <input
          id="auth-code"
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={t("codePlaceholder") || "Paste code here..."}
          className="w-full rounded border border-terminal-border bg-terminal-cream/95 dark:bg-terminal-cream-dark/50 px-3 py-2 font-mono text-sm text-terminal-dark placeholder:text-terminal-muted/50 focus:border-terminal-green focus:outline-none focus:ring-1 focus:ring-terminal-green"
          autoFocus
          disabled={loading}
          onKeyDown={(e) => {
            if (e.key === "Enter" && code.trim() && !loading) {
              onSubmit(code.trim());
            }
          }}
        />
      </div>

      {loading && (
        <div className="flex items-center gap-2 rounded-lg border border-terminal-blue/30 bg-terminal-blue/5 p-3">
          <svg className="h-4 w-4 animate-spin text-terminal-blue" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <p className="font-mono text-xs text-terminal-blue">
            {t("verifying") || "Verifying authorization..."}
          </p>
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={onCancel}
          disabled={loading}
          className="rounded border border-terminal-border px-3 py-1.5 font-mono text-xs text-terminal-muted hover:bg-terminal-bg disabled:opacity-50"
        >
          {t("cancel") || "Cancel"}
        </button>
        <button
          onClick={() => code.trim() && onSubmit(code.trim())}
          disabled={loading || !code.trim()}
          className="rounded border border-terminal-green bg-terminal-green/10 px-3 py-1.5 font-mono text-xs text-terminal-green hover:bg-terminal-green/20 disabled:opacity-50"
        >
          {loading ? (t("verifying") || "Verifying...") : (t("submitCode") || "Submit Code")}
        </button>
      </div>
    </div>
  );
}
