import { db } from "./db";
import {
  fuzzyRank,
  FUZZY_CANDIDATE_CAP,
  FUZZY_MIN_QUERY,
  normalizeFuzzy,
} from "./fuzzy";
import { sanitizeSurrogates } from "./markdown";
import {
  escapeLike,
  refreshSessionMeta,
  type SessionMetaInput,
} from "./session-meta";
import { sql, type SqlFragment } from "./sql";
import { currentTenantId } from "./tenant";
import {
  ACTIVITY_KINDS,
  PARTICIPANTS,
  type ActivityKind,
  type ActivityParticipant,
  type ParsedActivityQuery,
} from "./activity-query";

export type ActivityCursor = {
  t: number;
  k: ActivityKind;
  id: string;
};

export type ActivityMatch = "exact" | "fuzzy";

export type ActivityItem = {
  kind: ActivityKind;
  id: string;
  project_id: string;
  project_name: string;
  title: string;
  snippet: string;
  participants: ActivityParticipant[];
  last_activity_at: number;
  total: number;
  match: ActivityMatch;
};

export type ActivityPage = {
  items: ActivityItem[];
  next: ActivityCursor | null;
};

type ActivityRow = Omit<ActivityItem, "snippet" | "participants" | "match"> & {
  snippet?: string;
  participants?: ActivityParticipant[];
  match?: ActivityMatch;
};

type LegFilters = {
  tenant: string;
  projectIds: string[] | null;
  with: ActivityParticipant["id"][];
  terms: string[];
  excludeTerms?: boolean;
};

export type ActivityLeg = {
  kind: ActivityKind;
  select(filters: LegFilters): SqlFragment;
  hydrate(rows: ActivityRow[]): void;
};

const ACTIVITY_BIND_CHUNK = 900;

function chunks<T>(items: readonly T[], size = ACTIVITY_BIND_CHUNK): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function whereWithAnd(
  predicates: readonly (SqlFragment | null | undefined | false)[],
): SqlFragment {
  return sql.join(
    [sql.raw("1"), ...predicates.filter((part): part is SqlFragment => !!part)],
    " AND ",
  );
}

function projectPredicate(
  alias: string,
  projectIds: string[] | null,
): SqlFragment | null {
  return projectIds === null
    ? null
    : sql`${sql.raw(`${alias}.project_id`)} ${sql.inList(projectIds)}`;
}

function termPredicate(textExpr: SqlFragment, terms: string[]): SqlFragment {
  return sql.and(
    terms.map(
      (term) => sql`(${textExpr}) LIKE ${`%${escapeLike(term)}%`} ESCAPE '\\'`,
    ),
  );
}

function termFilter(
  textExpr: SqlFragment,
  filters: LegFilters,
): SqlFragment | null {
  if (filters.terms.length === 0) return null;
  const predicate = termPredicate(textExpr, filters.terms);
  return filters.excludeTerms ? sql`NOT (${predicate})` : predicate;
}

function participantPredicate(
  filters: LegFilters,
  predicates: Partial<Record<ActivityParticipant["id"], SqlFragment>>,
): SqlFragment {
  return sql.and(
    filters.with.map((participant) => predicates[participant] ?? sql.raw("0")),
  );
}

const SESSION_TEXT = sql.raw(
  `COALESCE(m.title,'') || ' ' || COALESCE((SELECT t2.content
     FROM temporal_messages t2
    WHERE t2.project_id = s.project_id AND t2.session_id = s.session_id
    ORDER BY t2.created_at DESC, t2.id DESC LIMIT 1),'')`,
);

