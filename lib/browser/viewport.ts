/**
 * Browser viewport presets and resolver for Chromium workspace sessions.
 *
 * All dimensions are CSS viewport pixels. Device presets intentionally keep
 * deviceScaleFactor at 1 so screenshots and screencast coordinate mapping stay
 * deterministic while still exercising responsive layout breakpoints.
 */

import type { Page } from "playwright-core";

export type BrowserViewportOrientation = "portrait" | "landscape";

export interface BrowserViewportInput {
  viewportPreset?: BrowserViewportPreset | string;
  viewportWidth?: number;
  viewportHeight?: number;
  orientation?: BrowserViewportOrientation;
  resetViewport?: boolean;
}

export interface BrowserViewportPresetDefinition {
  label: string;
  width: number;
  height: number;
  orientation: BrowserViewportOrientation;
  category: "desktop" | "mobile" | "tablet";
  isMobile: boolean;
  hasTouch: boolean;
  deviceScaleFactor: number;
}

export interface BrowserViewport {
  width: number;
  height: number;
  orientation: BrowserViewportOrientation;
  preset?: BrowserViewportPreset;
  label: string;
  category: "desktop" | "mobile" | "tablet" | "custom";
  isMobile: boolean;
  hasTouch: boolean;
  deviceScaleFactor: number;
  source: "default" | "preset" | "custom";
}

export const BROWSER_VIEWPORT_PRESETS = {
  desktop: {
    label: "Desktop 1280×720",
    width: 1280,
    height: 720,
    orientation: "landscape",
    category: "desktop",
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 1,
  },
  "desktop-wide": {
    label: "Desktop Wide 1440×900",
    width: 1440,
    height: 900,
    orientation: "landscape",
    category: "desktop",
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 1,
  },
  mobile: {
    label: "Mobile 390×844",
    width: 390,
    height: 844,
    orientation: "portrait",
    category: "mobile",
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  },
  "iphone-se": {
    label: "iPhone SE 375×667",
    width: 375,
    height: 667,
    orientation: "portrait",
    category: "mobile",
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  },
  "iphone-14": {
    label: "iPhone 14 390×844",
    width: 390,
    height: 844,
    orientation: "portrait",
    category: "mobile",
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  },
  "pixel-7": {
    label: "Pixel 7 412×915",
    width: 412,
    height: 915,
    orientation: "portrait",
    category: "mobile",
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  },
  tablet: {
    label: "Tablet 768×1024",
    width: 768,
    height: 1024,
    orientation: "portrait",
    category: "tablet",
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  },
  ipad: {
    label: "iPad 768×1024",
    width: 768,
    height: 1024,
    orientation: "portrait",
    category: "tablet",
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  },
  "ipad-pro": {
    label: "iPad Pro 1024×1366",
    width: 1024,
    height: 1366,
    orientation: "portrait",
    category: "tablet",
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  },
} as const satisfies Record<string, BrowserViewportPresetDefinition>;

export type BrowserViewportPreset = keyof typeof BROWSER_VIEWPORT_PRESETS;

export const DEFAULT_BROWSER_VIEWPORT_PRESET: BrowserViewportPreset = "desktop";

const VIEWPORT_MIN_PX = 100;
const VIEWPORT_MAX_PX = 10_000;
const VIEWPORT_MAX_AREA_PX = 25_000_000;

export const DEFAULT_BROWSER_VIEWPORT: BrowserViewport = viewportFromPreset(
  DEFAULT_BROWSER_VIEWPORT_PRESET,
  "default"
);

export function isBrowserViewportPreset(value: unknown): value is BrowserViewportPreset {
  return typeof value === "string" && value in BROWSER_VIEWPORT_PRESETS;
}

export function listBrowserViewportPresets(): BrowserViewportPreset[] {
  return Object.keys(BROWSER_VIEWPORT_PRESETS) as BrowserViewportPreset[];
}

export function hasBrowserViewportInput(input: BrowserViewportInput | undefined): boolean {
  if (!input) return false;
  return (
    input.resetViewport === true ||
    input.viewportPreset != null ||
    input.viewportWidth != null ||
    input.viewportHeight != null ||
    input.orientation != null
  );
}

export function inferBrowserViewportOrientation(
  width: number,
  height: number
): BrowserViewportOrientation {
  return width > height ? "landscape" : "portrait";
}

