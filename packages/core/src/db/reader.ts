// Read-only SQLite connection factory for the vector-search worker pool.
//
// Each worker in the pool opens its OWN connection to the same WAL database
// file via this factory. SQLite WAL mode supports one writer (the main thread)
// plus many concurrent readers, so these connections read a consistent
// snapshot without contending with the main thread's writes.
//
// Crucially this is NOT the `db()` singleton path: it runs NO migrations and
// installs NO sync-capture triggers (the main thread owns the schema and is the
// sole writer). It only:
//   1. opens the connection,
//   2. sets a busy timeout (so a brief writer lock retries instead of throwing),
//   3. sets `query_only = TRUE` — a hard SQLite-level guarantee that this
//      connection can never write. This also sidesteps the read-only-open
//      WAL/-shm creation quirk (a true `readonly` open can't create the -shm
//      file; here we open read/write but forbid writes), and
//   4. loads sqlite-vec on this connection (independent of the main thread's
//      loader state) so the worker can use the native fast path when available.

import { Database } from "#db/driver";
import { loadVecForConnection } from "./vec";

export interface ReaderConnection {
  /** The read-only connection. Only SELECTs are permitted (query_only). */
  db: Database;
  /** Whether sqlite-vec loaded on THIS connection (native fast path usable). */
  vecAvailable: boolean;
}

/**
 * Open a query-only reader connection to the database at `path` and load
 * sqlite-vec on it. Never runs migrations or installs triggers. The caller
 * owns the returned connection's lifetime (close it on worker shutdown).
 */
export function openReaderConnection(path: string): ReaderConnection {
  const database = new Database(path);
  // Retry briefly when the main thread holds the write lock instead of
  // throwing SQLITE_BUSY immediately.
  database.exec("PRAGMA busy_timeout = 5000");
  // We only ever SELECT. Make that a hard guarantee and avoid the read-only
  // open WAL/-shm quirk (see file header).
  database.exec("PRAGMA query_only = TRUE");
  const vecAvailable = loadVecForConnection(database);
  return { db: database, vecAvailable };
}
