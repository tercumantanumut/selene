import { loadSettings } from "@/lib/settings/settings-manager";
import { getWhisperModel, DEFAULT_WHISPER_MODEL } from "@/lib/config/whisper-models";
import {
  getParakeetModel,
  getSherpaOnnxArchiveName,
  getSherpaOnnxBinaryName,
  SHERPA_ONNX_VERSION,
  type ParakeetModel,
} from "@/lib/voice/parakeet-models";
import { loadHuggingFaceHubRuntime } from "@/lib/huggingface/hub-runtime";
import { getOrStartParakeetServer, shutdownParakeetServer } from "@/lib/voice/parakeet-server";
// Lazy-imported to avoid pulling better-sqlite3 into the Electron main bundle.
// voice-utils imports lib/db/sqlite-client which requires a native module compiled
// for the correct Node ABI — the Electron main process and Next.js dev server use
// different ABIs, so this must stay dynamic.
type VoiceUtils = typeof import("@/lib/voice/voice-utils");
const getVoiceUtils = (): Promise<VoiceUtils> => import("@/lib/voice/voice-utils");
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  writeFileSync,
  readFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  chmodSync,
  createWriteStream,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { join, basename, dirname } from "node:path";
import { tmpdir, homedir, platform } from "node:os";

interface TranscriptionResult {
  text: string;
  provider: string;
  durationSeconds?: number;
  language?: string;
}

let cachedFfmpegBinary: string | null | undefined;

/**
 * Transcribe an audio buffer using the configured STT provider.
 * Supports OpenAI Whisper API (cloud), whisper.cpp (local), and Parakeet (local sherpa-onnx websocket).
 */
export async function transcribeAudio(
  audio: Buffer,
  mimeType: string,
  filename?: string
): Promise<TranscriptionResult> {
  const settings = loadSettings();

  if (!settings.sttEnabled) {
    throw new Error("Speech-to-text is disabled in settings");
  }

  const provider = settings.sttProvider || "openai";

  if (provider === "openai") {
    return transcribeWithOpenAI(audio, mimeType, filename);
  }

  if (provider === "local") {
    return transcribeWithWhisperCpp(audio, mimeType, filename);
  }

  if (provider === "parakeet") {
    return transcribeWithParakeet(audio, mimeType);
  }

  throw new Error(`Unsupported STT provider: ${provider}`);
}

// ---------------------------------------------------------------------------
// OpenAI Whisper (cloud)
// ---------------------------------------------------------------------------

async function transcribeWithOpenAI(
  audio: Buffer,
  mimeType: string,
  filename?: string
): Promise<TranscriptionResult> {
  const settings = loadSettings();

  const openaiKey = settings.openaiApiKey || process.env.OPENAI_API_KEY;

  if (!openaiKey) {
    throw new Error(
      "OpenAI API key is required for Whisper transcription. " +
      "Please add your OpenAI API key (sk-...) in Settings -> API Keys. " +
      "Note: OpenRouter keys cannot be used for the Whisper audio API."
    );
  }

  const effectiveKey = openaiKey;
  const baseUrl = "https://api.openai.com/v1";

  const extension = getExtensionForMimeType(mimeType);
  const effectiveFilename = filename || `audio.${extension}`;

  const formData = new FormData();
  const uint8 = new Uint8Array(audio);
  const blob = new Blob([uint8 as BlobPart], { type: mimeType });
  formData.append("file", blob, effectiveFilename);
  formData.append("model", "whisper-1");
  formData.append("response_format", "verbose_json");

  const response = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${effectiveKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    const statusCode = response.status;

    if (statusCode === 401) {
      throw new Error(
        `Whisper API authentication failed (401). ` +
        `Please verify your OpenAI API key in Settings -> API Keys. ` +
        `OpenAI Whisper requires a direct OpenAI API key (sk-...).`
      );
    }

    throw new Error(`OpenAI Whisper API error ${statusCode}: ${errorText}`);
  }

  const result = (await response.json()) as {
    text: string;
    duration?: number;
    language?: string;
  };

  console.log(
    `[STT] Transcribed audio (${result.duration?.toFixed(1)}s) via OpenAI Whisper`
  );

  return {
    text: result.text,
    provider: "openai",
    durationSeconds: result.duration,
    language: result.language,
  };
}

