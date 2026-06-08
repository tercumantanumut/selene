import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  resolveSeleneTemplateTools,
  getExcludedSeleneTools,
  isToolAvailableForSelene,
  DEFAULT_ENABLED_TOOLS,
  ALWAYS_ENABLED_TOOLS,
  UTILITY_TOOLS,
  type ToolResolutionResult,
} from "@/lib/characters/templates/resolve-tools";
import type { AppSettings } from "@/lib/settings/settings-manager";

/**
 * Build a minimal AppSettings object for testing.
 * Only the fields relevant to tool resolution are included.
 */
function buildSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    llmProvider: "anthropic",
    localUserId: "test-user",
    localUserEmail: "test@test.com",
    appLanguage: "en",
    theme: "dark",
    vectorDBEnabled: false,
    webScraperProvider: "firecrawl",
    ...overrides,
  } as AppSettings;
}

describe("buildSettings", () => {
  it("preserves persisted language overrides across rebuilds", () => {
    const english = buildSettings({ appLanguage: "en" });
    expect(english.appLanguage).toBe("en");

    const reloaded = buildSettings({ ...english, appLanguage: "tr" });
    expect(reloaded.appLanguage).toBe("tr");

    const reopened = buildSettings({ ...reloaded });
    expect(reopened.appLanguage).toBe("tr");
  });
});

/**
 * Ghost OS is conditionally added on macOS only (process.platform === "darwin").
 * Tests run on CI (Linux) won't include it. We detect and adjust counts accordingly.
 */
const isMacOS = process.platform === "darwin";
const GHOST_OS_TOOL_COUNT = isMacOS ? 1 : 0;

