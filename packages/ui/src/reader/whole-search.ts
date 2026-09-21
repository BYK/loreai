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

/** Whether the reader currently holds the block with this id. */
export type IsLoaded = (blockId: string) => boolean;

/** Server hits whose message is not loaded, newest first. */
export function olderServerHits(
  hits: readonly SessionSearchHit[],
  isLoaded: IsLoaded,
): SessionSearchHit[] {
  return hits
    .filter((hit) => !isLoaded(messageBlockId(hit.message_id)))
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
  isLoaded: IsLoaded,
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
    result.older.push(...olderServerHits(page.hits, isLoaded));
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
  isLoaded: IsLoaded,
): SessionSearchHit | null {
  return (
    result.older.find((hit) => !isLoaded(messageBlockId(hit.message_id))) ??
    null
  );
}

/** Older hits still outside the loaded window. */
export function remainingOlderHits(
  result: WholeSearchResult,
  isLoaded: IsLoaded,
): number {
  let n = 0;
  for (const hit of result.older) {
    if (!isLoaded(messageBlockId(hit.message_id))) n++;
  }
  return n;
}

/**
 * Bringing one server hit onto the screen: older pages are loaded until its
 * message is in the window, then the browser-side scan must find the query
 * in the displayed text. Each way that can end is said plainly.
 */
export type ReachState =
  | { kind: "loading"; messageId: string; pages: number }
  /** Paged `WHOLE_LOAD_PAGES` times and the message is still older. */
  | { kind: "exhausted"; messageId: string; pages: number }
  /** The server counted the message but no older page can be loaded. */
  | { kind: "unreachable"; messageId: string }
  /** The message is loaded but its displayed text has no literal match. */
  | { kind: "inexact"; messageId: string; mode: SessionSearchPage["mode"] };

export function reachLabel(state: ReachState): string {
  switch (state.kind) {
    case "loading":
      return `Loading older history to reach the match · page ${state.pages} of ${WHOLE_LOAD_PAGES}`;
    case "exhausted":
      return `The match is further back than ${WHOLE_LOAD_PAGES} pages of older history · load more to keep going`;
    case "unreachable":
      return "The server counted a match that older history cannot reach from here · reload to refresh the view";
    case "inexact":
      return state.mode === "terms"
        ? "Matching message loaded · its words appear separately, so there is no single passage to highlight"
        : "Matching message loaded · the stored text matches but the displayed text does not contain it literally";
  }
}

/** One-line description of a finished whole-session search. */
export function wholeSearchSummary(
  result: WholeSearchResult,
  isLoaded: IsLoaded,
): string {
  const n = result.total;
  const messages = `${n.toLocaleString()} matching ${n === 1 ? "message" : "messages"} in the whole session`;
  const how = result.mode === "terms" ? " (all words, any order)" : "";
  const older = remainingOlderHits(result, isLoaded);
  if (n === 0) return "No matches in the whole session";
  if (older === 0) {
    return result.complete
      ? `${messages}${how} · nothing more in older history`
      : `${messages}${how} · the newest ${result.examined.toLocaleString()} checked, none in older history yet`;
  }
  return `${messages}${how} · ${older.toLocaleString()} in older history${result.complete ? "" : " so far"}`;
}
