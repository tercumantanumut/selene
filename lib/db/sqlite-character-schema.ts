import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { relations, sql } from "drizzle-orm";
import { users, sessions, messages } from "./sqlite-schema-base";

// ============================================================================
// MAIN CHARACTERS TABLE
// ============================================================================

export const characters = sqliteTable("characters", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),

  // Basic Info
  name: text("name").notNull(),
  displayName: text("display_name"),
  tagline: text("tagline"),
  status: text("status", { enum: ["draft", "active", "archived"] }).default("draft").notNull(),
  isDefault: integer("is_default", { mode: "boolean" }).default(false).notNull(),

  // Timestamps
  createdAt: text("created_at").default(sql`(datetime('now'))`).notNull(),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`).notNull(),
  lastInteractionAt: text("last_interaction_at"),

  // Metadata
  metadata: text("metadata", { mode: "json" }).default("{}").notNull(),
});

// ============================================================================
// CHARACTER IMAGES TABLE
// ============================================================================

export const characterImages = sqliteTable("character_images", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  characterId: text("character_id")
    .references(() => characters.id, { onDelete: "cascade" })
    .notNull(),

  imageType: text("image_type", { enum: ["portrait", "full_body", "expression", "outfit", "scene", "avatar"] }).notNull(),
  isPrimary: integer("is_primary", { mode: "boolean" }).default(false).notNull(),
  localPath: text("local_path").notNull(),
  url: text("url").notNull(),
  thumbnailUrl: text("thumbnail_url"),
  width: integer("width"),
  height: integer("height"),
  format: text("format"),
  prompt: text("prompt"),
  seed: integer("seed"),
  generationModel: text("generation_model"),
  sortOrder: integer("sort_order").default(0).notNull(),
  metadata: text("metadata", { mode: "json" }).default("{}").notNull(),
  createdAt: text("created_at").default(sql`(datetime('now'))`).notNull(),
});

// ============================================================================
// AGENT SYNC FOLDERS TABLE
// ============================================================================

export const agentSyncFolders = sqliteTable(
  "agent_sync_folders",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    characterId: text("character_id")
      .references(() => characters.id, { onDelete: "cascade" })
      .notNull(),
    folderPath: text("folder_path").notNull(),
    displayName: text("display_name"),
    isPrimary: integer("is_primary", { mode: "boolean" }).default(false).notNull(),
    recursive: integer("recursive", { mode: "boolean" }).default(true).notNull(),
    includeExtensions: text("include_extensions", { mode: "json" }).default('["md","txt","pdf","html"]').notNull(),
    excludePatterns: text("exclude_patterns", { mode: "json" }).default('["node_modules",".*",".git"]').notNull(),
    status: text("status", { enum: ["pending", "syncing", "synced", "error", "paused"] }).default("pending").notNull(),
    lastSyncedAt: text("last_synced_at"),
    lastError: text("last_error"),
    fileCount: integer("file_count").default(0),
    chunkCount: integer("chunk_count").default(0),
    embeddingModel: text("embedding_model"), // Track which embedding model was used for sync
    indexingMode: text("indexing_mode", {
      enum: ["files-only", "full", "auto"],
    })
      .default("auto")
      .notNull(), // files-only: track files only, full: create embeddings, auto: use embeddings if VectorDB enabled
    syncMode: text("sync_mode", {
      enum: ["auto", "manual", "scheduled", "triggered"],
    })
      .default("auto")
      .notNull(),
    syncCadenceMinutes: integer("sync_cadence_minutes").default(60).notNull(),
    fileTypeFilters: text("file_type_filters", { mode: "json" }).default("[]").notNull(),
    maxFileSizeBytes: integer("max_file_size_bytes").default(10485760).notNull(),
    chunkPreset: text("chunk_preset", {
      enum: ["balanced", "small", "large", "custom"],
    })
      .default("balanced")
      .notNull(),
    chunkSizeOverride: integer("chunk_size_override"),
    chunkOverlapOverride: integer("chunk_overlap_override"),
    reindexPolicy: text("reindex_policy", {
      enum: ["smart", "always", "never"],
    })
      .default("smart")
      .notNull(),
    skippedCount: integer("skipped_count").default(0).notNull(),
    skipReasons: text("skip_reasons", { mode: "json" }).default("{}").notNull(),
    lastRunMetadata: text("last_run_metadata", { mode: "json" }).default("{}").notNull(),
    lastRunTrigger: text("last_run_trigger", {
      enum: ["manual", "scheduled", "triggered", "auto"],
    }),
    // Workflow inheritance tracking: set when a folder is copied to a member via workflow folder sharing
    inheritedFromWorkflowId: text("inherited_from_workflow_id"),
    inheritedFromAgentId: text("inherited_from_agent_id"),
    inheritedFromFolderId: text("inherited_from_folder_id"), // Stable FK to source folder row (survives path renames)
    // Provenance of the folder record.
    // - "user":      user-configured sync folder (shown in Vector Search UI, counted in sync status, propagated in workflows).
    //  - "workspace": ephemeral record registered by the workspace tool purely so file tools
    //                 (readFile/editFile/writeFile/localGrep) can access the git worktree path.
    //                 These folders must NEVER trigger sync notifications, background syncs,
    //                 workflow propagation, or appear in the Vector DB sync status UI.
    source: text("source", { enum: ["user", "workspace"] })
      .default("user")
      .notNull(),
    createdAt: text("created_at").default(sql`(datetime('now'))`).notNull(),
    updatedAt: text("updated_at").default(sql`(datetime('now'))`).notNull(),
  },
  (table) => ({
    userIdx: index("agent_sync_folders_user_idx").on(table.userId),
    characterIdx: index("agent_sync_folders_character_idx").on(table.characterId),
    primaryIdx: index("agent_sync_folders_primary_idx").on(table.characterId, table.isPrimary),
    inheritedWorkflowIdx: index("agent_sync_folders_inherited_workflow_idx").on(table.inheritedFromWorkflowId),
  })
);

// ============================================================================
// AGENT SYNC FILES TABLE
// ============================================================================

export const agentSyncFiles = sqliteTable("agent_sync_files", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  folderId: text("folder_id")
    .references(() => agentSyncFolders.id, { onDelete: "cascade" })
    .notNull(),
  characterId: text("character_id")
    .references(() => characters.id, { onDelete: "cascade" })
    .notNull(),
  filePath: text("file_path").notNull(),
  relativePath: text("relative_path").notNull(),
  contentHash: text("content_hash"),
  sizeBytes: integer("size_bytes"),
  modifiedAt: text("modified_at"),
  status: text("status", { enum: ["pending", "indexed", "error"] }).default("pending").notNull(),
  vectorPointIds: text("vector_point_ids", { mode: "json" }).default("[]"),
  chunkCount: integer("chunk_count").default(0),
  lastIndexedAt: text("last_indexed_at"),
  createdAt: text("created_at").default(sql`(datetime('now'))`).notNull(),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`).notNull(),
});

