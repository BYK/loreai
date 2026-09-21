/**
 * Opening, upgrading and recovering the `lore-ui` IndexedDB.
 *
 * Recovery contract (worst case the shell runs with no cache):
 *  - a DB missing any expected store (corrupted or written by something
 *    else) → reset once and reopen;
 *  - any open failure (e.g. VersionError because a newer version exists) →
 *    reset once and retry; a second failure → `null` ("unavailable");
 *  - a `blocked` event (another tab holds an old connection) → wait
 *    `blockedTimeoutMs`, then resolve `null` ("blocked") so the shell never
 *    hangs;
 *  - `blocking`/`terminated` on an open connection → drop it so the other
 *    tab can proceed and the next `openLoreDb` reopens.
 */
import { deleteDB, wrap } from "idb";

import { LORE_DB_NAME, LORE_DB_VERSION, type LoreUiDb } from "./schema";

export type CacheStatus = "ready" | "unavailable" | "blocked" | "reset";

export interface OpenOptions {
  /** Injected for tests (e.g. `new IDBFactory()` from fake-indexeddb). */
  factory?: IDBFactory;
  /** How long to wait on a `blocked` upgrade before giving up. Default 3000. */
  blockedTimeoutMs?: number;
  onStatus?: (status: CacheStatus) => void;
}

const CACHED_STORES = [
  "projects",
  "knowledge",
  "sessions",
  "entities",
  "messageBlocks",
] as const;

const ALL_STORES = [
  "meta",
  ...CACHED_STORES,
  "collections",
  "drafts",
  "pendingChanges",
] as const;

let opening: Promise<LoreUiDb | null> | null = null;
let lastOptions: OpenOptions | undefined;

export function indexedDbAvailable(factory?: IDBFactory): boolean {
  if (factory) return true;
  return typeof globalThis.indexedDB !== "undefined";
}

// Runs inside `onupgradeneeded` — raw IDBDatabase only (wrapping the
// database here aborts the versionchange transaction in fake-indexeddb).
function upgrade(db: IDBDatabase, oldVersion: number) {
  if (oldVersion < 1) {
    db.createObjectStore("meta", { keyPath: "key" });
  }
  if (oldVersion < 2) {
    // v2's original set — `entities` joined in v3 below.
    for (const name of ["projects", "knowledge", "sessions", "messageBlocks"]) {
      const store = db.createObjectStore(name, { keyPath: "key" });
      store.createIndex("by-scope", "scope");
      store.createIndex("by-accessed", "accessedAt");
      store.createIndex("by-stored", "storedAt");
    }
    db.createObjectStore("collections", { keyPath: "key" });
    const drafts = db.createObjectStore("drafts", { keyPath: "key" });
    drafts.createIndex("by-updated", "updatedAt");
    const pending = db.createObjectStore("pendingChanges", { keyPath: "key" });
    pending.createIndex("by-created", "createdAt");
  }
  if (oldVersion < 3) {
    const entities = db.createObjectStore("entities", { keyPath: "key" });
    entities.createIndex("by-scope", "scope");
    entities.createIndex("by-accessed", "accessedAt");
    entities.createIndex("by-stored", "storedAt");
  }
}

function hasAllStores(db: LoreUiDb): boolean {
  return ALL_STORES.every((name) => db.objectStoreNames.contains(name));
}