// ---------------------------------------------------------------------------
// Parakeet (local sherpa-onnx websocket)
// ---------------------------------------------------------------------------

async function transcribeWithParakeet(
  audio: Buffer,
  mimeType: string
): Promise<TranscriptionResult> {
  const settings = loadSettings();
  const modelId = settings.parakeetModel || "parakeet-tdt-0.6b-v3";
  const model = getParakeetModel(modelId);
  if (!model) {
    throw new Error(`Unsupported Parakeet model: ${modelId}`);
  }

  const ffmpegPath = findFfmpegBinary();
  if (!ffmpegPath) {
    throw new Error(
      "ffmpeg is required for Parakeet transcription but was not found. " +
      "Install it with your package manager and ensure it is in PATH."
    );
  }

  const ext = getExtensionForMimeType(mimeType);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tmpIn = join(tmpdir(), `selene-parakeet-in-${id}.${ext}`);
  const tmpWav = join(tmpdir(), `selene-parakeet-conv-${id}.wav`);

  try {
    writeFileSync(tmpIn, audio);

    execFileSync(
      ffmpegPath,
      ["-y", "-i", tmpIn, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", tmpWav],
      { timeout: 30000, stdio: "pipe" }
    );

    const samples = readWavAsFloat32(tmpWav);
    const message = Buffer.alloc(8 + samples.length * 4);
    message.writeInt32LE(16000, 0);
    message.writeInt32LE(samples.length * 4, 4);
    for (let i = 0; i < samples.length; i += 1) {
      message.writeFloatLE(samples[i], 8 + i * 4);
    }

    const baseDir = resolveParakeetBaseDir();
    if (!existsSync(baseDir)) {
      mkdirSync(baseDir, { recursive: true });
    }

    const modelDir = await ensureParakeetModel(model, baseDir);
    const wsBinary = await ensureParakeetRuntime(baseDir);

    const endpoint = await getOrStartParakeetServer({
      modelDir,
      runtimeBinary: wsBinary,
    });

    const startedAt = Date.now();
    const rawResult = await transcribeViaParakeetWebSocket(endpoint, message);
    const elapsedSeconds = (Date.now() - startedAt) / 1000;

    let text = rawResult.trim();
    try {
      const parsed = JSON.parse(rawResult) as { text?: string };
      if (typeof parsed.text === "string") {
        text = parsed.text.trim();
      }
    } catch {
      // Server can return plain text for some builds.
    }

    if (!text) {
      throw new Error("Parakeet transcription produced empty result");
    }

    console.log(`[STT] Transcribed audio (${elapsedSeconds.toFixed(1)}s) via Parakeet (${model.name})`);
    return {
      text,
      provider: "parakeet",
    };
  } finally {
    try {
      unlinkSync(tmpIn);
    } catch {}
    try {
      unlinkSync(tmpWav);
    } catch {}
  }
}

function resolveParakeetBaseDir(): string {
  const localDataPath = process.env.LOCAL_DATA_PATH;
  if (localDataPath) {
    return join(localDataPath, "..", "models", "parakeet");
  }

  const userDataPath = process.env.ELECTRON_USER_DATA_PATH;
  if (userDataPath) {
    return join(userDataPath, "models", "parakeet");
  }

  return join(process.cwd(), ".local-data", "models", "parakeet");
}

async function ensureParakeetModel(model: ParakeetModel, baseDir: string): Promise<string> {
  const modelDir = join(baseDir, model.modelDir);

  if (model.requiredFiles.every((file) => existsSync(join(modelDir, file)))) {
    return modelDir;
  }

  mkdirSync(modelDir, { recursive: true });

  const { downloadFile } = loadHuggingFaceHubRuntime();
  for (const filename of model.requiredFiles) {
    if (existsSync(join(modelDir, filename))) continue;

    const blob = await downloadFile({ repo: model.repo, path: filename });
    if (!blob) {
      throw new Error(`Failed to download ${filename} from ${model.repo}`);
    }
    const buffer = Buffer.from(await blob.arrayBuffer());
    writeFileSync(join(modelDir, filename), buffer);
  }

  if (!model.requiredFiles.every((file) => existsSync(join(modelDir, file)))) {
    throw new Error(`Parakeet model install incomplete at ${modelDir}`);
  }

  return modelDir;
}

async function ensureParakeetRuntime(baseDir: string): Promise<string> {
  const binaryName = getSherpaOnnxBinaryName(process.platform, process.arch);
  if (!binaryName) {
    throw new Error(`Parakeet runtime is unsupported on ${process.platform}-${process.arch}`);
  }

  const existingBinary = findParakeetRuntimeBinary(baseDir, binaryName);
  if (existingBinary) {
    ensureExecutable(existingBinary);
    return existingBinary;
  }

  const archiveName = getSherpaOnnxArchiveName(process.platform, process.arch);
  if (!archiveName) {
    throw new Error(`No sherpa-onnx runtime archive for ${process.platform}-${process.arch}`);
  }

  const archivePath = join(baseDir, archiveName);
  const archiveUrl = `https://github.com/k2-fsa/sherpa-onnx/releases/download/v${SHERPA_ONNX_VERSION}/${archiveName}`;

  try {
    await downloadToFile(archiveUrl, archivePath);
    await extractTarBz2Archive(archivePath, baseDir);
  } finally {
    try {
      unlinkSync(archivePath);
    } catch {}
  }

  const installedBinary = findParakeetRuntimeBinary(baseDir, binaryName);
  if (!installedBinary) {
    throw new Error(`Parakeet runtime binary not found after install: ${binaryName}`);
  }

  ensureExecutable(installedBinary);
  return installedBinary;
}

function findParakeetRuntimeBinary(baseDir: string, binaryName: string): string | null {
  if (!existsSync(baseDir)) {
    return null;
  }

  const stack = [baseDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;

    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        const stats = statSync(full);
        if (stats.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (stats.isFile() && basename(full) === binaryName) {
          return full;
        }
      } catch {
        // Ignore race conditions while scanning.
      }
    }
  }

  return null;
}

