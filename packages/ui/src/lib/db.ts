/**
 * IndexedDB scaffold (UI-02). Only the database name, version and the first
 * object store are defined here; UI-03 adds repositories and migrations.
 *
 * The browser store is a cache/projection, never an authority: everything in
 * it can be rebuilt from the gateway API. Drafts written locally in later
 * slices are the one exception and are labelled as "on this device".
 */
import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export const LORE_DB_NAME = "lore-ui";
export const LORE_DB_VERSION = 1;

export interface LoreUiSchema extends DBSchema {
  /** Per-device UI preferences (theme is in localStorage; this is for UI-03+). */
  meta: {
    key: string;
    value: { key: string; value: unknown; updatedAt: number };
  };
}

export type LoreUiDb = IDBPDatabase<LoreUiSchema>;

let opening: Promise<LoreUiDb | null> | null = null;

export function indexedDbAvailable(): boolean {
  return typeof globalThis.indexedDB !== "undefined";
}

/**
 * Opens (creating on first use) the UI database. Resolves to `null` when
 * IndexedDB is unavailable (private mode, disabled storage) so callers can
 * degrade instead of failing the whole shell.
 */
export function openLoreDb(): Promise<LoreUiDb | null> {
  if (!indexedDbAvailable()) return Promise.resolve(null);
  opening ??= openDB<LoreUiSchema>(LORE_DB_NAME, LORE_DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
    },
    blocking() {
      // Another tab upgraded the schema: close so it can proceed. The next
      // openLoreDb() call reopens at the new version.
      void opening?.then((db) => db?.close());
      opening = null;
    },
  }).catch(() => null);
  return opening;
}
