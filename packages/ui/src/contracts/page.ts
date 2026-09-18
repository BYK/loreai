import * as v from "valibot";

/**
 * Cursor-mode page envelope (`{ items, next_cursor }`) used by the
 * `?page=cursor` / `?cursor=` list routes
 * (origin/devin/1789739012-api-cursor-pagination).
 */
export const cursorPage = <S extends v.GenericSchema>(item: S) =>
  v.looseObject({
    items: v.array(item),
    next_cursor: v.nullable(v.string()),
  });

export interface CursorPage<T> {
  items: T[];
  next_cursor: string | null;
}