function ensureExecutable(filePath: string): void {
  if (process.platform === "win32") {
    return;
  }

  try {
    chmodSync(filePath, 0o755);
  } catch {
    // Best effort.
  }
}

// Track active extraction processes for cleanup on shutdown.
const activeExtractionProcesses = new Set<ChildProcess>();

function extractTarBz2Archive(archivePath: string, destinationDir: string): Promise<void> {
  const tarCmd = process.platform === "win32" ? "tar.exe" : "tar";

  return new Promise((resolve, reject) => {
    const child = spawn(tarCmd, ["-xjf", archivePath, "-C", destinationDir], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });

    activeExtractionProcesses.add(child);

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      activeExtractionProcesses.delete(child);
      reject(error);
    });

    child.on("close", (code) => {
      activeExtractionProcesses.delete(child);
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`tar extraction failed (exit ${code}): ${stderr.slice(0, 400)}`));
    });
  });
}

async function downloadToFile(url: string, destinationPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }

  if (!response.body) {
    throw new Error(`No response body for ${url}`);
  }

  const destDir = dirname(destinationPath);
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }

  // Stream response body directly to disk — no memory buffering
  const readable = Readable.fromWeb(response.body as import("stream/web").ReadableStream);
  const writable = createWriteStream(destinationPath);

  await pipeline(readable, writable);
}

/**
 * Kill all active extraction child processes and shut down the persistent
 * Parakeet server. Call from electron/main.ts on app quit.
 */
export async function cleanupAllVoiceProcesses(): Promise<void> {
  // Kill any in-flight tar extractions.
  for (const child of activeExtractionProcesses) {
    try {
      child.kill();
    } catch {}
  }
  activeExtractionProcesses.clear();

  // Shut down the persistent Parakeet WebSocket server.
  await shutdownParakeetServer();
}

