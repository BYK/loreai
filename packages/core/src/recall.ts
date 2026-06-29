/**
 * Recall — unified search across Lore's memory sources.
 *
 * Pure search + result-formatting logic shared by every host's recall tool.
 * Hosts (OpenCode plugin, Pi extension, future ACP server) wrap `runRecall()`
 * in their tool-registration mechanism:
 *   - OpenCode: `tool()` from `@opencode-ai/plugin/tool`
 *   - Pi: `pi.registerTool()` with TypeBox schema
 *
 * Behavior is identical across hosts so curated knowledge travels with the user.
 */
import * as latReader from "./lat-reader";
import * as ltm from "./ltm";
import * as temporal from "./temporal";
import * as embedding from "./embedding";
import { ReadPathTimer } from "./read-telemetry";
import * as entities from "./entities";
import * as toolTrace from "./tool-trace";
import * as log from "./log";
import { db, ensureProject, projectName } from "./db";
import type { LoreConfig } from "./config";
import type { LLMClient } from "./types";
import {
  EMPTY_QUERY,
  exactTermMatchRank,
  expandQuery,
  filterTerms,
  ftsQuery,
  reciprocalRankFusion,
  runRelaxedSearchAsync,
  termIDF,
} from "./search";
import {
  offloadAll,
  offloadAllOrTimeout,
  READ_JOB_TIMED_OUT,
} from "./read-offload";
import { inline } from "./markdown";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Distillation = {
  id: string;
  observations: string;
  generation: number;
  created_at: number;
  session_id: string;
  c_norm: number | null;
  r_compression: number | null;
};

export type ScoredDistillation = Distillation & { rank: number };

/** An entity result. `rank` mirrors the other scored sources for type parity;
 *  RRF fuses by list position, not by this value. */
export type ScoredEntity = entities.EntityWithAliases & { rank: number };

export type RecallScope = "all" | "session" | "project" | "knowledge";

export type RecallInput = {
  query: string;
  /** Narrow the search surface. Defaults to `"all"`. */
  scope?: RecallScope;
  /** Fetch full content of a specific result by its source-prefixed ID (e.g. "k:xxx", "d:xxx"). */
  id?: string;
  /** Project root — used by all scoring paths. */
  projectPath: string;
  /** Current session ID — required when `scope === "session"`. */
  sessionID?: string;
  /** Whether to include long-term knowledge results. Default `true`. */
  knowledgeEnabled?: boolean;
  /** Optional LLM client for query expansion (if `config.search.queryExpansion`). */
  llm?: LLMClient;
  /** Search config — provides recallLimit, queryExpansion, ftsWeights, etc. */
  searchConfig?: LoreConfig["search"];
  /**
   * Record cross-project knowledge transfer metrics (issue #506) for
   * foreign/promoted entries that survive fusion. Set true ONLY for genuine
   * agent recall (executeRecall); left false for dashboard/CLI searches so they
   * don't inflate counts. Default false.
   */
  recordTransfers?: boolean;
};

/** Result of a full recall run — markdown-formatted string for the LLM. */
export type RecallResult = string;

export type TaggedResult =
  | { source: "knowledge"; item: ltm.ScoredKnowledgeEntry }
  | {
      source: "cross-knowledge";
      item: ltm.ScoredKnowledgeEntry;
      projectLabel: string;
    }
  | { source: "distillation"; item: ScoredDistillation }
  | { source: "temporal"; item: temporal.ScoredTemporalMessage }
  | { source: "lat-section"; item: latReader.ScoredLatSection }
  | { source: "entity"; item: ScoredEntity };

export type ScoredTaggedResult = { item: TaggedResult; score: number };

/**
 * Multiplier applied to the fused score of raw/archived history (`temporal`
 * and `distillation` sources) that belongs to a session OTHER than the current
 * one, under non-session scopes. Keeps cross-session raw history reachable when
 * it is strongly relevant, but prevents weak keyword overlap from injecting
 * unrelated prior-session content into a fresh session.
 */
const CROSS_SESSION_RAW_PENALTY = 0.5;

// ---------------------------------------------------------------------------
// Tagged result helpers (used by exact-match boost + formatting)
// ---------------------------------------------------------------------------

/** Extract searchable text from any TaggedResult variant. */
function getTaggedText(tagged: TaggedResult): string {
  switch (tagged.source) {
    case "knowledge":
    case "cross-knowledge":
      return `${tagged.item.title} ${tagged.item.content}`;
    case "distillation":
      return tagged.item.observations;
    case "temporal":
      return tagged.item.content;
    case "lat-section":
      return `${tagged.item.heading} ${tagged.item.content}`;
    case "entity":
      return `${tagged.item.canonical_name} ${tagged.item.aliases
        .map((a) => a.alias_value)
        .join(" ")}`;
  }
}

/** Unified key function for TaggedResult — source-prefixed ID for RRF dedup. */
function taggedResultKey(r: TaggedResult): string {
  switch (r.source) {
    case "knowledge":
      return `k:${r.item.id}`;
    case "cross-knowledge":
      return `xk:${r.item.id}`;
    case "distillation":
      return `d:${r.item.id}`;
    case "temporal":
      return `t:${r.item.id}`;
    case "lat-section":
      return `lat:${r.item.id}`;
    case "entity":
      return `e:${r.item.id}`;
  }
}

// ---------------------------------------------------------------------------
// Distillation search
// ---------------------------------------------------------------------------

/** LIKE-based fallback for when FTS5 fails unexpectedly on distillations. */
function searchDistillationsLike(input: {
  pid: string;
  query: string;
  sessionID?: string;
  limit: number;
}): Distillation[] {
  const terms = input.query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 1);
  if (!terms.length) return [];
  const conditions = terms
    .map(() => "LOWER(observations) LIKE ?")
    .join(" AND ");
  const likeParams = terms.map((term) => `%${term}%`);
  const sql = input.sessionID
    ? `SELECT id, observations, generation, created_at, session_id, c_norm, r_compression FROM distillations WHERE project_id = ? AND session_id = ? AND ${conditions} ORDER BY created_at DESC LIMIT ?`
    : `SELECT id, observations, generation, created_at, session_id, c_norm, r_compression FROM distillations WHERE project_id = ? AND ${conditions} ORDER BY created_at DESC LIMIT ?`;
  const allParams = input.sessionID
    ? [input.pid, input.sessionID, ...likeParams, input.limit]
    : [input.pid, ...likeParams, input.limit];
  return db()
    .query(sql)
    .all(...allParams) as Distillation[];
}