function sessionSelect(filters: LegFilters): SqlFragment {
  const sessionRows =
    filters.terms.length > 0
      ? sql`SELECT sm.project_id, sm.session_id,
                   (SELECT t2.created_at FROM temporal_messages t2
                     WHERE t2.project_id = sm.project_id
                       AND t2.session_id = sm.session_id
                     ORDER BY t2.created_at DESC, t2.id DESC LIMIT 1) AS last_at,
                   sm.message_count AS n
              FROM session_meta sm
             WHERE ${whereWithAnd([
               projectPredicate("sm", filters.projectIds),
               filters.projectIds === null
                 ? sql`sm.project_id IN (
                     SELECT id FROM projects WHERE tenant_id = ${filters.tenant}
                   )`
                 : null,
             ])}`
      : sql`SELECT project_id, session_id, MAX(created_at) AS last_at,
                   COUNT(*) AS n
              FROM temporal_messages
             WHERE ${
               filters.projectIds === null
                 ? sql`project_id IN (
                     SELECT id FROM projects WHERE tenant_id = ${filters.tenant}
                   )`
                 : sql`project_id ${sql.inList(filters.projectIds)}`
             }
             GROUP BY project_id, session_id`;
  const withPredicates = participantPredicate(filters, {
    user: sql.raw("1"),
    "claude-code": sql`EXISTS (
      SELECT 1 FROM temporal_messages a
       WHERE a.project_id = s.project_id AND a.session_id = s.session_id
         AND a.role = 'user' AND a.metadata IS NOT NULL
         AND json_extract(a.metadata,'$.agent') = ${"claude-code"}
    )`,
    codex: sql`EXISTS (
      SELECT 1 FROM temporal_messages a
       WHERE a.project_id = s.project_id AND a.session_id = s.session_id
         AND a.role = 'user' AND a.metadata IS NOT NULL
         AND json_extract(a.metadata,'$.agent') = ${"codex"}
    )`,
    opencode: sql`EXISTS (
      SELECT 1 FROM temporal_messages a
       WHERE a.project_id = s.project_id AND a.session_id = s.session_id
         AND a.role = 'user' AND a.metadata IS NOT NULL
         AND json_extract(a.metadata,'$.agent') = ${"opencode"}
    )`,
    pi: sql`EXISTS (
      SELECT 1 FROM temporal_messages a
       WHERE a.project_id = s.project_id AND a.session_id = s.session_id
         AND a.role = 'user' AND a.metadata IS NOT NULL
         AND json_extract(a.metadata,'$.agent') = ${"pi"}
    )`,
    lore: sql`(
      EXISTS (SELECT 1 FROM distillations d
               WHERE d.project_id = s.project_id AND d.session_id = s.session_id)
      OR EXISTS (SELECT 1 FROM knowledge_session_injections i
                  WHERE i.session_id = s.session_id AND i.project_id = s.project_id)
    )`,
  });
  return sql`SELECT 'session' AS kind, s.session_id AS id, s.project_id AS project_id,
       COALESCE(p.name, s.project_id) AS project_name,
       COALESCE(m.title, s.session_id) AS title,
       s.last_at AS last_activity_at, s.n AS total
  FROM (${sessionRows}) s
  LEFT JOIN projects p ON p.id = s.project_id
  LEFT JOIN session_meta m ON m.project_id = s.project_id AND m.session_id = s.session_id
 WHERE ${whereWithAnd([withPredicates, termFilter(SESSION_TEXT, filters)])}`;
}

function knowledgeWhere(
  filters: LegFilters,
  textExpr: SqlFragment,
  withPredicates: SqlFragment,
  extra: SqlFragment | null = null,
): SqlFragment {
  return whereWithAnd([
    sql`k.tenant_id = ${filters.tenant}`,
    projectPredicate("k", filters.projectIds),
    withPredicates,
    termFilter(textExpr, filters),
    extra,
  ]);
}