function transcribeViaParakeetWebSocket(endpoint: string, payload: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint);
    let receivedMessage = false;

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Parakeet websocket transcription timeout"));
    }, 60_000);

    ws.addEventListener("open", () => {
      ws.send(payload);
    });

    ws.addEventListener("message", (event) => {
      receivedMessage = true;
      const data = typeof event.data === "string" ? event.data : String(event.data);
      clearTimeout(timer);
      ws.close();
      resolve(data);
    });

    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Parakeet websocket communication failed"));
    });

    ws.addEventListener("close", () => {
      if (!receivedMessage) {
        clearTimeout(timer);
        reject(new Error("Parakeet websocket closed without returning a transcription result"));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// whisper.cpp (local, on-device)
// ---------------------------------------------------------------------------

/**
 * Local transcription via whisper-cli (whisper.cpp).
 */
async function transcribeWithWhisperCpp(
  audio: Buffer,
  mimeType: string,
  _filename?: string
): Promise<TranscriptionResult> {
  const settings = loadSettings();
  const modelId = settings.sttLocalModel || DEFAULT_WHISPER_MODEL;
  const modelInfo = getWhisperModel(modelId);
  const modelPath = resolveWhisperModelPath(modelId);

  if (!modelPath) {
    throw new Error(
      `Whisper model "${modelInfo?.name || modelId}" not found. ` +
      "Please download it in Settings -> Voice & Audio -> Whisper Model."
    );
  }

  const binaryPath = findWhisperBinary();
  if (!binaryPath) {
    throw new Error(
      "whisper-cli not found. Install whisper.cpp (macOS: brew install whisper-cpp, Windows: download whisper-bin-x64.zip from https://github.com/ggml-org/whisper.cpp/releases)\n" +
      "Or set a custom path in Settings -> Voice & Audio."
    );
  }

  const ext = getExtensionForMimeType(mimeType);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tmpIn = join(tmpdir(), `selene-stt-in-${id}.${ext}`);
  const tmpWav = join(tmpdir(), `selene-stt-conv-${id}.wav`);
  const tmpOut = join(tmpdir(), `selene-stt-out-${id}`);

  try {
    writeFileSync(tmpIn, audio);

    const ffmpegPath = findFfmpegBinary();
    if (!ffmpegPath) {
      throw new Error(
        "Local whisper.cpp transcription is not available because Selene could not find ffmpeg. " +
        "Selene normally bundles ffmpeg automatically. Try reinstalling the app, or switch Speech-to-Text to OpenAI Whisper in Settings -> Voice & Audio."
      );
    }

    try {
      execFileSync(ffmpegPath, [
        "-y", "-i", tmpIn,
        "-ar", "16000",
        "-ac", "1",
        "-c:a", "pcm_s16le",
        tmpWav,
      ], { timeout: 30000, stdio: "pipe" });
    } catch (ffmpegErr) {
      const msg = ffmpegErr instanceof Error ? ffmpegErr.message : String(ffmpegErr);
      throw new Error(`ffmpeg failed to convert audio (format: ${ext}): ${msg}`);
    }

    const args: string[] = [
      "-m", modelPath,
      "-f", tmpWav,
      "-of", tmpOut,
      "-oj",
      "-np",
      "--no-timestamps",
    ];

    if (modelInfo?.language === "multilingual") {
      args.push("-l", "auto");
    }

    try {
      const { getCustomDictionary, buildWhisperPromptFromDictionary } = await getVoiceUtils();
      const customDictionary = await getCustomDictionary();
      const prompt = buildWhisperPromptFromDictionary(customDictionary);
      if (prompt) {
        args.push("--prompt", prompt);
      }
    } catch (error) {
      console.warn("[STT] Failed to load custom dictionary for whisper.cpp:", error);
    }

    const startTime = Date.now();
    const effectiveBinaryPath = runWhisperCli(binaryPath, args);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    const jsonPath = `${tmpOut}.json`;
    if (!existsSync(jsonPath)) {
      throw new Error("whisper-cli did not produce output. The audio may be too short or silent.");
    }

    const output = JSON.parse(readFileSync(jsonPath, "utf-8")) as {
      transcription?: Array<{ text: string }>;
      result?: { language?: string };
      text?: string;
      language?: string;
    };

    let text = "";
    if (output.transcription && Array.isArray(output.transcription)) {
      text = output.transcription.map((s) => s.text).join(" ").trim();
    } else if (typeof output.text === "string") {
      text = output.text.trim();
    }

    if (!text) {
      throw new Error("Transcription produced empty result. The audio may be silent or too short.");
    }

    const detectedLang = output.result?.language || output.language;

    console.log(
      `[STT] Transcribed audio (${elapsed}s) via whisper.cpp (model: ${modelInfo?.name || modelId}, bin: ${basename(effectiveBinaryPath)})`
    );

    return {
      text,
      provider: "whisper.cpp",
      language: detectedLang || (modelInfo?.language === "en" ? "en" : undefined),
    };
  } finally {
    try { unlinkSync(tmpIn); } catch {}
    try { unlinkSync(tmpWav); } catch {}
    try { unlinkSync(`${tmpOut}.json`); } catch {}
    try { unlinkSync(`${tmpOut}.txt`); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Availability checks
// ---------------------------------------------------------------------------

export function isTranscriptionAvailable(): boolean {
  const settings = loadSettings();
  if (!settings.sttEnabled) return false;

  if (settings.sttProvider === "local") {
    return isWhisperCppAvailable();
  }

  if (settings.sttProvider === "parakeet") {
    return true;
  }

  return !!(settings.openaiApiKey || process.env.OPENAI_API_KEY || settings.openrouterApiKey);
}

export function isWhisperCppAvailable(): boolean {
  try {
    const binaryPath = findWhisperBinary();
    if (!binaryPath) return false;

    const ffmpegPath = findFfmpegBinary();
    if (!ffmpegPath) return false;

    const settings = loadSettings();
    const modelId = settings.sttLocalModel || DEFAULT_WHISPER_MODEL;
    const modelPath = resolveWhisperModelPath(modelId);
    return !!modelPath;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findWhisperBinary(): string | null {
  const settings = loadSettings();

  if (settings.whisperCppPath && existsSync(settings.whisperCppPath)) {
    const resolved = resolvePreferredWhisperBinary(settings.whisperCppPath);
    if (resolved) return resolved;
  }

  for (const relativePath of getWhisperBundledRelativePaths()) {
    const bundledPaths = getBundledBinaryPaths("whisper", relativePath);
    for (const p of bundledPaths) {
      if (existsSync(p)) return p;
    }
  }

  const commonPaths = [
    "/opt/homebrew/bin/whisper-whisper-cli",
    "/usr/local/bin/whisper-whisper-cli",
    "/opt/homebrew/bin/whisper-cli",
    "/usr/local/bin/whisper-cli",
    join(process.env.ProgramFiles || "C:\\Program Files", "whisper.cpp", "whisper-whisper-cli.exe"),
    join(process.env.ProgramFiles || "C:\\Program Files", "whisper.cpp", "whisper-cli.exe"),
    join(process.env.ProgramFiles || "C:\\Program Files", "whisper.cpp", "main.exe"),
    join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "whisper.cpp", "whisper-whisper-cli.exe"),
    join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "whisper.cpp", "whisper-cli.exe"),
    join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "whisper.cpp", "main.exe"),
    join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Programs", "whisper.cpp", "whisper-whisper-cli.exe"),
    join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Programs", "whisper.cpp", "whisper-cli.exe"),
    join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Programs", "whisper.cpp", "main.exe"),
  ];

  for (const p of commonPaths) {
    if (existsSync(p)) {
      const resolved = resolvePreferredWhisperBinary(p);
      if (resolved) return resolved;
    }
  }

  const inPath = findExecutableInPath(["whisper-whisper-cli", "whisper-cli", "main"]);
  if (inPath) {
    const resolved = resolvePreferredWhisperBinary(inPath);
    if (resolved) return resolved;
  }

  return null;
}

export function findFfmpegBinary(): string | null {
  if (cachedFfmpegBinary !== undefined) {
    if (cachedFfmpegBinary && existsSync(cachedFfmpegBinary)) {
      return cachedFfmpegBinary;
    }
    cachedFfmpegBinary = undefined;
  }

  const inPath = findExecutableInPath(["ffmpeg", "ffmpeg.exe"]);
  if (inPath) {
    cachedFfmpegBinary = inPath;
    return inPath;
  }

  for (const relativePath of getFfmpegBundledRelativePaths()) {
    const bundledPaths = getBundledBinaryPaths("ffmpeg", relativePath);
    for (const p of bundledPaths) {
      if (existsSync(p) && !isJavaScriptShim(p)) {
        cachedFfmpegBinary = p;
        return p;
      }
    }
  }

  cachedFfmpegBinary = null;
  return null;
}

/**
 * Detect whether a file is a JavaScript shim (e.g. npm .bin wrapper) rather
 * than a real native binary.  On Windows the ffmpeg-static package installs a
 * tiny JS wrapper at node_modules/.bin/ffmpeg.exe that `require()`s the real
 * binary path — executing it directly with `spawn` causes an UNKNOWN error.
 */
function isJavaScriptShim(filePath: string): boolean {
  try {
    const size = statSync(filePath).size;
    // Real ffmpeg binaries are tens of MB; JS shims are a few KB
    if (size < 50_000) {
      const head = readFileSync(filePath, { encoding: "utf-8", flag: "r" }).slice(0, 256);
      return head.includes("require(") || head.includes("'use strict'") || head.startsWith("#!/usr/bin/env node");
    }
    return false;
  } catch {
    return false;
  }
}

function getWhisperBundledRelativePaths(): string[] {
  return [
    join("bin", "whisper-whisper-cli"),
    join("bin", "whisper-whisper-cli.exe"),
    join("bin", "whisper-cli"),
    join("bin", "whisper-cli.exe"),
    join("bin", "main.exe"),
  ];
}

function preferNewWhisperBinary(binaryPath: string): string {
  const fileName = basename(binaryPath).toLowerCase();
  const binaryDir = dirname(binaryPath);

  if (fileName === "whisper-cli.exe") {
    const preferred = join(binaryDir, "whisper-whisper-cli.exe");
    if (existsSync(preferred)) return preferred;
  }

  if (fileName === "whisper-cli") {
    const preferred = join(binaryDir, "whisper-whisper-cli");
    if (existsSync(preferred)) return preferred;
  }

  return binaryPath;
}

function resolvePreferredWhisperBinary(binaryPath: string): string | null {
  const preferred = preferNewWhisperBinary(binaryPath);
  if (!isDeprecatedWhisperStub(preferred)) return preferred;
  if (preferred !== binaryPath && !isDeprecatedWhisperStub(binaryPath)) return binaryPath;
  return null;
}

function runWhisperCli(binaryPath: string, args: string[]): string {
  const firstChoice = preferNewWhisperBinary(binaryPath);
  try {
    execFileSync(firstChoice, args, {
      timeout: 120000,
      stdio: "pipe",
      env: buildWhisperRuntimeEnv(firstChoice),
    });
    return firstChoice;
  } catch (err) {
    const output = getProcessErrorOutput(err);
    const replacement = parseDeprecatedWhisperReplacement(output);

    if (replacement) {
      const retryPath = resolveReplacementWhisperBinary(firstChoice, replacement);
      if (retryPath && retryPath !== firstChoice) {
        execFileSync(retryPath, args, {
          timeout: 120000,
          stdio: "pipe",
          env: buildWhisperRuntimeEnv(retryPath),
        });
        return retryPath;
      }

      throw new Error(
        `Bundled whisper binary "${basename(firstChoice)}" is a deprecated launcher and exited before transcription. ` +
        `Expected replacement "${replacement}" was not found. ` +
        "Re-bundle whisper binaries (npm run electron:bundle-whisper) or set a custom binary path in Settings -> Voice & Audio."
      );
    }

    throw err;
  }
}

function buildWhisperRuntimeEnv(binaryPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const binParent = join(dirname(binaryPath), "..");

  if (platform() === "win32") {
    const libDir = join(binParent, "lib");
    if (existsSync(libDir)) {
      env.PATH = `${libDir};${env.PATH || ""}`;
    }
  }

  if (platform() === "darwin") {
    // Ensure bundled dylibs (libggml, libomp, etc.) are found.
    // Backend plugins (.so) are placed next to whisper-cli in bin/ so
    // ggml_backend_load_best() finds them via its executable-dir fallback.
    const libDir = join(binParent, "lib");
    if (existsSync(libDir)) {
      env.DYLD_LIBRARY_PATH = libDir + (env.DYLD_LIBRARY_PATH ? `:${env.DYLD_LIBRARY_PATH}` : "");
    }
  }

  return env;
}

function getProcessErrorOutput(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error ?? "");
  }

  const err = error as {
    message?: string;
    stdout?: string | Buffer;
    stderr?: string | Buffer;
  };

  const chunks: string[] = [];
  if (typeof err.stdout === "string") chunks.push(err.stdout);
  if (Buffer.isBuffer(err.stdout)) chunks.push(err.stdout.toString("utf-8"));
  if (typeof err.stderr === "string") chunks.push(err.stderr);
  if (Buffer.isBuffer(err.stderr)) chunks.push(err.stderr.toString("utf-8"));
  if (typeof err.message === "string") chunks.push(err.message);
  return chunks.join("\n").trim();
}

function parseDeprecatedWhisperReplacement(output: string): string | null {
  if (!/is deprecated/i.test(output)) return null;
  const match = output.match(/Please use '([^']+)'/i);
  return match?.[1] || null;
}

function resolveReplacementWhisperBinary(currentBinaryPath: string, replacementName: string): string | null {
  const localCandidate = join(dirname(currentBinaryPath), replacementName);
  if (existsSync(localCandidate)) return localCandidate;

  const fromPath = findExecutableInPath([replacementName]);
  if (fromPath) return fromPath;

  return null;
}

function isDeprecatedWhisperStub(binaryPath: string): boolean {
  try {
    const output = execFileSync(binaryPath, ["--help"], {
      timeout: 5000,
      stdio: "pipe",
      encoding: "utf-8",
    });
    return /is deprecated/i.test(output || "");
  } catch (err) {
    const output = getProcessErrorOutput(err);
    return /is deprecated/i.test(output);
  }
}

function readWavAsFloat32(wavPath: string): Float32Array {
  const buffer = readFileSync(wavPath);
  if (buffer.length < 44) {
    throw new Error("Invalid WAV file: header too short");
  }

  const riff = buffer.toString("ascii", 0, 4);
  const wave = buffer.toString("ascii", 8, 12);
  if (riff !== "RIFF" || wave !== "WAVE") {
    throw new Error("Invalid WAV file: missing RIFF/WAVE headers");
  }

  let offset = 12;
  let audioFormat = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;

    if (chunkId === "fmt " && chunkSize >= 16) {
      audioFormat = buffer.readUInt16LE(chunkDataOffset);
      channels = buffer.readUInt16LE(chunkDataOffset + 2);
      bitsPerSample = buffer.readUInt16LE(chunkDataOffset + 14);
    } else if (chunkId === "data") {
      dataOffset = chunkDataOffset;
      dataSize = chunkSize;
      break;
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0 || dataSize <= 0) {
    throw new Error("Invalid WAV file: data chunk not found");
  }

  if (audioFormat !== 1) {
    throw new Error(`Unsupported WAV encoding: expected PCM (1), received ${audioFormat}`);
  }

  if (bitsPerSample !== 16) {
    throw new Error(`Unsupported WAV bit depth: expected 16-bit PCM, received ${bitsPerSample}`);
  }

  if (channels < 1) {
    throw new Error("Invalid WAV file: channel count is zero");
  }

  const frameSize = channels * 2;
  const frameCount = Math.floor(dataSize / frameSize);
  const samples = new Float32Array(frameCount);

  for (let i = 0; i < frameCount; i += 1) {
    const frameStart = dataOffset + i * frameSize;
    let monoSum = 0;
    for (let ch = 0; ch < channels; ch += 1) {
      monoSum += buffer.readInt16LE(frameStart + ch * 2);
    }
    samples[i] = (monoSum / channels) / 32768;
  }

  return samples;
}

function getFfmpegBundledRelativePaths(): string[] {
  return [
    // ffmpeg-static package stores the real binary here (dev mode)
    join("node_modules", "ffmpeg-static", platform() === "win32" ? "ffmpeg.exe" : "ffmpeg"),
    // Bundled by electron-prepare.js from ffmpeg-static (validated by isJavaScriptShim)
    join("node_modules", ".bin", platform() === "win32" ? "ffmpeg.exe" : "ffmpeg"),
  ];
}

function findExecutableInPath(candidates: string[]): string | null {
  const lookupCommand = platform() === "win32" ? "where" : "which";
  for (const candidate of candidates) {
    try {
      const output = execFileSync(lookupCommand, [candidate], {
        timeout: 3000,
        stdio: "pipe",
        encoding: "utf-8",
      }).trim();
      if (!output) continue;

      const paths = output.split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
      for (const p of paths) {
        if (existsSync(p)) return p;
      }
    } catch {
      // Not found in PATH
    }
  }
  return null;
}

function getBundledBinaryPaths(name: string, relativePath: string): string[] {
  const paths: string[] = [];

  const resourcesPath = process.env.ELECTRON_RESOURCES_PATH;
  if (resourcesPath) {
    paths.push(join(resourcesPath, "binaries", name, relativePath));
    paths.push(join(resourcesPath, "standalone", "binaries", name, relativePath));
    // ffmpeg is bundled into standalone/node_modules/.bin during electron:prepare
    paths.push(join(resourcesPath, "standalone", relativePath));
    paths.push(join(resourcesPath, relativePath));
  }

  const cwd = process.cwd();
  paths.push(join(cwd, "binaries", name, relativePath));
  paths.push(join(cwd, "..", "binaries", name, relativePath));
  paths.push(join(cwd, relativePath));
  paths.push(join(cwd, "..", relativePath));

  return [...new Set(paths)];
}

function resolveWhisperModelPath(modelId: string): string | null {
  const modelInfo = getWhisperModel(modelId);
  const filename = modelInfo?.hfFile || `${modelId}.bin`;

  const electronModelsDir = process.env.LOCAL_DATA_PATH
    ? join(process.env.LOCAL_DATA_PATH, "..", "models", "whisper")
    : null;
  if (electronModelsDir) {
    const p = join(electronModelsDir, filename);
    if (existsSync(p)) return p;
  }

  const electronUserDataFallback = getElectronUserDataModelsDir();
  if (electronUserDataFallback) {
    const p = join(electronUserDataFallback, filename);
    if (existsSync(p)) return p;
  }

  const devPath = join(process.cwd(), ".local-data", "models", "whisper", filename);
  if (existsSync(devPath)) return devPath;

  const brewModelPaths = [
    join("/opt/homebrew/share/whisper-cpp/models", filename),
    join("/usr/local/share/whisper-cpp/models", filename),
  ];
  for (const p of brewModelPaths) {
    if (existsSync(p)) return p;
  }

  const commonPaths = [
    join(homedir(), ".cache", "whisper", filename),
    join(homedir(), ".local", "share", "whisper", filename),
    join(process.cwd(), "models", filename),
    join(process.cwd(), "whisper.cpp", "models", filename),
  ];

  for (const p of commonPaths) {
    if (existsSync(p)) return p;
  }

  return null;
}

function getElectronUserDataModelsDir(): string | null {
  const p = platform();
  const home = homedir();
  const appName = "selene";

  if (p === "darwin") {
    return join(home, "Library", "Application Support", appName, "models", "whisper");
  }
  if (p === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    return join(appData, appName, "models", "whisper");
  }
  if (p === "linux") {
    const xdgDataHome = process.env.XDG_DATA_HOME || join(home, ".config");
    return join(xdgDataHome, appName, "models", "whisper");
  }
  return null;
}

function getExtensionForMimeType(mimeType: string): string {
  const map: Record<string, string> = {
    "audio/webm": "webm",
    "audio/webm;codecs=opus": "webm",
    "audio/ogg": "ogg",
    "audio/ogg;codecs=opus": "ogg",
    "audio/wav": "wav",
    "audio/wave": "wav",
    "audio/x-wav": "wav",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/m4a": "m4a",
    "audio/aac": "aac",
    "audio/flac": "flac",
    "audio/x-flac": "flac",
    "audio/opus": "opus",
  };

  if (map[mimeType]) return map[mimeType];

  const base = mimeType.split(";")[0]?.trim();
  return map[base] || "webm";
}

/**
 * Detect if a MIME type represents an audio file.
 */
export function isAudioMimeType(mimeType: string): boolean {
  return mimeType.startsWith("audio/") || mimeType === "application/ogg";
}
