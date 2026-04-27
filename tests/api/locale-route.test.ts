import { beforeEach, describe, expect, it, vi } from "vitest";

const nextJsonMock = vi.hoisted(() =>
  vi.fn((body: unknown, init?: ResponseInit) => {
    const cookies = { set: vi.fn() };
    const headers = new Headers();
    return { body, init, cookies, headers };
  })
);

const settingsMocks = vi.hoisted(() => ({
  updateSetting: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: nextJsonMock },
}));

vi.mock("@/lib/settings/settings-manager", () => settingsMocks);

import { POST } from "@/app/api/locale/route";

describe("/api/locale route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists the selected locale before setting the cookie", async () => {
    const response = await POST(
      new Request("http://localhost/api/locale", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locale: "tr" }),
      })
    );

    expect(settingsMocks.updateSetting).toHaveBeenCalledWith("appLanguage", "tr");
    expect((response as { cookies: { set: ReturnType<typeof vi.fn> } }).cookies.set).toHaveBeenCalledWith(
      "NEXT_LOCALE",
      "tr",
      expect.objectContaining({
        path: "/",
        sameSite: "lax",
        httpOnly: false,
      })
    );
  });

  it("returns 500 when persisting the locale fails", async () => {
    settingsMocks.updateSetting.mockImplementation(() => {
      throw new Error("disk failed");
    });

    await POST(
      new Request("http://localhost/api/locale", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locale: "en" }),
      })
    );

    expect(nextJsonMock).toHaveBeenLastCalledWith(
      { error: "Failed to persist locale selection" },
      { status: 500 }
    );
  });
});
