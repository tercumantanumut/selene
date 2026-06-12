export interface NewDesignComponent {
  /** Optional pre-assigned ID. A random UUID is generated if omitted. */
  id?: string;
  userId: string;
  characterId?: string;
  sessionId?: string;
  projectId?: string;
  name: string;
  description?: string;
  prompt: string;
  code: string;
  framework?: string;
  category?: string;
  tags?: string[];
  styleTags?: string[];
  previewPath?: string;
  mode?: string;
  style?: string;
  /**
   * Structured JSON metadata. Sprint 2 W2.1 introduced this for the "import"
   * action (carries `sourcePath`, `importedAt`). Keep shape open so future
   * actions can extend it without another migration.
   */
  metadata?: DesignComponentMetadata | null;
}

/**
 * Open-ended metadata bag persisted per design component. The `sourcePath` +
 * `importedAt` fields are emitted by the "import" action; additional keys are
 * allowed via the index signature so downstream actions (Sprint 2+) can attach
 * their own metadata without churning this type.
 */
export interface DesignComponentMetadata {
  sourcePath?: string;
  importedAt?: string;
  [key: string]: unknown;
}

export interface DesignComponentRow {
  id: string;
  userId: string;
  characterId: string | null;
  sessionId: string | null;
  projectId: string | null;
  name: string;
  description: string | null;
  prompt: string;
  code: string;
  framework: string;
  category: string;
  tags: string[];
  styleTags: string[];
  previewPath: string | null;
  mode: string;
  style: string;
  useCount: number;
  lastUsedAt: string | null;
  isFavorite: boolean;
  createdAt: string;
  updatedAt: string;
  /** Parsed metadata bag. `null` when no metadata has been persisted. */
  metadata: DesignComponentMetadata | null;
}

/**
 * Metadata-only row for gallery list views. Excludes heavy fields (`code`,
 * `prompt`) so the initial workspace list payload stays small regardless of
 * how many components a user has persisted. Use `getDesignComponent` to
 * hydrate the full row on demand.
 */
export interface DesignComponentSummaryRow {
  id: string;
  sessionId: string | null;
  projectId: string | null;
  name: string;
  description: string | null;
  framework: string;
  category: string;
  tags: string[];
  styleTags: string[];
  previewPath: string | null;
  mode: string;
  style: string;
  useCount: number;
  lastUsedAt: string | null;
  isFavorite: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GallerySearchOpts {
  userId: string;
  query?: string;
  sessionId?: string;
  category?: string;
  framework?: string;
  tags?: string[];
  favoritesOnly?: boolean;
  projectId?: string;
  limit?: number;
  offset?: number;
}

export interface ScopedDesignListOpts {
  userId?: string;
  sessionId?: string;
  limit?: number;
}
