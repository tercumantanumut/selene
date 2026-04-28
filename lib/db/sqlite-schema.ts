// Re-export all base tables, relations, and types
export * from "./sqlite-schema-base";

// Re-export character schema
export * from "./sqlite-character-schema";

// Re-export observability schema (agent runs, events, prompt versioning)
export * from "./sqlite-observability-schema";

// Re-export schedule schema (scheduled tasks and runs)
export * from "./sqlite-schedule-schema";

// Re-export skills schema
export * from "./sqlite-skills-schema";

// Re-export plugins schema
export * from "./sqlite-plugins-schema";

// Re-export workflows schema
export * from "./sqlite-workflows-schema";

// Re-export voice schema
export * from "./sqlite-voice-schema";

// Re-export design gallery schema
export * from "./schema/design-gallery";

// Re-export design snapshots schema (persisted iteration memory — separate
// from the transient Zustand DesignSnapshot declared in
// lib/design/workspace/types.ts)
export * from "./schema/design-snapshots";
