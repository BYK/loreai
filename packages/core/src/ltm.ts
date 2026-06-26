import { uuidv7 } from "uuidv7";
import { db, ensureProject, getKV, setKV, withTransaction } from "./db";
import { config } from "./config";
import {
  ftsQuery,
  ftsQueryOr,
  EMPTY_QUERY,
  extractTopTerms,
  filterTerms,
  runRelaxedSearch,
  runRelaxedSearchAsync,
} from "./search";
import * as embedding from "./embedding";
import {
  offloadAll,
  offloadAllOrTimeout,
  READ_JOB_TIMED_OUT,
} from "./read-offload";
import { ReadPathTimer } from "./read-telemetry";
import { sessionVerifierVerdict } from "./tool-trace";
import * as latReader from "./lat-reader";
import {
  extractReferences,
  type Reference,
  type ReferenceResolver,
} from "./references";
import * as log from "./log";

// ~3 chars per token — validated as best heuristic against real API data.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** Sensitivity classification — product hint guiding auto-promotion decisions. */
export type Sensitivity = "normal" | "sensitive" | "restricted";
/** Promotion intent — tracks the personal \u2192 team DB promotion flow. */
export type PromotionStatus = "nominated" | "suggested" | "promoted";
/** Approval state — used in team DB for admin approval workflow. */
export type ApprovalStatus = "auto" | "pending" | "approved" | "rejected";

/** Per-entry metadata blob — intentionally narrow. The column exists for
 *  non-queryable per-version data; queryable fields get dedicated columns (see
 *  worker_provider_id / worker_model_id, v35 — db.ts:1000-1004). (#627 Phase 1.) */
export type KnowledgeMetadata = {
  /** Commit SHA the session was on when this entry was minted
   *  (`synthetic-tools.ts` probe → `applySyntheticResolution` → SessionState).
   *  Format: 7-40 char lowercase hex. Never validated here — the probe guard at
   *  synthetic-tools.ts:621 already rejects malformed SHAs. */
  gitHead?: string;
};

/** Parse the raw `metadata` TEXT column into a typed object. Tolerant: a
 *  malformed/garbled value (e.g. user-edited `.lore.md`) yields `null` + warn
 *  rather than a throw — metadata is a slot, not a constraint. (#627 Phase 1.) */
function parseMetadata(raw: string | null): KnowledgeMetadata | null {
  if (raw == null) return null;
  try {
    const obj = JSON.parse(raw);
    if (obj == null || typeof obj !== "object") return null;
    return obj as KnowledgeMetadata;
  } catch (e) {
    log.warn("ltm.parseMetadata: malformed JSON, dropping:", e);
    return null;
  }
}

/** Stringify a metadata object for INSERT/UPDATE. `undefined` and empty objects
 *  both serialize to NULL so the column stays clean for entries that never opt in. */
function stringifyMetadata(m: KnowledgeMetadata | undefined): string | null {
  if (m == null) return null;
  const json = JSON.stringify(m);
  return json === "{}" ? null : json;
}

/** Apply the metadata column parse to a raw DB row. Every `KnowledgeEntry`
 *  consumer site hydrates through this so the parsed type is the single source
 *  of truth. The generic bound is wide on purpose — sql.js `.all()` returns
 *  `Record<string, unknown>[]`, and we only need `row.metadata` to be a string
 *  (or null). (#627 Phase 1.) */
export function hydrateKnowledgeEntry<T extends Record<string, unknown>>(
  row: T,
): T & { metadata: KnowledgeMetadata | null } {
  return {
    ...row,
    metadata: parseMetadata(row.metadata as string | null),
  };
}

export type KnowledgeEntry = {
  id: string;
  /** Stable entry identity across versions (A2, #823). For a v1/unversioned row
   *  this equals `id`; cross-reference linkages (refs/transfers/markers) key on
   *  this, never the per-version `id`. */
  logical_id: string;
  project_id: string | null;
  category: string;
  title: string;
  content: string;
  source_session: string | null;
  cross_project: number;
  confidence: number;
  created_at: number;
  updated_at: number;
  metadata: KnowledgeMetadata | null;
  // Multi-user attribution & sync (v29)
  created_by: string | null;
  updated_by: string | null;
  sensitivity: Sensitivity;
  promotion_status: PromotionStatus | null;
  promoted_at: number | null;
  approval_status: ApprovalStatus;
  approved_by: string | null;
  approved_at: number | null;
  source_user_id: string | null;
  source_entry_id: string | null;
  last_accessed_at: number | null;
  // Worker source attribution (v35): which model produced this entry.
  // Nullable for backward compatibility with pre-v35 rows.
  worker_provider_id: string | null;
  worker_model_id: string | null;
  // Confidence lifecycle (v48): when relevance was last confirmed (injected,
  // recalled, or curator-reconfirmed). The decay pass uses this to age out
  // unreinforced entries. Nullable for pre-v48 rows (backfilled to updated_at).
  last_reinforced_at: number | null;
};

/** Columns to select for KnowledgeEntry — excludes the embedding BLOB
 *  (4KB per entry) which is only needed by vectorSearch() in embedding.ts. */
const KNOWLEDGE_COLS =
  "id, project_id, category, title, content, source_session, cross_project, confidence, created_at, updated_at, metadata, created_by, updated_by, sensitivity, promotion_status, promoted_at, approval_status, approved_by, approved_at, source_user_id, source_entry_id, last_accessed_at, worker_provider_id, worker_model_id, last_reinforced_at, logical_id";

/** Same columns with table alias prefix for use in JOIN queries. `confidence` and
 *  `last_reinforced_at` live on the metric register (alias `m`), not the immutable
 *  knowledge version row (A2 sub-PR 3b, #823) — so every query using this MUST also
 *  `LEFT JOIN knowledge_meta m ON m.logical_id = k.logical_id` (LEFT + COALESCE
 *  default mirrors the knowledge_current view, so a meta-less row never vanishes). */
const KNOWLEDGE_COLS_K =
  "k.id, k.project_id, k.category, k.title, k.content, k.source_session, k.cross_project, COALESCE(m.confidence, 1.0) AS confidence, k.created_at, k.updated_at, k.metadata, k.created_by, k.updated_by, k.sensitivity, k.promotion_status, k.promoted_at, k.approval_status, k.approved_by, k.approved_at, k.source_user_id, k.source_entry_id, k.last_accessed_at, k.worker_provider_id, k.worker_model_id, m.last_reinforced_at, k.logical_id";

/**
 * Upsert the metric-register row for a logical entry (A2 sub-PR 3b, #823).
 * `confidence` + `last_reinforced_at` are the mutable per-entry metrics, keyed by
 * the STABLE logical_id (one row across all versions), not the immutable knowledge
 * version rows. `create()` mints the row; the lifecycle ops below mutate it.
 *
 * `updated_at` is the register's own clock (future sync cursor / CRDT tiebreak):
 * a synced-metric CHANGE (confidence) bumps it; a pure relevance touch
 * (`last_reinforced_at` alone, via markInjected) must NOT — so injection stays
 * sync-silent. ON CONFLICT keeps it idempotent for cross-machine re-create.
 */
function insertMeta(
  logicalId: string,
  confidence: number,
  lastReinforcedAt: number | null,
  now: number,
): void {
  db()
    .query(
      `INSERT INTO knowledge_meta (logical_id, confidence, last_reinforced_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(logical_id) DO UPDATE SET
         confidence = excluded.confidence,
         last_reinforced_at = excluded.last_reinforced_at,
         updated_at = excluded.updated_at`,
    )
    .run(logicalId, confidence, lastReinforcedAt, now);
}

