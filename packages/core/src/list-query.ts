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
 * Ordering is a stack of sort keys followed by `id` in the primary direction,
 * so every page boundary resumes exactly where it left off.
 */
import { db, ensureProject } from "./db";
import { hydrateKnowledgeEntry, type KnowledgeEntry, logicalIdOf } from "./ltm";
import { ftsQuery, EMPTY_QUERY } from "./search";
import { config } from "./config";
import { sql, type SqlFragment } from "./sql";
import { currentTenantId } from "./tenant";
import {
  escapeLike,
  pruneOrphanSessionMeta,
  refreshSessionMeta,
} from "./session-meta";
import { normalizeTitle } from "./session-title";
import type { SessionSummary } from "./data";
import type { TemporalMessage } from "./temporal";

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

export type KnowledgeSortField =
  | "updated_at"
  | "created_at"
  | "confidence"
  | "title";
export type KnowledgeSortKey = {
  field: KnowledgeSortField;
  dir: "asc" | "desc";
};
export type KnowledgeSort = readonly KnowledgeSortKey[];
export const DEFAULT_KNOWLEDGE_SORT: KnowledgeSort = [
  { field: "updated_at", dir: "desc" },
];
export const KNOWLEDGE_SORT_FIELDS: readonly KnowledgeSortField[] = [
  "updated_at",
  "created_at",
  "confidence",
  "title",
];

/** `project`: project-owned entries not shared across projects.
 *  `shared`: project-less or cross-project entries.
 *  `all`: everything visible in the selected workspace. */
export type KnowledgeScope = "project" | "shared" | "all";
export const KNOWLEDGE_SCOPES: ReadonlySet<KnowledgeScope> =
  new Set<KnowledgeScope>(["project", "shared", "all"]);

export type KnowledgeCategory =
  | "decision"
  | "pattern"
  | "preference"
  | "architecture"
  | "gotcha";
export const KNOWLEDGE_CATEGORIES: ReadonlySet<KnowledgeCategory> =
  new Set<KnowledgeCategory>([
    "decision",
    "pattern",
    "preference",
    "architecture",
    "gotcha",
  ]);

export function parseKnowledgeSort(raw: string): KnowledgeSort | null {
  const terms = raw.split(",");
  if (terms.length < 1 || terms.length > 3) return null;
  const fields = new Set<KnowledgeSortField>();
  const sort: KnowledgeSortKey[] = [];
  for (const term of terms) {
    const match = /^(updated_at|created_at|confidence|title):(asc|desc)$/.exec(
      term,
    );
    if (!match) return null;
    const field = match[1] as KnowledgeSortField;
    if (fields.has(field)) return null;
    fields.add(field);
    sort.push({ field, dir: match[2] as KnowledgeSortKey["dir"] });
  }
  return sort;
}

export function formatKnowledgeSort(sort: KnowledgeSort): string {
  return sort.map(({ field, dir }) => `${field}:${dir}`).join(",");
}
export function isKnowledgeScope(v: string): v is KnowledgeScope {
  return (KNOWLEDGE_SCOPES as ReadonlySet<string>).has(v);
}
export function isKnowledgeCategory(v: string): v is KnowledgeCategory {
  return (KNOWLEDGE_CATEGORIES as ReadonlySet<string>).has(v);
}

/** Position of the last row of the previous page; keys follow sort order. */
export type KnowledgeKeyset = { keys: Array<number | string>; id: string };

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

export type CrossProjectKnowledgeEntry = KnowledgeEntry & {
  project_name: string | null;
};

const SORT_SPEC: Record<
  KnowledgeSortField,
  { column: string; kind: "number" | "string" }
> = {
  updated_at: { column: "updated_at", kind: "number" },
  created_at: { column: "created_at", kind: "number" },
  confidence: { column: "COALESCE(confidence, 1.0)", kind: "number" },
  title: { column: "title", kind: "string" },
};

function knowledgeSortKeys(
  entry: KnowledgeEntry,
  sort: KnowledgeSort,
): Array<number | string> {
  return sort.map(({ field }) => entry[field]);
}