async function searchDistillationsScored(input: {
  projectPath: string;
  query: string;
  sessionID?: string;
  limit?: number;
  /** IDF weights from `termIDF()` — when provided, the relaxed cascade
   *  drops common terms first instead of short ones. */
  termWeights?: Map<string, number>;
}): Promise<ScoredDistillation[]> {
  const pid = ensureProject(input.projectPath);
  const limit = input.limit ?? 10;

  const ftsSQL = input.sessionID
    ? `SELECT d.id, d.observations, d.generation, d.created_at, d.session_id, d.c_norm, d.r_compression, rank
       FROM distillation_fts f
       CROSS JOIN distillations d ON d.rowid = f.rowid
       WHERE distillation_fts MATCH ?
       AND d.project_id = ? AND d.session_id = ?
       ORDER BY rank LIMIT ?`
    : `SELECT d.id, d.observations, d.generation, d.created_at, d.session_id, d.c_norm, d.r_compression, rank
       FROM distillation_fts f
       CROSS JOIN distillations d ON d.rowid = f.rowid
       WHERE distillation_fts MATCH ?
       AND d.project_id = ?
       ORDER BY rank LIMIT ?`;

  try {
    return await runRelaxedSearchAsync(
      input.query,
      async (matchExpr) => {
        const params = input.sessionID
          ? [matchExpr, pid, input.sessionID, limit]
          : [matchExpr, pid, limit];
        // Staleness-tolerant distillation FTS scan — offload off the event loop
        // (#966 B). The selected columns are lean (no embedding BLOB).
        const rows = await offloadAllOrTimeout(ftsSQL, params);
        if (rows === READ_JOB_TIMED_OUT) return null;
        return rows as ScoredDistillation[];
      },
      input.termWeights,
    );
  } catch {
    // FTS5 failed — fall back to LIKE search with synthetic rank
    return searchDistillationsLike({
      pid,
      query: input.query,
      sessionID: input.sessionID,
      limit,
    }).map((dist, i) => ({ ...dist, rank: -(10 - i) }));
  }
}

/**
 * Batch-hydrate vector-search hits with a single `WHERE id IN (...)` scan
 * offloaded onto the read-worker pool (#966). Replaces the previous per-hit
 * `db().query(...).get(hit.id)` loops, which ran one synchronous indexed lookup
 * per hit on the main event loop. `selectPrefix` MUST be a `SELECT ... WHERE id
 * IN`-shaped fragment with a lean column list (no embedding BLOB) so rows are
 * structured-clone-safe across the worker boundary. Returns a map keyed by row
 * id; callers iterate the hits in similarity order, preserving ranking and
 * dropping misses exactly as the per-hit loops did. On pool timeout
 * `offloadAll` resolves to `[]`, so a slow worker degrades to "no hits for this
 * source" rather than re-blocking the main thread.
 */
async function hydrateVectorRows<T extends { id: string }>(
  hits: ReadonlyArray<{ id: string }>,
  selectPrefix: string,
): Promise<Map<string, T>> {
  const map = new Map<string, T>();
  if (!hits.length) return map;
  const ids = hits.map((h) => h.id);
  const placeholders = ids.map(() => "?").join(",");
  const rows = (await offloadAll(
    `${selectPrefix} (${placeholders})`,
    ids,
  )) as T[];
  for (const row of rows) map.set(row.id, row);
  return map;
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

/** Default formatting config used when no overrides are provided. */
const DEFAULT_FORMAT_CONFIG = {
  charBudget: 12000,
  relevanceFloor: 0.15,
  maxResults: 15,
  // Absolute RRF score floor. Unlike `relevanceFloor` (relative to the top
  // result), this drops results whose absolute fused score is too low to be
  // trustworthy — preventing weak cross-session archives from being force-
  // injected when nothing in the project is genuinely relevant. 0 disables it.
  absoluteFloor: 0,
};

type FormatConfig = typeof DEFAULT_FORMAT_CONFIG;

/**
 * Truncate text at a sentence boundary within maxChars.
 *
 * Walks backwards from the budget limit looking for sentence-ending
 * punctuation (. ! ?) followed by whitespace or end-of-string.
 * Only searches the back half of the budget to avoid cutting too short.
 * Falls back to word boundary if no sentence end is found.
 */
function truncateAtSentence(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  // Search backwards from maxChars for a sentence boundary
  const minPos = Math.floor(maxChars * 0.5);
  for (let i = maxChars - 1; i >= minPos; i--) {
    if (
      (text[i] === "." || text[i] === "!" || text[i] === "?") &&
      (i + 1 >= text.length || /\s/.test(text[i + 1]))
    ) {
      return text.slice(0, i + 1);
    }
  }

  // No sentence boundary — fall back to word boundary
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > minPos) return `${text.slice(0, lastSpace)}...`;
  return `${slice}...`;
}

/** Source-type weights for budget allocation. Higher = more space. */
const SOURCE_WEIGHT: Record<TaggedResult["source"], number> = {
  knowledge: 1.0,
  "cross-knowledge": 1.0,
  entity: 0.9,
  "lat-section": 0.9,
  distillation: 0.8,
  temporal: 0.8,
};

/** Tier multipliers for budget allocation. */
const TIER_MULTIPLIERS = [3.0, 1.5, 0.7] as const;

/** Human-readable tier labels. */
const TIER_NAMES = ["Strong Matches", "Supporting", "Peripheral"] as const;

/** Source display order within a tier. */
const SOURCE_ORDER: Record<TaggedResult["source"], number> = {
  entity: 0,
  knowledge: 1,
  "cross-knowledge": 2,
  "lat-section": 3,
  distillation: 4,
  temporal: 5,
};

/** Human-readable source group labels for sub-headers. */
const SOURCE_LABELS: Record<TaggedResult["source"], string> = {
  entity: "People & Entities",
  knowledge: "Knowledge",
  "cross-knowledge": "Cross-Project",
  "lat-section": "Reference",
  distillation: "Distilled",
  temporal: "Conversation",
};

