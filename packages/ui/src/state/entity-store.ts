import { createStore, reconcile } from "solid-js/store";

import { IDLE_STATUS, type KeyStatus } from "./status";

/**
 * Generic keyed entity store: records by id, per-scope id lists and
 * per-scope/per-key status. `reconcile` keeps referential identity for
 * records whose contents did not change, so memoized rows don't re-render.
 */
export function createEntityStore<T>(keyOf: (value: T) => string) {
  const [state, setState] = createStore<{
    byKey: Record<string, T>;
    lists: Record<string, string[]>;
    status: Record<string, KeyStatus>;
  }>({ byKey: {}, lists: {}, status: {} });

  return {
    /** Narrow selector — tracks only this key. */
    select(key: string): T | undefined {
      return state.byKey[key];
    },
    selectList(scope: string): T[] | undefined {
      const ids = state.lists[scope];
      if (!ids) return undefined;
      return ids
        .map((id) => state.byKey[id])
        .filter((v): v is T => v !== undefined);
    },
    statusOf(key: string): KeyStatus {
      return state.status[key] ?? IDLE_STATUS;
    },
    reconcileOne(value: T) {
      const key = keyOf(value);
      setState("byKey", key, reconcile(value));
    },
    /**
     * Upsert every record and set the scope's id list. `{ complete: false }`
     * marks the scope partial and APPENDS to an existing list (cursor
     * "load more"); a complete list replaces it.
     */
    reconcileList(
      scope: string,
      values: readonly T[],
      meta: { complete: boolean },
    ) {
      const ids = values.map(keyOf);
      setState("byKey", (byKey) => {
        const next = { ...byKey };
        for (const v of values) next[keyOf(v)] = v;
        return next;
      });
      setState("lists", scope, (existing) => {
        if (!meta.complete && existing) {
          const seen = new Set(existing);
          return [...existing, ...ids.filter((id) => !seen.has(id))];
        }
        return ids;
      });
      setState("status", scope, (prev) => ({
        ...(prev ?? IDLE_STATUS),
        partial: !meta.complete,
      }));
    },
    /** Drop a record and strip it from every scope list. */
    remove(key: string) {
      setState("byKey", key, undefined as never);
      setState("lists", (lists) => {
        const next: Record<string, string[]> = {};
        for (const [scope, ids] of Object.entries(lists)) {
          next[scope] = ids.filter((id) => id !== key);
        }
        return next;
      });
    },
    setStatus(key: string, patch: Partial<KeyStatus>) {
      setState("status", key, (prev) => ({
        ...(prev ?? IDLE_STATUS),
        ...patch,
      }));
    },
  };
}
