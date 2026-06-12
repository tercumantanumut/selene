import { db } from "@/lib/db/sqlite-client";
import { designComponents } from "@/lib/db/schema/design-gallery";
import { eq, desc, and, sql, type SQL } from "drizzle-orm";
import type {
  NewDesignComponent,
  DesignComponentRow,
  DesignComponentMetadata,
  DesignComponentSummaryRow,
  GallerySearchOpts,
  ScopedDesignListOpts,
} from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a raw DB row into the application-facing shape. */
function toRow(row: typeof designComponents.$inferSelect): DesignComponentRow {
  return {
    ...row,
    tags: safeParseTags(row.tags),
    styleTags: safeParseTags(row.styleTags),
    isFavorite: Boolean(row.isFavorite),
    metadata: safeParseMetadata(row.metadata ?? null),
  };
}

function safeParseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Defensive parser for the `metadata` JSON column.
 *
 * The column is nullable (added via additive migration — see
 * lib/db/migrations/design-gallery-tables.ts) so rows persisted before the
 * W2.1 migration return `null`. Invalid JSON also falls back to `null` so a
 * corrupt row does not crash the list/find call.
 */
function safeParseMetadata(raw: string | null): DesignComponentMetadata | null {
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as DesignComponentMetadata;
    }
    return null;
  } catch {
    return null;
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function now(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 23);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** Save a new component to the gallery. */
export async function saveDesignComponent(
  component: NewDesignComponent
): Promise<DesignComponentRow> {
  const id = component.id ?? crypto.randomUUID();
  const ts = now();

  const [inserted] = await db
    .insert(designComponents)
    .values({
      id,
      userId: component.userId,
      characterId: component.characterId ?? null,
      sessionId: component.sessionId ?? null,
      projectId: component.projectId ?? null,
      name: component.name,
      description: component.description ?? null,
      prompt: component.prompt,
      code: component.code,
      framework: component.framework ?? "html-css",
      category: component.category ?? "general",
      tags: JSON.stringify(component.tags ?? []),
      styleTags: JSON.stringify(component.styleTags ?? []),
      previewPath: component.previewPath ?? null,
      mode: component.mode ?? "tailwind",
      style: component.style ?? "default",
      metadata: component.metadata ? JSON.stringify(component.metadata) : null,
      createdAt: ts,
      updatedAt: ts,
    })
    .returning();

  return toRow(inserted);
}

/** Get a single component by ID, scoped to the owning user. */
export async function getDesignComponent(
  userId: string,
  id: string
): Promise<DesignComponentRow | null> {
  const row = await db.query.designComponents.findFirst({
    where: and(eq(designComponents.userId, userId), eq(designComponents.id, id)),
  });
  return row ? toRow(row) : null;
}

/**
 * Find an existing component that was previously imported from the given
 * synced-folder path, scoped to (userId, sessionId). Used by the design
 * workspace "import" action so repeated imports of the same file update the
 * same row rather than cluttering the gallery with duplicates.
 *
 * Uses `json_extract` against the `metadata` column — `metadata` was added in
 * Sprint 2 W2.1 via an additive migration (see migrations/design-gallery-
 * tables.ts). Rows with `metadata IS NULL` are naturally excluded.
 */
async function findDesignComponentBySourcePath(opts: {
  userId: string;
  sessionId?: string;
  sourcePath: string;
}): Promise<DesignComponentRow | null> {
  const conditions: SQL[] = [
    eq(designComponents.userId, opts.userId),
    sql`json_extract(${designComponents.metadata}, '$.sourcePath') = ${opts.sourcePath}`,
  ];
  if (opts.sessionId) {
    conditions.push(eq(designComponents.sessionId, opts.sessionId));
  }

  const row = await db.query.designComponents.findFirst({
    where: and(...conditions),
    orderBy: [desc(designComponents.updatedAt)],
  });

  return row ? toRow(row) : null;
}

// ---------------------------------------------------------------------------
// BA-2 / BA-warn-6 — transactional import upsert.
//
// The "import" action had a TOCTOU race: the handler called
// `findDesignComponentBySourcePath`, branched on the result, then did either
// an INSERT or an UPDATE. Two concurrent imports of the same file could BOTH
// see "no existing row" and BOTH insert, producing duplicate rows keyed on
// the same (userId, sessionId, sourcePath) triple.
//
// `upsertImportedDesignComponent` closes the race by running the
// find + insert/update inside a better-sqlite3 transaction AND retrying the
// lookup on a SQLITE_CONSTRAINT_UNIQUE violation (which the partial unique
// index `idx_design_components_source_path_unique` triggers when a concurrent
// writer beat us to the insert). Drizzle's `db.transaction()` on a
// better-sqlite3 driver runs the callback synchronously inside a BEGIN /
// COMMIT block — the `await` below is a no-op at runtime but keeps the
// signature async-friendly for the tool handler.
// ---------------------------------------------------------------------------

export interface UpsertImportedDesignInput {
  userId: string;
  characterId?: string | null;
  sessionId?: string | null;
  projectId?: string | null;
  name: string;
  prompt: string;
  code: string;
  mode?: string;
  style?: string;
  framework?: string;
  category?: string;
  tags: string[];
  styleTags?: string[];
  metadata: DesignComponentMetadata & { sourcePath: string };
  /**
   * New row ID when an INSERT path is taken. Ignored on UPDATE; passed
   * by the caller so the caller can log it before the transaction runs.
   */
  newId: string;
}

export interface UpsertImportedDesignResult {
  row: DesignComponentRow;
  /** True when an existing row was updated; false when a new row was inserted. */
  updated: boolean;
}

export async function upsertImportedDesignComponent(
  input: UpsertImportedDesignInput,
): Promise<UpsertImportedDesignResult> {
  const ts = now();

  // Build the shared INSERT payload once. `style` / `mode` / `framework`
  // have the same defaults as `saveDesignComponent` so an inserted row
  // matches what the legacy code path produced.
  const insertValues = {
    id: input.newId,
    userId: input.userId,
    characterId: input.characterId ?? null,
    sessionId: input.sessionId ?? null,
    projectId: input.projectId ?? null,
    name: input.name,
    description: null,
    prompt: input.prompt,
    code: input.code,
    framework: input.framework ?? "html-css",
    category: input.category ?? "general",
    tags: JSON.stringify(input.tags),
    styleTags: JSON.stringify(input.styleTags ?? []),
    previewPath: null,
    mode: input.mode ?? "tailwind",
    style: input.style ?? "default",
    metadata: JSON.stringify(input.metadata),
    createdAt: ts,
    updatedAt: ts,
  } as typeof designComponents.$inferInsert;

  // We drive the transaction through drizzle's `db.transaction` because the
  // existing codebase already uses that API (see `setDefaultCharacter` in
  // `lib/characters/queries.ts`). drizzle-orm/better-sqlite3 executes the
  // callback synchronously — async drizzle builders resolve in-thread —
  // so the `try/catch` around the transaction reliably intercepts SQLite's
  // UNIQUE constraint error.
  const runUpsert = (): UpsertImportedDesignResult => {
    return db.transaction((tx): UpsertImportedDesignResult => {
      // 1. Look up an existing row for (userId, sessionId, sourcePath).
      const conditions: SQL[] = [
        eq(designComponents.userId, input.userId),
        sql`json_extract(${designComponents.metadata}, '$.sourcePath') = ${input.metadata.sourcePath}`,
      ];
      if (input.sessionId) {
        conditions.push(eq(designComponents.sessionId, input.sessionId));
      }

      const existingRaw = tx
        .select()
        .from(designComponents)
        .where(and(...conditions))
        .orderBy(desc(designComponents.updatedAt))
        .limit(1)
        .all();
      const existing = existingRaw[0];

      if (existing) {
        // 2a. UPDATE path — merge the incoming metadata with whatever was
        // already persisted so downstream metadata keys (non-import) are
        // preserved across re-imports.
        const existingMetadata = safeParseMetadata(existing.metadata ?? null) ?? {};
        const mergedMetadata = { ...existingMetadata, ...input.metadata };

        const [updated] = tx
          .update(designComponents)
          .set({
            name: input.name,
            code: input.code,
            prompt: input.prompt,
            tags: JSON.stringify(input.tags),
            metadata: JSON.stringify(mergedMetadata),
            sessionId: input.sessionId ?? existing.sessionId ?? null,
            characterId: input.characterId ?? existing.characterId ?? null,
            updatedAt: ts,
          })
          .where(
            and(
              eq(designComponents.userId, existing.userId),
              eq(designComponents.id, existing.id),
            ),
          )
          .returning()
          .all();

        return { row: toRow(updated), updated: true };
      }

      // 2b. INSERT path.
      const [inserted] = tx
        .insert(designComponents)
        .values(insertValues)
        .returning()
        .all();

      return { row: toRow(inserted), updated: false };
    });
  };

  try {
    return runUpsert();
  } catch (error) {
    // Concurrent writer beat us to the INSERT — the partial unique index
    // (see migrations/design-gallery-tables.ts) triggers
    // SQLITE_CONSTRAINT_UNIQUE. Retry once inside a fresh transaction: the
    // lookup now sees the other writer's row and takes the UPDATE branch.
    // If the retry itself fails, re-throw so the tool handler can surface
    // IMPORT_DUPLICATE_RACE.
    const code = (error as { code?: string } | null)?.code;
    if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT") {
      return runUpsert();
    }
    throw error;
  }
}

