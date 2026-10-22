/**
 * Recall — unified search across Lore's memory sources.
 *
 * Pure search + result-formatting logic shared by every host's recall tool.
 * Harness adapters register the canonical contract and use the shared
 * `executeRecallTool()` executor from `recall-tool.ts`:
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
import { currentTenantId } from "./tenant";
import * as toolTrace from "./tool-trace";
import * as log from "./log";
import { createHash, randomUUID } from "node:crypto";
import {
  db,
  ensureProject,
  projectId as getProjectId,
  projectName,
} from "./db";
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
  assertValidRecallQuery,
  isRecallDetailRef,
  isValidRecallId,
  isValidRecallQuery,
  MAX_RECALL_ID_CHARS,
} from "./recall-limits";
import {
  offloadAll,
  offloadAllOrTimeout,
  isReadJobFailure,
} from "./read-offload";
import { inline } from "./markdown";

export {
  isRecallDetailRef,
  isValidRecallId,
  MAX_RECALL_ID_CHARS,
} from "./recall-limits";

function reportRecallDiagnostic(
  message: string,
  level: "info" | "warn" | "error" = "info",
): void {
  try {
    if (level === "error") log.error(message);
    else if (level === "warn") log.warn(message);
    else log.info(message);
  } catch {
    // Diagnostics are best-effort and must never affect recall delivery.
  }
}

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
  /** Fetch several source details in one bounded invocation. Mutually exclusive with `id`. */
  ids?: string[];
  /** Unicode code-point offset into an `id` detail (SQLite `substr` units). */
  detailOffset?: number;
  /** Maximum detail Unicode code points to return for an `id` detail. */
  detailLimit?: number;
  /** Project root — used by all scoring paths. */
  projectPath: string;
  /** Current session ID — required when `scope === "session"`. */
  sessionID?: string;
  /** Whether to include long-term knowledge results. Default `true`. */
  knowledgeEnabled?: boolean;
  /** Add opaque, request-session-bound handles for truncated agent-tool results. */
  detailRefs?: boolean;
  /** Optional LLM client for query expansion (if `config.search.queryExpansion`). */
  llm?: LLMClient;
  /** Abort in-flight query expansion when the owning client disconnects. */
  signal?: AbortSignal;
  /** Search config — provides recallLimit, queryExpansion, ftsWeights, etc. */
  searchConfig?: LoreConfig["search"];
  /**
   * Record cross-project knowledge transfer metrics (issue #506) for
   * foreign/promoted entries that survive fusion. Set true ONLY for genuine
   * agent recall (executeRecall); left false for dashboard/CLI searches so they
   * don't inflate counts. Default false.
   */
  recordTransfers?: boolean;
  /**
   * Defer transfer-counter writes until the caller commits a larger persistence
   * unit. When omitted, transfers retain their existing immediate-write
   * behavior. The callback is synchronous so callers can run it inside their
   * own SQLite savepoint.
   */
  deferTransferRecording?: (record: () => void) => void;
  /**
   * Set of knowledge entry IDs (`019fxxxx-...` UUIDs — the canonical form
   * without the `k:` prefix) that are already present in the model's visible
   * context — the stable system[1] knowledge catalog and/or the durable
   * prompt-delta pair appended by the pipeline.
   *
   * When set, `runRecall` appends a hint to the result footer telling the
   * model how many returned hits were already in its context, so a recall
   * query whose hits are entirely redundant doesn't trick the model into
   * thinking it has new information (silent agent loop exit).
   *
   * Only knowledge entries are tracked — distillations/temporal/entities have
   * their own IDs but the loop-exit failure mode is knowledge-specific (the
   * LTM block is the dominant in-context source). Pass undefined to skip the
   * dedup pass (dashboard/CLI/recallById callers don't need it).
   */
  alreadyInLtmIds?: ReadonlySet<string>;
};

/** Result of a full recall run — markdown-formatted string for the LLM. */
export type RecallResult = string;

/** Private source coverage returned alongside rendered recall output. */
export type RecallCoverage = {
  /** Canonical source identity; aliases resolve to the same value. */
  identity: string;
  /** Content revision fingerprint. This never appears in rendered tool output. */
  revision: string;
  /** Delivered source-content range, measured in Unicode code points. */
  offset: number;
  length: number;
  complete: boolean;
  /** Search previews and detail/range reads are distinct delivered coverage. */
  kind?: "preview" | "detail";
};

/** Rendered tool result plus private coverage used by gateway recall policy. */
export type RecallRun = {
  result: RecallResult;
  coverage: RecallCoverage[];
};

type RecallDetailRef = {
  sourceId: string;
  tenantId: string;
  projectId: string;
  scope: RecallScope;
  sessionID?: string;
  expiresAt: number;
};

// This bounded, process-local map is the only bridge from opaque detail refs
// to source IDs; refs never serialize the underlying ID or cross scope.
const MAX_RECALL_DETAIL_REFS = 512;
const RECALL_DETAIL_REF_TTL_MS = 30 * 60 * 1000;
const recallDetailRefs = new Map<string, RecallDetailRef>();

/** Keep one tool call bounded while allowing known source details to be batched. */
export const MAX_RECALL_BATCH_IDS = 8;
/** Bound untrusted tool IDs before they are interpolated into a result. */
export const DEFAULT_RECALL_DETAIL_CHARS = 12_000;
export const MAX_RECALL_DETAIL_CHARS = 16_000;
export const MAX_RECALL_BATCH_CHARS = 32_000;
/** Keep entity drill-down metadata useful without allowing unbounded fan-out. */
const MAX_RECALL_ENTITY_ALIASES = 8;
const MAX_RECALL_ENTITY_RELATIONS = 8;
const MAX_RECALL_ENTITY_LABEL_CHARS = 256;

export {
  assertValidRecallQuery,
  isValidRecallQuery,
  MAX_RECALL_QUERY_CHARS,
} from "./recall-limits";

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

/** RRF weight of the supplemental fuzzy-title knowledge list (#1978) —
 *  strictly below every exact/semantic list weight. */
const FUZZY_RECALL_WEIGHT = 0.5;

/** Max knowledge rows whose ONLY evidence is the fuzzy title leg (#1978). */
const MAX_FUZZY_RECALL = 2;

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