function knowledgeSelect(filters: LegFilters): SqlFragment {
  const withPredicates = participantPredicate(filters, {
    curator: sql`EXISTS (
      SELECT 1 FROM knowledge v
       WHERE v.tenant_id = k.tenant_id AND v.logical_id = k.logical_id
         AND v.origin = ${"curator"}
    )`,
    pattern: sql`EXISTS (
      SELECT 1 FROM knowledge v
       WHERE v.tenant_id = k.tenant_id AND v.logical_id = k.logical_id
         AND v.origin = ${"pattern"}
    )`,
    import: sql`EXISTS (
      SELECT 1 FROM knowledge v
       WHERE v.tenant_id = k.tenant_id AND v.logical_id = k.logical_id
         AND v.origin = ${"import"}
    )`,
    user: sql`EXISTS (
      SELECT 1 FROM knowledge v
       WHERE v.tenant_id = k.tenant_id AND v.logical_id = k.logical_id
         AND v.origin = ${"user"}
    )`,
  });
  return sql`SELECT 'knowledge' AS kind, k.logical_id AS id,
       COALESCE(k.project_id,'') AS project_id,
       COALESCE(p.name, CASE WHEN k.project_id IS NULL THEN 'Global' ELSE k.project_id END) AS project_name,
       k.title AS title, k.updated_at AS last_activity_at, k.version AS total
  FROM knowledge_current k LEFT JOIN projects p ON p.id = k.project_id
 WHERE ${knowledgeWhere(filters, sql.raw("k.title || ' ' || k.content"), withPredicates)}`;
}

function promotionSelect(filters: LegFilters): SqlFragment {
  const withPredicates = participantPredicate(filters, { lore: sql.raw("1") });
  return sql`SELECT 'promotion' AS kind, k.logical_id AS id,
       COALESCE(k.project_id,'') AS project_id,
       COALESCE(p.name, CASE WHEN k.project_id IS NULL THEN 'Global' ELSE k.project_id END) AS project_name,
       k.title AS title, COALESCE(k.promoted_at, k.updated_at) AS last_activity_at, 1 AS total
  FROM knowledge_current k LEFT JOIN projects p ON p.id = k.project_id
 WHERE ${knowledgeWhere(
   filters,
   sql.raw("k.title || ' ' || k.content"),
   withPredicates,
   sql`k.promotion_status IS NOT NULL`,
 )}`;
}

const CONTRADICTION_TEXT = sql.raw(
  "COALESCE(ka.title,'') || ' ' || COALESCE(kb.title,'') || ' ' || COALESCE(c.rationale,'')",
);

function contradictionSelect(filters: LegFilters): SqlFragment {
  const withPredicates = participantPredicate(filters, {
    lore: sql.raw("1"),
  });
  return sql`SELECT 'contradiction' AS kind,
       c.logical_id_a || ':' || c.logical_id_b AS id,
       COALESCE(c.project_id,'') AS project_id,
       COALESCE(p.name, CASE WHEN c.project_id IS NULL THEN 'Global' ELSE c.project_id END) AS project_name,
       COALESCE(ka.title, c.logical_id_a) || ' ↔ ' || COALESCE(kb.title, c.logical_id_b) AS title,
       c.updated_at AS last_activity_at, 1 AS total
  FROM knowledge_contradictions c
  LEFT JOIN knowledge ka
    ON ka.tenant_id = c.tenant_id AND ka.logical_id = c.logical_id_a
   AND ka.is_current = 1 AND ka.is_deleted = 0
  LEFT JOIN knowledge kb
    ON kb.tenant_id = c.tenant_id AND kb.logical_id = c.logical_id_b
   AND kb.is_current = 1 AND kb.is_deleted = 0
  LEFT JOIN projects p ON p.id = c.project_id
 WHERE ${whereWithAnd([
   sql`c.tenant_id = ${filters.tenant}`,
   projectPredicate("c", filters.projectIds),
   withPredicates,
   termFilter(CONTRADICTION_TEXT, filters),
 ])}`;
}

function byParticipantIds(ids: Iterable<string>): ActivityParticipant[] {
  const selected = new Set(ids);
  return PARTICIPANTS.filter((participant) => selected.has(participant.id));
}

function byProject(rows: ActivityRow[]): Map<string, ActivityRow[]> {
  const groups = new Map<string, ActivityRow[]>();
  for (const row of rows) {
    const group = groups.get(row.project_id) ?? [];
    group.push(row);
    groups.set(row.project_id, group);
  }
  return groups;
}

