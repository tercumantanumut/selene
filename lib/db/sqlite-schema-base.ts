import {
  sqliteTable,
  text,
  integer,
  real,
  blob,
  index,
} from "drizzle-orm/sqlite-core";
import { relations, sql } from "drizzle-orm";

// Helper for UUID generation (SQLite doesn't have native UUID)
const uuidDefault = sql`(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))))`;

// Helper for timestamp default
const timestampDefault = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

// ============================================================================
// USERS TABLE
// ============================================================================

export const users = sqliteTable("users", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  externalId: text("external_id"),
  email: text("email").unique().notNull(),
  passwordHash: text("password_hash"),
  createdAt: text("created_at").default(sql`(datetime('now'))`).notNull(),
});

// ============================================================================
// SESSIONS TABLE
// ============================================================================

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").references(() => users.id),
    title: text("title"),
    status: text("status", { enum: ["active", "archived", "deleted"] }).default("active").notNull(),
    providerSessionId: text("provider_session_id"),
    summary: text("summary"),
    summaryUpToMessageId: text("summary_up_to_message_id"),
    characterId: text("character_id"),
    messageCount: integer("message_count").default(0).notNull(),
    totalTokenCount: integer("total_token_count").default(0).notNull(),
    lastMessageAt: text("last_message_at"),
    // NEW: Atomic ordering index counter for bullet-proof message ordering
    lastOrderingIndex: integer("last_ordering_index").default(0).notNull(),
    channelType: text("channel_type", { enum: ["whatsapp", "telegram", "slack", "discord"] }),
    // Sprint 4 W4.3 — persists the design workspace's "currently focused"
    // component across session restart. Nullable by design; FK +
    // ON DELETE SET NULL are declared in SQL by
    // `initSessionLastActiveComponentWith` (we keep drizzle schema FK-free
    // here to avoid a circular import with `./schema/design-gallery.ts`).
    lastActiveComponentId: text("last_active_component_id"),
    createdAt: text("created_at").default(sql`(datetime('now'))`).notNull(),
    updatedAt: text("updated_at").default(sql`(datetime('now'))`).notNull(),
    metadata: text("metadata", { mode: "json" }).default("{}").notNull(),
  },
  (table) => ({
    idxSessionsUserCharacter: index("idx_sessions_user_character").on(table.userId, table.characterId, table.status),
    idxSessionsUserUpdated: index("idx_sessions_user_updated").on(table.userId, table.updatedAt),
    idxSessionsCharacterUpdated: index("idx_sessions_character_updated").on(table.characterId, table.updatedAt),
  })
);

// ============================================================================
// MESSAGES TABLE
// ============================================================================

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    sessionId: text("session_id")
      .references(() => sessions.id, { onDelete: "cascade" })
      .notNull(),
    parentId: text("parent_id"),
    role: text("role", { enum: ["system", "user", "assistant", "tool"] }).notNull(),
    content: text("content", { mode: "json" }).notNull(),
    model: text("model"),
    toolName: text("tool_name"),
    toolCallId: text("tool_call_id"),
    isCompacted: integer("is_compacted", { mode: "boolean" }).default(false).notNull(),
    tokenCount: integer("token_count"),
    // NEW: Explicit ordering index for bullet-proof ordering (nullable for migration)
    orderingIndex: integer("ordering_index"),
    createdAt: text("created_at").default(sql`(datetime('now'))`).notNull(),
    metadata: text("metadata", { mode: "json" }).default("{}").notNull(),
    // Set on every insert/update so pollers can fetch only changed rows.
    // NULL on rows written before the column existed.
    updatedAt: text("updated_at")
      .$defaultFn(() => new Date().toISOString())
      .$onUpdateFn(() => new Date().toISOString()),
  },
  (table) => ({
    // NEW: Index for fast ordered retrieval
    idxMessagesSessionOrdering: index("idx_messages_session_ordering").on(table.sessionId, table.orderingIndex),
    idxMessagesSessionUpdated: index("idx_messages_session_updated").on(table.sessionId, table.updatedAt),
  })
);

// ============================================================================
// TOOL RUNS TABLE
// ============================================================================

export const toolRuns = sqliteTable("tool_runs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  sessionId: text("session_id")
    .references(() => sessions.id, { onDelete: "cascade" })
    .notNull(),
  messageId: text("message_id").references(() => messages.id),
  toolName: text("tool_name").notNull(),
  args: text("args", { mode: "json" }).notNull(),
  result: text("result", { mode: "json" }),
  status: text("status", { enum: ["pending", "running", "succeeded", "failed", "cancelled"] }).default("pending").notNull(),
  error: text("error"),
  startedAt: text("started_at").default(sql`(datetime('now'))`).notNull(),
  completedAt: text("completed_at"),
  metadata: text("metadata", { mode: "json" }).default("{}").notNull(),
});

