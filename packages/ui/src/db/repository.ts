/**
 * Generic repository over the cached entity stores. Only ever instantiated
 * (in `db/index.ts`) with the contract types — local working state does not
 * typecheck here, which is the authority boundary.
 *
 * `db === null` (cache unavailable) degrades every method to a no-op so the
 * shell keeps working server-only.
 */
import type { IDBPTransaction } from "idb";

import { CACHE_LIMITS, type CacheLimit } from "./limits";
import type {
  CachedRecord,
  CachedStoreName,
  CollectionState,
  LoreUiDb,
  LoreUiSchema,
} from "./schema";

export interface Repository<T> {
  /** The record, or undefined when missing OR expired. */
  get(key: string): Promise<T | undefined>;
  /** Non-expired rows of one scope; refreshes `accessedAt` on what it returns. */
  getScope(scope: string): Promise<T[]>;
  put(value: T, scope: string, opts?: { keepScope?: boolean }): Promise<void>;
  putMany(
    values: readonly T[],
    scope: string,
    opts?: { replaceScope?: boolean },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  collection(scope: string): Promise<CollectionState | undefined>;
  setCollection(
    scope: string,
    state: Omit<CollectionState, "key" | "store" | "scope">,
  ): Promise<void>;
}

type AnyRecord = CachedRecord<unknown>;

export function createRepository<T>(
  db: LoreUiDb | null,
  store: CachedStoreName,
  keyOf: (value: T, scope: string) => string,
  limits: CacheLimit = CACHE_LIMITS[store],
  now: () => number = Date.now,
): Repository<T> {
  const empty: T[] = [];

  /** Expire-by-age then LRU-to-cap, inside the caller's write transaction. */
  async function evict(
    tx: IDBPTransaction<LoreUiSchema, [CachedStoreName], "readwrite">,
  ) {
    const cutoff = now() - limits.maxAgeMs;
    let cursor = await tx.store
      .index("by-stored")
      .openCursor(IDBKeyRange.upperBound(cutoff, true));
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    const count = await tx.store.count();
    if (count > limits.maxEntries) {
      let excess = count - limits.maxEntries;
      let lru = await tx.store.index("by-accessed").openCursor();
      while (lru && excess > 0) {
        await lru.delete();
        lru = await lru.continue();
        excess--;
      }
    }
  }

  return {
    async get(key) {
      if (!db) return undefined;
      const tx = db.transaction(store, "readwrite");
      const row = (await tx.store.get(key)) as AnyRecord | undefined;
      let value: T | undefined;
      if (row && row.storedAt >= now() - limits.maxAgeMs) {
        row.accessedAt = now();
        await tx.store.put(row as never);
        value = row.value as T;
      }
      await tx.done;
      return value;
    },

    async getScope(scope) {
      if (!db) return empty;
      const tx = db.transaction(store, "readwrite");
      const rows = (await tx.store
        .index("by-scope")
        .getAll(scope)) as AnyRecord[];
      const cutoff = now() - limits.maxAgeMs;
      const out: T[] = [];
      for (const row of rows) {
        if (row.storedAt < cutoff) continue;
        row.accessedAt = now();
        await tx.store.put(row as never);
        out.push(row.value as T);
      }
      await tx.done;
      return out;
    },

    async put(value, scope, opts) {
      if (!db) return;
      const tx = db.transaction(store, "readwrite");
      const t = now();
      const key = keyOf(value, scope);
      const existing = opts?.keepScope
        ? ((await tx.store.get(key)) as AnyRecord | undefined)
        : undefined;
      const record: CachedRecord<T> = {
        key,
        scope: existing?.scope ?? scope,
        value,
        storedAt: t,
        accessedAt: t,
      };
      await tx.store.put(record as never);
      await evict(tx);
      await tx.done;
    },

    async putMany(values, scope, opts) {
      if (!db) return;
      const tx = db.transaction(store, "readwrite");
      const t = now();
      const keys = new Set<string>();
      for (const value of values) {
        const key = keyOf(value, scope);
        keys.add(key);
        const record = {
          key,
          scope,
          value,
          storedAt: t,
          accessedAt: t,
        } satisfies CachedRecord<T>;
        await tx.store.put(record as CachedRecord<never>);
      }
      if (opts?.replaceScope) {
        const existing = await tx.store.index("by-scope").getAllKeys(scope);
        for (const key of existing) {
          if (!keys.has(key)) await tx.store.delete(key);
        }
      }
      await evict(tx);
      await tx.done;
    },

    async delete(key) {
      if (!db) return;
      await db.delete(store, key);
    },

    async clear() {
      if (!db) return;
      await db.clear(store);
    },

    async collection(scope) {
      if (!db) return undefined;
      return db.get("collections", `${store}:${scope}`);
    },

    async setCollection(scope, state) {
      if (!db) return;
      const record: CollectionState = {
        key: `${store}:${scope}`,
        store,
        scope,
        ...state,
      };
      await db.put("collections", record);
    },
  };
}