/**
 * Resolve a component for internal tools when user scope may be unavailable.
 * Falls back to session scoping so the active chat can still recover persisted work.
 */
export async function findDesignComponentForScope(opts: {
  id: string;
  userId?: string;
  sessionId?: string;
}): Promise<DesignComponentRow | null> {
  const conditions: SQL[] = [eq(designComponents.id, opts.id)];

  if (opts.userId) {
    conditions.push(eq(designComponents.userId, opts.userId));
  } else if (opts.sessionId) {
    conditions.push(eq(designComponents.sessionId, opts.sessionId));
  } else {
    return null;
  }

  const row = await db.query.designComponents.findFirst({
    where: and(...conditions),
  });

  return row ? toRow(row) : null;
}

// ---------------------------------------------------------------------------
// Sprint 4 W4.2 — cross-component composition resolver.
//
// `findWorkspaceDesignByIdOrTag` resolves a `design:<ref>` import specifier
// emitted by the esbuild virtual-module plugin inside the workspace compiler.
// The lookup is STRICTLY scoped to (userId, sessionId): rows owned by another
// user OR another session always return null — never leak existence across
// scopes, matching the `findSnapshotById` pattern from Sprint 3 W3.1.
//
// Resolution order (first hit wins):
//   1. Exact `id` match within scope.
//   2. Exact `name` match within scope — BUT only when EXACTLY one row in
//      scope has that name. Duplicate names in the same session return
//      `null` (treated as IMPORT_NOT_FOUND by the compiler) so the alias
//      resolution is never ambiguous.
//
// FLAG-W4.2: Tag-name resolution is intentionally name-only for v1. The
// spec text says "resolves by id OR tag name" but the design_components
// schema has both a `name` column and a `tags` JSON array; we resolve by
// `name` (the human-authored identifier shown in the UI) rather than by
// entries inside `tags[]`. Tag-array aliasing is out of scope for W4.2
// because:
//   - `tags` can contain duplicate values across components within a
//     session (e.g. "button", "primitive"), which would make tag-name
//     aliasing inherently collision-prone.
//   - A single row can carry multiple tags, so "resolve by tag" would
//     need a policy for "which row wins if a tag matches N rows". That's
//     a design decision, not an implementation detail — flagged for the
//     product owner to resolve before Sprint 5.
// Callers MUST pass unique `name` values within a session if they want
// the name alias to resolve; collision returns null (→ IMPORT_NOT_FOUND).
// ---------------------------------------------------------------------------
export async function findWorkspaceDesignByIdOrTag(
  userId: string,
  sessionId: string,
  ref: string,
): Promise<DesignComponentRow | null> {
  const normalized = ref.trim();
  if (!normalized) {
    return null;
  }

  // 1. Try id match first. Scoped to (userId, sessionId) so a collision
  //    across users / sessions is impossible.
  const byId = await db.query.designComponents.findFirst({
    where: and(
      eq(designComponents.id, normalized),
      eq(designComponents.userId, userId),
      eq(designComponents.sessionId, sessionId),
    ),
  });
  if (byId) {
    return toRow(byId);
  }

  // 2. Fall back to exact-name match. Require exactly one row to avoid
  //    silently binding to a stale duplicate. Using `limit(2)` + length
  //    check keeps the query cheap (no COUNT(*) needed).
  const byName = await db
    .select()
    .from(designComponents)
    .where(
      and(
        eq(designComponents.name, normalized),
        eq(designComponents.userId, userId),
        eq(designComponents.sessionId, sessionId),
      ),
    )
    .limit(2);

  if (byName.length === 1) {
    return toRow(byName[0]);
  }

  return null;
}

