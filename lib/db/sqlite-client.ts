import Database from "better-sqlite3";
import { drizzle, BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./sqlite-schema";
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { runSessionMaintenance } from "./maintenance";
import { initializeTables } from "./sqlite-migrations";

// Get the database path from environment or use default
function getDbPath(): string {
  // In Electron, LOCAL_DATA_PATH is set to userDataPath/data
  // Database goes to userDataPath/data/zlutty.db
  if (process.env.LOCAL_DATA_PATH) {
    const dataDir = process.env.LOCAL_DATA_PATH;
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    return join(dataDir, "zlutty.db");
  }

  // For development/testing outside Electron
  const dataDir = join(process.cwd(), ".local-data");
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  return join(dataDir, "zlutty.db");
}

// Global singleton for the database connection
const globalForDb = globalThis as unknown as {
  sqlite: Database.Database | undefined;
  db: BetterSQLite3Database<typeof schema> | undefined;
  schemaVersion?: number;
  didLogSqliteOpen?: boolean;
};

const SCHEMA_VERSION = 5;

function createConnection(): { sqlite: Database.Database; db: BetterSQLite3Database<typeof schema> } {
  const dbPath = getDbPath();

  // Ensure directory exists
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  if (!globalForDb.didLogSqliteOpen) {
    console.log("[SQLite] Opening database at:", dbPath);
    globalForDb.didLogSqliteOpen = true;
  }

  const sqlite = new Database(dbPath);

  // Enable WAL mode for better concurrent access
  sqlite.pragma("journal_mode = WAL");

  // Allow short waits for locks during concurrent dev migrations.
  sqlite.pragma("busy_timeout = 5000");

  // Enable foreign keys
  sqlite.pragma("foreign_keys = ON");

  const db = drizzle(sqlite, { schema });

  return { sqlite, db };
}

// Initialize the database
function getDb(): BetterSQLite3Database<typeof schema> {
  if (!globalForDb.db) {
    const { sqlite, db } = createConnection();
    globalForDb.sqlite = sqlite;
    globalForDb.db = db;

    // Initialize tables on first connection
    initializeTables(sqlite);
    runSessionMaintenance(sqlite);
    globalForDb.schemaVersion = SCHEMA_VERSION;
    return globalForDb.db;
  }
  if (globalForDb.schemaVersion !== SCHEMA_VERSION && globalForDb.sqlite) {
    initializeTables(globalForDb.sqlite);
    runSessionMaintenance(globalForDb.sqlite);
    globalForDb.schemaVersion = SCHEMA_VERSION;
  }
  return globalForDb.db;
}

// Check if we're in a build environment (Next.js static generation)
const isBuildTime = process.env.NEXT_PHASE === "phase-production-build" ||
  process.argv.some(arg => arg.includes("next") && process.argv.includes("build"));

// Export the database instance (lazy initialization to avoid build-time issues)
// During build time, we export a proxy that throws if accessed
export const db: BetterSQLite3Database<typeof schema> = isBuildTime
  ? (new Proxy({} as BetterSQLite3Database<typeof schema>, {
    get(_, prop) {
      if (prop === "then") return undefined; // Allow Promise checks
      throw new Error(`Database accessed during build time. Property: ${String(prop)}`);
    },
  }))
  : getDb();

export function getRawSqlite(): Database.Database {
  if (isBuildTime) {
    throw new Error("Database accessed during build time.");
  }
  getDb();
  if (!globalForDb.sqlite) {
    throw new Error("SQLite connection was not initialized.");
  }
  return globalForDb.sqlite;
}

// Export close function for cleanup
function closeDb(): void {
  if (globalForDb.sqlite) {
    globalForDb.sqlite.close();
    globalForDb.sqlite = undefined;
    globalForDb.db = undefined;
    console.log("[SQLite] Database connection closed");
  }
}
