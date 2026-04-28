import Database from "better-sqlite3";
import { initCoreTablesWith } from "./migrations/core-tables";
import { initCharacterTablesWith } from "./migrations/character-tables";
import { initChannelTablesWith } from "./migrations/channel-tables";
import { initObservabilityTablesWith } from "./migrations/observability-tables";
import { initLobbiesTablesWith } from "./migrations/lobbies-tables";
import { initSkillsTablesWith, runSkillsMigrations } from "./migrations/skills-tables";
import { initPluginWorkflowTablesWith } from "./migrations/plugin-workflow-tables";
import { initDesignGalleryTablesWith } from "./migrations/design-gallery-tables";
import { initDesignSnapshotsTableWith } from "./migrations/design-snapshots-table";
import { initSessionLastActiveComponentWith } from "./migrations/session-last-active-component";
import { runDataMigrations } from "./migrations/data-migrations";
import { seedLobbyStarterTemplatesWith } from "../lobbies/seed-templates";

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
  // lobbies FK into agent_runs, so observability must initialize first.
  initLobbiesTablesWith(sqlite);
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

  // Seed built-in (public) lobby starter templates. SPEC §2 commits to 3
  // starter templates (blank, research-and-summarize, code-task) and SPEC §4
  // requires public templates have user_id = NULL. The seed runs after the
  // lobby tables exist and is idempotent (`INSERT OR IGNORE` on stable ids),
  // so it's safe to call on every boot.
  seedLobbyStarterTemplatesWith(sqlite);
}