/**
 * Metadata-only summary list for the workspace gallery. Drops `code`,
 * `prompt`, `userId`, and `characterId` so the initial payload stays small
 * even when the user has hundreds of persisted components. The `/api/design/
 * gallery` `get` action is used to hydrate a full row when the user clicks
 * into a component.
 */
export async function listDesignComponentSummariesForScope(
  opts: ScopedDesignListOpts,
): Promise<DesignComponentSummaryRow[]> {
  const conditions: SQL[] = [];

  if (opts.userId) {
    conditions.push(eq(designComponents.userId, opts.userId));
  } else if (opts.sessionId) {
    conditions.push(eq(designComponents.sessionId, opts.sessionId));
  } else {
    return [];
  }

  if (opts.sessionId) {
    conditions.push(eq(designComponents.sessionId, opts.sessionId));
  }

  const rows = await db
    .select({
      id: designComponents.id,
      sessionId: designComponents.sessionId,
      projectId: designComponents.projectId,
      name: designComponents.name,
      description: designComponents.description,
      framework: designComponents.framework,
      category: designComponents.category,
      tags: designComponents.tags,
      styleTags: designComponents.styleTags,
      previewPath: designComponents.previewPath,
      mode: designComponents.mode,
      style: designComponents.style,
      useCount: designComponents.useCount,
      lastUsedAt: designComponents.lastUsedAt,
      isFavorite: designComponents.isFavorite,
      createdAt: designComponents.createdAt,
      updatedAt: designComponents.updatedAt,
    })
    .from(designComponents)
    .where(and(...conditions))
    .orderBy(desc(designComponents.updatedAt))
    .limit(opts.limit ?? 50);

  return rows.map((row) => ({
    ...row,
    tags: safeParseTags(row.tags),
    styleTags: safeParseTags(row.styleTags),
    isFavorite: Boolean(row.isFavorite),
  }));
}