function hydrateSessions(rows: ActivityRow[]): void {
  for (const [projectId, projectRows] of byProject(rows)) {
    const ids = projectRows.map((row) => row.id);
    const metaInputs = projectRows.map(
      (row): SessionMetaInput => ({
        session_id: row.id,
        message_count: row.total,
        distillation_count: 0,
      }),
    );
    const agents = new Map<string, Set<string>>();
    const hasLore = new Set<string>();
    const distillationCounts = new Map<string, number>();
    for (const idChunk of chunks(ids)) {
      for (const row of sql.all<{ session_id: string; content: string }>(
        db(),
        sql`SELECT session_id, content FROM (
              SELECT session_id, content,
                     ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at DESC, id DESC) AS row_num
                FROM temporal_messages
               WHERE project_id = ${projectId} AND session_id ${sql.inList(idChunk)}
            ) WHERE row_num = 1`,
      )) {
        const activity = projectRows.find(
          (candidate) => candidate.id === row.session_id,
        );
        if (activity) activity.snippet = row.content;
      }
      for (const row of sql.all<{ session_id: string; agent: string | null }>(
        db(),
        sql`SELECT session_id, json_extract(metadata,'$.agent') AS agent
              FROM temporal_messages
             WHERE project_id = ${projectId} AND session_id ${sql.inList(idChunk)}
               AND role = 'user' AND metadata IS NOT NULL`,
      )) {
        if (row.agent !== null) {
          const set = agents.get(row.session_id) ?? new Set<string>();
          set.add(row.agent);
          agents.set(row.session_id, set);
        }
      }
      for (const row of sql.all<{ session_id: string; count: number }>(
        db(),
        sql`SELECT session_id, COUNT(*) AS count
              FROM distillations
             WHERE project_id = ${projectId} AND session_id ${sql.inList(idChunk)}
             GROUP BY session_id`,
      )) {
        distillationCounts.set(row.session_id, row.count);
      }
      for (const row of sql.all<{ session_id: string }>(
        db(),
        sql`SELECT session_id FROM knowledge_session_injections
             WHERE project_id = ${projectId} AND session_id ${sql.inList(idChunk)}
             GROUP BY session_id`,
      )) {
        hasLore.add(row.session_id);
      }
    }

    for (const meta of metaInputs) {
      meta.distillation_count = distillationCounts.get(meta.session_id) ?? 0;
    }
    const titles = refreshSessionMeta(projectId, metaInputs);
    for (const row of projectRows) {
      row.title = titles.get(row.id)?.title ?? row.title;
      const participantIds = new Set<string>(["user"]);
      for (const agent of agents.get(row.id) ?? []) participantIds.add(agent);
      if ((distillationCounts.get(row.id) ?? 0) > 0 || hasLore.has(row.id)) {
        participantIds.add("lore");
      }
      row.participants = byParticipantIds(participantIds);
    }
  }
}

function hydrateKnowledge(rows: ActivityRow[]): void {
  for (const [projectId, projectRows] of byProject(rows)) {
    const ids = projectRows.map((row) => row.id);
    const scopedProject = projectId || null;
    const origins = new Map<string, Set<string>>();
    for (const idChunk of chunks(ids)) {
      for (const row of sql.all<{ logical_id: string; content: string }>(
        db(),
        sql`SELECT logical_id, content FROM knowledge_current
             WHERE tenant_id = ${currentTenantId()}
               AND project_id IS ${scopedProject}
               AND logical_id ${sql.inList(idChunk)}`,
      )) {
        const activity = projectRows.find(
          (candidate) => candidate.id === row.logical_id,
        );
        if (activity) activity.snippet = row.content;
      }
      for (const row of sql.all<{ logical_id: string; origin: string | null }>(
        db(),
        sql`SELECT logical_id, origin FROM knowledge
             WHERE tenant_id = ${currentTenantId()}
               AND project_id IS ${scopedProject}
               AND logical_id ${sql.inList(idChunk)}`,
      )) {
        if (row.origin !== null) {
          const set = origins.get(row.logical_id) ?? new Set<string>();
          set.add(row.origin);
          origins.set(row.logical_id, set);
        }
      }
    }
    for (const row of projectRows) {
      row.participants = byParticipantIds(origins.get(row.id) ?? []);
    }
  }
}

