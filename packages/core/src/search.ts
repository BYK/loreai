/**
 * Centralized FTS5 search utilities for Lore.
 *
 * Provides query building, stopword filtering, and (Phase 2+) score fusion.
 * All FTS5 search callers (ltm, temporal, reflect) import from here.
 */

/**
 * Curated stopword set for FTS5 queries. These are common English words that
 * match broadly and dilute search precision when used with OR semantics.
 *
 * CRITICAL: OR without stopword filtering is catastrophic — "the OR for OR and"
 * matches every document in the corpus. Stopwords MUST be filtered before
 * building OR queries.
 *
 * This list is intentionally conservative: only includes words that are
 * genuinely content-free. Domain terms like "handle", "state", "type" are
 * NOT stopwords — they carry meaning in code/technical contexts.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  // Articles & determiners
  "an",
  "the",
  "this",
  "that",
  "these",
  "those",
  "some",
  "each",
  "every",
  // Pronouns
  "he",
  "it",
  "me",
  "my",
  "we",
  "us",
  "or",
  "am",
  "they",
  "them",
  "their",
  "there",
  "here",
  "what",
  "which",
  "where",
  "when",
  "whom",
  // Common verbs (content-free)
  "is",
  "be",
  "do",
  "no",
  "so",
  "if",
  "as",
  "at",
  "by",
  "in",
  "of",
  "on",
  "to",
  "up",
  "are",
  "was",
  "has",
  "had",
  "not",
  "but",
  "can",
  "did",
  "for",
  "got",
  "let",
  "may",
  "our",
  "its",
  "nor",
  "yet",
  "how",
  "all",
  "any",
  "too",
  "own",
  "out",
  "why",
  "who",
  "few",
  "have",
  "been",
  "were",
  "will",
  "would",
  "could",
  "should",
  "does",
  "being",
  "also",
  // Prepositions & conjunctions
  "with",
  "from",
  "into",
  "about",
  "than",
  "over",
  "such",
  "after",
  "before",
  "between",
  // Adverbs (content-free)
  "just",
  "only",
  "very",
  "more",
  "most",
  "really",
  "already",
]);

/**
 * The sentinel value returned when a query contains no meaningful terms after
 * filtering. Callers should check for this and return a "query too vague"
 * message instead of executing an FTS5 MATCH against it.
 */
export const EMPTY_QUERY = '""';

/**
 * Filter raw query text into meaningful FTS5 tokens.
 *
 * Filtering (in order):
 * 1. Strip non-word chars (punctuation, operators — prevents FTS5 injection)
 * 2. Remove single-character tokens (contraction artifacts like "s", "t")
 * 3. Remove stopwords
 *
 * If ALL words are filtered, returns an empty array. The caller decides
 * what to do (typically returns a "query too vague" message).
 *
 * No general length filter — short but meaningful tokens like "DB", "CI",
 * "IO", "PR" are preserved. Only single chars are dropped.
 *
 * Tokenization is Unicode-aware: the strip class keeps any Unicode letter
 * (\p{L}), number (\p{N}), and underscore. This preserves non-English words
 * intact — e.g. Turkish "değişiklik" stays one token instead of splitting at
 * ç/ğ/ı/ö/ş/ü (which ASCII \w treats as non-word). Underscore is kept so
 * snake_case identifiers survive (matching the prior \w behavior).
 */