// ============================================================================
// CHANNEL CONNECTIONS TABLE
// ============================================================================

export const channelConnections = sqliteTable(
  "channel_connections",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    characterId: text("character_id")
      .references(() => characters.id, { onDelete: "cascade" })
      .notNull(),
    channelType: text("channel_type", { enum: ["whatsapp", "telegram", "slack", "discord"] }).notNull(),
    displayName: text("display_name"),
    config: text("config", { mode: "json" }).default("{}").notNull(),
    status: text("status", { enum: ["disconnected", "connecting", "connected", "error"] })
      .default("disconnected")
      .notNull(),
    lastError: text("last_error"),
    createdAt: text("created_at").default(sql`(datetime('now'))`).notNull(),
    updatedAt: text("updated_at").default(sql`(datetime('now'))`).notNull(),
  },
  (table) => ({
    userIdx: index("channel_connections_user_idx").on(table.userId),
    characterIdx: index("channel_connections_character_idx").on(table.characterId),
    typeIdx: index("channel_connections_type_idx").on(table.channelType),
  })
);

// ============================================================================
// CHANNEL CONVERSATIONS TABLE
// ============================================================================

export const channelConversations = sqliteTable(
  "channel_conversations",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    connectionId: text("connection_id")
      .references(() => channelConnections.id, { onDelete: "cascade" })
      .notNull(),
    characterId: text("character_id")
      .references(() => characters.id, { onDelete: "cascade" })
      .notNull(),
    channelType: text("channel_type", { enum: ["whatsapp", "telegram", "slack", "discord"] }).notNull(),
    peerId: text("peer_id").notNull(),
    peerName: text("peer_name"),
    threadId: text("thread_id"),
    sessionId: text("session_id")
      .references(() => sessions.id, { onDelete: "cascade" })
      .notNull(),
    lastMessageAt: text("last_message_at"),
    createdAt: text("created_at").default(sql`(datetime('now'))`).notNull(),
    updatedAt: text("updated_at").default(sql`(datetime('now'))`).notNull(),
  },
  (table) => ({
    connectionIdx: index("channel_conversations_connection_idx").on(table.connectionId),
    characterIdx: index("channel_conversations_character_idx").on(table.characterId),
    peerIdx: index("channel_conversations_peer_idx").on(table.channelType, table.peerId, table.threadId),
    sessionIdx: index("channel_conversations_session_idx").on(table.sessionId),
  })
);