function hydratePromotions(rows: ActivityRow[]): void {
  hydrateKnowledge(rows);
  for (const row of rows) row.participants = byParticipantIds(["lore"]);
}

function hydrateContradictions(rows: ActivityRow[]): void {
  const tenant = currentTenantId();
  for (const [projectId, projectRows] of byProject(rows)) {
    for (const idChunk of chunks(projectRows.map((row) => row.id))) {
      for (const row of sql.all<{ id: string; rationale: string | null }>(
        db(),
        sql`SELECT logical_id_a || ':' || logical_id_b AS id, rationale
              FROM knowledge_contradictions
             WHERE tenant_id = ${tenant} AND project_id IS ${projectId || null}
               AND (logical_id_a || ':' || logical_id_b) ${sql.inList(idChunk)}`,
      )) {
        const activity = projectRows.find(
          (candidate) => candidate.id === row.id,
        );
        if (activity) activity.snippet = row.rationale ?? "";
      }
    }
    for (const row of projectRows)
      row.participants = byParticipantIds(["lore"]);
  }
}

export const ACTIVITY_LEGS: Record<ActivityKind, ActivityLeg> = {
  session: { kind: "session", select: sessionSelect, hydrate: hydrateSessions },
  knowledge: {
    kind: "knowledge",
    select: knowledgeSelect,
    hydrate: hydrateKnowledge,
  },
  contradiction: {
    kind: "contradiction",
    select: contradictionSelect,
    hydrate: hydrateContradictions,
  },
  promotion: {
    kind: "promotion",
    select: promotionSelect,
    hydrate: hydratePromotions,
  },
};

type ActivityFilters = LegFilters & {
  after: number | null;
  before: number | null;
};

const ACTIVITY_FUZZY_CANDIDATE_CAP = Math.min(FUZZY_CANDIDATE_CAP, 1_000);

function selectedKinds(parsed: ParsedActivityQuery): ActivityKind[] {
  return parsed.server.types ?? [...ACTIVITY_KINDS];
}

function unionFor(
  kinds: readonly ActivityKind[],
  filters: LegFilters,
  after: number | null,
  before: number | null,
  cursor: ActivityCursor | null,
  limit: number,
): SqlFragment {
  return sql.join(
    kinds.map((kind) => {
      const leg = ACTIVITY_LEGS[kind].select(filters);
      const legFilters = { ...filters, after, before };
      return sql`SELECT * FROM (
        SELECT * FROM (${leg}) leg
          WHERE ${outerWhere(legFilters, cursor)}
          ORDER BY leg.last_activity_at DESC, leg.kind ASC, leg.id ASC
          LIMIT ${limit}
      )`;
    }),
    " UNION ALL ",
  );
}

function outerWhere(
  filters: ActivityFilters,
  cursor: ActivityCursor | null,
): SqlFragment {
  const predicates: SqlFragment[] = [];
  if (filters.after !== null) {
    predicates.push(sql`leg.last_activity_at >= ${filters.after}`);
  }
  if (filters.before !== null) {
    predicates.push(sql`leg.last_activity_at < ${filters.before}`);
  }
  if (cursor) {
    predicates.push(
      sql`(leg.last_activity_at < ${cursor.t}
        OR (leg.last_activity_at = ${cursor.t}
          AND (leg.kind > ${cursor.k}
            OR (leg.kind = ${cursor.k} AND leg.id > ${cursor.id}))))`,
    );
  }
  return whereWithAnd(predicates);
}

