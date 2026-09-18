import type { CursorPage } from "~/contracts";

export interface MergedPage<T> {
  items: T[];
  nextCursor: string | null;
  /** True ONLY when the last page reported `next_cursor === null`. */
  complete: boolean;
}

/**
 * Append a cursor page to the accumulated list. The first page replaces;
 * later pages append, deduped by `keyOf`. `next_cursor: ""` (or any non-null
 * string) keeps the page partial — only `null` completes it.
 */
export function mergeCursorPage<T>(
  prev: MergedPage<T> | undefined,
  page: CursorPage<T>,
  keyOf: (value: T) => string,
): MergedPage<T> {
  const prior = prev?.items ?? [];
  const seen = new Set(prior.map(keyOf));
  const items = [...prior, ...page.items.filter((v) => !seen.has(keyOf(v)))];
  return { items, nextCursor: page.next_cursor, complete: page.next_cursor === null };
}
