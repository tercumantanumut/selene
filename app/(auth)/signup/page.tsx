"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2Icon, CheckCircleIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "next-intl";
import { useAuthRedirect } from "@/hooks/use-auth-redirect";
import { useAuth } from "@/components/auth/auth-provider";
import { AuthFormCard } from "@/components/auth/auth-form-card";
import { readAuthResponseError } from "@/components/auth/auth-error";

export default function SignUpPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const t = useTranslations("signup");
  const tc = useTranslations("common");

  const { checkingAuth, isFirstUser } = useAuthRedirect();
  const { refreshAuth } = useAuth();

  const validatePassword = (pwd: string): string | null => {
    if (pwd.length < 6) {
      return t("errorPasswordLength");
    }
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError(t("errorPasswordMatch"));
      return;
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
      setError(passwordError);
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        const responseError = await readAuthResponseError(res);
        console.error("[Auth] Signup failed", {
          status: res.status,
          statusText: res.statusText,
          error: responseError,
        });
        setError(responseError || t("errorShort"));
        setLoading(false);
        return;
      }

      await res.json();

      await refreshAuth();
      router.push("/");
    } catch (err) {
      const message = err instanceof Error ? err.message : tc("error");
      console.error("[Auth] Signup request failed", err);
      setError(message);
      setLoading(false);
    }
  };

  if (checkingAuth) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2Icon className="size-6 animate-spin text-terminal-green" />
      </div>
    );
  }

  return (
    <AuthFormCard
      title={isFirstUser ? t("titleFirst") : t("title")}
      subtitle={isFirstUser ? t("subtitleFirst") : t("subtitle")}
      banner={
        isFirstUser ? (
          <div className="flex items-center gap-2 p-3 text-sm text-terminal-green bg-green-50 rounded-md border border-green-200">
            <CheckCircleIcon className="size-4 flex-shrink-0" />
            <span className="font-mono">{t("firstUser")}</span>
          </div>
        ) : undefined
      }
      email={email}
      onEmailChange={setEmail}
      password={password}
      onPasswordChange={setPassword}
      passwordHint={t("passwordHint")}
      extraFields={
        <div className="space-y-2">
          <Label htmlFor="confirmPassword" className="font-mono text-terminal-dark">
            {tc("confirmPassword")}
          </Label>
          <Input
            id="confirmPassword"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder={t("placeholderPassword")}
            required
            disabled={loading}
            className="font-mono bg-terminal-cream border-terminal-border focus:border-terminal-green focus:ring-terminal-green"
          />
        </div>
      }
      emailPlaceholder={t("placeholderEmail")}
      passwordPlaceholder={t("placeholderPassword")}
      submitLabel={t("create")}
      submittingLabel={t("creating")}
      loading={loading}
      error={error}
      onSubmit={handleSubmit}
      footer={
        !isFirstUser ? (
          <div className="text-center">
            <p className="text-sm text-terminal-muted font-mono">
              {t("cta")}{" "}
              <Link
                href="/login"
                className="text-terminal-green hover:text-terminal-green/80 font-medium"
              >
                {t("ctaLink")}
              </Link>
            </p>
          </div>
        ) : undefined
      }
    />
  );
}