function activityRowsQuery(
  kinds: readonly ActivityKind[],
  filters: ActivityFilters,
  cursor: ActivityCursor | null,
  limit: number,
): SqlFragment {
  const union = unionFor(
    kinds,
    filters,
    filters.after,
    filters.before,
    cursor,
    limit,
  );
  return sql`SELECT u.* FROM (${union}) u
    ORDER BY u.last_activity_at DESC, u.kind ASC, u.id ASC
    LIMIT ${limit}`;
}

function resolveProjects(
  tokens: readonly string[],
  tenant: string,
): string[] | null {
  if (tokens.length === 0) return null;
  const ids = new Set<string>();
  for (const token of tokens) {
    for (const row of sql.all<{ id: string }>(
      db(),
      sql`SELECT id FROM projects
           WHERE tenant_id = ${tenant}
             AND (id = ${token} OR lower(name) = lower(${token}))`,
    )) {
      ids.add(row.id);
    }
  }
  return [...ids];
}

function refreshSessionTitles(
  projectIds: string[] | null,
  tenant: string,
): void {
  const projectScope =
    projectIds === null
      ? sql`t.project_id IN (
          SELECT id FROM projects WHERE tenant_id = ${tenant}
        )`
      : projectPredicate("t", projectIds);
  const distillationScope =
    projectIds === null
      ? sql`d.project_id IN (
          SELECT id FROM projects WHERE tenant_id = ${tenant}
        )`
      : projectPredicate("d", projectIds);
  const staleRows = sql.all<SessionMetaInput & { project_id: string }>(
    db(),
    sql`SELECT t.project_id, t.session_id, COUNT(*) AS message_count,
                COALESCE(d.distillation_count, 0) AS distillation_count
           FROM temporal_messages t
           LEFT JOIN (
             SELECT d.project_id, d.session_id, COUNT(*) AS distillation_count
               FROM distillations d
              WHERE ${distillationScope}
              GROUP BY d.project_id, d.session_id
           ) d ON d.project_id = t.project_id AND d.session_id = t.session_id
           LEFT JOIN session_meta m
             ON m.project_id = t.project_id AND m.session_id = t.session_id
          WHERE ${whereWithAnd([projectScope])}
          GROUP BY t.project_id, t.session_id
         HAVING m.session_id IS NULL
             OR m.message_count <> COUNT(*)
             OR m.distillation_count <> COALESCE(d.distillation_count, 0)`,
  );
  const byProject = new Map<string, SessionMetaInput[]>();
  for (const { project_id: projectId, ...session } of staleRows) {
    const sessions = byProject.get(projectId) ?? [];
    sessions.push(session);
    byProject.set(projectId, sessions);
  }
  for (const [projectId, sessions] of byProject)
    refreshSessionMeta(projectId, sessions);
}

type SessionRefreshVersion = {
  dataVersion: number;
  totalChanges: number;
  scopeKey: string;
};

type SessionRefreshSnapshot = Omit<SessionRefreshVersion, "scopeKey">;

const sessionRefreshVersions = new WeakMap<
  object,
  Map<string, SessionRefreshVersion>
>();

function readSessionRefreshVersion(database = db()): SessionRefreshSnapshot {
  const dataVersion = database.query("PRAGMA data_version").get() as {
    data_version: number;
  };
  const totalChanges = database
    .query("SELECT total_changes() AS total_changes")
    .get() as { total_changes: number };
  return {
    dataVersion: dataVersion.data_version,
    totalChanges: totalChanges.total_changes,
  };
}

function refreshSessionTitlesIfStale(
  projectIds: string[] | null,
  tenant: string,
): void {
  const database = db();
  let versions = sessionRefreshVersions.get(database);
  if (!versions) {
    versions = new Map();
    sessionRefreshVersions.set(database, versions);
  }
  const scopeKey = JSON.stringify([
    tenant,
    projectIds === null ? null : [...projectIds].sort(),
  ]);
  const before = readSessionRefreshVersion(database);
  const previous = versions.get(tenant);
  if (
    previous &&
    previous.dataVersion === before.dataVersion &&
    previous.totalChanges === before.totalChanges &&
    previous.scopeKey === scopeKey
  ) {
    return;
  }

  refreshSessionTitles(projectIds, tenant);
  const after = readSessionRefreshVersion(database);
  if (before.dataVersion === after.dataVersion) {
    versions.set(tenant, { ...after, scopeKey });
  } else {
    versions.delete(tenant);
  }
}

