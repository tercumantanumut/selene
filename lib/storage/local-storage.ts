import { existsSync, mkdirSync, readFileSync, unlinkSync } from "fs";
import { writeFile } from "fs/promises";
import { dirname, resolve, sep } from "path";
import { nanoid } from "nanoid";

type StorageRole = "upload" | "reference" | "generated" | "mask" | "tile";

// Get the base storage path
function getStoragePath(): string {
  // In Electron, LOCAL_DATA_PATH is set to userDataPath/data
  // So media goes to userDataPath/data/media
  if (process.env.LOCAL_DATA_PATH) {
    return resolve(process.env.LOCAL_DATA_PATH, "media");
  }
  // Fallback for development
  return resolve(process.cwd(), ".local-data", "media");
}

// Ensure directory exists
function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

// Convert local path to URL for display in the app
// Uses /api/media/ endpoint which works in both Electron and browser
function pathToFileUrl(filePath: string): string {
  // Normalize path separators for cross-platform compatibility
  const normalizedPath = filePath.replace(/\\/g, "/");
  // Use the API endpoint to serve media files
  // This works in both Electron (via Next.js server) and browser
  return `/api/media/${normalizedPath}`;
}

function sanitizeSegment(value: string, fallback: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+$/, "_");
  const clipped = normalized.slice(0, 120);
  return clipped || fallback;
}

function sanitizeExtension(value: string, fallback: string = "bin"): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized || fallback;
}

function normalizeRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) {
    throw new Error("Invalid relative path");
  }

  for (const part of parts) {
    if (part === "." || part === ".." || part.includes("\0")) {
      throw new Error("Invalid path segment");
    }
  }

  return parts.join("/");
}

function resolveUnderStorage(relativePath: string): string {
  const storageRoot = resolve(getStoragePath());
  const normalizedRelative = normalizeRelativePath(relativePath);
  const fullPath = resolve(storageRoot, normalizedRelative);
  const storagePrefix = storageRoot.endsWith(sep) ? storageRoot : `${storageRoot}${sep}`;

  if (fullPath !== storageRoot && !fullPath.startsWith(storagePrefix)) {
    throw new Error("Path escapes storage directory");
  }

  return fullPath;
}

function createSessionRelativePath(
  sessionId: string,
  role: StorageRole,
  extension: string
): string {
  const safeSessionId = sanitizeSegment(sessionId, "session");
  const safeRole = sanitizeSegment(role, "generated");
  const safeExtension = sanitizeExtension(extension);
  return `${safeSessionId}/${safeRole}/${nanoid()}.${safeExtension}`;
}

function createDocumentRelativePath(
  userId: string,
  characterId: string,
  extension: string
): string {
  const safeUserId = sanitizeSegment(userId, "user");
  const safeCharacterId = sanitizeSegment(characterId, "character");
  const safeExtension = sanitizeExtension(extension);
  return `docs/${safeUserId}/${safeCharacterId}/${nanoid()}.${safeExtension}`;
}

interface UploadResult {
  localPath: string;
  url: string;
  filePath: string;
}

interface DocumentUploadResult extends UploadResult {
  extension: string;
}

/**
 * Save a base64-encoded image to local storage
 */
export async function saveBase64Image(
  base64Data: string,
  sessionId: string,
  role: StorageRole = "generated",
  format: string = "png"
): Promise<UploadResult> {
  const base64Clean = base64Data.replace(/^data:image\/\w+;base64,/, "");
  const buffer = Buffer.from(base64Clean, "base64");

  const relativePath = createSessionRelativePath(sessionId, role, format);
  const fullPath = resolveUnderStorage(relativePath);

  ensureDir(dirname(fullPath));
  await writeFile(fullPath, buffer);

  return {
    localPath: relativePath,
    url: pathToFileUrl(relativePath),
    filePath: fullPath,
  };
}

/**
 * Save a base64-encoded video to local storage
 */
