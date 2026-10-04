/**
 * Shared fuzzy-ranking helper (#1948). The core ships an identical copy at
 * `packages/core/src/fuzzy.ts` — keep thresholds, normalization and ranking
 * semantics in lockstep so client and server filters behave the same.
 *
 * Exact substring matches (after normalization) always outrank fuzzy hits:
 * their score is forced to 1. Results are sorted by score descending and are
 * stable — callers pass pre-sorted candidate lists so their ordering survives
 * among equal scores.
 */
import { Searcher, sortKind } from "fast-fuzzy";

/** fast-fuzzy score floor for a non-exact hit. */
export const FUZZY_THRESHOLD = 0.6;

/** Normalized queries shorter than this return no results — too noisy. */
export const FUZZY_MIN_QUERY = 3;

/** Upper bound on the candidate set a fuzzy leg ranks (titles of the most
 *  recent rows under the caller's non-query predicates). */
export const FUZZY_CANDIDATE_CAP = 2_500;

export type FuzzyHit<T> = {
  item: T;
  /** 1 for exact substring hits, otherwise the fast-fuzzy score. */
  score: number;
  /** Some normalized key contains the normalized query as a substring. */
  exact: boolean;
};

/**
 * Lowercase, NFKD + strip combining marks (diacritics), replace separator
 * runs (`-`, `_`, `/`, `.`, `\`, `:`) with a space, collapse whitespace, trim.
 */
export function normalizeFuzzy(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[-_/.\\:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Rank `items` against `query`. `keys(item)` returns the searchable strings
 * (e.g. `[name, path]`). Returns [] when the normalized query is shorter than
 * `FUZZY_MIN_QUERY`; `opts.limit` caps the output.
 */
export function fuzzyRank<T>(
  query: string,
  items: readonly T[],
  keys: (item: T) => readonly string[],
  opts?: { limit?: number; threshold?: number },
): FuzzyHit<T>[] {
  const q = normalizeFuzzy(query);
  if (q.length < FUZZY_MIN_QUERY) return [];
  const threshold = opts?.threshold ?? FUZZY_THRESHOLD;

  const candidates = items.map((item) => ({
    item,
    keys: keys(item)
      .map(normalizeFuzzy)
      .filter((key) => key.length > 0),
  }));
  const searcher = new Searcher(candidates, {
    keySelector: (candidate) => candidate.keys,
    threshold,
    ignoreCase: true,
    normalizeWhitespace: true,
    returnMatchData: true,
    // Input order — we re-sort by score stably below so equal scores keep
    // the caller's ordering (e.g. recency).
    sortBy: sortKind.insertOrder,
  });
  const hits = searcher
    .search(q)
    .map(({ item, score }) => {
      const exact = item.keys.some((key) => key.includes(q));
      return { item: item.item, score: exact ? 1 : score, exact };
    })
    .filter((hit) => hit.exact || hit.score >= threshold);
  hits.sort((a, b) => b.score - a.score);
  const limited = opts?.limit !== undefined ? hits.slice(0, opts.limit) : hits;
  return limited;
}
