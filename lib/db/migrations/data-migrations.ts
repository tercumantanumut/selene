import Database from "better-sqlite3";

/**
 * Run data migrations to keep data consistent with code changes.
 * These migrations are idempotent and safe to run multiple times.
 */
export function runDataMigrations(sqlite: Database.Database): void {
  // Migration: Rename tool names in character metadata (editRoomImage -> editImage)
  // This migration updates existing agent configurations to use the new tool name
  try {
    const toolRenameMap: Record<string, string> = {
      "editRoomImage": "editImage",
      // OpenRouter model renames (May 2026 — Gemini 2.5 Flash → 3.1 Flash)
      "generateImageGemini25Flash": "generateImageGemini31Flash",
      "editImageGemini25Flash": "editImageGemini31Flash",
      "referenceImageGemini25Flash": "referenceImageGemini31Flash",
      // Add more renames here as needed
    };
    const toolsToRemove = ["batchEditRoomImage"];

    // Get all characters with metadata containing enabled tools
    const rows = sqlite.prepare(
      `SELECT id, metadata FROM characters WHERE metadata LIKE '%enabledTools%'`
    ).all() as Array<{ id: string; metadata: string }>;

    let updatedCount = 0;
    for (const row of rows) {
      try {
        const metadata = JSON.parse(row.metadata || "{}");
        if (!metadata.enabledTools || !Array.isArray(metadata.enabledTools)) {
          continue;
        }

        let modified = false;
        const toolSet = new Set<string>();
        const removedTools = new Set(toolsToRemove);

        for (const tool of metadata.enabledTools) {
          // Skip tools that should be removed
          if (removedTools.has(tool)) {
            modified = true;
            continue;
          }
          // Rename tools that need renaming
          const renamed = toolRenameMap[tool];
          if (renamed) {
            toolSet.add(renamed);
            modified = true;
          } else {
            toolSet.add(tool);
          }
        }
        const newEnabledTools = Array.from(toolSet);

        if (modified) {
          metadata.enabledTools = newEnabledTools;
          sqlite.prepare(
            `UPDATE characters SET metadata = ?, updated_at = datetime('now') WHERE id = ?`
          ).run(JSON.stringify(metadata), row.id);
          updatedCount++;
        }
      } catch (parseError) {
        console.warn(`[SQLite Migration] Failed to parse metadata for character ${row.id}:`, parseError);
      }
    }

    if (updatedCount > 0) {
      console.log(`[SQLite Migration] Updated tool names in ${updatedCount} character(s)`);
    }
  } catch (error) {
    console.warn("[SQLite Migration] Tool name migration failed:", error);
    // Don't throw - this is a non-critical migration
  }

  // Migration: Ensure skills table exists for skill-linked prompting and scheduling.
  try {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        icon TEXT,
        prompt_template TEXT NOT NULL,
        input_parameters TEXT NOT NULL DEFAULT '[]',
        tool_hints TEXT NOT NULL DEFAULT '[]',
        trigger_examples TEXT NOT NULL DEFAULT '[]',
        category TEXT NOT NULL DEFAULT 'general',
        version INTEGER NOT NULL DEFAULT 1,
        copied_from_skill_id TEXT REFERENCES skills(id) ON DELETE SET NULL,
        copied_from_character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
        source_type TEXT NOT NULL DEFAULT 'conversation' CHECK(source_type IN ('conversation', 'manual', 'template', 'catalog')),
        source_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        catalog_id TEXT,
        run_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        last_run_at TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft', 'active', 'archived')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    sqlite.exec(`
      CREATE INDEX IF NOT EXISTS idx_skills_user_character
      ON skills (user_id, character_id, status)
    `);
    sqlite.exec(`
      CREATE INDEX IF NOT EXISTS idx_skills_character_name
      ON skills (character_id, name)
    `);

    const skillColumns = sqlite.prepare("PRAGMA table_info(skills)").all() as Array<{ name: string }>;
    const skillColumnNames = new Set(skillColumns.map((column) => column.name));
    const skillColumnsToAdd = [
      { name: "trigger_examples", sql: "ALTER TABLE skills ADD COLUMN trigger_examples TEXT NOT NULL DEFAULT '[]'" },
      { name: "category", sql: "ALTER TABLE skills ADD COLUMN category TEXT NOT NULL DEFAULT 'general'" },
      { name: "version", sql: "ALTER TABLE skills ADD COLUMN version INTEGER NOT NULL DEFAULT 1" },
      { name: "copied_from_skill_id", sql: "ALTER TABLE skills ADD COLUMN copied_from_skill_id TEXT REFERENCES skills(id) ON DELETE SET NULL" },
      { name: "copied_from_character_id", sql: "ALTER TABLE skills ADD COLUMN copied_from_character_id TEXT REFERENCES characters(id) ON DELETE SET NULL" },
      { name: "catalog_id", sql: "ALTER TABLE skills ADD COLUMN catalog_id TEXT" },
    ];

    for (const column of skillColumnsToAdd) {
      if (!skillColumnNames.has(column.name)) {
        sqlite.exec(column.sql);
        console.log(`[SQLite Migration] Added column ${column.name} to skills`);
      }
    }

    sqlite.exec(`
      CREATE INDEX IF NOT EXISTS idx_skills_user_updated
      ON skills (user_id, updated_at)
    `);
    sqlite.exec(`
      CREATE INDEX IF NOT EXISTS idx_skills_user_category
      ON skills (user_id, category)
    `);
    sqlite.exec(`
      CREATE INDEX IF NOT EXISTS idx_skills_catalog_id
      ON skills (catalog_id)
    `);

    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS skill_versions (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        prompt_template TEXT NOT NULL,
        input_parameters TEXT NOT NULL DEFAULT '[]',
        tool_hints TEXT NOT NULL DEFAULT '[]',
        description TEXT,
        change_reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    sqlite.exec(`
      CREATE INDEX IF NOT EXISTS idx_skill_versions_skill_version
      ON skill_versions (skill_id, version)
    `);
    sqlite.exec(`
      CREATE INDEX IF NOT EXISTS idx_skill_versions_skill_created
      ON skill_versions (skill_id, created_at)
    `);

    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS skill_telemetry_events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
        skill_id TEXT REFERENCES skills(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    sqlite.exec(`
      CREATE INDEX IF NOT EXISTS idx_skill_telemetry_user_event
      ON skill_telemetry_events (user_id, event_type, created_at DESC)
    `);
    sqlite.exec(`
      CREATE INDEX IF NOT EXISTS idx_skill_telemetry_skill_event
      ON skill_telemetry_events (skill_id, event_type, created_at DESC)
    `);
  } catch (error) {
    console.warn("[SQLite Migration] Skills table migration failed:", error);
  }

  // Migration: Add new columns to scheduled_tasks for pause/resume and delivery
  try {
    // Check if columns exist by trying to query them
    const tableInfo = sqlite.prepare("PRAGMA table_info(scheduled_tasks)").all() as Array<{ name: string }>;
    const existingColumns = new Set(tableInfo.map(c => c.name));

    const columnsToAdd = [
      { name: "paused_at", sql: "ALTER TABLE scheduled_tasks ADD COLUMN paused_at TEXT" },
      { name: "paused_until", sql: "ALTER TABLE scheduled_tasks ADD COLUMN paused_until TEXT" },
      { name: "pause_reason", sql: "ALTER TABLE scheduled_tasks ADD COLUMN pause_reason TEXT" },
      { name: "status", sql: "ALTER TABLE scheduled_tasks ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft', 'active', 'paused', 'archived'))" },
      { name: "delivery_method", sql: "ALTER TABLE scheduled_tasks ADD COLUMN delivery_method TEXT NOT NULL DEFAULT 'session'" },
      { name: "delivery_config", sql: "ALTER TABLE scheduled_tasks ADD COLUMN delivery_config TEXT NOT NULL DEFAULT '{}'" },
      { name: "skill_id", sql: "ALTER TABLE scheduled_tasks ADD COLUMN skill_id TEXT REFERENCES skills(id) ON DELETE SET NULL" },
    ];

    for (const col of columnsToAdd) {
      if (!existingColumns.has(col.name)) {
        sqlite.exec(col.sql);
        console.log(`[SQLite Migration] Added column ${col.name} to scheduled_tasks`);
      }
    }

    const updatedTableInfo = sqlite.prepare("PRAGMA table_info(scheduled_tasks)").all() as Array<{ name: string }>;
    const hasSkillId = updatedTableInfo.some((column) => column.name === "skill_id");
    if (hasSkillId) {
      sqlite.exec(`
        CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_skill_id
          ON scheduled_tasks (skill_id)
      `);
    }
  } catch (error) {
    console.warn("[SQLite Migration] Scheduled tasks column migration failed:", error);
    // Don't throw - this is a non-critical migration
  }

  // Migration: Expand delivery_method constraint to include "channel"
  try {
    sqlite.exec("BEGIN IMMEDIATE");

    const tableSqlRow = sqlite.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='scheduled_tasks'"
    ).get() as { sql?: string } | undefined;
    const tableSql = tableSqlRow?.sql || "";
    if (!tableSql || tableSql.includes("'channel'")) {
      sqlite.exec("COMMIT");
    } else {
      console.log("[SQLite Migration] Updating scheduled_tasks delivery_method constraint to include channel");
      sqlite.exec("PRAGMA foreign_keys=OFF");
      try {
        sqlite.exec("ALTER TABLE scheduled_tasks RENAME TO scheduled_tasks_old");
        const oldTableExists = sqlite.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_tasks_old'"
        ).get();
        if (!oldTableExists) {
          sqlite.exec("ROLLBACK");
          console.warn("[SQLite Migration] scheduled_tasks_old missing after rename, skipping migration");
        } else {
          sqlite.exec(`
            CREATE TABLE scheduled_tasks (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
              name TEXT NOT NULL,
              description TEXT,
              schedule_type TEXT NOT NULL DEFAULT 'cron' CHECK(schedule_type IN ('cron', 'interval', 'once')),
              cron_expression TEXT,
              interval_minutes INTEGER,
              scheduled_at TEXT,
              timezone TEXT NOT NULL DEFAULT 'UTC',
              initial_prompt TEXT NOT NULL,
              prompt_variables TEXT NOT NULL DEFAULT '{}',
              context_sources TEXT NOT NULL DEFAULT '[]',
              enabled INTEGER NOT NULL DEFAULT 1,
              max_retries INTEGER NOT NULL DEFAULT 3,
              timeout_ms INTEGER NOT NULL DEFAULT 300000,
              priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('high', 'normal', 'low')),
              status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft', 'active', 'paused', 'archived')),
              paused_at TEXT,
              paused_until TEXT,
              pause_reason TEXT,
              delivery_method TEXT NOT NULL DEFAULT 'session' CHECK(delivery_method IN ('session', 'email', 'slack', 'webhook', 'channel')),
              delivery_config TEXT NOT NULL DEFAULT '{}',
              result_session_id TEXT REFERENCES sessions(id),
              skill_id TEXT REFERENCES skills(id) ON DELETE SET NULL,
              create_new_session_per_run INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              updated_at TEXT NOT NULL DEFAULT (datetime('now')),
              last_run_at TEXT,
              next_run_at TEXT
            )
          `);
          sqlite.exec(`
            INSERT INTO scheduled_tasks (
              id, user_id, character_id, name, description, schedule_type, cron_expression,
              interval_minutes, scheduled_at, timezone, initial_prompt, prompt_variables,
              context_sources, enabled, max_retries, timeout_ms, priority, status, paused_at,
              paused_until, pause_reason, delivery_method, delivery_config, result_session_id,
              skill_id, create_new_session_per_run, created_at, updated_at, last_run_at, next_run_at
            )
            SELECT
              id, user_id, character_id, name, description, schedule_type, cron_expression,
              interval_minutes, scheduled_at, timezone, initial_prompt, prompt_variables,
              context_sources, enabled, max_retries, timeout_ms, priority, status, paused_at,
              paused_until, pause_reason, delivery_method, delivery_config, result_session_id,
              NULL as skill_id, create_new_session_per_run, created_at, updated_at, last_run_at, next_run_at
            FROM scheduled_tasks_old
          `);

          sqlite.exec(`
            CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_user
              ON scheduled_tasks (user_id, enabled, created_at DESC)
          `);
          sqlite.exec(`
            CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_character
              ON scheduled_tasks (character_id, enabled)
          `);
          sqlite.exec(`
            CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run
              ON scheduled_tasks (enabled, next_run_at)
          `);
          sqlite.exec(`
            CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_skill_id
              ON scheduled_tasks (skill_id)
          `);

          sqlite.exec("DROP TABLE IF EXISTS scheduled_tasks_old");
          sqlite.exec("COMMIT");
        }
      } catch (migrationError) {
        sqlite.exec("ROLLBACK");
        const hasOldTable = sqlite.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_tasks_old'"
        ).get();
        const hasNewTable = sqlite.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_tasks'"
        ).get();
        if (hasOldTable && !hasNewTable) {
          sqlite.exec("ALTER TABLE scheduled_tasks_old RENAME TO scheduled_tasks");
        }
        console.warn("[SQLite Migration] Delivery method migration aborted:", migrationError);
      } finally {
        sqlite.exec("PRAGMA foreign_keys=ON");
      }
    }
  } catch (error) {
    try {
      if (sqlite.inTransaction) {
        sqlite.exec("ROLLBACK");
      }
    } catch {
      // ignore rollback errors
    }
    console.warn("[SQLite Migration] Scheduled tasks delivery_method migration failed:", error);
    // Don't throw - this is a non-critical migration
  }

  // Migration: Repair scheduled_task_runs foreign key if it points to scheduled_tasks_old
  try {
    const tableSqlRow = sqlite.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='scheduled_task_runs'"
    ).get() as { sql?: string } | undefined;
    const tableSql = tableSqlRow?.sql || "";
    if (tableSql && tableSql.includes("scheduled_tasks_old")) {
      console.log("[SQLite Migration] Updating scheduled_task_runs foreign key to scheduled_tasks");
      sqlite.exec("BEGIN IMMEDIATE");
      sqlite.exec("PRAGMA foreign_keys=OFF");
      try {
        sqlite.exec("ALTER TABLE scheduled_task_runs RENAME TO scheduled_task_runs_old");
        const oldTableExists = sqlite.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_task_runs_old'"
        ).get();
        if (!oldTableExists) {
          sqlite.exec("ROLLBACK");
          console.warn("[SQLite Migration] scheduled_task_runs_old missing after rename, skipping migration");
        } else {
          sqlite.exec(`
            CREATE TABLE scheduled_task_runs (
              id TEXT PRIMARY KEY,
              task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
              agent_run_id TEXT,
              session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
              status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'timeout')),
              scheduled_for TEXT NOT NULL,
              started_at TEXT,
              completed_at TEXT,
              duration_ms INTEGER,
              attempt_number INTEGER NOT NULL DEFAULT 1,
              result_summary TEXT,
              error TEXT,
              resolved_prompt TEXT,
              metadata TEXT NOT NULL DEFAULT '{}',
              created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
          `);

          sqlite.exec(`
            INSERT INTO scheduled_task_runs (
              id, task_id, agent_run_id, session_id, status, scheduled_for, started_at,
              completed_at, duration_ms, attempt_number, result_summary, error, resolved_prompt,
              metadata, created_at
            )
            SELECT
              id, task_id, agent_run_id, session_id, status, scheduled_for, started_at,
              completed_at, duration_ms, attempt_number, result_summary, error, resolved_prompt,
              metadata, created_at
            FROM scheduled_task_runs_old
          `);

          sqlite.exec(`
            CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_task
              ON scheduled_task_runs (task_id, created_at DESC)
          `);
          sqlite.exec(`
            CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_status
              ON scheduled_task_runs (status, scheduled_for)
          `);

          sqlite.exec("DROP TABLE IF EXISTS scheduled_task_runs_old");
          sqlite.exec("COMMIT");
        }
      } catch (migrationError) {
        sqlite.exec("ROLLBACK");
        const hasOldTable = sqlite.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_task_runs_old'"
        ).get();
        const hasNewTable = sqlite.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_task_runs'"
        ).get();
        if (hasOldTable && !hasNewTable) {
          sqlite.exec("ALTER TABLE scheduled_task_runs_old RENAME TO scheduled_task_runs");
        }
        console.warn("[SQLite Migration] scheduled_task_runs foreign key migration aborted:", migrationError);
      } finally {
        sqlite.exec("PRAGMA foreign_keys=ON");
      }
    }
  } catch (error) {
    try {
      if (sqlite.inTransaction) {
        sqlite.exec("ROLLBACK");
      }
    } catch {
      // ignore rollback errors
    }
    console.warn("[SQLite Migration] scheduled_task_runs foreign key migration failed:", error);
  }

  // Migration: Ensure default agents do not auto-enable MCP tools
  // IMPORTANT: This must run once per character only. Do not wipe user-configured MCP selections.
  try {
    const rows = sqlite.prepare(
      "SELECT id, metadata FROM characters WHERE is_default = 1"
    ).all() as Array<{ id: string; metadata: string }>;

    let updatedCount = 0;
    for (const row of rows) {
      try {
        const metadata = JSON.parse(row.metadata || "{}");
        const alreadyApplied = metadata.defaultMcpDisableMigrationApplied === true;
        if (alreadyApplied) {
          continue;
        }

        const enabledServers = Array.isArray(metadata.enabledMcpServers)
          ? metadata.enabledMcpServers
          : [];
        const enabledTools = Array.isArray(metadata.enabledMcpTools)
          ? metadata.enabledMcpTools
          : [];
        const preferences =
          metadata.mcpToolPreferences && typeof metadata.mcpToolPreferences === "object"
            ? metadata.mcpToolPreferences
            : {};

        const hasUserConfiguredMcp =
          metadata.mcpUserConfigured === true ||
          enabledServers.length > 0 ||
          enabledTools.length > 0 ||
          Object.keys(preferences).length > 0;

        if (hasUserConfiguredMcp) {
          // Mark as applied so we don't re-check this character on every startup.
          metadata.defaultMcpDisableMigrationApplied = true;
          if (metadata.mcpUserConfigured !== true) {
            metadata.mcpUserConfigured = true;
          }
          sqlite.prepare(
            "UPDATE characters SET metadata = ?, updated_at = datetime('now') WHERE id = ?"
          ).run(JSON.stringify(metadata), row.id);
          continue;
        }

        metadata.enabledMcpServers = [];
        metadata.enabledMcpTools = [];
        metadata.mcpToolPreferences = {};
        metadata.defaultMcpDisableMigrationApplied = true;
        sqlite.prepare(
          "UPDATE characters SET metadata = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(JSON.stringify(metadata), row.id);
        updatedCount++;
      } catch (parseError) {
        console.warn(`[SQLite Migration] Failed to update MCP defaults for character ${row.id}:`, parseError);
      }
    }

    if (updatedCount > 0) {
      console.log(`[SQLite Migration] Disabled MCP tools for ${updatedCount} default agent(s)`);
    }
  } catch (error) {
    console.warn("[SQLite Migration] Default agent MCP disable migration failed:", error);
  }

  // Migration: Backfill sessions.message_count with visible conversation turns only.
  // Hidden live-prompt injected user rows must not count toward sidebar totals.
  try {
    const result = sqlite.prepare(`
      UPDATE sessions
      SET message_count = COALESCE((
        SELECT COUNT(*)
        FROM messages
        WHERE messages.session_id = sessions.id
          AND messages.role IN ('user', 'assistant')
          AND (
            messages.role != 'user'
            OR json_extract(messages.metadata, '$.livePromptInjected') IS NULL
            OR json_extract(messages.metadata, '$.livePromptInjected') = 0
          )
      ), 0)
      WHERE message_count != COALESCE((
        SELECT COUNT(*)
        FROM messages
        WHERE messages.session_id = sessions.id
          AND messages.role IN ('user', 'assistant')
          AND (
            messages.role != 'user'
            OR json_extract(messages.metadata, '$.livePromptInjected') IS NULL
            OR json_extract(messages.metadata, '$.livePromptInjected') = 0
          )
      ), 0)
    `).run();

    if (result.changes > 0) {
      console.log(`[SQLite Migration] Recomputed visible message_count for ${result.changes} session(s)`);
    }
  } catch (error) {
    console.warn("[SQLite Migration] Visible message_count migration failed:", error);
  }

  // Migration: Add chromiumWorkspace to existing agents' enabledTools
  try {
    const rows = sqlite.prepare(
      `SELECT id, metadata FROM characters WHERE metadata LIKE '%enabledTools%'`
    ).all() as Array<{ id: string; metadata: string }>;

    let updatedCount = 0;
    for (const row of rows) {
      try {
        const metadata = JSON.parse(row.metadata || "{}");
        if (!metadata.enabledTools || !Array.isArray(metadata.enabledTools)) continue;
        if (metadata.enabledTools.includes("chromiumWorkspace")) continue;

        metadata.enabledTools.push("chromiumWorkspace");
        sqlite.prepare(
          `UPDATE characters SET metadata = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(JSON.stringify(metadata), row.id);
        updatedCount++;
      } catch {
        // Skip unparseable rows
      }
    }

    if (updatedCount > 0) {
      console.log(`[SQLite Migration] Added chromiumWorkspace to ${updatedCount} agent(s)`);
    }
  } catch (error) {
    console.warn("[SQLite Migration] chromiumWorkspace migration failed:", error);
  }

  // Migration: Backfill agent_plugins rows for plugins installed before the junction table existed.
  // Without this, the LEFT JOIN in getAvailablePluginsForAgent returns NULL for assignmentEnabled,
  // which coalesces to false via `?? false`, silently disabling previously-working plugins.
  try {
    // Guard: skip if already applied
    const backfillMarker = sqlite.prepare(
      "SELECT 1 FROM agent_plugins WHERE id LIKE 'backfill-%' LIMIT 1"
    ).get();

    // Also check if there are actually any plugins missing assignment rows
    const missingCount = sqlite.prepare(`
      SELECT COUNT(*) AS cnt FROM plugins p
      WHERE p.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM agent_plugins ap WHERE ap.plugin_id = p.id
        )
    `).get() as { cnt: number } | undefined;

    if (!backfillMarker && missingCount && missingCount.cnt > 0) {
      let inserted = 0;

      // Part A: Plugins with character_id set — create assignment for the installing agent
      const agentScopedPlugins = sqlite.prepare(`
        SELECT p.id AS plugin_id, p.character_id AS agent_id
        FROM plugins p
        WHERE p.status = 'active'
          AND p.character_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM agent_plugins ap
            WHERE ap.plugin_id = p.id AND ap.agent_id = p.character_id
          )
      `).all() as Array<{ plugin_id: string; agent_id: string }>;

      const insertStmt = sqlite.prepare(`
        INSERT OR IGNORE INTO agent_plugins (id, agent_id, plugin_id, enabled, created_at)
        VALUES (?, ?, ?, 1, datetime('now'))
      `);

      for (const row of agentScopedPlugins) {
        const result = insertStmt.run(
          `backfill-${row.plugin_id}-${row.agent_id}`,
          row.agent_id,
          row.plugin_id
        );
        inserted += result.changes;
      }

      // Part B: Plugins with character_id IS NULL (user-wide) — create assignment for ALL agents of that user
      const userWidePlugins = sqlite.prepare(`
        SELECT p.id AS plugin_id, p.user_id
        FROM plugins p
        WHERE p.status = 'active'
          AND p.character_id IS NULL
      `).all() as Array<{ plugin_id: string; user_id: string }>;

      for (const plugin of userWidePlugins) {
        const userAgents = sqlite.prepare(`
          SELECT id AS agent_id FROM characters WHERE user_id = ?
        `).all(plugin.user_id) as Array<{ agent_id: string }>;

        for (const agent of userAgents) {
          const result = insertStmt.run(
            `backfill-${plugin.plugin_id}-${agent.agent_id}`,
            agent.agent_id,
            plugin.plugin_id
          );
          inserted += result.changes;
        }
      }

      if (inserted > 0) {
        console.log(`[SQLite Migration] Backfilled ${inserted} agent_plugins row(s) for pre-existing plugins`);
      }
    }
  } catch (error) {
    console.warn("[SQLite Migration] Plugin assignment backfill migration failed:", error);
  }

  // Migration: Add workflow folder inheritance tracking columns
  try {
    const folderCols = sqlite.prepare("PRAGMA table_info(agent_sync_folders)").all() as Array<{ name: string }>;
    const colNames = new Set(folderCols.map((c) => c.name));

    if (!colNames.has("inherited_from_workflow_id")) {
      sqlite.exec("ALTER TABLE agent_sync_folders ADD COLUMN inherited_from_workflow_id TEXT");
    }
    if (!colNames.has("inherited_from_agent_id")) {
      sqlite.exec("ALTER TABLE agent_sync_folders ADD COLUMN inherited_from_agent_id TEXT");
    }
    if (!colNames.has("inherited_from_folder_id")) {
      sqlite.exec("ALTER TABLE agent_sync_folders ADD COLUMN inherited_from_folder_id TEXT");
    }
    sqlite.exec(`
      CREATE INDEX IF NOT EXISTS agent_sync_folders_inherited_workflow_idx
      ON agent_sync_folders (inherited_from_workflow_id)
    `);
  } catch (error) {
    console.warn("[SQLite Migration] Workflow folder tracking columns migration failed:", error);
  }
}
