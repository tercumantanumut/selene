import { ipcMain, shell } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as os from "node:os";
import { spawn } from "node:child_process";
// @huggingface/hub is dynamically imported where needed to avoid bundling ~4MB into main.js
import { debugLog, debugError } from "./debug-logger";
import type { IpcHandlerContext } from "./ipc-context";
import { loadHuggingFaceHubRuntime } from "@/lib/huggingface/hub-runtime";
import {
  getParakeetModel,
  getSherpaOnnxArchiveName,
  getSherpaOnnxBinaryName,
  type ParakeetModel,
} from "@/lib/voice/parakeet-models";

// ---------------------------------------------------------------------------
// Download state tracking (persists across renderer navigations)
// ---------------------------------------------------------------------------

interface ActiveDownload {
  modelId: string;
  status: "downloading" | "completed" | "error";
  progress: number;
  totalBytes: number;
  downloadedBytes: number;
  totalFiles: number;
  downloadedFiles: number;
  currentFile: string;
  error?: string;
  startedAt: number;
  abortController: AbortController;
}

const activeDownloads = new Map<string, ActiveDownload>();

const DOWNLOAD_MANIFEST_FILE = "_download_complete.json";
const DOWNLOAD_LOCK_FILE = "_downloading.lock";

/** Ensure a resolved path is inside the allowed base directory (prevents path traversal). */
function assertInsideDir(basePath: string, resolvedPath: string): void {
  const normalizedBase = path.resolve(basePath) + path.sep;
  const normalizedResolved = path.resolve(resolvedPath);
  if (!normalizedResolved.startsWith(normalizedBase) && normalizedResolved !== path.resolve(basePath)) {
    throw new Error(`Path traversal detected: ${resolvedPath} is outside ${basePath}`);
  }
}

const PARAKEET_DEFAULT_MODEL_ID = "parakeet-tdt-0.6b-v3";

function getParakeetBaseDir(userModelsDir: string): string {
  return path.join(userModelsDir, "parakeet");
}

function getParakeetModelDir(userModelsDir: string, model: ParakeetModel): string {
  return path.join(getParakeetBaseDir(userModelsDir), model.modelDir);
}

function readParakeetModelId(settingsPath: string): string | null {
  try {
    if (!fs.existsSync(settingsPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as { parakeetModel?: string };
    return parsed.parakeetModel?.trim() || null;
  } catch {
    return null;
  }
}

function collectFilesRecursive(rootDir: string, maxDepth = 6): string[] {
  if (!fs.existsSync(rootDir)) return [];

  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  };

  walk(rootDir, 0);
  return out;
}

function getSherpaBinaryPath(userModelsDir: string): string | null {
  const binaryName = getSherpaOnnxBinaryName(process.platform, process.arch);
  if (!binaryName) return null;

  const baseDir = getParakeetBaseDir(userModelsDir);
  const candidates = collectFilesRecursive(baseDir)
    .filter((filePath) => path.basename(filePath) === binaryName);

  return candidates[0] ?? null;
}

function ensureExecutable(filePath: string): void {
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(filePath, 0o755);
  } catch {
    // Best-effort; if chmod fails, spawn will surface the permission issue later.
  }
}

function extractArchive(archivePath: string, destinationDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tarCmd = process.platform === "win32" ? "tar.exe" : "tar";
    const child = spawn(tarCmd, ["-xjf", archivePath, "-C", destinationDir], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`tar extraction failed (exit ${code}): ${stderr.slice(0, 500)}`));
    });
  });
}

async function downloadToFile(url: string, destinationPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }

  const data = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destinationPath, data);
}

function getSherpaRuntimeArchiveUrl(archiveName: string): string {
  return `https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.12.23/${archiveName}`;
}

// ---------------------------------------------------------------------------
// Registration function
// ---------------------------------------------------------------------------