/**
 * List persisted components for a tool session.
 * Uses user scope when available, otherwise falls back to session scope.
 */
export async function listDesignComponentsForScope(opts: {
  userId?: string;
  sessionId?: string;
  limit?: number;
}): Promise<DesignComponentRow[]> {
  const conditions: SQL[] = [];

  if (opts.userId) {
    conditions.push(eq(designComponents.userId, opts.userId));
  } else if (opts.sessionId) {
    conditions.push(eq(designComponents.sessionId, opts.sessionId));
  } else {
    return [];
  }

  if (opts.sessionId) {
    conditions.push(eq(designComponents.sessionId, opts.sessionId));
  }

  const rows = await db
    .select()
    .from(designComponents)
    .where(and(...conditions))
    .orderBy(desc(designComponents.updatedAt))
    .limit(opts.limit ?? 50);

  return rows.map(toRow);
}

/** List components for a user with optional filters. */
export async function listDesignComponents(opts: GallerySearchOpts & {
  search?: string;
}): Promise<DesignComponentRow[]> {
  const search = opts.search ?? opts.query;
  const conditions: SQL[] = [eq(designComponents.userId, opts.userId)];

  if (opts.category) {
    conditions.push(eq(designComponents.category, opts.category));
  }
  if (opts.framework) {
    conditions.push(eq(designComponents.framework, opts.framework));
  }
  if (opts.favoritesOnly) {
    conditions.push(eq(designComponents.isFavorite, true));
  }
  if (opts.projectId) {
    conditions.push(eq(designComponents.projectId, opts.projectId));
  }
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    conditions.push(
      sql`(${designComponents.name} LIKE ${pattern} ESCAPE '\\' OR ${designComponents.description} LIKE ${pattern} ESCAPE '\\')`
    );
  }

  const rows = await db
    .select()
    .from(designComponents)
    .where(and(...conditions))
    .orderBy(desc(designComponents.updatedAt))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0);

  return rows.map(toRow);
}

