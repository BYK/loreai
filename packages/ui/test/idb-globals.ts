/**
 * Registers fake-indexeddb's IDB classes as globals (NOT `indexedDB` itself)
 * so `idb`'s `wrap()`/`openDB()` `instanceof` checks work under jsdom — which
 * ships no IndexedDB globals. `openLoreDb()` without an injected factory
 * therefore still resolves `null`, keeping non-db tests deterministic.
 */
import {
  IDBCursor,
  IDBCursorWithValue,
  IDBDatabase,
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBOpenDBRequest,
  IDBRequest,
  IDBTransaction,
  IDBVersionChangeEvent,
} from "fake-indexeddb";

Object.assign(globalThis, {
  IDBCursor,
  IDBCursorWithValue,
  IDBDatabase,
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBOpenDBRequest,
  IDBRequest,
  IDBTransaction,
  IDBVersionChangeEvent,
});

export { IDBFactory };
