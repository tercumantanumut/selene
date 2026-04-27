import { defaultLocale, localeCookieName, locales, type Locale } from "@/i18n/config";
import type { AppSettings } from "@/lib/settings/settings-manager";

type LocaleSettings = Pick<Partial<AppSettings>, "appLanguage"> | null | undefined;

export function resolvePersistedAppLocale(settings: LocaleSettings): Locale {
  const appLanguage = settings?.appLanguage;
  return locales.includes(appLanguage as Locale) ? (appLanguage as Locale) : defaultLocale;
}

export function buildPersistedLocaleCookie(url: string, settings: LocaleSettings) {
  return {
    url,
    name: localeCookieName,
    value: resolvePersistedAppLocale(settings),
    path: "/",
    sameSite: "lax" as const,
    httpOnly: false,
    secure: url.startsWith("https://"),
    expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365,
  };
}
