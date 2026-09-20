/**
 * In-session search (UI-06c) over the *logical* history — every loaded block,
 * mounted or not — so a virtualised reader can still find text the browser's
 * own find cannot see. Hits are displayed-text spans (the same coordinates
 * source anchors use), found in row order, so a hit can be scrolled to,
 * highlighted and, if the reader wants, turned into an anchor.
 *
 * Displayed text is derived per part through the render cache, so a search
 * over thousands of blocks is done in bounded slices (`searchRows` walks
 * `[from, from + budget)` rows) and the caller yields between slices instead
 * of blocking the frame.
 */
import type { MessageBlock } from "./blocks";
import { displayedText } from "./render";
import type { ReaderRow } from "./rows";

export interface SearchHit {
  blockId: string;
  partIndex: number;
  /** Displayed-text offsets, half-open. */
  start: number;
  end: number;
  /** Row index at search time (for scrolling). */
  rowIndex: number;
}

export interface SearchSlice {
  hits: SearchHit[];
  /** Next row to scan, or null when every row has been scanned. */
  next: number | null;
}

/** Shortest query the reader searches for; single characters match everywhere. */
export const MIN_QUERY_LENGTH = 2;
/** Rows scanned per slice before yielding to the frame. */
export const SEARCH_SLICE_ROWS = 400;

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive literal matcher; `i` folds case without changing lengths. */
export function queryMatcher(query: string): RegExp | null {
  const trimmed = query.trim();
  if (trimmed.length < MIN_QUERY_LENGTH) return null;
  return new RegExp(escapeRegExp(trimmed), "giu");
}

export function findInText(
  text: string,
  matcher: RegExp,
): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  matcher.lastIndex = 0;
  for (let m = matcher.exec(text); m; m = matcher.exec(text)) {
    if (m[0].length === 0) {
      matcher.lastIndex++;
      continue;
    }
    spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

export function findInBlock(
  block: MessageBlock,
  matcher: RegExp,
  rowIndex: number,
): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const part of block.parts) {
    for (const span of findInText(displayedText(block, part), matcher)) {
      hits.push({
        blockId: block.id,
        partIndex: part.index,
        start: span.start,
        end: span.end,
        rowIndex,
      });
    }
  }
  return hits;
}

/**
 * Scan rows `[from, from + budget)` for `matcher`. Distillation rows are
 * skipped: compressed context is loaded on demand and is not session speech,
 * so it is not part of "what was said" a search claims to cover.
 */
export function searchRows(
  rows: readonly ReaderRow[],
  matcher: RegExp,
  from = 0,
  budget = SEARCH_SLICE_ROWS,
): SearchSlice {
  const hits: SearchHit[] = [];
  const end = Math.min(rows.length, from + budget);
  for (let i = from; i < end; i++) {
    const block = rows[i]?.block;
    if (block?.kind !== "message") continue;
    for (const hit of findInBlock(block, matcher, i)) hits.push(hit);
  }
  return { hits, next: end < rows.length ? end : null };
}