export function create(input: {
  projectPath?: string;
  category: string;
  title: string;
  content: string;
  session?: string;
  scope: "project" | "global";
  crossProject?: boolean;
  /** Explicit ID to use — for cross-machine import via agents-file. Defaults to a new UUIDv7. */
  id?: string;
  /** Initial confidence (0.0–1.0). Default 1.0. Controls injection priority for preferences. */
  confidence?: number;
  /** User ID who created this entry. Null for system-created entries. */
  createdBy?: string;
  /** Sensitivity classification — guides auto-promotion decisions. Default 'normal'. */
  sensitivity?: Sensitivity;
  /** Worker model providerID that produced this entry (curator / pattern-extract). */
  workerProviderID?: string;
  /** Worker model ID that produced this entry. */
  workerModelID?: string;
  /** Per-entry metadata (e.g. `gitHead` from the session-start probe, #627
   *  Phase 1). Stored as JSON in the `metadata` TEXT column. `undefined` →
   *  NULL; an empty object → NULL (so the column stays clean for entries that
   *  never opt in). Parsed back into a typed object on read. */
  metadata?: KnowledgeMetadata;
}): string {
  const pid =
    input.scope === "project" && input.projectPath
      ? ensureProject(input.projectPath)
      : null;

  // IF-2: Global entries (pid=null) must be cross-project to avoid a data hole
  // where forSession() can't find them in either the project or cross-project pool.
  const crossProject = pid === null ? true : (input.crossProject ?? false);

  // Dedup guard: if an entry with the same project_id + title already exists,
  // update its content instead of inserting a duplicate. This prevents the
  // curator from creating multiple entries for the same concept across sessions.
  // Also checks cross-project entries to prevent the curator from creating
  // project-scoped duplicates of globally-shared knowledge.
  // Note: when an explicit id is provided (cross-machine import), skip dedup —
  // the caller (importFromFile) already handles duplicate detection by UUID.
  if (!input.id) {
    // First check same project_id
    // Return the stable logical_id (not the per-version id): update() below
    // appends a new version, which would supersede the version id we matched.
    const existing = (
      pid !== null
        ? db()
            .query(
              "SELECT logical_id FROM knowledge_current WHERE project_id = ? AND LOWER(title) = LOWER(?) AND confidence > 0 LIMIT 1",
            )
            .get(pid, input.title)
        : db()
            .query(
              "SELECT logical_id FROM knowledge_current WHERE project_id IS NULL AND LOWER(title) = LOWER(?) AND confidence > 0 LIMIT 1",
            )
            .get(input.title)
    ) as { logical_id: string } | null;

    // Build the update payload — forward confidence when the caller provided one
    // so the curator's scoring intent isn't silently dropped on dedup.
    const dedupUpdate = {
      content: input.content,
      ...(input.confidence != null ? { confidence: input.confidence } : {}),
    };

    if (existing) {
      update(existing.logical_id, dedupUpdate);
      return existing.logical_id;
    }

    // Also check cross-project entries — prevents creating project-scoped
    // duplicates of entries that already exist as cross-project knowledge.
    const crossExisting = db()
      .query(
        "SELECT logical_id FROM knowledge_current WHERE cross_project = 1 AND LOWER(title) = LOWER(?) AND confidence > 0 LIMIT 1",
      )
      .get(input.title) as { logical_id: string } | null;

    if (crossExisting) {
      update(crossExisting.logical_id, dedupUpdate);
      return crossExisting.logical_id;
    }

    // Fuzzy dedup: check for title-similar entries via FTS5 + word-overlap.
    // This catches near-duplicates the curator creates with slightly different
    // titles for the same concept (e.g. "Upgrade lock bug" vs "Upgrade binary
    // lock re-entry bug"). Placed after exact checks (cheaper checks first).
    const fuzzyMatch = findFuzzyDuplicate({
      title: input.title,
      projectId: pid,
    });
    if (fuzzyMatch) {
      // findFuzzyDuplicate returns a version id; resolve to the stable logical_id.
      const logicalId = logicalIdOf(fuzzyMatch.id);
      update(logicalId, dedupUpdate);
      return logicalId;
    }
  }

  const id = input.id ?? uuidv7();
  const now = Date.now();
  const confidence =
    input.confidence != null ? Math.max(0, Math.min(1, input.confidence)) : 1.0;
  db()
    .query(
      `INSERT INTO knowledge (id, logical_id, project_id, category, title, content, source_session, cross_project, created_at, updated_at, created_by, sensitivity, worker_provider_id, worker_model_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      id, // logical_id: a fresh entry is its own logical identity (version 1)
      pid,
      input.category,
      input.title,
      input.content,
      input.session ?? null,
      crossProject ? 1 : 0,
      now,
      now,
      input.createdBy ?? null,
      input.sensitivity ?? "normal",
      input.workerProviderID ?? null,
      input.workerModelID ?? null,
      stringifyMetadata(input.metadata),
    );
  // The mutable metrics live on the register, keyed by logical_id (A2 3b). A fresh
  // entry starts its decay clock now (last_reinforced_at = now).
  insertMeta(id, confidence, now, now);

  // Fire-and-forget: embed for vector search (errors logged, never thrown)
  if (embedding.isAvailable()) {
    embedding.embedKnowledgeEntry(id, input.title, input.content);
  }

  return id;
}

/**
 * Append an immutable new version of an existing logical entry (A2, #823).
 *
 * Inserts a new version row (`version = current + 1`, `is_current = 1`) copying
 * the current row forward with the given overrides, then demotes the prior
 * current row (`is_current = 0`). A delete is `isDeleted: true` (an immutable
 * death-certificate version — no physical DELETE). `created_at` is preserved (the
 * entry's original creation); `updated_at` is bumped. The embedding is reset to
 * NULL so the new content is re-embedded lazily. Returns the new version row id,
 * or `null` if `logicalId` has no current row.
 *
 * Low-level seam: `ltm.update()`/`remove()` are rewired onto this in a follow-up
 * PR — nothing calls it in production yet, so this PR changes no behavior.
 */
export function appendVersion(
  logicalId: string,
  overrides: {
    title?: string;
    content?: string;
    category?: string;
    isDeleted?: boolean;
    /**
     * #627 Phase 2: stamp the NEW version with fresh provenance (the commit the
     * edit/delete happened at). When omitted — or empty (`{}` → NULL via
     * stringifyMetadata) — the prior version's metadata is forward-copied via
     * `COALESCE(?, metadata)`, so a caller with no session gitHead (CLI import,
     * dashboard delete) never wipes a previously-recorded commit anchor.
     */
    metadata?: KnowledgeMetadata;
  } = {},
): string | null {
  const newId = uuidv7();
  const now = Date.now();
  // Atomic insert-new + demote-old (Seer #839): a crash between the two
  // statements must never leave two is_current=1 rows for one logical_id. We
  // DEMOTE FIRST, then insert — the partial UNIQUE index idx_knowledge_one_current
  // (logical_id WHERE is_current=1) is checked per-statement, so inserting a
  // second current row before demoting would violate it. The forward-copy SELECT
  // still reads the (now-demoted) row by id. The current-row lookup is INSIDE the
  // txn so it can't race a concurrent append (no TOCTOU).
  const ok = withTransaction(() => {
    const cur = db()
      .query(
        "SELECT id FROM knowledge WHERE logical_id = ? AND is_current = 1 LIMIT 1",
      )
      .get(logicalId) as { id: string } | undefined;
    if (!cur) return false;
    db().query("UPDATE knowledge SET is_current = 0 WHERE id = ?").run(cur.id);
    db()
      .query(
        // confidence/last_reinforced_at are NOT copied — they live on the register
        // (knowledge_meta), keyed by the stable logical_id, unchanged by an append.
        `INSERT INTO knowledge (
           id, project_id, category, title, content, source_session, cross_project,
           created_at, updated_at, metadata, embedding, created_by,
           updated_by, sensitivity, promotion_status, promoted_at, approval_status,
           approved_by, approved_at, source_user_id, source_entry_id, last_accessed_at,
           worker_provider_id, worker_model_id,
           logical_id, version, is_deleted, is_current)
         SELECT
           ?, project_id, COALESCE(?, category), COALESCE(?, title), COALESCE(?, content),
           source_session, cross_project, created_at, ?, COALESCE(?, metadata), NULL,
           created_by, updated_by, sensitivity, promotion_status, promoted_at,
           approval_status, approved_by, approved_at, source_user_id, source_entry_id,
           last_accessed_at, worker_provider_id, worker_model_id,
           logical_id, version + 1, ?, 1
         FROM knowledge WHERE id = ?`,
      )
      .run(
        newId,
        overrides.category ?? null,
        overrides.title ?? null,
        overrides.content ?? null,
        now,
        // #627 Phase 2: a non-empty override stamps the new version; NULL (absent
        // or `{}`) makes COALESCE forward-copy the prior version's metadata.
        stringifyMetadata(overrides.metadata),
        overrides.isDeleted ? 1 : 0,
        cur.id,
      );
    return true;
  });

  return ok ? newId : null;
}

/**
 * Disambiguating variant of `create()` for callers that need to know whether
 * a brand-new row was inserted vs. an existing entry was reused (dedup-merge
 * by title / cross-project / fuzzy). Durable prompt deltas
 * only surfaces genuinely-new entries — dedup-merged creates are skipped from
 * the delta message so the agent doesn't see the same entry twice.
 *
 * Returns the entry id and a boolean `created` flag. When `created` is false,
 * the entry already existed and was updated in place (content/confidence
 * forwarded). The boolean does NOT cover post-create dedup sweeps (those run
 * asynchronously after a curator pass).
 */
export function tryCreate(input: Parameters<typeof create>[0]): {
  id: string;
  created: boolean;
  previousContent?: string;
} {
  // Use the same dedup logic as create(): a return value where the id
  // matches an existing row means we hit a dedup branch. We probe for the
  // existence of the title BEFORE calling create() to know which branch fired.
  const pid =
    input.scope === "project" && input.projectPath
      ? ensureProject(input.projectPath)
      : null;

  if (!input.id) {
    const existing = (
      pid !== null
        ? db()
            .query(
              "SELECT id, content FROM knowledge_current WHERE project_id = ? AND LOWER(title) = LOWER(?) AND confidence > 0 LIMIT 1",
            )
            .get(pid, input.title)
        : db()
            .query(
              "SELECT id, content FROM knowledge_current WHERE project_id IS NULL AND LOWER(title) = LOWER(?) AND confidence > 0 LIMIT 1",
            )
            .get(input.title)
    ) as { id: string; content: string } | null;

    if (existing) {
      // Dedup hit on exact match — do NOT count as a new create.
      const id = create(input);
      return { id, created: false, previousContent: existing.content };
    }

    const crossExisting = db()
      .query(
        "SELECT id, content FROM knowledge_current WHERE cross_project = 1 AND LOWER(title) = LOWER(?) AND confidence > 0 LIMIT 1",
      )
      .get(input.title) as { id: string; content: string } | null;
    if (crossExisting) {
      const id = create(input);
      return { id, created: false, previousContent: crossExisting.content };
    }

    const fuzzyMatch = findFuzzyDuplicate({
      title: input.title,
      projectId: pid,
    });
    if (fuzzyMatch) {
      const previous = get(fuzzyMatch.id);
      const id = create(input);
      return { id, created: false, previousContent: previous?.content };
    }
  }

  // No dedup hit — call create() to actually insert. The id is fresh.
  const id = create(input);
  return { id, created: true };
}

export function update(
  id: string,
  input: {
    content?: string;
    confidence?: number;
    updatedBy?: string;
    sensitivity?: Sensitivity;
    /**
     * #627 Phase 2: provenance for the edit. Applied ONLY when a content change
     * appends a new version — a metric/sensitivity-only update mutates no version
     * row (A2 rows are immutable), so the existing gitHead correctly stands.
     */
    metadata?: KnowledgeMetadata;
  },
) {
  // A2 (#823): content is IMMUTABLE per version. A content change appends a new
  // version (copying confidence/metadata forward); confidence/updated_by/
  // sensitivity are MUTABLE metadata applied to the current version in place.
  // `id` may be a current OR superseded version id — resolve to the logical_id.
  const logicalId = logicalIdOf(id);
  // Append a new version only when the content actually changed — a byte-identical
  // "update" (e.g. the curator re-observing an unchanged entry) must NOT append, or
  // frequently re-observed entries grow the table unbounded until compaction.
  let appended = false;
  if (input.content !== undefined) {
    const cur = getByLogical(logicalId);
    if (cur && cur.content !== input.content) {
      appendVersion(logicalId, {
        content: input.content,
        metadata: input.metadata,
      });
      appended = true;
    }
  }

  const now = Date.now();
  // Mutable METADATA on the current version row (NOT confidence — that's a metric
  // register field now, A2 3b). updated_at always bumps (a re-confirmation).
  const sets: string[] = ["updated_at = ?"];
  const params: unknown[] = [now];
  if (input.updatedBy !== undefined) {
    sets.push("updated_by = ?");
    params.push(input.updatedBy);
  }
  if (input.sensitivity !== undefined) {
    sets.push("sensitivity = ?");
    params.push(input.sensitivity);
  }
  params.push(logicalId);
  // Target the CURRENT version (the freshly-appended one if content changed).
  db()
    .query(
      `UPDATE knowledge SET ${sets.join(", ")} WHERE logical_id = ? AND is_current = 1`,
    )
    .run(...(params as [string, ...string[]]));

  // Metric register (A2 3b): any update is a re-confirmation → reset the decay
  // clock so a freshly-touched entry never ages out (v48). Bump the register's
  // sync clock (updated_at) ONLY when the synced metric (confidence) actually
  // changed — a content-only edit must not churn metric sync. Clamp confidence to
  // [0,1] (an out-of-range LLM value would over-weight scoring or silently delete).
  const metaSets: string[] = ["last_reinforced_at = ?"];
  const metaParams: unknown[] = [now];
  if (input.confidence !== undefined) {
    metaSets.push("confidence = ?", "updated_at = ?");
    metaParams.push(Math.max(0, Math.min(1, input.confidence)), now);
  }
  metaParams.push(logicalId);
  db()
    .query(
      `UPDATE knowledge_meta SET ${metaSets.join(", ")} WHERE logical_id = ?`,
    )
    .run(...(metaParams as [unknown, ...unknown[]]));

  // Re-embed the new current version only when a content change was appended.
  if (embedding.isAvailable() && appended) {
    const entry = getByLogical(logicalId);
    if (entry) {
      embedding.embedKnowledgeEntry(entry.id, entry.title, entry.content);
    }
  }
}

/**
 * Per-entry bookkeeping tables that have a `logical_id` column and no FK
 * CASCADE to the `knowledge` row. Under A2 (#823) a deleted entry's row is never
 * physically removed (delete = append a death-cert version), so CASCADE never
 * fires; and the bulk data-purge paths (clearProject / deleteProject /
 * clearKnowledge) physically delete `knowledge` rows while bypassing remove().
 * Every knowledge hard-delete path must purge these explicitly or their rows
 * orphan. Centralized here so a new such table is wired into all delete paths by
 * editing one list. (#990; introduced by #911 / PR #988.)
 *
 * This is the LOCAL-ONLY purge registry: only add tables whose rows are pure
 * local derived state. Do NOT add synced convergent registers (e.g.
 * knowledge_meta) — a local DELETE there would diverge from its
 * convergent-register sync/merge semantics (confidence LWW->merge) once team
 * sync lands. (Note: "tombstone" elsewhere in this file means the A2 is_deleted
 * death-cert version, not the retired knowledge_tombstones table.)
 */
export const LOGICAL_ID_BOOKKEEPING_TABLES = [
  "knowledge_ref_validity",
  "knowledge_symbol_presence",
] as const;

export function remove(id: string, metadata?: KnowledgeMetadata) {
  // A2 (#823): delete = append an immutable is_deleted "death-certificate"
  // version (ordinary append, no physical DELETE). The death cert IS the
  // tombstone + resurrection guard: knowledge_current excludes it, the FTS
  // triggers drop its posting, and isTombstoned() detects it so a stale .lore.md
  // re-import can't resurrect the entry. Keyed on the stable logical_id.
  // #627 Phase 2: the death cert records the delete-time gitHead (provenance for
  // `lore why`); absent → forward-copies the entry's last commit anchor.
  const logicalId = logicalIdOf(id);
  if (!getByLogical(logicalId)) return; // already deleted or unknown — no-op
  appendVersion(logicalId, { isDeleted: true, metadata });
  // The row is NOT physically deleted, so FK ON DELETE CASCADE no longer fires —
  // clean cross-references explicitly, all keyed on the logical_id.
  db()
    .query("DELETE FROM knowledge_entity_refs WHERE knowledge_id = ?")
    .run(logicalId);
  db()
    .query("DELETE FROM knowledge_refs WHERE from_id = ? OR to_id = ?")
    .run(logicalId, logicalId);
  db()
    .query("DELETE FROM knowledge_transfers WHERE knowledge_id = ?")
    .run(logicalId);
  // Per-entry validation bookkeeping (no FK CASCADE) — purge so it doesn't
  // orphan once the entry is tombstoned. Table names are compile-time constants.
  for (const table of LOGICAL_ID_BOOKKEEPING_TABLES) {
    db().query(`DELETE FROM ${table} WHERE logical_id = ?`).run(logicalId);
  }
  // Outcome-reward injection log (#497): same orphan class, but keyed on a
  // composite (session_id, logical_id) PK + carries a project_id, so it can't
  // ride LOGICAL_ID_BOOKKEEPING_TABLES (uniform single logical_id shape). Purge
  // by logical_id here; the project/session bulk-delete paths sweep it by their
  // own scope. (#996)
  db()
    .query("DELETE FROM knowledge_session_injections WHERE logical_id = ?")
    .run(logicalId);
}

/** True when the entry for this logical_id was deleted (tombstoned). */
export function isTombstoned(id: string): boolean {
  // A2: the current version is an is_deleted death certificate.
  const deathCert = db()
    .query(
      "SELECT 1 FROM knowledge WHERE logical_id = ? AND is_current = 1 AND is_deleted = 1 LIMIT 1",
    )
    .get(id) as { 1: number } | null;
  if (deathCert) return true;
  // Legacy: entries deleted before the append-only flip left a tombstone row and
  // no death-cert version (they were physically deleted).
  const legacy = db()
    .query("SELECT 1 FROM knowledge_tombstones WHERE id = ?")
    .get(id) as { 1: number } | null;
  return legacy != null;
}

/**
 * Clear a tombstone for the given UUID — called when an entry is legitimately
 * (re-)created with that exact UUID, so a future delete can tombstone it again.
 */
export function clearTombstone(id: string): void {
  db().query("DELETE FROM knowledge_tombstones WHERE id = ?").run(id);
}

// ---------------------------------------------------------------------------
// Fuzzy title dedup — word-overlap similarity
// ---------------------------------------------------------------------------

/**
 * Compute title word-overlap between two titles.
 * Returns { coefficient, intersectionSize } where:
 * - coefficient = |A ∩ B| / min(|A|, |B|) (0–1)
 * - intersectionSize = number of shared meaningful words
 * Filters stopwords and single-char tokens for meaningful comparison.
 */
function titleOverlap(
  a: string,
  b: string,
): { coefficient: number; intersectionSize: number } {
  const wordsA = new Set(filterTerms(a).map((w) => w.toLowerCase()));
  const wordsB = new Set(filterTerms(b).map((w) => w.toLowerCase()));
  if (wordsA.size === 0 || wordsB.size === 0)
    return { coefficient: 0, intersectionSize: 0 };
  const intersection = [...wordsA].filter((w) => wordsB.has(w));
  return {
    coefficient: intersection.length / Math.min(wordsA.size, wordsB.size),
    intersectionSize: intersection.length,
  };
}

/** Minimum word-overlap coefficient to consider two titles as duplicates. */
const FUZZY_DEDUP_THRESHOLD = 0.7;
/** Minimum number of overlapping meaningful words required for a fuzzy match.
 *  Prevents false positives on short titles where 2-3 common words produce
 *  a high overlap coefficient despite being genuinely different entries. */
const FUZZY_DEDUP_MIN_OVERLAP = 4;
/** Minimum cosine similarity for embedding-based dedup. Empirically tuned
 *  against 312 Nomic v1.5 entries:
 *  - 0.935+: all genuine duplicates (same topic, different wording)
 *  - 0.92–0.935: contains false positives from same-subsystem entries
 *    (e.g. "BGE Small unusable" ↔ "Nomic OOM" scored 0.9326 — related
 *    but distinct bugs). Star clustering amplifies this by bridging.
 *  - <0.92: mixed or unrelated entries */
const EMBEDDING_DEDUP_THRESHOLD = 0.935;

/** Cosine cutoff for deduping `preference` entries at create time. Lower than
 *  the global 0.935 because preferences are behavioral directives the LLM
 *  curator re-observes and re-phrases every session ("document invariants in
 *  code" stated 3 ways), producing paraphrases that cluster ~0.85–0.92 — below
 *  the conservative global threshold yet clearly the same rule. Scoped to a
 *  single category (preferences inject into the always-pinned system[1] block,
 *  so duplicates are the most costly), so the looser cutoff cannot false-merge
 *  distinct architecture/gotcha entries. */
export const PREFERENCE_DEDUP_THRESHOLD = 0.88;

// --- Cross-project auto-promotion thresholds (issue #498) ---
/** A semantic cluster must span at least this many distinct projects to
 *  qualify its members for cross-project promotion. */
const MIN_PROMOTION_PROJECTS = 3;
/** Only project-scoped entries at or above this confidence are eligible
 *  for promotion — we only spread knowledge that is already strong/directive
 *  in its home projects. */
const MIN_PROMOTION_CONFIDENCE = 0.8;
/** Cross-project semantic-match threshold. Reuses the (conservative,
 *  empirically-tuned) dedup threshold to avoid false promotions; cross-project
 *  phrasing varies more, but staying strict keeps promotions trustworthy. */
const PROMOTION_SIMILARITY_THRESHOLD = EMBEDDING_DEDUP_THRESHOLD;
/** Max candidates to consider — keeps the O(n²) pairwise comparison bounded.
 *  With 200 candidates: 200² = 40K cosine computations (microseconds).
 *  Query orders by confidence DESC so the highest-quality entries are kept. */
const MAX_PROMOTION_CANDIDATES = 200;

/**
 * Find an existing knowledge entry whose title is fuzzy-similar to the given title.
 *
 * Uses FTS5 to find up to 5 candidates, then applies word-overlap filtering.
 * This is the same algorithm used by `check()` but returns a single match
 * for use in the `create()` dedup guard.
 *
 * @returns The first matching entry (id + title), or null if no fuzzy match.
 */
export function findFuzzyDuplicate(input: {
  title: string;
  projectId: string | null;
  excludeId?: string;
}): { id: string; title: string } | null {
  const q = ftsQueryOr(input.title);
  if (q === EMPTY_QUERY) return null;

  const { title: tw, content: cw, category: catw } = config().search.ftsWeights;

  try {
    // Build query scoped to the same project + cross-project entries
    const excludeClause = input.excludeId ? "AND k.id != ?" : "";
    const sql =
      input.projectId !== null
        ? `SELECT k.id, k.title FROM knowledge_fts f
         CROSS JOIN knowledge k ON k.rowid = f.rowid
         LEFT JOIN knowledge_meta m ON m.logical_id = k.logical_id
         WHERE knowledge_fts MATCH ?
         AND (k.project_id = ? OR k.cross_project = 1)
         AND COALESCE(m.confidence, 1.0) > 0.2
         ${excludeClause}
         ORDER BY bm25(knowledge_fts, ?, ?, ?) LIMIT 5`
        : `SELECT k.id, k.title FROM knowledge_fts f
         CROSS JOIN knowledge k ON k.rowid = f.rowid
         LEFT JOIN knowledge_meta m ON m.logical_id = k.logical_id
         WHERE knowledge_fts MATCH ?
         AND (k.project_id IS NULL OR k.cross_project = 1)
         AND COALESCE(m.confidence, 1.0) > 0.2
         ${excludeClause}
         ORDER BY bm25(knowledge_fts, ?, ?, ?) LIMIT 5`;

    const params: (string | number)[] =
      input.projectId !== null
        ? [
            q,
            input.projectId,
            ...(input.excludeId ? [input.excludeId] : []),
            tw,
            cw,
            catw,
          ]
        : [q, ...(input.excludeId ? [input.excludeId] : []), tw, cw, catw];

    const candidates = db()
      .query(sql)
      .all(...params) as Array<{ id: string; title: string }>;

    for (const candidate of candidates) {
      const { coefficient, intersectionSize } = titleOverlap(
        input.title,
        candidate.title,
      );
      if (
        coefficient >= FUZZY_DEDUP_THRESHOLD &&
        intersectionSize >= FUZZY_DEDUP_MIN_OVERLAP
      ) {
        return candidate;
      }
    }
  } catch {
    // FTS5 error — fall through to no match
  }

  return null;
}

/**
 * Find a SEMANTIC near-duplicate of the given title+content among existing
 * entries (this project + cross-project), using embedding cosine similarity.
 * Catches duplicates that `findFuzzyDuplicate` (title-word overlap) misses —
 * e.g. the same behavioral preference auto-extracted twice with differently
 * worded titles. Returns the closest match at or above EMBEDDING_DEDUP_THRESHOLD,
 * or null. No-ops (returns null) when embeddings are unavailable.
 *
 * Used by pattern-echo to avoid re-creating a preference that is semantically
 * already present (which would otherwise thrash with consolidation trimming).
 */
export async function findSemanticDuplicate(input: {
  title: string;
  content: string;
  projectId: string | null;
  /**
   * Cosine-similarity cutoff. Defaults to EMBEDDING_DEDUP_THRESHOLD (0.935),
   * tuned high to avoid false-merging distinct same-subsystem entries. Callers
   * deduping a single category where paraphrase is common (e.g. preferences)
   * may pass a lower, category-specific threshold (see PREFERENCE_DEDUP_THRESHOLD).
   */
  threshold?: number;
}): Promise<{ id: string; similarity: number } | null> {
  if (!embedding.isAvailable()) return null;
  const threshold = input.threshold ?? EMBEDDING_DEDUP_THRESHOLD;
  let vec: Float32Array;
  try {
    [vec] = await embedding.embed(
      [`${input.title}\n${input.content}`],
      "document",
    );
  } catch (err) {
    log.warn("findSemanticDuplicate: embed failed (non-fatal):", err);
    return null;
  }
  // Search a few nearest neighbors, then keep only those visible to this
  // project (same project or cross-project) — vectorSearch is global.
  const hits = await embedding.vectorSearch(vec, 10);
  for (const hit of hits) {
    if (hit.similarity < threshold) break; // sorted desc
    const row = db()
      .query(
        `SELECT id FROM knowledge_current
         WHERE id = ? AND (project_id = ? OR project_id IS NULL OR cross_project = 1)`,
      )
      .get(hit.id, input.projectId) as { id: string } | null;
    if (row) return { id: row.id, similarity: hit.similarity };
  }
  return null;
}

export function forProject(
  projectPath: string,
  includeCross = true,
): KnowledgeEntry[] {
  const pid = ensureProject(projectPath);
  if (includeCross) {
    return db()
      .query(
        `SELECT ${KNOWLEDGE_COLS} FROM knowledge_current
         WHERE (project_id = ? OR (project_id IS NULL) OR (cross_project = 1))
         AND confidence > 0.2
         ORDER BY confidence DESC, updated_at DESC`,
      )
      .all(pid)
      .map(hydrateKnowledgeEntry) as KnowledgeEntry[];
  }
  return db()
    .query(
      `SELECT ${KNOWLEDGE_COLS} FROM knowledge_current
       WHERE project_id = ?
       AND confidence > 0.2
       ORDER BY confidence DESC, updated_at DESC`,
    )
    .all(pid)
    .map(hydrateKnowledgeEntry) as KnowledgeEntry[];
}

/**
 * Relevance floor: entries at or below this confidence are filtered out of
 * `forProject()` (it requires `confidence > 0.2`), so they are invisible to
 * injection, curation, and consolidation — pure dead weight.
 */
export const DEAD_CONFIDENCE_FLOOR = 0.2;

/**
 * Hard-delete a project's "dead" entries — those that have decayed to/below the
 * relevance floor (`confidence <= DEAD_CONFIDENCE_FLOOR`). They contribute
 * nothing (already filtered everywhere) and only bloat the row count and the
 * curator's existing-entries context. `remove()` tombstones each id so a stale
 * `.lore.md` re-import can't resurrect it. Restricted to EXCLUSIVELY
 * project-owned rows (`cross_project = 0`): a cross-project entry keeps its
 * origin `project_id` after promotion (promoteCrossProject flips the flag in
 * place), so filtering on `project_id` alone would let a single project delete
 * shared knowledge if its confidence decayed (Seer review, PR #815).
 * Returns the pruned entries (for op-log / metrics).
 */
export function pruneDeadEntries(projectPath: string): KnowledgeEntry[] {
  const pid = ensureProject(projectPath);
  const dead = db()
    .query(
      `SELECT ${KNOWLEDGE_COLS} FROM knowledge_current
       WHERE project_id = ? AND cross_project = 0 AND confidence <= ?`,
    )
    .all(pid, DEAD_CONFIDENCE_FLOOR)
    .map(hydrateKnowledgeEntry) as KnowledgeEntry[];
  for (const e of dead) remove(e.id);
  return dead;
}

/**
 * Global counterpart of `pruneDeadEntries`: reap dead rows across ALL projects
 * in a single pass. The per-project version only runs for the active session's
 * project on its idle tick, so dead entries in projects nobody is currently
 * working in linger indefinitely (invisible, but counted). A periodic global
 * sweep clears those. Same safety rule applies — only EXCLUSIVELY project-owned
 * rows (`cross_project = 0`) are eligible; shared/global knowledge is never
 * touched. `remove()` tombstones each id. Returns the pruned entries.
 *
 * `limit` bounds the per-pass delete count so a future mass-decay can never run
 * an unbounded synchronous delete loop on the caller's event loop; the caller
 * re-runs until the backlog clears. The default `-1` is SQLite's "no limit".
 */
export function pruneDeadEntriesAllProjects(limit = -1): KnowledgeEntry[] {
  const dead = db()
    .query(
      `SELECT ${KNOWLEDGE_COLS} FROM knowledge_current
       WHERE cross_project = 0 AND confidence <= ? LIMIT ?`,
    )
    .all(DEAD_CONFIDENCE_FLOOR, limit)
    .map(hydrateKnowledgeEntry) as KnowledgeEntry[];
  for (const e of dead) remove(e.id);
  return dead;
}

/** Token cost of one entry as the curator prompt renders it (see curatorUser). */
function curatorEntryTokens(e: KnowledgeEntry): number {
  return estimateTokens(`[${e.id}] (${e.category}) ${e.title}: ${e.content}`);
}

/**
 * Budget the curator's "existing entries" context so curator LLM cost stops
 * scaling with stored count. Returns the entries the curator may update / delete
 * / dedup against, packed into `maxTokens` by priority:
 *
 *   1. ALL cross-project / global entries — shared and few; they must stay
 *      visible so a project can update them and avoid re-minting duplicates.
 *   2. Project-scoped entries are CONSIDERED in `forProject` rank order
 *      (confidence DESC, updated_at DESC), so the highest-confidence entries are
 *      always packed first.
 *
 * Pass 2 uses `continue` (not `break`) on an over-budget entry — matching the
 * established `forSession` packer. This MAXIMISES the number of entries the
 * curator can see (its whole job is to dedup/update against existing knowledge,
 * so coverage minimises duplicate creation), and it never sacrifices a
 * high-confidence entry for a low-confidence one: by the time an entry is
 * skipped for size, every higher-ranked entry has already been packed. `break`
 * would be strictly worse — a single oversized top entry would drop the entire
 * remainder, so the curator could see zero existing entries and re-mint
 * everything.
 *
 * When everything fits (the common case) the full set is returned unchanged.
 * Dropped entries are the lowest-confidence / stalest project-scoped ones —
 * least likely to be re-observed this session; the curator's post-create
 * embedding dedup sweep backstops any duplicate minted for an unseen entry.
 * Result preserves `forProject` ordering for determinism.
 */
export function forCurator(
  projectPath: string,
  maxTokens: number,
): KnowledgeEntry[] {
  const all = forProject(projectPath, true);
  let total = 0;
  for (const e of all) total += curatorEntryTokens(e);
  if (total <= maxTokens) return all;

  const keep = new Set<string>();
  let used = 0;
  // Pass 1: pin all cross-project / global entries (always visible).
  for (const e of all) {
    if (e.cross_project === 1 || e.project_id === null) {
      keep.add(e.id);
      used += curatorEntryTokens(e);
    }
  }
  // Pass 2: pack project-scoped entries by rank until the budget is full.
  for (const e of all) {
    if (e.cross_project === 1 || e.project_id === null) continue;
    const cost = curatorEntryTokens(e);
    if (used + cost > maxTokens) continue;
    keep.add(e.id);
    used += cost;
  }
  return all.filter((e) => keep.has(e.id));
}

// ---------------------------------------------------------------------------
// Confidence lifecycle (v48): reinforcement, decay, value-based eviction
// ---------------------------------------------------------------------------

/** Confidence boost applied when an entry is explicitly re-confirmed. */
export const REINFORCE_STEP = 0.05;
/** Min interval between decay passes per project (rate-stable decrement). */
export const DECAY_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
/** An entry must be unreinforced for this long before it starts decaying. */
export const DECAY_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7d
/** Confidence removed per decay pass for an unreinforced entry. */
export const DECAY_STEP = 0.1;

// --- Reference-validity validator (#627 Phase 0) ---------------------------
/** Min interval between reference-resolution passes per project (mirrors
 *  DECAY_INTERVAL_MS) — the per-pass penalty is rate-stable regardless of how
 *  often the idle tick fires. */
export const REFCHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
/** Confidence removed per pass for an entry with ≥1 definitively-broken
 *  reference. ONE flat decrement per stale entry per pass — never scaled by the
 *  number of broken refs, never deleting. Symmetric with DECAY_STEP, so a
 *  continuously-broken, never-reinforced entry loses ~0.1/day. */
export const REFERENCE_DRIFT_PENALTY = 0.1;

// --- Outcome-reward loop (#497) --------------------------------------------
// Within-session co-occurrence: an entry injected into a session is credited
// by that session's verifier verdict. Deliberately asymmetric and bounded:
//  - the boost is SMALL and CAPPED at a ceiling, so co-occurrence with passing
//    verifiers can lift an under-confident-but-useful entry without ever
//    manufacturing the 0.9–1.0 cluster (mere selection ≠ proven certainty);
//  - the penalty is LARGER and uncapped (down to 0), because an entry present
//    while verifiers fail is the more decisive signal.
/** Confidence added to an injected entry when the session's verifiers passed. */
export const OUTCOME_REWARD = 0.02;
/** Confidence removed from an injected entry when the session's verifiers failed. */
export const OUTCOME_PENALTY = 0.05;
/** The outcome boost never lifts confidence above this — it only rescues
 *  under-confident entries; the high band stays reserved for explicit signals. */
export const OUTCOME_BOOST_CEILING = 0.8;

/**
 * Mark entries as injected into a prompt this turn: reset the decay clock
 * WITHOUT changing confidence. Selection by forSession means "still relevant",
 * not "more certain" — bumping confidence every turn would re-flatten all
 * entries to 1.0 and destroy the decay signal that makes confidence a real
 * value ranking. Single batched UPDATE; safe to call on the hot path.
 */
export function markInjected(ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  // last_reinforced_at lives on the metric register (A2 3b); resolve the passed
  // version ids to their logical_ids. A pure relevance touch — does NOT bump the
  // register's updated_at, so an injection stays sync-silent.
  db()
    .query(
      `UPDATE knowledge_meta SET last_reinforced_at = ?
        WHERE logical_id IN (SELECT logical_id FROM knowledge WHERE id IN (${placeholders}))`,
    )
    .run(Date.now(), ...ids);
}

/**
 * Reinforce an entry: adjust confidence by `delta` (clamped to [0,1]) and reset
 * the decay clock. Positive delta = the entry was re-confirmed (curator re-saw
 * it, a dedup-merge landed on it); a future negative delta expresses staleness
 * (#627: a cited file changed) without deleting. Extension point for outcome
 * reward (#497: test/build pass → boost).
 */
export function reinforce(id: string, delta: number = REINFORCE_STEP): void {
  // Metric register (A2 3b): a confidence change bumps the register's sync clock.
  // `id` may be any version id — resolve to the stable logical_id.
  const now = Date.now();
  db()
    .query(
      `UPDATE knowledge_meta
       SET confidence = MAX(0, MIN(1, confidence + ?)), last_reinforced_at = ?, updated_at = ?
       WHERE logical_id = (SELECT logical_id FROM knowledge WHERE id = ?)`,
    )
    .run(delta, now, now, id);
}

/**
 * Lower an entry's confidence for reference drift (#627 Phase 0), keyed by the
 * stable logical_id. Unlike `reinforce`, this deliberately does NOT touch
 * `last_reinforced_at`: a broken, unused entry should age toward the floor
 * FASTER, not be protected from time-decay — so reference-drift and disuse-decay
 * compound (resetting the clock here would let a continuously-broken entry that
 * is never injected dodge `decayProject` forever). It DOES bump the register's
 * sync clock (`updated_at`), because confidence is a synced metric. Floors at 0;
 * `pruneDeadEntries` reaps only once an entry sinks to DEAD_CONFIDENCE_FLOOR
 * after repeated misses. Mirrors `decayProject`'s register write exactly.
 */
export function penalizeStaleReferences(
  logicalId: string,
  delta: number = REFERENCE_DRIFT_PENALTY,
): void {
  db()
    .query(
      `UPDATE knowledge_meta
       SET confidence = MAX(0, confidence - ?), updated_at = ?
       WHERE logical_id = ?`,
    )
    .run(delta, Date.now(), logicalId);
}

/** Outcome of a reference-validity pass over one project. */
export interface RefCheckResult {
  /** Live entries whose references were resolved this pass (excludes no-ref and
   *  all-unverifiable entries). */
  checked: number;
  /** Entries that had ≥1 definitively-missing reference and were penalized. */
  penalized: number;
  /** True when the rate gate blocked the run (no work done). */
  gated: boolean;
  /** True when the resolver returned a whole-batch null (unverifiable → neutral
   *  no-op; the gate is still consumed to avoid hammering a failing probe). */
  neutral: boolean;
}

/**
 * Reference-validity pass for one project (#627 Phase 0). Lowers confidence on
 * project-scoped entries whose literal `file:line` / command references no longer
 * resolve against the current repo, via the supplied `ReferenceResolver`.
 *
 * 🔴 Invariants (mirrors decayProject + creditSessionOutcome):
 *  - Rate-gated once per REFCHECK_INTERVAL_MS via `projects.last_refcheck_at`, so
 *    the per-pass penalty is rate-stable regardless of idle-tick frequency.
 *  - Only project-scoped (`cross_project = 0`) LIVE (`confidence > floor`) entries
 *    are touched — a single project must never penalize shared/global knowledge.
 *  - "cannot verify" ≠ "broken": a null resolver result, or refs that resolve to
 *    "unknown" (absolute/out-of-tree path, ambiguous basename, missing
 *    package.json), NEVER penalize. Only ≥1 definitively-"missing" ref does.
 *  - Exactly ONE flat penalty per stale entry per pass (never scaled by broken-ref
 *    count, never deleting); `pruneDeadEntries` reaps at the floor after repeated
 *    misses. Entries with zero extractable refs are untouched (no refs ≠ broken).
 */
export async function validateProjectReferences(
  projectPath: string,
  resolver: ReferenceResolver,
  now: number = Date.now(),
): Promise<RefCheckResult> {
  const pid = ensureProject(projectPath);
  const proj = db()
    .query("SELECT last_refcheck_at FROM projects WHERE id = ?")
    .get(pid) as { last_refcheck_at: number | null } | null;
  const last = proj?.last_refcheck_at ?? 0;
  if (now - last < REFCHECK_INTERVAL_MS) {
    return { checked: 0, penalized: 0, gated: true, neutral: false };
  }

  const rows = db()
    .query(
      `SELECT logical_id, title, content FROM knowledge_current
        WHERE project_id = ? AND cross_project = 0 AND confidence > ?`,
    )
    .all(pid, DEAD_CONFIDENCE_FLOOR) as Array<{
    logical_id: string;
    title: string;
    content: string;
  }>;

  // Extract per entry; dedupe the union of refs so the resolver does ONE batch
  // (one client round-trip in synthetic-probe mode).
  const perEntry = new Map<string, Reference[]>();
  const union = new Map<string, Reference>();
  for (const r of rows) {
    const refs = extractReferences(`${r.title}\n${r.content}`);
    if (refs.length === 0) continue; // no signal — untouched
    perEntry.set(r.logical_id, refs);
    for (const ref of refs) {
      if (!union.has(ref.raw)) union.set(ref.raw, ref);
    }
  }
  const unionList = [...union.values()];

  const stampGate = (): void => {
    db()
      .query("UPDATE projects SET last_refcheck_at = ? WHERE id = ?")
      .run(now, pid);
  };

  if (unionList.length === 0) {
    stampGate();
    return { checked: 0, penalized: 0, gated: false, neutral: false };
  }

  const statusMap = await resolver.resolve(unionList);
  if (statusMap == null) {
    // Whole batch unverifiable (probe error/timeout / no FS) → strict no-op.
    // Consume the gate so a failing probe isn't re-hammered every idle tick.
    stampGate();
    return { checked: 0, penalized: 0, gated: false, neutral: true };
  }

  let checked = 0;
  let penalized = 0;
  // Symbol drift uses a presence HISTORY (#911): a symbol only counts as broken
  // when it was previously confirmed present in this repo and is now absent (a
  // genuine rename/removal). A symbol that was NEVER present here (external lib,
  // historical/renamed-away mention, rejected alternative) never gets a row, so
  // it can never penalize — this is what keeps symbol validation on the safe
  // side of "cannot verify ≠ broken".
  const recordSymbolPresent = db().query(
    `INSERT INTO knowledge_symbol_presence (logical_id, symbol, last_present_at)
       VALUES (?, ?, ?)
     ON CONFLICT(logical_id, symbol) DO UPDATE SET last_present_at = excluded.last_present_at`,
  );
  const wasSymbolPresent = db().query(
    `SELECT 1 FROM knowledge_symbol_presence WHERE logical_id = ? AND symbol = ?`,
  );
  // Stamp the 24h gate in a `finally`, OUTSIDE the penalty transaction. If a
  // write inside the transaction throws, `withTransaction` rolls back the whole
  // batch — but the gate MUST still advance, otherwise the next idle tick re-runs
  // the same failing pass (re-resolving / re-probing) every tick forever. The
  // gate is just a rate-limiter timestamp, so decoupling it from the penalty
  // atomicity is safe; a failed pass simply waits for the next 24h window. (Seer.)
  try {
    withTransaction(() => {
      for (const [logicalId, refs] of perEntry) {
        let broken = 0;
        let total = 0; // refs with a DEFINITIVE status (ok|missing); excludes unknown
        for (const ref of refs) {
          const st = statusMap.get(ref.raw);
          if (ref.kind === "symbol") {
            if (st === "ok") {
              // Confirmed present now — record so a later disappearance reads as
              // drift. Counts as a definitive (verifiable) ref, never broken.
              recordSymbolPresent.run(logicalId, ref.name, now);
              total++;
            } else if (st === "missing") {
              // Confirmed ABSENT. Only drift (broken) if we have proof it was
              // present before; otherwise a strict no-op (never-present mention).
              if (wasSymbolPresent.get(logicalId, ref.name)) {
                broken++;
                total++;
              }
            }
            // "unknown" → neutral, not counted
            continue;
          }
          // file / command refs: a definitive "missing" is directly broken.
          if (st === "missing") {
            broken++;
            total++;
          } else if (st === "ok") {
            total++;
          }
          // "unknown" / absent → neutral, not counted
        }
        if (total === 0) continue; // every ref unverifiable for this entry — neutral
        checked++;
        db()
          .query(
            `INSERT INTO knowledge_ref_validity (logical_id, broken, total, checked_at)
               VALUES (?, ?, ?, ?)
             ON CONFLICT(logical_id) DO UPDATE SET
               broken = excluded.broken, total = excluded.total, checked_at = excluded.checked_at`,
          )
          .run(logicalId, broken, total, now);
        if (broken >= 1) {
          penalizeStaleReferences(logicalId, REFERENCE_DRIFT_PENALTY);
          penalized++;
        }
      }
    });
  } finally {
    stampGate();
  }

  return { checked, penalized, gated: false, neutral: false };
}

/**
 * Peek the deduped reference set for a project WITHOUT resolving or writing
 * anything — used by the remote synthetic-probe driver to (a) check the rate gate
 * and (b) build the client probe script. The actual penalty pass happens later
 * (turn N+1) via `validateProjectReferences` with a `SyntheticProbeResolver`,
 * which re-gathers from the SAME query, so the two are consistent by construction.
 */
export function peekProjectRefs(
  projectPath: string,
  now: number = Date.now(),
): { gated: boolean; refs: Reference[] } {
  const pid = ensureProject(projectPath);
  const proj = db()
    .query("SELECT last_refcheck_at FROM projects WHERE id = ?")
    .get(pid) as { last_refcheck_at: number | null } | null;
  const last = proj?.last_refcheck_at ?? 0;
  if (now - last < REFCHECK_INTERVAL_MS) return { gated: true, refs: [] };

  const rows = db()
    .query(
      `SELECT title, content FROM knowledge_current
        WHERE project_id = ? AND cross_project = 0 AND confidence > ?`,
    )
    .all(pid, DEAD_CONFIDENCE_FLOOR) as Array<{
    title: string;
    content: string;
  }>;
  const union = new Map<string, Reference>();
  for (const r of rows) {
    for (const ref of extractReferences(`${r.title}\n${r.content}`)) {
      if (!union.has(ref.raw)) union.set(ref.raw, ref);
    }
  }
  return { gated: false, refs: [...union.values()] };
}

/**
 * Record which knowledge entries were injected into a session, for the
 * outcome-reward loop (#497). Keyed by `logical_id` (the A2 stable identity), so
 * crediting survives a version edit between injection and the idle credit pass.
 * Idempotent per (session, entry) via the PK — re-injection across turns does
 * NOT reset the `credited` flag, so an entry is credited at most once per
 * session. cross_project (shared) and synthetic (lat.md) entries are skipped:
 * the loop must never auto-adjust shared knowledge, and synthetics aren't rows.
 */
export function recordSessionInjections(
  sessionID: string | undefined,
  projectPath: string,
  entries: { logical_id?: string; cross_project?: number; category?: string }[],
): void {
  if (!sessionID) return;
  const pid = ensureProject(projectPath);
  const now = Date.now();
  const stmt = db().query(
    `INSERT INTO knowledge_session_injections
       (session_id, logical_id, project_id, created_at, credited)
     VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(session_id, logical_id) DO NOTHING`,
  );
  // One transaction for the whole batch (matches markInjected's single write and
  // avoids a per-entry auto-commit on the request hot path).
  withTransaction(() => {
    for (const e of entries) {
      if (!e.logical_id) continue;
      if (e.cross_project === 1) continue;
      if (e.category === "lat.md") continue;
      stmt.run(sessionID, e.logical_id, pid, now);
    }
  });
}

/** Outcome of crediting one session's injected entries. */
export type OutcomeCreditResult = {
  verdict: "pass" | "fail" | "none";
  /** Number of injected entries whose confidence was adjusted. */
  credited: number;
};

/**
 * Credit a session's injected knowledge entries by its verifier verdict (#497).
 * Runs at idle. Within-session co-occurrence: entries that were in-context when
 * the session's verifiers passed get a small (capped) boost; entries in-context
 * when verifiers failed get a larger penalty. Applied at most once per entry per
 * session (the `credited` flag), so a later idle tick won't re-credit.
 *
 * Invariants:
 *  - `none` verdict (no verifier ran) is a no-op — never guess.
 *  - cross_project (shared) entries are never touched (the injection log already
 *    excludes them; the UPDATE re-asserts `cross_project = 0` as a backstop).
 *  - the boost is clamped to OUTCOME_BOOST_CEILING; the penalty floors at 0.
 *  - both write `last_reinforced_at` (the entry was demonstrably in use), so a
 *    credited entry won't also be aged out by decay this cycle.
 */
export function creditSessionOutcome(
  sessionID: string,
  projectPath: string,
): OutcomeCreditResult {
  const pid = ensureProject(projectPath);
  const uncredited = db()
    .query(
      `SELECT logical_id FROM knowledge_session_injections
       WHERE session_id = ? AND project_id = ? AND credited = 0`,
    )
    .all(sessionID, pid) as { logical_id: string }[];
  if (uncredited.length === 0) return { verdict: "none", credited: 0 };

  const verdict = sessionVerifierVerdict(projectPath, sessionID);
  if (verdict === "none") return { verdict, credited: 0 };

  const ids = uncredited.map((r) => r.logical_id);
  const placeholders = ids.map(() => "?").join(",");
  const now = Date.now();
  // Apply the confidence adjustment and the credited-flag write atomically, so a
  // crash between them can't re-credit (double-adjust) on restart.
  withTransaction(() => {
    // Adjust the current, live version of each injected logical entry. The
    // cross_project = 0 guard is a real backstop (a PROMOTED entry keeps its
    // origin project_id but has cross_project = 1 — it must never be adjusted);
    // is_deleted = 0 skips death-certificate versions.
    // Confidence lives on the register (A2 3b); the eligibility filters
    // (is_current/is_deleted/cross_project/project_id) are knowledge-row facts, so
    // gate via a knowledge_current subquery (it already pins is_current=1 AND
    // is_deleted=0 and exposes confidence via the JOIN). A confidence change bumps
    // the register's sync clock (updated_at).
    if (verdict === "pass") {
      db()
        .query(
          `UPDATE knowledge_meta
           SET confidence = MIN(?, confidence + ?), last_reinforced_at = ?, updated_at = ?
           WHERE logical_id IN (
             SELECT logical_id FROM knowledge_current
              WHERE cross_project = 0 AND project_id = ? AND confidence < ?
                AND logical_id IN (${placeholders}))`,
        )
        .run(
          OUTCOME_BOOST_CEILING,
          OUTCOME_REWARD,
          now,
          now,
          pid,
          OUTCOME_BOOST_CEILING,
          ...ids,
        );
    } else {
      db()
        .query(
          `UPDATE knowledge_meta
           SET confidence = MAX(0, confidence - ?), last_reinforced_at = ?, updated_at = ?
           WHERE logical_id IN (
             SELECT logical_id FROM knowledge_current
              WHERE cross_project = 0 AND project_id = ? AND logical_id IN (${placeholders}))`,
        )
        .run(OUTCOME_PENALTY, now, now, pid, ...ids);
    }

    // Mark this session's injections credited (so a later idle tick is a no-op)
    // and record the verdict for per-entry "knowledge impact" stats (#497).
    db()
      .query(
        `UPDATE knowledge_session_injections SET credited = 1, verdict = ?
         WHERE session_id = ? AND project_id = ? AND credited = 0`,
      )
      .run(verdict, sessionID, pid);
  });

  return { verdict, credited: ids.length };
}

/** Per-entry outcome co-occurrence stats for the reward loop (#497). */
export type OutcomeImpact = {
  /** Sessions this entry was injected into that ended with passing verifiers. */
  passes: number;
  /** Sessions this entry was injected into that ended with failing verifiers. */
  fails: number;
};

/**
 * Aggregate the verifier outcomes a knowledge entry has co-occurred with, by its
 * stable `logical_id` (A2). Counts credited injection rows by verdict; 'none'
 * verdicts are not recorded (no signal), so only pass/fail are counted (the
 * `verdict IN ('pass','fail')` filter also excludes still-uncredited NULL rows).
 * Read-only — surfaced by `lore data show` so the reward loop's effect is
 * observable. (A recency / "last verdict" hint is intentionally omitted: the
 * only available timestamp is injection time, not credit time, so it would
 * misreport when an old session is credited late.)
 */
export function outcomeImpact(logicalId: string): OutcomeImpact {
  const rows = db()
    .query(
      `SELECT verdict, COUNT(*) AS n
       FROM knowledge_session_injections
       WHERE logical_id = ? AND verdict IN ('pass','fail')
       GROUP BY verdict`,
    )
    .all(logicalId) as { verdict: string; n: number }[];
  let passes = 0;
  let fails = 0;
  for (const r of rows) {
    if (r.verdict === "pass") passes = r.n;
    else if (r.verdict === "fail") fails = r.n;
  }
  return { passes, fails };
}

/** Last observed reference-resolution counts for an entry (#627), or null if it
 *  has never been checked (or has no extractable references). */
export type RefValidity = {
  /** References that resolved definitively MISSING at the last check. */
  broken: number;
  /** References with a definitive status (ok + missing) at the last check. */
  total: number;
  /** When the last check ran (epoch ms). */
  checkedAt: number;
};

/** Read the last reference-validity snapshot for an entry by logical_id. Read-only;
 *  surfaced by `lore data show`. */
export function refValidity(logicalId: string): RefValidity | null {
  const row = db()
    .query(
      "SELECT broken, total, checked_at FROM knowledge_ref_validity WHERE logical_id = ?",
    )
    .get(logicalId) as
    | { broken: number; total: number; checked_at: number }
    | null
    | undefined;
  if (!row) return null;
  return { broken: row.broken, total: row.total, checkedAt: row.checked_at };
}

/**
 * Idle decay pass for one project. Lowers confidence by DECAY_STEP for
 * project-scoped entries that have been unreinforced (not injected / recalled /
 * re-confirmed) for longer than DECAY_GRACE_MS, so genuinely unused knowledge
 * ages toward the relevance floor (then `pruneDeadEntries` reaps it) while
 * regularly-injected knowledge never decays.
 *
 * Gated to once per DECAY_INTERVAL_MS per project via `projects.last_decay_at`,
 * so the per-pass decrement is rate-stable regardless of idle-tick frequency.
 * Cross-project/global entries are never decayed by a single project. Returns
 * the number of entries decayed (0 when the interval gate blocks the run).
 */
export function decayProject(
  projectPath: string,
  now: number = Date.now(),
): number {
  const pid = ensureProject(projectPath);
  const proj = db()
    .query("SELECT last_decay_at FROM projects WHERE id = ?")
    .get(pid) as { last_decay_at: number | null } | null;
  const lastDecay = proj?.last_decay_at ?? 0;
  if (now - lastDecay < DECAY_INTERVAL_MS) return 0; // interval gate

  const cutoff = now - DECAY_GRACE_MS;
  // cross_project = 0: a promoted entry keeps its origin project_id, so a single
  // project must not decay shared knowledge it merely originated (it may be
  // actively used — and reinforced — in OTHER projects). (Seer review, PR #816.)
  // confidence > floor: only decay still-LIVE entries. Already-dead rows
  // (<= floor) are invisible everywhere and reaped by pruneDeadEntries; matching
  // them here would re-apply a no-op MAX(0, …) and inflate the returned/logged
  // count with rows whose confidence didn't actually change. (Seer review.)
  // Confidence is a register field (A2 3b); the eligibility facts (project_id,
  // cross_project, confidence floor, grace window) come from knowledge_current
  // (which pins is_current=1 and exposes confidence/last_reinforced_at via the
  // JOIN; `updated_at` here is the content row's, NOT the register's, so the bump
  // below can't feed back into the grace check). Decay does NOT reset
  // last_reinforced_at; it bumps the register's sync clock (updated_at).
  const res = db()
    .query(
      `UPDATE knowledge_meta
       SET confidence = MAX(0, confidence - ?), updated_at = ?
       WHERE logical_id IN (
         SELECT logical_id FROM knowledge_current
          WHERE project_id = ? AND cross_project = 0 AND confidence > ?
            AND COALESCE(last_reinforced_at, updated_at) < ?)`,
    )
    .run(DECAY_STEP, now, pid, DEAD_CONFIDENCE_FLOOR, cutoff) as {
    changes?: number | bigint;
  };
  db()
    .query("UPDATE projects SET last_decay_at = ? WHERE id = ?")
    .run(now, pid);
  return Number(res.changes ?? 0);
}

/**
 * Value-based eviction backstop. Deletes the `count` lowest-VALUE project-scoped
 * entries — ranked by confidence ASC, then last_reinforced_at ASC (least
 * confident, then least-recently reinforced). Confidence is the decayed value
 * (the decay pass mutates it in place), so this evicts what the lifecycle has
 * already judged least valuable. Only EXCLUSIVELY project-owned rows
 * (`cross_project = 0`) are eligible — a promoted entry keeps its origin
 * project_id, so a single project must never evict shared knowledge (Seer
 * review, PR #816). `remove()` tombstones each id. Returns the evicted rows
 * (for the changed-entries / delta channel).
 *
 * Only considers LIVE entries (`confidence > DEAD_CONFIDENCE_FLOOR`) — the same
 * set `forProject` counts. Callers (enforceEntryCap) compute `count` from the
 * live count over the cap, so eviction must draw from the same population or it
 * would reap already-dead entries (handled by pruneDeadEntries) without reducing
 * the live count, under-enforcing the cap. (Seer review, PR #816.)
 *
 * Self-correcting at the cap: a freshly-created entry less confident than every
 * incumbent sorts to the tail and evicts itself, so weak new knowledge never
 * displaces stronger existing knowledge.
 */
export function evictLowestValue(
  projectPath: string,
  count: number,
): KnowledgeEntry[] {
  if (count <= 0) return [];
  const pid = ensureProject(projectPath);
  const victims = db()
    .query(
      `SELECT ${KNOWLEDGE_COLS} FROM knowledge_current
       WHERE project_id = ? AND cross_project = 0 AND confidence > ?
       ORDER BY confidence ASC, COALESCE(last_reinforced_at, updated_at) ASC
       LIMIT ?`,
    )
    .all(pid, DEAD_CONFIDENCE_FLOOR, count)
    .map(hydrateKnowledgeEntry) as KnowledgeEntry[];
  for (const e of victims) remove(e.id);
  return victims;
}

type Scored = { entry: KnowledgeEntry; score: number };

/** BM25 column weights for knowledge_fts: title, content, category.
 *  Reads from config().search.ftsWeights, falling back to defaults. */
function ftsWeights() {
  return config().search.ftsWeights;
}

/** Max entries per pool to include on first turn when no session context exists. */
const NO_CONTEXT_FALLBACK_CAP = 10;

/** Number of top-confidence project entries always included as a safety net,
 *  even when they don't match any session context terms. This guards against
 *  the coarse term-overlap scoring accidentally excluding important project
 *  knowledge. */
const PROJECT_SAFETY_NET = 5;

/**
 * Classify an entry from the cross-project pool relative to the current project:
 *  - "global": `project_id IS NULL` — a user-level entry with no home project
 *    (e.g. `scope:"global"` preferences). Universally applicable.
 *  - "own":    `project_id === pid` — this project's own entry that also carries
 *    `cross_project = 1`. It belongs here.
 *  - "foreign": `cross_project = 1` owned by a DIFFERENT project. Sharing it is
 *    only ever appropriate when it relevance-matches the current session.
 */
function crossEntryClass(
  entry: KnowledgeEntry,
  pid: string,
): "global" | "own" | "foreign" {
  if (entry.project_id === null) return "global";
  if (entry.project_id === pid) return "own";
  return "foreign";
}

/**
 * Whether a cross-pool entry may be injected WITHOUT a relevance match.
 * Globals and this project's own entries are always eligible; foreign
 * cross-project entries are not — they must earn injection through relevance
 * scoring. This is the guard that stops one project's knowledge (e.g. lore's
 * own engineering directives) from leaking into every other project's context.
 */
function isBlanketEligible(entry: KnowledgeEntry, pid: string): boolean {
  return crossEntryClass(entry, pid) !== "foreign";
}

/**
 * Score entries by FTS5 BM25 relevance to session context.
 *
 * Uses OR semantics (not AND-then-OR) because we're scoring ALL candidates
 * for relevance ranking, not searching for exact matches. An entry that
 * matches 1 of 40 terms should still get a (low) score, not be excluded.
 * BM25 naturally weights entries matching more terms higher.
 *
 * Returns a Map of entry ID → normalized score (0–1).
 */
async function scoreEntriesFTS(
  sessionContext: string,
): Promise<Map<string, number>> {
  const terms = extractTopTerms(sessionContext);
  if (!terms.length) return new Map();

  const q = terms.map((t) => `${t}*`).join(" OR ");
  const { title, content, category } = ftsWeights();

  try {
    // Offload the BM25 OR-scan to the read-worker pool (in-process fallback).
    // knowledge_fts is not written on the hot path → staleness-tolerant. #966 B.
    const results = (await offloadAll(
      `SELECT k.id, bm25(knowledge_fts, ?, ?, ?) as rank
          FROM knowledge_fts f
          CROSS JOIN knowledge k ON k.rowid = f.rowid
         LEFT JOIN knowledge_meta m ON m.logical_id = k.logical_id
          WHERE knowledge_fts MATCH ?
          AND COALESCE(m.confidence, 1.0) > 0.2`,
      [title, content, category, q],
    )) as Array<{
      id: string;
      rank: number;
    }>;

    if (!results.length) return new Map();

    // Normalize: BM25 rank is negative (more negative = better).
    // Convert to 0–1 where 1 = best match.
    const ranks = results.map((r) => r.rank);
    const minRank = Math.min(...ranks);
    const maxRank = Math.max(...ranks);
    const scoreMap = new Map<string, number>();
    for (const r of results) {
      const norm =
        minRank === maxRank ? 1 : (maxRank - r.rank) / (maxRank - minRank);
      scoreMap.set(r.id, norm);
    }
    return scoreMap;
  } catch {
    return new Map();
  }
}

/**
 * Well-known knowledge entry categories managed by the curator.
 * The DB column is a free-form string, but these are the standard values.
 */
export type KnowledgeCategory =
  | "decision"
  | "pattern"
  | "preference"
  | "architecture"
  | "gotcha";

/** Options for `forSession()` to control entry selection. */
export type ForSessionOptions = {
  /** Caller-provided context (e.g., user's current message) for relevance
   *  scoring when no session context exists in the DB yet. */
  contextHint?: string;
  /** Restrict to these categories (e.g., `['preference']` for turn 1). */
  categories?: (KnowledgeCategory | (string & {}))[];
  /** Exclude these categories (e.g., `['preference']` for context-bound
   *  entries when preferences are already injected in a separate block).
   *  Mutually exclusive with `categories` — if both are provided,
   *  `categories` (include) wins. */
  excludeCategories?: (KnowledgeCategory | (string & {}))[];
  /**
   * IDs of entries that were selected on the PREVIOUS turn (the currently
   * pinned system[2] set). These receive a relevance hysteresis bonus so they
   * stay selected across turns unless a genuinely stronger entry displaces
   * them or they are removed. Without this, vector scores re-computed against
   * the evolving per-turn session context churn the budget-boundary subset
   * every turn — each a real set change that busts the prompt cache. The bonus
   * is multiplicative and modest, so a clearly more-relevant new entry still
   * wins, but ties and minor fluctuations don't reshuffle the selected set.
   */
  stickyIds?: Set<string>;
  /**
   * Optional sink for the budget-overflow tail (#917). When provided,
   * `forSession` pushes the entries that were relevance-scored but did NOT fit
   * the token budget into this array, in the same score-descending order it
   * uses internally. Lets a caller surface a compact "these also exist — recall
   * by id for detail" table of contents without re-querying. Invariants:
   * selected (returned) entries are never included; lat.md synthetics are never
   * included (they are not knowledge rows and carry no recall id). Ordering is
   * deterministic (matches the internal `allScored` sort) so the rendered ToC is
   * byte-stable across turns.
   */
  overflowSink?: KnowledgeEntry[];
};

/**
 * Multiplicative relevance bonus applied to entries already selected on the
 * previous turn (see ForSessionOptions.stickyIds). Tuned so a previously-shown
 * entry keeps its slot against minor score fluctuations, but a new entry that
 * scores >25% higher can still displace it — selection stays relevance-driven,
 * just with anti-churn hysteresis.
 */
const STICKY_RELEVANCE_BONUS = 1.25;

/**
 * Build a relevance-ranked, budget-capped list of knowledge entries for injection
 * into the system prompt of a live session.
 *
 * Strategy:
 * 1. Both project-specific and cross-project entries are scored for relevance
 *    against recent session context (last distillation + recent raw messages).
 * 2. When embeddings are available, vector cosine similarity is used for scoring
 *    (captures semantic matches that keyword overlap misses). Falls back to
 *    FTS5 BM25 when embeddings are unavailable.
 * 3. Project entries get a safety net: the top PROJECT_SAFETY_NET entries by
 *    confidence are always included even if they have zero relevance score.
 *    This ensures the most important project knowledge is never lost to
 *    coarse scoring.
 * 4. All scored entries are merged into a single pool and greedily packed
 *    into the token budget by score descending.
 * 5. If there's no session context yet (first turn), fall back to top entries
 *    by confidence only (capped at NO_CONTEXT_FALLBACK_CAP per pool).
 *
 * @param projectPath   Current project path
 * @param sessionID     Current session ID (for context extraction)
 * @param maxTokens     Hard token budget for the entire formatted block
 * @param options       Optional category filter and context hint
 */
export async function forSession(
  projectPath: string,
  sessionID: string | undefined,
  maxTokens: number,
  options?: ForSessionOptions,
): Promise<KnowledgeEntry[]> {
  // Measure this hot per-turn path's main-thread blocking cost (#966 B). The
  // awaits below (embed + the pool-backed vector search) are wrapped so the
  // wall-time remainder is the synchronous entry-load / FTS / scoring / packing
  // cost. Emitted at each real-work return.
  const timer = new ReadPathTimer();
  const pid = ensureProject(projectPath);
  const categoryFilter = options?.categories;
  const excludeFilter = options?.excludeCategories;

  // Build optional SQL category clauses (include / exclude are mutually exclusive)
  let categoryClause = "";
  let categoryParams: string[] = [];
  if (categoryFilter?.length) {
    categoryClause = ` AND category IN (${categoryFilter.map(() => "?").join(",")})`;
    categoryParams = categoryFilter;
  } else if (excludeFilter?.length) {
    categoryClause = ` AND category NOT IN (${excludeFilter.map(() => "?").join(",")})`;
    categoryParams = excludeFilter;
  }

  // --- 1 & 2. Load project-specific + cross-project candidates ---
  // These two unbounded `knowledge_current` scans are the heaviest synchronous
  // reads on this per-turn path. Offload them to the read-worker pool (with an
  // in-process fallback) and run them in parallel, so the main event loop stays
  // free while a worker scans. Knowledge is not written on the hot per-message
  // path, so a worker's read-only snapshot is safe (staleness-tolerant). #966 B.
  const projectSql = `SELECT ${KNOWLEDGE_COLS} FROM knowledge_current
       WHERE project_id = ? AND cross_project = 0 AND confidence > 0.2${categoryClause}
       ORDER BY confidence DESC, updated_at DESC`;
  const crossSql = `SELECT ${KNOWLEDGE_COLS} FROM knowledge_current
       WHERE (project_id IS NULL OR cross_project = 1) AND confidence > 0.2${categoryClause}
       ORDER BY confidence DESC, updated_at DESC`;
  const [projectRows, crossRows] = await timer.await(
    Promise.all([
      offloadAllOrTimeout(projectSql, [pid, ...categoryParams]),
      offloadAllOrTimeout(crossSql, [...categoryParams]),
    ]),
  );
  // Symmetric degrade: if EITHER scan's worker wedged (timeout), drop the whole
  // LTM injection for this turn rather than inject a lopsided partial set (e.g.
  // cross-project entries without the usually-more-relevant project-specific
  // half). Re-running the wedged scan in-process would re-block the loop the
  // offload exists to keep free (#1006); the next turn retries against a freshly
  // respawned worker. A 10s timeout on these small-table scans is near-impossible
  // in practice — this is a safety valve, not a common path.
  if (projectRows === READ_JOB_TIMED_OUT || crossRows === READ_JOB_TIMED_OUT) {
    timer.emit("forSession", 0);
    return [];
  }
  const projectEntries = (projectRows as Record<string, unknown>[]).map(
    hydrateKnowledgeEntry,
  ) as KnowledgeEntry[];
  const crossEntries = (crossRows as Record<string, unknown>[]).map(
    hydrateKnowledgeEntry,
  ) as KnowledgeEntry[];

  if (!crossEntries.length && !projectEntries.length) return [];

  // --- Preference-only fast path ---
  // Preferences are unconditional user directives — relevance scoring harms them.
  // Skip scoring; rank purely by confidence (set by curator or `lore data rerank`)
  // then recency. Confidence carries real meaning now: 1.0 = unconditional
  // directive, 0.9 = strong preference, 0.8 = moderate, 0.6 = mild.
  const isPreferenceOnly =
    categoryFilter?.length === 1 && categoryFilter[0] === "preference";
  if (isPreferenceOnly) {
    // Blanket-inject only the user's own directives: project-local prefs
    // (Pool 1), true globals (`project_id IS NULL`), and this project's own
    // cross-marked prefs. FOREIGN cross-project prefs (owned by a different
    // project) are NOT blanket-injected — otherwise one project's preferences
    // leak into every project. They re-enter only when they relevance-match the
    // caller-provided context hint; with no hint we cannot establish relevance
    // on this cheap path, so they are dropped.
    const blanketPrefs = [
      ...projectEntries,
      ...crossEntries.filter((e) => isBlanketEligible(e, pid)),
    ];
    const foreignPrefs = crossEntries.filter((e) => !isBlanketEligible(e, pid));
    let relevantForeign: KnowledgeEntry[] = [];
    if (foreignPrefs.length && options?.contextHint?.trim()) {
      const ftsScores = await scoreEntriesFTS(options.contextHint);
      relevantForeign = foreignPrefs.filter(
        (e) => (ftsScores.get(e.id) ?? 0) > 0,
      );
    }

    const allPrefs = [...blanketPrefs, ...relevantForeign];
    allPrefs.sort((a, b) => {
      if (a.confidence !== b.confidence) return b.confidence - a.confidence;
      if (a.updated_at !== b.updated_at) return b.updated_at - a.updated_at;
      // Deterministic id tiebreak — keeps preference ordering byte-stable.
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    const HEADER_OVERHEAD_TOKENS = 15;
    let used = HEADER_OVERHEAD_TOKENS;
    const result: KnowledgeEntry[] = [];
    for (const entry of allPrefs) {
      if (used >= maxTokens) break;
      const cost = estimateTokens(entry.title + entry.content) + 10;
      if (used + cost > maxTokens) continue;
      result.push(entry);
      used += cost;
    }
    // Note: transfer metrics (issue #506) are intentionally NOT recorded on this
    // fast path. Preferences are typically global/cross directives rather than
    // project-origin knowledge, so counting them as cross-project "transfers"
    // would be misleading.
    //
    // Reinforce injected preferences (confidence lifecycle): this is the ONLY
    // injection path for preferences (the context-block callers pass
    // excludeCategories: ["preference"]). Without this, a project-scoped
    // preference injected into system[1] every turn would still age out and be
    // pruned by decayProject/pruneDeadEntries after the grace window — silently
    // deleting an actively-used directive. Resets the decay clock only.
    try {
      markInjected(result.map((e) => e.id));
      recordSessionInjections(sessionID, projectPath, result);
    } catch (err) {
      log.warn(
        "forSession(preference): reinforcement failed (non-fatal):",
        err,
      );
    }
    timer.emit("forSession", projectEntries.length + crossEntries.length);
    return result;
  }

  // --- 3. Build session context for relevance scoring ---
  let sessionContext = "";
  if (sessionID) {
    const distRow = db()
      .query(
        `SELECT observations FROM distillations
         WHERE project_id = ? AND session_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(pid, sessionID) as { observations: string } | null;
    if (distRow?.observations) {
      sessionContext += `${distRow.observations}\n`;
    }
    const recentMsgs = db()
      .query(
        `SELECT content FROM temporal_messages
         WHERE project_id = ? AND session_id = ?
         ORDER BY created_at DESC LIMIT 10`,
      )
      .all(pid, sessionID) as Array<{ content: string }>;
    if (recentMsgs.length) {
      sessionContext += recentMsgs.map((m) => m.content).join("\n");
    }
  }

  // Fall back to caller-provided context hint (e.g., user's first message)
  if (!sessionContext.trim() && options?.contextHint) {
    sessionContext = options.contextHint;
  }

  // --- 4. Score both pools by relevance ---
  let scoredProject: Scored[];
  let scoredCross: Scored[];

  if (sessionContext.trim().length > 20 && embedding.isAvailable()) {
    // Vector scoring: embed session context, score entries by cosine similarity.
    // Captures semantic matches (e.g., "OpenAI Batch API" ↔ "batch queue worker")
    // that keyword-based FTS5 misses.
    let vectorScores: Map<string, number>;
    try {
      const [contextVec] = await timer.await(
        embedding.embed([sessionContext], "query"),
      );
      const hits = await timer.await(
        embedding.vectorSearch(contextVec, 50, excludeFilter),
      );
      vectorScores = new Map(hits.map((h) => [h.id, h.similarity]));
    } catch (err) {
      log.warn("Vector scoring failed, falling back to FTS5:", err);
      vectorScores = new Map();
    }

    if (vectorScores.size > 0) {
      // Hybrid scoring: vector search only covers entries with stored embeddings.
      // Entries without embeddings (e.g. newly created, async embed not yet done)
      // fall back to FTS5 so they aren't invisible to scoring.
      const ftsScores = await scoreEntriesFTS(sessionContext);

      // Score project entries: prefer vector similarity, fall back to FTS5
      const rawScored: Scored[] = projectEntries.map((entry) => {
        const vecScore = vectorScores.get(entry.id);
        const score =
          vecScore != null
            ? vecScore * entry.confidence
            : (ftsScores.get(entry.id) ?? 0) * entry.confidence;
        return { entry, score };
      });
      const matched = rawScored.filter((s) => s.score > 0);
      const matchedIds = new Set(matched.map((s) => s.entry.id));

      // Safety net: top PROJECT_SAFETY_NET entries by confidence that weren't already matched.
      // Given a tiny score (0.001 * confidence) so they sort below genuinely matched entries.
      const safetyNet = projectEntries
        .filter((e) => !matchedIds.has(e.id))
        .slice(0, PROJECT_SAFETY_NET)
        .map((e) => ({ entry: e, score: 0.001 * e.confidence }));

      scoredProject = [...matched, ...safetyNet];

      // Cross-project: include entries matched by vector OR FTS5
      scoredCross = crossEntries
        .filter((e) => vectorScores.has(e.id) || ftsScores.has(e.id))
        .map((e) => {
          const vecScore = vectorScores.get(e.id);
          const score =
            vecScore != null
              ? vecScore * e.confidence
              : (ftsScores.get(e.id) ?? 0) * e.confidence;
          return { entry: e, score };
        });
    } else {
      // Vector failed — fall through to FTS5
      const ftsScores = await scoreEntriesFTS(sessionContext);
      ({ scoredProject, scoredCross } = scoreFTS(
        projectEntries,
        crossEntries,
        ftsScores,
      ));
    }
  } else if (sessionContext.trim().length > 20) {
    // Embeddings unavailable — use FTS5 BM25 as fallback
    const ftsScores = await scoreEntriesFTS(sessionContext);
    ({ scoredProject, scoredCross } = scoreFTS(
      projectEntries,
      crossEntries,
      ftsScores,
    ));
  } else {
    // No session context — fall back to top entries by confidence, capped.
    // For the cross pool, only blanket-eligible entries (globals + this
    // project's own) qualify; foreign cross-project entries are withheld since
    // there is no context to establish their relevance.
    scoredProject = projectEntries
      .slice(0, NO_CONTEXT_FALLBACK_CAP)
      .map((entry) => ({ entry, score: entry.confidence }));
    scoredCross = crossEntries
      .filter((e) => isBlanketEligible(e, pid))
      .slice(0, NO_CONTEXT_FALLBACK_CAP)
      .map((entry) => ({ entry, score: entry.confidence }));
  }

  // --- 5. Merge and pack into token budget ---
  // Architecture entries get a guaranteed minimum allocation (first 20% of
  // budget) before the general score-ranked packing. These entries provide
  // the structural "map" that makes specific gotchas/decisions interpretable
  // — without them, a gotcha about a subsystem is harder to contextualize.
  const allScored = [...scoredProject, ...scoredCross];

  // Set-stabilization hysteresis: boost entries that were selected last turn so
  // the budget-boundary subset doesn't churn turn-to-turn (which would bust the
  // system[2] prompt cache). Applied uniformly across all scoring paths. A new
  // entry must out-score a sticky one by >(STICKY_RELEVANCE_BONUS-1) to displace
  // it, so selection stays relevance-driven but resists minor fluctuations.
  if (options?.stickyIds?.size) {
    for (const s of allScored) {
      if (options.stickyIds.has(s.entry.id)) s.score *= STICKY_RELEVANCE_BONUS;
    }
  }

  // Deterministic ordering: sort by score DESC, then by entry id ASC as a
  // stable tiebreak. Without the id tiebreak, equal/near-equal scores (or float
  // micro-variations from re-embedding the evolving session context) reorder
  // turn-to-turn, which churns the rendered system[2] text and busts the cache.
  allScored.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.entry.id < b.entry.id ? -1 : 1,
  );

  const HEADER_OVERHEAD_TOKENS = 15;
  const ARCH_BUDGET_FRACTION = 0.2;
  let used = HEADER_OVERHEAD_TOKENS;
  const result: KnowledgeEntry[] = [];
  const packedIds = new Set<string>();

  // Phase 1: Pack architecture entries first (up to 20% of budget)
  const archBudget = Math.floor(maxTokens * ARCH_BUDGET_FRACTION);
  const archEntries = allScored.filter(
    (s) => s.entry.category === "architecture",
  );
  // Sort architecture by score descending (already sorted, but filter may
  // reorder) with the same id tiebreak for deterministic selection.
  archEntries.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.entry.id < b.entry.id ? -1 : 1,
  );
  for (const { entry } of archEntries) {
    if (used >= archBudget + HEADER_OVERHEAD_TOKENS) break;
    const cost = estimateTokens(entry.title + entry.content) + 10;
    if (used + cost > maxTokens) continue; // hard cap: never exceed total budget
    result.push(entry);
    packedIds.add(entry.id);
    used += cost;
  }

  // Phase 2: Pack remaining entries by score descending (skip already packed)
  for (const { entry } of allScored) {
    if (used >= maxTokens) break;
    if (packedIds.has(entry.id)) continue;
    const cost = estimateTokens(entry.title + entry.content) + 10;
    if (used + cost > maxTokens) continue;
    result.push(entry);
    used += cost;
  }

  // --- 6. Pack lat.md sections into remaining budget ---
  // lat.md sections compete for the remaining token budget (shared LTM pool).
  // They are scored separately by BM25 relevance against the same session context.
  if (latReader.hasLatDir(projectPath) && used < maxTokens) {
    const latSections = await latReader.scoreForSession(
      projectPath,
      sessionContext,
      maxTokens - used,
    );
    for (const section of latSections) {
      if (used >= maxTokens) break;
      const display = section.first_paragraph ?? section.content;
      const cost = estimateTokens(section.heading + display) + 10;
      if (used + cost > maxTokens) continue;
      // Convert lat section to a synthetic KnowledgeEntry for formatKnowledge()
      result.push({
        id: section.id,
        logical_id: section.id, // synthetic lat.md entry: its own logical identity
        project_id: section.project_id,
        category: "lat.md",
        title: `[${section.file}] ${section.heading}`,
        content: display,
        source_session: null,
        cross_project: 0,
        confidence: 1.0,
        created_at: section.updated_at,
        updated_at: section.updated_at,
        metadata: null,
        created_by: null,
        updated_by: null,
        sensitivity: "normal",
        promotion_status: null,
        promoted_at: null,
        approval_status: "auto",
        approved_by: null,
        approved_at: null,
        source_user_id: null,
        source_entry_id: null,
        last_accessed_at: null,
        worker_provider_id: null,
        worker_model_id: null,
        last_reinforced_at: null,
      });
      used += cost;
    }
  }

  // --- 7. Record cross-project transfer metrics (issue #506) ---
  // An entry counts as a "transfer" when it was injected into a project that is
  // NOT its origin: cross_project=1 AND a non-null project_id != pid. Global
  // entries (project_id === null) have no origin; self-project entries
  // (project_id === pid) are not transfers; lat.md synthetics are skipped (they
  // are not knowledge rows). The in-memory throttle bounds writes so this
  // every-message path does not hammer SQLite.
  try {
    for (const entry of result) {
      if (entry.category === "lat.md") continue;
      if (entry.cross_project !== 1) continue;
      if (!entry.project_id || entry.project_id === pid) continue;
      if (!shouldRecordTransfer(sessionID, entry.logical_id, pid)) continue;
      recordTransfer({
        knowledgeId: entry.logical_id,
        recalledInProjectId: pid,
      });
    }
  } catch (err) {
    log.warn("forSession: transfer recording failed (non-fatal):", err);
  }

  // --- 8. Reinforce injected entries (confidence lifecycle) ---
  // Being selected for the prompt resets each entry's decay clock — it is "still
  // relevant" — WITHOUT bumping confidence (that would re-flatten everything to
  // 1.0 and destroy the decay signal). lat.md synthetics are not knowledge rows.
  try {
    markInjected(
      result.filter((e) => e.category !== "lat.md").map((e) => e.id),
    );
    recordSessionInjections(sessionID, projectPath, result);
  } catch (err) {
    log.warn("forSession: reinforcement failed (non-fatal):", err);
  }

  // --- 9. Surface the budget-overflow tail (#917) ---
  // Entries that were relevance-scored (`allScored`) but didn't make the
  // budget cut. `allScored` is already sorted score-desc (with id tiebreak), so
  // pushing in iteration order yields deterministic, byte-stable ordering for
  // the caller's recall-on-demand ToC. `allScored` contains only knowledge rows
  // (lat.md synthetics are packed separately in step 6), so this never leaks a
  // lat.md row, which has no recall id.
  if (options?.overflowSink) {
    const selectedIds = new Set(result.map((e) => e.id));
    for (const { entry } of allScored) {
      if (!selectedIds.has(entry.id)) options.overflowSink.push(entry);
    }
  }

  timer.emit("forSession", projectEntries.length + crossEntries.length);
  return result;
}

