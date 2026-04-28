import Database from "better-sqlite3";
import { initCoreTablesWith } from "./migrations/core-tables";
import { initCharacterTablesWith } from "./migrations/character-tables";
import { initChannelTablesWith } from "./migrations/channel-tables";
import { initObservabilityTablesWith } from "./migrations/observability-tables";
import { initSkillsTablesWith, runSkillsMigrations } from "./migrations/skills-tables";
import { initPluginWorkflowTablesWith } from "./migrations/plugin-workflow-tables";
import { initDesignGalleryTablesWith } from "./migrations/design-gallery-tables";
import { initDesignSnapshotsTableWith } from "./migrations/design-snapshots-table";
import { initSessionLastActiveComponentWith } from "./migrations/session-last-active-component";
import { runDataMigrations } from "./migrations/data-migrations";

const globalForSqliteMigrations = globalThis as typeof globalThis & {
  didLogSqliteTableInit?: boolean;
};

/**
 * Initialize all database tables and run inline schema migrations.
 * This function is idempotent and safe to call on every connection.
 */
export function initializeTables(sqlite: Database.Database): void {
  initCoreTablesWith(sqlite);
  initCharacterTablesWith(sqlite);
  initChannelTablesWith(sqlite);
  initObservabilityTablesWith(sqlite);
  initSkillsTablesWith(sqlite);
  initPluginWorkflowTablesWith(sqlite);
  initDesignGalleryTablesWith(sqlite);
  // design_snapshots depends on design_components (FK with ON DELETE CASCADE)
  // — MUST run after initDesignGalleryTablesWith. Idempotent.
  initDesignSnapshotsTableWith(sqlite);
  // sessions.last_active_component_id FKs into design_components(id)
  // (ON DELETE SET NULL) — MUST run after initDesignGalleryTablesWith.
  // Idempotent: guarded by PRAGMA table_info on `sessions`.
  initSessionLastActiveComponentWith(sqlite);

  if (!globalForSqliteMigrations.didLogSqliteTableInit) {
    console.log("[SQLite] All tables initialized (including plugin and workflow systems)");
    globalForSqliteMigrations.didLogSqliteTableInit = true;
  }

  runDataMigrations(sqlite);
  runSkillsMigrations(sqlite);
}
