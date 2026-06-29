// Embedding storage seam — the single source of truth for WHERE embeddings
// live and HOW a given connection should search them.
//
// Lore stores 768-dim Float32 embeddings in one of two layouts, recorded
// per-DB-file in `kv_meta` under {@link VEC_STORAGE_MODE_KEY}:
//
//   "blob" — embeddings live in an `embedding` BLOB column on each base table
//            (`knowledge`, `entities`, `distillations`, `temporal_messages`).
//            Searched by `vec_distance_cosine()` when sqlite-vec is loaded, or
//            the pure-JS brute force otherwise. This is the only mode today.
//   "vec0" — embeddings live in dedicated sqlite-vec `vec0` virtual tables and
//            are searched by DiskANN KNN. The base BLOB columns are dropped.
//            (Write + read cutover lands in a later PR; the type + plumbing are
//            introduced here so that change is small and behavioral.)
//
// The EFFECTIVE behavior of a connection is a function of BOTH the DB's stored
// layout AND whether sqlite-vec actually loaded on THAT connection (the two
// threads — main and each read-worker — load the extension independently). That
// product is collapsed into a single {@link VecReadMode} by {@link resolveReadMode}
// so callers never have to reason about the 2×2 matrix inline.
//
// This module MUST stay leaf-level — no `db()` singleton, no config, no provider
// chain — because the read-worker bundle imports it (same constraint as
// vector-query.ts). It takes the connection as a parameter.

import { toBlob } from "../vector-query";

/** How a DB file physically stores embeddings. Recorded in `kv_meta`. */
export type VecStorageMode = "blob" | "vec0";

/**
 * The resolved search strategy for one connection — the collapse of
 * (storage mode × sqlite-vec availability):
 *   - `blob-native`  blob layout, sqlite-vec loaded → `vec_distance_cosine()`.
 *   - `blob-js`      blob layout, no sqlite-vec → pure-JS brute force.
 *   - `vec0`         vec0 layout, sqlite-vec loaded → DiskANN KNN (PR4).
 *   - `degraded`     vec0 layout but sqlite-vec unavailable → vector recall is
 *                    impossible (no blobs to fall back to). Reads return `[]`,
 *                    writes no-op; FTS/keyword recall still works. Never crashes;
 *                    re-converges when next opened on a capable runtime.
 */
export type VecReadMode = "vec0" | "blob-native" | "blob-js" | "degraded";

/** The four embedding-bearing logical tables. `temporal` → `temporal_messages`. */
export type EmbeddingTable =
  | "knowledge"
  | "entities"
  | "distillations"
  | "temporal";

/** `kv_meta` key recording this DB file's {@link VecStorageMode}. */
export const VEC_STORAGE_MODE_KEY = "vec.storage_mode";

/** Logical table → physical base table name. */
const BASE_TABLE: Record<EmbeddingTable, string> = {
  knowledge: "knowledge",
  entities: "entities",
  distillations: "distillations",
  temporal: "temporal_messages",
};

/** Minimal connection shape for reading the stored storage mode. */
export interface StorageModeConn {
  query(sql: string): { get(...params: unknown[]): unknown };
}

/** Minimal connection shape for writing embeddings. */
export interface EmbeddingWriteConn {
  query(sql: string): { run(...params: unknown[]): unknown };
}

/**
 * Read this DB file's stored {@link VecStorageMode} from `kv_meta`.
 *
 * Defaults to `"blob"` when the key is absent (every DB today), holds an
 * unrecognized value, or the read throws — i.e. the safe layout that never
 * assumes vec0 tables exist. Cheap: a single indexed `kv_meta` lookup against
 * the caller's own connection (the prepared statement is driver-cached).
 */
export function readStorageMode(conn: StorageModeConn): VecStorageMode {
  try {
    const row = conn
      .query("SELECT value FROM kv_meta WHERE key = ?")
      .get(VEC_STORAGE_MODE_KEY) as { value?: string } | null | undefined;
    return row?.value === "vec0" ? "vec0" : "blob";
  } catch {
    // A missing kv_meta table or any read error → assume the safe blob layout.
    return "blob";
  }
}

/**
 * Collapse (storage mode × sqlite-vec availability) into the single
 * {@link VecReadMode} the query runner branches on. See {@link VecReadMode}.
 */
export function resolveReadMode(
  mode: VecStorageMode,
  vecAvailable: boolean,
): VecReadMode {
  if (mode === "vec0") return vecAvailable ? "vec0" : "degraded";
  return vecAvailable ? "blob-native" : "blob-js";
}

/**
 * Persist one embedding for `id` on `table`.
 *
 * Centralizes the previously-scattered `UPDATE … SET embedding = ?` sites so the
 * vec0 write path lands in exactly one place later. Today (blob layout) it
 * writes the Float32 vector as a BLOB on the base row. Uses `conn.query()` so
 * the prepared statement is driver-cached across backfill-loop calls (same cost
 * as the dedicated prepared statement the loops used before).
 */
export function storeEmbedding(
  conn: EmbeddingWriteConn,
  table: EmbeddingTable,
  id: string,
  vec: Float32Array,
): void {
  conn
    .query(`UPDATE ${BASE_TABLE[table]} SET embedding = ? WHERE id = ?`)
    .run(toBlob(vec), id);
}

/**
 * Clear ALL embeddings across all four tables — used when the embedding config
 * changes (provider/model/dimension swap) and every stored vector becomes
 * incompatible. Today (blob layout) it NULLs the base BLOB columns; the vec0
 * layout will instead empty the vec0 tables.
 */
export function clearAllEmbeddings(conn: EmbeddingWriteConn): void {
  conn.query("UPDATE knowledge SET embedding = NULL").run();
  conn.query("UPDATE distillations SET embedding = NULL").run();
  conn.query("UPDATE temporal_messages SET embedding = NULL").run();
  conn.query("UPDATE entities SET embedding = NULL").run();
}