function tryOpen(
  factory: IDBFactory | undefined,
  blockedTimeoutMs: number,
): Promise<LoreUiDb | "blocked"> {
  return new Promise((resolve, reject) => {
    const idb = factory ?? globalThis.indexedDB;
    const request = idb.open(LORE_DB_NAME, LORE_DB_VERSION);
    // A `blocked` upgrade is surfaced by this timer; if the underlying
    // request later completes anyway, the orphaned connection is closed.
    let gaveUp = false;
    const timer = setTimeout(() => {
      gaveUp = true;
      resolve("blocked");
    }, blockedTimeoutMs);
    request.onupgradeneeded = (event) => {
      upgrade(request.result, event.oldVersion);
    };
    request.onblocked = () => undefined;
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error ?? new Error("IndexedDB open failed"));
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      const raw = request.result;
      if (gaveUp) {
        raw.close();
        return;
      }
      raw.onversionchange = () => {
        // Another tab wants to upgrade: close so it can proceed.
        void opening?.then((db) => db?.close());
        opening = null;
      };
      // The connection dying under us (browser clears storage) drops the
      // memo so the next openLoreDb() recreates it.
      raw.onclose = () => {
        opening = null;
      };
      resolve(wrap(raw) as LoreUiDb);
    };
  });
}

async function openOnce(
  factory: IDBFactory | undefined,
  blockedTimeoutMs: number,
): Promise<LoreUiDb | null | "blocked"> {
  const db = await tryOpen(factory, blockedTimeoutMs);
  if (db === "blocked") return "blocked";
  if (!hasAllStores(db)) {
    // Corrupted or foreign database under our name.
    db.close();
    return null;
  }
  return db;
}

async function deleteLoreDb(factory: IDBFactory | undefined): Promise<void> {
  if (factory) {
    await new Promise<void>((resolve, reject) => {
      const request = factory.deleteDatabase(LORE_DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () =>
        reject(request.error ?? new Error("IndexedDB delete failed"));
      request.onblocked = () => resolve();
    });
  } else {
    await deleteDB(LORE_DB_NAME);
  }
}

/** Delete the whole database so the next open recreates it cleanly. */
export async function resetCache(opts?: OpenOptions): Promise<void> {
  const options = opts ?? lastOptions;
  const pending = opening;
  opening = null;
  const db = await pending;
  if (db) db.close();
  await deleteLoreDb(options?.factory);
  options?.onStatus?.("reset");
}

/**
 * Opens (creating on first use) the UI database. Resolves `null` when
 * IndexedDB is unavailable or keeps failing after one reset+retry, so the
 * shell degrades to server-only instead of failing to render.
 */
export function openLoreDb(opts?: OpenOptions): Promise<LoreUiDb | null> {
  if (opts) lastOptions = opts;
  const options = opts ?? lastOptions;
  if (!indexedDbAvailable(options?.factory)) {
    options?.onStatus?.("unavailable");
    return Promise.resolve(null);
  }
  if (opening) return opening;

  const blockedTimeoutMs = options?.blockedTimeoutMs ?? 3000;
  opening = (async () => {
    let db = await openOnce(options?.factory, blockedTimeoutMs);
    if (db === "blocked") {
      options?.onStatus?.("blocked");
      opening = null;
      return null;
    }
    if (db === null) {
      // Missing stores → delete and try once more. (`deleteLoreDb`, not
      // `resetCache`: `opening` is the very promise being computed here, so
      // awaiting it would self-deadlock.)
      await deleteLoreDb(options?.factory).catch(() => undefined);
      db = await openOnce(options?.factory, blockedTimeoutMs).catch(() => null);
      if (db === null || db === "blocked") {
        options?.onStatus?.(db === "blocked" ? "blocked" : "unavailable");
        opening = null;
        return null;
      }
    }
    options?.onStatus?.("ready");
    return db;
  })().catch(async () => {
    // Open rejected (e.g. VersionError: a higher version exists) → delete,
    // retry once, then give up.
    await deleteLoreDb(options?.factory).catch(() => undefined);
    const retry = await openOnce(options?.factory, blockedTimeoutMs).catch(
      () => null,
    );
    if (retry === null || retry === "blocked") {
      options?.onStatus?.("unavailable");
      opening = null;
      return null;
    }
    options?.onStatus?.("ready");
    return retry;
  });
  return opening;
}

/** Close the memoised connection; the next `openLoreDb` reopens. Test-only. */
export async function closeLoreDb(): Promise<void> {
  const pending = opening;
  opening = null;
  const db = await pending;
  if (db) db.close();
}