export async function saveBase64Video(
  base64Data: string,
  sessionId: string,
  role: StorageRole = "generated",
  format: string = "mp4"
): Promise<UploadResult> {
  const base64Clean = base64Data.replace(/^data:(video|application)\/\w+;base64,/, "");
  const buffer = Buffer.from(base64Clean, "base64");

  const relativePath = createSessionRelativePath(sessionId, role, format);
  const fullPath = resolveUnderStorage(relativePath);

  ensureDir(dirname(fullPath));
  await writeFile(fullPath, buffer);

  return {
    localPath: relativePath,
    url: pathToFileUrl(relativePath),
    filePath: fullPath,
  };
}

/**
 * Save a file buffer to local storage
 */
export async function saveFile(
  file: Buffer,
  sessionId: string,
  filename: string,
  role: StorageRole = "upload"
): Promise<UploadResult> {
  const ext = filename.split(".").pop() || "bin";

  const relativePath = createSessionRelativePath(sessionId, role, ext);
  const fullPath = resolveUnderStorage(relativePath);

  ensureDir(dirname(fullPath));
  await writeFile(fullPath, file);

  return {
    localPath: relativePath,
    url: pathToFileUrl(relativePath),
    filePath: fullPath,
  };
}

/**
 * Save a document file (PDF, text, Markdown, HTML) to local storage
 * under a stable, agent-scoped path.
 */
async function saveDocumentFile(
  file: Buffer,
  userId: string,
  characterId: string,
  filename: string
): Promise<DocumentUploadResult> {
  const ext = filename.split(".").pop() || "bin";
  const relativePath = createDocumentRelativePath(userId, characterId, ext);
  const fullPath = resolveUnderStorage(relativePath);

  ensureDir(dirname(fullPath));
  await writeFile(fullPath, file);

  return {
    localPath: relativePath,
    url: pathToFileUrl(relativePath),
    filePath: fullPath,
    extension: sanitizeExtension(ext),
  };
}

/**
 * Read a file from local storage
 */
export function readLocalFile(relativePath: string): Buffer {
  const fullPath = resolveUnderStorage(relativePath);
  return readFileSync(fullPath);
}

/**
 * Delete a file from local storage
 */
function deleteLocalFile(relativePath: string): void {
  try {
    const fullPath = resolveUnderStorage(relativePath);
    if (existsSync(fullPath)) {
      unlinkSync(fullPath);
    }
  } catch {
    // Ignore invalid path attempts
  }
}

/**
 * Get the full file path for a relative path
 */
export function getFullPath(relativePath: string): string {
  return resolveUnderStorage(relativePath);
}

/**
 * Convert a media URL/local reference into a storage-relative path when possible.
 */
function getRelativeMediaPath(mediaRef: string): string | null {
  if (!mediaRef) return null;

  if (mediaRef.startsWith("/api/media/")) {
    return normalizeRelativePath(mediaRef.replace("/api/media/", ""));
  }

  if (mediaRef.startsWith("local-media://")) {
    return normalizeRelativePath(mediaRef.replace("local-media://", "").replace(/^\/+/, ""));
  }

  if (mediaRef.startsWith("http://") || mediaRef.startsWith("https://") || mediaRef.startsWith("data:")) {
    return null;
  }

  try {
    return normalizeRelativePath(mediaRef);
  } catch {
    return null;
  }
}

/**
 * Resolve a media URL/local reference to an absolute storage path when possible.
 */
export function getFullPathFromMediaRef(mediaRef: string): string | null {
  const relativePath = getRelativeMediaPath(mediaRef);
  if (!relativePath) return null;
  try {
    return getFullPath(relativePath);
  } catch {
    return null;
  }
}

/**
 * Check if a file exists
 */
export function fileExists(relativePath: string): boolean {
  try {
    const fullPath = resolveUnderStorage(relativePath);
    return existsSync(fullPath);
  } catch {
    return false;
  }
}

/**
 * Get the storage base path (useful for Electron to serve files)
 */
export function getMediaStoragePath(): string {
  return getStoragePath();
}