/** Format a relative age string from a timestamp. */
function relativeAge(createdAt: number): string {
  const diffMs = Date.now() - createdAt;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

type TieredResult = ScoredTaggedResult & {
  tier: 0 | 1 | 2;
  charBudget: number;
};

function formatFusedResults(
  results: ScoredTaggedResult[],
  config: FormatConfig,
): string {
  if (!results.length) return "No results found for this query.";

  const totalFound = results.length;
  const topScore = results[0].score;
  // Combine the relative floor (topScore * relevanceFloor) with an absolute
  // floor so weak matches are dropped even when the whole result set is weak.
  const scoreFloor = Math.max(
    topScore * config.relevanceFloor,
    config.absoluteFloor,
  );

  // Step 1: Score-based cutoff + hard cap. Backfill to 3 results only with
  // items that still clear the ABSOLUTE floor, so we never force-inject
  // content that is weak in absolute terms (e.g. stale cross-session archives
  // surfaced by an off-topic recall query).
  let kept = results.filter((r) => r.score >= scoreFloor);
  kept = kept.slice(0, config.maxResults);
  if (kept.length < 3) {
    kept = results.filter((r) => r.score >= config.absoluteFloor).slice(0, 3);
  }

  if (!kept.length) return "No results found for this query.";

  // Step 2: Assign tiers based on relative score.
  const tiered: TieredResult[] = kept.map((r) => ({
    ...r,
    tier: r.score >= topScore * 0.6 ? 0 : r.score >= topScore * 0.3 ? 1 : 2,
    charBudget: 0, // computed next
  }));

  // Step 3: Compute per-result char budgets proportional to weight.
  const rawWeights = tiered.map(
    (r) => SOURCE_WEIGHT[r.item.source] * TIER_MULTIPLIERS[r.tier],
  );
  const totalWeight = rawWeights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < tiered.length; i++) {
    tiered[i].charBudget = Math.max(
      80,
      Math.min(
        1200,
        Math.floor((config.charBudget * rawWeights[i]) / totalWeight),
      ),
    );
  }

  // Step 4+5: Build markdown output grouped by tier, then by source.
  const lowScore = kept[kept.length - 1].score;
  const lines: string[] = [];

  lines.push(`## Recall Results`);
  lines.push(``);
  lines.push(
    `Found ${totalFound} results, showing top ${kept.length} (score range: ${topScore.toFixed(3)}–${lowScore.toFixed(3)}).`,
  );

  for (const tierIdx of [0, 1, 2] as const) {
    const tierResults = tiered.filter((r) => r.tier === tierIdx);
    if (!tierResults.length) continue;

    // Sort by source order within tier
    tierResults.sort(
      (a, b) => SOURCE_ORDER[a.item.source] - SOURCE_ORDER[b.item.source],
    );

    lines.push(``);
    lines.push(`### ${TIER_NAMES[tierIdx]}`);

    // Group by source type for sub-headers
    let currentSource: TaggedResult["source"] | null = null;

    for (const r of tierResults) {
      if (r.item.source !== currentSource) {
        currentSource = r.item.source;
        lines.push(``);
        lines.push(`#### ${SOURCE_LABELS[currentSource]}`);
      }

      const line = renderResultLine(r.item, r.charBudget);
      lines.push(line);
    }
  }

  // Footer
  const anyTruncated = tiered.some(
    (r) => getFullContentLength(r.item) > r.charBudget,
  );
  lines.push(``);
  lines.push(`---`);
  if (anyTruncated) {
    lines.push(
      `*${kept.length} of ${totalFound} results shown. Use recall with id parameter to see full content of truncated results.*`,
    );
  } else {
    lines.push(`*${kept.length} of ${totalFound} results shown.*`);
  }

  return lines.join("\n");
}

/**
 * Build the compact human-readable pieces of an entity summary used for recall
 * rendering: deduped aliases, a role/description blurb from metadata, and
 * resolved relations (e.g. "partner of Burak Yigit Kaya").
 */
function entitySummaryParts(item: entities.EntityWithAliases): {
  aliasesText: string;
  metaText: string;
  relationsText: string;
} {
  const uniqueAliases = Array.from(
    new Set(
      item.aliases
        .map((a) => a.alias_value)
        .filter((v) => v !== item.canonical_name),
    ),
  );
  const aliasesText = uniqueAliases.length
    ? `aka ${uniqueAliases.join(", ")}`
    : "";

  let metaText = "";
  try {
    const meta = item.metadata
      ? (JSON.parse(item.metadata) as Record<string, unknown>)
      : null;
    if (meta && typeof meta === "object") {
      const bits: string[] = [];
      if (typeof meta.role === "string") bits.push(meta.role);
      if (typeof meta.description === "string") bits.push(meta.description);
      metaText = bits.join("; ");
    }
  } catch {
    // malformed metadata JSON — skip
  }

  let relationsText = "";
  try {
    relationsText = entities.formatRelationsForPrompt(item.id);
  } catch {
    // non-fatal — relations are best-effort
  }

  return { aliasesText, metaText, relationsText };
}

/** Get the full content length of a tagged result (before truncation). */
function getFullContentLength(tagged: TaggedResult): number {
  switch (tagged.source) {
    case "knowledge":
    case "cross-knowledge":
      return tagged.item.title.length + tagged.item.content.length + 4; // **: :
    case "distillation":
      return tagged.item.observations.length;
    case "temporal":
      return tagged.item.content.length;
    case "lat-section":
      return tagged.item.heading.length + tagged.item.content.length;
    case "entity": {
      const p = entitySummaryParts(tagged.item);
      return (
        tagged.item.canonical_name.length +
        p.aliasesText.length +
        p.metaText.length +
        p.relationsText.length
      );
    }
  }
}

/** Render a single result as a markdown list item line. */
/**
 * Fetch source message IDs for a distillation segment.
 * Returns a compact list of IDs that can be used with the recall tool
 * to fetch full message details on demand.
 */
function getDistillationSourceIds(distillId: string): string[] {
  try {
    const row = db()
      .query("SELECT source_ids FROM distillations WHERE id = ?")
      .get(distillId) as { source_ids: string } | null;
    if (!row?.source_ids) return [];
    return JSON.parse(row.source_ids);
  } catch {
    return [];
  }
}

