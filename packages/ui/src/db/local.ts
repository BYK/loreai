/**
 * Local working state on this device; never authoritative, never merged
 * into entity stores.
 *
 * `drafts` holds in-progress edits the user has not saved; `pendingChanges`
 * holds mutations queued for a write API that does not exist yet. Both are
 * structurally different from every contract type, so the entity
 * repositories (`repository.ts`) reject them at the type level — the
 * `// @ts-expect-error` assertions in `test/db.test.ts` keep that true.
 */
import type { IndexNames } from "idb";

import type { LoreUiDb, LoreUiSchema } from "./schema";

export interface LocalDraft {
  key: string;
  kind: "knowledge";
  /** Logical id being edited, or null for a new entry. */
  target: string | null;
  body: { title: string; content: string; category: string };
  updatedAt: number;
}

export interface PendingChange {
  key: string;
  op: "create" | "update" | "delete";
  entity: "knowledge";
  /** Logical id being changed, or null for a create. */
  target: string | null;
  payload: unknown;
  createdAt: number;
  attempts: number;
}

/**
 * Hard cap so local state stays bounded. No TTL/LRU — this is user data,
 * only oldest-first eviction past the cap.
 */
export const LOCAL_CAP = 500;

export interface LocalStore<T extends { key: string }> {
  get(key: string): Promise<T | undefined>;
  put(value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<T[]>;
  clear(): Promise<void>;
}

function createLocalStore<
  T extends { key: string },
  S extends "drafts" | "pendingChanges",
>(
  db: LoreUiDb | null,
  store: S,
  index: IndexNames<LoreUiSchema, S>,
): LocalStore<T> {
  const noop: T[] = [];
  return {
    async get(key) {
      if (!db) return undefined;
      return (await db.get(store, key)) as T | undefined;
    },
    async put(value) {
      if (!db) return;
      const tx = db.transaction(store, "readwrite");
      await tx.store.put(value as never);
      const count = await tx.store.count();
      if (count > LOCAL_CAP) {
        let cursor = await tx.store.index(index).openCursor();
        let excess = count - LOCAL_CAP;
        while (cursor && excess > 0) {
          if (cursor.primaryKey !== value.key) {
            await cursor.delete();
            excess--;
          }
          cursor = await cursor.continue();
        }
      }
      await tx.done;
    },
    async delete(key) {
      if (!db) return;
      await db.delete(store, key);
    },
    async list() {
      if (!db) return noop;
      const rows: unknown[] = await db.getAll(store);
      return rows as T[];
    },
    async clear() {
      if (!db) return;
      await db.clear(store);
    },
  };
}

export function createDraftsStore(db: LoreUiDb | null): LocalStore<LocalDraft> {
  return createLocalStore<LocalDraft, "drafts">(db, "drafts", "by-updated");
}

export function createPendingChangesStore(
  db: LoreUiDb | null,
): LocalStore<PendingChange> {
  return createLocalStore<PendingChange, "pendingChanges">(
    db,
    "pendingChanges",
    "by-created",
  );
}
