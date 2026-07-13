export const locales = ["en", "tr", "zh-CN"] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "en";

// We keep localePrefix disabled to avoid changing existing routes.
const localePrefix = "never";

export const localeCookieName = "NEXT_LOCALE";