function renderResultLine(tagged: TaggedResult, charBudget: number): string {
  const id = taggedResultKey(tagged);

  switch (tagged.source) {
    case "knowledge": {
      const k = tagged.item;
      const age = relativeAge(k.updated_at);
      const titlePart = `**${inline(k.title)}** (${age}): `;
      const contentBudget = Math.max(40, charBudget - titlePart.length);
      const content = truncateAtSentence(inline(k.content), contentBudget);
      const wasTruncated = inline(k.content).length > contentBudget;
      return `- ${titlePart}${content}${wasTruncated ? ` (${id})` : ""}`;
    }
    case "cross-knowledge": {
      const k = tagged.item;
      const age = relativeAge(k.updated_at);
      const titlePart = `**${inline(k.title)}** (${age}, from: ${tagged.projectLabel}): `;
      const contentBudget = Math.max(40, charBudget - titlePart.length);
      const content = truncateAtSentence(inline(k.content), contentBudget);
      const wasTruncated = inline(k.content).length > contentBudget;
      return `- ${titlePart}${content}${wasTruncated ? ` (${id})` : ""}`;
    }
    case "distillation": {
      const d = tagged.item;
      // Compression hint: signal when the distillation is lossy so the model
      // knows to drill into source messages for exact details.
      const compressionHint =
        d.r_compression != null && d.r_compression < 1.0 ? "[lossy] " : "";
      const fullText = inline(d.observations);
      const content = truncateAtSentence(fullText, charBudget);
      const wasTruncated = fullText.length > charBudget;
      // Include source message IDs so the LLM can fetch full details
      // via the recall tool when the summary lacks specifics.
      const sourceIds = getDistillationSourceIds(d.id);
      const sourceRef =
        sourceIds.length > 0
          ? ` (sources: ${sourceIds.map((s) => `t:${s}`).join(", ")})`
          : "";
      return `- ${compressionHint}${content}${wasTruncated ? ` (${id})` : ""}${sourceRef}`;
    }
    case "temporal": {
      const m = tagged.item;
      const prefix = `(${m.role}, ${relativeAge(m.created_at)}) `;
      const contentBudget = Math.max(40, charBudget - prefix.length);
      const fullText = inline(m.content);
      const content = truncateAtSentence(fullText, contentBudget);
      const wasTruncated = fullText.length > contentBudget;
      return `- ${prefix}${content}${wasTruncated ? ` (${id})` : ""}`;
    }
    case "lat-section": {
      const s = tagged.item;
      const heading = `**${inline(s.file)} \u00A7 ${inline(s.heading)}**: `;
      const contentBudget = Math.max(40, charBudget - heading.length);
      const fullText = s.first_paragraph
        ? inline(s.first_paragraph)
        : inline(s.content);
      const content = truncateAtSentence(fullText, contentBudget);
      const wasTruncated = fullText.length > contentBudget;
      return `- ${heading}${content}${wasTruncated ? ` (${id})` : ""}`;
    }
    case "entity": {
      const e = tagged.item;
      const typeLabel =
        e.entity_type === "self" ? "person, you" : e.entity_type;
      const head = `**${inline(e.canonical_name)}** (${typeLabel})`;
      const { aliasesText, metaText, relationsText } = entitySummaryParts(e);
      const detailFull = [aliasesText, metaText, relationsText]
        .filter(Boolean)
        .join(" \u2014 ");
      const detailBudget = Math.max(40, charBudget - head.length - 2);
      const detail = truncateAtSentence(inline(detailFull), detailBudget);
      const wasTruncated = inline(detailFull).length > detailBudget;
      return `- ${head}${detail ? `: ${detail}` : ""}${wasTruncated ? ` (${id})` : ""}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Search every relevant source, fuse with RRF, and return raw scored results.
 *
 * This is the search+fusion core shared by `runRecall()` (LLM-formatted) and
 * direct consumers like the web UI that need access to the raw result items.
 */
export async function searchRecall(
  input: RecallInput,
): Promise<ScoredTaggedResult[]> {
  const {
    query,
    scope = "all",
    projectPath,
    sessionID,
    knowledgeEnabled = true,
    llm,
    searchConfig,
  } = input;

  const limit = searchConfig?.recallLimit ?? 10;

  // Short-circuit vague queries — stopwords-only would match everything.
  if (ftsQuery(query) === EMPTY_QUERY) {
    return [];
  }

  // Measure the read path's main-thread blocking cost (#966 B). Awaits below
  // (LLM expansion, embed, the pool-backed vector searches) are wrapped so the
  // remainder of the wall time is this call's own synchronous FTS/hydration/RRF
  // work. Emitted just before the return.
  const timer = new ReadPathTimer();

  const queryTerms = filterTerms(query);
  const queryTermCount = queryTerms.length;

  // Compute IDF weights for the original query terms. Used by the relaxed
  // cascade to drop common/generic terms first instead of short ones — keeps
  // discriminative terms like "V8", "SEA", "PKCE" in the cascade longer.
  const idfWeights = termIDF(query);

  // Optional LLM query expansion: generate alternative phrasings.
  // Skip for long queries (> queryExpansionMaxTerms) — they already have high
  // specificity and expansion introduces noise that dilutes precision (e.g.
  // a 14-term technical query gets tangential LLM expansions that accumulate
  // enough RRF score to displace the correct result).
  const expansionMaxTerms = searchConfig?.queryExpansionMaxTerms ?? 8;
  let queries = [query];
  if (
    searchConfig?.queryExpansion &&
    llm &&
    queryTermCount <= expansionMaxTerms
  ) {
    try {
      queries = await timer.await(
        expandQuery(llm, query, undefined, sessionID),
      );
    } catch (err) {
      log.info("recall: query expansion failed, using original:", err);
    }
  }

  // Entity-aware query expansion: detect entity references in the query
  // and add all known aliases as additional search queries. This ensures
  // "what did Seylan say?" finds results referencing "@seylancinar" or email.
  // Always runs regardless of term count — entity aliases are fast and targeted.
  try {
    const entityExpansions = entities.expandQueryWithEntities(query);
    if (entityExpansions.length > 0) {
      // Add each alias as a separate query variant (up to 4)
      for (const alias of entityExpansions.slice(0, 4)) {
        if (!queries.includes(alias)) {
          queries.push(alias);
        }
      }
    }
  } catch (err) {
    log.info("recall: entity query expansion failed (non-fatal):", err);
  }

  // Determine vector boost weight: for queries with enough meaningful terms,
  // boost vector search lists so semantic similarity outweighs keyword noise.
  const vectorWeight =
    queryTermCount >= (searchConfig?.vectorBoostMinTerms ?? 3)
      ? (searchConfig?.vectorBoostWeight ?? 1.5)
      : 1;

  // Collect per-query RRF lists. Original query is always first; if expansion
  // produced extras, we still weight the original twice by adding both original
  // and expanded lists (RRF naturally weights items appearing in more lists).
  const allRrfLists: Array<{
    items: TaggedResult[];
    key: (r: TaggedResult) => string;
    weight?: number;
  }> = [];

  // Track whether session-specific results (temporal/distillation) exist
  // across any query. Used to downweight knowledge when session content is
  // available — knowledge entries are general cross-session facts, and when
  // temporal details exist they are more likely the answer.
  let hasSessionResults = false;

  // Track where primary (first-query) lists end so the MAX_RRF_LISTS cap
  // trims expanded-query lists first, preserving vector/supplemental lists.
  let primaryListEnd = 0;

  for (const q of queries) {
    const knowledgeResults: ltm.ScoredKnowledgeEntry[] = [];
    if (knowledgeEnabled && scope !== "session") {
      try {
        knowledgeResults.push(
          ...(await ltm.searchScored({
            query: q,
            projectPath,
            limit,
            termWeights: idfWeights,
          })),
        );
      } catch (err) {
        log.error("recall: knowledge search failed:", err);
      }
    }

    const distillationResults: ScoredDistillation[] = [];
    if (scope !== "knowledge") {
      try {
        distillationResults.push(
          ...(await searchDistillationsScored({
            projectPath,
            query: q,
            sessionID: scope === "session" ? sessionID : undefined,
            limit,
            termWeights: idfWeights,
          })),
        );
      } catch (err) {
        log.error("recall: distillation search failed:", err);
      }
    }

    const temporalResults: temporal.ScoredTemporalMessage[] = [];
    if (scope !== "knowledge") {
      try {
        temporalResults.push(
          ...(await temporal.searchScored({
            projectPath,
            query: q,
            sessionID: scope === "session" ? sessionID : undefined,
            limit,
            termWeights: idfWeights,
          })),
        );
      } catch (err) {
        log.error("recall: temporal search failed:", err);
      }
    }

    if (temporalResults.length > 0 || distillationResults.length > 0) {
      hasSessionResults = true;
    }

    // When searching all scopes AND session-specific results exist,
    // downweight knowledge BM25 so session content ranks higher.
    const knowledgeWeight = scope === "all" && hasSessionResults ? 0.6 : 1.0;

    allRrfLists.push(
      {
        items: knowledgeResults.map((item) => ({
          source: "knowledge" as const,
          item,
        })),
        key: (r) => `k:${r.item.id}`,
        weight: knowledgeWeight,
      },
      {
        items: distillationResults.map((item) => ({
          source: "distillation" as const,
          item,
        })),
        key: (r) => `d:${r.item.id}`,
      },
      {
        items: temporalResults.map((item) => ({
          source: "temporal" as const,
          item,
        })),
        key: (r) => `t:${r.item.id}`,
      },
    );

    // Recency-biased list for temporal results: same candidates re-ranked
    // by created_at (newest first). RRF naturally boosts messages that
    // appear in both the BM25 and recency lists — i.e. results that are
    // both semantically relevant AND recent. Uses the same `t:` key prefix
    // so RRF merges rather than duplicates.
    if (temporalResults.length > 0) {
      const recencySorted = [...temporalResults].sort(
        (a, b) => b.created_at - a.created_at,
      );
      allRrfLists.push({
        items: recencySorted.map((item) => ({
          source: "temporal" as const,
          item,
        })),
        key: (r) => `t:${r.item.id}`,
      });
    }

    // Recency-biased list for distillation results (structural parity with
    // temporal). Recent distillations covering the most recent work get a
    // deserved RRF boost. Same `d:` key prefix so RRF merges, not duplicates.
    if (distillationResults.length > 0) {
      const recencySorted = [...distillationResults].sort(
        (a, b) => b.created_at - a.created_at,
      );
      allRrfLists.push({
        items: recencySorted.map((item) => ({
          source: "distillation" as const,
          item,
        })),
        key: (r) => `d:${r.item.id}`,
      });
    }

    // Session-affinity boost: when searching all scopes with a known session,
    // add extra RRF lists for same-session results. This boosts current-session
    // temporal messages and distillations over cross-session LTM entries that
    // may match keywords but lack session-specific context.
    if (scope === "all" && sessionID) {
      const sessionTemporal = temporalResults.filter(
        (r) => r.session_id === sessionID,
      );
      if (sessionTemporal.length > 0) {
        allRrfLists.push({
          items: sessionTemporal.map((item) => ({
            source: "temporal" as const,
            item,
          })),
          key: (r) => `t:${r.item.id}`,
        });
      }

      const sessionDistillations = distillationResults.filter(
        (r) => r.session_id === sessionID,
      );
      if (sessionDistillations.length > 0) {
        allRrfLists.push({
          items: sessionDistillations.map((item) => ({
            source: "distillation" as const,
            item,
          })),
          key: (r) => `d:${r.item.id}`,
        });
      }
    }

    // Mark the end of the first (original) query's lists. Supplemental lists
    // (vector, lat.md, cross-project, quality, exact-match) are appended after
    // the loop and should be preserved over expanded-query lists when capping.
    if (primaryListEnd === 0) {
      primaryListEnd = allRrfLists.length;
    }
  }
  const perQueryListEnd = allRrfLists.length;

  // Vector search on the original query (not expansions — avoid redundant embeds).
  if (embedding.isAvailable() && scope !== "session") {
    try {
      const [queryVec] = await timer.await(embedding.embed([query], "query"));

      // Knowledge vector search
      if (knowledgeEnabled) {
        const vectorHits = await timer.await(
          embedding.vectorSearch(queryVec, limit),
        );
        // Batch-hydrate hits off-thread (#966) instead of N per-hit ltm.get().
        const entryMap = await timer.await(
          ltm.getManyOffloaded(vectorHits.map((h) => h.id)),
        );
        const vectorTagged: TaggedResult[] = [];
        for (const hit of vectorHits) {
          const entry = entryMap.get(hit.id);
          if (entry) {
            vectorTagged.push({
              source: "knowledge",
              item: { ...entry, rank: -hit.similarity },
            });
          }
        }
        if (vectorTagged.length) {
          // Same `k:` key prefix as BM25 knowledge — RRF merges, not duplicates.
          // Apply knowledge downweight so knowledge is consistently
          // deprioritized when session-specific content exists.
          const kvWeight = scope === "all" && hasSessionResults ? 0.6 : 1.0;
          allRrfLists.push({
            items: vectorTagged,
            key: (r) => `k:${r.item.id}`,
            weight: vectorWeight * kvWeight,
          });
        }
      }

      // Distillation vector search
      if (scope !== "knowledge") {
        const distVectorHits = await timer.await(
          embedding.vectorSearchDistillations(queryVec, limit),
        );
        // Batch-hydrate hits off-thread (#966) instead of N per-hit point reads.
        const distMap = await timer.await(
          hydrateVectorRows<Distillation>(
            distVectorHits,
            "SELECT id, observations, generation, created_at, session_id, c_norm, r_compression FROM distillations WHERE id IN",
          ),
        );
        const distVectorTagged: TaggedResult[] = distVectorHits
          .map((hit): TaggedResult | null => {
            const row = distMap.get(hit.id);
            if (!row) return null;
            return {
              source: "distillation",
              item: { ...row, rank: -hit.similarity },
            };
          })
          .filter((r): r is TaggedResult => r !== null);
        if (distVectorTagged.length) {
          allRrfLists.push({
            items: distVectorTagged,
            key: (r) => `d:${r.item.id}`,
            weight: vectorWeight,
          });
        }
      }

      // Temporal vector search (includes distilled — embeddings preserved by markDistilled)
      if (scope !== "knowledge") {
        const pid = ensureProject(projectPath);
        const temporalVectorHits = await timer.await(
          embedding.vectorSearchTemporal(queryVec, pid, limit),
        );
        // Batch-hydrate hits off-thread (#966) instead of N per-hit point reads.
        const temporalMap = await timer.await(
          hydrateVectorRows<temporal.TemporalMessage>(
            temporalVectorHits,
            "SELECT id, project_id, session_id, role, content, tokens, distilled, created_at, metadata FROM temporal_messages WHERE id IN",
          ),
        );
        const temporalVectorTagged: TaggedResult[] = temporalVectorHits
          .map((hit): TaggedResult | null => {
            const row = temporalMap.get(hit.id);
            if (!row) return null;
            return {
              source: "temporal",
              item: { ...row, rank: -hit.similarity },
            };
          })
          .filter((r): r is TaggedResult => r !== null);
        if (temporalVectorTagged.length) {
          allRrfLists.push({
            items: temporalVectorTagged,
            key: (r) => `t:${r.item.id}`,
            weight: vectorWeight,
          });
        }
      }

      // Entity vector search — semantic match on entity name/alias embeddings.
      // Same `e:` key as the FTS list so RRF merges (boosting entities that
      // match both lexically and semantically).
      if (scope === "all" || scope === "project") {
        // vectorSearchEntities is NOT project-scoped, so apply the same
        // visibility predicate entities.search() uses — otherwise a semantic
        // match could leak another project's project-scoped infra entity.
        // Exception: in "all" scope, cross-project `repo` entities ARE admitted
        // (mirrors the FTS cross-project repo discovery below), so a repo the
        // user references by name from another project resolves semantically
        // too. `infra` stays project-scoped.
        const entPid = ensureProject(projectPath);
        const entityVectorHits = await timer.await(
          embedding.vectorSearchEntities(queryVec, limit),
        );
        // Batch-hydrate hits off-thread (#966) instead of N per-hit
        // getWithAliases() calls (entity row + alias load each).
        const entMap = await timer.await(
          entities.getManyWithAliasesOffloaded(
            entityVectorHits.map((h) => h.id),
          ),
        );
        const entityVectorTagged: TaggedResult[] = entityVectorHits
          .map((hit): TaggedResult | null => {
            const ent = entMap.get(hit.id);
            if (!ent) return null;
            const visible =
              ent.project_id === entPid ||
              ent.project_id === null ||
              ent.cross_project === 1 ||
              (scope === "all" && ent.entity_type === "repo");
            if (!visible) return null;
            return {
              source: "entity",
              item: { ...ent, rank: -hit.similarity },
            };
          })
          .filter((r): r is TaggedResult => r !== null);
        if (entityVectorTagged.length) {
          allRrfLists.push({
            items: entityVectorTagged,
            key: (r) => `e:${r.item.id}`,
            weight: vectorWeight,
          });
        }
      }
    } catch (err) {
      log.info("recall: vector search failed:", err);
    }
  }

  // lat.md section search
  if (scope !== "session" && latReader.hasLatDir(projectPath)) {
    try {
      const latResults = await latReader.searchScored({
        query,
        projectPath,
        limit,
        termWeights: idfWeights,
      });
      if (latResults.length) {
        allRrfLists.push({
          items: latResults.map((item) => ({
            source: "lat-section" as const,
            item,
          })),
          key: (r) =>
            `lat:${(r as { source: "lat-section"; item: latReader.ScoredLatSection }).item.id}`,
        });
      }
    } catch (err) {
      log.info("recall: lat.md section search failed:", err);
    }
  }

  // Cross-project knowledge discovery — only in "all" scope.
  if (knowledgeEnabled && scope === "all") {
    try {
      const crossProjectResults = await ltm.searchScoredOtherProjects({
        query,
        excludeProjectPath: projectPath,
        limit,
        termWeights: idfWeights,
      });
      if (crossProjectResults.length) {
        allRrfLists.push({
          items: crossProjectResults.map((item: ltm.ScoredKnowledgeEntry) => {
            const label =
              (item.project_id ? projectName(item.project_id) : null) ??
              "other";
            return {
              source: "cross-knowledge" as const,
              item,
              projectLabel: label,
            } as TaggedResult;
          }),
          key: (r) => `xk:${r.item.id}`,
        });
      }
    } catch (err) {
      log.info("recall: cross-project knowledge search failed:", err);
    }
  }

  // Entity search — surface matching people/orgs/services/tools (with their
  // aliases + relations) as first-class results. Identity questions ("who is
  // Seylan?", "what's our CI?") are answered directly instead of only via the
  // alias query-expansion above. Cross-session/cross-project, so excluded from
  // "session" and "knowledge" scopes.
  if (scope === "all" || scope === "project") {
    try {
      const entityResults = await timer.await(
        entities.searchAsync({ query, projectPath, limit }),
      );
      if (entityResults.length) {
        allRrfLists.push({
          items: entityResults.map((item, i) => ({
            source: "entity" as const,
            item: { ...item, rank: i },
          })),
          key: (r) => `e:${r.item.id}`,
        });
      }
    } catch (err) {
      log.info("recall: entity search failed (non-fatal):", err);
    }
  }

  // Cross-project repository discovery — only in "all" scope. `repo` entities
  // are project-scoped (cross_project = 0) and deliberately excluded from the
  // entity visibility predicate above (FTS) and at recall.ts vector block, so a
  // repo owned by another project — one the user references by name while
  // working elsewhere — is otherwise unreachable. Surface those here. Same
  // `e:` key as the entity list so RRF merges them. `infra` stays excluded.
  if (scope === "all") {
    try {
      const crossRepos = await timer.await(
        entities.searchCrossProjectReposAsync({
          query,
          excludeProjectPath: projectPath,
          limit,
        }),
      );
      if (crossRepos.length) {
        allRrfLists.push({
          items: crossRepos.map((item, i) => ({
            source: "entity" as const,
            item: { ...item, rank: i },
          })),
          key: (r) => `e:${r.item.id}`,
        });
      }
    } catch (err) {
      log.info("recall: cross-project repo search failed (non-fatal):", err);
    }
  }

  // Entity-graph fan-in: Lore builds an entity graph (knowledge_entity_refs +
  // entity_relations) but search historically never traversed it — only the
  // dashboard did. Walk that graph from the entities this query already matched
  // (collected into the entity-tagged lists above) and surface (a) knowledge
  // entries linked to those entities and their 1-hop relation neighbors, and
  // (b) the neighbor entities themselves. Emitted as supplemental RRF lists with
  // the same `k:`/`e:` keys, so graph-reachable items merge with (and are
  // boosted by) the keyword/vector lists, while items reachable ONLY via the
  // graph enter as fresh candidates. Gated to scopes that surface entities.
  if (
    (searchConfig?.graphExpansion ?? true) &&
    (scope === "all" || scope === "project")
  ) {
    try {
      // Seeds = entities matched lexically/semantically (entity FTS + vector +
      // cross-repo). They were already visibility-filtered at their source, so
      // seeding from them never leaks another project's project-scoped entity.
      const seedIds = new Set<string>();
      for (const list of allRrfLists) {
        for (const it of list.items) {
          if (it.source === "entity") seedIds.add(it.item.id);
        }
      }

      if (seedIds.size) {
        const expansion = entities.graphExpand([...seedIds], {
          maxSeeds: 8,
          maxNeighbors: 12,
          maxKnowledge: limit * 2,
        });
        const graphWeight = searchConfig?.graphBoostWeight ?? 1.0;
        const gpid = ensureProject(projectPath);

        // (a) Graph-linked knowledge, ordered by graph score (depth-decay ×
        // local reach). Hydrated via getByLogical (refs store logical_ids) and
        // visibility-filtered to mirror ltm.searchScored — a knowledge entry
        // linked to a shared entity may belong to another project. Same `k:`
        // key as the BM25/vector knowledge lists so RRF merges, not duplicates.
        if (knowledgeEnabled && expansion.knowledge.length) {
          const graphKnowledge: TaggedResult[] = [];
          for (const gk of expansion.knowledge) {
            const entry = ltm.getByLogical(gk.logicalId);
            if (!entry) continue;
            const visible =
              entry.project_id === gpid ||
              entry.project_id === null ||
              entry.cross_project === 1;
            if (!visible) continue;
            graphKnowledge.push({
              source: "knowledge",
              item: { ...entry, rank: -gk.score },
            });
          }
          if (graphKnowledge.length) {
            // Apply the same session-aware knowledge downweight the other
            // knowledge lists use, so graph knowledge is deprioritized
            // consistently when session-specific content exists.
            const kgWeight = scope === "all" && hasSessionResults ? 0.6 : 1.0;
            allRrfLists.push({
              items: graphKnowledge,
              key: (r) => `k:${r.item.id}`,
              weight: graphWeight * kgWeight,
            });
          }
        }

        // (b) 1-hop neighbor entities, ordered by graph score. Hydrated +
        // visibility-filtered (same predicate entities.search uses). Same `e:`
        // key as the entity FTS/vector lists so RRF merges them.
        if (expansion.entities.length) {
          const neighborMap = await timer.await(
            entities.getManyWithAliasesOffloaded(
              expansion.entities.map((e) => e.id),
            ),
          );
          const graphEntities: TaggedResult[] = [];
          for (const ge of expansion.entities) {
            const ent = neighborMap.get(ge.id);
            if (!ent) continue;
            const visible =
              ent.project_id === gpid ||
              ent.project_id === null ||
              ent.cross_project === 1;
            if (!visible) continue;
            graphEntities.push({
              source: "entity",
              item: { ...ent, rank: -ge.score },
            });
          }
          if (graphEntities.length) {
            allRrfLists.push({
              items: graphEntities,
              key: (r) => `e:${r.item.id}`,
              weight: graphWeight,
            });
          }
        }
      }
    } catch (err) {
      log.info("recall: entity-graph expansion failed (non-fatal):", err);
    }
  }

  // Distillation quality list: rank distillation candidates by a quality score
  // that combines temporal clustering (c_norm) and age. Segments with low c_norm
  // (uniformly distributed timestamps) are considered higher quality than bursty
  // segments (high c_norm). Among high-c_norm segments, recent ones are more
  // likely relevant. This adds a mild signal — RRF naturally blends it with the
  // BM25 and vector signals without overriding them.
  {
    const distillationCandidates: Array<{
      tagged: TaggedResult;
      key: string;
      qualityScore: number;
    }> = [];

    for (const list of allRrfLists) {
      for (const item of list.items) {
        if (item.source !== "distillation") continue;
        const key = `d:${item.item.id}`;
        const d = item.item as ScoredDistillation;
        const cNorm = d.c_norm ?? 0; // NULL → treat as uniform (best case)
        // Quality score: lower c_norm is better. For high c_norm, recency
        // partially compensates. Age is normalized to days (capped at 90).
        const ageDays = Math.min((Date.now() - d.created_at) / 86_400_000, 90);
        // score ∈ [0, ~1]: 0 = best quality (uniform + recent)
        // c_norm dominates (0–1), age adds a mild 0–0.1 penalty
        const score = cNorm + (ageDays / 90) * 0.1;
        distillationCandidates.push({ tagged: item, key, qualityScore: score });
      }
    }

    if (distillationCandidates.length > 1) {
      // De-duplicate by key (same distillation may appear in BM25 + vector lists)
      const seen = new Set<string>();
      const unique = distillationCandidates.filter((c) => {
        if (seen.has(c.key)) return false;
        seen.add(c.key);
        return true;
      });

      // Sort by quality: lowest score first (best quality)
      unique.sort((a, b) => a.qualityScore - b.qualityScore);

      allRrfLists.push({
        items: unique.map((c) => c.tagged),
        key: (r) => `d:${r.item.id}`,
      });
    }
  }

  // Exact-match boost: add an additional RRF list that ranks candidates by
  // the number of exact query term matches. This boosts proper nouns, file
  // names, and technical terms that BM25's prefix/stem matching may dilute.
  // Only runs when there are meaningful terms and existing candidates.
  if (filterTerms(query).length > 0 && allRrfLists.length > 0) {
    // Collect unique candidates across all lists
    const allCandidates = new Map<string, TaggedResult>();
    for (const list of allRrfLists) {
      for (const item of list.items) {
        const key = list.key(item);
        if (!allCandidates.has(key)) allCandidates.set(key, item);
      }
    }

    const candidateEntries = [...allCandidates.entries()];
    const exactRanked = exactTermMatchRank(
      candidateEntries,
      ([, tagged]) => getTaggedText(tagged),
      query,
    );

    if (exactRanked.length) {
      allRrfLists.push({
        items: exactRanked.map(([, item]) => item),
        key: taggedResultKey,
      });
    }
  }

  // Cap the number of RRF lists to prevent score inflation from marginal items.
  // With query expansion (3 queries × 4 sources + supplemental lists), the list
  // count can exceed 15. Each list gives marginal items enough cumulative RRF
  // score to clear the relevance floor.
  //
  // Priority: primary (original query BM25 + recency) and supplemental
  // (vector, lat.md, cross-project, entity FTS + entity vector, quality,
  // exact-match) are high-value and always kept — only expanded-query BM25
  // lists are trimmed. Note: keeping all supplemental lists means the final
  // count can slightly exceed MAX_RRF_LISTS when primary+supplemental alone
  // already do; the cap only bounds how many expanded-query lists survive.
  const MAX_RRF_LISTS = 14;
  if (allRrfLists.length > MAX_RRF_LISTS) {
    // Layout: [0..primaryListEnd) = primary, [primaryListEnd..perQueryEnd) = expanded, [perQueryEnd..) = supplemental
    const primary = allRrfLists.slice(0, primaryListEnd);
    const expanded = allRrfLists.slice(primaryListEnd, perQueryListEnd);
    const supplemental = allRrfLists.slice(perQueryListEnd);
    const budget = Math.max(
      0,
      MAX_RRF_LISTS - primary.length - supplemental.length,
    );
    allRrfLists.length = 0;
    allRrfLists.push(...primary, ...expanded.slice(0, budget), ...supplemental);
  }

  let fused = reciprocalRankFusion<TaggedResult>(allRrfLists);

  // Demote cross-session raw/archived history. Under `scope="all"`/`"project"`
  // the temporal and distillation searches span the whole project, so raw
  // conversation and archived gen-0 distillations from prior, unrelated
  // sessions can surface on weak keyword overlap and derail a new session.
  // Knowledge / entities / lat-sections are intentionally cross-session and are
  // never penalized. Same-session results are never penalized either.
  if (scope !== "session" && sessionID) {
    fused = fused
      .map((r) => {
        if (r.item.source !== "temporal" && r.item.source !== "distillation") {
          return r;
        }
        if (r.item.item.session_id === sessionID) return r;
        return { ...r, score: r.score * CROSS_SESSION_RAW_PENALTY };
      })
      .sort((a, b) => b.score - a.score);
  }

  // Cap output: return at most 3x the per-source limit. With 7+ RRF sources
  // each contributing up to `limit` items, uncapped output can be huge (89+
  // results for broad OR fallbacks). The top-scoring items after RRF fusion
  // are the ones that appeared in multiple lists — capping preserves those
  // while dropping the long tail of single-list noise.
  const maxResults = limit * 3;
  timer.emit("recall", fused.length, scope);
  return fused.slice(0, maxResults);
}

// ---------------------------------------------------------------------------
// Recall by ID — fetch full untruncated content of a specific result
// ---------------------------------------------------------------------------

/**
 * Fetch the full content of a single result by its source-prefixed ID.
 *
 * IDs use the format `prefix:uuid` where prefix is one of:
 *   k: (knowledge), xk: (cross-knowledge), d: (distillation),
 *   t: (temporal), lat: (lat-section), e: (entity).
 */
export function recallById(id: string): string {
  const colonIdx = id.indexOf(":");
  if (colonIdx < 1) return `No entry found for id: ${id}`;

  const prefix = id.slice(0, colonIdx);
  const rawId = id.slice(colonIdx + 1);

  switch (prefix) {
    case "k":
    case "xk": {
      // Resolve a current OR superseded version id / logical_id to the current
      // entry (A2, #823) — a recalled id may be the stable logical_id.
      const entry = ltm.get(rawId) ?? ltm.getByLogical(ltm.logicalIdOf(rawId));
      if (!entry) return `No entry found for id: ${id}`;
      return [
        `## Recall Detail: ${id}`,
        ``,
        `#### Knowledge`,
        `- **${inline(entry.title)}** (${entry.category}): ${inline(entry.content)}`,
      ].join("\n");
    }
    case "d": {
      const row = db()
        .query(
          "SELECT id, observations, generation, created_at, session_id, c_norm, r_compression FROM distillations WHERE id = ?",
        )
        .get(rawId) as Distillation | null;
      if (!row) return `No entry found for id: ${id}`;
      return [
        `## Recall Detail: ${id}`,
        ``,
        `#### Distilled`,
        `${inline(row.observations)}`,
      ].join("\n");
    }
    case "t": {
      const row = db()
        .query(
          "SELECT id, project_id, session_id, role, content, tokens, distilled, created_at, metadata FROM temporal_messages WHERE id = ?",
        )
        .get(rawId) as temporal.TemporalMessage | null;
      if (!row) return `No entry found for id: ${id}`;
      return [
        `## Recall Detail: ${id}`,
        ``,
        `#### Conversation`,
        `(${row.role}, ${relativeAge(row.created_at)}, session: ${row.session_id.slice(0, 8)})`,
        ``,
        `${inline(row.content)}`,
      ].join("\n");
    }
    case "lat": {
      const row = db()
        .query(
          "SELECT id, project_id, file, heading, depth, content, content_hash, first_paragraph, updated_at FROM lat_sections WHERE id = ?",
        )
        .get(rawId) as latReader.LatSection | null;
      if (!row) return `No entry found for id: ${id}`;
      return [
        `## Recall Detail: ${id}`,
        ``,
        `#### Reference`,
        `**${inline(row.file)} \u00A7 ${inline(row.heading)}**`,
        ``,
        `${inline(row.content)}`,
      ].join("\n");
    }
    case "e": {
      const ent = entities.getWithAliases(rawId);
      if (!ent) return `No entry found for id: ${id}`;
      const lines = [
        `## Recall Detail: ${id}`,
        ``,
        `#### People & Entities`,
        entities.formatForPrompt([ent]),
      ];
      // formatForPrompt only renders relations relative to a self entity in the
      // passed array; for a single non-self entity it omits them — append
      // explicitly so the drill-down isn't less informative than the summary.
      const relations = entities.formatRelationsForPrompt(rawId);
      if (relations) lines.push(``, `Relations: ${relations}`);
      return lines.join("\n");
    }
    default:
      return `Unknown source prefix "${prefix}" in id: ${id}`;
  }
}

