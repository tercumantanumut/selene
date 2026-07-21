import { locales, defaultLocale, localeCookieName, type Locale } from "./i18n/config";
import { NextResponse, type NextRequest } from "next/server";

// Session cookie name (must match the one in local-auth.ts)
const SESSION_COOKIE_NAME = "zlutty-session";

// Public routes that don't require authentication.
// Prefix routes cover auth screens/APIs; exact routes are intentionally narrow
// for browser callbacks that must arrive without Selene's local session cookie.
const PUBLIC_ROUTE_PREFIXES = ["/login", "/signup", "/api/auth"];
const PUBLIC_ROUTE_EXACT = ["/api/mcp/oauth/callback"];

// Static assets and API routes that should always be accessible
const STATIC_ROUTES = [
  "/_next",
  "/favicon.ico",
  "/assets",
  "/api/auth", // Auth API routes are public
];

/**
 * Detect locale from cookie or Accept-Language header.
 */
function detectLocale(request: NextRequest): Locale {
  // 1. Check cookie first
  const cookieLocale = request.cookies.get(localeCookieName)?.value;
  if (cookieLocale && locales.includes(cookieLocale as Locale)) {
    return cookieLocale as Locale;
  }

  // 2. Check Accept-Language header
  const acceptLanguage = request.headers.get("Accept-Language");
  if (acceptLanguage) {
    const preferredLocale = acceptLanguage
      .split(",")
      .map((lang) => lang.split(";")[0].trim().split("-")[0])
      .find((lang) => locales.includes(lang as Locale));
    if (preferredLocale) {
      return preferredLocale as Locale;
    }
  }

  // 3. Default
  return defaultLocale;
}

/**
 * Proxy handler to protect routes, handle authentication redirects, and set locale.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip static routes
  if (STATIC_ROUTES.some((route) => pathname.startsWith(route))) {
    return NextResponse.next();
  }

  // Browser session pop-out window — inject standalone header so root layout
  // renders a minimal shell (no auth, sidebar, sync providers).
  if (pathname.startsWith("/browser-session")) {
    const locale = detectLocale(request);
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-standalone", "1");
    requestHeaders.set("x-next-intl-locale", locale);
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set("x-next-intl-locale", locale);
    response.cookies.set(localeCookieName, locale, { path: "/" });
    return response;
  }

  // Detect locale and prepare to set header for i18n/request.ts
  const locale = detectLocale(request);
  const schedulerSecret = process.env.INTERNAL_API_SECRET || "selene-internal-scheduler";
  const internalAuthHeader = request.headers.get("x-internal-auth");
  const isScheduledRunHeader = request.headers.get("x-scheduled-run") === "true";
  const isInternalAuthRequest =
    pathname.startsWith("/api/") &&
    internalAuthHeader === schedulerSecret;
  const internalMediaToken = request.nextUrl.searchParams.get("internal_auth");
  const isInternalMediaRequest =
    pathname.startsWith("/api/media") && internalMediaToken === schedulerSecret;

  // Check for session cookie
  const sessionId = request.cookies.get(SESSION_COOKIE_NAME)?.value;

  // Check if this is a public route
  const isPublicRoute =
    PUBLIC_ROUTE_EXACT.includes(pathname) ||
    PUBLIC_ROUTE_PREFIXES.some((route) => pathname.startsWith(route));

  // If no session and trying to access protected route
  if (!sessionId && !isPublicRoute && !isInternalAuthRequest && !isInternalMediaRequest) {
    // For API routes, return 401
    if (pathname.startsWith("/api/")) {
      const response = NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      response.headers.set("x-next-intl-locale", locale);
      return response;
    }

    // For pages, redirect to login
    const loginUrl = new URL("/login", request.url);
    const response = NextResponse.redirect(loginUrl);
    response.headers.set("x-next-intl-locale", locale);
    response.cookies.set(localeCookieName, locale, { path: "/" });
    return response;
  }

  // If has session and trying to access auth pages, redirect to home
  if (sessionId && isPublicRoute && !pathname.startsWith("/api/")) {
    const homeUrl = new URL("/", request.url);
    const response = NextResponse.redirect(homeUrl);
    response.headers.set("x-next-intl-locale", locale);
    response.cookies.set(localeCookieName, locale, { path: "/" });
    return response;
  }

  // Continue request with locale header for i18n/request.ts
  const response = NextResponse.next();
  response.headers.set("x-next-intl-locale", locale);
  response.cookies.set(localeCookieName, locale, { path: "/" });
  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - *.wasm (ONNX Runtime WASM files)
     * - assets/ (TTS model assets)
     * - api/characters/:id/documents* (large multipart uploads; route handles auth directly)
     * Feel free to modify this pattern to include more paths.
     */
    "/((?!_next/static|_next/image|favicon.ico|assets/|api/characters/[^/]+/documents(?:/.*)?|.*\\.(?:svg|png|jpg|jpeg|gif|webp|wasm|onnx|json)$).*)",
  ],
};
