/**
 * Whole-session search (#1857): the server answers *which messages* match
 * (`GET /sessions/:id/search`, FTS5 over the stored text); the reader still
 * owns *where* on screen — a hit becomes a highlight only after its message
 * is loaded and the browser-side matcher finds the query in the displayed
 * text (Markdown/code coordinates exist nowhere else).
 *
 * This module is the pure part: pulling server pages until a hit outside the
 * loaded window is known, and picking the next such hit to load. Paging the
 * history and highlighting stay in `SessionView`.
 */
import type { SessionSearchHit, SessionSearchPage } from "~/contracts";
import { messageBlockId } from "./blocks";

/** Hits per server page while looking for one outside the loaded window. */
export const WHOLE_SEARCH_PAGE = 200;
/** Server pages pulled per whole-session search before giving up. */
export const WHOLE_SEARCH_MAX_PAGES = 5;
/** Older history pages loaded to bring one server hit into the window. */
export const WHOLE_LOAD_PAGES = 10;

export interface WholeSearchResult {
  query: string;
  /** Matching messages in the whole session, as the server counted them. */
  total: number;
  mode: SessionSearchPage["mode"];
  terms: string[];
  /**
   * Hits whose message was outside the loaded window when fetched — newest
   * first, i.e. in the order paging older history reaches them.
   */
  older: SessionSearchHit[];
  /** Server hits examined (loaded or not). */
  examined: number;
  /** False when the server had more pages than `WHOLE_SEARCH_MAX_PAGES`. */
  complete: boolean;
}

export type WholeSearchState =
  | { kind: "idle" }
  | { kind: "searching"; query: string }
  | { kind: "error"; query: string; message: string }
  | { kind: "done"; result: WholeSearchResult };

export const WHOLE_IDLE: WholeSearchState = { kind: "idle" };

/** Newest-first ordering of server hits: `(created_at, message_id)` desc. */
export function compareHitsNewestFirst(
  a: SessionSearchHit,
  b: SessionSearchHit,
): number {
  if (a.created_at !== b.created_at) return b.created_at - a.created_at;
  return a.message_id < b.message_id ? 1 : a.message_id > b.message_id ? -1 : 0;
}

/** Server hits whose message is not in `loadedBlockIds`, newest first. */
export function olderServerHits(
  hits: readonly SessionSearchHit[],
  loadedBlockIds: ReadonlySet<string>,
): SessionSearchHit[] {
  return hits
    .filter((hit) => !loadedBlockIds.has(messageBlockId(hit.message_id)))
    .sort(compareHitsNewestFirst);
}

/**
 * Pull server pages (newest hits first) until at least one hit outside the
 * loaded window is known, the server runs out, or the page bound is hit.
 * Loaded hits are already found by the browser-side scan, so they are only
 * counted, never returned.
 */
export async function searchWholeSession(
  query: string,
  fetchPage: (cursor: string | null) => Promise<SessionSearchPage>,
  loadedBlockIds: ReadonlySet<string>,
  options: { maxPages?: number } = {},
): Promise<WholeSearchResult> {
  const maxPages = options.maxPages ?? WHOLE_SEARCH_MAX_PAGES;
  let cursor: string | null = null;
  let pages = 0;
  const result: WholeSearchResult = {
    query,
    total: 0,
    mode: "phrase",
    terms: [],
    older: [],
    examined: 0,
    complete: false,
  };
  for (;;) {
    const page = await fetchPage(cursor);
    pages++;
    result.total = page.total;
    result.mode = page.mode;
    result.terms = page.terms;
    result.examined += page.hits.length;
    result.older.push(...olderServerHits(page.hits, loadedBlockIds));
    cursor = page.next_cursor;
    if (cursor === null || page.hits.length === 0) {
      result.complete = true;
      break;
    }
    if (result.older.length > 0 || pages >= maxPages) break;
  }
  result.older.sort(compareHitsNewestFirst);
  return result;
}

/**
 * The next server hit worth loading: the newest one whose message is still
 * outside the loaded window (older pages arrive newest-first, so it is the
 * cheapest to reach).
 */
export function nextOlderHit(
  result: WholeSearchResult,
  loadedBlockIds: ReadonlySet<string>,
): SessionSearchHit | null {
  return (
    result.older.find(
      (hit) => !loadedBlockIds.has(messageBlockId(hit.message_id)),
    ) ?? null
  );
}

/** Older hits still outside the loaded window. */
export function remainingOlderHits(
  result: WholeSearchResult,
  loadedBlockIds: ReadonlySet<string>,
): number {
  let n = 0;
  for (const hit of result.older) {
    if (!loadedBlockIds.has(messageBlockId(hit.message_id))) n++;
  }
  return n;
}

/** One-line description of a finished whole-session search. */
export function wholeSearchSummary(
  result: WholeSearchResult,
  loadedBlockIds: ReadonlySet<string>,
): string {
  const n = result.total;
  const messages = `${n.toLocaleString()} matching ${n === 1 ? "message" : "messages"} in the whole session`;
  const how = result.mode === "terms" ? " (all words, any order)" : "";
  const older = remainingOlderHits(result, loadedBlockIds);
  if (n === 0) return "No matches in the whole session";
  if (older === 0) {
    return result.complete
      ? `${messages}${how} · nothing more in older history`
      : `${messages}${how} · the newest ${result.examined.toLocaleString()} checked, none in older history yet`;
  }
  return `${messages}${how} · ${older.toLocaleString()} in older history${result.complete ? "" : " so far"}`;
}
