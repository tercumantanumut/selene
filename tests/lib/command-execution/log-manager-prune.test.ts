import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pruneTerminalLogs } from "@/lib/command-execution/log-manager";

describe("pruneTerminalLogs", () => {
  let dataDir: string;
  let logsDir: string;
  const previousDataPath = process.env.LOCAL_DATA_PATH;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "selene-terminal-logs-"));
    logsDir = path.join(dataDir, "logs", "terminal");
    fs.mkdirSync(logsDir, { recursive: true });
    process.env.LOCAL_DATA_PATH = dataDir;
  });

  afterEach(() => {
    if (previousDataPath === undefined) {
      delete process.env.LOCAL_DATA_PATH;
    } else {
      process.env.LOCAL_DATA_PATH = previousDataPath;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("removes only .log files older than the max age", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const write = (name: string, ageMs: number) => {
      const file = path.join(logsDir, name);
      fs.writeFileSync(file, "x");
      const mtime = new Date(now - ageMs);
      fs.utimesSync(file, mtime, mtime);
    };

    write("old.log", 8 * day);
    write("fresh.log", 1 * day);
    write("old-but-not-a-log.txt", 30 * day);

    const removed = await pruneTerminalLogs(7 * day, now);

    expect(removed).toBe(1);
    expect(fs.readdirSync(logsDir).sort()).toEqual(["fresh.log", "old-but-not-a-log.txt"]);
  });

  it("reports non-ENOENT failures and keeps pruning the rest", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    for (const name of ["a.log", "b.log"]) {
      const file = path.join(logsDir, name);
      fs.writeFileSync(file, "x");
      fs.utimesSync(file, new Date(now - 8 * day), new Date(now - 8 * day));
    }
    const realUnlink = fs.promises.unlink;
    const unlinkSpy = vi.spyOn(fs.promises, "unlink").mockImplementation(async (target) => {
      if (String(target).endsWith("a.log")) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return realUnlink(target);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const removed = await pruneTerminalLogs(7 * day, now);

      expect(removed).toBe(1);
      expect(fs.readdirSync(logsDir)).toEqual(["a.log"]);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0][0])).toContain("Failed to prune 1 terminal log");
    } finally {
      unlinkSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("silently skips files that vanish mid-prune (ENOENT)", async () => {
    const now = Date.now();
    const file = path.join(logsDir, "gone.log");
    fs.writeFileSync(file, "x");
    const statSpy = vi.spyOn(fs.promises, "stat").mockRejectedValueOnce(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await pruneTerminalLogs(0, now)).toBe(0);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      statSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