describe("resolveSeleneTemplateTools", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Core tools — always enabled regardless of settings
  // =========================================================================
  describe("always-enabled core tools", () => {
    it("should always include localGrep, readFile, editFile, writeFile, executeCommand", () => {
      const settings = buildSettings(); // No API keys, no vector DB
      const result = resolveSeleneTemplateTools(settings);

      const coreTools = ["localGrep", "readFile", "editFile", "writeFile", "executeCommand"];
      for (const tool of coreTools) {
        expect(result.enabledTools).toContain(tool);
      }
    });

    it("should export always-enabled core tools constant", () => {
      expect(ALWAYS_ENABLED_TOOLS).toEqual([
        "localGrep",
        "readFile",
        "editFile",
        "writeFile",
        "executeCommand",
      ]);
    });
  });

  // =========================================================================
  // Utility tools — always enabled
  // =========================================================================
  describe("always-enabled utility tools", () => {
    it("should always include all utility tools", () => {
      const settings = buildSettings();
      const result = resolveSeleneTemplateTools(settings);

      const utilityTools = [
        "compactSession",
        "memorize",
        "skill",
        "updatePlan",
        "delegateToSubagent",
      ];
      for (const tool of utilityTools) {
        expect(result.enabledTools).toContain(tool);
      }
    });

    it("should export utility tools constant including delegateToSubagent", () => {
      expect(UTILITY_TOOLS).toContain("delegateToSubagent");
    });
  });

  // =========================================================================
  // Excluded tools — never included
  // =========================================================================
  describe("excluded tools", () => {
    it("should NOT include describeImage", () => {
      const settings = buildSettings({
        vectorDBEnabled: true,
        tavilyApiKey: "tvly-test-key",
        firecrawlApiKey: "fc-test-key",
      });
      const result = resolveSeleneTemplateTools(settings);
      expect(result.enabledTools).not.toContain("describeImage");
    });

    it("should NOT include patchFile", () => {
      const settings = buildSettings({
        vectorDBEnabled: true,
        tavilyApiKey: "tvly-test-key",
        firecrawlApiKey: "fc-test-key",
      });
      const result = resolveSeleneTemplateTools(settings);
      expect(result.enabledTools).not.toContain("patchFile");
    });
  });

  // =========================================================================
  // Vector Search — conditional on vectorDBEnabled
  // =========================================================================
  describe("vectorSearch", () => {
    it("should include vectorSearch when vectorDBEnabled is true", () => {
      const settings = buildSettings({ vectorDBEnabled: true });
      const result = resolveSeleneTemplateTools(settings);
      expect(result.enabledTools).toContain("vectorSearch");
      expect(result.warnings.find((w) => w.toolId === "vectorSearch")).toBeUndefined();
    });

    it("should NOT include vectorSearch when vectorDBEnabled is false", () => {
      const settings = buildSettings({ vectorDBEnabled: false });
      const result = resolveSeleneTemplateTools(settings);
      expect(result.enabledTools).not.toContain("vectorSearch");
    });

    it("should include a warning when vectorSearch is disabled", () => {
      const settings = buildSettings({ vectorDBEnabled: false });
      const result = resolveSeleneTemplateTools(settings);
      const warning = result.warnings.find((w) => w.toolId === "vectorSearch");
      expect(warning).toBeDefined();
      expect(warning!.settingsKeys).toContain("vectorDBEnabled");
      expect(warning!.action).toContain("Settings");
    });

    it("should NOT include vectorSearch when vectorDBEnabled is undefined", () => {
      const settings = buildSettings();
      delete (settings as Partial<AppSettings>).vectorDBEnabled;
      const result = resolveSeleneTemplateTools(settings);
      expect(result.enabledTools).not.toContain("vectorSearch");
    });
  });

  // =========================================================================
  // Web Search — conditional on tavilyApiKey
  // =========================================================================
  describe("webSearch", () => {
    it("should include webSearch when tavilyApiKey is set", () => {
      const settings = buildSettings({ tavilyApiKey: "tvly-abc123" });
      const result = resolveSeleneTemplateTools(settings);
      expect(result.enabledTools).toContain("webSearch");
      expect(result.warnings.find((w) => w.toolId === "webSearch")).toBeUndefined();
    });

    it("should include webSearch in default enabled tools", () => {
      expect(DEFAULT_ENABLED_TOOLS).toContain("webSearch");
    });

    it("should include webSearch even when tavilyApiKey is missing (DuckDuckGo fallback)", () => {
      const settings = buildSettings({ tavilyApiKey: undefined });
      const result = resolveSeleneTemplateTools(settings);
      expect(result.enabledTools).toContain("webSearch");
    });

    it("should include webSearch even when tavilyApiKey is empty string (DuckDuckGo fallback)", () => {
      const settings = buildSettings({ tavilyApiKey: "" });
      const result = resolveSeleneTemplateTools(settings);
      expect(result.enabledTools).toContain("webSearch");
    });

    it("should include webSearch even when tavilyApiKey is whitespace only (DuckDuckGo fallback)", () => {
      const settings = buildSettings({ tavilyApiKey: "   " });
      const result = resolveSeleneTemplateTools(settings);
      expect(result.enabledTools).toContain("webSearch");
    });

    it("should NOT emit a warning for webSearch (always enabled via DuckDuckGo fallback)", () => {
      const settings = buildSettings({ tavilyApiKey: undefined });
      const result = resolveSeleneTemplateTools(settings);
      const warning = result.warnings.find((w) => w.toolId === "webSearch");
      expect(warning).toBeUndefined();
    });
  });

  // =========================================================================
  // Workspace — pre-selected by default (not in UTILITY_TOOLS)
  // =========================================================================
  describe("workspace", () => {
    it("should include workspace when devWorkspaceEnabled is true", () => {
      const settings = buildSettings({ devWorkspaceEnabled: true } as Partial<AppSettings>);
      const result = resolveSeleneTemplateTools(settings);
      expect(result.enabledTools).toContain("workspace");
      expect(result.warnings.find((w) => w.toolId === "workspace")).toBeUndefined();
    });

    it("should NOT include workspace when devWorkspaceEnabled is false", () => {
      const settings = buildSettings({ devWorkspaceEnabled: false } as Partial<AppSettings>);
      const result = resolveSeleneTemplateTools(settings);
      expect(result.enabledTools).not.toContain("workspace");
    });

    it("should include a warning when workspace is disabled", () => {
      const settings = buildSettings();
      const result = resolveSeleneTemplateTools(settings);
      const warning = result.warnings.find((w) => w.toolId === "workspace");
      expect(warning).toBeDefined();
      expect(warning!.settingsKeys).toContain("devWorkspaceEnabled");
    });

    it("should NOT be in UTILITY_TOOLS or DEFAULT_ENABLED_TOOLS (it is conditional)", () => {
      expect(UTILITY_TOOLS).not.toContain("workspace");
      expect(DEFAULT_ENABLED_TOOLS).not.toContain("workspace");
    });
  });

  // =========================================================================
  // compactSession — always enabled as a utility tool
  // =========================================================================
  describe("compactSession", () => {
    it("should always include compactSession", () => {
      const settings = buildSettings();
      const result = resolveSeleneTemplateTools(settings);
      expect(result.enabledTools).toContain("compactSession");
    });

    it("should be in UTILITY_TOOLS constant", () => {
      expect(UTILITY_TOOLS).toContain("compactSession");
    });
  });

  // =========================================================================
  // Full configuration — all tools enabled
  // =========================================================================
  describe("full configuration", () => {
    it("should enable all conditional tools when everything is configured", () => {
      const settings = buildSettings({
        vectorDBEnabled: true,
        devWorkspaceEnabled: true,
        tavilyApiKey: "tvly-test-key",
        firecrawlApiKey: "fc-test-key",
      } as Partial<AppSettings>);
      const result = resolveSeleneTemplateTools(settings);

      expect(result.enabledTools).toContain("vectorSearch");
      expect(result.enabledTools).toContain("webSearch");
      expect(result.enabledTools).toContain("workspace");
      expect(result.warnings).toHaveLength(0);
    });

    it("should have no warnings when all prerequisites are met", () => {
      const settings = buildSettings({
        vectorDBEnabled: true,
        devWorkspaceEnabled: true,
        tavilyApiKey: "tvly-test-key",
        firecrawlApiKey: "fc-test-key",
      } as Partial<AppSettings>);
      const result = resolveSeleneTemplateTools(settings);
      expect(result.warnings).toHaveLength(0);
    });
  });

  // =========================================================================
  // Bare minimum configuration — only core and utility tools
  // =========================================================================
  describe("bare minimum configuration", () => {
    it("should have 2 warnings when nothing is configured (vectorSearch + workspace)", () => {
      const settings = buildSettings({
        vectorDBEnabled: false,
        tavilyApiKey: undefined,
        firecrawlApiKey: undefined,
        webScraperProvider: "firecrawl",
      });
      const result = resolveSeleneTemplateTools(settings);

      expect(result.warnings).toHaveLength(2);
      expect(result.warnings.map((w) => w.toolId).sort()).toEqual([
        "vectorSearch",
        "workspace",
      ]);
    });

    it("should still include core + utility + webSearch tools with no configuration", () => {
      const settings = buildSettings({
        vectorDBEnabled: false,
        tavilyApiKey: undefined,
        firecrawlApiKey: undefined,
        webScraperProvider: "firecrawl",
      });
      const result = resolveSeleneTemplateTools(settings);

      // 5 core + 5 utility + 1 always-on webSearch + 1 chromiumWorkspace = 12 base
      // + 1 ghostOs on macOS = 13
      const expectedMin = 12 + GHOST_OS_TOOL_COUNT;
      expect(result.enabledTools.length).toBeGreaterThanOrEqual(expectedMin);
      expect(result.enabledTools).not.toContain("vectorSearch");
      expect(result.enabledTools).not.toContain("workspace");
      expect(result.enabledTools).toContain("webSearch");
    });
  });

  // =========================================================================
  // Tool count verification
  // =========================================================================
  describe("tool count", () => {
    it("should return correct tool count when all prerequisites are met", () => {
      const settings = buildSettings({
        vectorDBEnabled: true,
        devWorkspaceEnabled: true,
        tavilyApiKey: "tvly-test-key",
        firecrawlApiKey: "fc-test-key",
      } as Partial<AppSettings>);
      const result = resolveSeleneTemplateTools(settings);

      // 5 core + 5 utility + 1 workspace + 1 vectorSearch + 1 webSearch + 1 chromiumWorkspace = 14 base
      // + 1 ghostOs on macOS = 15
      const expected = 14 + GHOST_OS_TOOL_COUNT;
      expect(result.enabledTools).toHaveLength(expected);
      expect(result.enabledTools).toContain("workspace");
      if (isMacOS) {
        expect(result.enabledTools).toContain("ghostOs");
      } else {
        expect(result.enabledTools).not.toContain("ghostOs");
      }
    });

    it("should return correct tool count when no optional tools are available", () => {
      const settings = buildSettings({
        vectorDBEnabled: false,
        tavilyApiKey: undefined,
        firecrawlApiKey: undefined,
        webScraperProvider: "firecrawl",
      });
      const result = resolveSeleneTemplateTools(settings);

      // 5 core + 5 utility + 1 always-on webSearch + 1 chromiumWorkspace = 12 base
      // + 1 ghostOs on macOS = 13
      const expected = 12 + GHOST_OS_TOOL_COUNT;
      expect(result.enabledTools).toHaveLength(expected);
    });
  });

  // =========================================================================
  // No duplicate tools
  // =========================================================================
  describe("no duplicates", () => {
    it("should not contain duplicate tool IDs", () => {
      const settings = buildSettings({
        vectorDBEnabled: true,
        tavilyApiKey: "tvly-test-key",
        firecrawlApiKey: "fc-test-key",
      });
      const result = resolveSeleneTemplateTools(settings);
      const unique = new Set(result.enabledTools);
      expect(unique.size).toBe(result.enabledTools.length);
    });
  });
});

