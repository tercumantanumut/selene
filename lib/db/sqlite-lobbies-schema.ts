import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  primaryKey,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import { relations, sql } from "drizzle-orm";
import { users, sessions } from "./sqlite-schema-base";
import { characters } from "./sqlite-character-schema";
import { agentRuns } from "./sqlite-observability-schema";
import type {
  LobbyCardAcceptanceCriterionV1,
  LobbyCardColumn,
  LobbyCardCreator,
  LobbyCardOutputV1,
  LobbyCardStatus,
  LobbyConfigV1,
  LobbyEventActor,
  LobbyPermissionScopeV1,
  LobbySeatStatus,
  LobbyStatus,
  LobbyTemplateSeatV1,
  LobbyTemplateVisibility,
} from "../lobbies/types";

const lobbyStatuses = ["roster", "planning", "rolling", "review", "completed", "aborted"] as [
  LobbyStatus,
  ...LobbyStatus[],
];
const lobbyTemplateVisibilities = ["private", "public"] as [
  LobbyTemplateVisibility,
  ...LobbyTemplateVisibility[],
];
const lobbySeatStatuses = ["empty", "ready", "busy", "idle"] as [LobbySeatStatus, ...LobbySeatStatus[]];
const lobbyCardColumns = ["backlog", "ready", "in_progress", "review", "done", "blocked"] as [
  LobbyCardColumn,
  ...LobbyCardColumn[],
];
const lobbyCardStatuses = [
  "pending",
  "running",
  "awaiting_review",
  "approved",
  "rejected",
  "failed",
  "cancelled",
] as [LobbyCardStatus, ...LobbyCardStatus[]];
const lobbyCardCreators = ["planner", "human"] as [LobbyCardCreator, ...LobbyCardCreator[]];
const lobbyEventActors = ["captain", "agent", "system"] as [LobbyEventActor, ...LobbyEventActor[]];

export const lobbyTemplates = sqliteTable(
  "lobby_templates",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    description: text("description"),
    defaultSeats: text("default_seats", { mode: "json" }).$type<LobbyTemplateSeatV1[]>().default([]).notNull(),
    planningPrompt: text("planning_prompt").notNull(),
    synthesisPrompt: text("synthesis_prompt").notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    visibility: text("visibility", { enum: lobbyTemplateVisibilities }).default("private").notNull(),
    config: text("config", { mode: "json" }).$type<Partial<LobbyConfigV1>>().default({}).notNull(),
    createdAt: text("created_at").default(sql`(datetime('now'))`).notNull(),
    updatedAt: text("updated_at").default(sql`(datetime('now'))`).notNull(),
  },
  (table) => ({
    userVisibilityIdx: index("idx_lobby_templates_user_visibility").on(table.userId, table.visibility),
  })
);

export const lobbies = sqliteTable(
  "lobbies",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "cascade" }).notNull(),
    title: text("title").notNull(),
    goal: text("goal").notNull(),
    status: text("status", { enum: lobbyStatuses }).default("roster").notNull(),
    templateId: text("template_id").references(() => lobbyTemplates.id, { onDelete: "set null" }),
    planningRunId: text("planning_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    synthesisRunId: text("synthesis_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    outputArtifactId: text("output_artifact_id"),
    config: text("config", { mode: "json" }).$type<LobbyConfigV1>().default({ version: 1 }).notNull(),
    lockVersion: integer("lock_version").default(0).notNull(),
    eventSequence: integer("event_sequence").default(0).notNull(),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    abortedAt: text("aborted_at"),
    createdAt: text("created_at").default(sql`(datetime('now'))`).notNull(),
    updatedAt: text("updated_at").default(sql`(datetime('now'))`).notNull(),
  },
  (table) => ({
    userStatusUpdatedIdx: index("idx_lobbies_user_status_updated").on(table.userId, table.status, table.updatedAt),
    templateIdx: index("idx_lobbies_template").on(table.templateId),
    planningRunIdx: index("idx_lobbies_planning_run").on(table.planningRunId),
    synthesisRunIdx: index("idx_lobbies_synthesis_run").on(table.synthesisRunId),
    sessionIdx: uniqueIndex("idx_lobbies_session").on(table.sessionId),
  })
);

