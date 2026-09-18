/**
 * Keyset-paginated list queries for the management API (#1799, #1800).
 *
 * Everything here is read-only and additive to the legacy `ltm.forProject()` /
 * `data.listSessions()` readers: the legacy callers keep their exact ordering
 * and shape, while these helpers return a deterministic page plus the keyset
 * needed to fetch the next one. Cursors are encoded by the caller (the gateway
 * owns the opaque token format); core only speaks in typed keysets so the
 * ordering contract lives next to the SQL that implements it.
 *
 * Ordering is always `<sort key> <dir>, id <dir>` so equal sort keys still
 * produce a total order — a page boundary inside a run of equal keys resumes
 * exactly where it left off, and rows inserted/mutated between pages never
 * cause a row to be skipped or repeated unless its own sort key moved.
 */
import { db, ensureProject } from "./db";
import { hydrateKnowledgeEntry, type KnowledgeEntry, logicalIdOf } from "./ltm";
import type { ReadParam } from "./read-job";
import { ftsQuery, EMPTY_QUERY } from "./search";
import { currentTenantId } from "./tenant";
import type { SessionSummary } from "./data";

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

export const KNOWLEDGE_SORTS = [
  "updated_desc",
  "created_desc",
  "confidence_desc",
  "title_asc",
] as const;
export type KnowledgeSort = (typeof KNOWLEDGE_SORTS)[number];

/** `project`: entries owned by the project (legacy list behaviour).
 *  `global`: project-less entries visible to every project.
 *  `all`: everything the project can see (own + global + cross_project). */
export const KNOWLEDGE_SCOPES = ["project", "global", "all"] as const;
export type KnowledgeScope = (typeof KNOWLEDGE_SCOPES)[number];

export const KNOWLEDGE_CATEGORIES = [
  "decision",
  "pattern",
  "preference",
  "architecture",
  "gotcha",
] as const;
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

export function isKnowledgeSort(v: string): v is KnowledgeSort {
  return (KNOWLEDGE_SORTS as readonly string[]).includes(v);
}
export function isKnowledgeScope(v: string): v is KnowledgeScope {
  return (KNOWLEDGE_SCOPES as readonly string[]).includes(v);
}
export function isKnowledgeCategory(v: string): v is KnowledgeCategory {
  return (KNOWLEDGE_CATEGORIES as readonly string[]).includes(v);
}

/** Position of the last row of the previous page. `key` is the sort column's
 *  value for that row (number for timestamps/confidence, string for title);
 *  `id` is the per-version knowledge id used as the tiebreaker. */
export type KnowledgeKeyset = { key: number | string; id: string };

export type KnowledgeListOptions = {
  q?: string;
  category?: KnowledgeCategory;
  scope?: KnowledgeScope;
  sort?: KnowledgeSort;
};

export type KnowledgePage = {
  items: KnowledgeEntry[];
  /** Keyset of the last item, or null when this is the final page. */
  next: KnowledgeKeyset | null;
};

const SORT_SPEC: Record<
  KnowledgeSort,
  { column: string; dir: "ASC" | "DESC"; kind: "number" | "string" }
> = {
  updated_desc: { column: "updated_at", dir: "DESC", kind: "number" },
  created_desc: { column: "created_at", dir: "DESC", kind: "number" },
  confidence_desc: { column: "confidence", dir: "DESC", kind: "number" },
  title_asc: { column: "title", dir: "ASC", kind: "string" },
};

/** Sort key of an entry under `sort`, i.e. what `KnowledgeKeyset.key` holds. */
export function knowledgeSortKey(
  entry: KnowledgeEntry,
  sort: KnowledgeSort,
): number | string {
  switch (sort) {
    case "updated_desc":
      return entry.updated_at;
    case "created_desc":
      return entry.created_at;
    case "confidence_desc":
      return entry.confidence;
    case "title_asc":
      return entry.title;
  }
}

/** True when `key` has the JS type the sort's column produces — a decoded
 *  cursor carrying a string key for a numeric sort is malformed. */
export function knowledgeKeysetMatchesSort(
  key: KnowledgeKeyset,
  sort: KnowledgeSort,
): boolean {
  const kind = SORT_SPEC[sort].kind;
  if (kind === "number")
    return typeof key.key === "number" && Number.isFinite(key.key);
  return typeof key.key === "string";
}

/** Same LIKE term filter as `ltm.searchLike()` — the fallback used when the
 *  query has no FTS-indexable term (all stop-words / too short). */