/** Full recall run: search every relevant source, fuse with RRF, format as markdown. */
export async function runRecall(input: RecallInput): Promise<RecallResult> {
  // ID-based detail retrieval — bypass search entirely.
  if (input.id) {
    return recallById(input.id);
  }

  const fused = await searchRecall(input);

  // Record cross-project knowledge transfers (issue #506) — only for genuine
  // agent recall. id-based detail retrieval already returned above, so
  // recallById is never counted. Two fused sources qualify:
  //   - "cross-knowledge": foreign-project non-promoted entries
  //     (searchScoredOtherProjects guarantees project_id != current project).
  //   - "knowledge": promoted cross_project=1 entries whose project_id is a
  //     DIFFERENT non-null project than the current one.
  if (input.recordTransfers) {
    try {
      const pid = ensureProject(input.projectPath);
      for (const { item: tagged } of fused) {
        if (
          tagged.source !== "cross-knowledge" &&
          tagged.source !== "knowledge"
        )
          continue;
        const entry = tagged.item;
        // For same-source knowledge results, only promoted cross-project entries
        // from another project count as transfers.
        if (tagged.source === "knowledge" && entry.cross_project !== 1)
          continue;
        if (!entry.project_id || entry.project_id === pid) continue;
        ltm.recordTransfer({
          knowledgeId: entry.logical_id,
          recalledInProjectId: pid,
        });
      }
    } catch (err) {
      log.warn("recall: transfer recording failed (non-fatal):", err);
    }
  }

  const recallCfg = input.searchConfig?.recall;
  let out = formatFusedResults(fused, {
    charBudget: recallCfg?.charBudget ?? DEFAULT_FORMAT_CONFIG.charBudget,
    relevanceFloor:
      recallCfg?.relevanceFloor ?? DEFAULT_FORMAT_CONFIG.relevanceFloor,
    maxResults: recallCfg?.maxResults ?? DEFAULT_FORMAT_CONFIG.maxResults,
    absoluteFloor:
      recallCfg?.absoluteFloor ?? DEFAULT_FORMAT_CONFIG.absoluteFloor,
  });

  // Surface structured tool-failure stats for debugging. Appended outside the
  // RRF scoring/budget logic so it never displaces actual search hits.
  // Skipped for `knowledge` scope (pure LTM lookups, no execution traces).
  if (input.scope !== "knowledge") {
    try {
      const section = toolTrace.formatToolFailureSection(
        input.projectPath,
        input.scope === "session" ? input.sessionID : undefined,
      );
      if (section) out += `\n\n${section}`;
    } catch (err) {
      log.warn("tool failure section failed (non-fatal):", err);
    }
  }

  return out;
}