export const lobbySeats = sqliteTable(
  "lobby_seats",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    lobbyId: text("lobby_id").references(() => lobbies.id, { onDelete: "cascade" }).notNull(),
    role: text("role").notNull(),
    agentId: text("agent_id").references(() => characters.id, { onDelete: "restrict" }),
    permissionScope: text("permission_scope", { mode: "json" })
      .$type<LobbyPermissionScopeV1>()
      .default({ version: 1, mode: "tool_list", allowedTools: [] })
      .notNull(),
    position: integer("position").notNull(),
    status: text("status", { enum: lobbySeatStatuses }).default("empty").notNull(),
    lockVersion: integer("lock_version").default(0).notNull(),
    createdAt: text("created_at").default(sql`(datetime('now'))`).notNull(),
    updatedAt: text("updated_at").default(sql`(datetime('now'))`).notNull(),
  },
  (table) => ({
    lobbyPositionIdx: uniqueIndex("idx_lobby_seats_lobby_position").on(table.lobbyId, table.position),
    lobbyAgentIdx: uniqueIndex("idx_lobby_seats_lobby_agent")
      .on(table.lobbyId, table.agentId)
      .where(sql`${table.agentId} IS NOT NULL`),
    lobbyIdx: index("idx_lobby_seats_lobby").on(table.lobbyId),
    agentIdx: index("idx_lobby_seats_agent").on(table.agentId),
  })
);

export const lobbyCards = sqliteTable(
  "lobby_cards",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    lobbyId: text("lobby_id").references(() => lobbies.id, { onDelete: "cascade" }).notNull(),
    column: text("column", { enum: lobbyCardColumns }).default("backlog").notNull(),
    title: text("title").notNull(),
    description: text("description").default("").notNull(),
    acceptanceCriteria: text("acceptance_criteria", { mode: "json" })
      .$type<LobbyCardAcceptanceCriterionV1[]>()
      .default([])
      .notNull(),
    assignedSeatId: text("assigned_seat_id").references(() => lobbySeats.id, { onDelete: "restrict" }),
    position: integer("position").default(0).notNull(),
    status: text("status", { enum: lobbyCardStatuses }).default("pending").notNull(),
    agentRunId: text("agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    output: text("output", { mode: "json" }).$type<LobbyCardOutputV1>(),
    failureReason: text("failure_reason"),
    reviewNotes: text("review_notes"),
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    attemptCount: integer("attempt_count").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(3).notNull(),
    lockVersion: integer("lock_version").default(0).notNull(),
    createdBy: text("created_by", { enum: lobbyCardCreators }).notNull(),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    reviewedAt: text("reviewed_at"),
    createdAt: text("created_at").default(sql`(datetime('now'))`).notNull(),
    updatedAt: text("updated_at").default(sql`(datetime('now'))`).notNull(),
  },
  (table) => ({
    lobbyColumnPositionIdx: index("idx_lobby_cards_lobby_column_position").on(
      table.lobbyId,
      table.column,
      table.position
    ),
    lobbyStatusIdx: index("idx_lobby_cards_lobby_status").on(table.lobbyId, table.status),
    assignedSeatStatusIdx: index("idx_lobby_cards_assigned_seat_status").on(table.assignedSeatId, table.status),
    agentRunIdx: index("idx_lobby_cards_agent_run").on(table.agentRunId),
  })
);

export const lobbyCardDependencies = sqliteTable(
  "lobby_card_dependencies",
  {
    lobbyId: text("lobby_id").references(() => lobbies.id, { onDelete: "cascade" }).notNull(),
    cardId: text("card_id").references(() => lobbyCards.id, { onDelete: "cascade" }).notNull(),
    dependsOnCardId: text("depends_on_card_id")
      .references((): AnySQLiteColumn => lobbyCards.id, { onDelete: "cascade" })
      .notNull(),
    optional: integer("optional", { mode: "boolean" }).default(false).notNull(),
    createdAt: text("created_at").default(sql`(datetime('now'))`).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.lobbyId, table.cardId, table.dependsOnCardId] }),
    lobbyDependsOnIdx: index("idx_lobby_card_dependencies_lobby_depends_on").on(
      table.lobbyId,
      table.dependsOnCardId
    ),
    lobbyCardIdx: index("idx_lobby_card_dependencies_lobby_card").on(table.lobbyId, table.cardId),
  })
);

export const lobbyEvents = sqliteTable(
  "lobby_events",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    lobbyId: text("lobby_id").references(() => lobbies.id, { onDelete: "cascade" }).notNull(),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).default({}).notNull(),
    actor: text("actor", { enum: lobbyEventActors }).notNull(),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorAgentId: text("actor_agent_id").references(() => characters.id, { onDelete: "set null" }),
    cardId: text("card_id").references(() => lobbyCards.id, { onDelete: "set null" }),
    seatId: text("seat_id").references(() => lobbySeats.id, { onDelete: "set null" }),
    agentRunId: text("agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    createdAt: text("created_at").default(sql`(datetime('now'))`).notNull(),
  },
  (table) => ({
    lobbySequenceIdx: uniqueIndex("idx_lobby_events_lobby_sequence").on(table.lobbyId, table.sequence),
    lobbyCreatedIdx: index("idx_lobby_events_lobby_created").on(table.lobbyId, table.createdAt),
    lobbyTypeIdx: index("idx_lobby_events_lobby_type").on(table.lobbyId, table.type),
    cardIdx: index("idx_lobby_events_card").on(table.cardId),
    agentRunIdx: index("idx_lobby_events_agent_run").on(table.agentRunId),
  })
);

