import { describe, expect, it } from "vitest";

import { buildPersistedLocaleCookie, resolvePersistedAppLocale } from "@/lib/i18n/persisted-locale";

describe("persisted locale helpers", () => {
  it("uses the saved appLanguage when it is supported", () => {
    expect(resolvePersistedAppLocale({ appLanguage: "tr" })).toBe("tr");
    expect(resolvePersistedAppLocale({ appLanguage: "en" })).toBe("en");
  });

  it("falls back to the default locale when appLanguage is missing or invalid", () => {
    expect(resolvePersistedAppLocale(undefined)).toBe("en");
    expect(resolvePersistedAppLocale({ appLanguage: "de" as never })).toBe("en");
  });

  it("builds an Electron cookie payload from persisted appLanguage", () => {
    const cookie = buildPersistedLocaleCookie("https://127.0.0.1:3001", { appLanguage: "tr" });

    expect(cookie).toMatchObject({
      url: "https://127.0.0.1:3001",
      name: "NEXT_LOCALE",
      value: "tr",
      path: "/",
      sameSite: "lax",
      httpOnly: false,
      secure: true,
    });
    expect(cookie.expirationDate).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});
