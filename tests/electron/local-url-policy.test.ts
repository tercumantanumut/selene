import { describe, expect, it } from "vitest";

import { isElectronInternalUrl } from "../../electron/local-url-policy";

describe("isElectronInternalUrl", () => {
  it("keeps loopback app URLs inside Electron", () => {
    expect(isElectronInternalUrl("https://127.0.0.1:3456/api/media/session/generated/image.png")).toBe(true);
    expect(isElectronInternalUrl("http://127.0.0.1:3000/settings")).toBe(true);
    expect(isElectronInternalUrl("https://localhost:3456/api/media/session/generated/image.png")).toBe(true);
    expect(isElectronInternalUrl("file:///tmp/image.png")).toBe(true);
  });

  it("opens non-Selene URLs externally", () => {
    expect(isElectronInternalUrl("https://example.com/image.png")).toBe(false);
    expect(isElectronInternalUrl("https://127.0.0.1.evil.test/image.png")).toBe(false);
    expect(isElectronInternalUrl("mailto:hello@example.com")).toBe(false);
    expect(isElectronInternalUrl("not a url")).toBe(false);
  });
});
