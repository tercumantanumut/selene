import { afterEach, describe, expect, it, vi } from "vitest";
import path from "path";

// Mock DB-dependent imports to prevent better-sqlite3 from loading
vi.mock("@/lib/db/sqlite-client", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("@/lib/db/sqlite-character-schema", () => ({
  agentSyncFiles: {
    characterId: "characterId",
    relativePath: "relativePath",
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: vi.fn(),
    like: vi.fn(),
    and: vi.fn(),
    or: vi.fn(),
  };
});

vi.mock("@/lib/vectordb/sync-service", () => ({
  getSyncFolders: vi.fn(),
}));

import { isPathAllowed } from "@/lib/ai/filesystem/path-utils";

describe("isPathAllowed", () => {
  afterEach(() => {
    delete process.env.SELENE_UNSAFE_AGENT_PERMISSIONS;
  });
  // Use platform-specific paths for allowed folders
  // We use path.resolve to ensure they are absolute and normalized for the current platform
  const workspaceRoot = path.resolve(process.cwd(), "test-workspace");
  const tmpProject = path.resolve(process.cwd(), "test-tmp-project");
  
  const allowedFolders = [workspaceRoot, tmpProject];

  describe("absolute paths", () => {
    it("allows paths within a synced folder", async () => {
      const filePath = path.join(workspaceRoot, "src", "index.ts");
      expect(await isPathAllowed(filePath, allowedFolders)).toBe(filePath);
    });

    it("allows the folder root itself", async () => {
      expect(await isPathAllowed(workspaceRoot, allowedFolders)).toBe(workspaceRoot);
    });

    it("allows paths in any synced folder", async () => {
      const filePath = path.join(tmpProject, "readme.md");
      expect(await isPathAllowed(filePath, allowedFolders)).toBe(filePath);
    });

    it("rejects paths outside all synced folders", async () => {
      const outsidePath = path.resolve(process.cwd(), "outside", "file.txt");
      expect(await isPathAllowed(outsidePath, allowedFolders)).toBeNull();
    });

    it("rejects paths that share a prefix but aren't inside the folder", async () => {
      // e.g. /workspace-other vs /workspace
      const similarPrefix = workspaceRoot + "-other";
      const filePath = path.join(similarPrefix, "file.txt");
      expect(await isPathAllowed(filePath, allowedFolders)).toBeNull();
    });

    it("rejects path traversal attacks in absolute paths", async () => {
      // Construct a path that looks absolute but tries to traverse out
      // On Windows, resolve(workspaceRoot, "..", "outside") -> parent of workspaceRoot + \outside
      const traversalPath = path.resolve(workspaceRoot, "..", "outside.txt");
      expect(await isPathAllowed(traversalPath, allowedFolders)).toBeNull();
    });
  });

  describe("relative paths", () => {
    it("resolves relative paths against synced folders", async () => {
      const relPath = path.join("src", "index.ts");
      const expected = path.join(workspaceRoot, "src", "index.ts");
      expect(await isPathAllowed(relPath, allowedFolders)).toBe(expected);
    });

    it("resolves simple file names", async () => {
      const relPath = "readme.md";
      const expected = path.join(workspaceRoot, "readme.md");
      expect(await isPathAllowed(relPath, allowedFolders)).toBe(expected);
    });

    it("blocks path traversal via relative paths", async () => {
      // "../../outside.txt"
      const relPath = path.join("..", "..", "outside.txt");
      expect(await isPathAllowed(relPath, allowedFolders)).toBeNull();
    });

    it("blocks path traversal with nested traversal", async () => {
      // "src/../../../outside.txt"
      const relPath = path.join("src", "..", "..", "..", "outside.txt");
      expect(await isPathAllowed(relPath, allowedFolders)).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("returns null for empty allowed folders", async () => {
      expect(await isPathAllowed(path.join(workspaceRoot, "file.txt"), [])).toBeNull();
    });

    it("allows arbitrary absolute paths when unsafe agent permissions are enabled", async () => {
      process.env.SELENE_UNSAFE_AGENT_PERMISSIONS = "true";
      const outsidePath = path.resolve(process.cwd(), "outside", "file.txt");
      expect(await isPathAllowed(outsidePath, [])).toBe(outsidePath);
    });

    it("resolves arbitrary relative paths when unsafe agent permissions are enabled", async () => {
      process.env.SELENE_UNSAFE_AGENT_PERMISSIONS = "true";
      const relPath = path.join("..", "outside.txt");
      expect(await isPathAllowed(relPath, [])).toBe(path.resolve(relPath));
    });

    it("allows any absolute path when unsafe agent permissions are enabled", async () => {
      process.env.SELENE_UNSAFE_AGENT_PERMISSIONS = "true";
      const filePath = path.resolve(process.cwd(), "outside", "file.txt");
      expect(await isPathAllowed(filePath, [])).toBe(filePath);
    });

    it("resolves any relative path from process cwd when unsafe agent permissions are enabled", async () => {
      process.env.SELENE_UNSAFE_AGENT_PERMISSIONS = "true";
      expect(await isPathAllowed("../outside.txt", [])).toBe(path.resolve("../outside.txt"));
    });

    it("handles paths with double slashes", async () => {
      // path.join/resolve handles double slashes, but we can manually construct one
      // to ensure isPathAllowed normalizes it.
      // We use path.sep to make it platform valid
      const messyPath = workspaceRoot + path.sep + path.sep + "src" + path.sep + "file.ts";
      const expected = path.join(workspaceRoot, "src", "file.ts");
      
      const result = await isPathAllowed(messyPath, allowedFolders);
      expect(result).toBe(expected);
    });
  });
});