export function filterTerms(raw: string): string[] {
  const words = raw
    .replace(/[^\p{L}\p{N}_\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

  return words.filter((w) => w.length > 1 && !STOPWORDS.has(w.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Term importance via IDF (Inverse Document Frequency)
// ---------------------------------------------------------------------------

/**
 * FTS5 tables to probe for document frequency counts. Each table contributes
 * to the IDF estimate. Querying multiple tables produces a corpus-wide signal
 * rather than a single-source bias.
 */
const IDF_FTS_TABLES = [
  "knowledge_fts",
  "distillation_fts",
  "temporal_fts",
] as const;

/**
 * Estimate term importance via inverse document frequency across FTS5 tables.
 *
 * For each filtered term, counts how many rows match `<term>*` across the
 * three FTS5 tables (knowledge, distillation, temporal). Terms appearing in
 * fewer documents get higher IDF scores — they are more discriminative.
 *
 * Returns a Map<string, number> where the key is the **lowercased** term and
 * the value is `log(1 + totalDocs / (1 + termDocs))`. Higher = rarer = more
 * important. Terms not found in any table get the maximum score.
 * Callers must use `.get(term.toLowerCase())` to look up weights.
 *
 * This is intentionally a rough estimate — FTS5 MATCH with a prefix query is
 * fast (uses the index), but the count is approximate because prefix matching
 * can overcount. Good enough for ranking which terms to keep vs drop.
 *
 * @param raw  The raw query string (filtered through `filterTerms()` internally)
 */
export function termIDF(raw: string): Map<string, number> {
  const terms = filterTerms(raw);
  if (!terms.length) return new Map();

  const database = db();
  const weights = new Map<string, number>();

  // Estimate total corpus size (sum of row counts across tables).
  // Use a rough count — exact count is expensive and unnecessary for IDF.
  let totalDocs = 0;
  for (const table of IDF_FTS_TABLES) {
    try {
      const row = database
        .query(`SELECT count(*) as cnt FROM ${table}`)
        .get() as { cnt: number } | null;
      totalDocs += row?.cnt ?? 0;
    } catch {
      // Table might not exist in test environments — skip it.
    }
  }
  // Floor at 1 to avoid division by zero.
  totalDocs = Math.max(totalDocs, 1);

  // Deduplicate terms (case-insensitive) to avoid redundant queries.
  const seen = new Set<string>();
  for (const term of terms) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    let termDocs = 0;
    for (const table of IDF_FTS_TABLES) {
      try {
        const row = database
          .query(`SELECT count(*) as cnt FROM ${table} WHERE ${table} MATCH ?`)
          .get(ftsToken(term)) as { cnt: number } | null;
        termDocs += row?.cnt ?? 0;
      } catch {
        // MATCH can fail for certain inputs — treat as zero hits.
      }
    }

    // Standard IDF with +1 smoothing to avoid log(0) and division by zero.
    weights.set(key, Math.log(1 + totalDocs / (1 + termDocs)));
  }

  return weights;
}

/**
 * Render a single filtered term as an FTS5 prefix token.
 *
 * CRITICAL: the term is wrapped in double quotes BEFORE the `*` prefix
 * operator. Without quoting, a bareword that is an uppercase FTS5 keyword
 * (AND, OR, NOT, NEAR) is parsed as a query *operator* rather than a search
 * token — e.g. `run* OR AND* OR tests*` raises
 * `fts5: syntax error near "AND"`. Quoting forces FTS5 to treat the token as a
 * string literal, neutralizing the entire keyword-injection class regardless
 * of which terms survive stopword filtering (today only `or`/`not` are caught,
 * via STOPWORDS — `and`/`near` are not). `filterTerms()` strips everything
 * except \p{L}\p{N}_, so a term can never contain a quote in practice; we
 * still double any `"` defensively in case that contract changes.
 *
 * Quoting is semantically identical to the bareword form for ordinary tokens:
 * `"foo"*` and `foo*` match the same rows (incl. snake_case and non-ASCII).
 */
function ftsToken(term: string): string {
  return `"${term.replace(/"/g, '""')}"*`;
}

/**
 * Build an FTS5 MATCH expression using AND semantics (implicit AND via space).
 *
 * Returns `""` (match-nothing sentinel) when no meaningful terms remain after
 * filtering. Callers should check `q === EMPTY_QUERY` and handle accordingly.
 */
export function ftsQuery(raw: string): string {
  const terms = filterTerms(raw);
  if (!terms.length) return EMPTY_QUERY;
  return terms.map(ftsToken).join(" ");
}

/**
 * Build an FTS5 MATCH expression using OR semantics.
 * Same filtering as ftsQuery(), but joins terms with OR.
 * Used as fallback when AND returns zero results.
 */
export function ftsQueryOr(raw: string): string {
  const terms = filterTerms(raw);
  if (!terms.length) return EMPTY_QUERY;
  return terms.map(ftsToken).join(" OR ");
}

/**
 * Build a cascade of progressively relaxed FTS5 queries.
 *
 * For N terms, produces up to (N - minTerms) queries, each dropping one more
 * term (least significant first). The final entry is always the full OR query.
 *
 * Term drop order:
 * - When `termWeights` is provided (IDF map from `termIDF()`), terms with the
 *   lowest weight (most common / least discriminative) are dropped first. This
 *   keeps rare, specific terms like "V8", "SEA", "PKCE" longer in the cascade
 *   instead of dropping them early due to short length.
 * - When `termWeights` is absent, falls back to length ascending (shortest
 *   terms dropped first) as a rough proxy for specificity. This preserves
 *   backward compatibility for callers that don't compute IDF.
 *
 * Example for 6 terms with minTerms=3:
 *   [0] 5-of-6 AND (drop least important term)
 *   [1] 4-of-6 AND
 *   [2] 3-of-6 AND
 *   [3] full OR (all 6 terms)
 *
 * For ≤ minTerms terms, returns just the OR query (no intermediate steps).
 * Callers should try each query in order, stopping at the first that returns
 * results. This avoids the AND→OR cliff that produces massive low-quality
 * result sets.
 */
export function ftsQueryRelaxed(
  raw: string,
  minTerms = 3,
  termWeights?: Map<string, number>,
): string[] {
  const terms = filterTerms(raw);
  if (!terms.length) return [EMPTY_QUERY];

  const orQuery = terms.map(ftsToken).join(" OR ");

  // Not enough terms for progressive relaxation — just OR.
  if (terms.length <= minTerms) return [orQuery];

  // Sort by importance ascending — least important terms dropped first.
  // With IDF weights: low IDF = common/unimportant → dropped first.
  // Without weights: short length = rough proxy for low specificity → dropped first.
  //
  // When termWeights is provided but a term has no entry (e.g. LLM-expanded
  // queries introduce tokens not in the original IDF map), fall back to the
  // length heuristic for that term — avoids treating unknown terms as weight 0
  // (which would always drop them first, even if they're discriminative).
  const ranked = [...terms].sort((a, b) => {
    if (termWeights) {
      const wa = termWeights.get(a.toLowerCase());
      const wb = termWeights.get(b.toLowerCase());
      // Both have IDF weights → sort by weight (lower = less important → dropped first)
      if (wa !== undefined && wb !== undefined) {
        if (wa !== wb) return wa - wb;
        return a.length - b.length; // tie-break by length
      }
      // One or both missing: unknown terms (likely LLM-generated filler) sort
      // to the front (dropped first), known terms sort to the back (kept longest).
      if (wa !== undefined && wb === undefined) return 1; // a known, b unknown → drop b first
      if (wa === undefined && wb !== undefined) return -1; // a unknown, b known → drop a first
      return a.length - b.length; // both unknown → length heuristic
    }
    return a.length - b.length;
  });

  const cascade: string[] = [];
  for (let drop = 1; drop <= terms.length - minTerms; drop++) {
    const kept = ranked.slice(drop);
    cascade.push(kept.map(ftsToken).join(" "));
  }
  cascade.push(orQuery);
  return cascade;
}

/**
 * Run a search function through the relaxed cascade, stopping at the first
 * query that produces results. Falls back through progressively looser AND
 * queries before trying full OR.
 *
 * @param raw          The original query string
 * @param runner       A function that takes an FTS5 MATCH expression and returns results
 * @param termWeights  Optional IDF weights from `termIDF()` — when provided, the
 *                     relaxed cascade drops common terms first instead of short ones
 * @returns            The results from the first cascade step that produced matches
 */
export function runRelaxedSearch<T>(
  raw: string,
  runner: (matchExpr: string) => T[],
  termWeights?: Map<string, number>,
): T[] {
  // First try exact AND (all terms)
  const q = ftsQuery(raw);
  if (q === EMPTY_QUERY) return [];

  const andResults = runner(q);
  if (andResults.length) return andResults;

  // Try progressively relaxed queries — with IDF weights, the cascade keeps
  // rare/discriminative terms longer instead of dropping them early.
  const cascade = ftsQueryRelaxed(raw, 3, termWeights);
  for (const relaxed of cascade) {
    if (relaxed === EMPTY_QUERY) continue;
    const results = runner(relaxed);
    if (results.length) return results;
  }

  return [];
}

// ---------------------------------------------------------------------------
// Term extraction (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Extract the top meaningful terms from text, sorted by frequency.
 *
 * Same filtering as ftsQuery: drops single chars + stopwords.
 * No general length threshold — preserves short meaningful tokens like "DB", "CI".
 *
 * Used by forSession() to build session context queries for FTS5 scoring.
 *
 * @param text   Raw text to extract terms from
 * @param limit  Max number of terms to return (default 40)
 */
export function extractTopTerms(text: string, limit = 40): string[] {
  const freq = text
    .replace(/[^\p{L}\p{N}_\s]/gu, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .reduce<Map<string, number>>((acc, w) => {
      acc.set(w, (acc.get(w) ?? 0) + 1);
      return acc;
    }, new Map());

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w]) => w);
}

// ---------------------------------------------------------------------------
// Score normalization & fusion (Phase 2)
// ---------------------------------------------------------------------------

/**
 * Normalize a raw FTS5 BM25 rank to a 0–1 range using min-max normalization.
 *
 * FTS5 rank/bm25() values are negative (more negative = better match).
 * This converts them to 0–1 where 1 = best match in the result set.
 *
 * Used for display scores only — RRF fusion uses rank positions, not scores.
 */
export function normalizeRank(
  rank: number,
  minRank: number,
  maxRank: number,
): number {
  // All same rank → everything is equally relevant
  if (minRank === maxRank) return 1;
  // minRank is most negative (best), maxRank is least negative (worst)
  // Invert: best match → 1.0, worst → 0.0
  return (maxRank - rank) / (maxRank - minRank);
}

/**
 * Reciprocal Rank Fusion: merge multiple ranked lists into a single ranked list.
 *
 * RRF score = Σ(weight / (k + rank_i)) for each list where the item appears.
 * k = 60 is standard (from Cormack et al., 2009; also used by QMD).
 *
 * RRF is rank-based, not score-based — raw score magnitude differences across
 * different FTS5 tables don't matter. Only relative ordering within each list.
 *
 * @param lists  Each list provides items (in ranked order), a key function
 *               for deduplication, and an optional weight (default 1).
 *               Items at the front of the array are rank 0.
 * @param k      Smoothing constant. Default 60.
 * @returns      Fused list sorted by RRF score descending. When items appear
 *               in multiple lists, the first occurrence's item is kept.
 */
export function reciprocalRankFusion<T>(
  lists: Array<{ items: T[]; key: (item: T) => string; weight?: number }>,
  k = 60,
): Array<{ item: T; score: number }> {
  const scores = new Map<string, { item: T; score: number }>();

  for (const list of lists) {
    const w = list.weight ?? 1;
    for (let rank = 0; rank < list.items.length; rank++) {
      const item = list.items[rank];
      const id = list.key(item);
      const rrfScore = w / (k + rank);
      const existing = scores.get(id);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(id, { item, score: rrfScore });
      }
    }
  }

  return [...scores.values()].sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Exact term match ranking (Phase 5 — MemPalace-inspired keyword boost)
// ---------------------------------------------------------------------------

/**
 * Score candidates by exact query term overlap.
 *
 * Returns items sorted by number of exact term matches (descending).
 * Used as an additional RRF list to boost results that contain query terms
 * verbatim — important for proper nouns, file names, and technical terms
 * that BM25's prefix matching + Porter stemming can miss or dilute.
 *
 * Terms are filtered through the standard stopword + single-char filter
 * (same as `ftsQuery`), then matched case-insensitively via `includes()`.
 */
export function exactTermMatchRank<T>(
  items: T[],
  getText: (item: T) => string,
  query: string,
): T[] {
  const terms = filterTerms(query).map((t) => t.toLowerCase());
  if (!terms.length) return [];

  const scored = items
    .map((item) => {
      const text = getText(item).toLowerCase();
      const matches = terms.filter((t) => text.includes(t)).length;
      return { item, matches };
    })
    .filter((s) => s.matches > 0)
    .sort((a, b) => b.matches - a.matches);

  return scored.map((s) => s.item);
}

// ---------------------------------------------------------------------------
// LLM query expansion (Phase 4)
// ---------------------------------------------------------------------------

import { QUERY_EXPANSION_SYSTEM } from "./prompt";
import * as log from "./log";
import { db } from "./db";
import type { LLMClient } from "./types";

/**
 * Expand a user query into multiple search variants using the configured LLM.
 * Returns `[original, ...expanded]`. The original is always first.
 *
 * Uses a 3-second timeout — if the LLM is slow, returns only the original query.
 * Errors are caught silently (logged) and the original query is returned.
 *
 * @param llm       LLM client for prompt calls
 * @param query     The original user query
 * @param model     Optional model override
 */
export async function expandQuery(
  llm: LLMClient,
  query: string,
  model?: { providerID: string; modelID: string },
  sessionID?: string,
): Promise<string[]> {
  const TIMEOUT_MS = 3000;

  try {
    // Race the LLM call against a timeout
    const responseText = await Promise.race([
      llm.prompt(
        QUERY_EXPANSION_SYSTEM,
        `Input: "${query}"`,
        // temperature: 0 trades expansion diversity for eval reproducibility
        {
          model,
          workerID: "lore-query-expand",
          thinking: false,
          urgent: true,
          sessionID,
          maxTokens: 256,
          temperature: 0,
        },
      ),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), TIMEOUT_MS),
      ),
    ]);

    if (!responseText) {
      log.info("query expansion timed out or failed, using original query");
      return [query];
    }

    // Parse JSON array from response
    const cleaned = responseText
      .trim()
      .replace(/^```json?\s*/i, "")
      .replace(/\s*```$/i, "");
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [query];

    const expanded = parsed.filter(
      (q): q is string => typeof q === "string" && q.trim().length > 0,
    );
    if (!expanded.length) return [query];

    return [query, ...expanded.slice(0, 3)]; // cap at 3 expansions
  } catch (err) {
    log.info("query expansion failed, using original query:", err);
    return [query];
  }
}
