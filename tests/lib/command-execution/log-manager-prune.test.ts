import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    process.env.LOCAL_DATA_PATH = previousDataPath;
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
});