/** Update a component (partial), scoped to a user. */
export async function updateDesignComponent(
  userId: string,
  id: string,
  updates: Partial<NewDesignComponent>
): Promise<DesignComponentRow | null> {
  const values: Record<string, unknown> = { updatedAt: now() };

  if (updates.name !== undefined) values.name = updates.name;
  if (updates.description !== undefined) values.description = updates.description;
  if (updates.prompt !== undefined) values.prompt = updates.prompt;
  if (updates.code !== undefined) values.code = updates.code;
  if (updates.framework !== undefined) values.framework = updates.framework;
  if (updates.category !== undefined) values.category = updates.category;
  if (updates.tags !== undefined) values.tags = JSON.stringify(updates.tags);
  if (updates.styleTags !== undefined) values.styleTags = JSON.stringify(updates.styleTags);
  if (updates.previewPath !== undefined) values.previewPath = updates.previewPath;
  if (updates.mode !== undefined) values.mode = updates.mode;
  if (updates.style !== undefined) values.style = updates.style;
  if (updates.characterId !== undefined) values.characterId = updates.characterId;
  if (updates.sessionId !== undefined) values.sessionId = updates.sessionId;
  if (updates.projectId !== undefined) values.projectId = updates.projectId;
  if (updates.metadata !== undefined) {
    values.metadata = updates.metadata ? JSON.stringify(updates.metadata) : null;
  }

  const [updated] = await db
    .update(designComponents)
    .set(values)
    .where(and(eq(designComponents.userId, userId), eq(designComponents.id, id)))
    .returning();

  return updated ? toRow(updated) : null;
}

/** Delete a component scoped to a user. Returns true if a row was deleted. */
export async function deleteDesignComponent(userId: string, id: string): Promise<boolean> {
  const result = await db
    .delete(designComponents)
    .where(and(eq(designComponents.userId, userId), eq(designComponents.id, id)))
    .returning({ id: designComponents.id });

  return result.length > 0;
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/** Toggle the favorite flag atomically, returning the new state or null if not found. */
export async function toggleDesignFavorite(userId: string, id: string): Promise<boolean | null> {
  const [updated] = await db
    .update(designComponents)
    .set({
      isFavorite: sql`NOT ${designComponents.isFavorite}`,
      updatedAt: now(),
    })
    .where(and(eq(designComponents.userId, userId), eq(designComponents.id, id)))
    .returning({ isFavorite: designComponents.isFavorite });

  return updated ? Boolean(updated.isFavorite) : null;
}

/** Increment the use count and update lastUsedAt, scoped to a user. */
export async function incrementDesignUseCount(userId: string, id: string): Promise<void> {
  await db
    .update(designComponents)
    .set({
      useCount: sql`${designComponents.useCount} + 1`,
      lastUsedAt: now(),
      updatedAt: now(),
    })
    .where(and(eq(designComponents.userId, userId), eq(designComponents.id, id)));
}

