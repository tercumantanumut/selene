/**
 * One-time cleanup: remove redundant `argsText` from stored tool-call parts.
 *
 * New rows no longer persist `argsText` once `args` is parsed (see
 * stripRedundantArgsText in app/api/chat/canonical-content.ts). This script
 * applies the same rule to existing rows. Close Selene before running it.
 *
 * Usage:
 *   npx tsx scripts/perf/strip-persisted-args-text.ts [dbPath]            # dry run
 *   npx tsx scripts/perf/strip-persisted-args-text.ts [dbPath] --apply    # rewrite rows
 *   npx tsx scripts/perf/strip-persisted-args-text.ts [dbPath] --apply --vacuum
 *
 * dbPath defaults to ~/Library/Application Support/Selene/data/zlutty.db.
 */
import Database from "better-sqlite3";
import * as os from "os";
import * as path from "path";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const vacuum = args.includes("--vacuum");
const dbPath =
  args.find((arg) => !arg.startsWith("--")) ??
  path.join(os.homedir(), "Library", "Application Support", "Selene", "data", "zlutty.db");

type Part = Record<string, unknown>;

function stripParts(parts: Part[]): Part[] | null {
  let changed = false;
  const result = parts.map((part) => {
    if (
      part.type !== "tool-call" ||
      part.args === undefined ||
      part.state === "input-streaming" ||
      typeof part.argsText !== "string"
    ) {
      return part;
    }
    changed = true;
    const { argsText: _argsText, ...rest } = part;
    return rest;
  });
  return changed ? result : null;
}

const db = new Database(dbPath);
db.pragma("busy_timeout = 5000");

const select = db.prepare(
  `SELECT id, content FROM messages
   WHERE role = 'assistant' AND content LIKE '%"argsText"%' AND rowid > ?
   ORDER BY rowid LIMIT 500`,
);
const rowidOf = db.prepare(`SELECT rowid FROM messages WHERE id = ?`);
const update = db.prepare(`UPDATE messages SET content = ? WHERE id = ?`);

let lastRowid = 0;
let rowsChanged = 0;
let bytesSaved = 0;

for (;;) {
  const rows = select.all(lastRowid) as Array<{ id: string; content: string }>;
  if (rows.length === 0) break;

  const writes: Array<{ id: string; content: string }> = [];
  for (const row of rows) {
    let parts: unknown;
    try {
      parts = JSON.parse(row.content);
    } catch {
      continue;
    }
    if (!Array.isArray(parts)) continue;
    const stripped = stripParts(parts as Part[]);
    if (!stripped) continue;
    const content = JSON.stringify(stripped);
    bytesSaved += row.content.length - content.length;
    rowsChanged++;
    writes.push({ id: row.id, content });
  }

  if (apply && writes.length > 0) {
    db.transaction(() => {
      for (const write of writes) update.run(write.content, write.id);
    })();
  }

  const last = rowidOf.get(rows[rows.length - 1].id) as { rowid: number };
  lastRowid = last.rowid;
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
console.log(
  `${apply ? "Rewrote" : "Would rewrite"} ${rowsChanged} messages, saving ${mb(bytesSaved)} MB of content.`,
);

if (apply && vacuum) {
  console.log("Running VACUUM to return freed pages to disk...");
  db.exec("VACUUM");
  console.log("Done.");
} else if (apply) {
  console.log("Freed pages are reused by SQLite; pass --vacuum to shrink the file.");
}

db.close();