function likeTerms(q: string): string[] {
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

/**
 * Build the WHERE fragment for `q`. Uses the same FTS5 expression recall uses
 * (`ftsQuery`: AND of prefix tokens over title/content/category) as a rowid
 * subquery so the outer ORDER BY stays the caller's sort — not bm25 — which
 * is what makes the page boundary stable. No relaxed cascade here: relaxing
 * per page would change the result set between pages.
 */
function queryFilter(q: string): { sql: string; params: ReadParam[] } | null {
  const trimmed = q.trim();
  if (!trimmed) return null;
  const match = ftsQuery(trimmed);
  if (match !== EMPTY_QUERY) {
    return {
      // knowledge_current is a view (no rowid): hop through the base table to
      // translate FTS rowids into version ids.
      sql: `id IN (SELECT k.id FROM knowledge k
                    WHERE k.rowid IN (SELECT rowid FROM knowledge_fts WHERE knowledge_fts MATCH ?))`,
      params: [match],
    };
  }
  const terms = likeTerms(trimmed);
  if (!terms.length) {
    const needle = `%${trimmed.toLowerCase()}%`;
    return {
      sql: `(LOWER(title) LIKE ? OR LOWER(content) LIKE ?)`,
      params: [needle, needle],
    };
  }
  return {
    sql: terms
      .map(() => "(LOWER(title) LIKE ? OR LOWER(content) LIKE ?)")
      .join(" AND "),
    params: terms.flatMap((t) => [`%${t}%`, `%${t}%`]),
  };
}

const KNOWLEDGE_LIST_COLS =
  "id, tenant_id, project_id, category, title, content, source_session, cross_project, confidence, created_at, updated_at, metadata, created_by, updated_by, sensitivity, promotion_status, promoted_at, approval_status, approved_by, approved_at, source_user_id, source_entry_id, last_accessed_at, worker_provider_id, worker_model_id, last_reinforced_at, logical_id";

/**
 * Filtered, sorted, keyset-paginated read over `knowledge_current` for one
 * project. `limit` rows are returned at most; `next` is set only when a
 * further row exists (probed with `limit + 1`). Confidence gating matches
 * `ltm.forProject()` (`confidence > 0.2`) so cursor mode never surfaces an
 * entry the legacy list would hide.
 *
 * Indexes used: `idx_knowledge_project_current` (project_id WHERE current+live)
 * narrows to the project's live rows; the sort is over that bounded set, so no
 * additional index is needed for the sort/tiebreak columns.
 */
export function listKnowledgePage(
  projectPath: string,
  options: KnowledgeListOptions & { limit: number; after?: KnowledgeKeyset },
): KnowledgePage {
  const pid = ensureProject(projectPath);
  const sort = options.sort ?? "updated_desc";
  const spec = SORT_SPEC[sort];
  const where: string[] = ["tenant_id = ?", "confidence > 0.2"];
  const params: ReadParam[] = [currentTenantId()];

  switch (options.scope ?? "project") {
    case "project":
      where.push("project_id = ?");
      params.push(pid);
      break;
    case "global":
      where.push("project_id IS NULL");
      break;
    case "all":
      where.push("(project_id = ? OR project_id IS NULL OR cross_project = 1)");
      params.push(pid);
      break;
  }
  if (options.category) {
    where.push("category = ?");
    params.push(options.category);
  }
  if (options.q !== undefined) {
    const f = queryFilter(options.q);
    if (f) {
      where.push(f.sql);
      params.push(...f.params);
    }
  }
  if (options.after) {
    // Keyset predicate: rows strictly after (key, id) in sort order. DESC sorts
    // continue with smaller keys; ties on the key continue with the id in the
    // same direction.
    const cmp = spec.dir === "DESC" ? "<" : ">";
    where.push(
      `(${spec.column} ${cmp} ? OR (${spec.column} = ? AND id ${cmp} ?))`,
    );
    params.push(options.after.key, options.after.key, options.after.id);
  }

  const limit = Math.max(1, Math.floor(options.limit));
  const rows = db()
    .query(
      `SELECT ${KNOWLEDGE_LIST_COLS} FROM knowledge_current
        WHERE ${where.join(" AND ")}
        ORDER BY ${spec.column} ${spec.dir}, id ${spec.dir}
        LIMIT ?`,
    )
    .all(...params, limit + 1)
    .map(hydrateKnowledgeEntry) as KnowledgeEntry[];

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    next:
      hasMore && last
        ? { key: knowledgeSortKey(last, sort), id: last.id }
        : null,
  };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Sessions are ordered `last_message_at DESC, session_id DESC`. */
export type SessionKeyset = { last_message_at: number; session_id: string };

export type SessionPage = {
  items: SessionSummary[];
  next: SessionKeyset | null;
};

/**
 * Keyset-paginated variant of `data.listSessions()`: same per-session
 * aggregate, plus a `session_id` tiebreaker so equal `last_message_at` values
 * page deterministically. The keyset predicate lives in HAVING because the key
 * is an aggregate. Uses `idx_temporal_project_session` for the grouped scan.
 */
export function listSessionsPage(
  projectPath: string,
  options: { limit: number; after?: SessionKeyset },
): SessionPage {
  const pid = ensureProject(projectPath);
  const limit = Math.max(1, Math.floor(options.limit));
  const having = options.after
    ? `HAVING (MAX(t.created_at) < ? OR (MAX(t.created_at) = ? AND t.session_id < ?))`
    : "";
  const params: ReadParam[] = [pid, pid];
  if (options.after) {
    params.push(
      options.after.last_message_at,
      options.after.last_message_at,
      options.after.session_id,
    );
  }
  const rows = db()
    .query(
      `SELECT
        t.session_id,
        COUNT(*) as message_count,
        MIN(t.created_at) as first_message_at,
        MAX(t.created_at) as last_message_at,
        SUM(CASE WHEN t.distilled = 1 THEN 1 ELSE 0 END) as distilled_count,
        SUM(CASE WHEN t.distilled = 0 THEN 1 ELSE 0 END) as undistilled_count,
        COALESCE(d.cnt, 0) as distillation_count
       FROM temporal_messages t
       LEFT JOIN (
         SELECT session_id, COUNT(*) AS cnt
         FROM distillations
         WHERE project_id = ?
         GROUP BY session_id
       ) d ON d.session_id = t.session_id
       WHERE t.project_id = ?
       GROUP BY t.session_id
       ${having}
       ORDER BY MAX(t.created_at) DESC, t.session_id DESC
       LIMIT ?`,
    )
    .all(...params, limit + 1) as SessionSummary[];

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    next:
      hasMore && last
        ? { last_message_at: last.last_message_at, session_id: last.session_id }
        : null,
  };
}