/** Validate that each key has the type produced by its corresponding column. */
export function knowledgeKeysetMatchesSort(
  key: KnowledgeKeyset,
  sort: KnowledgeSort,
): boolean {
  if (
    !Array.isArray(key.keys) ||
    key.keys.length !== sort.length ||
    sort.length < 1 ||
    sort.length > 3 ||
    new Set(sort.map(({ field }) => field)).size !== sort.length
  ) {
    return false;
  }
  return sort.every(({ field }, index) => {
    const value = key.keys[index];
    return SORT_SPEC[field].kind === "number"
      ? typeof value === "number" && Number.isFinite(value)
      : typeof value === "string";
  });
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
function queryFilter(q: string): SqlFragment | null {
  const trimmed = q.trim();
  if (!trimmed) return null;
  const match = ftsQuery(trimmed);
  if (match !== EMPTY_QUERY) {
    // knowledge_current is a view (no rowid): hop through the base table to
    // translate FTS rowids into version ids.
    return sql`id IN (SELECT k.id FROM knowledge k
                    WHERE k.rowid IN (SELECT rowid FROM knowledge_fts WHERE knowledge_fts MATCH ${match}))`;
  }
  const terms = likeTerms(trimmed);
  // Nothing searchable (all tokens ≤ 2 chars): searchLike() returns [] here,
  // so match nothing rather than broad-matching the raw string.
  if (!terms.length) return sql.raw("0");
  return sql.and(
    terms.map(
      (term) =>
        sql`LOWER(title) LIKE ${`%${term}%`} OR LOWER(content) LIKE ${`%${term}%`}`,
    ),
  );
}

const KNOWLEDGE_LIST_COLS =
  "id, tenant_id, project_id, category, title, content, source_session, cross_project, confidence, created_at, updated_at, metadata, created_by, updated_by, sensitivity, promotion_status, promoted_at, approval_status, approved_by, approved_at, source_user_id, source_entry_id, last_accessed_at, worker_provider_id, worker_model_id, last_reinforced_at, logical_id";

const KNOWLEDGE_PROJECT_NAME =
  "(SELECT COALESCE(NULLIF(p.name, ''), p.path) FROM projects p WHERE p.id = knowledge_current.project_id) AS project_name";

function knowledgePredicates(
  options: KnowledgeListOptions,
  scopePredicate: SqlFragment | null,
  includeQuery = true,
): SqlFragment[] {
  const where: SqlFragment[] = [
    sql`tenant_id = ${currentTenantId()}`,
    sql`confidence > 0.2`,
  ];
  if (scopePredicate) where.push(scopePredicate);
  if (options.category) where.push(sql`category = ${options.category}`);
  if (includeQuery && options.q !== undefined) {
    const f = queryFilter(options.q);
    if (f) where.push(f);
  }
  return where;
}

function buildKnowledgePage<T extends KnowledgeEntry>(
  options: KnowledgeListOptions & {
    limit: number;
    after?: KnowledgeKeyset;
  },
  scopePredicate: SqlFragment | null,
  columns = KNOWLEDGE_LIST_COLS,
): { items: T[]; next: KnowledgeKeyset | null } {
  const sort = options.sort ?? DEFAULT_KNOWLEDGE_SORT;
  const where = knowledgePredicates(options, scopePredicate);

  const after = options.after;
  if (after) {
    const branches: SqlFragment[] = [];
    for (let index = 0; index < sort.length; index++) {
      const key = sort[index];
      const terms = sort.slice(0, index).map((prior, priorIndex) => {
        const column = SORT_SPEC[prior.field].column;
        return sql`${sql.raw(column)} = ${after.keys[priorIndex]}`;
      });
      const column = SORT_SPEC[key.field].column;
      const cmp = key.dir === "desc" ? "<" : ">";
      terms.push(sql`${sql.raw(column)} ${sql.raw(cmp)} ${after.keys[index]}`);
      branches.push(sql.and(terms));
    }
    const idTerms = sort.map(
      ({ field }, index) =>
        sql`${sql.raw(SORT_SPEC[field].column)} = ${after.keys[index]}`,
    );
    const primaryCmp = sort[0].dir === "desc" ? "<" : ">";
    idTerms.push(sql`id ${sql.raw(primaryCmp)} ${after.id}`);
    branches.push(sql.and(idTerms));
    where.push(sql.or(branches));
  }

  const limit = Math.max(1, Math.floor(options.limit));
  const order = [
    ...sort.map(
      ({ field, dir }) => `${SORT_SPEC[field].column} ${dir.toUpperCase()}`,
    ),
    `id ${sort[0].dir.toUpperCase()}`,
  ].join(", ");
  const rows = sql
    .all<T>(
      db(),
      sql`SELECT ${sql.raw(columns)} FROM knowledge_current
        WHERE ${sql.and(where)}
        ORDER BY ${sql.raw(order)}
        LIMIT ${limit + 1}`,
    )
    .map(hydrateKnowledgeEntry) as T[];

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    next:
      hasMore && last
        ? { keys: knowledgeSortKeys(last, sort), id: last.id }
        : null,
  };
}