export function registerModelHandlers(ctx: IpcHandlerContext): void {
  const { userModelsDir } = ctx;

  // --------------------------------------------------------------------------
  // Model download handlers
  // --------------------------------------------------------------------------

  ipcMain.handle("model:getModelsDir", () => {
    return userModelsDir;
  });

  ipcMain.handle("model:checkExists", async (_event, modelId: string) => {
    const modelPath = path.join(userModelsDir, ...modelId.split("/"));
    assertInsideDir(userModelsDir, modelPath);

    // If a download lock file exists, model is incomplete
    if (fs.existsSync(path.join(modelPath, DOWNLOAD_LOCK_FILE))) {
      return false;
    }

    // Check for our completion manifest (written only after ALL files download)
    if (fs.existsSync(path.join(modelPath, DOWNLOAD_MANIFEST_FILE))) {
      return true;
    }

    // Fallback: check minimum required files exist (config.json + at least one .onnx)
    if (!fs.existsSync(path.join(modelPath, "config.json"))) {
      return false;
    }
    const hasOnnx = fs.existsSync(modelPath) &&
      fs.readdirSync(modelPath, { recursive: true })
        .some((f) => String(f).endsWith(".onnx"));
    return hasOnnx;
  });

  // Return active download state (survives renderer navigation)
  ipcMain.handle("model:getDownloadState", async (_event, modelId: string) => {
    const download = activeDownloads.get(modelId);
    if (!download) return null;
    return {
      modelId: download.modelId,
      status: download.status,
      progress: download.progress,
      totalBytes: download.totalBytes,
      downloadedBytes: download.downloadedBytes,
      totalFiles: download.totalFiles,
      downloadedFiles: download.downloadedFiles,
      currentFile: download.currentFile,
      error: download.error,
      startedAt: download.startedAt,
    };
  });

  // Cancel an active download
  ipcMain.handle("model:cancelDownload", async (_event, modelId: string) => {
    const download = activeDownloads.get(modelId);
    if (download && download.status === "downloading") {
      // Signal abort -- the download loop will throw, hit the catch block,
      // clean up the lock file, and schedule map eviction.
      download.abortController.abort();
      return { success: true };
    }
    return { success: false, error: "No active download" };
  });

  ipcMain.handle("model:download", async (event, modelId: string) => {
    // If already downloading this model, return current state
    const existing = activeDownloads.get(modelId);
    if (existing && existing.status === "downloading") {
      return { success: false, error: "Download already in progress", inProgress: true };
    }

    const abortController = new AbortController();
    const downloadState: ActiveDownload = {
      modelId,
      status: "downloading",
      progress: 0,
      totalBytes: 0,
      downloadedBytes: 0,
      totalFiles: 0,
      downloadedFiles: 0,
      currentFile: "Preparing...",
      startedAt: Date.now(),
      abortController,
    };
    activeDownloads.set(modelId, downloadState);

    const sendProgress = () => {
      try {
        if (event.sender.isDestroyed()) return;
        const elapsed = (Date.now() - downloadState.startedAt) / 1000;
        const speed = elapsed > 0 ? downloadState.downloadedBytes / elapsed : 0;

        event.sender.send("model:downloadProgress", {
          modelId,
          status: downloadState.status,
          progress: downloadState.progress,
          totalBytes: downloadState.totalBytes,
          downloadedBytes: downloadState.downloadedBytes,
          totalFiles: downloadState.totalFiles,
          downloadedFiles: downloadState.downloadedFiles,
          file: downloadState.currentFile,
          speed, // bytes per second
          error: downloadState.error,
        });
      } catch {
        // Renderer destroyed mid-download; progress is still tracked in activeDownloads map
      }
    };

    try {
      const destDir = path.join(userModelsDir, ...modelId.split("/"));
      assertInsideDir(userModelsDir, destDir);

      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }

      // Write lock file to mark download in progress
      fs.writeFileSync(path.join(destDir, DOWNLOAD_LOCK_FILE), JSON.stringify({
        modelId,
        startedAt: new Date().toISOString(),
      }));

      // Remove stale manifest if re-downloading
      try { fs.unlinkSync(path.join(destDir, DOWNLOAD_MANIFEST_FILE)); } catch { /* ignore */ }

      debugLog(`[Model] Starting download: ${modelId} -> ${destDir}`);

      const { listFiles, downloadFile } = loadHuggingFaceHubRuntime();
      const files: { path: string; size: number }[] = [];
      for await (const file of listFiles({ repo: modelId, recursive: true })) {
        if (file.type === "file" && !file.path.startsWith(".git/")) {
          files.push({ path: file.path, size: file.size ?? 0 });
        }
      }

      const totalFiles = files.length;
      const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
      let downloadedBytes = 0;

      downloadState.totalFiles = totalFiles;
      downloadState.totalBytes = totalBytes;

      debugLog(`[Model] Found ${totalFiles} files to download (${(totalBytes / 1024 / 1024).toFixed(1)} MB total)`);
      sendProgress();

      for (const file of files) {
        // Check for cancellation
        if (abortController.signal.aborted) {
          throw new Error("Download cancelled");
        }

        const filePath = path.join(destDir, file.path);
        const fileDir = path.dirname(filePath);

        if (!fs.existsSync(fileDir)) {
          fs.mkdirSync(fileDir, { recursive: true });
        }

        downloadState.currentFile = file.path;
        sendProgress();

        const blob = await downloadFile({
          repo: modelId,
          path: file.path,
          fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
            fetch(input, { ...init, signal: abortController.signal }),
        });

        if (blob) {
          const buffer = await blob.arrayBuffer();
          fs.writeFileSync(filePath, Buffer.from(buffer));

          downloadedBytes += buffer.byteLength;
          downloadState.downloadedBytes = downloadedBytes;
          downloadState.downloadedFiles++;
          downloadState.progress = totalBytes > 0
            ? Math.round((downloadedBytes / totalBytes) * 100)
            : Math.round((downloadState.downloadedFiles / totalFiles) * 100);
          sendProgress();
        }
      }

      // Write completion manifest
      fs.writeFileSync(path.join(destDir, DOWNLOAD_MANIFEST_FILE), JSON.stringify({
        modelId,
        completedAt: new Date().toISOString(),
        totalFiles,
        totalBytes: downloadedBytes,
        files: files.map(f => f.path),
      }));

      // Remove lock file
      try { fs.unlinkSync(path.join(destDir, DOWNLOAD_LOCK_FILE)); } catch { /* ignore */ }

      downloadState.status = "completed";
      downloadState.progress = 100;
      debugLog(`[Model] Download complete: ${modelId}`);
      sendProgress();

      // Keep state for 30s so UI can pick it up after navigation
      setTimeout(() => activeDownloads.delete(modelId), 30000);

      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      debugError(`[Model] Download failed: ${modelId}`, error);

      downloadState.status = "error";
      downloadState.error = errorMsg;
      sendProgress();

      // Clean up lock file on error
      const destDir = path.join(userModelsDir, ...modelId.split("/"));
      try { fs.unlinkSync(path.join(destDir, DOWNLOAD_LOCK_FILE)); } catch { /* ignore */ }

      // Keep error state for 60s
      setTimeout(() => activeDownloads.delete(modelId), 60000);

      return { success: false, error: errorMsg };
    }
  });

  // --------------------------------------------------------------------------
  // model:validate — run a test embedding to confirm the pipeline works
  // --------------------------------------------------------------------------

  ipcMain.handle("model:validate", async (_event, modelId: string) => {
    try {
      // Dynamic import so ONNX is only loaded on demand
      const { runValidationEmbedding } = await import("@/lib/ai/local-embeddings");
      const result = await runValidationEmbedding({ modelId });
      debugLog(
        `[Model] Validation ${result.success ? "PASSED" : "FAILED"} for ${modelId}: ` +
        `dims=${result.dims} ms=${result.durationMs}${result.error ? ` err=${result.error}` : ""}`
      );
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      debugError(`[Model] Validation error for ${modelId}`, err);
      return { success: false, durationMs: 0, dims: 0, error };
    }
  });

  // --------------------------------------------------------------------------
  // model:openFolder — reveal model directory in Finder / Explorer
  // --------------------------------------------------------------------------

  ipcMain.handle("model:openFolder", async (_event, modelId: string) => {
    const modelPath = path.join(userModelsDir, ...modelId.split("/"));
    assertInsideDir(userModelsDir, modelPath);

    // If the model hasn't been downloaded yet, open the parent models dir
    const targetPath = fs.existsSync(modelPath) ? modelPath : userModelsDir;
    await shell.openPath(targetPath);
    debugLog(`[Model] Opened folder: ${targetPath}`);
    return { success: true, path: targetPath };
  });

  // --------------------------------------------------------------------------
  // model:redownloadAndValidate — clear files, re-download, then validate
  // --------------------------------------------------------------------------

  ipcMain.handle("model:redownloadAndValidate", async (event, modelId: string) => {
    const destDir = path.join(userModelsDir, ...modelId.split("/"));
    assertInsideDir(userModelsDir, destDir);

    const sendStatus = (status: string, detail?: string) => {
      try {
        if (!event.sender.isDestroyed()) {
          event.sender.send("model:redownloadProgress", { modelId, status, detail });
        }
      } catch { /* renderer destroyed */ }
    };

    try {
      // Step 1: Remove existing files
      sendStatus("clearing", "Removing existing model files…");
      if (fs.existsSync(destDir)) {
        const clearDir = (dir: string) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              clearDir(full);
              try { fs.rmdirSync(full); } catch { /* not empty */ }
            } else {
              fs.unlinkSync(full);
            }
          }
        };
        clearDir(destDir);
      }
      debugLog(`[Model] Cleared ${destDir} for redownload`);

      // Step 2: Re-download via HuggingFace Hub (same logic as model:download)
      sendStatus("downloading", "Starting fresh download…");

      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }

      fs.writeFileSync(path.join(destDir, DOWNLOAD_LOCK_FILE), JSON.stringify({
        modelId,
        startedAt: new Date().toISOString(),
      }));
      try { fs.unlinkSync(path.join(destDir, DOWNLOAD_MANIFEST_FILE)); } catch { /* ignore */ }

      const { listFiles: listHfFiles, downloadFile: downloadHfFile } = loadHuggingFaceHubRuntime();

      const files: { path: string; size: number }[] = [];
      for await (const file of listHfFiles({ repo: modelId, recursive: true })) {
        if (file.type === "file" && !file.path.startsWith(".git/")) {
          files.push({ path: file.path, size: file.size ?? 0 });
        }
      }

      const totalBytes = files.reduce((s, f) => s + f.size, 0);
      let downloadedBytes = 0;

      for (const file of files) {
        sendStatus(
          "downloading",
          `${file.path} (${Math.round((downloadedBytes / Math.max(totalBytes, 1)) * 100)}%)`
        );

        const filePath = path.join(destDir, file.path);
        const fileDir = path.dirname(filePath);
        if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });

        const blob = await downloadHfFile({ repo: modelId, path: file.path });
        if (blob) {
          const buffer = Buffer.from(await blob.arrayBuffer());
          fs.writeFileSync(filePath, buffer);
          downloadedBytes += buffer.byteLength;
        }
      }

      fs.writeFileSync(path.join(destDir, DOWNLOAD_MANIFEST_FILE), JSON.stringify({
        modelId,
        completedAt: new Date().toISOString(),
        totalFiles: files.length,
        totalBytes: downloadedBytes,
      }));
      try { fs.unlinkSync(path.join(destDir, DOWNLOAD_LOCK_FILE)); } catch { /* ignore */ }

      debugLog(`[Model] Redownload complete: ${modelId}`);

      // Step 3: Validate
      sendStatus("validating", "Running embedding test…");
      const { runValidationEmbedding } = await import("@/lib/ai/local-embeddings");
      const validation = await runValidationEmbedding({ modelId });

      sendStatus(
        "complete",
        validation.success
          ? `Validation passed — ${validation.dims}d in ${validation.durationMs}ms`
          : `Download complete but validation failed: ${validation.error}`
      );

      return { success: true, validation };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      debugError(`[Model] Redownload+validate failed for ${modelId}`, err);

      // Clean up lock file on error
      try { fs.unlinkSync(path.join(destDir, DOWNLOAD_LOCK_FILE)); } catch { /* ignore */ }

      sendStatus("error", error);
      return { success: false, error };
    }
  });

  ipcMain.handle("model:checkFileExists", async (_event, opts: { modelId: string; filename: string }) => {
    const filePath = path.join(userModelsDir, "whisper", opts.filename);
    return fs.existsSync(filePath);
  });

  ipcMain.handle("model:downloadFile", async (event, opts: { modelId: string; repo: string; filename: string }) => {
    try {
      const destDir = path.join(userModelsDir, "whisper");
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }

      const destPath = path.join(destDir, opts.filename);
      debugLog(`[Model] Starting single-file download: ${opts.repo}/${opts.filename} -> ${destPath}`);

      event.sender.send("model:downloadProgress", {
        modelId: opts.modelId,
        status: "downloading",
        progress: 0,
        file: opts.filename,
      });

      const { downloadFile } = loadHuggingFaceHubRuntime();
      const blob = await downloadFile({
        repo: opts.repo,
        path: opts.filename,
      });

      if (!blob) {
        throw new Error(`File not found: ${opts.repo}/${opts.filename}`);
      }

      const arrayBuffer = await blob.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      fs.writeFileSync(destPath, buffer);

      debugLog(`[Model] Single-file download complete: ${opts.filename} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);

      event.sender.send("model:downloadProgress", {
        modelId: opts.modelId,
        status: "completed",
        progress: 100,
        file: opts.filename,
      });

      return { success: true };
    } catch (error) {
      debugError(`[Model] Single-file download failed: ${opts.repo}/${opts.filename}`, error);
      event.sender.send("model:downloadProgress", {
        modelId: opts.modelId,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle("parakeet:getStatus", async (_event, requestedModelId?: string) => {
    const settingsPath = path.join(ctx.dataDir, "settings.json");
    const configuredModelId = readParakeetModelId(settingsPath);
    const modelId = requestedModelId || configuredModelId || PARAKEET_DEFAULT_MODEL_ID;
    const model = getParakeetModel(modelId);

    const baseDir = getParakeetBaseDir(userModelsDir);
    const modelDir = model ? getParakeetModelDir(userModelsDir, model) : null;
    const wsBinary = getSherpaBinaryPath(userModelsDir);

    return {
      installed: !!(modelDir && fs.existsSync(path.join(modelDir, "tokens.txt"))),
      running: false,
      modelId: model?.id ?? modelId,
      modelDir,
      wsBinary,
      wsAvailable: !!wsBinary,
      cpuThreads: Math.max(1, Math.min(8, Math.floor(os.cpus().length * 0.75))),
      baseDir,
    };
  });

  ipcMain.handle("parakeet:resolvePaths", async (_event, requestedModelId?: string) => {
    const settingsPath = path.join(ctx.dataDir, "settings.json");
    const configuredModelId = readParakeetModelId(settingsPath);
    const modelId = requestedModelId || configuredModelId || PARAKEET_DEFAULT_MODEL_ID;
    const model = getParakeetModel(modelId);

    if (!model) {
      return { success: false, error: `Unsupported Parakeet model: ${modelId}` };
    }

    const modelDir = getParakeetModelDir(userModelsDir, model);
    const wsBinary = getSherpaBinaryPath(userModelsDir);

    return {
      success: true,
      modelId: model.id,
      modelDir,
      wsBinary,
      modelInstalled: fs.existsSync(path.join(modelDir, "tokens.txt")),
      wsAvailable: !!wsBinary,
    };
  });

  ipcMain.handle("parakeet:downloadModel", async (event, requestedModelId?: string) => {
    const modelId = requestedModelId || PARAKEET_DEFAULT_MODEL_ID;
    const model = getParakeetModel(modelId);
    if (!model) {
      return { success: false, error: `Unsupported Parakeet model: ${modelId}` };
    }

    const archiveName = getSherpaOnnxArchiveName(process.platform, process.arch);
    if (!archiveName) {
      return {
        success: false,
        error: `Unsupported platform for sherpa-onnx runtime: ${process.platform}-${process.arch}`,
      };
    }

    const baseDir = getParakeetBaseDir(userModelsDir);
    const modelDir = getParakeetModelDir(userModelsDir, model);
    const runtimeArchivePath = path.join(baseDir, archiveName);

    fs.mkdirSync(baseDir, { recursive: true });

    const sendProgress = (status: string, progress: number, file?: string, error?: string) => {
      event.sender.send("model:downloadProgress", {
        modelId: model.id,
        status,
        progress,
        file,
        error,
      });
    };

    try {
      const existingBinary = getSherpaBinaryPath(userModelsDir);
      if (!existingBinary) {
        sendProgress("downloading", 5, archiveName);
        await downloadToFile(getSherpaRuntimeArchiveUrl(archiveName), runtimeArchivePath);
        sendProgress("downloading", 40, archiveName);

        await extractArchive(runtimeArchivePath, baseDir);
        sendProgress("downloading", 60, "runtime-extracted");

        try {
          fs.unlinkSync(runtimeArchivePath);
        } catch {
          // best effort
        }
      }

      const resolvedBinary = getSherpaBinaryPath(userModelsDir);
      if (resolvedBinary) {
        ensureExecutable(resolvedBinary);
      }

      if (!model.requiredFiles.every((f) => fs.existsSync(path.join(modelDir, f)))) {
        fs.mkdirSync(modelDir, { recursive: true });
        const total = model.requiredFiles.length;
        let done = 0;

        for (const filename of model.requiredFiles) {
          if (fs.existsSync(path.join(modelDir, filename))) {
            done++;
            continue;
          }

          sendProgress("downloading", 70 + Math.round((done / total) * 25), filename);

          const { downloadFile } = loadHuggingFaceHubRuntime();
          const blob = await downloadFile({ repo: model.repo, path: filename });
          if (!blob) {
            throw new Error(`Failed to download ${filename} from ${model.repo}`);
          }
          const buffer = Buffer.from(await blob.arrayBuffer());
          fs.writeFileSync(path.join(modelDir, filename), buffer);
          done++;
        }
      }

      sendProgress("completed", 100, model.modelDir);

      return {
        success: true,
        modelId: model.id,
        modelDir,
        wsBinary: getSherpaBinaryPath(userModelsDir),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugError(`[Parakeet] Download failed for ${model.id}`, error);
      sendProgress("error", 0, undefined, message);
      return { success: false, error: message };
    }
  });
}
