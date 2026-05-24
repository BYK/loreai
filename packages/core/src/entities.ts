/**
 * Entity Registry — recurring people, services, repos, tools, and companies
 * that users reference across sessions with inconsistent names.
 *
 * Provides CRUD, alias management, lookup/resolution, merge, search, and
 * formatting for system prompt injection and recall query expansion.
 */
import { uuidv7 } from "uuidv7";
import { db, ensureProject } from "./db";
import { ftsQuery, ftsQueryOr, EMPTY_QUERY, filterTerms } from "./search";
import { config } from "./config";
import { getGitUser } from "./git";
import * as log from "./log";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EntityType = "self" | "person" | "org" | "service" | "tool" | "repo" | "infra";

export const ENTITY_TYPES: readonly EntityType[] = [
  "self", "person", "org", "service", "tool", "repo", "infra",
] as const;

export type AliasType =
  | "name"
  | "email"
  | "github"
  | "slack"
  | "phone"
  | "nickname"
  | "url"
  | "domain";

export type Entity = {
  id: string;
  project_id: string | null;
  entity_type: EntityType;
  canonical_name: string;
  metadata: string | null;
  cross_project: number;
  created_at: number;
  updated_at: number;
};

export type EntityAlias = {
  id: string;
  entity_id: string;
  alias_type: AliasType;
  alias_value: string;
  source: string | null;
  created_at: number;
};

export type EntityWithAliases = Entity & {
  aliases: EntityAlias[];
};

/** Structured metadata for entities — role, description, notes. */
export type EntityMetadata = {
  description?: string;
  role?: string;
  notes?: string;
  [key: string]: unknown;
};

/** Relationship types between entities. */
export type RelationType =
  | "friend"
  | "colleague"
  | "manager"
  | "report"
  | "collaborator"
  | "client"
  | "mentor"
  | "partner";

export const RELATION_TYPES: readonly RelationType[] = [
  "friend", "colleague", "manager", "report",
  "collaborator", "client", "mentor", "partner",
] as const;

export type EntityRelation = {
  id: string;
  entity_a: string;
  entity_b: string;
  relation: RelationType;
  metadata: string | null;
  source: string | null;
  created_at: number;
  updated_at: number;
};

/** Relation with the other entity's name resolved for display. */
export type EntityRelationResolved = EntityRelation & {
  other_id: string;
  other_name: string;
  other_type: EntityType;
};

/** Entity types that default to cross-project (user-level). */
const CROSS_PROJECT_TYPES: ReadonlySet<EntityType> = new Set([
  "self", "person", "org", "service", "tool",
]);

/** Columns to SELECT for Entity — avoids pulling unnecessary data. */
const ENTITY_COLS =
  "id, project_id, entity_type, canonical_name, metadata, cross_project, created_at, updated_at";

/** Same columns with table alias prefix for use in JOIN queries. */
const ENTITY_COLS_E =
  "e.id, e.project_id, e.entity_type, e.canonical_name, e.metadata, e.cross_project, e.created_at, e.updated_at";

// ---------------------------------------------------------------------------
// CRUD — Entities
// ---------------------------------------------------------------------------

/**
 * Create an entity with optional initial aliases.
 * Returns the new entity ID. Deduplicates by canonical name within the same
 * project scope — if an exact match exists, returns the existing ID.
 */
/**
 * Create result: `id` is the entity ID, `created` indicates whether a new
 * entity was inserted (`true`) or an existing one was deduplicated (`false`).
 */
export type CreateResult = { id: string; created: boolean };

