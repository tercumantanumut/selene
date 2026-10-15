import { describe, expect, it } from "vitest";
import { DEFAULT_FORM_STATE, buildFormStateFromData } from "@/app/settings/settings-types";

describe("uiScale setting", () => {
  it("defaults to 100 percent", () => {
    expect(DEFAULT_FORM_STATE.uiScale).toBe(100);
    expect(buildFormStateFromData({}).uiScale).toBe(100);
  });

  it("preserves valid persisted values and clamps invalid persisted values", () => {
    expect(buildFormStateFromData({ uiScale: 65 }).uiScale).toBe(65);
    expect(buildFormStateFromData({ uiScale: 20 }).uiScale).toBe(50);
    expect(buildFormStateFromData({ uiScale: 180 }).uiScale).toBe(120);
  });
});