/** Score entries using FTS5 BM25 — extracted for reuse in the vector-fallback path. */
function scoreFTS(
  projectEntries: KnowledgeEntry[],
  crossEntries: KnowledgeEntry[],
  ftsScores: Map<string, number>,
): { scoredProject: Scored[]; scoredCross: Scored[] } {
  const rawScored: Scored[] = projectEntries.map((entry) => ({
    entry,
    score: (ftsScores.get(entry.id) ?? 0) * entry.confidence,
  }));
  const matched = rawScored.filter((s) => s.score > 0);
  const matchedIds = new Set(matched.map((s) => s.entry.id));

  const safetyNet = projectEntries
    .filter((e) => !matchedIds.has(e.id))
    .slice(0, PROJECT_SAFETY_NET)
    .map((e) => ({ entry: e, score: 0.001 * e.confidence }));

  const scoredProject = [...matched, ...safetyNet];

  const scoredCross = crossEntries
    .filter((e) => ftsScores.has(e.id))
    .map((e) => ({
      entry: e,
      score: (ftsScores.get(e.id) ?? 0) * e.confidence,
    }));

  return { scoredProject, scoredCross };
}

export function all(): KnowledgeEntry[] {
  return db()
    .query(
      `SELECT ${KNOWLEDGE_COLS} FROM knowledge_current WHERE confidence > 0.2 ORDER BY confidence DESC, updated_at DESC`,
    )
    .all()
    .map(hydrateKnowledgeEntry) as KnowledgeEntry[];
}