function knowledgeScopePredicate(
  scope: KnowledgeScope | undefined,
  projectId?: string,
): SqlFragment | null {
  if (scope === undefined) {
    return projectId !== undefined ? sql`(project_id = ${projectId})` : null;
  }
  if (projectId !== undefined) {
    switch (scope) {
      case "project":
        return sql`(project_id = ${projectId} AND COALESCE(cross_project, 0) = 0)`;
      case "shared":
        return sql`(project_id IS NULL OR COALESCE(cross_project, 0) = 1)`;
      case "all":
        return sql`(project_id = ${projectId} OR project_id IS NULL OR COALESCE(cross_project, 0) = 1)`;
    }
  }
  switch (scope) {
    case "project":
      return sql`(project_id IS NOT NULL AND COALESCE(cross_project, 0) = 0)`;
    case "shared":
      return sql`(project_id IS NULL OR COALESCE(cross_project, 0) = 1)`;
    case "all":
      return null;
  }
}

/**
 * Filtered, sorted, keyset-paginated read over `knowledge_current` for one
 * project. `limit` rows are returned at most; `next` is set only when a
 * further row exists (probed with `limit + 1`). An omitted scope means rows
 * owned by this project, including its cross-project rows; confidence gating
 * matches `ltm.forProject()` (`confidence > 0.2`).
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
  return buildKnowledgePage(
    options,
    knowledgeScopePredicate(options.scope, pid),
  );
}

/**
 * Read a cross-project keyset page from the tenant's current live knowledge.
 * With no scope or project filter, no scope predicate is applied. With a
 * project filter and omitted scope, only entries owned by that project are
 * returned, including its cross-project rows.
 */
export function listAllKnowledgePage(
  options: KnowledgeListOptions & {
    limit: number;
    after?: KnowledgeKeyset;
    projectId?: string;
  },
): { items: CrossProjectKnowledgeEntry[]; next: KnowledgeKeyset | null } {
  const scopePredicate = knowledgeScopePredicate(
    options.scope,
    options.projectId,
  );
  return buildKnowledgePage<CrossProjectKnowledgeEntry>(
    options,
    scopePredicate,
    `${KNOWLEDGE_LIST_COLS}, ${KNOWLEDGE_PROJECT_NAME}`,
  );
}

/**
 * BM25-ranked cross-project knowledge search. With an omitted scope, a
 * project-filtered search returns rows owned by that project; without a
 * project filter, no scope predicate is applied. The total is exact and
 * results are intentionally top-N rather than paginated.
 */