/** Private, stable coverage for a rendered search preview. */
function previewCoverage(tagged: TaggedResult): RecallCoverage {
  let identity = taggedResultKey(tagged);
  let revisionSource = "";
  switch (tagged.source) {
    case "knowledge":
    case "cross-knowledge":
      identity = `k:${tagged.item.logical_id}`;
      // Must match sourceCoverage() exactly: a preview and a later detail of
      // the same source are distinct coverage but one delivered item.
      revisionSource = `${tagged.item.id}:${tagged.item.updated_at}`;
      break;
    case "distillation":
      revisionSource = `${tagged.item.id}:${tagged.item.created_at}`;
      break;
    case "temporal":
      revisionSource = `${tagged.item.id}:${tagged.item.created_at}`;
      break;
    case "lat-section":
      revisionSource = tagged.item.content_hash;
      break;
    case "entity":
      revisionSource = `${tagged.item.id}:${tagged.item.updated_at}`;
      break;
  }
  return {
    identity,
    revision: createHash("sha256").update(revisionSource).digest("hex"),
    offset: 0,
    // A preview is a separate coverage mode, not a fake full-content range.
    length: 1,
    complete: false,
    kind: "preview",
  };
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
        if (isReadJobFailure(rows)) return null;
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

type FormatConfig = Omit<typeof DEFAULT_FORMAT_CONFIG, "alreadyInLtmIds"> & {
  // Optional, see RecallInput.alreadyInLtmIds — when set, formatFusedResults
  // counts hits already in the model's LTM context and appends a hint line so
  // the model doesn't treat redundant recall as new information.
  alreadyInLtmIds?: ReadonlySet<string>;
  /** Private resolver; rendered handles never contain the underlying source ID. */
  createDetailRef?: (tagged: TaggedResult) => string;
};

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

type FormattedRecallResults = {
  result: string;
  /** The exact sources rendered into `result`, excluding score-pruned hits. */
  shown: ScoredTaggedResult[];
};

function formatFusedResults(
  results: ScoredTaggedResult[],
  config: FormatConfig,
): FormattedRecallResults {
  if (!results.length) {
    return { result: "No results found for this query.", shown: [] };
  }

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

  if (!kept.length) {
    return { result: "No results found for this query.", shown: [] };
  }

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

  // Batch-load the resolved code anchors (file:line / symbol) for every knowledge
  // hit ONCE, so recall can point the agent straight at the code instead of
  // making it grep (Modem "how coding agents read your code"). One query for the
  // whole result set; entries with no resolved anchors are simply absent.
  const knowledgeLogicalIds: string[] = [];
  for (const r of tiered) {
    if (r.item.source === "knowledge" || r.item.source === "cross-knowledge")
      knowledgeLogicalIds.push(r.item.item.logical_id);
  }
  const anchorsByLogicalId =
    knowledgeLogicalIds.length > 0
      ? ltm.knowledgeRefAnchors(knowledgeLogicalIds)
      : undefined;
  // D2c PR-2: file-path associations share the same batch load shape as
  // anchors. Batch-loaded once for the whole result set so per-line rendering
  // is O(1) lookup, and entries with no associations are simply absent.
  const filesByLogicalId =
    knowledgeLogicalIds.length > 0
      ? ltm.knowledgeFileRefsBatch(knowledgeLogicalIds)
      : undefined;

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

      const detailRef = isResultContentTruncated(
        r.item,
        r.charBudget,
        anchorsByLogicalId,
        filesByLogicalId,
      )
        ? config.createDetailRef?.(r.item)
        : undefined;
      const detailRefCost = detailRef
        ? ` [detail ref: \`${detailRef}\`]`.length
        : 0;
      const line = renderResultLine(
        r.item,
        Math.max(0, r.charBudget - detailRefCost),
        anchorsByLogicalId,
        filesByLogicalId,
        detailRef,
      );
      lines.push(line);
    }
  }

  // Footer
  const anyTruncated = tiered.some((r) =>
    isResultContentTruncated(
      r.item,
      r.charBudget,
      anchorsByLogicalId,
      filesByLogicalId,
    ),
  );
  lines.push(``);
  lines.push(`---`);
  if (anyTruncated) {
    lines.push(
      config.createDetailRef
        ? `*${kept.length} of ${totalFound} results shown. Use the opaque \`r:\` detail ref printed after a truncated result to inspect its detail.*`
        : `*${kept.length} of ${totalFound} results shown; some result details are truncated.*`,
    );
  } else {
    lines.push(`*${kept.length} of ${totalFound} results shown.*`);
  }

  // LTM-overlap hint — only counts knowledge entries (the dominant in-context
  // LTM source via system[1] catalog + prompt-delta pair). Surfaces the count
  // when any kept hit is already in the model's visible context so it doesn't
  // treat redundant recall as new information and emit a silent 3-token stop.
  // Skipped entirely when no `alreadyInLtmIds` was passed (dashboard/CLI/drill-
  // down callers don't have LTM in context) or when no knowledge hits overlap.
  if (config.alreadyInLtmIds && config.alreadyInLtmIds.size > 0) {
    const knowledgeKeptCount = tiered.reduce((n, r) => {
      if (r.item.source !== "knowledge" && r.item.source !== "cross-knowledge")
        return n;
      return n + 1;
    }, 0);
    const inLtmCount = tiered.reduce((n, r) => {
      if (r.item.source !== "knowledge" && r.item.source !== "cross-knowledge")
        return n;
      return config.alreadyInLtmIds!.has(r.item.item.id) ? n + 1 : n;
    }, 0);
    if (inLtmCount > 0) {
      // Compare knowledge-vs-knowledge, not knowledge-vs-total — a recall
      // returning 3 knowledge + 2 distillation should emit "All 3 knowledge
      // entries are already in LTM", not "3 of 5 entries are already…"
      // (Seer 15623149/0).
      if (inLtmCount === knowledgeKeptCount) {
        lines.push(
          ``,
          `> All ${inLtmCount} shown knowledge entries are already in your LTM context (system catalog or knowledge delta). No new information — consider whether recall is actually needed for this query.`,
        );
      } else {
        // Seer 15623354/0: denominator must also be knowledge-only, matching
        // the full-overlap case. Otherwise "2 of 5" looks like a small slice
        // when in fact 2 of 2 knowledge entries are already in LTM.
        lines.push(
          ``,
          `> ${inLtmCount} of ${knowledgeKeptCount} shown knowledge entries are already in your LTM context. Only the non-overlapping entries are new — re-call with \`id\` for full content of those.`,
        );
      }
    }
  }

  return { result: lines.join("\n"), shown: kept };
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

/** Render a single result as a markdown list item line. */
/** Render an entry's resolved code anchors as a compact ` \u21b3 a, b` suffix the
 *  agent can jump to instead of grepping. Empty/absent → "". Symbol anchors get a
 *  trailing `()` so they read as identifiers. */
function renderAnchors(anchors?: ltm.KnowledgeRefAnchor[]): string {
  if (!anchors || anchors.length === 0) return "";
  const parts = anchors.map((a) =>
    a.kind === "symbol" ? `${a.anchor}()` : a.anchor,
  );
  return ` \u21b3 ${parts.join(", ")}`;
}

/** Render an entry's file-path associations as a `↳ files: a, b, c` suffix
 *  (D2c PR-2). Parallel to renderAnchors: empty/absent → "". Up to
 *  MAX_RECALL_FILES_PER_ENTRY (already enforced by the batch reader) paths.
 *  Sorted deterministically by the writer, so output is stable. */
function renderFiles(paths?: string[]): string {
  if (!paths || paths.length === 0) return "";
  return ` \u21b3 files: ${paths.join(", ")}`;
}

function isResultContentTruncated(
  tagged: TaggedResult,
  charBudget: number,
  anchorsByLogicalId?: Map<string, ltm.KnowledgeRefAnchor[]>,
  filesByLogicalId?: Map<string, string[]>,
): boolean {
  let content: string;
  let contentBudget: number;

  switch (tagged.source) {
    case "knowledge": {
      const k = tagged.item;
      const titlePart = `**${inline(k.title)}** (${relativeAge(k.updated_at)}${k.match === "fuzzy" ? ", approximate" : ""}): `;
      const anchors = renderAnchors(anchorsByLogicalId?.get(k.logical_id));
      const files = renderFiles(filesByLogicalId?.get(k.logical_id));
      content = inline(k.content);
      contentBudget = Math.max(
        40,
        charBudget - titlePart.length - anchors.length - files.length,
      );
      break;
    }
    case "cross-knowledge": {
      const k = tagged.item;
      const titlePart = `**${inline(k.title)}** (${relativeAge(k.updated_at)}, from: ${tagged.projectLabel}): `;
      const anchors = renderAnchors(anchorsByLogicalId?.get(k.logical_id));
      const files = renderFiles(filesByLogicalId?.get(k.logical_id));
      content = inline(k.content);
      contentBudget = Math.max(
        40,
        charBudget - titlePart.length - anchors.length - files.length,
      );
      break;
    }
    case "distillation":
      content = inline(tagged.item.observations);
      contentBudget = charBudget;
      break;
    case "temporal": {
      const prefix = `(${tagged.item.role}, ${relativeAge(tagged.item.created_at)}) `;
      content = inline(tagged.item.content);
      contentBudget = Math.max(40, charBudget - prefix.length);
      break;
    }
    case "lat-section": {
      const heading = `**${inline(tagged.item.file)} \u00A7 ${inline(tagged.item.heading)}**: `;
      content = inline(tagged.item.first_paragraph || tagged.item.content);
      contentBudget = Math.max(40, charBudget - heading.length);
      break;
    }
    case "entity": {
      const typeLabel =
        tagged.item.entity_type === "self"
          ? "person, you"
          : tagged.item.entity_type;
      const head = `**${inline(tagged.item.canonical_name)}** (${typeLabel})`;
      const { aliasesText, metaText, relationsText } = entitySummaryParts(
        tagged.item,
      );
      const detailFull = [aliasesText, metaText, relationsText]
        .filter(Boolean)
        .join(" \u2014 ");
      content = inline(detailFull);
      contentBudget = Math.max(40, charBudget - head.length - 2);
      break;
    }
  }

  return truncateAtSentence(content, contentBudget) !== content;
}

