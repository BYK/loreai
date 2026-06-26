/**
 * Entity Registry — recurring people, services, repos, tools, and companies
 * that users reference across sessions with inconsistent names.
 *
 * Provides CRUD, alias management, lookup/resolution, merge, search, and
 * formatting for system prompt injection and recall query expansion.
 */
import { uuidv7 } from "uuidv7";
import { db, ensureProject, getKV, setKV, withTransaction } from "./db";
import { ftsQuery, ftsQueryOr, EMPTY_QUERY, filterTerms } from "./search";
import { offloadAll } from "./read-offload";
import { config } from "./config";
import { getGitUser } from "./git";
import * as log from "./log";
import * as embedding from "./embedding";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EntityType =
  | "self"
  | "person"
  | "org"
  | "service"
  | "tool"
  | "repo"
  | "infra";

export const ENTITY_TYPES: readonly EntityType[] = [
  "self",
  "person",
  "org",
  "service",
  "tool",
  "repo",
  "infra",
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
  "friend",
  "colleague",
  "manager",
  "report",
  "collaborator",
  "client",
  "mentor",
  "partner",
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
  "self",
  "person",
  "org",
  "service",
  "tool",
]);

/**
 * Alias types that uniquely identify a *person*. Used to gate self/person
 * merging: only these may trigger an absorb-into-self. Shared, non-identity
 * aliases (`url`, `domain`) routinely co-occur on unrelated colleagues — e.g.
 * everyone on a team shares `github.com/org` or `sentry.io` — so matching on
 * them would over-merge real people into the self entity and delete them.
 */
