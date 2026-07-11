import { describe, it, expect } from "vitest";
import { DEFAULT_FORM_STATE, buildFormStateFromData } from "@/app/settings/settings-types";

describe("claudecodeBackend setting", () => {
  it("defaults to dario in DEFAULT_FORM_STATE", () => {
    expect(DEFAULT_FORM_STATE.claudecodeBackend).toBe("dario");
  });

  it("defaults to dario when absent from persisted data", () => {
    const form = buildFormStateFromData({});
    expect(form.claudecodeBackend).toBe("dario");
  });

  it("preserves an explicit sdk selection", () => {
    const form = buildFormStateFromData({ claudecodeBackend: "sdk" });
    expect(form.claudecodeBackend).toBe("sdk");
  });

  it("coerces an unknown value back to dario", () => {
    const form = buildFormStateFromData({ claudecodeBackend: "bogus" });
    expect(form.claudecodeBackend).toBe("dario");
  });
});