export function searchKnowledgeRanked(options: {
  q: string;
  limit: number;
  projectId?: string;
  category?: KnowledgeCategory;
  scope?: KnowledgeScope;
}): {
  items: Array<CrossProjectKnowledgeEntry & { rank: number | null }>;
  total: number;
  mode: "fts" | "like" | "none";
} {
  const scopePredicate = knowledgeScopePredicate(
    options.scope,
    options.projectId,
  );
  const where = knowledgePredicates(options, scopePredicate, false);
  const limit = Math.max(1, Math.floor(options.limit));
  const match = ftsQuery(options.q.trim());

  if (match !== EMPTY_QUERY) {
    const { title, content, category } = config().search.ftsWeights;
    const matchedRows = sql`SELECT k.id AS fts_id, bm25(knowledge_fts, ${title}, ${content}, ${category}) AS rank
      FROM knowledge_fts
      JOIN knowledge k ON k.rowid = knowledge_fts.rowid
      WHERE knowledge_fts MATCH ${match}`;
    const from = sql`FROM (${matchedRows}) r
      JOIN knowledge_current ON knowledge_current.id = r.fts_id
      WHERE ${sql.and(where)}`;
    const totalRow = sql.get<{ total: number }>(
      db(),
      sql`SELECT COUNT(*) AS total ${from}`,
    );
    const rows = sql.all<CrossProjectKnowledgeEntry & { rank: number }>(
      db(),
      sql`SELECT ${sql.raw(KNOWLEDGE_LIST_COLS)}, ${sql.raw(KNOWLEDGE_PROJECT_NAME)}, r.rank
        ${from}
        ORDER BY r.rank ASC, knowledge_current.id ASC
        LIMIT ${limit}`,
    );
    return {
      items: rows.map(hydrateKnowledgeEntry),
      total: totalRow?.total ?? 0,
      mode: "fts",
    };
  }

  const terms = likeTerms(options.q.trim());
  if (terms.length === 0) return { items: [], total: 0, mode: "none" };

  const like = sql.and(
    terms.map(
      (term) =>
        sql`LOWER(title) LIKE ${`%${term}%`} OR LOWER(content) LIKE ${`%${term}%`}`,
    ),
  );
  where.push(like);
  const whereClause = sql.and(where);
  const totalRow = sql.get<{ total: number }>(
    db(),
    sql`SELECT COUNT(*) AS total FROM knowledge_current WHERE ${whereClause}`,
  );
  const rows = sql.all<CrossProjectKnowledgeEntry & { rank: null }>(
    db(),
    sql`SELECT ${sql.raw(KNOWLEDGE_LIST_COLS)}, ${sql.raw(KNOWLEDGE_PROJECT_NAME)}, NULL AS rank
      FROM knowledge_current
      WHERE ${whereClause}
      ORDER BY updated_at DESC, id DESC
      LIMIT ${limit}`,
  );
  return {
    items: rows.map(hydrateKnowledgeEntry),
    total: totalRow?.total ?? 0,
    mode: "like",
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
  options: { limit: number; after?: SessionKeyset; q?: string },
): SessionPage {
  const pid = ensureProject(projectPath);
  const limit = Math.max(1, Math.floor(options.limit));
  const having = options.after
    ? sql`(MAX(t.created_at) < ${options.after.last_message_at} OR (MAX(t.created_at) = ${options.after.last_message_at} AND t.session_id < ${options.after.session_id}))`
    : sql.empty;

  const q = options.q?.trim() ?? "";
  if (q) {
    // Title search (#1921): titles live in the session_meta cache, so first
    // refresh it for EVERY session of the project (a match may sit beyond
    // this page) and sweep orphans left by out-of-band deletes.
    const all = sql.all<{
      session_id: string;
      message_count: number;
      distillation_count: number;
    }>(
      db(),
      sql`SELECT t.session_id, COUNT(*) as message_count, COALESCE(d.cnt, 0) as distillation_count
         FROM temporal_messages t
         LEFT JOIN (
           SELECT session_id, COUNT(*) AS cnt
           FROM distillations
           WHERE project_id = ${pid}
           GROUP BY session_id
         ) d ON d.session_id = t.session_id
         WHERE t.project_id = ${pid}
         GROUP BY t.session_id`,
    );
    refreshSessionMeta(pid, all);
    pruneOrphanSessionMeta(pid);

    // m.title / m.title_source are not aggregates, but the join keys on the
    // grouping key (t.session_id) so SQLite bare-column semantics return the
    // one matching meta row per group.
    const match = sql`(instr(m.title_norm, ${normalizeTitle(q)}) > 0 OR t.session_id LIKE ${`${escapeLike(q)}%`} ESCAPE '\\')`;
    const rows = sql.all<SessionSummary>(
      db(),
      sql`SELECT
          t.session_id,
          COUNT(*) as message_count,
          MIN(t.created_at) as first_message_at,
          MAX(t.created_at) as last_message_at,
          SUM(CASE WHEN t.distilled = 1 THEN 1 ELSE 0 END) as distilled_count,
          SUM(CASE WHEN t.distilled = 0 THEN 1 ELSE 0 END) as undistilled_count,
          COALESCE(d.cnt, 0) as distillation_count,
          m.title,
          m.title_source
         FROM temporal_messages t
         JOIN session_meta m
           ON m.project_id = ${pid} AND m.session_id = t.session_id
         LEFT JOIN (
           SELECT session_id, COUNT(*) AS cnt
           FROM distillations
           WHERE project_id = ${pid}
           GROUP BY session_id
         ) d ON d.session_id = t.session_id
         WHERE t.project_id = ${pid}
         GROUP BY t.session_id
         HAVING ${match} ${options.after ? sql`AND ${having}` : sql.empty}
         ORDER BY MAX(t.created_at) DESC, t.session_id DESC
         LIMIT ${limit + 1}`,
    );
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return {
      items,
      next:
        hasMore && last
          ? {
              last_message_at: last.last_message_at,
              session_id: last.session_id,
            }
          : null,
    };
  }

  const rows = sql.all<SessionSummary>(
    db(),
    sql`SELECT
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
         WHERE project_id = ${pid}
         GROUP BY session_id
       ) d ON d.session_id = t.session_id
       WHERE t.project_id = ${pid}
       GROUP BY t.session_id
       ${options.after ? sql`HAVING ${having}` : sql.empty}
       ORDER BY MAX(t.created_at) DESC, t.session_id DESC
       LIMIT ${limit + 1}`,
  );

  // Attach derived titles (#1921): refreshSessionMeta recomputes only stale
  // rows, so a warm list is the aggregate query + one IN() lookup.
  const meta = refreshSessionMeta(pid, rows);
  for (const row of rows) {
    const m = meta.get(row.session_id);
    row.title = m?.title ?? row.session_id;
    row.title_source = m?.title_source ?? "id";
  }

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
// Session messages (history reader, #1801)
// ---------------------------------------------------------------------------

/** Position of the oldest message of the previous page. */
export type MessageKeyset = { created_at: number; id: string };

export type SessionMessagePage = {
  /** Chronological (`created_at ASC, id ASC`) within the page. */
  items: TemporalMessage[];
  /** Keyset to fetch the next *older* page, or null when the page reached the
   *  session's first message. */
  next: MessageKeyset | null;
  /** Messages in the session at query time, so a reader can say how much of
   *  the captured history it has loaded. */
  total: number;
};

/**
 * Keyset-paginated tail of a session's messages: the first page is the
 * newest `limit` messages, each later page (`before`) the `limit` messages
 * older than the previous page's oldest. Pages are returned in chronological
 * order so a reader prepends them as they arrive. The total order is
 * `created_at, id`, which the legacy `temporal.bySession()` (`created_at`
 * only) is consistent with except among equal timestamps.
 */
export function listSessionMessagesPage(
  projectPath: string,
  sessionId: string,
  options: { limit: number; before?: MessageKeyset },
): SessionMessagePage {
  const pid = ensureProject(projectPath);
  const limit = Math.max(1, Math.floor(options.limit));
  const before = options.before
    ? sql`AND (created_at < ${options.before.created_at} OR (created_at = ${options.before.created_at} AND id < ${options.before.id}))`
    : sql.empty;
  const rows = sql.all<TemporalMessage>(
    db(),
    sql`SELECT * FROM (
         SELECT * FROM temporal_messages
         WHERE project_id = ${pid} AND session_id = ${sessionId} ${before}
         ORDER BY created_at DESC, id DESC
         LIMIT ${limit + 1})
       ORDER BY created_at ASC, id ASC`,
  );
  const total =
    sql.get<{ n: number }>(
      db(),
      sql`SELECT COUNT(*) AS n FROM temporal_messages WHERE project_id = ${pid} AND session_id = ${sessionId}`,
    )?.n ?? 0;
  return { ...olderPage(rows, limit), total };
}

/**
 * Splits a chronological `LIMIT limit + 1` fetch of the newest rows before a
 * keyset into the page and the keyset of its oldest row. The probe row, when
 * present, is the first (oldest) one and only proves that older rows exist.
 */
function olderPage<T extends MessageKeyset>(
  rows: T[],
  limit: number,
): { items: T[]; next: MessageKeyset | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(1) : rows;
  const oldest = items[0];
  return {
    items,
    next:
      hasMore && oldest
        ? { created_at: oldest.created_at, id: oldest.id }
        : null,
  };
}

// ---------------------------------------------------------------------------
// Session search (in-session finder, #1857)
// ---------------------------------------------------------------------------

/**
 * Tokens the FTS5 `unicode61` tokenizer would produce for `raw` (letters and
 * digits; everything else separates), lower-cased so the response echoes what
 * was actually matched. Unlike `filterTerms()` this keeps single-character
 * tokens and stop words: a reader searching "needle-5" or "the store" wants
 * the literal sequence, not the recall engine's relevance heuristics.
 */
export function sessionSearchTerms(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
    .slice(0, 32);
}

/** How the hits were matched: the terms as one adjacent phrase, or every
 *  term anywhere in the message. Either way only the last term is a prefix. */
export type SessionSearchMode = "phrase" | "terms";

export type SessionSearchHit = {
  id: string;
  created_at: number;
  role: string;
  /** Plain-text excerpt around the first match, FTS5 `snippet()` with the
   *  part separator (`\x1f`) turned into a space. */
  snippet: string;
  /** FTS5 bm25 rank (lower is better) for callers that want relevance. */
  rank: number;
};

export type SessionSearchPage = {
  terms: string[];
  mode: SessionSearchMode;
  /** Chronological (`created_at ASC, id ASC`) within the page. */
  items: SessionSearchHit[];
  /** Keyset to fetch the next *older* page of hits, or null. */
  next: MessageKeyset | null;
  /** Matching messages in the session at query time. */
  total: number;
};

function ftsQuoted(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/** `"a b c"*` — the terms as one phrase, last term a prefix. */
function phraseMatch(terms: readonly string[]): string {
  return `${ftsQuoted(terms.join(" "))}*`;
}

/**
 * `"a" "b" "c"*` — every term anywhere in the message, only the last one a
 * prefix (like the phrase form, and like a finder matching what was typed so
 * far). A short inner token such as the `5` of `needle-5 config` therefore
 * has to appear as that token, not as the start of every `5…` number.
 */
function termsMatch(terms: readonly string[]): string {
  return terms
    .map((t, i) => (i === terms.length - 1 ? `${ftsQuoted(t)}*` : ftsQuoted(t)))
    .join(" ");
}

/**
 * Keyset-paginated hits of an in-session finder over `temporal_fts`, walking
 * from the newest matching message backwards like `listSessionMessagesPage`.
 *
 * The query is tokenised the way the index is and quoted, so FTS5 operators
 * in user input (`NEAR`, `*`, `"`, `-`) are literal characters, never syntax.
 * The first page decides the mode: the literal phrase when any message
 * contains it, otherwise (multi-term queries only) every term anywhere. Later
 * pages pin the mode via `options.mode` so a data change between pages can't
 * make the walk switch semantics half-way.
 */
export function searchSessionMessagesPage(
  projectPath: string,
  sessionId: string,
  options: {
    query: string;
    limit: number;
    before?: MessageKeyset;
    mode?: SessionSearchMode;
  },
): SessionSearchPage {
  const pid = ensureProject(projectPath);
  const terms = sessionSearchTerms(options.query);
  const limit = Math.max(1, Math.floor(options.limit));
  if (terms.length === 0) {
    return { terms, mode: "phrase", items: [], next: null, total: 0 };
  }

  const count = (match: string): number =>
    sql.get<{ n: number }>(
      db(),
      sql`SELECT COUNT(*) AS n FROM temporal_fts f
         CROSS JOIN temporal_messages m ON m.rowid = f.rowid
         WHERE f.content MATCH ${match} AND m.project_id = ${pid} AND m.session_id = ${sessionId}`,
    )?.n ?? 0;

  let mode: SessionSearchMode = options.mode ?? "phrase";
  let match = mode === "phrase" ? phraseMatch(terms) : termsMatch(terms);
  let total = count(match);
  if (
    options.mode === undefined &&
    mode === "phrase" &&
    total === 0 &&
    terms.length > 1
  ) {
    mode = "terms";
    match = termsMatch(terms);
    total = count(match);
  }

  const before = options.before
    ? sql`AND (m.created_at < ${options.before.created_at} OR (m.created_at = ${options.before.created_at} AND m.id < ${options.before.id}))`
    : sql.empty;
  const rows = sql.all<SessionSearchHit>(
    db(),
    sql`SELECT * FROM (
         SELECT m.id, m.created_at, m.role,
                replace(snippet(temporal_fts, 0, '', '', '…', 16), char(31), ' ') AS snippet,
                f.rank AS rank
         FROM temporal_fts f
         CROSS JOIN temporal_messages m ON m.rowid = f.rowid
         WHERE f.content MATCH ${match} AND m.project_id = ${pid} AND m.session_id = ${sessionId} ${before}
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT ${limit + 1})
       ORDER BY created_at ASC, id ASC`,
  );
  return { terms, mode, ...olderPage(rows, limit), total };
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
  scope: "project" | "shared";
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
  cross_project: number | null;
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
 * unknown OR (unless `includeDeleted`) when the entry's head is a death
 * certificate — the same visibility rule as `ltm.getByLogical()` /
 * `GET /api/v1/knowledge/:id`, so a deleted entry cannot be enumerated
 * through its history by default. With `includeDeleted` the tombstone head is
 * reported as the current version with `is_deleted: true` (needed to show and
 * restore entries removed by a reviewed dedup merge). Superseded and
 * historical deleted versions (a delete later followed by a re-append) are
 * always included. Pure read: no LLM, no maintenance side effects.
 */
export function knowledgeVersionHistory(
  id: string,
  opts: { includeDeleted?: boolean } = {},
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
  if (!head) return null;
  if (head.is_deleted === 1 && !opts.includeDeleted) return null;

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
      scope:
        r.project_id === null || r.cross_project === 1
          ? ("shared" as const)
          : ("project" as const),
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