// ============================================================================
// CHANNEL MESSAGE MAP TABLE
// ============================================================================

export const channelMessages = sqliteTable(
  "channel_messages",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    connectionId: text("connection_id")
      .references(() => channelConnections.id, { onDelete: "cascade" })
      .notNull(),
    channelType: text("channel_type", { enum: ["whatsapp", "telegram", "slack", "discord"] }).notNull(),
    externalMessageId: text("external_message_id").notNull(),
    sessionId: text("session_id")
      .references(() => sessions.id, { onDelete: "cascade" })
      .notNull(),
    messageId: text("message_id")
      .references(() => messages.id, { onDelete: "cascade" })
      .notNull(),
    direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
    createdAt: text("created_at").default(sql`(datetime('now'))`).notNull(),
  },
  (table) => ({
    connectionIdx: index("channel_messages_connection_idx").on(table.connectionId),
    externalIdx: index("channel_messages_external_idx").on(table.channelType, table.externalMessageId, table.direction),
    sessionIdx: index("channel_messages_session_idx").on(table.sessionId),
    // At most one outbound record per internal message (outbox dedup invariant).
    outboundMessageIdx: uniqueIndex("idx_channel_messages_outbound_message_uidx")
      .on(table.messageId)
      .where(sql`direction = 'outbound'`),
  })
);

// ============================================================================
// CHANNEL OUTBOX TABLE
// ============================================================================
// Durable delivery queue for outbound channel replies. Final assistant
// responses are enqueued here before delivery so that a failed/timed-out
// send (e.g. after a 30-40 minute agent run) can be retried by the outbox
// worker instead of being silently dropped.

export const channelOutbox = sqliteTable(
  "channel_outbox",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    sessionId: text("session_id")
      .references(() => sessions.id, { onDelete: "cascade" })
      .notNull(),
    messageId: text("message_id")
      .references(() => messages.id, { onDelete: "cascade" })
      .notNull(),
    rawMode: integer("raw_mode", { mode: "boolean" }).default(false).notNull(),
    status: text("status", { enum: ["pending", "delivering", "delivered", "failed"] })
      .default("pending")
      .notNull(),
    attempts: integer("attempts").default(0).notNull(),
    lastError: text("last_error"),
    nextAttemptAt: text("next_attempt_at"),
    deliveredAt: text("delivered_at"),
    createdAt: text("created_at").default(sql`(datetime('now'))`).notNull(),
    updatedAt: text("updated_at").default(sql`(datetime('now'))`).notNull(),
  },
  (table) => ({
    statusIdx: index("channel_outbox_status_idx").on(table.status, table.nextAttemptAt),
    statusUpdatedIdx: index("channel_outbox_status_updated_idx").on(table.status, table.updatedAt),
    // One logical delivery per final message — makes enqueue idempotent.
    messageIdx: uniqueIndex("channel_outbox_message_uidx").on(table.messageId),
  })
);

