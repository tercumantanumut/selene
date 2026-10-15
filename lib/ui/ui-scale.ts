export const MIN_UI_SCALE = 50;
export const MAX_UI_SCALE = 120;
export const DEFAULT_UI_SCALE = 100;

export function normalizeUiScale(value: unknown): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(numeric)) {
    return DEFAULT_UI_SCALE;
  }

  return Math.min(MAX_UI_SCALE, Math.max(MIN_UI_SCALE, Math.round(numeric)));
}

export function isValidUiScale(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_UI_SCALE &&
    value <= MAX_UI_SCALE
  );
}

export function uiScaleToZoomFactor(value: unknown): number {
  return normalizeUiScale(value) / 100;
}