// ============================================================================
// WEB BROWSE ENTRIES TABLE
// ============================================================================

export const webBrowseEntries = sqliteTable("web_browse_entries", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  sessionId: text("session_id")
    .references(() => sessions.id, { onDelete: "cascade" })
    .notNull(),
  url: text("url").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  contentLength: integer("content_length").notNull(),
  images: text("images", { mode: "json" }).default("[]").notNull(),
  ogImage: text("og_image"),
  fetchedAt: text("fetched_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});

// ============================================================================
// TRUNCATED CONTENT TABLE
// ============================================================================
//
// Persistent backing store for `storeFullContent` / `retrieveFullContent`.
// When a tool result is truncated for the model's context window, the full
// payload lands here keyed by a `trunc_XXX` id. The row is FK-scoped to the
// session so it cascades on session delete and survives Electron restart,
// crash-recovery, etc. — the previous in-memory Map lost every contentId on
// process exit, breaking mid-task resume.
//
// TTL-bounded: a periodic sweep deletes rows past `expires_at`. No per-session
// cap — TTL (1h default) plus cascade delete already bound growth.

export const truncatedContent = sqliteTable(
  "truncated_content",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .references(() => sessions.id, { onDelete: "cascade" })
      .notNull(),
    context: text("context").notNull(),
    fullContent: text("full_content").notNull(),
    fullLength: integer("full_length").notNull(),
    truncatedLength: integer("truncated_length").notNull(),
    storedAt: integer("stored_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => ({
    idxTruncatedContentSession: index("idx_truncated_content_session").on(
      table.sessionId,
      table.expiresAt,
    ),
    idxTruncatedContentExpires: index("idx_truncated_content_expires").on(
      table.expiresAt,
    ),
  }),
);

// ============================================================================
// IMAGES TABLE
// ============================================================================

export const images = sqliteTable("images", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  sessionId: text("session_id")
    .references(() => sessions.id, { onDelete: "cascade" })
    .notNull(),
  messageId: text("message_id").references(() => messages.id),
  toolRunId: text("tool_run_id").references(() => toolRuns.id),
  role: text("role", { enum: ["upload", "reference", "generated", "mask", "tile"] }).notNull(),
  localPath: text("local_path").notNull(), // Changed from s3Key - local file path
  url: text("url").notNull(), // Will be file:// URL for local files
  width: integer("width"),
  height: integer("height"),
  format: text("format"),
  createdAt: text("created_at").default(sql`(datetime('now'))`).notNull(),
  metadata: text("metadata", { mode: "json" }).default("{}").notNull(),
});

// ============================================================================
// RELATIONS
// ============================================================================

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
}));

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
  messages: many(messages),
  toolRuns: many(toolRuns),
  webBrowseEntries: many(webBrowseEntries),
  images: many(images),
}));

export const messagesRelations = relations(messages, ({ one, many }) => ({
  session: one(sessions, {
    fields: [messages.sessionId],
    references: [sessions.id],
  }),
  parent: one(messages, {
    fields: [messages.parentId],
    references: [messages.id],
    relationName: "message_parent",
  }),
  children: many(messages, { relationName: "message_parent" }),
  toolRuns: many(toolRuns),
  images: many(images),
}));

export const toolRunsRelations = relations(toolRuns, ({ one, many }) => ({
  session: one(sessions, {
    fields: [toolRuns.sessionId],
    references: [sessions.id],
  }),
  message: one(messages, {
    fields: [toolRuns.messageId],
    references: [messages.id],
  }),
  images: many(images),
}));

export const webBrowseEntriesRelations = relations(webBrowseEntries, ({ one }) => ({
  session: one(sessions, {
    fields: [webBrowseEntries.sessionId],
    references: [sessions.id],
  }),
}));

export const imagesRelations = relations(images, ({ one }) => ({
  session: one(sessions, {
    fields: [images.sessionId],
    references: [sessions.id],
  }),
  message: one(messages, {
    fields: [images.messageId],
    references: [messages.id],
  }),
  toolRun: one(toolRuns, {
    fields: [images.toolRunId],
    references: [toolRuns.id],
  }),
}));

// ============================================================================
// TYPES
// ============================================================================

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type ToolRun = typeof toolRuns.$inferSelect;
export type NewToolRun = typeof toolRuns.$inferInsert;
export type WebBrowseEntry = typeof webBrowseEntries.$inferSelect;
export type NewWebBrowseEntry = typeof webBrowseEntries.$inferInsert;
export type Image = typeof images.$inferSelect;
export type NewImage = typeof images.$inferInsert;
export type TruncatedContentRow = typeof truncatedContent.$inferSelect;
export type NewTruncatedContentRow = typeof truncatedContent.$inferInsert;
