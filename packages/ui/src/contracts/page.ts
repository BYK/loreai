import "./config";
import { type, type Type } from "arktype";

/**
 * Cursor-mode page envelope (`{ items, next_cursor }`) used by the
 * `?page=cursor` / `?cursor=` list routes
 * (packages/gateway/src/api-lists.ts).
 */
export function cursorPage<T>(item: Type<T>): Type<CursorPage<T>> {
  return type({
    items: item.array(),
    next_cursor: "string | null",
  });
}

export interface CursorPage<T> {
  items: T[];
  next_cursor: string | null;
}