const IDENTITY_ALIAS_TYPES: ReadonlySet<AliasType> = new Set([
  "name",
  "email",
  "github",
  "slack",
  "phone",
  "nickname",
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
  const cross =
    input.crossProject ??
    (CROSS_PROJECT_TYPES.has(input.entityType) ? true : pid === null);
  const d = db();

  // Dedup + insert inside a transaction to avoid race conditions
  d.exec("BEGIN IMMEDIATE");
  try {
    const existing = pid
      ? (d
          .query(
            `SELECT id, metadata FROM entities WHERE canonical_name = ? COLLATE NOCASE AND (project_id = ? OR project_id IS NULL)`,
          )
          .get(input.canonicalName, pid) as {
          id: string;
          metadata: string | null;
        } | null)
      : (d
          .query(
            `SELECT id, metadata FROM entities WHERE canonical_name = ? COLLATE NOCASE AND project_id IS NULL`,
          )
          .get(input.canonicalName) as {
          id: string;
          metadata: string | null;
        } | null);

    if (existing) {
      // Merge metadata inside the transaction to avoid race conditions
      if (input.metadata && Object.keys(input.metadata).length > 0) {
        const merged = mergeMetadata(existing.metadata, input.metadata);
        if (merged) {
          d.query(
            "UPDATE entities SET metadata = ?, updated_at = ? WHERE id = ?",
          ).run(JSON.stringify(merged), Date.now(), existing.id);
        }
      }
      d.exec("COMMIT");
      // Add any new aliases to the existing entity (outside transaction —
      // addAlias has its own error handling for UNIQUE constraint violations)
      if (input.aliases?.length) {
        for (const alias of input.aliases) {
          addAlias(existing.id, alias.type, alias.value, alias.source);
        }
        // Alias set changed — refresh the dedup embedding.
        reembedEntity(existing.id);
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
    reembedEntity(id);
    return { id, created: true };
  } catch (e) {
    try {
      d.exec("ROLLBACK");
    } catch {
      /* best-effort */
    }
    throw e;
  }
}

/**
 * Recompute and store an entity's embedding from its current canonical name +
 * alias values. Fire-and-forget (errors logged inside embedEntity). Called
 * whenever the name or alias set changes so the entity dedup vector stays
 * current. No-op when no embedding provider is available. Exported so external
 * mutation paths (CLI alias add/rm) can refresh the vector after changing the
 * alias set without going through create()/update().
 */
export function reembedEntity(id: string): void {
  const row = db()
    .query("SELECT canonical_name FROM entities WHERE id = ?")
    .get(id) as { canonical_name: string } | null;
  if (!row) return;
  embedding.embedEntity(id, row.canonical_name, aliasValues(id));
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
    // Canonical name changed — refresh the dedup embedding.
    reembedEntity(id);
  }
}

/** Delete an entity, its aliases, relations, and knowledge refs. */
export function remove(id: string): void {
  db().query("DELETE FROM knowledge_entity_refs WHERE entity_id = ?").run(id);
  db()
    .query("DELETE FROM entity_relations WHERE entity_a = ? OR entity_b = ?")
    .run(id, id);
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
    .query(
      `SELECT ${ENTITY_COLS} FROM entities WHERE entity_type = 'self' LIMIT 1`,
    )
    .get() as Entity | null;
  if (!row) return null;
  const aliases = db()
    .query(
      "SELECT * FROM entity_aliases WHERE entity_id = ? ORDER BY alias_type, alias_value",
    )
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
export function ensureSelfEntity(
  projectPath: string,
): EntityWithAliases | null {
  const cfg = config().user;
  const git = getGitUser(projectPath);

  const name = cfg?.name || git.name;
  if (!name) return getSelfEntity(); // no identity source — return existing or null

  const email = cfg?.email || git.email;
  const existing = getSelfEntity();

  if (existing) {
    // Update name if changed
    const updates: {
      canonicalName?: string;
      metadata?: Record<string, unknown>;
    } = {};
    if (existing.canonical_name !== name) {
      updates.canonicalName = name;
    }
    // Merge config metadata into existing
    if (cfg?.metadata && Object.keys(cfg.metadata).length > 0) {
      const merged = mergeMetadata(
        existing.metadata,
        cfg.metadata as Record<string, unknown>,
      );
      if (merged) updates.metadata = merged;
    }
    let changed = Object.keys(updates).length > 0;
    if (changed) {
      update(existing.id, updates);
    }
    // Add email alias if not present
    if (email && addAlias(existing.id, "email", email, "auto")) changed = true;
    // Add config aliases
    if (cfg?.aliases) {
      for (const a of cfg.aliases) {
        if (addAlias(existing.id, a.type as AliasType, a.value, "config"))
          changed = true;
      }
    }
    // Only re-embed when the name or alias set actually changed.
    if (changed) reembedEntity(existing.id);
    return finalizeSelfEntity(getSelfEntity() ?? missingSelfEntity());
  }

  // Create self entity
  const aliases: Array<{ type: AliasType; value: string; source?: string }> =
    [];
  if (email) aliases.push({ type: "email", value: email, source: "auto" });
  if (cfg?.aliases) {
    for (const a of cfg.aliases) {
      aliases.push({
        type: a.type as AliasType,
        value: a.value,
        source: "config",
      });
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

  const created = result.id ? getSelfEntity() : null;
  return created ? finalizeSelfEntity(created) : null;
}

/**
 * After ensuring the self entity exists, check for "person" entities that
 * share a canonical name or alias with the self entity and merge them in.
 * This handles the case where the LLM curator created a "person" entity for
 * the user (it cannot create "self" type) before or alongside the self entity.
 */
function finalizeSelfEntity(self: EntityWithAliases): EntityWithAliases {
  const count = mergeSelfPersonDuplicates(self);
  if (count > 0) {
    log.info(
      `merged ${count} person entit${count === 1 ? "y" : "ies"} into self entity`,
    );
    return getSelfEntity() ?? missingSelfEntity(); // re-fetch with merged aliases
  }
  return self;
}

/**
 * Self-entity invariant violation: getSelfEntity() returned null
 * from a code path that assumes it always exists. The self entity
 * is created on first call to ensureSelfEntity() and persists for
 * the lifetime of the process; this only triggers if the DB is
 * unexpectedly empty mid-operation. Throw so the call site sees a
 * real error rather than a silent null deref.
 */
function missingSelfEntity(): never {
  throw new Error(
    "self entity invariant violation: getSelfEntity() returned null",
  );
}

/**
 * Find "person" entities that are genuinely the *same individual* as the self
 * entity and merge them in. Exported for testing.
 *
 * Matching is restricted to IDENTITY_ALIAS_TYPES (name/email/github/slack/
 * phone/nickname) plus the canonical name. Non-identity aliases (`url`,
 * `domain`) are deliberately ignored: they are shared across whole teams, so
 * matching on them would absorb (and delete) unrelated colleagues. The self
 * entity's match set is likewise built from identity aliases only.
 *
 * NOTE: The match set is captured once before the loop and is NOT refreshed
 * after each merge. Transitive overlaps (person A → self gains A's alias →
 * person B matches that alias) need a second pass to converge; since
 * `ensureSelfEntity` runs on every curator invocation this converges across
 * sessions.
 */
export function mergeSelfPersonDuplicates(
  selfEntity: EntityWithAliases,
): number {
  // Collect self identity values (lowercased): canonical_name + identity aliases.
  const selfIdentityValues = new Set<string>();
  selfIdentityValues.add(selfEntity.canonical_name.toLowerCase());
  for (const a of selfEntity.aliases) {
    if (IDENTITY_ALIAS_TYPES.has(a.alias_type)) {
      selfIdentityValues.add(a.alias_value.toLowerCase());
    }
  }

  // Find all "person" entities
  const persons = db()
    .query(`SELECT ${ENTITY_COLS} FROM entities WHERE entity_type = 'person'`)
    .all() as Entity[];

  // For each person, check for an identity match against self.
  let mergedCount = 0;
  for (const person of persons) {
    let matched: string | null = null;
    if (selfIdentityValues.has(person.canonical_name.toLowerCase())) {
      matched = `name:${person.canonical_name}`;
    } else {
      // Check identity-typed alias overlap only.
      const personAliases = db()
        .query(
          "SELECT alias_type, alias_value FROM entity_aliases WHERE entity_id = ?",
        )
        .all(person.id) as Array<{
        alias_type: AliasType;
        alias_value: string;
      }>;
      const hit = personAliases.find(
        (a) =>
          IDENTITY_ALIAS_TYPES.has(a.alias_type) &&
          selfIdentityValues.has(a.alias_value.toLowerCase()),
      );
      if (hit) matched = `${hit.alias_type}:${hit.alias_value}`;
    }
    if (matched === null) continue;

    // Audit before the row disappears: log + record a feedback row so the
    // self/person merge has a durable, queryable trail (these merges leave no
    // other history). source='self_merge' is excluded from threshold calibration.
    log.info(
      `merging person "${person.canonical_name}" into self entity (matched ${matched})`,
    );
    try {
      recordEntityDedupFeedback({
        projectId: null,
        entryATitle: selfEntity.canonical_name,
        entryBTitle: person.canonical_name,
        similarity: 1.0,
        accepted: true,
        source: "self_merge",
      });
    } catch (err) {
      log.warn("self_merge audit record failed (non-fatal):", err);
    }
    merge(selfEntity.id, person.id); // absorb person into self
    mergedCount++;
  }
  return mergedCount;
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
    .query(
      "SELECT * FROM entity_aliases WHERE entity_id = ? ORDER BY alias_type, alias_value",
    )
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
  const base = existing
    ? (JSON.parse(existing) as Record<string, unknown>)
    : {};
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
    if (
      typeof m.description === "string" &&
      m.description &&
      m.description !== m.role
    ) {
      parts.push(`"${m.description}"`);
    }
    if (!parts.length) return "";
    const joined = parts.join("; ");
    const truncated = joined.length > 80 ? `${joined.slice(0, 77)}...` : joined;
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
    .query(
      "SELECT * FROM entity_aliases WHERE entity_id = ? ORDER BY alias_type, alias_value",
    )
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

/**
 * Offloaded counterpart to {@link batchLoadAliases} (#966). The single
 * `entity_aliases IN (...)` scan runs on the read-worker pool instead of the
 * main thread.
 *
 * 🔴 Clone-safety invariant: `SELECT *` is only safe here because
 * `entity_aliases` carries no BLOB column (id/entity_id/alias_type/alias_value/
 * source are TEXT, created_at is INTEGER) — all structured-clone-safe across the
 * worker boundary. If a BLOB column (e.g. an embedding) is ever added to
 * `entity_aliases`, this MUST switch to an explicit non-BLOB column list, or the
 * BLOB will be copied across the boundary on every recall.
 */
async function batchLoadAliasesOffloaded(
  entityIds: string[],
): Promise<Map<string, EntityAlias[]>> {
  const map = new Map<string, EntityAlias[]>();
  if (!entityIds.length) return map;
  // Initialize empty arrays for all IDs (mirrors batchLoadAliases)
  for (const id of entityIds) map.set(id, []);
  const placeholders = entityIds.map(() => "?").join(",");
  const allAliases = (await offloadAll(
    `SELECT * FROM entity_aliases WHERE entity_id IN (${placeholders}) ORDER BY alias_type, alias_value`,
    entityIds,
  )) as EntityAlias[];
  for (const a of allAliases) {
    map.get(a.entity_id)?.push(a);
  }
  return map;
}

/** Offloaded counterpart to {@link withAliases} (#966). */
async function withAliasesOffloaded(
  rows: Entity[],
): Promise<EntityWithAliases[]> {
  const aliasMap = await batchLoadAliasesOffloaded(rows.map((e) => e.id));
  return rows.map((e) => ({ ...e, aliases: aliasMap.get(e.id) ?? [] }));
}

/**
 * Batch-hydrate entities + aliases by id, offloaded (#966). Used by recall's
 * entity vector hydration to replace N per-hit `getWithAliases()` calls with a
 * single `entities IN (...)` scan plus one offloaded alias load. `ENTITY_COLS`
 * excludes the embedding BLOB, so rows are clone-safe across the worker
 * boundary. Returns a map keyed by entity id; ids with no live row are absent
 * from the map (callers drop them, matching `getWithAliases()` returning null).
 */
export async function getManyWithAliasesOffloaded(
  ids: string[],
): Promise<Map<string, EntityWithAliases>> {
  const map = new Map<string, EntityWithAliases>();
  if (!ids.length) return map;
  const placeholders = ids.map(() => "?").join(",");
  const rows = (await offloadAll(
    `SELECT ${ENTITY_COLS} FROM entities WHERE id IN (${placeholders})`,
    ids,
  )) as Entity[];
  for (const e of await withAliasesOffloaded(rows)) {
    map.set(e.id, e);
  }
  return map;
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
    .query(
      `SELECT ${ENTITY_COLS} FROM entities ORDER BY entity_type, canonical_name`,
    )
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

/**
 * Offloaded counterpart to {@link search} (#966). The two FTS scans (canonical
 * name + alias) and the alias hydration run on the read-worker pool instead of
 * the main event loop. `ENTITY_COLS_E` excludes the embedding BLOB, so rows are
 * structured-clone-safe across the worker boundary. Behaviour (filtering,
 * merge/dedupe order, limit) is identical to {@link search}.
 */
export async function searchAsync(input: {
  query: string;
  projectPath?: string;
  limit?: number;
}): Promise<EntityWithAliases[]> {
  const limit = input.limit ?? 20;
  const fts = ftsQueryOr(input.query);
  if (fts === EMPTY_QUERY) return [];

  const pid = input.projectPath ? ensureProject(input.projectPath) : null;

  const nameSQL = pid
    ? `SELECT ${ENTITY_COLS_E}
         FROM entities e
         JOIN entities_fts f ON f.rowid = e.rowid
         WHERE entities_fts MATCH ? AND (e.project_id = ? OR e.project_id IS NULL OR e.cross_project = 1)
         ORDER BY rank
         LIMIT ?`
    : `SELECT ${ENTITY_COLS_E}
         FROM entities e
         JOIN entities_fts f ON f.rowid = e.rowid
         WHERE entities_fts MATCH ?
         ORDER BY rank
         LIMIT ?`;
  const aliasSQL = pid
    ? `SELECT DISTINCT ${ENTITY_COLS_E}
         FROM entities e
         JOIN entity_aliases a ON a.entity_id = e.id
         JOIN entity_aliases_fts af ON af.rowid = a.rowid
         WHERE entity_aliases_fts MATCH ? AND (e.project_id = ? OR e.project_id IS NULL OR e.cross_project = 1)
         ORDER BY rank
         LIMIT ?`
    : `SELECT DISTINCT ${ENTITY_COLS_E}
         FROM entities e
         JOIN entity_aliases a ON a.entity_id = e.id
         JOIN entity_aliases_fts af ON af.rowid = a.rowid
         WHERE entity_aliases_fts MATCH ?
         ORDER BY rank
         LIMIT ?`;
  const nameParams = pid ? [fts, pid, limit] : [fts, limit];
  const aliasParams = pid ? [fts, pid, limit] : [fts, limit];

  // Independent degrade (each scan → [] on pool timeout) is deliberate here,
  // unlike forSession's shared-fate offloadAllOrTimeout (#966 B). Entity FTS is
  // a best-effort supplemental RRF list: under a partial pool timeout, keeping
  // whichever scan succeeded (a valid subset of matches) is preferable to
  // discarding both. A partial set is never *wrong* data — only degraded recall.
  const [nameMatches, aliasMatches] = (await Promise.all([
    offloadAll(nameSQL, nameParams),
    offloadAll(aliasSQL, aliasParams),
  ])) as [Entity[], Entity[]];

  // Merge and dedupe (preserve name-match ordering first) — identical to search()
  const seen = new Set<string>();
  const merged: Entity[] = [];
  for (const e of [...nameMatches, ...aliasMatches]) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    merged.push(e);
  }

  return withAliasesOffloaded(merged.slice(0, limit));
}

/**
 * Search `repo` entities owned by *other* projects, by FTS5 on canonical name
 * and alias values. Used by recall's "all" scope to resolve cross-project
 * repository references (e.g. "the sentry-cli typescript project" mentioned
 * while working in a different repo).
 *
 * `repo` entities default to project scope (cross_project = 0) and are
 * therefore filtered out by the standard `search()` visibility predicate, so a
 * repo owned by another project is otherwise invisible. This complements
 * `search()` rather than replacing it; the current project's own repos + all
 * cross-project entities are still handled there.
 *
 * `infra` entities are intentionally excluded — they are project-specific
 * (servers, queues, buckets) and would be noise/confusion across projects.
 */
export function searchCrossProjectRepos(input: {
  query: string;
  excludeProjectPath: string;
  limit?: number;
}): EntityWithAliases[] {
  const limit = input.limit ?? 20;
  const fts = ftsQueryOr(input.query);
  if (fts === EMPTY_QUERY) return [];

  const pid = ensureProject(input.excludeProjectPath);

  // cross_project = 0: only project-scoped repos. Repos already marked
  // cross_project = 1 are returned by the standard search() via its
  // cross_project predicate — including them here would double-boost them in
  // RRF fusion. This keeps the two search paths strictly complementary.
  const nameMatches = db()
    .query(
      `SELECT ${ENTITY_COLS_E}
       FROM entities e
       JOIN entities_fts f ON f.rowid = e.rowid
       WHERE entities_fts MATCH ?
         AND e.entity_type = 'repo'
         AND e.cross_project = 0
         AND e.project_id IS NOT NULL
         AND e.project_id != ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(fts, pid, limit) as Entity[];

  const aliasMatches = db()
    .query(
      `SELECT DISTINCT ${ENTITY_COLS_E}
       FROM entities e
       JOIN entity_aliases a ON a.entity_id = e.id
       JOIN entity_aliases_fts af ON af.rowid = a.rowid
       WHERE entity_aliases_fts MATCH ?
         AND e.entity_type = 'repo'
         AND e.cross_project = 0
         AND e.project_id IS NOT NULL
         AND e.project_id != ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(fts, pid, limit) as Entity[];

  // Merge and dedupe (preserve name-match ordering first)
  const seen = new Set<string>();
  const merged: Entity[] = [];
  for (const e of [...nameMatches, ...aliasMatches]) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    merged.push(e);
  }

  return withAliases(merged.slice(0, limit));
}

/**
 * Offloaded counterpart to {@link searchCrossProjectRepos} (#966). FTS scans +
 * alias hydration run on the read-worker pool. Behaviour is identical to the
 * synchronous version.
 */
export async function searchCrossProjectReposAsync(input: {
  query: string;
  excludeProjectPath: string;
  limit?: number;
}): Promise<EntityWithAliases[]> {
  const limit = input.limit ?? 20;
  const fts = ftsQueryOr(input.query);
  if (fts === EMPTY_QUERY) return [];

  const pid = ensureProject(input.excludeProjectPath);

  const nameSQL = `SELECT ${ENTITY_COLS_E}
       FROM entities e
       JOIN entities_fts f ON f.rowid = e.rowid
       WHERE entities_fts MATCH ?
         AND e.entity_type = 'repo'
         AND e.cross_project = 0
         AND e.project_id IS NOT NULL
         AND e.project_id != ?
       ORDER BY rank
       LIMIT ?`;
  const aliasSQL = `SELECT DISTINCT ${ENTITY_COLS_E}
       FROM entities e
       JOIN entity_aliases a ON a.entity_id = e.id
       JOIN entity_aliases_fts af ON af.rowid = a.rowid
       WHERE entity_aliases_fts MATCH ?
         AND e.entity_type = 'repo'
         AND e.cross_project = 0
         AND e.project_id IS NOT NULL
         AND e.project_id != ?
       ORDER BY rank
       LIMIT ?`;

  // Independent degrade (see searchAsync) — best-effort supplemental RRF list.
  const [nameMatches, aliasMatches] = (await Promise.all([
    offloadAll(nameSQL, [fts, pid, limit]),
    offloadAll(aliasSQL, [fts, pid, limit]),
  ])) as [Entity[], Entity[]];

  const seen = new Set<string>();
  const merged: Entity[] = [];
  for (const e of [...nameMatches, ...aliasMatches]) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    merged.push(e);
  }

  return withAliasesOffloaded(merged.slice(0, limit));
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
    // Move aliases from source to target. The UNIQUE(alias_type, alias_value)
    // constraint is table-wide, so we UPDATE entity_id rather than
    // INSERT+DELETE — the source still owns the row and INSERT would always
    // conflict. Aliases that already exist on the target (same type+value)
    // are dropped via OR IGNORE + cleanup.
    d.query(
      `UPDATE OR IGNORE entity_aliases SET entity_id = ?, created_at = ?
       WHERE entity_id = ?`,
    ).run(targetId, Date.now(), sourceId);
    // Clean up any source aliases left behind (OR IGNORE skipped them because
    // target already has the same alias_type+alias_value pair)
    d.query("DELETE FROM entity_aliases WHERE entity_id = ?").run(sourceId);

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
    d.query(
      "DELETE FROM entity_relations WHERE entity_a = ? OR entity_b = ?",
    ).run(sourceId, sourceId);

    // Delete source — explicit alias delete so FTS5 triggers fire
    // (CASCADE deletes don't fire AFTER DELETE triggers in SQLite)
    d.query("DELETE FROM knowledge_entity_refs WHERE entity_id = ?").run(
      sourceId,
    );
    d.query("DELETE FROM entity_aliases WHERE entity_id = ?").run(sourceId);
    d.query("DELETE FROM entities WHERE id = ?").run(sourceId);

    // Update target timestamp
    d.query("UPDATE entities SET updated_at = ? WHERE id = ?").run(
      Date.now(),
      targetId,
    );

    d.exec("COMMIT");
    // Target absorbed source aliases — refresh its dedup embedding.
    reembedEntity(targetId);
  } catch (e) {
    try {
      d.exec("ROLLBACK");
    } catch (rbErr) {
      log.info("merge rollback failed:", rbErr);
    }
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
      log.info(
        `relation already exists: ${entityA} → ${entityB} (${relation})`,
      );
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
    .all(
      entityId,
      entityId,
      entityId,
      entityId,
      entityId,
    ) as EntityRelationResolved[];
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
      .get(
        entityA,
        entityB,
        entityB,
        entityA,
        relation,
      ) as EntityRelation | null;
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

/** Resolve a knowledge id (current or, post-2b, a superseded version) to its
 *  stable logical_id — the key all knowledge_entity_refs rows use (A2, #823).
 *  No-op today: a v1 row has id == logical_id. */
function logicalIdOf(knowledgeId: string): string {
  const r = db()
    .query("SELECT logical_id FROM knowledge WHERE id = ?")
    .get(knowledgeId) as { logical_id: string } | null;
  return r?.logical_id ?? knowledgeId;
}

/** Link a knowledge entry to an entity. */
export function linkKnowledge(knowledgeId: string, entityId: string): void {
  try {
    db()
      .query(
        `INSERT OR IGNORE INTO knowledge_entity_refs (knowledge_id, entity_id)
         VALUES (?, ?)`,
      )
      .run(logicalIdOf(knowledgeId), entityId);
  } catch (e: unknown) {
    // FK violation (entity or knowledge entry doesn't exist) — ignore
    if (e instanceof Error && /FOREIGN KEY/i.test(e.message)) {
      log.info(
        `cannot link knowledge ${knowledgeId} to entity ${entityId}: FK violation`,
      );
      return;
    }
    throw e;
  }
}

/** Unlink a knowledge entry from an entity. */
export function unlinkKnowledge(knowledgeId: string, entityId: string): void {
  db()
    .query(
      "DELETE FROM knowledge_entity_refs WHERE knowledge_id = ? AND entity_id = ?",
    )
    .run(logicalIdOf(knowledgeId), entityId);
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
    .all(logicalIdOf(knowledgeId)) as Entity[];
}

/** Get all knowledge logical_ids referencing an entity (A2: callers resolve the
 *  current entry via ltm.getByLogical, not ltm.get). */
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
    let group = grouped[displayType];
    if (!group) {
      group = [];
      grouped[displayType] = group;
    }
    group.push(e);
  }

  const lines: string[] = [
    "Known entities (resolve ambiguous references using these):",
  ];
  for (const [type, items] of Object.entries(grouped)) {
    lines.push(`  ${type}:`);
    for (const e of items) {
      const aliasStrs = e.aliases
        .filter((a) => a.alias_value !== e.canonical_name) // skip canonical dupe
        .map((a) => `${a.alias_type}:${a.alias_value}`);
      const aliasInfo = aliasStrs.length
        ? ` (aliases: ${aliasStrs.join(", ")})`
        : "";

      // Self-entity marker
      const selfMarker = e.entity_type === "self" ? " — you (the user)" : "";

      // Metadata brief (role/description)
      const metaInfo =
        e.entity_type === "self" ? "" : formatMetadataBrief(e.metadata);

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
/**
 * The full entity + alias registry used to match entity mentions in content.
 * Loading this is two full-table scans, so callers that re-sync many entries in
 * a loop (the curator) should load it ONCE via {@link syncEntityRefsBatch}
 * rather than once per entry.
 */
export interface EntityMatchRegistry {
  entities: Array<{ id: string; canonical_name: string }>;
  aliases: Array<{ entity_id: string; alias_value: string }>;
}

/** Load the entity + alias registry (two full-table scans). */
function loadEntityMatchRegistry(): EntityMatchRegistry {
  const entities = db()
    .query("SELECT id, canonical_name FROM entities")
    .all() as Array<{ id: string; canonical_name: string }>;
  const aliases = db()
    .query("SELECT entity_id, alias_value FROM entity_aliases")
    .all() as Array<{ entity_id: string; alias_value: string }>;
  return { entities, aliases };
}

export function syncEntityRefs(
  knowledgeId: string,
  content: string,
  registry?: EntityMatchRegistry,
): number {
  // Entity refs key on the stable logical_id (A2, #823) so they survive version
  // appends. The FK to knowledge(id) stays satisfied because logical_id equals
  // the never-physically-deleted first version's id.
  const logicalId = logicalIdOf(knowledgeId);

  // Clear existing refs for this knowledge entry. Runs even when the registry is
  // empty so stale refs are purged after all matching entities are removed.
  db()
    .query("DELETE FROM knowledge_entity_refs WHERE knowledge_id = ?")
    .run(logicalId);

  // Load the entities + aliases for matching. A batch caller passes a preloaded
  // registry so this isn't re-read once per entry (the curator N+1, #1010).
  const { entities: allEntities, aliases: allAliases } =
    registry ?? loadEntityMatchRegistry();

  if (!allEntities.length) return 0;

  const contentLower = content.toLowerCase();
  const linkedEntityIds = new Set<string>();

  // Min length to avoid false positives from short aliases like "Go", "CI", "DB"
  const MIN_MATCH_LEN = 3;

  // Check canonical names
  for (const e of allEntities) {
    if (
      e.canonical_name.length >= MIN_MATCH_LEN &&
      contentLower.includes(e.canonical_name.toLowerCase())
    ) {
      linkedEntityIds.add(e.id);
    }
  }

  // Check aliases
  for (const a of allAliases) {
    if (
      a.alias_value.length >= MIN_MATCH_LEN &&
      contentLower.includes(a.alias_value.toLowerCase())
    ) {
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
        .run(logicalId, entityId);
      count++;
    } catch (e: unknown) {
      // FK violation (entity or knowledge entry doesn't exist) — skip
      if (e instanceof Error && /FOREIGN KEY/i.test(e.message)) continue;
      throw e;
    }
  }

  return count;
}

/**
 * Re-sync entity refs for many entries while loading the entity/alias registry
 * exactly ONCE for the whole batch (the per-entry reload was the curator's N+1,
 * #1010). Per-item failures are logged and skipped so one bad entry can't abort
 * the rest — mirroring the curator's prior per-entry try/catch.
 *
 * @returns Total number of (knowledge, entity) links written across all items.
 */
export function syncEntityRefsBatch(
  items: ReadonlyArray<{ id: string; content: string }>,
): number {
  if (!items.length) return 0;
  // Load once. New entities are only created AFTER the curator's ref-sync loop,
  // so this snapshot stays authoritative for the whole batch.
  const registry = loadEntityMatchRegistry();
  let total = 0;
  for (const item of items) {
    try {
      total += syncEntityRefs(item.id, item.content, registry);
    } catch (err) {
      log.warn(`entity ref sync failed for ${item.id}:`, err);
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Entity auto-dedup (#462)
// ---------------------------------------------------------------------------

/**
 * Minimum embedding cosine similarity for two same-type entities to be
 * considered duplicates. Lower than the 0.935 knowledge dedup threshold
 * because entity names are short and noisy ("GitHub Actions" ↔ "GHA").
 */
export const ENTITY_EMBEDDING_DEDUP_THRESHOLD = 0.85;
/**
 * Similarity at/above which a pair is auto-merged silently. Pairs in
 * [ENTITY_EMBEDDING_DEDUP_THRESHOLD, ENTITY_AUTO_MERGE_THRESHOLD) are only
 * *suggested* (surfaced in CLI / dashboard for explicit confirmation).
 */
export const ENTITY_AUTO_MERGE_THRESHOLD = 0.92;
/** Canonical-name Jaccard at/above which the name signal boosts a pair. */
const ENTITY_NAME_JACCARD_THRESHOLD = 0.5;
/** Small additive boost applied to a pair's score when a softer signal fires. */
const ENTITY_SIGNAL_BOOST = 0.05;
/**
 * Score assigned when one canonical name is a proper subset of the other
 * ("Seylan" ⊂ "Seylan Çinar Kaya"). Deliberately in the *suggestion* band
 * ([ENTITY_EMBEDDING_DEDUP_THRESHOLD, ENTITY_AUTO_MERGE_THRESHOLD)) — name
 * containment surfaces a candidate for the user to confirm but never
 * auto-merges, because a bare first name is ambiguous ("John" ⊂ both
 * "John Smith" and "John Doe").
 */
const ENTITY_NAME_CONTAINMENT_SCORE = 0.9;

/** A cluster of duplicate entities sharing one survivor. */
export type EntityDedupCluster = {
  surviving: { id: string; name: string };
  merged: Array<{ id: string; name: string; similarity: number }>;
};

export type EntityDedupResult = {
  /** Auto-merge tier (similarity ≥ ENTITY_AUTO_MERGE_THRESHOLD or alias overlap). */
  merged: EntityDedupCluster[];
  /** Suggestion tier (≥ dedup threshold, < auto-merge threshold). */
  suggested: EntityDedupCluster[];
  /** All pairwise similarities (key = entityPairKey) for calibration. */
  pairSimilarities: Map<string, number>;
  /** id → canonical name for every input entity (survives deletion). */
  names: Map<string, string>;
};

/** Order-independent key for an entity pair (mirrors ltm.dedupPairKey). */
export function entityPairKey(idA: string, idB: string): string {
  return idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;
}

/** Jaccard word-overlap of two canonical names (using search term filtering). */
function nameJaccard(a: string, b: string): number {
  const wa = new Set(filterTerms(a).map((w) => w.toLowerCase()));
  const wb = new Set(filterTerms(b).map((w) => w.toLowerCase()));
  if (wa.size === 0 || wb.size === 0) return 0;
  const intersection = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * True when one canonical name's word set is a non-empty *proper* subset of the
 * other's — e.g. "Seylan" ⊂ "Seylan Çinar Kaya", "GitHub Actions" ⊂ "GitHub
 * Actions CI". Catches first-name/full-name (and prefix/abbreviation) duplicates
 * that Jaccard misses: its denominator is inflated by the longer name's extra
 * tokens (1/3 for "Seylan" vs "Seylan Çinar Kaya"), keeping it under the 0.5
 * boost threshold. Order-independent.
 */
function nameContainment(a: string, b: string): boolean {
  const wa = new Set(filterTerms(a).map((w) => w.toLowerCase()));
  const wb = new Set(filterTerms(b).map((w) => w.toLowerCase()));
  if (wa.size === 0 || wb.size === 0) return false;
  if (wa.size === wb.size) return false; // equal size → identical handled by Jaccard
  const [small, large] = wa.size < wb.size ? [wa, wb] : [wb, wa];
  for (const w of small) {
    if (!large.has(w)) return false;
  }
  return true;
}

/**
 * Deduplicate entities using embedding similarity + multi-signal scoring.
 *
 * Signals (issue #462):
 *  - Same entity_type — REQUIRED (never merge a person with a service).
 *  - Embedding cosine similarity — primary signal.
 *  - Exact alias-value overlap — strong; forces the auto-merge tier.
 *  - Canonical-name Jaccard ≥ 0.5 — moderate boost.
 *  - Shared linked-knowledge — small boost.
 *
 * Uses greedy star clustering (no transitivity — mirrors ltm._dedup) so that
 * A~B and B~C but not A~C only merges the strongest pair. Survivor per cluster:
 * most aliases (richest) → most recent → shortest canonical name.
 *
 * `dryRun` defaults to true — callers must pass { dryRun: false } to merge.
 * Only the auto-merge tier is ever applied; suggestions are never auto-merged.
 */
export async function deduplicateEntities(
  projectPath?: string,
  opts?: { dryRun?: boolean; threshold?: number },
): Promise<EntityDedupResult> {
  const dryRun = opts?.dryRun ?? true;
  const entities = projectPath ? forProject(projectPath) : listAll();
  const names = new Map(entities.map((e) => [e.id, e.canonical_name]));

  const empty: EntityDedupResult = {
    merged: [],
    suggested: [],
    pairSimilarities: new Map(),
    names,
  };
  if (entities.length < 2) return empty;

  const dedupThreshold =
    opts?.threshold ??
    loadEntityCalibratedThreshold(
      projectPath ? ensureProject(projectPath) : null,
    ) ??
    ENTITY_EMBEDDING_DEDUP_THRESHOLD;

  // --- Load embeddings for the candidate entities (if available) ---
  const embeddingMap = new Map<string, Float32Array>();
  {
    const ids = entities.map((e) => e.id);
    const placeholders = ids.map(() => "?").join(",");
    const rows = db()
      .query(
        `SELECT id, embedding FROM entities WHERE embedding IS NOT NULL AND id IN (${placeholders})`,
      )
      .all(...ids) as Array<{ id: string; embedding: Buffer }>;
    for (const row of rows) {
      try {
        embeddingMap.set(row.id, embedding.fromBlob(row.embedding));
      } catch {
        log.info(`skipping corrupted embedding for entity ${row.id}`);
      }
    }
  }

  // Pre-compute lowercased alias sets per entity.
  const aliasSets = new Map<string, Set<string>>();
  for (const e of entities) {
    aliasSets.set(
      e.id,
      new Set(e.aliases.map((a) => a.alias_value.toLowerCase())),
    );
  }

  // Batch-load linked-knowledge sets (single query instead of N+1).
  const knowledgeSets = new Map<string, Set<string>>();
  {
    const rows = db()
      .query("SELECT entity_id, knowledge_id FROM knowledge_entity_refs")
      .all() as Array<{ entity_id: string; knowledge_id: string }>;
    for (const r of rows) {
      let s = knowledgeSets.get(r.entity_id);
      if (!s) {
        s = new Set();
        knowledgeSets.set(r.entity_id, s);
      }
      s.add(r.knowledge_id);
    }
  }

  // --- Build neighbor map (O(n²) pairwise) ---
  type DedupHit = { id: string; score: number; forceMerge: boolean };
  const neighborMap = new Map<string, DedupHit[]>();
  const pairSimilarities = new Map<string, number>(); // raw cosine (for calibration)
  const pairScores = new Map<string, number>(); // combined/boosted score (for tier assignment)

  for (const entry of entities) {
    const neighbors: DedupHit[] = [];
    const entryVec = embeddingMap.get(entry.id);

    for (const other of entities) {
      if (other.id === entry.id) continue;
      // REQUIRED gate: same entity_type or never a candidate.
      if (other.entity_type !== entry.entity_type) continue;

      // Embedding cosine similarity (primary signal).
      let similarity = 0;
      if (entryVec) {
        const otherVec = embeddingMap.get(other.id);
        if (otherVec && entryVec.length === otherVec.length) {
          similarity = embedding.cosineSimilarity(entryVec, otherVec);
        }
      }

      // Alias-value overlap (strong → force auto-merge regardless of cosine).
      const aSet = aliasSets.get(entry.id);
      const bSet = aliasSets.get(other.id);
      let aliasOverlap = false;
      if (aSet && bSet) {
        for (const v of aSet) {
          if (bSet.has(v)) {
            aliasOverlap = true;
            break;
          }
        }
      }

      // Canonical-name Jaccard (moderate boost).
      const jaccard = nameJaccard(entry.canonical_name, other.canonical_name);

      // Shared linked-knowledge (small boost).
      const kA = knowledgeSets.get(entry.id);
      const kB = knowledgeSets.get(other.id);
      let sharedKnowledge = false;
      if (kA && kB)
        for (const k of kA) {
          if (kB.has(k)) {
            sharedKnowledge = true;
            break;
          }
        }

      // Name containment ("Seylan" ⊂ "Seylan Çinar Kaya") — a strong signal
      // that Jaccard structurally misses. Suggestion-only (never force-merge).
      const containment = nameContainment(
        entry.canonical_name,
        other.canonical_name,
      );

      // Combined score: cosine, lifted by softer signals.
      let score = similarity;
      if (jaccard >= ENTITY_NAME_JACCARD_THRESHOLD) {
        score = Math.max(score, jaccard);
        score += ENTITY_SIGNAL_BOOST;
      }
      if (sharedKnowledge) score += ENTITY_SIGNAL_BOOST;
      // Lift containment pairs into the suggestion band — applied via max (no
      // additive boost) so name containment alone can't reach the auto-merge
      // threshold and silently fold ambiguous first-name matches.
      if (containment) {
        score = Math.max(score, ENTITY_NAME_CONTAINMENT_SCORE);
      }
      score = Math.min(score, 1);

      // Record raw cosine for calibration (cosine only; > 0) and combined
      // score for tier assignment when the survivor differs from the center.
      const pk = entityPairKey(entry.id, other.id);
      if (similarity > 0 && !pairSimilarities.has(pk)) {
        pairSimilarities.set(pk, similarity);
      }
      const existing = pairScores.get(pk);
      if (existing === undefined || score > existing) {
        pairScores.set(pk, aliasOverlap ? 1 : score);
      }

      // Containment always qualifies as a neighbor (so it surfaces even when a
      // project's calibrated threshold sits above the containment score), but
      // never as a force-merge.
      const isNeighbor = aliasOverlap || containment || score >= dedupThreshold;
      if (isNeighbor) {
        neighbors.push({
          id: other.id,
          score: aliasOverlap ? 1 : score,
          forceMerge: aliasOverlap || score >= ENTITY_AUTO_MERGE_THRESHOLD,
        });
      }
    }
    neighbors.sort((a, b) => b.score - a.score);
    neighborMap.set(entry.id, neighbors);
  }

  // --- Greedy star clustering (no transitivity) ---
  const claimed = new Set<string>();
  const rawClusters = new Map<string, DedupHit[]>();
  const sortedIds = [...neighborMap.keys()].sort(
    (a, b) =>
      (neighborMap.get(b)?.length ?? 0) - (neighborMap.get(a)?.length ?? 0),
  );

  for (const centerId of sortedIds) {
    if (claimed.has(centerId)) continue;
    claimed.add(centerId);
    const hits = neighborMap.get(centerId);
    if (!hits) continue;
    const members: DedupHit[] = [];
    for (const hit of hits) {
      if (claimed.has(hit.id)) continue;
      claimed.add(hit.id);
      members.push(hit);
    }
    if (members.length > 0) rawClusters.set(centerId, members);
  }

  // --- Build clusters, pick survivors, split into tiers ---
  const entityById = new Map(entities.map((e) => [e.id, e]));
  const merged: EntityDedupCluster[] = [];
  const suggested: EntityDedupCluster[] = [];

  for (const [centerId, hits] of rawClusters) {
    const all = [centerId, ...hits.map((h) => h.id)]
      .map((id) => entityById.get(id))
      .filter((e): e is EntityWithAliases => Boolean(e));
    if (all.length < 2) continue;

    // Survivor: most aliases → most recent → shortest canonical name.
    const sorted = [...all].sort((a, b) => {
      const aliasDiff = b.aliases.length - a.aliases.length;
      if (aliasDiff !== 0) return aliasDiff;
      if (b.updated_at !== a.updated_at) return b.updated_at - a.updated_at;
      return a.canonical_name.length - b.canonical_name.length;
    });
    const survivor = sorted[0];

    // Tier each non-survivor member by its pair score vs the survivor.
    const scoreFor = (memberId: string): { score: number; force: boolean } => {
      // Direct alias-value overlap with the survivor always forces a merge,
      // even if the member only clustered transitively via the center.
      const survivorAliases = aliasSets.get(survivor.id);
      const memberAliases = aliasSets.get(memberId);
      if (survivorAliases && memberAliases) {
        for (const v of memberAliases) {
          if (survivorAliases.has(v)) return { score: 1, force: true };
        }
      }
      const fromCenter = neighborMap
        .get(survivor.id)
        ?.find((h) => h.id === memberId);
      if (fromCenter)
        return { score: fromCenter.score, force: fromCenter.forceMerge };
      const fromMember = neighborMap
        .get(memberId)
        ?.find((h) => h.id === survivor.id);
      if (fromMember)
        return { score: fromMember.score, force: fromMember.forceMerge };
      // Fallback: use the combined/boosted score (not raw cosine) to preserve
      // the Jaccard/knowledge boosts when the survivor differs from the center.
      const pk = entityPairKey(survivor.id, memberId);
      const s = pairScores.get(pk) ?? 0;
      return { score: s, force: s >= ENTITY_AUTO_MERGE_THRESHOLD };
    };

    const mergeMembers: EntityDedupCluster["merged"] = [];
    const suggestMembers: EntityDedupCluster["merged"] = [];
    for (const m of sorted.slice(1)) {
      const { score, force } = scoreFor(m.id);
      const entry = { id: m.id, name: m.canonical_name, similarity: score };
      if (force) mergeMembers.push(entry);
      else suggestMembers.push(entry);
    }

    if (mergeMembers.length > 0) {
      merged.push({
        surviving: { id: survivor.id, name: survivor.canonical_name },
        merged: mergeMembers,
      });
      if (!dryRun) {
        for (const m of mergeMembers) merge(survivor.id, m.id);
      }
    }
    if (suggestMembers.length > 0) {
      suggested.push({
        surviving: { id: survivor.id, name: survivor.canonical_name },
        merged: suggestMembers,
      });
    }
  }

  merged.sort((a, b) => b.merged.length - a.merged.length);
  suggested.sort((a, b) => b.merged.length - a.merged.length);

  return { merged, suggested, pairSimilarities, names };
}

// ---------------------------------------------------------------------------
// Entity dedup adaptive threshold calibration (#462)
//
// Reuses the shared `dedup_feedback` table with kind='entity' so entity and
// knowledge feedback coexist without a second table. All queries here scope to
// kind='entity'; the knowledge calibration path (ltm.ts) implicitly operates on
// kind='knowledge' (the column default).
// ---------------------------------------------------------------------------

export type EntityDedupFeedbackSource =
  | "auto_dedup"
  | "cli_yes"
  | "cli_interactive"
  | "dashboard"
  // Audit-only: a person entity absorbed into the self entity. Excluded from
  // threshold calibration (it is tautological — always similarity 1.0).
  | "self_merge";

const MIN_ENTITY_CALIBRATION_SAMPLES = 20;
/** Only record auto-signals for pairs with similarity >= this floor. */
const ENTITY_AUTO_SIGNAL_MIN_SIMILARITY = 0.8;
/**
 * Return a Set of "nameA\x1fnameB" keys for entity pairs that have been
 * explicitly dismissed (accepted=0) via the dashboard. Both orderings are
 * included so callers can do a single `has()` check.
 *
 * Dismissals are name-based; renaming an entity resets its dismiss state
 * (the old names won't match), which is the correct behavior since the
 * entity's identity has changed.
 */
export function getDismissedEntityPairs(): Set<string> {
  const rows = db()
    .query(
      `SELECT entry_a_title, entry_b_title FROM dedup_feedback
       WHERE kind = 'entity' AND accepted = 0 AND source = 'dashboard'
         AND project_id IS NULL`,
    )
    .all() as Array<{ entry_a_title: string; entry_b_title: string }>;
  const dismissed = new Set<string>();
  for (const r of rows) {
    dismissed.add(`${r.entry_a_title}\x1f${r.entry_b_title}`);
    dismissed.add(`${r.entry_b_title}\x1f${r.entry_a_title}`);
  }
  return dismissed;
}

/** Max auto-signal pairs to record per dedup run (closest to threshold). */
const ENTITY_AUTO_SIGNAL_MAX_PAIRS = 50;
/** Max feedback rows to keep per project (prevents unbounded growth). */
const MAX_ENTITY_FEEDBACK_ROWS_PER_PROJECT = 500;

/** Record a single entity dedup feedback row (kind='entity'). */
export function recordEntityDedupFeedback(input: {
  projectId: string | null;
  entryATitle: string;
  entryBTitle: string;
  similarity: number;
  accepted: boolean;
  source: EntityDedupFeedbackSource;
}): void {
  db()
    .query(
      `INSERT INTO dedup_feedback
         (project_id, entry_a_title, entry_b_title, similarity, accepted, source, created_at, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'entity')`,
    )
    .run(
      input.projectId,
      input.entryATitle,
      input.entryBTitle,
      input.similarity,
      input.accepted ? 1 : 0,
      input.source,
      Date.now(),
    );
}

/**
 * Record automatic calibration signals from a post-curation entity dedup sweep.
 * Records only **reject** signals — non-merged pairs with cosine similarity in
 * [floor, threshold). Accept signals from auto-merge are tautological, so they
 * are excluded (manual cli_yes/cli_interactive provide the accept side).
 */
export function recordEntityAutoSignals(
  projectId: string | null,
  result: EntityDedupResult,
): void {
  // Collect merged/suggested pair keys to exclude from reject signals.
  const decidedPairs = new Set<string>();
  for (const cluster of [...result.merged, ...result.suggested]) {
    for (const m of cluster.merged) {
      decidedPairs.add(entityPairKey(cluster.surviving.id, m.id));
    }
  }

  type Signal = {
    entryATitle: string;
    entryBTitle: string;
    similarity: number;
  };
  const signals: Signal[] = [];
  for (const [pk, sim] of result.pairSimilarities) {
    if (sim < ENTITY_AUTO_SIGNAL_MIN_SIMILARITY) continue;
    if (decidedPairs.has(pk)) continue; // merged/suggested — skip
    const [idA, idB] = pk.split(":");
    const nameA = result.names.get(idA);
    const nameB = result.names.get(idB);
    if (!nameA || !nameB) continue;
    signals.push({ entryATitle: nameA, entryBTitle: nameB, similarity: sim });
  }

  const currentThreshold =
    loadEntityCalibratedThreshold(projectId) ??
    ENTITY_EMBEDDING_DEDUP_THRESHOLD;
  signals.sort(
    (a, b) =>
      Math.abs(a.similarity - currentThreshold) -
      Math.abs(b.similarity - currentThreshold),
  );
  const capped = signals.slice(0, ENTITY_AUTO_SIGNAL_MAX_PAIRS);

  // Prune + insert atomically in one transaction. Without this each
  // recordEntityDedupFeedback() below auto-commits on its own (up to
  // ENTITY_AUTO_SIGNAL_MAX_PAIRS write-lock cycles per sweep); wrapping
  // collapses the sweep into a single commit and keeps prune+insert consistent.
  withTransaction(() => {
    pruneEntityDedupFeedback(projectId);

    for (const s of capped) {
      recordEntityDedupFeedback({
        projectId,
        entryATitle: s.entryATitle,
        entryBTitle: s.entryBTitle,
        similarity: s.similarity,
        accepted: false,
        source: "auto_dedup",
      });
    }
  });
}

/** Get all entity feedback for a project (for calibration). */
export function getEntityDedupFeedback(
  projectId: string | null,
): Array<{ similarity: number; accepted: boolean; source: string }> {
  const rows = (
    projectId !== null
      ? db()
          .query(
            "SELECT similarity, accepted, source FROM dedup_feedback WHERE kind = 'entity' AND source != 'self_merge' AND project_id = ? ORDER BY similarity",
          )
          .all(projectId)
      : db()
          .query(
            "SELECT similarity, accepted, source FROM dedup_feedback WHERE kind = 'entity' AND source != 'self_merge' AND project_id IS NULL ORDER BY similarity",
          )
          .all()
  ) as Array<{ similarity: number; accepted: number; source: string }>;
  return rows.map((r) => ({
    similarity: r.similarity,
    accepted: r.accepted === 1,
    source: r.source,
  }));
}

/** Quick count of entity feedback rows for a project. */
export function getEntityDedupFeedbackCount(projectId: string | null): number {
  const row = (
    projectId !== null
      ? db()
          .query(
            "SELECT COUNT(*) as cnt FROM dedup_feedback WHERE kind = 'entity' AND source != 'self_merge' AND project_id = ?",
          )
          .get(projectId)
      : db()
          .query(
            "SELECT COUNT(*) as cnt FROM dedup_feedback WHERE kind = 'entity' AND source != 'self_merge' AND project_id IS NULL",
          )
          .get()
  ) as { cnt: number } | null;
  return row?.cnt ?? 0;
}

/** Prune old entity feedback rows, keeping the most recent rows.
 *  self_merge audit rows are excluded — they must not be pruned so the
 *  absorb trail remains durable and queryable. */
export function pruneEntityDedupFeedback(projectId: string | null): void {
  const count = getEntityDedupFeedbackCount(projectId);
  if (count <= MAX_ENTITY_FEEDBACK_ROWS_PER_PROJECT) return;
  const excess = count - MAX_ENTITY_FEEDBACK_ROWS_PER_PROJECT;
  if (projectId !== null) {
    db()
      .query(
        `DELETE FROM dedup_feedback WHERE id IN (
           SELECT id FROM dedup_feedback WHERE kind = 'entity' AND source != 'self_merge' AND project_id = ?
           ORDER BY created_at ASC LIMIT ?
         )`,
      )
      .run(projectId, excess);
  } else {
    db()
      .query(
        `DELETE FROM dedup_feedback WHERE id IN (
           SELECT id FROM dedup_feedback WHERE kind = 'entity' AND source != 'self_merge' AND project_id IS NULL
           ORDER BY created_at ASC LIMIT ?
         )`,
      )
      .run(excess);
  }
}

/**
 * Calibrate the entity dedup threshold by accuracy maximization over recorded
 * feedback. Returns null until MIN_ENTITY_CALIBRATION_SAMPLES are collected.
 * Mirrors ltm.calibrateDedupThreshold but clamps to the entity range.
 */
export function calibrateEntityDedupThreshold(
  projectId: string | null,
): number | null {
  const feedback = getEntityDedupFeedback(projectId);
  if (feedback.length < MIN_ENTITY_CALIBRATION_SAMPLES) return null;

  const accepted = feedback.filter((f) => f.accepted);
  const rejected = feedback.filter((f) => !f.accepted);

  // Edge case: all accept, no rejects
  if (rejected.length === 0) {
    const minAccepted = Math.min(...accepted.map((f) => f.similarity));
    return Math.max(0.8, minAccepted - 0.005);
  }
  // Edge case: all reject, no accepts → keep default
  if (accepted.length === 0) {
    log.warn(
      "entity dedup calibration: all feedback is reject — keeping default threshold",
    );
    return null;
  }

  const allSims = [...new Set(feedback.map((f) => f.similarity))].sort(
    (a, b) => a - b,
  );
  let bestThreshold = ENTITY_EMBEDDING_DEDUP_THRESHOLD;
  let bestAccuracy = -1;
  for (let i = 0; i < allSims.length - 1; i++) {
    const candidate = (allSims[i] + allSims[i + 1]) / 2;
    const correctAccepted = accepted.filter(
      (f) => f.similarity >= candidate,
    ).length;
    const correctRejected = rejected.filter(
      (f) => f.similarity < candidate,
    ).length;
    const accuracy = (correctAccepted + correctRejected) / feedback.length;
    if (
      accuracy > bestAccuracy ||
      (accuracy === bestAccuracy && candidate > bestThreshold)
    ) {
      bestAccuracy = accuracy;
      bestThreshold = candidate;
    }
  }
  // Clamp to the entity range (lower than knowledge's [0.85, 0.98]).
  return Math.max(0.8, Math.min(0.95, bestThreshold));
}

/** Persist the calibrated entity dedup threshold for a project. */
export function saveEntityCalibratedThreshold(
  projectId: string | null,
  threshold: number,
  sampleSize: number,
): void {
  const key = `entity_dedup_threshold:${projectId ?? "global"}`;
  setKV(
    key,
    JSON.stringify({ threshold, sampleSize, calibratedAt: Date.now() }),
  );
}

/** Load the calibrated entity dedup threshold for a project, or null. */
export function loadEntityCalibratedThreshold(
  projectId: string | null,
): number | null {
  const key = `entity_dedup_threshold:${projectId ?? "global"}`;
  const raw = getKV(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed.threshold === "number" ? parsed.threshold : null;
  } catch {
    return null;
  }
}
