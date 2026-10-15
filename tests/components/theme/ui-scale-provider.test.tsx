/** @vitest-environment jsdom */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "@/components/theme/theme-provider";

function ScaleProbe({ nextScale }: { nextScale?: number }) {
  const { uiScale, setUiScale } = useTheme();
  return createElement(
    "button",
    {
      type: "button",
      "data-scale": uiScale,
      onClick: () => nextScale !== undefined && setUiScale(nextScale),
    },
    String(uiScale),
  );
}

describe("ThemeProvider UI scaling", () => {
  beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    window.localStorage.clear();
    delete window.electronAPI;
    document.documentElement.style.removeProperty("--ui-scale-factor");
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete window.electronAPI;
    document.documentElement.style.removeProperty("--ui-scale-factor");
  });

  it("applies native Electron zoom to the entire renderer and updates it live", async () => {
    const setZoomFactor = vi.fn(async () => 80);
    window.electronAPI = {
      isElectron: true,
      window: { setZoomFactor },
    } as unknown as NonNullable<Window["electronAPI"]>;

    await act(async () => {
      root.render(
        createElement(
          ThemeProvider,
          { initialTheme: "dark", initialUiScale: 80 },
          createElement(ScaleProbe, { nextScale: 115 }),
        ),
      );
    });

    expect(setZoomFactor).toHaveBeenLastCalledWith(0.8, false);

    await act(async () => {
      container.querySelector("button")?.click();
    });

    expect(setZoomFactor).toHaveBeenCalledWith(1.15, true);
    expect(setZoomFactor).toHaveBeenLastCalledWith(1.15, false);
    expect(container.querySelector("button")?.getAttribute("data-scale")).toBe("115");
    expect(document.documentElement.style.getPropertyValue("--ui-scale-factor")).toBe("1");
  });

  it("uses CSS zoom as a browser fallback", async () => {
    await act(async () => {
      root.render(
        createElement(
          ThemeProvider,
          { initialTheme: "dark", initialUiScale: 70 },
          createElement(ScaleProbe),
        ),
      );
    });

    expect(document.documentElement.style.getPropertyValue("--ui-scale-factor")).toBe("0.7");
  });
});