// ---------------------------------------------------------------------------
// Version history
// ---------------------------------------------------------------------------

export type KnowledgeVersionDetail = {
  version_id: string;
  version: number;
  /** When this version was written (the row's `updated_at`; the immutable
   *  `created_at` is forward-copied from v1 and identical on every version). */
  created_at: number;
  /** `created_at` of the version that replaced this one; null for the head. */
  superseded_at: number | null;
  is_current: boolean;
  is_deleted: boolean;
  title: string;
  content: string;
  category: string;
  /** Confidence lives on the per-logical-id register, so it is the same on
   *  every version — reported per version for a self-contained row. */
  confidence: number;
  scope: "project" | "global";
  cross_project: boolean;
  source_refs: {
    session_id: string | null;
    entry_id: string | null;
    user_id: string | null;
    created_by: string | null;
    updated_by: string | null;
    worker_provider_id: string | null;
    worker_model_id: string | null;
  };
};

export type KnowledgeVersionHistory = {
  /** Stable logical id. */
  id: string;
  current_version_id: string;
  versions: KnowledgeVersionDetail[];
};

type VersionRow = {
  id: string;
  version: number;
  is_current: number;
  is_deleted: number;
  title: string;
  content: string;
  category: string;
  confidence: number;
  project_id: string | null;
  cross_project: number;
  updated_at: number;
  source_session: string | null;
  source_entry_id: string | null;
  source_user_id: string | null;
  created_by: string | null;
  updated_by: string | null;
  worker_provider_id: string | null;
  worker_model_id: string | null;
};

/**
 * Full ordered version history (oldest first) for a logical knowledge id.
 * Accepts any version id or the logical id. Returns null when the id is
 * unknown OR when the entry's head is a death certificate — the same
 * visibility rule as `ltm.getByLogical()` / `GET /api/v1/knowledge/:id`, so
 * a deleted entry cannot be enumerated through its history. Superseded and
 * historical deleted versions (a delete later followed by a re-append) ARE
 * included. Pure read: no LLM, no maintenance side effects.
 */
export function knowledgeVersionHistory(
  id: string,
): KnowledgeVersionHistory | null {
  const logicalId = logicalIdOf(id);
  const rows = db()
    .query(
      `SELECT k.id, k.version, k.is_current, k.is_deleted, k.title, k.content, k.category,
              COALESCE(m.confidence, 1.0) AS confidence, k.project_id, k.cross_project,
              k.updated_at, k.source_session, k.source_entry_id, k.source_user_id,
              k.created_by, k.updated_by, k.worker_provider_id, k.worker_model_id
         FROM knowledge k
         LEFT JOIN knowledge_meta m ON m.logical_id = k.logical_id
        WHERE k.tenant_id = ? AND k.logical_id = ?
        ORDER BY k.version ASC, k.updated_at ASC, k.id ASC`,
    )
    .all(currentTenantId(), logicalId) as VersionRow[];
  const head = rows.find((r) => r.is_current === 1);
  if (!head || head.is_deleted === 1) return null;

  const versions = rows.map((r, i) => {
    const next = rows[i + 1];
    return {
      version_id: r.id,
      version: r.version,
      created_at: r.updated_at,
      superseded_at: next ? next.updated_at : null,
      is_current: r.is_current === 1,
      is_deleted: r.is_deleted === 1,
      title: r.title,
      content: r.content,
      category: r.category,
      confidence: r.confidence,
      scope: r.project_id === null ? ("global" as const) : ("project" as const),
      cross_project: r.cross_project === 1,
      source_refs: {
        session_id: r.source_session,
        entry_id: r.source_entry_id,
        user_id: r.source_user_id,
        created_by: r.created_by,
        updated_by: r.updated_by,
        worker_provider_id: r.worker_provider_id,
        worker_model_id: r.worker_model_id,
      },
    };
  });
  return { id: logicalId, current_version_id: head.id, versions };
}