/** Return all cross-project and global (user-level) knowledge entries. */
export function crossProject(): KnowledgeEntry[] {
  return db()
    .query(
      `SELECT ${KNOWLEDGE_COLS} FROM knowledge_current
       WHERE (project_id IS NULL OR cross_project = 1) AND confidence > 0.2
       ORDER BY confidence DESC, updated_at DESC`,
    )
    .all()
    .map(hydrateKnowledgeEntry) as KnowledgeEntry[];
}

/**
 * Re-score confidence on preference entries using directive-detection patterns.
 * Only touches entries with confidence = 1.0 (legacy/unscored). Entries already
 * scored by the curator (confidence < 1.0) are left untouched.
 *
 * The directive patterns are English-only. To avoid penalizing non-English
 * preferences (e.g. Turkish "her zaman"/"asla" directives), entries whose text
 * matches NO English directive pattern keep their existing confidence rather
 * than being demoted. This means English explicit-prefs are lowered to 0.9 and
 * English strong directives confirmed at 1.0, while everything else (including
 * all non-English entries) retains the curator's chosen confidence.
 *
 * @returns Count of entries updated.
 */
export function rerankPreferences(): number {
  const prefs = db()
    .query(
      `SELECT ${KNOWLEDGE_COLS} FROM knowledge_current WHERE category = 'preference' AND confidence = 1.0`,
    )
    .all()
    .map(hydrateKnowledgeEntry) as KnowledgeEntry[];

  // Strong unconditional directives
  const STRONG_DIRECTIVE_RE = /\b(never|always|must not|must)\b/i;
  // Explicit preference language
  const EXPLICIT_PREF_RE =
    /\b(I (?:want|need|prefer|expect)|make sure to|don'?t forget)\b/i;

  let updated = 0;
  for (const entry of prefs) {
    const text = `${entry.title} ${entry.content}`;
    let newConfidence: number;
    if (STRONG_DIRECTIVE_RE.test(text)) {
      newConfidence = 1.0; // Keep at max — unconditional directive
    } else if (EXPLICIT_PREF_RE.test(text)) {
      newConfidence = 0.9; // Strong but not absolute
    } else {
      // No English directive language detected. Do NOT demote — the patterns
      // are English-only, so a non-match may simply be a non-English directive.
      // Keep the curator's existing confidence instead of forcing 0.8.
      continue;
    }
    if (newConfidence !== entry.confidence) {
      update(entry.id, { confidence: newConfidence });
      updated++;
    }
  }
  return updated;
}

// LIKE-based fallback for when FTS5 fails unexpectedly.
function searchLike(input: {
  query: string;
  projectPath?: string;
  limit: number;
}): KnowledgeEntry[] {
  const terms = input.query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  if (!terms.length) return [];
  const conditions = terms
    .map(() => "(LOWER(title) LIKE ? OR LOWER(content) LIKE ?)")
    .join(" AND ");
  const likeParams = terms.flatMap((t) => [`%${t}%`, `%${t}%`]);
  if (input.projectPath) {
    const pid = ensureProject(input.projectPath);
    return db()
      .query(
        `SELECT ${KNOWLEDGE_COLS} FROM knowledge_current WHERE (project_id = ? OR project_id IS NULL OR cross_project = 1) AND confidence > 0.2 AND ${conditions} ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(pid, ...likeParams, input.limit)
      .map(hydrateKnowledgeEntry) as KnowledgeEntry[];
  }
  return db()
    .query(
      `SELECT ${KNOWLEDGE_COLS} FROM knowledge_current WHERE confidence > 0.2 AND ${conditions} ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...likeParams, input.limit)
    .map(hydrateKnowledgeEntry) as KnowledgeEntry[];
}

export function search(input: {
  query: string;
  projectPath?: string;
  limit?: number;
}): KnowledgeEntry[] {
  const limit = input.limit ?? 20;

  const pid = input.projectPath ? ensureProject(input.projectPath) : null;

  const ftsSQL = pid
    ? `SELECT ${KNOWLEDGE_COLS_K} FROM knowledge_fts f
       CROSS JOIN knowledge k ON k.rowid = f.rowid
         LEFT JOIN knowledge_meta m ON m.logical_id = k.logical_id
       WHERE knowledge_fts MATCH ?
       AND (k.project_id = ? OR k.project_id IS NULL OR k.cross_project = 1)
       AND COALESCE(m.confidence, 1.0) > 0.2
       ORDER BY bm25(knowledge_fts, ?, ?, ?) LIMIT ?`
    : `SELECT ${KNOWLEDGE_COLS_K} FROM knowledge_fts f
       CROSS JOIN knowledge k ON k.rowid = f.rowid
         LEFT JOIN knowledge_meta m ON m.logical_id = k.logical_id
       WHERE knowledge_fts MATCH ?
       AND COALESCE(m.confidence, 1.0) > 0.2
       ORDER BY bm25(knowledge_fts, ?, ?, ?) LIMIT ?`;

  const { title, content, category } = ftsWeights();

  try {
    return runRelaxedSearch(input.query, (matchExpr) => {
      const params = pid
        ? [matchExpr, pid, title, content, category, limit]
        : [matchExpr, title, content, category, limit];
      return db()
        .query(ftsSQL)
        .all(...params)
        .map(hydrateKnowledgeEntry) as KnowledgeEntry[];
    });
  } catch {
    return searchLike({
      query: input.query,
      projectPath: input.projectPath,
      limit,
    });
  }
}

export type ScoredKnowledgeEntry = KnowledgeEntry & { rank: number };

/**
 * Search with BM25 scores included. Returns results with raw FTS5 rank values
 * for use in cross-source score fusion (RRF).
 */
export async function searchScored(input: {
  query: string;
  projectPath?: string;
  limit?: number;
  /** IDF weights from `termIDF()` — when provided, the relaxed cascade
   *  drops common terms first instead of short ones. */
  termWeights?: Map<string, number>;
}): Promise<ScoredKnowledgeEntry[]> {
  const limit = input.limit ?? 20;

  const pid = input.projectPath ? ensureProject(input.projectPath) : null;
  const { title, content, category } = ftsWeights();

  const ftsSQL = pid
    ? `SELECT ${KNOWLEDGE_COLS_K}, bm25(knowledge_fts, ?, ?, ?) as rank FROM knowledge_fts f
       CROSS JOIN knowledge k ON k.rowid = f.rowid
         LEFT JOIN knowledge_meta m ON m.logical_id = k.logical_id
       WHERE knowledge_fts MATCH ?
       AND (k.project_id = ? OR k.project_id IS NULL OR k.cross_project = 1)
       AND COALESCE(m.confidence, 1.0) > 0.2
       ORDER BY rank LIMIT ?`
    : `SELECT ${KNOWLEDGE_COLS_K}, bm25(knowledge_fts, ?, ?, ?) as rank FROM knowledge_fts f
       CROSS JOIN knowledge k ON k.rowid = f.rowid
         LEFT JOIN knowledge_meta m ON m.logical_id = k.logical_id
       WHERE knowledge_fts MATCH ?
       AND COALESCE(m.confidence, 1.0) > 0.2
       ORDER BY rank LIMIT ?`;

  try {
    return await runRelaxedSearchAsync(
      input.query,
      async (matchExpr) => {
        const params = pid
          ? [title, content, category, matchExpr, pid, limit]
          : [title, content, category, matchExpr, limit];
        // Staleness-tolerant knowledge FTS scan — offload off the event loop
        // (#966 B). KNOWLEDGE_COLS_K excludes the embedding BLOB, so the rows are
        // structured-clone-safe across the worker boundary.
        const rows = await offloadAllOrTimeout(ftsSQL, params);
        if (rows === READ_JOB_TIMED_OUT) return null;
        // Hydrate metadata (#627 Phase 1) on the main thread; hydrateKnowledgeEntry
        // preserves the extra `rank` column via spread, so ScoredKnowledgeEntry holds.
        return (rows as Record<string, unknown>[]).map(
          hydrateKnowledgeEntry,
        ) as ScoredKnowledgeEntry[];
      },
      input.termWeights,
    );
  } catch {
    return [];
  }
}

/**
 * Search knowledge entries from OTHER projects — entries that are project-specific
 * (cross_project=0) and belong to a different project_id than the given one.
 * Used by the recall tool in "all" scope to surface relevant knowledge from
 * the user's other projects ("tunnel" discovery across projects).
 */
export async function searchScoredOtherProjects(input: {
  query: string;
  excludeProjectPath: string;
  limit?: number;
  /** IDF weights from `termIDF()` — when provided, the relaxed cascade
   *  drops common terms first instead of short ones. */
  termWeights?: Map<string, number>;
}): Promise<ScoredKnowledgeEntry[]> {
  const limit = input.limit ?? 10;

  const excludePid = ensureProject(input.excludeProjectPath);
  const { title, content, category } = ftsWeights();

  // Find entries from other projects that are NOT cross-project (those are
  // already included in the normal search via the cross_project=1 filter).
  // Also exclude entries with no project_id (global) — already included.
  const ftsSQL = `SELECT ${KNOWLEDGE_COLS_K}, bm25(knowledge_fts, ?, ?, ?) as rank FROM knowledge_fts f
     CROSS JOIN knowledge k ON k.rowid = f.rowid
         LEFT JOIN knowledge_meta m ON m.logical_id = k.logical_id
     WHERE knowledge_fts MATCH ?
     AND k.project_id IS NOT NULL
     AND k.project_id != ?
     AND k.cross_project = 0
     AND COALESCE(m.confidence, 1.0) > 0.2
     ORDER BY rank LIMIT ?`;

  try {
    return await runRelaxedSearchAsync(
      input.query,
      async (matchExpr) => {
        const params = [title, content, category, matchExpr, excludePid, limit];
        // Staleness-tolerant cross-project knowledge FTS scan — offload off the
        // event loop (#966 B). KNOWLEDGE_COLS_K excludes the embedding BLOB.
        const rows = await offloadAllOrTimeout(ftsSQL, params);
        if (rows === READ_JOB_TIMED_OUT) return null;
        // Hydrate metadata (#627 Phase 1) on the main thread — see searchScored above.
        return (rows as Record<string, unknown>[]).map(
          hydrateKnowledgeEntry,
        ) as ScoredKnowledgeEntry[];
      },
      input.termWeights,
    );
  } catch {
    return [];
  }
}

export function get(id: string): KnowledgeEntry | null {
  const row = db()
    .query(`SELECT ${KNOWLEDGE_COLS} FROM knowledge_current WHERE id = ?`)
    .get(id) as Record<string, unknown> | null;
  // Hydrate the `metadata` column like every `.all()` site does — without this
  // the single-row getters would return an unparsed JSON string, violating the
  // `KnowledgeEntry.metadata: KnowledgeMetadata | null` contract (#627 Phase 1).
  return row ? (hydrateKnowledgeEntry(row) as KnowledgeEntry) : null;
}

/**
 * Batch-hydrate current knowledge entries by id, offloaded (#966). Replaces N
 * per-hit `get()` calls in recall's knowledge vector hydration with a single
 * `knowledge_current IN (...)` scan on the read-worker pool. `KNOWLEDGE_COLS`
 * excludes the embedding BLOB, so rows are structured-clone-safe across the
 * worker boundary. Returns a map keyed by id; ids with no current/live row are
 * absent from the map (callers drop them, matching `get()` returning null).
 */
export async function getManyOffloaded(
  ids: string[],
): Promise<Map<string, KnowledgeEntry>> {
  const map = new Map<string, KnowledgeEntry>();
  if (!ids.length) return map;
  const placeholders = ids.map(() => "?").join(",");
  const rows = (await offloadAll(
    `SELECT ${KNOWLEDGE_COLS} FROM knowledge_current WHERE id IN (${placeholders})`,
    ids,
  )) as Record<string, unknown>[];
  for (const row of rows) {
    const entry = hydrateKnowledgeEntry(row) as KnowledgeEntry;
    map.set(entry.id, entry);
  }
  return map;
}

/**
 * Fetch the current entry for a stable `logical_id` (A2, #823). Cross-reference
 * consumers (entity refs, wiki-links, `.lore.md` markers) store `logical_id`, so
 * they must resolve back through this — `get(id)` would miss the entry once a
 * later version supersedes the row whose `id == logical_id`. Today (v1 rows)
 * this is identical to `get()`.
 */
export function getByLogical(logicalId: string): KnowledgeEntry | null {
  const row = db()
    .query(
      `SELECT ${KNOWLEDGE_COLS} FROM knowledge_current WHERE logical_id = ?`,
    )
    .get(logicalId) as Record<string, unknown> | null;
  // Hydrate `metadata` (#627 Phase 1) — see get() above.
  return row ? (hydrateKnowledgeEntry(row) as KnowledgeEntry) : null;
}

/**
 * Resolve any knowledge id — a current version id, a SUPERSEDED version id, or a
 * logical_id — to its stable logical_id. Reads the BASE table (not the view) so
 * it still resolves a superseded version; falls back to the input id if unknown
 * (so ref writers always have a value). This is the canonical resolver the flip
 * (update/remove/syncRefs) uses to stay correct once a version is superseded.
 */
export function logicalIdOf(id: string): string {
  const row = db()
    .query("SELECT logical_id FROM knowledge WHERE id = ?")
    .get(id) as { logical_id: string } | null;
  return row?.logical_id ?? id;
}

/**
 * Read the worker source attribution for a knowledge entry. Returns null for
 * legacy entries created before v35 (no attribution recorded) or for entries
 * imported from outside the worker pipeline (manual `.lore.md` edits, etc).
 *
 * Use this in the dashboard's knowledge-entry detail view to surface the
 * model that produced the entry, and in cost/quality analytics.
 */
export function getWorkerSource(
  id: string,
): { providerID: string; modelID: string } | null {
  const row = db()
    .query(
      "SELECT worker_provider_id, worker_model_id FROM knowledge_current WHERE id = ?",
    )
    .get(id) as {
    worker_provider_id: string | null;
    worker_model_id: string | null;
  } | null;
  if (!row?.worker_provider_id || !row.worker_model_id) return null;
  return {
    providerID: row.worker_provider_id,
    modelID: row.worker_model_id,
  };
}

/**
 * Prune knowledge entries whose content exceeds maxLength characters.
 * These are typically corrupted entries from AGENTS.md roundtrip escaping bugs
 * or curator hallucinations with full code dumps.
 *
 * Rather than hard-deleting, sets confidence to 0 so they're excluded from
 * queries (confidence > 0.2) but can be inspected for debugging.
 *
 * @returns Number of entries pruned
 */
export function pruneOversized(maxLength: number): number {
  // confidence is a register field (A2 3b); the size filter is a knowledge-row
  // fact, so gate via knowledge_current (current+live, exposes content+confidence).
  const result = db()
    .query(
      `UPDATE knowledge_meta SET confidence = 0, updated_at = ?
        WHERE logical_id IN (
          SELECT logical_id FROM knowledge_current
           WHERE LENGTH(content) > ? AND confidence > 0)`,
    )
    .run(Date.now(), maxLength);
  // node:sqlite returns `changes` as `number | bigint`; coerce for cross-runtime parity.
  return Number(result.changes);
}

// ---------------------------------------------------------------------------
// Wiki-link cross-references ([[entry-id]] / [[Entry Title]])
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WIKI_LINK_RE = /\[\[([^\]]+)\]\]/g;

/**
 * Resolve a wiki-link reference to a knowledge entry ID.
 * - UUID format → direct O(1) lookup
 * - Title text → FTS5 best-match search
 * Returns null if the reference can't be resolved.
 */
export function resolveRef(ref: string): string | null {
  if (UUID_RE.test(ref)) {
    // The [[uuid]] in content may be a logical_id or a (possibly superseded)
    // version id — resolve via the base table, then confirm the target still has
    // a current, non-deleted version before linking to it.
    const entry = getByLogical(logicalIdOf(ref));
    return entry ? entry.logical_id : null;
  }
  // Title search — FTS5 best match
  const results = search({ query: ref, limit: 1 });
  return results.length ? results[0].logical_id : null;
}

/**
 * Extract [[...]] wiki-link references from entry content.
 * Returns the raw ref strings (UUIDs or titles).
 */
export function extractRefs(content: string): string[] {
  const refs: string[] = [];
  const re = new RegExp(WIKI_LINK_RE.source, WIKI_LINK_RE.flags);
  let match = re.exec(content);
  while (match !== null) {
    refs.push(match[1]);
    match = re.exec(content);
  }
  return refs;
}

/**
 * Populate the knowledge_refs join table for an entry by resolving its [[...]] links.
 * Clears existing outgoing refs for this entry first.
 */
export function syncRefs(entryId: string): number {
  // entryId may be a current OR superseded version id (the curator passes the id
  // it read, which update() then supersedes). Resolve to the logical_id via the
  // base table, then fetch the current version's content to extract refs from.
  const fromLogical = logicalIdOf(entryId);
  const entry = getByLogical(fromLogical);
  if (!entry) return 0;

  // Clear existing outgoing refs for this entry
  db().query("DELETE FROM knowledge_refs WHERE from_id = ?").run(fromLogical);

  const refs = extractRefs(entry.content);
  if (!refs.length) return 0;

  let synced = 0;
  const insertStmt = db().query(
    "INSERT OR IGNORE INTO knowledge_refs (from_id, to_id) VALUES (?, ?)",
  );

  for (const ref of refs) {
    const targetId = resolveRef(ref); // a logical_id
    if (targetId && targetId !== fromLogical) {
      insertStmt.run(fromLogical, targetId);
      synced++;
    }
  }

  return synced;
}

/**
 * Cascade-replace an entry ID in all knowledge content and the refs table.
 *
 * OBSOLETE under the append-only model (A2, #823): refs now key on the stable
 * `logical_id`, which never changes across version appends, so a version bump no
 * longer changes an entry's ref identity. This mechanism only applies to a
 * genuine logical_id remap (e.g. a dedup survivor adopting a duplicate's id) and
 * has no production caller. Do NOT call it with per-version ids.
 */
export function cascadeRefReplace(oldId: string, newId: string): number {
  const oldRef = `[[${oldId}]]`;
  const newRef = `[[${newId}]]`;

  // Rewrite content in entries that reference the old ID
  const result = db()
    .query(
      `UPDATE knowledge SET content = REPLACE(content, ?, ?), updated_at = ?
       WHERE is_current = 1 AND content LIKE ?`,
    )
    .run(oldRef, newRef, Date.now(), `%${oldRef}%`);

  // Update the join table
  db()
    .query("UPDATE OR IGNORE knowledge_refs SET to_id = ? WHERE to_id = ?")
    .run(newId, oldId);
  db()
    .query("UPDATE OR IGNORE knowledge_refs SET from_id = ? WHERE from_id = ?")
    .run(newId, oldId);

  // Clean up any rows that became self-referential
  db().query("DELETE FROM knowledge_refs WHERE from_id = to_id").run();

  // node:sqlite returns `changes` as `number | bigint`; coerce for cross-runtime parity.
  return Number(result.changes);
}

/**
 * Clean dead references — remove [[uuid]] patterns pointing to deleted entries.
 * Strips dead refs from content and purges orphan knowledge_refs rows.
 *
 * @returns Number of entries whose content was cleaned
 */
export function cleanDeadRefs(): number {
  // Step 1: Find orphan refs (target entry no longer exists)
  // refs key on logical_id (A2): "dead" = a logical_id with no current,
  // non-deleted version.
  const orphans = db()
    .query(
      `SELECT DISTINCT kr.from_id, kr.to_id FROM knowledge_refs kr
       WHERE NOT EXISTS (SELECT 1 FROM knowledge_current k WHERE k.logical_id = kr.to_id)`,
    )
    .all() as Array<{ from_id: string; to_id: string }>;

  if (!orphans.length) return 0;

  // Step 2: Strip [[dead-uuid]] from referring entries' content
  const now = Date.now();
  let cleaned = 0;

  for (const ref of orphans) {
    const deadRef = `[[${ref.to_id}]]`;
    // ref.from_id is a logical_id; strip from the current version. (2b-2: route
    // this through appendVersion so the strip is itself an append, not a mutate.)
    const result = db()
      .query(
        `UPDATE knowledge SET content = REPLACE(content, ?, ''), updated_at = ?
         WHERE logical_id = ? AND is_current = 1 AND content LIKE ?`,
      )
      .run(deadRef, now, ref.from_id, `%${deadRef}%`);
    if (result.changes > 0) cleaned++;
  }

  // Step 3: Delete orphan rows from knowledge_refs
  db()
    .query(
      "DELETE FROM knowledge_refs WHERE to_id NOT IN (SELECT logical_id FROM knowledge_current)",
    )
    .run();

  if (cleaned > 0) {
    log.info(`cleaned ${cleaned} entries with dead [[ref]] links`);
  }

  return cleaned;
}

// ---------------------------------------------------------------------------
// Knowledge integrity checking
// ---------------------------------------------------------------------------

export type IntegrityIssue = {
  entryId: string;
  type: "duplicate" | "stale-path" | "oversized" | "empty";
  description: string;
  suggestion?: string;
};

/**
 * Check knowledge entries for integrity issues.
 * Returns a list of issues found — does NOT auto-fix.
 *
 * Checks:
 * 1. Duplicate detection — FTS5 title similarity between entries
 * 2. Content quality — empty content, oversized entries
 */
export function check(projectPath: string): IntegrityIssue[] {
  const entries = forProject(projectPath, false);
  const issues: IntegrityIssue[] = [];

  // Oversized entries (>1200 chars with confidence > 0)
  for (const entry of entries) {
    if (entry.content.length > 1200) {
      issues.push({
        entryId: entry.id,
        type: "oversized",
        description: `Content is ${entry.content.length} chars (max 1200)`,
        suggestion: "Trim or split into multiple entries",
      });
    }
  }

  // Empty or near-empty content
  for (const entry of entries) {
    if (entry.content.trim().length < 10) {
      issues.push({
        entryId: entry.id,
        type: "empty",
        description: `Content is empty or near-empty (${entry.content.trim().length} chars)`,
        suggestion: "Delete or add meaningful content",
      });
    }
  }

  // Duplicate detection: for each entry, search by title and check for high overlap
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    const q = ftsQuery(entry.title);
    if (q === EMPTY_QUERY) continue;

    try {
      const { title, content, category } = config().search.ftsWeights;
      const matches = db()
        .query(
          `SELECT k.id, k.title FROM knowledge_fts f
           CROSS JOIN knowledge k ON k.rowid = f.rowid
         LEFT JOIN knowledge_meta m ON m.logical_id = k.logical_id
           WHERE knowledge_fts MATCH ?
           AND k.id != ?
           AND COALESCE(m.confidence, 1.0) > 0.2
           ORDER BY bm25(knowledge_fts, ?, ?, ?) LIMIT 3`,
        )
        .all(q, entry.id, title, content, category) as Array<{
        id: string;
        title: string;
      }>;

      for (const match of matches) {
        if (seen.has(match.id)) continue;
        // Check title similarity (case-insensitive)
        const a = entry.title.toLowerCase();
        const b = match.title.toLowerCase();
        // Simple overlap: if one title contains the other or they share >70% of words
        const wordsA = new Set(a.split(/\s+/));
        const wordsB = new Set(b.split(/\s+/));
        const intersection = [...wordsA].filter((w) => wordsB.has(w));
        const overlap =
          intersection.length / Math.min(wordsA.size, wordsB.size);
        if (overlap >= 0.7) {
          issues.push({
            entryId: entry.id,
            type: "duplicate",
            description: `Possibly duplicates "${match.title}" (${match.id.slice(0, 8)}...)`,
            suggestion: `Merge with ${match.id}`,
          });
          seen.add(match.id);
        }
      }
    } catch {
      // FTS5 error — skip this entry
    }
    seen.add(entry.id);
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Deduplication — embedding-based semantic clustering with word-overlap fallback
// ---------------------------------------------------------------------------

export type DedupCluster = {
  surviving: { id: string; title: string };
  merged: Array<{ id: string; title: string }>;
};

/** Stable pair key for two entry IDs — sorted to ensure order-independence. */
export function dedupPairKey(idA: string, idB: string): string {
  return idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;
}

export type DedupResult = {
  clusters: DedupCluster[];
  totalRemoved: number;
  /** Pairwise embedding cosine similarities. Key: dedupPairKey(idA, idB). */
  pairSimilarities: Map<string, number>;
  /** All entry titles by ID — for feedback recording after entries are deleted. */
  entryTitles: Map<string, string>;
};

/**
 * Deduplicate knowledge entries for a project.
 *
 * Uses two complementary signals with "star" clustering (no transitive
 * chains) to prevent snowball merging:
 *
 * 1. **Title word-overlap** (Jaccard on meaningful words) — catches entries
 *    with similar titles regardless of content wording.
 * 2. **Embedding cosine similarity** (when embeddings are available) — catches
 *    entries with different titles but semantically identical content. Nomic
 *    v1.5 produces a same-domain spread of 0.46–0.70 for distinct entries,
 *    making threshold-based dedup viable at 0.935+ (lower thresholds catch
 *    related-but-distinct entries as false positives, especially via star
 *    clustering where a hub entry bridges two distinct topics).
 *
 * Pairs matching either signal are clustered together. For each cluster,
 * picks a survivor (highest confidence, then most recently updated, then
 * shortest title) and removes the rest.
 *
 * @param projectPath   Project root path
 * @param opts.dryRun   If true (default), report clusters without deleting
 * @returns             Cluster report and count of removed entries
 */
/** Core dedup logic — operates on an arbitrary list of entries. */
function _dedup(
  entries: KnowledgeEntry[],
  dryRun: boolean,
  embeddingThreshold: number = EMBEDDING_DEDUP_THRESHOLD,
): DedupResult {
  if (entries.length < 2)
    return {
      clusters: [],
      totalRemoved: 0,
      pairSimilarities: new Map(),
      entryTitles: new Map(),
    };

  // --- Build neighbor map using title overlap + embedding similarity ---
  // Two entries are considered neighbors (potential duplicates) if EITHER:
  //   (a) title word-overlap ≥ 0.7 with ≥ 4 shared words, OR
  //   (b) embedding cosine similarity ≥ embeddingThreshold (default 0.935)
  // Star clustering (no transitivity) prevents snowball merging.
  // O(n²) pairwise comparison — acceptable for n ≤ 25 (maxEntries cap).

  // Load embeddings for the given entries (if available).
  // We query directly rather than using vectorSearch() because we need
  // pairwise comparison among entries, not a query-vs-all search.
  const embeddingMap = new Map<string, Float32Array>();
  {
    const entryIds = entries.map((e) => e.id);
    // Build parameterized IN clause for the entry IDs
    const placeholders = entryIds.map(() => "?").join(",");
    const rows = db()
      .query(
        `SELECT id, embedding FROM knowledge_current WHERE embedding IS NOT NULL AND id IN (${placeholders})`,
      )
      .all(...entryIds) as Array<{ id: string; embedding: Buffer }>;
    for (const row of rows) {
      try {
        embeddingMap.set(row.id, embedding.fromBlob(row.embedding));
      } catch {
        // Skip corrupted embeddings — entry falls back to title-overlap only.
        log.info(`skipping corrupted embedding for entry ${row.id}`);
      }
    }
  }

  // Pre-compute neighbors for all UNIQUE pairs — title overlap and cosine
  // similarity are both symmetric, so (A,B) == (B,A). Iterating over unique
  // pairs halves the number of comparisons (n*(n-1)/2 instead of n²).
  type DedupHit = { id: string; score: number };
  const neighborMap = new Map<string, DedupHit[]>();
  const pairSimilarities = new Map<string, number>();

  for (let i = 0; i < entries.length; i++) {
    if (!neighborMap.has(entries[i].id)) neighborMap.set(entries[i].id, []);
    const entryVec = embeddingMap.get(entries[i].id);

    for (let j = i + 1; j < entries.length; j++) {
      const entry = entries[i];
      const other = entries[j];

      // Signal 1: title word-overlap
      const { coefficient, intersectionSize } = titleOverlap(
        entry.title,
        other.title,
      );
      const titleMatch =
        coefficient >= FUZZY_DEDUP_THRESHOLD &&
        intersectionSize >= FUZZY_DEDUP_MIN_OVERLAP;

      // Signal 2: embedding cosine similarity
      let embeddingMatch = false;
      let similarity = 0;
      if (entryVec) {
        const otherVec = embeddingMap.get(other.id);
        if (otherVec && entryVec.length === otherVec.length) {
          similarity = embedding.cosineSimilarity(entryVec, otherVec);
          embeddingMatch = similarity >= embeddingThreshold;
        }
      }

      // Track pairwise embedding similarity for calibration
      if (similarity > 0) {
        pairSimilarities.set(dedupPairKey(entry.id, other.id), similarity);
      }

      if (titleMatch || embeddingMatch) {
        const score = Math.max(coefficient, similarity);
        const entryNeighbors = neighborMap.get(entry.id);
        if (entryNeighbors) entryNeighbors.push({ id: other.id, score });
        if (!neighborMap.has(other.id)) neighborMap.set(other.id, []);
        const otherNeighbors = neighborMap.get(other.id);
        if (otherNeighbors) otherNeighbors.push({ id: entry.id, score });
      }
    }
  }
  for (const neighbors of neighborMap.values()) {
    neighbors.sort((a, b) => b.score - a.score);
  }

  // Greedy star clustering — process entries with most neighbors first
  const claimed = new Set<string>();
  const rawClusters = new Map<string, string[]>();

  const sortedIds = [...neighborMap.keys()].sort(
    (a, b) =>
      (neighborMap.get(b)?.length ?? 0) - (neighborMap.get(a)?.length ?? 0),
  );

  for (const centerId of sortedIds) {
    if (claimed.has(centerId)) continue;
    claimed.add(centerId);
    const members = [centerId];

    for (const { id: neighborId } of neighborMap.get(centerId) ?? []) {
      if (claimed.has(neighborId)) continue;
      claimed.add(neighborId);
      members.push(neighborId);
    }

    if (members.length > 1) {
      rawClusters.set(centerId, members);
    }
  }

  // Build clusters and pick survivors
  const entryById = new Map(entries.map((e) => [e.id, e]));
  const result: DedupCluster[] = [];
  let totalRemoved = 0;

  for (const members of rawClusters.values()) {
    if (members.length < 2) continue;

    // Pick survivor: highest confidence → most recent → shortest title
    const sorted = members
      .map((id) => entryById.get(id))
      .filter((e): e is NonNullable<typeof e> => e !== undefined)
      .sort((a, b) => {
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        if (b.updated_at !== a.updated_at) return b.updated_at - a.updated_at;
        return a.title.length - b.title.length;
      });

    const survivor = sorted[0];
    const merged = sorted.slice(1);

    result.push({
      surviving: { id: survivor.id, title: survivor.title },
      merged: merged.map((e) => ({ id: e.id, title: e.title })),
    });

    if (!dryRun) {
      for (const entry of merged) {
        remove(entry.id);
      }
    }

    totalRemoved += merged.length;
  }

  // Sort clusters by size descending for readability
  result.sort((a, b) => b.merged.length - a.merged.length);

  // Build title map from all input entries — survives entry deletion.
  const entryTitles = new Map(entries.map((e) => [e.id, e.title]));

  return { clusters: result, totalRemoved, pairSimilarities, entryTitles };
}

export async function deduplicate(
  projectPath: string,
  opts?: { dryRun?: boolean },
): Promise<DedupResult> {
  const pid = ensureProject(projectPath);
  const threshold = loadCalibratedThreshold(pid) ?? EMBEDDING_DEDUP_THRESHOLD;
  const entries = forProject(projectPath, false);
  return _dedup(entries, opts?.dryRun ?? true, threshold);
}

/** Deduplicate global (cross-project) entries that have no project_id. */
export async function deduplicateGlobal(opts?: {
  dryRun?: boolean;
}): Promise<DedupResult> {
  const threshold = loadCalibratedThreshold(null) ?? EMBEDDING_DEDUP_THRESHOLD;
  const entries = db()
    .query(
      `SELECT ${KNOWLEDGE_COLS} FROM knowledge_current
       WHERE project_id IS NULL
       AND confidence > 0.2
       ORDER BY confidence DESC, updated_at DESC`,
    )
    .all()
    .map(hydrateKnowledgeEntry) as KnowledgeEntry[];
  return _dedup(entries, opts?.dryRun ?? true, threshold);
}

// ---------------------------------------------------------------------------
// Cross-project auto-promotion (issue #498)
// ---------------------------------------------------------------------------

/** A cluster of semantically-similar entries that spans multiple projects. */
export type PromotionCluster = {
  /** IDs of the entries in this cluster (all promoted when it qualifies). */
  memberIds: string[];
  /** Number of distinct project_ids represented in the cluster. */
  distinctProjects: number;
};

export type PromotionResult = {
  /** Number of entries flipped to cross_project = 1. */
  promoted: number;
  /** Qualifying clusters (distinctProjects >= MIN_PROMOTION_PROJECTS). */
  clusters: PromotionCluster[];
};

/**
 * Detect knowledge entries whose meaning appears across 3+ unrelated projects
 * and promote them to cross_project = 1 in place.
 *
 * Candidates are project-scoped (non-null project_id, cross_project = 0),
 * high-confidence (>= MIN_PROMOTION_CONFIDENCE), embedded entries. They are
 * clustered across project boundaries by embedding cosine similarity using the
 * same star-clustering (no-transitivity) approach as dedup. A cluster qualifies
 * when it spans >= MIN_PROMOTION_PROJECTS distinct project_ids; every member is
 * then flipped to cross_project = 1 with promotion_status = 'promoted'.
 *
 * No-ops (returns { promoted: 0, clusters: [] }) when embeddings are unavailable.
 */
export function promoteCrossProject(opts?: {
  dryRun?: boolean;
}): PromotionResult {
  const dryRun = opts?.dryRun ?? false;
  if (!embedding.isAvailable()) return { promoted: 0, clusters: [] };

  // 1. Load eligible candidate entries (project-scoped, high-confidence, embedded).
  //    Capped at MAX_PROMOTION_CANDIDATES to keep pairwise comparison bounded.
  //    Query orders by confidence DESC so the best entries survive.
  const candidates = db()
    .query(
      `SELECT ${KNOWLEDGE_COLS} FROM knowledge_current
       WHERE project_id IS NOT NULL
       AND cross_project = 0
       AND confidence >= ?
       AND embedding IS NOT NULL
       ORDER BY confidence DESC, updated_at DESC
       LIMIT ?`,
    )
    .all(MIN_PROMOTION_CONFIDENCE, MAX_PROMOTION_CANDIDATES)
    .map(hydrateKnowledgeEntry) as KnowledgeEntry[];

  if (candidates.length < MIN_PROMOTION_PROJECTS) {
    // Fewer entries than the minimum distinct-project requirement — impossible
    // to span enough projects.
    return { promoted: 0, clusters: [] };
  }

  // 2. Load embeddings for the candidate set.
  const embeddingMap = new Map<string, Float32Array>();
  {
    const ids = candidates.map((e) => e.id);
    const placeholders = ids.map(() => "?").join(",");
    const rows = db()
      .query(
        `SELECT id, embedding FROM knowledge_current WHERE embedding IS NOT NULL AND id IN (${placeholders})`,
      )
      .all(...ids) as Array<{ id: string; embedding: Buffer }>;
    for (const row of rows) {
      try {
        embeddingMap.set(row.id, embedding.fromBlob(row.embedding));
      } catch {
        log.info(`skipping corrupted embedding for entry ${row.id}`);
      }
    }
  }

  // 3. Build neighbor map by cross-project embedding similarity.
  //    Iterate unique pairs (i < j) and record the relationship symmetrically
  //    to halve the number of cosineSimilarity calls.
  const neighborMap = new Map<string, string[]>();
  for (const c of candidates) neighborMap.set(c.id, []);
  for (let i = 0; i < candidates.length; i++) {
    const entry = candidates[i];
    const entryVec = embeddingMap.get(entry.id);
    if (!entryVec) continue;
    for (let j = i + 1; j < candidates.length; j++) {
      const other = candidates[j];
      const otherVec = embeddingMap.get(other.id);
      if (!otherVec || otherVec.length !== entryVec.length) continue;
      if (
        embedding.cosineSimilarity(entryVec, otherVec) >=
        PROMOTION_SIMILARITY_THRESHOLD
      ) {
        neighborMap.get(entry.id)?.push(other.id);
        neighborMap.get(other.id)?.push(entry.id);
      }
    }
  }

  // 4. Greedy star clustering (no transitivity) — process entries with the
  //    most neighbors first, claim center + unclaimed neighbors.
  const entryById = new Map(candidates.map((e) => [e.id, e]));
  const claimed = new Set<string>();
  const sortedIds = [...neighborMap.keys()].sort(
    (a, b) =>
      (neighborMap.get(b)?.length ?? 0) - (neighborMap.get(a)?.length ?? 0),
  );

  const clusters: PromotionCluster[] = [];
  const toPromote: string[] = [];

  for (const centerId of sortedIds) {
    if (claimed.has(centerId)) continue;
    claimed.add(centerId);
    const members = [centerId];
    for (const neighborId of neighborMap.get(centerId) ?? []) {
      if (claimed.has(neighborId)) continue;
      claimed.add(neighborId);
      members.push(neighborId);
    }

    // 5. Qualify cluster by distinct project count.
    const projects = new Set<string>();
    for (const id of members) {
      const pid = entryById.get(id)?.project_id;
      if (pid) projects.add(pid);
    }
    if (projects.size < MIN_PROMOTION_PROJECTS) continue;

    clusters.push({ memberIds: members, distinctProjects: projects.size });
    toPromote.push(...members);
  }

  // 6. Flip qualifying members to cross_project = 1 in place.
  if (!dryRun && toPromote.length) {
    const now = Date.now();
    const stmt = db().query(
      `UPDATE knowledge
       SET cross_project = 1, promotion_status = 'promoted', promoted_at = ?, updated_at = ?
       WHERE id = ? AND is_current = 1`,
    );
    for (const id of toPromote) {
      stmt.run(now, now, id);
    }
  }

  return { promoted: toPromote.length, clusters };
}

// ---------------------------------------------------------------------------
// Dedup feedback & adaptive threshold calibration
// ---------------------------------------------------------------------------

export type DedupFeedbackSource =
  | "auto_dedup"
  | "cli_yes"
  | "cli_interactive"
  | "dashboard";

const MIN_CALIBRATION_SAMPLES = 20;
const DEFAULT_EMBEDDING_DEDUP_THRESHOLD = EMBEDDING_DEDUP_THRESHOLD;
/** Only record auto-signals for pairs with similarity >= this floor. */
const AUTO_SIGNAL_MIN_SIMILARITY = 0.8;
/** Max auto-signal pairs to record per dedup run (closest to threshold). */
const AUTO_SIGNAL_MAX_PAIRS = 50;

/** Record a single dedup feedback row. */
export function recordDedupFeedback(input: {
  projectId: string | null;
  entryATitle: string;
  entryBTitle: string;
  similarity: number;
  accepted: boolean;
  source: DedupFeedbackSource;
}): void {
  db()
    .query(
      `INSERT INTO dedup_feedback
         (project_id, entry_a_title, entry_b_title, similarity, accepted, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
 * Return a Set of "titleA\x1ftitleB" keys for knowledge pairs that have been
 * explicitly dismissed (accepted=0) via the dashboard. Both orderings are
 * included so callers can do a single `has()` check.
 *
 * Mirrors entities.getDismissedEntityPairs() but for kind='knowledge'.
 * Dismissals are title-based; renaming an entry resets its dismiss state.
 */
export function getDismissedKnowledgePairs(): Set<string> {
  const rows = db()
    .query(
      `SELECT entry_a_title, entry_b_title FROM dedup_feedback
       WHERE kind = 'knowledge' AND accepted = 0 AND source = 'dashboard'`,
    )
    .all() as Array<{ entry_a_title: string; entry_b_title: string }>;
  const dismissed = new Set<string>();
  for (const r of rows) {
    dismissed.add(`${r.entry_a_title}\x1f${r.entry_b_title}`);
    dismissed.add(`${r.entry_b_title}\x1f${r.entry_a_title}`);
  }
  return dismissed;
}

/**
 * Bulk-record feedback for all merged pairs in a DedupResult.
 * Only records pairs with embedding similarity > 0 (title-overlap-only
 * matches are excluded from calibration).
 */
export function recordDedupResultFeedback(
  projectId: string | null,
  result: DedupResult,
  accepted: boolean,
  source: DedupFeedbackSource,
): void {
  // Batch every row into a single transaction: each recordDedupFeedback() is a
  // standalone INSERT that would otherwise auto-commit on its own (one write
  // lock cycle per merged pair). Wrapping makes the whole signal set atomic.
  withTransaction(() => {
    for (const cluster of result.clusters) {
      for (const merged of cluster.merged) {
        const pk = dedupPairKey(cluster.surviving.id, merged.id);
        const similarity = result.pairSimilarities.get(pk);
        if (similarity != null && similarity > 0) {
          recordDedupFeedback({
            projectId,
            entryATitle: cluster.surviving.title,
            entryBTitle: merged.title,
            similarity,
            accepted,
            source,
          });
        }
      }
    }
  });
}

/**
 * Record automatic calibration signals from a post-curation dedup sweep.
 *
 * Only records **reject** signals — non-merged pairs with similarity in
 * [0.80, threshold). Accept signals from auto-dedup are tautological (the
 * pair was merged *because* its similarity exceeded the threshold), so they
 * provide no new information and would create a self-reinforcing feedback
 * loop. Manual signals (cli_yes, cli_interactive) provide the accept side.
 *
 * Caps at AUTO_SIGNAL_MAX_PAIRS most interesting pairs per run (closest
 * to the threshold boundary) to avoid table bloat.
 */
export function recordAutoSignals(
  projectId: string | null,
  result: DedupResult,
): void {
  // Collect merged pair IDs for quick lookup (to exclude from reject signals)
  const mergedPairs = new Set<string>();
  for (const cluster of result.clusters) {
    for (const merged of cluster.merged) {
      mergedPairs.add(dedupPairKey(cluster.surviving.id, merged.id));
    }
  }

  // Build a title map — we need titles for reject signals (non-merged pairs).
  // Use entryTitles from result first, then fall back to cluster data.
  const titleMap = new Map<string, string>(result.entryTitles);
  for (const cluster of result.clusters) {
    if (!titleMap.has(cluster.surviving.id)) {
      titleMap.set(cluster.surviving.id, cluster.surviving.title);
    }
    for (const m of cluster.merged) {
      if (!titleMap.has(m.id)) titleMap.set(m.id, m.title);
    }
  }

  // Collect reject signals: non-merged pairs with high similarity
  type Signal = {
    entryATitle: string;
    entryBTitle: string;
    similarity: number;
  };
  const signals: Signal[] = [];

  for (const [pk, sim] of result.pairSimilarities) {
    if (sim < AUTO_SIGNAL_MIN_SIMILARITY) continue;
    if (mergedPairs.has(pk)) continue; // merged pair — skip (tautological accept)

    const [idA, idB] = pk.split(":");
    const titleA = titleMap.get(idA);
    const titleB = titleMap.get(idB);
    if (!titleA || !titleB) continue;

    signals.push({ entryATitle: titleA, entryBTitle: titleB, similarity: sim });
  }

  // Sort by distance to threshold boundary (most informative first), cap
  const currentThreshold =
    loadCalibratedThreshold(projectId) ?? DEFAULT_EMBEDDING_DEDUP_THRESHOLD;
  signals.sort(
    (a, b) =>
      Math.abs(a.similarity - currentThreshold) -
      Math.abs(b.similarity - currentThreshold),
  );
  const capped = signals.slice(0, AUTO_SIGNAL_MAX_PAIRS);

  // Prune + insert atomically in a single transaction. Without this each
  // recordDedupFeedback() below auto-commits on its own (up to
  // AUTO_SIGNAL_MAX_PAIRS write-lock cycles per sweep); wrapping collapses the
  // whole sweep into one commit and keeps prune+insert consistent.
  withTransaction(() => {
    // Prune old feedback to prevent unbounded table growth
    pruneDedupFeedback(projectId);

    for (const s of capped) {
      recordDedupFeedback({
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

/** Get all feedback for a project (for calibration). */
export function getDedupFeedback(
  projectId: string | null,
): Array<{ similarity: number; accepted: boolean; source: string }> {
  // Scope to kind='knowledge' so entity dedup feedback (kind='entity') never
  // pollutes knowledge threshold calibration (mirrors entities.ts).
  const rows = (
    projectId !== null
      ? db()
          .query(
            "SELECT similarity, accepted, source FROM dedup_feedback WHERE kind = 'knowledge' AND project_id = ? ORDER BY similarity",
          )
          .all(projectId)
      : db()
          .query(
            "SELECT similarity, accepted, source FROM dedup_feedback WHERE kind = 'knowledge' AND project_id IS NULL ORDER BY similarity",
          )
          .all()
  ) as Array<{ similarity: number; accepted: number; source: string }>;
  return rows.map((r) => ({
    similarity: r.similarity,
    accepted: r.accepted === 1,
    source: r.source,
  }));
}

/** Quick count of feedback rows for a project. */
export function getDedupFeedbackCount(projectId: string | null): number {
  const row = (
    projectId !== null
      ? db()
          .query(
            "SELECT COUNT(*) as cnt FROM dedup_feedback WHERE kind = 'knowledge' AND project_id = ?",
          )
          .get(projectId)
      : db()
          .query(
            "SELECT COUNT(*) as cnt FROM dedup_feedback WHERE kind = 'knowledge' AND project_id IS NULL",
          )
          .get()
  ) as { cnt: number } | null;
  return row?.cnt ?? 0;
}

/** Max feedback rows to keep per project (prevents unbounded growth). */
const MAX_FEEDBACK_ROWS_PER_PROJECT = 500;

/**
 * Prune old feedback rows for a project, keeping the most recent
 * MAX_FEEDBACK_ROWS_PER_PROJECT rows. Called from recordAutoSignals
 * to prevent unbounded table growth.
 */
export function pruneDedupFeedback(projectId: string | null): void {
  const count = getDedupFeedbackCount(projectId);
  if (count <= MAX_FEEDBACK_ROWS_PER_PROJECT) return;

  const excess = count - MAX_FEEDBACK_ROWS_PER_PROJECT;
  if (projectId !== null) {
    db()
      .query(
        `DELETE FROM dedup_feedback WHERE id IN (
           SELECT id FROM dedup_feedback WHERE kind = 'knowledge' AND project_id = ?
           ORDER BY created_at ASC LIMIT ?
         )`,
      )
      .run(projectId, excess);
  } else {
    db()
      .query(
        `DELETE FROM dedup_feedback WHERE id IN (
           SELECT id FROM dedup_feedback WHERE kind = 'knowledge' AND project_id IS NULL
           ORDER BY created_at ASC LIMIT ?
         )`,
      )
      .run(excess);
  }
}

// ---------------------------------------------------------------------------
// Cross-project knowledge transfer metrics (issue #506)
// ---------------------------------------------------------------------------

/**
 * Record that a knowledge entry was surfaced in a project other than its
 * origin. UPSERT-increments the (knowledge_id, recalled_in_project_id) tally.
 *
 * Callers MUST pre-filter:
 *   - the entry's origin project must be non-null (global entries are not
 *     transfers)
 *   - recalledInProjectId !== the entry's origin project (no self-project
 *     recalls)
 * This function trusts those invariants but defensively no-ops on an empty
 * recalled-in id.
 */
export function recordTransfer(input: {
  knowledgeId: string;
  recalledInProjectId: string;
}): void {
  if (!input.recalledInProjectId) return;
  const now = Date.now();
  db()
    .query(
      `INSERT INTO knowledge_transfers
         (knowledge_id, recalled_in_project_id, hit_count, first_recalled_at, last_recalled_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(knowledge_id, recalled_in_project_id) DO UPDATE SET
         hit_count = hit_count + 1,
         last_recalled_at = ?`,
    )
    .run(input.knowledgeId, input.recalledInProjectId, now, now, now);
}

/**
 * Number of distinct foreign projects an entry has been recalled in. Each
 * composite-PK row is already one distinct foreign project, so a plain
 * COUNT(*) suffices.
 */
export function transferCount(knowledgeId: string): number {
  const row = db()
    .query(
      "SELECT COUNT(*) as cnt FROM knowledge_transfers WHERE knowledge_id = ?",
    )
    .get(knowledgeId) as { cnt: number } | null;
  return row?.cnt ?? 0;
}

/**
 * Distinct-foreign-project transfer counts for ALL entries, keyed by
 * knowledge_id. Batch-loaded for the user-knowledge list page to avoid N+1.
 */
export function transferCounts(): Map<string, number> {
  const rows = db()
    .query(
      "SELECT knowledge_id, COUNT(*) as cnt FROM knowledge_transfers GROUP BY knowledge_id",
    )
    .all() as Array<{ knowledge_id: string; cnt: number }>;
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.knowledge_id, r.cnt);
  return m;
}

export type KnowledgeTransfer = {
  recalled_in_project_id: string;
  hit_count: number;
  first_recalled_at: number;
  last_recalled_at: number;
};

/** Full per-foreign-project breakdown for one entry, newest activity first. */
export function transfersFor(knowledgeId: string): KnowledgeTransfer[] {
  return db()
    .query(
      `SELECT recalled_in_project_id, hit_count, first_recalled_at, last_recalled_at
         FROM knowledge_transfers
        WHERE knowledge_id = ?
        ORDER BY last_recalled_at DESC`,
    )
    .all(knowledgeId) as KnowledgeTransfer[];
}

// --- forSession transfer-recording throttle (in-memory, process-local) ------
//
// forSession() runs on (nearly) every message transform. Recording every
// cross-pool entry on every call would hammer SQLite. This guard records each
// (sessionID, knowledgeId, recalledInProjectId) tuple at most once per
// TRANSFER_DEDUP_WINDOW_MS. The map is bounded by TRANSFER_DEDUP_MAX_KEYS with
// FIFO eviction (Map preserves insertion order). State is volatile — the tally
// is durable in the DB, so a process restart simply re-opens the window.
const transferDedup = new Map<string, number>();
const TRANSFER_DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30 min
const TRANSFER_DEDUP_MAX_KEYS = 50_000;

function shouldRecordTransfer(
  sessionID: string | undefined,
  knowledgeId: string,
  recalledInProjectId: string,
): boolean {
  // No session → stable synthetic key so we still throttle per (entry, project).
  const sid = sessionID ?? "__nosession__";
  const key = `${sid}\x1f${knowledgeId}\x1f${recalledInProjectId}`;
  const now = Date.now();
  const last = transferDedup.get(key);
  if (last != null && now - last < TRANSFER_DEDUP_WINDOW_MS) return false;

  if (transferDedup.size >= TRANSFER_DEDUP_MAX_KEYS) {
    // Evict ~10% oldest to bound memory.
    const evict = Math.ceil(TRANSFER_DEDUP_MAX_KEYS * 0.1);
    let i = 0;
    for (const k of transferDedup.keys()) {
      transferDedup.delete(k);
      if (++i >= evict) break;
    }
  }
  transferDedup.set(key, now);
  return true;
}

/** Test-only: clear the in-memory forSession transfer-recording throttle. */
export function __resetTransferDedup(): void {
  transferDedup.clear();
}

/**
 * Compute an optimal embedding dedup threshold from user feedback.
 *
 * Algorithm:
 * 1. Load all (similarity, accepted) pairs for the project.
 * 2. If fewer than MIN_CALIBRATION_SAMPLES, return null (use default).
 * 3. If all feedback is "accept" (no rejects), return the minimum
 *    accepted similarity minus a small margin (0.005).
 * 4. If all feedback is "reject" (no accepts), return null.
 * 5. Otherwise, find the threshold that maximizes separation:
 *    - For each candidate threshold (midpoint between consecutive
 *      distinct similarity values), compute accuracy:
 *        correct = accepted_pairs_above + rejected_pairs_below
 *        accuracy = correct / total
 *    - Pick the threshold with highest accuracy.
 *    - Tie-break: prefer higher threshold (conservative).
 *    - Clamp to [0.85, 0.98].
 */
export function calibrateDedupThreshold(
  projectId: string | null,
): number | null {
  const feedback = getDedupFeedback(projectId);
  if (feedback.length < MIN_CALIBRATION_SAMPLES) return null;

  const accepted = feedback.filter((f) => f.accepted);
  const rejected = feedback.filter((f) => !f.accepted);

  // Edge case: all accept, no rejects
  if (rejected.length === 0) {
    const minAccepted = Math.min(...accepted.map((f) => f.similarity));
    return Math.max(0.85, minAccepted - 0.005);
  }

  // Edge case: all reject, no accepts
  if (accepted.length === 0) {
    log.warn(
      "dedup calibration: all feedback is reject — keeping default threshold",
    );
    return null;
  }

  // Find optimal threshold via accuracy maximization
  const allSims = [...new Set(feedback.map((f) => f.similarity))].sort(
    (a, b) => a - b,
  );

  let bestThreshold = DEFAULT_EMBEDDING_DEDUP_THRESHOLD;
  let bestAccuracy = -1;

  for (let i = 0; i < allSims.length - 1; i++) {
    const candidate = (allSims[i] + allSims[i + 1]) / 2;

    // Pairs above threshold are predicted "merge" — should be accepted
    // Pairs below threshold are predicted "keep separate" — should be rejected
    const correctAccepted = accepted.filter(
      (f) => f.similarity >= candidate,
    ).length;
    const correctRejected = rejected.filter(
      (f) => f.similarity < candidate,
    ).length;
    const accuracy = (correctAccepted + correctRejected) / feedback.length;

    // Tie-break: prefer higher threshold (conservative — fewer false merges)
    if (
      accuracy > bestAccuracy ||
      (accuracy === bestAccuracy && candidate > bestThreshold)
    ) {
      bestAccuracy = accuracy;
      bestThreshold = candidate;
    }
  }

  // Clamp to sane range
  return Math.max(0.85, Math.min(0.98, bestThreshold));
}

/** Persist the calibrated threshold for a project. */
export function saveCalibratedThreshold(
  projectId: string | null,
  threshold: number,
  sampleSize: number,
): void {
  const key = `dedup_threshold:${projectId ?? "global"}`;
  setKV(
    key,
    JSON.stringify({ threshold, sampleSize, calibratedAt: Date.now() }),
  );
}

/** Load the calibrated threshold for a project, or null if not calibrated. */
export function loadCalibratedThreshold(
  projectId: string | null,
): number | null {
  const key = `dedup_threshold:${projectId ?? "global"}`;
  const raw = getKV(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed.threshold === "number" ? parsed.threshold : null;
  } catch {
    return null;
  }
}