export function toSnippet(text: string): string {
  const cleaned = sanitizeSurrogates(text)
    .split("")
    .map((char) => {
      const code = char.charCodeAt(0);
      return code <= 0x08 ||
        (code >= 0x0b && code <= 0x1f) ||
        (code >= 0x7f && code <= 0x9f)
        ? " "
        : char;
    })
    .join("")
    .replace(/<[^>]*>/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[ \t]{0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)/gm, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const characters = Array.from(cleaned);
  return characters.length > 160
    ? `${characters.slice(0, 159).join("")}…`
    : cleaned;
}

function hydrateRows(rows: ActivityRow[]): ActivityItem[] {
  for (const kind of ACTIVITY_KINDS) {
    const kindRows = rows.filter((row) => row.kind === kind);
    if (kindRows.length > 0) ACTIVITY_LEGS[kind].hydrate(kindRows);
  }
  return rows.map((row) => ({
    kind: row.kind,
    id: row.id,
    project_id: row.project_id,
    project_name: row.project_name,
    title: row.title,
    snippet: toSnippet(row.snippet ?? ""),
    participants: row.participants ?? [],
    last_activity_at: row.last_activity_at,
    total: row.total,
    match: row.match ?? "exact",
  }));
}

export function listActivity(options: {
  parsed: ParsedActivityQuery;
  cursor: ActivityCursor | null;
  limit: number;
}): ActivityPage {
  const limit = Math.max(1, Math.floor(options.limit));
  const tenant = currentTenantId();
  const kinds = selectedKinds(options.parsed);
  if (kinds.length === 0) return { items: [], next: null };

  const projectIds = resolveProjects(options.parsed.server.projects, tenant);
  if (projectIds !== null && projectIds.length === 0) {
    return { items: [], next: null };
  }

  const terms = options.parsed.server.terms;
  const filters: ActivityFilters = {
    tenant,
    projectIds,
    with: options.parsed.server.with,
    terms,
    after: options.parsed.server.after,
    before: options.parsed.server.before,
  };
  if (terms.length > 0) refreshSessionTitlesIfStale(projectIds, tenant);

  const exactRows = sql.all<ActivityRow>(
    db(),
    activityRowsQuery(kinds, filters, options.cursor, limit + 1),
  );
  const hasMore = exactRows.length > limit;
  const pageRows = hasMore ? exactRows.slice(0, limit) : exactRows;
  for (const row of pageRows) row.match = "exact";
  const last = pageRows[pageRows.length - 1];
  const next =
    hasMore && last
      ? {
          t: last.last_activity_at,
          k: last.kind,
          id: last.id,
        }
      : null;

  let items = hydrateRows(pageRows);
  if (
    !next &&
    items.length < limit &&
    terms.length > 0 &&
    normalizeFuzzy(terms.join(" ")).length >= FUZZY_MIN_QUERY
  ) {
    const candidateFilters = { ...filters, excludeTerms: true };
    const candidates = sql.all<ActivityRow>(
      db(),
      activityRowsQuery(
        kinds,
        candidateFilters,
        null,
        ACTIVITY_FUZZY_CANDIDATE_CAP,
      ),
    );
    const fuzzyRows = fuzzyRank(
      terms.join(" "),
      candidates,
      (row) => [row.title],
      { limit: limit - items.length },
    ).map(({ item }) => ({ ...item, match: "fuzzy" as const }));
    items = [...items, ...hydrateRows(fuzzyRows)];
  }

  return { items, next };
}