// ===========================================================================
// getExcludedSeleneTools
// ===========================================================================
describe("getExcludedSeleneTools", () => {
  it("should return describeImage and patchFile", () => {
    const excluded = getExcludedSeleneTools();
    expect(excluded).toContain("describeImage");
    expect(excluded).toContain("patchFile");
  });

  it("should return exactly 2 excluded tools", () => {
    const excluded = getExcludedSeleneTools();
    expect(excluded).toHaveLength(2);
  });
});

describe("DEFAULT_ENABLED_TOOLS", () => {
  it("should include core and utility tools plus webSearch and chromiumWorkspace", () => {
    expect(DEFAULT_ENABLED_TOOLS).toEqual([
      ...ALWAYS_ENABLED_TOOLS,
      ...UTILITY_TOOLS,
      "webSearch",
      "chromiumWorkspace",
    ]);
  });

  it("should include delegateToSubagent and only one web tool", () => {
    expect(DEFAULT_ENABLED_TOOLS).toContain("delegateToSubagent");
    expect(DEFAULT_ENABLED_TOOLS).toContain("webSearch");
    expect(DEFAULT_ENABLED_TOOLS.filter((tool) => tool === "webSearch")).toHaveLength(1);
  });
});

// ===========================================================================
// isToolAvailableForSelene
// ===========================================================================
describe("isToolAvailableForSelene", () => {
  it("should return true for always-enabled tools", () => {
    const settings = buildSettings();
    expect(isToolAvailableForSelene("readFile", settings)).toBe(true);
    expect(isToolAvailableForSelene("editFile", settings)).toBe(true);
    expect(isToolAvailableForSelene("executeCommand", settings)).toBe(true);
  });

  it("should return false for vectorSearch when vectorDB is disabled", () => {
    const settings = buildSettings({ vectorDBEnabled: false });
    expect(isToolAvailableForSelene("vectorSearch", settings)).toBe(false);
  });

  it("should return true for vectorSearch when vectorDB is enabled", () => {
    const settings = buildSettings({ vectorDBEnabled: true });
    expect(isToolAvailableForSelene("vectorSearch", settings)).toBe(true);
  });

  it("should return false for excluded tools", () => {
    const settings = buildSettings({
      vectorDBEnabled: true,
      tavilyApiKey: "tvly-test",
      firecrawlApiKey: "fc-test",
    });
    expect(isToolAvailableForSelene("describeImage", settings)).toBe(false);
    expect(isToolAvailableForSelene("patchFile", settings)).toBe(false);
  });
});