// ============================================================================
// RELATIONS
// ============================================================================

export const charactersRelations = relations(characters, ({ one, many }) => ({
  user: one(users, {
    fields: [characters.userId],
    references: [users.id],
  }),
  images: many(characterImages),
}));

export const characterImagesRelations = relations(characterImages, ({ one }) => ({
  character: one(characters, {
    fields: [characterImages.characterId],
    references: [characters.id],
  }),
}));

export const agentSyncFoldersRelations = relations(agentSyncFolders, ({ one, many }) => ({
  user: one(users, {
    fields: [agentSyncFolders.userId],
    references: [users.id],
  }),
  character: one(characters, {
    fields: [agentSyncFolders.characterId],
    references: [characters.id],
  }),
  files: many(agentSyncFiles),
}));

export const agentSyncFilesRelations = relations(agentSyncFiles, ({ one }) => ({
  folder: one(agentSyncFolders, {
    fields: [agentSyncFiles.folderId],
    references: [agentSyncFolders.id],
  }),
  character: one(characters, {
    fields: [agentSyncFiles.characterId],
    references: [characters.id],
  }),
}));

export const channelConnectionsRelations = relations(channelConnections, ({ one, many }) => ({
  user: one(users, {
    fields: [channelConnections.userId],
    references: [users.id],
  }),
  character: one(characters, {
    fields: [channelConnections.characterId],
    references: [characters.id],
  }),
  conversations: many(channelConversations),
  messages: many(channelMessages),
}));

export const channelConversationsRelations = relations(channelConversations, ({ one, many }) => ({
  connection: one(channelConnections, {
    fields: [channelConversations.connectionId],
    references: [channelConnections.id],
  }),
  character: one(characters, {
    fields: [channelConversations.characterId],
    references: [characters.id],
  }),
  session: one(sessions, {
    fields: [channelConversations.sessionId],
    references: [sessions.id],
  }),
  messages: many(channelMessages),
}));

export const channelMessagesRelations = relations(channelMessages, ({ one }) => ({
  connection: one(channelConnections, {
    fields: [channelMessages.connectionId],
    references: [channelConnections.id],
  }),
  session: one(sessions, {
    fields: [channelMessages.sessionId],
    references: [sessions.id],
  }),
  message: one(messages, {
    fields: [channelMessages.messageId],
    references: [messages.id],
  }),
}));

// ============================================================================
// TYPES
// ============================================================================

export type Character = typeof characters.$inferSelect;
export type NewCharacter = typeof characters.$inferInsert;
export type CharacterImage = typeof characterImages.$inferSelect;
export type NewCharacterImage = typeof characterImages.$inferInsert;

export type AgentSyncFolder = typeof agentSyncFolders.$inferSelect;
export type NewAgentSyncFolder = typeof agentSyncFolders.$inferInsert;
export type AgentSyncFile = typeof agentSyncFiles.$inferSelect;
export type NewAgentSyncFile = typeof agentSyncFiles.$inferInsert;

export type ChannelConnection = typeof channelConnections.$inferSelect;
export type NewChannelConnection = typeof channelConnections.$inferInsert;
export type ChannelConversation = typeof channelConversations.$inferSelect;
export type NewChannelConversation = typeof channelConversations.$inferInsert;
export type ChannelMessage = typeof channelMessages.$inferSelect;
export type NewChannelMessage = typeof channelMessages.$inferInsert;
export type ChannelOutboxEntry = typeof channelOutbox.$inferSelect;
export type NewChannelOutboxEntry = typeof channelOutbox.$inferInsert;

export interface CharacterFull extends Character {
  images: CharacterImage[];
}

export type CharacterStatus = "draft" | "active" | "archived";
export type CharacterImageType = "portrait" | "full_body" | "expression" | "outfit" | "scene" | "avatar";
