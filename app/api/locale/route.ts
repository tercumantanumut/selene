import { NextResponse } from "next/server";
import { locales, localeCookieName, type Locale } from "@/i18n/config";

/**
 * Sets the NEXT_LOCALE cookie server-side so the proxy + next-intl can read it
 * on the very next render. Keeps the cookie scoped to Path=/ with SameSite=Lax
 * so Electron and browser contexts behave identically.
 */
export async function POST(request: Request) {
  let locale: string | undefined;
  try {
    const body = await request.json();
    locale = typeof body?.locale === "string" ? body.locale : undefined;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!locale || !locales.includes(locale as Locale)) {
    return NextResponse.json(
      { error: `Unsupported locale. Expected one of: ${locales.join(", ")}` },
      { status: 400 },
    );
  }

  const response = NextResponse.json({ locale });
  response.cookies.set(localeCookieName, locale, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
    httpOnly: false,
  });
  // Hint next-intl's request config for the current response in case of caches.
  response.headers.set("x-next-intl-locale", locale);
  return response;
}