export const lobbyTemplatesRelations = relations(lobbyTemplates, ({ one, many }) => ({
  user: one(users, {
    fields: [lobbyTemplates.userId],
    references: [users.id],
  }),
  lobbies: many(lobbies),
}));

export const lobbiesRelations = relations(lobbies, ({ one, many }) => ({
  captain: one(users, {
    fields: [lobbies.userId],
    references: [users.id],
  }),
  session: one(sessions, {
    fields: [lobbies.sessionId],
    references: [sessions.id],
  }),
  template: one(lobbyTemplates, {
    fields: [lobbies.templateId],
    references: [lobbyTemplates.id],
  }),
  planningRun: one(agentRuns, {
    fields: [lobbies.planningRunId],
    references: [agentRuns.id],
    relationName: "lobbies_planning_run",
  }),
  synthesisRun: one(agentRuns, {
    fields: [lobbies.synthesisRunId],
    references: [agentRuns.id],
    relationName: "lobbies_synthesis_run",
  }),
  seats: many(lobbySeats),
  cards: many(lobbyCards),
  events: many(lobbyEvents),
}));

export const lobbySeatsRelations = relations(lobbySeats, ({ one, many }) => ({
  lobby: one(lobbies, {
    fields: [lobbySeats.lobbyId],
    references: [lobbies.id],
  }),
  assignedCharacter: one(characters, {
    fields: [lobbySeats.agentId],
    references: [characters.id],
  }),
  assignedCards: many(lobbyCards),
  events: many(lobbyEvents),
}));

export const lobbyCardsRelations = relations(lobbyCards, ({ one, many }) => ({
  lobby: one(lobbies, {
    fields: [lobbyCards.lobbyId],
    references: [lobbies.id],
  }),
  assignedSeat: one(lobbySeats, {
    fields: [lobbyCards.assignedSeatId],
    references: [lobbySeats.id],
  }),
  agentRun: one(agentRuns, {
    fields: [lobbyCards.agentRunId],
    references: [agentRuns.id],
  }),
  reviewedBy: one(users, {
    fields: [lobbyCards.reviewedByUserId],
    references: [users.id],
  }),
  dependencies: many(lobbyCardDependencies, {
    relationName: "lobby_card_dependencies_card",
  }),
  dependents: many(lobbyCardDependencies, {
    relationName: "lobby_card_dependencies_depends_on",
  }),
  events: many(lobbyEvents),
}));

export const lobbyCardDependenciesRelations = relations(lobbyCardDependencies, ({ one }) => ({
  lobby: one(lobbies, {
    fields: [lobbyCardDependencies.lobbyId],
    references: [lobbies.id],
  }),
  card: one(lobbyCards, {
    fields: [lobbyCardDependencies.cardId],
    references: [lobbyCards.id],
    relationName: "lobby_card_dependencies_card",
  }),
  dependsOnCard: one(lobbyCards, {
    fields: [lobbyCardDependencies.dependsOnCardId],
    references: [lobbyCards.id],
    relationName: "lobby_card_dependencies_depends_on",
  }),
}));

export const lobbyEventsRelations = relations(lobbyEvents, ({ one }) => ({
  lobby: one(lobbies, {
    fields: [lobbyEvents.lobbyId],
    references: [lobbies.id],
  }),
  actorUser: one(users, {
    fields: [lobbyEvents.actorUserId],
    references: [users.id],
  }),
  actorAgent: one(characters, {
    fields: [lobbyEvents.actorAgentId],
    references: [characters.id],
  }),
  card: one(lobbyCards, {
    fields: [lobbyEvents.cardId],
    references: [lobbyCards.id],
  }),
  seat: one(lobbySeats, {
    fields: [lobbyEvents.seatId],
    references: [lobbySeats.id],
  }),
  agentRun: one(agentRuns, {
    fields: [lobbyEvents.agentRunId],
    references: [agentRuns.id],
  }),
}));

export type LobbyTemplate = typeof lobbyTemplates.$inferSelect;
export type NewLobbyTemplate = typeof lobbyTemplates.$inferInsert;
export type Lobby = typeof lobbies.$inferSelect;
export type NewLobby = typeof lobbies.$inferInsert;
export type LobbySeat = typeof lobbySeats.$inferSelect;
export type NewLobbySeat = typeof lobbySeats.$inferInsert;
export type LobbyCard = typeof lobbyCards.$inferSelect;
export type NewLobbyCard = typeof lobbyCards.$inferInsert;
export type LobbyCardDependency = typeof lobbyCardDependencies.$inferSelect;
export type NewLobbyCardDependency = typeof lobbyCardDependencies.$inferInsert;
export type LobbyEvent = typeof lobbyEvents.$inferSelect;
export type NewLobbyEvent = typeof lobbyEvents.$inferInsert;
