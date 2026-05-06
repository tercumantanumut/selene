"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useAuthRedirect } from "@/hooks/use-auth-redirect";
import { useAuth } from "@/components/auth/auth-provider";
import { AuthFormCard } from "@/components/auth/auth-form-card";
import { readAuthResponseError } from "@/components/auth/auth-error";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const t = useTranslations("login");
  const tc = useTranslations("common");

  const { checkingAuth } = useAuthRedirect({ redirectOnNoUsers: true });
  const { refreshAuth } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        const responseError = await readAuthResponseError(res);
        console.error("[Auth] Login failed", {
          status: res.status,
          statusText: res.statusText,
          error: responseError,
        });
        setError(responseError || t("error"));
        setLoading(false);
        return;
      }

      await res.json();

      await refreshAuth();
      router.push("/");
    } catch (err) {
      const message = err instanceof Error ? err.message : tc("error");
      console.error("[Auth] Login request failed", err);
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
      title={t("title")}
      subtitle={t("subtitle")}
      email={email}
      onEmailChange={setEmail}
      password={password}
      onPasswordChange={setPassword}
      emailPlaceholder={t("placeholderEmail")}
      passwordPlaceholder={t("placeholderPassword")}
      submitLabel={t("signIn")}
      submittingLabel={t("signingIn")}
      loading={loading}
      error={error}
      onSubmit={handleSubmit}
      footer={
        <div className="text-center">
          <p className="text-sm text-terminal-muted font-mono">
            {t("cta")}{" "}
            <Link
              href="/signup"
              className="text-terminal-green hover:text-terminal-green/80 font-medium"
            >
              {t("ctaLink")}
            </Link>
          </p>
        </div>
      }
    />
  );
}