/** Standard tool description reused verbatim by each host adapter. */
export const RECALL_TOOL_DESCRIPTION =
  "Search your persistent memory for this project. Your visible context is a trimmed window — older messages, decisions, and details may not be visible to you even within the current session. Use this tool whenever you need information that isn't in your current context: file paths, past decisions, user preferences, prior approaches, the people/services/tools the user works with, or anything from earlier in this conversation or previous sessions. Always prefer recall over assuming you don't have the information. When the user refers to a project, repository, person, service, or tool by name — especially one not already visible in your context — call recall to resolve it before searching the filesystem or assuming you must explore. Searches long-term knowledge, known entities (people, orgs, services, tools — with their aliases and relationships), distilled history, and raw message archives. When your context has been compressed, the distilled summaries are lossy — specific details (exact error messages, rejected alternatives, file paths, numerical values) are likely omitted, so use recall to verify any specific claim before answering questions about what happened, what was considered, or what the exact values were." +
  '\n\nYour context contains references in the format (prefix:id) — e.g. (d:abc123) for distillations, (t:abc123) for messages. These appear in distillation headers, tool result placeholders, and truncated recall results. Pass any such ID to this tool\'s `id` parameter to retrieve the full original content. Distillations marked "lossy" have lost specific details — use the ID to drill down.' +
  '\n\nNever write recall status text (like "📚 Searching…" or "📚 Fetching…") yourself — these are injected by the system automatically when you use this tool.';

/** Standard parameter descriptions reused by each host adapter. */
export const RECALL_PARAM_DESCRIPTIONS = {
  query:
    "What to search for — be specific. Include keywords, file names, or concepts.",
  scope:
    "Search scope: 'all' (default) searches everything, 'session' searches current session only, 'project' searches all sessions in this project, 'knowledge' searches only long-term knowledge.",
  id: "Fetch full content of a specific result by its source-prefixed ID (e.g. 'k:abc123', 'd:abc123', 't:abc123', 'e:abc123' for an entity). These IDs appear throughout your context: in distillation headers, tool result placeholders, and truncated recall results. When id is provided, query is ignored.",
};