export function resolveBrowserViewport(
  input: BrowserViewportInput = {},
  current: BrowserViewport = DEFAULT_BROWSER_VIEWPORT
): BrowserViewport {
  if (input.resetViewport === true) {
    return { ...DEFAULT_BROWSER_VIEWPORT };
  }

  const requestedPreset = input.viewportPreset == null
    ? undefined
    : resolvePreset(input.viewportPreset);
  const requestedOrientation = resolveViewportOrientation(input.orientation);

  const base = requestedPreset ? viewportFromPreset(requestedPreset, "preset") : current;
  const customWidth = coerceViewportDimension(input.viewportWidth, "viewportWidth");
  const customHeight = coerceViewportDimension(input.viewportHeight, "viewportHeight");
  const hasCustomDimensions = customWidth != null || customHeight != null;

  let width = customWidth ?? base.width;
  let height = customHeight ?? base.height;
  const orientation = requestedOrientation ?? inferBrowserViewportOrientation(width, height);

  if (orientation === "portrait" && width > height) {
    [width, height] = [height, width];
  } else if (orientation === "landscape" && height > width) {
    [width, height] = [height, width];
  }

  assertViewportArea(width, height);

  const category: BrowserViewport["category"] = hasCustomDimensions ? "custom" : base.category;
  const source: BrowserViewport["source"] = hasCustomDimensions
    ? "custom"
    : requestedPreset
      ? "preset"
      : requestedOrientation != null && base.source === "default"
        ? "custom"
        : base.source;
  const preset = hasCustomDimensions ? undefined : base.preset;
  const label = hasCustomDimensions || width !== base.width || height !== base.height
    ? formatBrowserViewportLabel(width, height, category)
    : base.label;

  return {
    width,
    height,
    orientation,
    preset,
    label,
    category,
    isMobile: base.isMobile,
    hasTouch: base.hasTouch,
    deviceScaleFactor: base.deviceScaleFactor,
    source,
  };
}

export function browserViewportToContextOptions(viewport: BrowserViewport) {
  return {
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor,
    isMobile: viewport.isMobile,
    hasTouch: viewport.hasTouch,
  };
}

export function formatBrowserViewport(viewport: BrowserViewport): string {
  return `${viewport.label} (${viewport.width}×${viewport.height}, ${viewport.orientation})`;
}

export async function applyBrowserViewportToPage(
  page: Page,
  viewport: BrowserViewport
): Promise<void> {
  const viewportSize = { width: viewport.width, height: viewport.height };

  if (!viewport.isMobile && !viewport.hasTouch && viewport.deviceScaleFactor === 1) {
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {});
    } finally {
      await cdp.detach().catch(() => {});
    }
    await page.setViewportSize(viewportSize);
    return;
  }

  await page.setViewportSize(viewportSize);

  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor,
      mobile: viewport.isMobile,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
      screenOrientation: {
        type: viewport.orientation === "landscape" ? "landscapePrimary" : "portraitPrimary",
        angle: viewport.orientation === "landscape" ? 90 : 0,
      },
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", {
      enabled: viewport.hasTouch,
      maxTouchPoints: viewport.hasTouch ? 5 : 0,
    });
  } finally {
    await cdp.detach().catch(() => {});
  }
}

function viewportFromPreset(
  preset: BrowserViewportPreset,
  source: BrowserViewport["source"]
): BrowserViewport {
  const definition = BROWSER_VIEWPORT_PRESETS[preset];
  return {
    width: definition.width,
    height: definition.height,
    orientation: definition.orientation,
    preset,
    label: definition.label,
    category: definition.category,
    isMobile: definition.isMobile,
    hasTouch: definition.hasTouch,
    deviceScaleFactor: definition.deviceScaleFactor,
    source,
  };
}

function resolvePreset(value: BrowserViewportPreset | string): BrowserViewportPreset {
  if (isBrowserViewportPreset(value)) return value;
  throw new Error(
    `Unknown viewport preset "${value}". Available presets: ${listBrowserViewportPresets().join(", ")}`
  );
}

function resolveViewportOrientation(value: unknown): BrowserViewportOrientation | undefined {
  if (value == null) return undefined;
  if (value === "portrait" || value === "landscape") return value;
  throw new Error('orientation must be "portrait" or "landscape"');
}

function assertViewportArea(width: number, height: number): void {
  const area = width * height;
  if (area > VIEWPORT_MAX_AREA_PX) {
    throw new Error(`Viewport area must be at most ${VIEWPORT_MAX_AREA_PX} CSS pixels`);
  }
}

function coerceViewportDimension(value: unknown, fieldName: string): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number`);
  }

  const rounded = Math.round(value);
  if (rounded < VIEWPORT_MIN_PX || rounded > VIEWPORT_MAX_PX) {
    throw new Error(`${fieldName} must be between ${VIEWPORT_MIN_PX} and ${VIEWPORT_MAX_PX} pixels`);
  }

  return rounded;
}

function formatBrowserViewportLabel(
  width: number,
  height: number,
  category: BrowserViewport["category"]
): string {
  const prefix = category === "custom" ? "Custom" : category.charAt(0).toUpperCase() + category.slice(1);
  return `${prefix} ${width}×${height}`;
}