function renderResultLine(
  tagged: TaggedResult,
  charBudget: number,
  anchorsByLogicalId?: Map<string, ltm.KnowledgeRefAnchor[]>,
  filesByLogicalId?: Map<string, string[]>,
  detailRef?: string,
): string {
  const detailRefSuffix = detailRef ? ` [detail ref: \`${detailRef}\`]` : "";
  switch (tagged.source) {
    case "knowledge": {
      const k = tagged.item;
      const age = relativeAge(k.updated_at);
      const titlePart = `**${inline(k.title)}** (${age}${k.match === "fuzzy" ? ", approximate" : ""}): `;
      const anchors = renderAnchors(anchorsByLogicalId?.get(k.logical_id));
      const files = renderFiles(filesByLogicalId?.get(k.logical_id));
      const contentBudget = Math.max(
        40,
        charBudget - titlePart.length - anchors.length - files.length,
      );
      const content = truncateAtSentence(inline(k.content), contentBudget);
      return `- ${titlePart}${content}${anchors}${files}${detailRefSuffix}`;
    }
    case "cross-knowledge": {
      const k = tagged.item;
      const age = relativeAge(k.updated_at);
      const titlePart = `**${inline(k.title)}** (${age}, from: ${tagged.projectLabel}): `;
      const anchors = renderAnchors(anchorsByLogicalId?.get(k.logical_id));
      const files = renderFiles(filesByLogicalId?.get(k.logical_id));
      const contentBudget = Math.max(
        40,
        charBudget - titlePart.length - anchors.length - files.length,
      );
      const content = truncateAtSentence(inline(k.content), contentBudget);
      return `- ${titlePart}${content}${anchors}${files}${detailRefSuffix}`;
    }
    case "distillation": {
      const d = tagged.item;
      // Compression hint: signal when the distillation is lossy so the model
      // knows to drill into source messages for exact details.
      const compressionHint =
        d.r_compression != null && d.r_compression < 1.0 ? "[lossy] " : "";
      const fullText = inline(d.observations);
      const content = truncateAtSentence(fullText, charBudget);
      return `- ${compressionHint}${content}${detailRefSuffix}`;
    }
    case "temporal": {
      const m = tagged.item;
      const prefix = `(${m.role}, ${relativeAge(m.created_at)}) `;
      const contentBudget = Math.max(40, charBudget - prefix.length);
      const fullText = inline(m.content);
      const content = truncateAtSentence(fullText, contentBudget);
      return `- ${prefix}${content}${detailRefSuffix}`;
    }
    case "lat-section": {
      const s = tagged.item;
      const heading = `**${inline(s.file)} \u00A7 ${inline(s.heading)}**: `;
      const contentBudget = Math.max(40, charBudget - heading.length);
      const fullText = s.first_paragraph
        ? inline(s.first_paragraph)
        : inline(s.content);
      const content = truncateAtSentence(fullText, contentBudget);
      return `- ${heading}${content}${detailRefSuffix}`;
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
      return `- ${head}${detail ? `: ${detail}` : ""}${detailRefSuffix}`;
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
  validateRecallScope(input);
  input.signal?.throwIfAborted();
  assertValidRecallQuery(input.query);
  const abortable = async <T>(promise: Promise<T>): Promise<T> => {
    const signal = input.signal;
    if (!signal) return promise;
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      void promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  };
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
      const expandedQueries = await abortable(
        timer.await(
          expandQuery(llm, query, undefined, sessionID, input.signal),
        ),
      );
      queries = [
        query,
        ...expandedQueries.filter(
          (expanded) => expanded !== query && isValidRecallQuery(expanded),
        ),
      ];
      input.signal?.throwIfAborted();
    } catch {
      if (input.signal?.aborted) throw input.signal.reason;
      reportRecallDiagnostic("recall: query expansion failed, using original");
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
        if (isValidRecallQuery(alias) && !queries.includes(alias)) {
          queries.push(alias);
        }
      }
    }
  } catch {
    reportRecallDiagnostic("recall: entity query expansion failed (non-fatal)");
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

  // Ids the exact knowledge legs already produced — the fuzzy title leg
  // (#1978) ranks only ids NOT seen here, so a fuzzy row can never duplicate
  // or outrank an exact/vector hit for the same entry.
  const knowledgeSeen = new Set<string>();
  let originalQuerySeen = false;

  // Track where primary (first-query) lists end so the MAX_RRF_LISTS cap
  // trims expanded-query lists first, preserving vector/supplemental lists.
  let primaryListEnd = 0;

  for (const q of queries) {
    input.signal?.throwIfAborted();
    const knowledgeResults: ltm.ScoredKnowledgeEntry[] = [];
    if (knowledgeEnabled && scope !== "session") {
      try {
        input.signal?.throwIfAborted();
        knowledgeResults.push(
          ...(await abortable(
            ltm.searchScored({
              query: q,
              projectPath,
              limit,
              termWeights: idfWeights,
            }),
          )),
        );
      } catch {
        if (input.signal?.aborted) throw input.signal.reason;
        reportRecallDiagnostic("recall: knowledge search failed", "error");
      }
    }

    const distillationResults: ScoredDistillation[] = [];
    if (scope !== "knowledge") {
      try {
        input.signal?.throwIfAborted();
        distillationResults.push(
          ...(await abortable(
            searchDistillationsScored({
              projectPath,
              query: q,
              sessionID: scope === "session" ? sessionID : undefined,
              limit,
              termWeights: idfWeights,
            }),
          )),
        );
      } catch {
        if (input.signal?.aborted) throw input.signal.reason;
        reportRecallDiagnostic("recall: distillation search failed", "error");
      }
    }

    const temporalResults: temporal.ScoredTemporalMessage[] = [];
    if (scope !== "knowledge") {
      try {
        input.signal?.throwIfAborted();
        temporalResults.push(
          ...(await abortable(
            temporal.searchScored({
              projectPath,
              query: q,
              sessionID: scope === "session" ? sessionID : undefined,
              limit,
              termWeights: idfWeights,
            }),
          )),
        );
      } catch {
        if (input.signal?.aborted) throw input.signal.reason;
        reportRecallDiagnostic("recall: temporal search failed", "error");
      }
    }

    if (temporalResults.length > 0 || distillationResults.length > 0) {
      hasSessionResults = true;
    }

    if (!originalQuerySeen) {
      for (const r of knowledgeResults) knowledgeSeen.add(r.id);
      originalQuerySeen = true;
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
      const [queryVec] = await abortable(
        timer.await(embedding.embed([query], "query"), "embed"),
      );

      // Knowledge vector search
      if (knowledgeEnabled) {
        // vectorSearch is NOT project-scoped, so apply the same visibility
        // predicate the FTS knowledge search uses — otherwise a semantic match
        // could leak another project's project-scoped (cross_project = 0)
        // knowledge into this project's recall. Cross-project DISCOVERY of other
        // projects' knowledge stays FTS-only (searchScoredOtherProjects); the
        // vector path mirrors the main, project-scoped search. Mirrors the
        // entity-vector visibility filter below.
        const knowledgePid = ensureProject(projectPath);
        const vectorHits = await abortable(
          timer.await(embedding.vectorSearch(queryVec, limit), "vectorSearch"),
        );
        // Batch-hydrate hits off-thread (#966) instead of N per-hit ltm.get().
        const entryMap = await abortable(
          timer.await(ltm.getManyOffloaded(vectorHits.map((h) => h.id))),
        );
        const vectorTagged: TaggedResult[] = [];
        for (const hit of vectorHits) {
          input.signal?.throwIfAborted();
          const entry = entryMap.get(hit.id);
          if (entry) {
            const visible =
              entry.project_id === knowledgePid ||
              entry.project_id === null ||
              entry.cross_project === 1;
            if (!visible) continue;
            vectorTagged.push({
              source: "knowledge",
              item: { ...entry, rank: -hit.similarity },
            });
          }
        }
        for (const tagged of vectorTagged) knowledgeSeen.add(tagged.item.id);
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
        const distillationPid = ensureProject(projectPath);
        const distVectorHits = await abortable(
          timer.await(
            embedding.vectorSearchDistillations(
              queryVec,
              limit,
              undefined,
              undefined,
              distillationPid,
            ),
            "vectorSearch",
          ),
        );
        // Batch-hydrate hits off-thread (#966) instead of N per-hit point reads.
        const distMap = await abortable(
          timer.await(
            hydrateVectorRows<Distillation & { project_id: string }>(
              distVectorHits,
              "SELECT id, project_id, observations, generation, created_at, session_id, c_norm, r_compression FROM distillations WHERE id IN",
            ),
          ),
        );
        const distVectorTagged: TaggedResult[] = distVectorHits
          .map((hit): TaggedResult | null => {
            const row = distMap.get(hit.id);
            // Recheck tenant/project ownership after hydration; vector hit
            // visibility is not sufficient authorization to return a row.
            if (!row || row.project_id !== distillationPid) return null;
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
        const temporalVectorHits = await abortable(
          timer.await(
            embedding.vectorSearchTemporal(queryVec, pid, limit),
            "vectorSearch",
          ),
        );
        // Batch-hydrate hits off-thread (#966) instead of N per-hit point reads.
        const temporalMap = await abortable(
          timer.await(
            hydrateVectorRows<temporal.TemporalMessage>(
              temporalVectorHits,
              "SELECT id, project_id, session_id, role, content, tokens, distilled, created_at, metadata FROM temporal_messages WHERE id IN",
            ),
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
        const entityVectorHits = await abortable(
          timer.await(
            embedding.vectorSearchEntities(queryVec, limit),
            "vectorSearch",
          ),
        );
        // Batch-hydrate hits off-thread (#966) instead of N per-hit
        // getWithAliases() calls (entity row + alias load each).
        const entMap = await abortable(
          timer.await(
            entities.getManyWithAliasesOffloaded(
              entityVectorHits.map((h) => h.id),
            ),
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
    } catch {
      if (input.signal?.aborted) throw input.signal.reason;
      reportRecallDiagnostic("recall: vector search failed");
    }
  }

  // Fuzzy title leg (#1978): a low-weight supplemental list that rescues
  // typo'd queries when the exact FTS + vector legs underfill `limit`.
  if (
    knowledgeEnabled &&
    scope !== "session" &&
    (searchConfig?.fuzzyRecall ?? true) &&
    knowledgeSeen.size < limit
  ) {
    try {
      input.signal?.throwIfAborted();
      const fuzzyHits = await abortable(
        timer.await(
          ltm.fuzzyTitleCandidates({
            query,
            projectPath,
            excludeIds: knowledgeSeen,
            limit: limit - knowledgeSeen.size,
          }),
          "fuzzyRecall",
        ),
      );
      if (fuzzyHits.length) {
        allRrfLists.push({
          items: fuzzyHits.map((item) => ({
            source: "knowledge" as const,
            item,
          })),
          key: (r) => `k:${r.item.id}`,
          weight: FUZZY_RECALL_WEIGHT,
        });
      }
    } catch {
      if (input.signal?.aborted) throw input.signal.reason;
      reportRecallDiagnostic("recall: fuzzy knowledge search failed", "error");
    }
  }

  // lat.md section search
  if (scope !== "session" && latReader.hasLatDir(projectPath)) {
    input.signal?.throwIfAborted();
    try {
      const latResults = await abortable(
        latReader.searchScored({
          query,
          projectPath,
          limit,
          termWeights: idfWeights,
        }),
      );
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
    } catch {
      if (input.signal?.aborted) throw input.signal.reason;
      reportRecallDiagnostic("recall: lat.md section search failed");
    }
  }

  // Cross-project knowledge discovery — only in "all" scope.
  if (knowledgeEnabled && scope === "all") {
    input.signal?.throwIfAborted();
    try {
      const crossProjectResults = await abortable(
        ltm.searchScoredOtherProjects({
          query,
          excludeProjectPath: projectPath,
          limit,
          termWeights: idfWeights,
        }),
      );
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
            };
          }),
          key: (r) => `xk:${r.item.id}`,
        });
      }
    } catch {
      if (input.signal?.aborted) throw input.signal.reason;
      reportRecallDiagnostic("recall: cross-project knowledge search failed");
    }
  }

  // Entity search — surface matching people/orgs/services/tools (with their
  // aliases + relations) as first-class results. Identity questions ("who is
  // Seylan?", "what's our CI?") are answered directly instead of only via the
  // alias query-expansion above. Cross-session/cross-project, so excluded from
  // "session" and "knowledge" scopes.
  if (scope === "all" || scope === "project") {
    input.signal?.throwIfAborted();
    try {
      const entityResults = await abortable(
        timer.await(entities.searchAsync({ query, projectPath, limit })),
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
    } catch {
      if (input.signal?.aborted) throw input.signal.reason;
      reportRecallDiagnostic("recall: entity search failed (non-fatal)");
    }
  }

  // Cross-project repository discovery — only in "all" scope. `repo` entities
  // are project-scoped (cross_project = 0) and deliberately excluded from the
  // entity visibility predicate above (FTS) and at recall.ts vector block, so a
  // repo owned by another project — one the user references by name while
  // working elsewhere — is otherwise unreachable. Surface those here. Same
  // `e:` key as the entity list so RRF merges them. `infra` stays excluded.
  if (scope === "all") {
    input.signal?.throwIfAborted();
    try {
      const crossRepos = await abortable(
        timer.await(
          entities.searchCrossProjectReposAsync({
            query,
            excludeProjectPath: projectPath,
            limit,
          }),
        ),
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
    } catch {
      if (input.signal?.aborted) throw input.signal.reason;
      reportRecallDiagnostic(
        "recall: cross-project repo search failed (non-fatal)",
      );
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
    input.signal?.throwIfAborted();
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
          // Skip the knowledge fan-in (and its refs query) when this recall
          // won't surface knowledge anyway (F4, #1048).
          includeKnowledge: knowledgeEnabled,
        });
        const graphWeight = searchConfig?.graphBoostWeight ?? 1.0;
        const gpid = ensureProject(projectPath);

        // (a) Graph-linked knowledge, ordered by graph score (depth-decay ×
        // local reach). Batch-hydrated by logical_id on the read-worker pool
        // (#1048) — refs store logical_ids, and this replaces N synchronous
        // getByLogical() calls on the hot path, mirroring the neighbor-entity
        // offload below and the #966 read path. Visibility-filtered to mirror
        // ltm.searchScored — a knowledge entry linked to a shared entity may
        // belong to another project. Same `k:` key as the BM25/vector knowledge
        // lists so RRF merges, not duplicates. The list is already empty when
        // knowledge is disabled (gated via includeKnowledge at graphExpand).
        if (expansion.knowledge.length) {
          const knowledgeMap = await abortable(
            timer.await(
              ltm.getManyByLogicalOffloaded(
                expansion.knowledge.map((gk) => gk.logicalId),
              ),
            ),
          );
          const graphKnowledge: TaggedResult[] = [];
          for (const gk of expansion.knowledge) {
            const entry = knowledgeMap.get(gk.logicalId);
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
          const neighborMap = await abortable(
            timer.await(
              entities.getManyWithAliasesOffloaded(
                expansion.entities.map((e) => e.id),
              ),
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
    } catch {
      if (input.signal?.aborted) throw input.signal.reason;
      reportRecallDiagnostic(
        "recall: entity-graph expansion failed (non-fatal)",
      );
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
        const d = item.item;
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

  // Fuzzy-only knowledge noise cap (#1978): keep at most MAX_FUZZY_RECALL
  // rows whose only evidence is the fuzzy title leg. An id that also appeared
  // in an exact/vector list keeps THAT list's (unflagged) item — RRF keeps the
  // first list's item per key and exact lists are pushed before the fuzzy one,
  // and fuzzyTitleCandidates never returns a seen id — so `match: "fuzzy"`
  // here means fuzzy-only.
  let fuzzyOnly = 0;
  fused = fused.filter((r) => {
    if (r.item.source === "knowledge" && r.item.item.match === "fuzzy") {
      fuzzyOnly += 1;
      return fuzzyOnly <= MAX_FUZZY_RECALL;
    }
    return true;
  });

  // Cap output: return at most 3x the per-source limit. With 7+ RRF sources
  // each contributing up to `limit` items, uncapped output can be huge (89+
  // results for broad OR fallbacks). The top-scoring items after RRF fusion
  // are the ones that appeared in multiple lists — capping preserves those
  // while dropping the long tail of single-list noise.
  const maxResults = limit * 3;
  timer.emit("recall", fused.length, scope);
  input.signal?.throwIfAborted();
  return fused.slice(0, maxResults);
}

// ---------------------------------------------------------------------------
// Recall detail — fetch a bounded, scope-checked page of a specific result
// ---------------------------------------------------------------------------

/**
 * Fetch a bounded detail page for a result inside the supplied project scope.
 *
 * IDs use the format `prefix:uuid` where prefix is one of:
 *   k: (knowledge), xk: (cross-knowledge), d: (distillation),
 *   t: (temporal), lat: (lat-section), e: (entity).
 */
export function recallById(
  id: string,
  input: RecallDetailOptions = {},
): string {
  return recallByIdWithMetadata(id, input).result;
}

type RecallDetailOptions = Partial<
  Pick<
    RecallInput,
    | "detailOffset"
    | "detailLimit"
    | "projectPath"
    | "scope"
    | "sessionID"
    | "knowledgeEnabled"
    | "detailRefs"
  >
>;

type RecallDetailContext = {
  projectId: string;
  scope: RecallScope;
  sessionID?: string;
};

function validateRecallScope(
  input: Pick<RecallDetailOptions, "scope" | "sessionID">,
): void {
  const scope = input.scope ?? "all";
  if (!["all", "session", "project", "knowledge"].includes(scope)) {
    throw new Error("Recall scope is invalid.");
  }
  if (scope === "session" && !input.sessionID?.trim()) {
    throw new Error("Recall session scope requires a session ID.");
  }
}

function recallDetailContext(
  input: RecallDetailOptions,
): RecallDetailContext | null {
  const scope = input.scope ?? "all";
  validateRecallScope(input);
  if (!input.projectPath) return null;
  // A detail lookup must only recognize an already established project; an
  // opaque handle must never create project ownership from a supplied path.
  const projectId = getProjectId(input.projectPath);
  if (!projectId) return null;
  return {
    projectId,
    scope,
    ...(input.sessionID ? { sessionID: input.sessionID } : {}),
  };
}

function detailScopeAllowsPrefix(
  prefix: string,
  context: RecallDetailContext,
  input: RecallDetailOptions,
): boolean {
  if ((prefix === "k" || prefix === "xk") && input.knowledgeEnabled === false) {
    return false;
  }
  // Keep detail access aligned with the source gates in searchRecall().
  switch (prefix) {
    case "k":
      return context.scope !== "session";
    case "xk":
      return context.scope === "all";
    case "d":
    case "t":
      return context.scope !== "knowledge";
    case "lat":
      return context.scope !== "session";
    case "e":
      return context.scope === "all" || context.scope === "project";
    default:
      return false;
  }
}

function createRecallDetailRef(
  tagged: TaggedResult,
  input: RecallInput,
): string {
  const sessionID = input.sessionID;
  const projectId = getProjectId(input.projectPath);
  // Detail handles are session-bound capabilities; never mint a reusable
  // project-only handle when a direct caller omitted session identity.
  if (!sessionID?.trim() || !projectId) return "";
  const now = Date.now();
  for (const [ref, detail] of recallDetailRefs) {
    if (detail.expiresAt <= now) recallDetailRefs.delete(ref);
  }
  while (recallDetailRefs.size >= MAX_RECALL_DETAIL_REFS) {
    const oldest = recallDetailRefs.keys().next().value;
    if (oldest === undefined) break;
    recallDetailRefs.delete(oldest);
  }

  const ref = `r:${randomUUID()}`;
  recallDetailRefs.set(ref, {
    sourceId: taggedResultKey(tagged),
    tenantId: currentTenantId(),
    projectId,
    scope: input.scope ?? "all",
    sessionID,
    expiresAt: now + RECALL_DETAIL_REF_TTL_MS,
  });
  return ref;
}

function resolveRecallDetailRef(
  ref: string,
  input: RecallDetailOptions,
): { sourceId: string; scope: RecallScope; sessionID?: string } | null {
  const detail = recallDetailRefs.get(ref);
  if (!detail) return null;
  if (detail.expiresAt <= Date.now()) {
    recallDetailRefs.delete(ref);
    return null;
  }

  const context = recallDetailContext(input);
  // Opaque handles keep the producing session boundary in every recall scope.
  if (
    !context ||
    !detail.sessionID ||
    detail.tenantId !== currentTenantId() ||
    detail.projectId !== context.projectId ||
    (input.scope !== undefined && detail.scope !== context.scope) ||
    detail.sessionID !== context.sessionID
  ) {
    return null;
  }

  const prefix = detail.sourceId.slice(0, detail.sourceId.indexOf(":"));
  const boundContext = {
    ...context,
    scope: detail.scope,
    sessionID: detail.sessionID,
  };
  return detailScopeAllowsPrefix(prefix, boundContext, input)
    ? {
        sourceId: detail.sourceId,
        scope: detail.scope,
        sessionID: detail.sessionID,
      }
    : null;
}

function knowledgeDetailVisibility(
  prefix: "k" | "xk",
  projectId: string,
): { sql: string; parameters: string[] } {
  if (prefix === "xk") {
    return {
      sql: "project_id IS NOT NULL AND project_id <> ? AND cross_project = 0",
      parameters: [projectId],
    };
  }
  return {
    sql: "(project_id = ? OR project_id IS NULL OR cross_project = 1)",
    parameters: [projectId],
  };
}

function entityDetailVisibility(
  context: RecallDetailContext,
  alias = "",
): { sql: string; parameters: Array<string | number> } {
  const column = (name: string) => (alias ? `${alias}.${name}` : name);
  return {
    sql: `(${column("project_id")} = ? OR ${column("project_id")} IS NULL OR ${column("cross_project")} = 1 OR (? = 1 AND ${column("entity_type")} = 'repo'))`,
    parameters: [context.projectId, context.scope === "all" ? 1 : 0],
  };
}

function normalizeDetailOptions(input: RecallDetailOptions): {
  offset: number;
  limit: number;
} {
  const offset = input.detailOffset ?? 0;
  const limit = input.detailLimit ?? DEFAULT_RECALL_DETAIL_CHARS;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("Recall detailOffset must be a non-negative integer");
  }
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_RECALL_DETAIL_CHARS
  ) {
    throw new Error(
      `Recall detailLimit must be an integer from 1 to ${MAX_RECALL_DETAIL_CHARS}`,
    );
  }
  return { offset, limit };
}

function sourceCoverage(
  id: string,
  input: RecallDetailOptions,
): Omit<RecallCoverage, "offset" | "length" | "complete"> | null {
  const colon = id.indexOf(":");
  if (colon < 1) return null;
  const prefix = id.slice(0, colon);
  const rawId = id.slice(colon + 1);
  const context = recallDetailContext(input);
  if (!context || !detailScopeAllowsPrefix(prefix, context, input)) return null;
  const fingerprint = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  switch (prefix) {
    case "k":
    case "xk": {
      // Coverage lookup must stay cheap: resolve a historical version to its
      // logical ID, then read only identity/revision metadata. Hydrating the
      // content happens once later, in the detail renderer.
      const visibility = knowledgeDetailVisibility(prefix, context.projectId);
      const version = db()
        .query(
          `SELECT logical_id FROM knowledge
            WHERE tenant_id = ? AND id = ? AND ${visibility.sql}`,
        )
        .get(currentTenantId(), rawId, ...visibility.parameters) as {
        logical_id: string;
      } | null;
      const logicalId = version?.logical_id ?? rawId;
      const entry = db()
        .query(
          `SELECT id, logical_id, updated_at
             FROM knowledge_current
            WHERE tenant_id = ? AND logical_id = ? AND ${visibility.sql}`,
        )
        .get(currentTenantId(), logicalId, ...visibility.parameters) as {
        id: string;
        logical_id: string;
        updated_at: number;
      } | null;
      if (!entry) return null;
      return {
        identity: `k:${entry.logical_id}`,
        revision: fingerprint(`${entry.id}:${entry.updated_at}`),
      };
    }
    case "d": {
      const sessionID = context.scope === "session" ? context.sessionID : null;
      const row = db()
        .query(
          `SELECT d.id, d.created_at
             FROM distillations d JOIN projects p ON p.id = d.project_id
            WHERE p.tenant_id = ? AND d.project_id = ? AND d.id = ?
              AND (? IS NULL OR d.session_id = ?)`,
        )
        .get(
          currentTenantId(),
          context.projectId,
          rawId,
          sessionID,
          sessionID,
        ) as {
        id: string;
        created_at: number;
      } | null;
      return row
        ? {
            identity: `d:${row.id}`,
            revision: fingerprint(`${row.id}:${row.created_at}`),
          }
        : null;
    }
    case "t": {
      const sessionID = context.scope === "session" ? context.sessionID : null;
      const row = db()
        .query(
          `SELECT t.id, t.created_at
             FROM temporal_messages t JOIN projects p ON p.id = t.project_id
            WHERE p.tenant_id = ? AND t.project_id = ? AND t.id = ?
              AND (? IS NULL OR t.session_id = ?)`,
        )
        .get(
          currentTenantId(),
          context.projectId,
          rawId,
          sessionID,
          sessionID,
        ) as {
        id: string;
        created_at: number;
      } | null;
      return row
        ? {
            identity: `t:${row.id}`,
            revision: fingerprint(`${row.id}:${row.created_at}`),
          }
        : null;
    }
    case "lat": {
      const row = db()
        .query(
          `SELECT l.id, l.content_hash
             FROM lat_sections l JOIN projects p ON p.id = l.project_id
            WHERE p.tenant_id = ? AND l.project_id = ? AND l.id = ?`,
        )
        .get(currentTenantId(), context.projectId, rawId) as {
        id: string;
        content_hash: string;
      } | null;
      return row
        ? { identity: `lat:${row.id}`, revision: fingerprint(row.content_hash) }
        : null;
    }
    case "e": {
      const visibility = entityDetailVisibility(context);
      const entity = db()
        .query(
          `SELECT e.id, e.updated_at FROM entities e
            WHERE e.tenant_id = ? AND e.id = ? AND ${visibility.sql}`,
        )
        .get(currentTenantId(), rawId, ...visibility.parameters) as {
        id: string;
        updated_at: number;
      } | null;
      return entity
        ? {
            identity: `e:${entity.id}`,
            revision: fingerprint(`${entity.id}:${entity.updated_at}`),
          }
        : null;
    }
    default:
      return null;
  }
}

function detailPage(
  coverage: Omit<RecallCoverage, "offset" | "length" | "complete">,
  header: string,
  content: string,
  totalLength: number,
  offset: number,
  /** Small source metadata rendered beside the page, excluded from coverage. */
  afterContent = "",
): RecallRun {
  const start = Math.min(offset, totalLength);
  // SQLite `length()` and `substr()` index Unicode code points, while
  // JavaScript's string.length counts UTF-16 code units. Keep the cursor and
  // coverage in SQLite's units so an astral symbol cannot skip later content.
  const length = Math.min(codePointLength(content), totalLength - start);
  const end = start + length;
  const complete = end >= totalLength;
  const suffix = complete
    ? ""
    : `\n\n[Detail truncated after characters ${start}-${end} of ${totalLength}. Call recall again with the same id and detailOffset ${end}.]`;
  return {
    result: `${header}\n\n${inline(content)}${afterContent}${suffix}`,
    coverage: [
      {
        ...coverage,
        offset: start,
        length,
        complete,
        kind: "detail",
      },
    ],
  };
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** Fetch a bounded detail plus private source coverage for recall policy. */
export function recallByIdWithMetadata(
  id: string,
  input: RecallDetailOptions = {},
): RecallRun {
  const { offset, limit } = normalizeDetailOptions(input);
  if (!isValidRecallId(id) && !isRecallDetailRef(id)) {
    return { result: "Invalid recall id.", coverage: [] };
  }
  if (id.startsWith("r:")) {
    const detailRef = resolveRecallDetailRef(id, input);
    if (!detailRef)
      return { result: "No matching recall detail.", coverage: [] };
    // The opaque reference is only a scope-bound lookup handle; resolve it
    // privately, then run the same source visibility checks as a direct ID.
    return recallByIdWithMetadata(detailRef.sourceId, {
      ...input,
      scope: input.scope ?? detailRef.scope,
      sessionID: input.sessionID ?? detailRef.sessionID,
    });
  }
  const context = recallDetailContext(input);
  if (!context) return { result: "No matching recall detail.", coverage: [] };
  const coverage = sourceCoverage(id, input);
  if (!coverage) return { result: "No matching recall detail.", coverage: [] };

  const colon = id.indexOf(":");
  const prefix = id.slice(0, colon);
  const rawId = id.slice(colon + 1);
  switch (prefix) {
    case "k":
    case "xk": {
      const visibility = knowledgeDetailVisibility(prefix, context.projectId);
      const version = db()
        .query(
          `SELECT logical_id FROM knowledge
            WHERE tenant_id = ? AND id = ? AND ${visibility.sql}`,
        )
        .get(currentTenantId(), rawId, ...visibility.parameters) as {
        logical_id: string;
      } | null;
      const logicalId = version?.logical_id ?? rawId;
      const row = db()
        .query(
          `SELECT substr(title, 1, 256) AS title, category,
                  length(content) AS content_length,
                  substr(content, ? + 1, ?) AS content_page
             FROM knowledge_current
            WHERE tenant_id = ? AND logical_id = ? AND ${visibility.sql}`,
        )
        .get(
          offset,
          limit,
          currentTenantId(),
          logicalId,
          ...visibility.parameters,
        ) as {
        title: string;
        category: string;
        content_length: number;
        content_page: string;
      } | null;
      if (!row) return { result: "No matching recall detail.", coverage: [] };
      // Detail pages must retain the same code-navigation metadata as search
      // previews. Both helpers are bounded batch lookups (at most three of
      // each) and do not hydrate the entry body.
      const detailAnchors = renderAnchors(
        ltm.knowledgeRefAnchors([logicalId]).get(logicalId),
      );
      const detailFiles = renderFiles(
        ltm.knowledgeFileRefsBatch([logicalId]).get(logicalId),
      );
      return detailPage(
        coverage,
        `## Recall Detail\n\n#### Knowledge\n- **${inline(row.title)}** (${row.category}):`,
        row.content_page,
        row.content_length,
        offset,
        `${detailAnchors}${detailFiles}`,
      );
    }
    case "d": {
      const sessionID = context.scope === "session" ? context.sessionID : null;
      const row = db()
        .query(
          `SELECT length(d.observations) AS content_length,
                  substr(d.observations, ? + 1, ?) AS content_page
             FROM distillations d JOIN projects p ON p.id = d.project_id
            WHERE p.tenant_id = ? AND d.project_id = ? AND d.id = ?
              AND (? IS NULL OR d.session_id = ?)`,
        )
        .get(
          offset,
          limit,
          currentTenantId(),
          context.projectId,
          rawId,
          sessionID,
          sessionID,
        ) as {
        content_length: number;
        content_page: string;
      } | null;
      if (!row) return { result: "No matching recall detail.", coverage: [] };
      return detailPage(
        coverage,
        "## Recall Detail\n\n#### Distilled",
        row.content_page,
        row.content_length,
        offset,
      );
    }
    case "t": {
      const sessionID = context.scope === "session" ? context.sessionID : null;
      const row = db()
        .query(
          `SELECT t.role, substr(t.session_id, 1, 8) AS session_id,
                  t.created_at, length(t.content) AS content_length,
                  substr(t.content, ? + 1, ?) AS content_page
             FROM temporal_messages t JOIN projects p ON p.id = t.project_id
            WHERE p.tenant_id = ? AND t.project_id = ? AND t.id = ?
              AND (? IS NULL OR t.session_id = ?)`,
        )
        .get(
          offset,
          limit,
          currentTenantId(),
          context.projectId,
          rawId,
          sessionID,
          sessionID,
        ) as {
        role: string;
        session_id: string;
        created_at: number;
        content_length: number;
        content_page: string;
      } | null;
      if (!row) return { result: "No matching recall detail.", coverage: [] };
      return detailPage(
        coverage,
        `## Recall Detail\n\n#### Conversation\n(${row.role}, ${relativeAge(row.created_at)})`,
        row.content_page,
        row.content_length,
        offset,
      );
    }
    case "lat": {
      const row = db()
        .query(
          `SELECT substr(l.file, 1, 256) AS file,
                  substr(l.heading, 1, 256) AS heading,
                  length(l.content) AS content_length,
                  substr(l.content, ? + 1, ?) AS content_page
             FROM lat_sections l JOIN projects p ON p.id = l.project_id
            WHERE p.tenant_id = ? AND l.project_id = ? AND l.id = ?`,
        )
        .get(offset, limit, currentTenantId(), context.projectId, rawId) as {
        file: string;
        heading: string;
        content_length: number;
        content_page: string;
      } | null;
      if (!row) return { result: "No matching recall detail.", coverage: [] };
      return detailPage(
        coverage,
        `## Recall Detail\n\n#### Reference\n**${inline(row.file)} § ${inline(row.heading)}**`,
        row.content_page,
        row.content_length,
        offset,
      );
    }
    case "e": {
      const visibility = entityDetailVisibility(context);
      const row = db()
        .query(
          `SELECT entity_type, substr(canonical_name, 1, ?) AS canonical_name,
                  length(COALESCE(metadata, '')) AS content_length,
                  substr(COALESCE(metadata, ''), ? + 1, ?) AS content_page
             FROM entities WHERE tenant_id = ? AND id = ? AND ${visibility.sql}`,
        )
        .get(
          MAX_RECALL_ENTITY_LABEL_CHARS,
          offset,
          limit,
          currentTenantId(),
          rawId,
          ...visibility.parameters,
        ) as {
        entity_type: string;
        canonical_name: string;
        content_length: number;
        content_page: string;
      } | null;
      if (!row) return { result: "No matching recall detail.", coverage: [] };
      // Preserve the useful parts of legacy entity drill-down without calling
      // the unbounded entity hydrators: aliases and relations are independently
      // capped and all untrusted display fields are clipped in SQLite.
      const aliases = db()
        .query(
          `SELECT ea.alias_type, substr(ea.alias_value, 1, ?) AS alias_value
             FROM entity_aliases ea
             JOIN entities e ON e.id = ea.entity_id
            WHERE e.tenant_id = ? AND ea.entity_id = ?
             ORDER BY alias_type, alias_value LIMIT ?`,
        )
        .all(
          MAX_RECALL_ENTITY_LABEL_CHARS,
          currentTenantId(),
          rawId,
          MAX_RECALL_ENTITY_ALIASES,
        ) as Array<{ alias_type: string; alias_value: string }>;
      const aliasInfo = aliases
        .filter((alias) => alias.alias_value !== row.canonical_name)
        .map(
          (alias) => `${inline(alias.alias_type)}:${inline(alias.alias_value)}`,
        )
        .join(", ");
      const relationEntityAVisibility = entityDetailVisibility(context, "ea");
      const relationEntityBVisibility = entityDetailVisibility(context, "eb");
      const relations = db()
        .query(
          `SELECT r.relation,
                  substr(CASE WHEN r.entity_a = ? THEN eb.canonical_name ELSE ea.canonical_name END, 1, ?) AS other_name
             FROM entity_relations r
             JOIN entities ea ON ea.id = r.entity_a
             JOIN entities eb ON eb.id = r.entity_b
            WHERE ea.tenant_id = ? AND eb.tenant_id = ?
              AND (r.entity_a = ? OR r.entity_b = ?)
              AND ${relationEntityAVisibility.sql}
              AND ${relationEntityBVisibility.sql}
            ORDER BY r.relation, other_name LIMIT ?`,
        )
        .all(
          rawId,
          MAX_RECALL_ENTITY_LABEL_CHARS,
          currentTenantId(),
          currentTenantId(),
          rawId,
          rawId,
          ...relationEntityAVisibility.parameters,
          ...relationEntityBVisibility.parameters,
          MAX_RECALL_ENTITY_RELATIONS,
        ) as Array<{ relation: string; other_name: string }>;
      const relationInfo = relations.length
        ? `\n\nRelations: ${relations
            .map(
              (relation) =>
                `${inline(relation.relation)} of ${inline(relation.other_name)}`,
            )
            .join(", ")}`
        : "";
      return detailPage(
        coverage,
        `## Recall Detail\n\n#### People & Entities\n**${inline(row.canonical_name)}** (${row.entity_type})${aliasInfo ? ` (aliases: ${aliasInfo})` : ""}`,
        row.content_page,
        row.content_length,
        offset,
        relationInfo,
      );
    }
    default:
      return {
        result: "No matching recall detail.",
        coverage: [],
      };
  }
}

/** Full recall run retaining the legacy string API. */
export async function runRecall(input: RecallInput): Promise<RecallResult> {
  return (await runRecallWithMetadata(input)).result;
}

/**
 * Run a recall and return private source coverage beside the rendered result.
 * Coverage is intentionally available only to in-process callers such as the
 * gateway policy; it is never interpolated into tool output or telemetry.
 */
export async function runRecallWithMetadata(
  input: RecallInput,
): Promise<RecallRun> {
  validateRecallScope(input);
  input.signal?.throwIfAborted();
  assertValidRecallQuery(input.query);
  if (input.id && input.ids) {
    throw new Error("Recall id and ids cannot be used together");
  }
  if (
    input.id !== undefined &&
    !isValidRecallId(input.id) &&
    !isRecallDetailRef(input.id)
  ) {
    throw new Error(
      `Recall id must be a non-empty string no longer than ${MAX_RECALL_ID_CHARS} characters`,
    );
  }
  if (
    (input.detailOffset !== undefined || input.detailLimit !== undefined) &&
    !input.id
  ) {
    throw new Error("Recall detail ranges require exactly one id");
  }
  if (input.ids) {
    if (input.ids.length === 0 || input.ids.length > MAX_RECALL_BATCH_IDS) {
      throw new Error(
        `Recall ids must be non-empty and contain at most ${MAX_RECALL_BATCH_IDS} items`,
      );
    }
    const seenRequests = new Set<string>();
    const seenSources = new Set<string>();
    const coverage: RecallCoverage[] = [];
    const sections: string[] = [];
    const header = "## Recall Details";
    const omissionNotice =
      "Some requested details were omitted by the batch output limit; fetch them separately.";
    const omissionReserve = 2 + codePointLength(omissionNotice);
    let outputLength = codePointLength(header);
    let omitted = false;
    for (const requestedId of input.ids) {
      input.signal?.throwIfAborted();
      if (
        typeof requestedId !== "string" ||
        (!isValidRecallId(requestedId) && !isRecallDetailRef(requestedId))
      ) {
        throw new Error(
          `Recall ids must contain non-empty strings no longer than ${MAX_RECALL_ID_CHARS} characters`,
        );
      }
      if (seenRequests.has(requestedId)) continue;
      seenRequests.add(requestedId);
      if (outputLength + 2 + omissionReserve >= MAX_RECALL_BATCH_CHARS) {
        omitted = true;
        continue;
      }
      // Resolve aliases before reading/rendering content, so k:<version> and
      // k:<logical-id> do not hydrate the same source twice in one batch.
      const canonical = sourceCoverage(requestedId, input);
      if (canonical && seenSources.has(canonical.identity)) continue;
      const sectionNumber = sections.length + 1;
      const render = (detailLimit: number) => {
        const detail = recallByIdWithMetadata(requestedId, {
          ...input,
          detailLimit,
        });
        const source = detail.coverage[0];
        const outcome = source
          ? source.complete
            ? "delivered"
            : "partial — fetch the reported remaining range"
          : "unavailable";
        const section = `### Detail ${sectionNumber}\nOutcome: ${outcome}\n\n${detail.result}`;
        return { source, section };
      };
      let detailLimit = Math.min(
        DEFAULT_RECALL_DETAIL_CHARS,
        MAX_RECALL_BATCH_CHARS - outputLength - 2 - omissionReserve,
      );
      let rendered = render(detailLimit);
      const fits = (section: string) =>
        outputLength + 2 + codePointLength(section) + omissionReserve <=
        MAX_RECALL_BATCH_CHARS;
      if (!fits(rendered.section)) {
        // Measure the rendered page, not just its source-content limit: the
        // detail header and continuation note also consume response budget.
        let low = 1;
        let high = detailLimit - 1;
        let best: typeof rendered | undefined;
        while (low <= high) {
          const candidateLimit = Math.floor((low + high) / 2);
          const candidate = render(candidateLimit);
          if (fits(candidate.section)) {
            best = candidate;
            low = candidateLimit + 1;
          } else {
            high = candidateLimit - 1;
          }
        }
        if (best) rendered = best;
      }
      if (!fits(rendered.section)) {
        omitted = true;
        continue;
      }
      const { source } = rendered;
      if (source && seenSources.has(source.identity)) continue;
      if (source) {
        seenSources.add(source.identity);
        coverage.push(source);
      }
      sections.push(rendered.section);
      outputLength += 2 + codePointLength(rendered.section);
    }
    input.signal?.throwIfAborted();
    const result = [header, ...sections].join("\n\n");
    return {
      result: omitted ? `${result}\n\n${omissionNotice}` : result,
      coverage,
    };
  }
  if (input.id) {
    const detail = recallByIdWithMetadata(input.id, input);
    input.signal?.throwIfAborted();
    return detail;
  }
  return runRecallSearch(input);
}

/** Search every relevant source, fuse with RRF, and format a public result. */
async function runRecallSearch(input: RecallInput): Promise<RecallRun> {
  const fused = await searchRecall(input);

  // Record cross-project knowledge transfers (issue #506) — only for genuine
  // agent recall. id-based detail retrieval already returned above, so
  // recallById is never counted. Two fused sources qualify:
  //   - "cross-knowledge": foreign-project non-promoted entries
  //     (searchScoredOtherProjects guarantees project_id != current project).
  //   - "knowledge": promoted cross_project=1 entries whose project_id is a
  //     DIFFERENT non-null project than the current one.
  if (input.recordTransfers) {
    const recordTransfers = (): void => {
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
      } catch {
        reportRecallDiagnostic(
          "recall: transfer recording failed (non-fatal)",
          "warn",
        );
      }
    };
    if (input.deferTransferRecording) {
      input.deferTransferRecording(recordTransfers);
    } else {
      recordTransfers();
    }
  }

  const recallCfg = input.searchConfig?.recall;
  const formatted = formatFusedResults(fused, {
    charBudget: recallCfg?.charBudget ?? DEFAULT_FORMAT_CONFIG.charBudget,
    relevanceFloor:
      recallCfg?.relevanceFloor ?? DEFAULT_FORMAT_CONFIG.relevanceFloor,
    maxResults: recallCfg?.maxResults ?? DEFAULT_FORMAT_CONFIG.maxResults,
    absoluteFloor:
      recallCfg?.absoluteFloor ?? DEFAULT_FORMAT_CONFIG.absoluteFloor,
    alreadyInLtmIds: input.alreadyInLtmIds,
    ...(input.detailRefs && input.sessionID?.trim()
      ? {
          createDetailRef: (tagged: TaggedResult) =>
            createRecallDetailRef(tagged, input),
        }
      : {}),
  });
  let out = formatted.result;

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
    } catch {
      reportRecallDiagnostic("tool failure section failed (non-fatal)", "warn");
    }
  }

  return {
    result: out,
    coverage: formatted.shown.map(({ item }) => previewCoverage(item)),
  };
}

/** Standard tool description reused verbatim by each host adapter. */
export const RECALL_TOOL_DESCRIPTION =
  "Search your persistent memory for this project. Your visible context is a trimmed window — older messages, decisions, and details may not be visible to you even within the current session. Use this tool whenever you need information that isn't in your current context: file paths, past decisions, user preferences, prior approaches, the people/services/tools the user works with, or anything from earlier in this conversation or previous sessions. Always prefer recall over assuming you don't have the information. When the user refers to a project, repository, person, service, or tool by name — especially one not already visible in your context — call recall to resolve it before searching the filesystem or assuming you must explore. Searches long-term knowledge, known entities (people, orgs, services, tools — with their aliases and relationships), distilled history, and raw message archives. When your context has been compressed, the distilled summaries are lossy — specific details (exact error messages, rejected alternatives, file paths, numerical values) are likely omitted, so use recall to verify any specific claim before answering questions about what happened, what was considered, or what the exact values were. IMPORTANT — for values that live in the repository (current code, config, styles, exact line contents): memory is a POINTER, not the source of truth. A remembered value can be stale once the file changes, so use recall to find WHERE something is (the file path / file:line / symbol), then READ that file for the current value — or use git history for what it used to be. Do not answer a current-code question from memory alone when you can read the file." +
  '\n\nYour context contains references in the format (prefix:id) — e.g. (d:abc123) for distillations, (t:abc123) for messages. These appear in distillation headers and tool result placeholders. A truncated search result includes an opaque `r:` detail ref; pass it as `id` to inspect that result without exposing its source ID. Source IDs already visible in your context can also be passed to `id`, or several can be batched with `ids`. `id` and `ids` are mutually exclusive and ignore `query`. Detail output is bounded: when a result reports a remaining offset, call `id` again with `detailOffset` to retrieve the next range. Distillations marked "lossy" have lost specific details — use IDs to drill down.' +
  '\n\nNever write recall status text (like "📚 Searching…" or "📚 Fetching…") yourself — these are injected by the system automatically when you use this tool.';

/** Standard parameter descriptions reused by each host adapter. */
export const RECALL_PARAM_DESCRIPTIONS = {
  query:
    "What to search for — be specific. Include keywords, file names, or concepts.",
  scope:
    "Search scope: 'all' (default) searches everything, 'session' searches current session only, 'project' searches all sessions in this project, 'knowledge' searches only long-term knowledge.",
  id: "Fetch full content using a source-prefixed ID already visible in context or the opaque r: detail ref printed beside a truncated result. A detail ref only works in the project and session that produced it, and expires after 30 minutes or process restart. When id is provided, query is ignored.",
  ids: "Fetch details for up to 8 already-known source IDs in their listed order. Duplicate/alias sources are returned once. Mutually exclusive with id; query is ignored.",
  detailOffset:
    "For a single id detail only: the character offset reported by a truncated prior result. Starts at 0.",
  detailLimit:
    "For a single id detail only: maximum characters to return. Use the default unless a smaller range is sufficient.",
};