export function create(input: {
  projectPath?: string;
  entityType: EntityType;
  canonicalName: string;
  aliases?: Array<{ type: AliasType; value: string; source?: string }>;
  metadata?: Record<string, unknown>;
  crossProject?: boolean;
  id?: string;
}): CreateResult {
  // Runtime validation — TypeScript types are erased, curator may pass garbage
  if (!ENTITY_TYPES.includes(input.entityType)) {
    throw new Error(`invalid entity type: ${input.entityType}`);
  }

  const pid = input.projectPath ? ensureProject(input.projectPath) : null;
  // Type-based cross_project defaults:
  // self/person/org/service/tool → cross-project (user-level)
  // repo/infra → project-scoped
  const cross = input.crossProject ?? (CROSS_PROJECT_TYPES.has(input.entityType) ? true : pid === null);
  const d = db();

  // Dedup + insert inside a transaction to avoid race conditions
  d.exec("BEGIN IMMEDIATE");
  try {
    const existing = pid
      ? (d
          .query(
            `SELECT id, metadata FROM entities WHERE canonical_name = ? COLLATE NOCASE AND (project_id = ? OR project_id IS NULL)`,
          )
          .get(input.canonicalName, pid) as { id: string; metadata: string | null } | null)
      : (d
          .query(
            `SELECT id, metadata FROM entities WHERE canonical_name = ? COLLATE NOCASE AND project_id IS NULL`,
          )
          .get(input.canonicalName) as { id: string; metadata: string | null } | null);

    if (existing) {
      // Merge metadata inside the transaction to avoid race conditions
      if (input.metadata && Object.keys(input.metadata).length > 0) {
        const merged = mergeMetadata(existing.metadata, input.metadata);
        if (merged) {
          d.query("UPDATE entities SET metadata = ?, updated_at = ? WHERE id = ?")
            .run(JSON.stringify(merged), Date.now(), existing.id);
        }
      }
      d.exec("COMMIT");
      // Add any new aliases to the existing entity (outside transaction —
      // addAlias has its own error handling for UNIQUE constraint violations)
      if (input.aliases?.length) {
        for (const alias of input.aliases) {
          addAlias(existing.id, alias.type, alias.value, alias.source);
        }
      }
      return { id: existing.id, created: false };
    }

    const id = input.id ?? uuidv7();
    const now = Date.now();

    d.query(
      `INSERT INTO entities (id, project_id, entity_type, canonical_name, metadata, cross_project, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      pid,
      input.entityType,
      input.canonicalName,
      input.metadata ? JSON.stringify(input.metadata) : null,
      cross ? 1 : 0,
      now,
      now,
    );

    // Also add the canonical name as a "name" alias for uniform lookup
    addAlias(id, "name", input.canonicalName, "auto");

    // Add provided aliases
    if (input.aliases?.length) {
      for (const alias of input.aliases) {
        addAlias(id, alias.type, alias.value, alias.source);
      }
    }

    d.exec("COMMIT");
    return { id, created: true };
  } catch (e) {
    try { d.exec("ROLLBACK"); } catch { /* best-effort */ }
    throw e;
  }
}

/** Update an entity's canonical name or metadata. */
export function update(
  id: string,
  input: {
    canonicalName?: string;
    metadata?: Record<string, unknown>;
    crossProject?: boolean;
  },
): void {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if (input.canonicalName !== undefined) {
    sets.push("canonical_name = ?");
    params.push(input.canonicalName);
  }
  if (input.metadata !== undefined) {
    sets.push("metadata = ?");
    params.push(JSON.stringify(input.metadata));
  }
  if (input.crossProject !== undefined) {
    sets.push("cross_project = ?");
    params.push(input.crossProject ? 1 : 0);
  }

  if (!sets.length) return;

  sets.push("updated_at = ?");
  params.push(Date.now());
  params.push(id);

  db()
    .query(`UPDATE entities SET ${sets.join(", ")} WHERE id = ?`)
    .run(...params);

  // When canonical name changes, update the auto-generated "name" alias
  if (input.canonicalName !== undefined) {
    const oldAlias = db()
      .query(
        `SELECT id FROM entity_aliases WHERE entity_id = ? AND alias_type = 'name' AND source = 'auto' LIMIT 1`,
      )
      .get(id) as { id: string } | null;
    if (oldAlias) {
      db().query("DELETE FROM entity_aliases WHERE id = ?").run(oldAlias.id);
    }
    addAlias(id, "name", input.canonicalName, "auto");
  }
}

/** Delete an entity, its aliases, relations, and knowledge refs. */
export function remove(id: string): void {
  db().query("DELETE FROM knowledge_entity_refs WHERE entity_id = ?").run(id);
  db().query("DELETE FROM entity_relations WHERE entity_a = ? OR entity_b = ?").run(id, id);
  // Explicitly delete aliases BEFORE the entity so FTS5 content-sync triggers
  // fire correctly (CASCADE deletes do NOT fire AFTER DELETE triggers in SQLite).
  db().query("DELETE FROM entity_aliases WHERE entity_id = ?").run(id);
  db().query("DELETE FROM entities WHERE id = ?").run(id);
}

// ---------------------------------------------------------------------------
// Self-entity
// ---------------------------------------------------------------------------

/**
 * Get the self entity (entity_type = 'self'). Returns null if none exists.
 * The self entity is always cross-project — there is at most one per installation.
 */
export function getSelfEntity(): EntityWithAliases | null {
  const row = db()
    .query(`SELECT ${ENTITY_COLS} FROM entities WHERE entity_type = 'self' LIMIT 1`)
    .get() as Entity | null;
  if (!row) return null;
  const aliases = db()
    .query("SELECT * FROM entity_aliases WHERE entity_id = ? ORDER BY alias_type, alias_value")
    .all(row.id) as EntityAlias[];
  return { ...row, aliases };
}

/**
 * Ensure the self entity exists. Creates or updates it from:
 *   1. `.lore.json` `user` config (explicit override)
 *   2. `git config user.name` / `user.email` (auto-detect fallback)
 *
 * Returns the self entity, or null if no identity could be determined.
 */
export function ensureSelfEntity(projectPath: string): EntityWithAliases | null {
  const cfg = config().user;
  const git = getGitUser(projectPath);

  const name = cfg?.name || git.name;
  if (!name) return getSelfEntity(); // no identity source — return existing or null

  const email = cfg?.email || git.email;
  const existing = getSelfEntity();

  if (existing) {
    // Update name if changed
    const updates: { canonicalName?: string; metadata?: Record<string, unknown> } = {};
    if (existing.canonical_name !== name) {
      updates.canonicalName = name;
    }
    // Merge config metadata into existing
    if (cfg?.metadata && Object.keys(cfg.metadata).length > 0) {
      const merged = mergeMetadata(existing.metadata, cfg.metadata as Record<string, unknown>);
      if (merged) updates.metadata = merged;
    }
    if (Object.keys(updates).length > 0) {
      update(existing.id, updates);
    }
    // Add email alias if not present
    if (email) addAlias(existing.id, "email", email, "auto");
    // Add config aliases
    if (cfg?.aliases) {
      for (const a of cfg.aliases) {
        addAlias(existing.id, a.type as AliasType, a.value, "config");
      }
    }
    return getSelfEntity();
  }

  // Create self entity
  const aliases: Array<{ type: AliasType; value: string; source?: string }> = [];
  if (email) aliases.push({ type: "email", value: email, source: "auto" });
  if (cfg?.aliases) {
    for (const a of cfg.aliases) {
      aliases.push({ type: a.type as AliasType, value: a.value, source: "config" });
    }
  }

  const result = create({
    // No projectPath — self entity is global (project_id=NULL) so it's
    // visible across all projects and dedup works correctly.
    entityType: "self",
    canonicalName: name,
    aliases,
    metadata: cfg?.metadata as Record<string, unknown> | undefined,
    crossProject: true,
  });

  return result.id ? getSelfEntity() : null;
}

// ---------------------------------------------------------------------------
// CRUD — Read
// ---------------------------------------------------------------------------

/** Get a single entity by ID. */
export function get(id: string): Entity | null {
  return (
    (db()
      .query(`SELECT ${ENTITY_COLS} FROM entities WHERE id = ?`)
      .get(id) as Entity | null) ?? null
  );
}

/** Get an entity with all its aliases. */
export function getWithAliases(id: string): EntityWithAliases | null {
  const entity = get(id);
  if (!entity) return null;
  const aliases = db()
    .query("SELECT * FROM entity_aliases WHERE entity_id = ? ORDER BY alias_type, alias_value")
    .all(id) as EntityAlias[];
  return { ...entity, aliases };
}

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

/**
 * Shallow-merge incoming metadata into existing metadata.
 * Existing non-empty values win (first observation preserved); new keys fill gaps.
 * Returns the merged object, or null if both inputs are empty.
 */
export function mergeMetadata(
  existing: string | null,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!incoming || Object.keys(incoming).length === 0) {
    return existing ? (JSON.parse(existing) as Record<string, unknown>) : null;
  }
  const base = existing ? (JSON.parse(existing) as Record<string, unknown>) : {};
  // Start from incoming, then overlay existing non-empty values
  const merged: Record<string, unknown> = { ...incoming };
  for (const [k, v] of Object.entries(base)) {
    if (v !== null && v !== undefined && v !== "") {
      merged[k] = v;
    }
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

/**
 * Format metadata for prompt injection — role/description only, max 80 chars.
 * Notes are omitted (too noisy for system prompts).
 */
function formatMetadataBrief(metadataJson: string | null): string {
  if (!metadataJson) return "";
  try {
    const m = JSON.parse(metadataJson) as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof m.role === "string" && m.role) parts.push(m.role);
    if (typeof m.description === "string" && m.description && m.description !== m.role) {
      parts.push(`"${m.description}"`);
    }
    if (!parts.length) return "";
    const joined = parts.join("; ");
    const truncated = joined.length > 80 ? joined.slice(0, 77) + "..." : joined;
    return ` — ${truncated}`;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// CRUD — Aliases
// ---------------------------------------------------------------------------

/**
 * Add an alias to an entity. Silently ignores duplicates (UNIQUE constraint
 * on alias_type + alias_value means each alias can belong to exactly one entity).
 */
export function addAlias(
  entityId: string,
  aliasType: AliasType,
  aliasValue: string,
  source?: string,
): string | null {
  const id = uuidv7();
  try {
    db()
      .query(
        `INSERT INTO entity_aliases (id, entity_id, alias_type, alias_value, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, entityId, aliasType, aliasValue, source ?? null, Date.now());
    return id;
  } catch (e: unknown) {
    // UNIQUE constraint violation — alias already exists (possibly on another entity)
    if (e instanceof Error && /UNIQUE constraint/i.test(e.message)) {
      log.info(`entity alias already exists: ${aliasType}:${aliasValue}`);
      return null;
    }
    throw e;
  }
}

/** Remove a specific alias by its ID. */
export function removeAlias(aliasId: string): void {
  db().query("DELETE FROM entity_aliases WHERE id = ?").run(aliasId);
}

/** Get all aliases for an entity. */
export function getAliases(entityId: string): EntityAlias[] {
  return db()
    .query("SELECT * FROM entity_aliases WHERE entity_id = ? ORDER BY alias_type, alias_value")
    .all(entityId) as EntityAlias[];
}

// ---------------------------------------------------------------------------
// Lookup & Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a mention (name, email, handle, etc.) to an entity.
 * Tries exact alias match first, then FTS5 fuzzy match on canonical name.
 * Returns the best match or null.
 */
export function resolve(mention: string): Entity | null {
  // 1. Exact alias match (case-insensitive)
  const aliasMatch = db()
    .query(
      `SELECT ${ENTITY_COLS_E}
       FROM entities e
       JOIN entity_aliases a ON a.entity_id = e.id
       WHERE a.alias_value = ? COLLATE NOCASE
       LIMIT 1`,
    )
    .get(mention) as Entity | null;

  if (aliasMatch) return aliasMatch;

  // 2. Exact canonical name match (case-insensitive)
  const nameMatch = db()
    .query(
      `SELECT ${ENTITY_COLS} FROM entities
       WHERE canonical_name = ? COLLATE NOCASE
       LIMIT 1`,
    )
    .get(mention) as Entity | null;

  if (nameMatch) return nameMatch;

  // 3. FTS5 fuzzy match on canonical name
  const fts = ftsQuery(mention);
  if (fts === EMPTY_QUERY) return null;

  const ftsMatch = db()
    .query(
      `SELECT ${ENTITY_COLS_E}
       FROM entities e
       JOIN entities_fts f ON f.rowid = e.rowid
       WHERE entities_fts MATCH ?
       ORDER BY rank
       LIMIT 1`,
    )
    .get(fts) as Entity | null;

  return ftsMatch ?? null;
}

/**
 * Resolve a mention and return all known aliases for the matched entity.
 * Used by recall query expansion to search for all variants.
 */
export function resolveWithAliases(mention: string): EntityWithAliases | null {
  const entity = resolve(mention);
  if (!entity) return null;
  return getWithAliases(entity.id);
}

/**
 * Look up all aliases for a given entity, returning just the alias values.
 * Useful for building expanded search queries.
 */
export function aliasValues(entityId: string): string[] {
  const rows = db()
    .query("SELECT alias_value FROM entity_aliases WHERE entity_id = ?")
    .all(entityId) as Array<{ alias_value: string }>;
  return rows.map((r) => r.alias_value);
}

// ---------------------------------------------------------------------------
// Query expansion for recall
// ---------------------------------------------------------------------------

/**
 * Expand a search query by detecting entity references and adding all aliases.
 * Returns additional query terms to OR with the original query.
 *
 * Example: "Seylan logo" → ["ben@seylan.im", "@seylancinar", "Seylan Cinar Kaya"]
 */
export function expandQueryWithEntities(query: string): string[] {
  const terms = filterTerms(query);
  if (!terms.length) return [];

  const expansions: string[] = [];
  const seenEntityIds = new Set<string>();
  // Track all known values (original terms + added expansions) to avoid dupes
  const seenValues = new Set(terms.map((t) => t.toLowerCase()));

  // Try each term as an entity mention
  for (const term of terms) {
    const entity = resolve(term);
    if (!entity || seenEntityIds.has(entity.id)) continue;
    seenEntityIds.add(entity.id);
    const values = aliasValues(entity.id);
    for (const v of values) {
      const vLower = v.toLowerCase();
      if (!seenValues.has(vLower)) {
        seenValues.add(vLower);
        expansions.push(v);
      }
    }
  }

  // Also try the full query as a single mention (e.g., "GitHub Actions")
  const fullEntity = resolve(query.trim());
  if (fullEntity && !seenEntityIds.has(fullEntity.id)) {
    const values = aliasValues(fullEntity.id);
    for (const v of values) {
      const vLower = v.toLowerCase();
      if (!seenValues.has(vLower)) {
        seenValues.add(vLower);
        expansions.push(v);
      }
    }
  }

  return expansions;
}

// ---------------------------------------------------------------------------
// Listing & Search
// ---------------------------------------------------------------------------

/**
 * Batch-load aliases for a set of entities in a single query.
 * Avoids N+1 queries when listing entities.
 */
function batchLoadAliases(entityIds: string[]): Map<string, EntityAlias[]> {
  const map = new Map<string, EntityAlias[]>();
  if (!entityIds.length) return map;
  // Initialize empty arrays for all IDs
  for (const id of entityIds) map.set(id, []);
  // Single query to fetch all aliases for the given entities
  const placeholders = entityIds.map(() => "?").join(",");
  const allAliases = db()
    .query(
      `SELECT * FROM entity_aliases WHERE entity_id IN (${placeholders}) ORDER BY alias_type, alias_value`,
    )
    .all(...entityIds) as EntityAlias[];
  for (const a of allAliases) {
    map.get(a.entity_id)?.push(a);
  }
  return map;
}

/** Attach aliases to entities using a single batch query. */
function withAliases(rows: Entity[]): EntityWithAliases[] {
  const aliasMap = batchLoadAliases(rows.map((e) => e.id));
  return rows.map((e) => ({ ...e, aliases: aliasMap.get(e.id) ?? [] }));
}

/** List entities for a project, optionally including cross-project entities. */
export function forProject(
  projectPath: string,
  includeCross = true,
): EntityWithAliases[] {
  const pid = ensureProject(projectPath);
  let rows: Entity[];
  if (includeCross) {
    rows = db()
      .query(
        `SELECT ${ENTITY_COLS} FROM entities
         WHERE project_id = ? OR project_id IS NULL OR cross_project = 1
         ORDER BY entity_type, canonical_name`,
      )
      .all(pid) as Entity[];
  } else {
    rows = db()
      .query(
        `SELECT ${ENTITY_COLS} FROM entities
         WHERE project_id = ?
         ORDER BY entity_type, canonical_name`,
      )
      .all(pid) as Entity[];
  }

  return withAliases(rows);
}

/** List all entities (no project filter). */
export function listAll(): EntityWithAliases[] {
  const rows = db()
    .query(`SELECT ${ENTITY_COLS} FROM entities ORDER BY entity_type, canonical_name`)
    .all() as Entity[];

  return withAliases(rows);
}

/** Search entities by FTS5 on canonical name and alias values. */
export function search(input: {
  query: string;
  projectPath?: string;
  limit?: number;
}): EntityWithAliases[] {
  const limit = input.limit ?? 20;
  const fts = ftsQueryOr(input.query);
  if (fts === EMPTY_QUERY) return [];

  const pid = input.projectPath ? ensureProject(input.projectPath) : null;

  // Search both canonical names and alias values, with optional project filter
  let nameMatches: Entity[];
  let aliasMatches: Entity[];

  if (pid) {
    nameMatches = db()
      .query(
        `SELECT ${ENTITY_COLS_E}
         FROM entities e
         JOIN entities_fts f ON f.rowid = e.rowid
         WHERE entities_fts MATCH ? AND (e.project_id = ? OR e.project_id IS NULL OR e.cross_project = 1)
         ORDER BY rank
         LIMIT ?`,
      )
      .all(fts, pid, limit) as Entity[];

    aliasMatches = db()
      .query(
        `SELECT DISTINCT ${ENTITY_COLS_E}
         FROM entities e
         JOIN entity_aliases a ON a.entity_id = e.id
         JOIN entity_aliases_fts af ON af.rowid = a.rowid
         WHERE entity_aliases_fts MATCH ? AND (e.project_id = ? OR e.project_id IS NULL OR e.cross_project = 1)
         ORDER BY rank
         LIMIT ?`,
      )
      .all(fts, pid, limit) as Entity[];
  } else {
    nameMatches = db()
      .query(
        `SELECT ${ENTITY_COLS_E}
         FROM entities e
         JOIN entities_fts f ON f.rowid = e.rowid
         WHERE entities_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(fts, limit) as Entity[];

    aliasMatches = db()
      .query(
        `SELECT DISTINCT ${ENTITY_COLS_E}
         FROM entities e
         JOIN entity_aliases a ON a.entity_id = e.id
         JOIN entity_aliases_fts af ON af.rowid = a.rowid
         WHERE entity_aliases_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(fts, limit) as Entity[];
  }

  // Merge and dedupe
  const seen = new Set<string>();
  const merged: Entity[] = [];
  for (const e of [...nameMatches, ...aliasMatches]) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    merged.push(e);
  }

  return withAliases(merged.slice(0, limit));
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Merge two entities: keep `targetId`, absorb all aliases and knowledge refs
 * from `sourceId`, then delete `sourceId`.
 */
export function merge(targetId: string, sourceId: string): void {
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    // Move aliases from source to target (skip duplicates via OR IGNORE)
    const sourceAliases = d
      .query("SELECT alias_type, alias_value, source FROM entity_aliases WHERE entity_id = ?")
      .all(sourceId) as Array<{ alias_type: string; alias_value: string; source: string | null }>;

    for (const a of sourceAliases) {
      try {
        d.query(
          `INSERT INTO entity_aliases (id, entity_id, alias_type, alias_value, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(uuidv7(), targetId, a.alias_type, a.alias_value, a.source, Date.now());
      } catch (e: unknown) {
        // UNIQUE constraint — alias already exists on target, skip
        if (!(e instanceof Error && /UNIQUE constraint/i.test(e.message))) throw e;
      }
    }

    // Move knowledge_entity_refs from source to target
    d.query(
      `UPDATE OR IGNORE knowledge_entity_refs SET entity_id = ? WHERE entity_id = ?`,
    ).run(targetId, sourceId);

    // Move relations from source to target (update both sides)
    d.query(
      `UPDATE OR IGNORE entity_relations SET entity_a = ? WHERE entity_a = ?`,
    ).run(targetId, sourceId);
    d.query(
      `UPDATE OR IGNORE entity_relations SET entity_b = ? WHERE entity_b = ?`,
    ).run(targetId, sourceId);
    // Clean up any remaining source relations (UNIQUE conflict → left behind by OR IGNORE)
    d.query("DELETE FROM entity_relations WHERE entity_a = ? OR entity_b = ?").run(sourceId, sourceId);

    // Delete source — explicit alias delete so FTS5 triggers fire
    // (CASCADE deletes don't fire AFTER DELETE triggers in SQLite)
    d.query("DELETE FROM knowledge_entity_refs WHERE entity_id = ?").run(sourceId);
    d.query("DELETE FROM entity_aliases WHERE entity_id = ?").run(sourceId);
    d.query("DELETE FROM entities WHERE id = ?").run(sourceId);

    // Update target timestamp
    d.query("UPDATE entities SET updated_at = ? WHERE id = ?").run(Date.now(), targetId);

    d.exec("COMMIT");
  } catch (e) {
    try { d.exec("ROLLBACK"); } catch (rbErr) { log.info("merge rollback failed:", rbErr); }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// CRUD — Relations
// ---------------------------------------------------------------------------

/**
 * Add a relationship between two entities. Silently ignores duplicates
 * (UNIQUE constraint on entity_a + entity_b + relation).
 * Returns the relation ID or null if already exists.
 */
export function addRelation(
  entityA: string,
  entityB: string,
  relation: RelationType,
  opts?: { metadata?: Record<string, unknown>; source?: string },
): string | null {
  if (entityA === entityB) {
    log.info(`skipping self-referential relation: ${entityA} (${relation})`);
    return null;
  }
  if (!RELATION_TYPES.includes(relation)) {
    throw new Error(`invalid relation type: ${relation}`);
  }
  const id = uuidv7();
  const now = Date.now();
  try {
    db()
      .query(
        `INSERT INTO entity_relations (id, entity_a, entity_b, relation, metadata, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        entityA,
        entityB,
        relation,
        opts?.metadata ? JSON.stringify(opts.metadata) : null,
        opts?.source ?? null,
        now,
        now,
      );
    return id;
  } catch (e: unknown) {
    if (e instanceof Error && /UNIQUE constraint/i.test(e.message)) {
      log.info(`relation already exists: ${entityA} → ${entityB} (${relation})`);
      return null;
    }
    throw e;
  }
}

/** Remove a relation by its ID. */
export function removeRelation(id: string): void {
  db().query("DELETE FROM entity_relations WHERE id = ?").run(id);
}

/**
 * Get all relations for an entity (either side), with the other entity's
 * name and type resolved for display.
 */
export function relationsFor(entityId: string): EntityRelationResolved[] {
  const rows = db()
    .query(
      `SELECT r.*, 
              CASE WHEN r.entity_a = ? THEN r.entity_b ELSE r.entity_a END AS other_id,
              CASE WHEN r.entity_a = ? THEN eb.canonical_name ELSE ea.canonical_name END AS other_name,
              CASE WHEN r.entity_a = ? THEN eb.entity_type ELSE ea.entity_type END AS other_type
       FROM entity_relations r
       JOIN entities ea ON ea.id = r.entity_a
       JOIN entities eb ON eb.id = r.entity_b
       WHERE r.entity_a = ? OR r.entity_b = ?
       ORDER BY r.relation, other_name`,
    )
    .all(entityId, entityId, entityId, entityId, entityId) as EntityRelationResolved[];
  return rows;
}

/**
 * Look up specific relation(s) between two entities. If `relation` is provided,
 * returns at most one row; otherwise returns all relations between the pair.
 */
export function getRelation(
  entityA: string,
  entityB: string,
  relation?: RelationType,
): EntityRelation[] {
  if (relation) {
    const row = db()
      .query(
        `SELECT * FROM entity_relations
         WHERE ((entity_a = ? AND entity_b = ?) OR (entity_a = ? AND entity_b = ?))
           AND relation = ?
         LIMIT 1`,
      )
      .get(entityA, entityB, entityB, entityA, relation) as EntityRelation | null;
    return row ? [row] : [];
  }
  return db()
    .query(
      `SELECT * FROM entity_relations
       WHERE (entity_a = ? AND entity_b = ?) OR (entity_a = ? AND entity_b = ?)
       ORDER BY relation`,
    )
    .all(entityA, entityB, entityB, entityA) as EntityRelation[];
}

/**
 * Format relations for an entity as a concise string for prompt injection.
 * Example: "friend of Melkey, colleague of Alice"
 */
export function formatRelationsForPrompt(entityId: string): string {
  const rels = relationsFor(entityId);
  if (!rels.length) return "";
  return rels.map((r) => `${r.relation} of ${r.other_name}`).join(", ");
}

// ---------------------------------------------------------------------------
// Knowledge–Entity References
// ---------------------------------------------------------------------------

/** Link a knowledge entry to an entity. */
export function linkKnowledge(knowledgeId: string, entityId: string): void {
  try {
    db()
      .query(
        `INSERT OR IGNORE INTO knowledge_entity_refs (knowledge_id, entity_id)
         VALUES (?, ?)`,
      )
      .run(knowledgeId, entityId);
  } catch (e: unknown) {
    // FK violation (entity or knowledge entry doesn't exist) — ignore
    if (e instanceof Error && /FOREIGN KEY/i.test(e.message)) {
      log.info(`cannot link knowledge ${knowledgeId} to entity ${entityId}: FK violation`);
      return;
    }
    throw e;
  }
}

/** Unlink a knowledge entry from an entity. */
export function unlinkKnowledge(knowledgeId: string, entityId: string): void {
  db()
    .query("DELETE FROM knowledge_entity_refs WHERE knowledge_id = ? AND entity_id = ?")
    .run(knowledgeId, entityId);
}

/** Get all entities referenced by a knowledge entry. */
export function entitiesForKnowledge(knowledgeId: string): Entity[] {
  return db()
    .query(
      `SELECT ${ENTITY_COLS_E}
       FROM entities e
       JOIN knowledge_entity_refs r ON r.entity_id = e.id
       WHERE r.knowledge_id = ?`,
    )
    .all(knowledgeId) as Entity[];
}

/** Get all knowledge entry IDs referencing an entity. */
export function knowledgeForEntity(entityId: string): string[] {
  const rows = db()
    .query("SELECT knowledge_id FROM knowledge_entity_refs WHERE entity_id = ?")
    .all(entityId) as Array<{ knowledge_id: string }>;
  return rows.map((r) => r.knowledge_id);
}

// ---------------------------------------------------------------------------
// Session injection — hybrid cap-based entity selection
// ---------------------------------------------------------------------------

/**
 * Select entities to inject into the agent system prompt.
 *
 * - If total count ≤ maxEntityInject (default 30): return all
 * - If count exceeds cap:
 *   - Always include: self entity + entities with direct relationships to self
 *   - Relevance-rank the rest by: knowledge ref count, recency of linked knowledge
 *   - Return up to `maxEntityInject` entities
 *
 * The curator always uses `forProject()` directly (needs the full list).
 */
export function entitiesForSession(
  projectPath: string,
  maxInject?: number,
): EntityWithAliases[] {
  const cap = maxInject ?? config().knowledge.maxEntityInject;
  if (cap === 0) return [];

  const all = forProject(projectPath);
  if (all.length <= cap) return all;

  // Always include self entity + entities related to self
  const selfEntity = all.find((e) => e.entity_type === "self");
  const alwaysInclude = new Set<string>();
  if (selfEntity) {
    alwaysInclude.add(selfEntity.id);
    const selfRels = relationsFor(selfEntity.id);
    for (const r of selfRels) {
      alwaysInclude.add(r.other_id);
    }
  }

  const guaranteed = all.filter((e) => alwaysInclude.has(e.id));
  const remaining = all.filter((e) => !alwaysInclude.has(e.id));

  if (guaranteed.length >= cap) {
    return guaranteed.slice(0, cap);
  }

  // Relevance-rank remaining by knowledge ref count (more refs = more relevant)
  const slots = cap - guaranteed.length;
  const scored = remaining.map((e) => {
    const refCount = knowledgeForEntity(e.id).length;
    return { entity: e, score: refCount };
  });
  scored.sort((a, b) => b.score - a.score);

  return [...guaranteed, ...scored.slice(0, slots).map((s) => s.entity)];
}

// ---------------------------------------------------------------------------
// Formatting for prompts
// ---------------------------------------------------------------------------

/**
 * Format entities for injection into the curator prompt or system prompt.
 * Groups by type, includes aliases, metadata brief, and relationship tags.
 *
 * The self entity is marked with " — you (the user)" and other entities
 * that have relationships with the self entity get a `[relation]` tag.
 */
export function formatForPrompt(entities: EntityWithAliases[]): string {
  if (!entities.length) return "";

  // Build a map of self-entity relationships for tagging
  const selfEntity = entities.find((e) => e.entity_type === "self");
  const selfRelMap = new Map<string, string[]>(); // entityId → [relation names]
  if (selfEntity) {
    const selfRels = relationsFor(selfEntity.id);
    for (const r of selfRels) {
      const rels = selfRelMap.get(r.other_id) ?? [];
      rels.push(r.relation);
      selfRelMap.set(r.other_id, rels);
    }
  }

  // Group entities — show "self" under "person" since it's a person
  const grouped: Record<string, EntityWithAliases[]> = {};
  for (const e of entities) {
    const displayType = e.entity_type === "self" ? "person" : e.entity_type;
    const group = grouped[displayType] ?? (grouped[displayType] = []);
    group.push(e);
  }

  const lines: string[] = ["Known entities (resolve ambiguous references using these):"];
  for (const [type, items] of Object.entries(grouped)) {
    lines.push(`  ${type}:`);
    for (const e of items) {
      const aliasStrs = e.aliases
        .filter((a) => a.alias_value !== e.canonical_name) // skip canonical dupe
        .map((a) => `${a.alias_type}:${a.alias_value}`);
      const aliasInfo = aliasStrs.length ? ` (aliases: ${aliasStrs.join(", ")})` : "";

      // Self-entity marker
      const selfMarker = e.entity_type === "self" ? " — you (the user)" : "";

      // Metadata brief (role/description)
      const metaInfo = e.entity_type === "self" ? "" : formatMetadataBrief(e.metadata);

      // Relationship tags from self entity (e.g. [friend])
      const relTags = selfRelMap.get(e.id);
      const relInfo = relTags?.length ? ` [${relTags.join(", ")}]` : "";

      lines.push(
        `    - [${e.id}] ${e.canonical_name}${aliasInfo}${selfMarker}${metaInfo}${relInfo}`,
      );
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Automatic entity-knowledge linking
// ---------------------------------------------------------------------------

/**
 * Scan a knowledge entry's content for entity references and populate
 * the knowledge_entity_refs join table. Tries to resolve each meaningful
 * word/phrase against the entity registry.
 *
 * Called after knowledge entry create/update in the curator pipeline.
 */
export function syncEntityRefs(knowledgeId: string, content: string): number {
  // Clear existing refs for this knowledge entry
  db().query("DELETE FROM knowledge_entity_refs WHERE knowledge_id = ?").run(knowledgeId);

  // Get all entities for fast matching
  const allEntities = db()
    .query("SELECT id, canonical_name FROM entities")
    .all() as Array<{ id: string; canonical_name: string }>;

  if (!allEntities.length) return 0;

  // Also load all aliases for matching
  const allAliases = db()
    .query("SELECT entity_id, alias_value FROM entity_aliases")
    .all() as Array<{ entity_id: string; alias_value: string }>;

  const contentLower = content.toLowerCase();
  const linkedEntityIds = new Set<string>();

  // Min length to avoid false positives from short aliases like "Go", "CI", "DB"
  const MIN_MATCH_LEN = 3;

  // Check canonical names
  for (const e of allEntities) {
    if (e.canonical_name.length >= MIN_MATCH_LEN && contentLower.includes(e.canonical_name.toLowerCase())) {
      linkedEntityIds.add(e.id);
    }
  }

  // Check aliases
  for (const a of allAliases) {
    if (a.alias_value.length >= MIN_MATCH_LEN && contentLower.includes(a.alias_value.toLowerCase())) {
      linkedEntityIds.add(a.entity_id);
    }
  }

  let count = 0;
  for (const entityId of linkedEntityIds) {
    try {
      db()
        .query(
          "INSERT OR IGNORE INTO knowledge_entity_refs (knowledge_id, entity_id) VALUES (?, ?)",
        )
        .run(knowledgeId, entityId);
      count++;
    } catch (e: unknown) {
      // FK violation (entity or knowledge entry doesn't exist) — skip
      if (e instanceof Error && /FOREIGN KEY/i.test(e.message)) continue;
      throw e;
    }
  }

  return count;
}

// ---------------------------------------------------------------------------
// Auto-dedup candidates
// ---------------------------------------------------------------------------

/**
 * Find potential duplicate entities by alias overlap or canonical name similarity.
 * Returns pairs of (entity1, entity2) that are likely duplicates.
 */
export function findDuplicateCandidates(
  projectPath?: string,
  maxCandidates = 50,
): Array<{ entity1: EntityWithAliases; entity2: EntityWithAliases; reason: string }> {
  const entities = projectPath ? forProject(projectPath) : listAll();
  const candidates: Array<{ entity1: EntityWithAliases; entity2: EntityWithAliases; reason: string }> = [];
  const seen = new Set<string>();

  for (let i = 0; i < entities.length && candidates.length < maxCandidates; i++) {
    for (let j = i + 1; j < entities.length && candidates.length < maxCandidates; j++) {
      const e1 = entities[i];
      const e2 = entities[j];
      const pairKey = `${e1.id}:${e2.id}`;
      if (seen.has(pairKey)) continue;

      // Check alias overlap
      const aliases1 = new Set(e1.aliases.map((a) => a.alias_value.toLowerCase()));
      const aliases2 = new Set(e2.aliases.map((a) => a.alias_value.toLowerCase()));
      const overlap = [...aliases1].filter((a) => aliases2.has(a));
      if (overlap.length > 0) {
        seen.add(pairKey);
        candidates.push({
          entity1: e1,
          entity2: e2,
          reason: `shared aliases: ${overlap.join(", ")}`,
        });
        continue;
      }

      // Check canonical name word overlap (Jaccard similarity)
      const words1 = new Set(filterTerms(e1.canonical_name));
      const words2 = new Set(filterTerms(e2.canonical_name));
      if (words1.size > 0 && words2.size > 0) {
        const intersection = [...words1].filter((w) => words2.has(w)).length;
        const union = new Set([...words1, ...words2]).size;
        const jaccard = intersection / union;
        if (jaccard >= 0.5 && intersection >= 2) {
          seen.add(pairKey);
          candidates.push({
            entity1: e1,
            entity2: e2,
            reason: `similar names (jaccard=${jaccard.toFixed(2)})`,
          });
        }
      }
    }
  }

  return candidates;
}
