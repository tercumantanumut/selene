import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { extractTextFromDocument } from "@/lib/documents/parser";
import { loadSettings, saveSettings, type AppSettings } from "@/lib/settings/settings-manager";
import { WHISPER_MODELS, type WhisperModelInfo } from "@/lib/config/whisper-models";

/**
 * Pick any locally-downloaded whisper model so the WAV test doesn't hard-code
 * `ggml-small.en` (which few developer machines have). Mirrors the search-dir
 * logic in `lib/audio/transcription.ts#resolveWhisperModelPath` (kept private
 * there) so the test stays honest without exporting internals. Returns the
 * first model id whose backing file actually exists on disk, or null.
 */
function findAvailableWhisperModel(): string | null {
  const searchDirs: string[] = [];
  const home = homedir();
  const os = platform();
  const appName = "selene";

  if (os === "darwin") {
    searchDirs.push(path.join(home, "Library", "Application Support", appName, "models", "whisper"));
  } else if (os === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    searchDirs.push(path.join(appData, appName, "models", "whisper"));
  } else if (os === "linux") {
    const xdgDataHome = process.env.XDG_DATA_HOME || path.join(home, ".config");
    searchDirs.push(path.join(xdgDataHome, appName, "models", "whisper"));
  }
  searchDirs.push(path.join(process.cwd(), ".local-data", "models", "whisper"));
  searchDirs.push("/opt/homebrew/share/whisper-cpp/models");
  searchDirs.push("/usr/local/share/whisper-cpp/models");
  searchDirs.push(path.join(home, ".cache", "whisper"));
  searchDirs.push(path.join(home, ".local", "share", "whisper"));

  const filenameFor = (m: WhisperModelInfo) => m.hfFile || `${m.id}.bin`;

  for (const model of WHISPER_MODELS) {
    const filename = filenameFor(model);
    for (const dir of searchDirs) {
      if (existsSync(path.join(dir, filename))) return model.id;
    }
  }
  return null;
}

const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "documents");

function readFixture(name: string): Buffer {
  return readFileSync(path.join(FIXTURE_DIR, name));
}

describe.sequential("extractTextFromDocument fixture coverage", () => {
  let originalSettings: AppSettings | null = null;
  const originalPath = process.env.PATH;

  beforeAll(() => {
    originalSettings = JSON.parse(JSON.stringify(loadSettings())) as AppSettings;
    process.env.PATH = `/opt/homebrew/bin:${originalPath ?? ""}`;
  });

  afterAll(() => {
    process.env.PATH = originalPath;
    if (originalSettings) {
      saveSettings(originalSettings);
    }
  });

  it("extracts DOCX content into normalized text", async () => {
    const result = await extractTextFromDocument(
      readFixture("sample.docx"),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "sample.docx",
    );

    expect(result.format).toBe("docx");
    expect(result.extractionMethod).toBe("docling");
    expect(result.text).toContain("Demonstration of DOCX support in calibre");
    expect(result.text.length).toBeGreaterThan(400);
  }, 90_000);

  it("extracts PPTX slide text", async () => {
    const result = await extractTextFromDocument(
      readFixture("sample.pptx"),
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "sample.pptx",
    );

    expect(result.format).toBe("pptx");
    expect(result.extractionMethod).toBe("docling");
    expect(result.text).toContain("Sample Slide containing SmartArt in extLst");
    expect(result.text).toContain("dummy content");
  }, 90_000);

  it("extracts XLSX sheet content", async () => {
    const result = await extractTextFromDocument(
      readFixture("sample.xlsx"),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "sample.xlsx",
    );

    expect(result.format).toBe("xlsx");
    expect(result.extractionMethod).toBe("docling");
    expect(result.text).toContain("January");
    expect(result.text).toContain("Select Month");
  }, 90_000);

  it("extracts VTT subtitle text", async () => {
    const result = await extractTextFromDocument(
      readFixture("sample.vtt"),
      "text/vtt",
      "sample.vtt",
    );

    expect(result.format).toBe("vtt");
    expect(result.extractionMethod).toBe("docling");
    expect(result.text).toContain("Hello from the Selene VTT fixture.");
    expect(result.text).toContain("It validates subtitle extraction.");
  }, 90_000);

  it("extracts JATS XML content", async () => {
    const result = await extractTextFromDocument(
      readFixture("sample.jats.xml"),
      "application/xml+jats",
      "sample.jats.xml",
    );

    expect(result.format).toBe("xml_jats");
    expect(result.extractionMethod).toBe("docling");
    expect(result.text).toContain("Evolving general practice consultation in Britain");
    expect(result.text).toContain("Summary points");
  }, 90_000);

  it("routes WAV audio through local STT", async (ctx) => {
    const availableModel = findAvailableWhisperModel();
    if (!availableModel) {
      console.warn(
        "[parser.integration] No local whisper model found — skipping WAV STT test. " +
          "Download one in Settings → Voice & Audio → Whisper Model.",
      );
      ctx.skip();
      return;
    }

    const current = loadSettings();
    saveSettings({
      ...current,
      sttEnabled: true,
      sttProvider: "local",
      sttLocalModel: availableModel,
    });

    const result = await extractTextFromDocument(
      readFixture("sample.wav"),
      "audio/wav",
      "sample.wav",
      "chat-attachment",
    );

    expect(result.format).toBe("audio");
    expect(result.extractionMethod).toBe("audio-stt");
    expect(result.metadata).toMatchObject({ provider: "whisper.cpp" });
    expect(typeof result.text).toBe("string");
    expect(result.text.length).toBeGreaterThan(0);
  });
});
