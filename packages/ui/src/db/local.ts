/**
 * Local working state on this device; never authoritative, never merged
 * into entity stores.
 *
 * `drafts` holds in-progress edits the user has not saved; `pendingChanges`
 * holds mutations queued for a write API that does not exist yet; and
 * `reviewDecisions` holds duplicate-review marks. These are local working
 * state, structurally distinct from every contract type, and never merged
 * into entity stores.
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

export interface DedupReviewMark {
  key: string;
  kind: "dedup";
  projectId: string;
  groupId: string;
  decision: "accept" | "skip";
  keepId: string;
  mergeIds: string[];
  expectedRevisions: Record<string, number>;
  markedAt: number;
}

export interface ReviewDecisionsStore {
  get(key: string): Promise<DedupReviewMark | undefined>;
  put(value: DedupReviewMark): Promise<void>;
  delete(key: string): Promise<void>;
  list(projectId: string): Promise<DedupReviewMark[]>;
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

export function createReviewDecisionsStore(
  db: LoreUiDb | null,
): ReviewDecisionsStore {
  const memory = new Map<string, DedupReviewMark>();
  return {
    async get(key) {
      if (!db) return memory.get(key);
      return db.get("reviewDecisions", key);
    },
    async put(value) {
      if (!db) {
        memory.set(value.key, value);
        return;
      }
      await db.put("reviewDecisions", value);
    },
    async delete(key) {
      if (!db) {
        memory.delete(key);
        return;
      }
      await db.delete("reviewDecisions", key);
    },
    async list(projectId) {
      if (!db) {
        return [...memory.values()].filter(
          (mark) => mark.projectId === projectId,
        );
      }
      return db.getAllFromIndex("reviewDecisions", "by-project", projectId);
    },
  };
}
