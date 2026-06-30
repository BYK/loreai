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
//            are searched by the FLAT vec0 KNN (exact recall). The base BLOB
//            columns are dropped once a DB file is fully cut over.
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
 *   - `vec0`         vec0 layout, sqlite-vec loaded → FLAT vec0 KNN (exact).
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

/**
 * `kv_meta` key recording the vector dimension the `vec0` tables were created
 * with. vec0 fixes the dimension at DDL time (`float[N]`), but the embedding
 * dimension is configurable (768 local / 1024 voyage / 1536 openai). On a
 * dimension change {@link ensureVec0Store} drops + recreates the tables.
 */
export const VEC_DIMENSION_KEY = "vec.dimension";

/** Logical table → physical base table name. */
const BASE_TABLE: Record<EmbeddingTable, string> = {
  knowledge: "knowledge",
  entities: "entities",
  distillations: "distillations",
  temporal: "temporal_messages",
};

/** Logical table → `vec0` virtual table name. */
const VEC_TABLE: Record<EmbeddingTable, string> = {
  knowledge: "knowledge_vec",
  entities: "entity_vec",
  distillations: "distillation_vec",
  temporal: "temporal_vec",
};

/**
 * DDL for the four `vec0` tables at vector dimension `dim`. Uses the FLAT
 * (default float) vec0 index — EXACT recall (1.0) with PARTITION KEY filter
 * pushdown. (DiskANN was evaluated and rejected: it supports neither partition
 * keys nor metadata columns, inserts ~400× slower, and is only approximate; it
 * is not even compiled into the upstream `sqlite-vec` build we ship.) Partition
 * keys shard the index so a
 * session/project-scoped query touches only the matching rows; `temporal_vec`
 * is chunk-keyed (`chunk_id`, `+message_id`) ahead of multi-vector chunking
 * (single-vector era writes exactly one chunk per message: `chunk_id = id#0`).
 * `CREATE … IF NOT EXISTS` so the routine is idempotent / re-runnable.
 */
export function vec0Ddl(dim: number): string[] {
  return [
    `CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_vec USING vec0(id TEXT PRIMARY KEY, embedding float[${dim}] distance_metric=cosine)`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS entity_vec USING vec0(id TEXT PRIMARY KEY, embedding float[${dim}] distance_metric=cosine)`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS distillation_vec USING vec0(id TEXT PRIMARY KEY, project_id TEXT PARTITION KEY, +session_id TEXT, embedding float[${dim}] distance_metric=cosine)`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS temporal_vec USING vec0(chunk_id TEXT PRIMARY KEY, +message_id TEXT, project_id TEXT PARTITION KEY, session_id TEXT PARTITION KEY, embedding float[${dim}] distance_metric=cosine)`,
  ];
}

/** The four `vec0` virtual table names, in dependency-free order. */
export const VEC_TABLES = Object.freeze([
  "knowledge_vec",
  "entity_vec",
  "distillation_vec",
  "temporal_vec",
]) as readonly string[];

/** Minimal connection shape for reading the stored storage mode. */
export interface StorageModeConn {
  query(sql: string): { get(...params: unknown[]): unknown };
}

/**
 * Connection shape for writing embeddings and managing the vec0 store. The
 * vec0 write paths additionally need `get` (look up a row's partition values /
 * the stored dimension) and `all` (none today, kept for symmetry), so this is a
 * superset of {@link StorageModeConn}. Satisfied by both node:sqlite and
 * bun:sqlite connections (and the traced `db()` Proxy).
 */
export interface EmbeddingWriteConn {
  query(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
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
 * write layout lives in one place. Branches on this DB's {@link VecStorageMode}:
 *   - `blob` → write the Float32 vector as a BLOB on the base row;
 *   - `vec0` → replace the row in the table's `vec0` index (DELETE-by-key then
 *     INSERT — vec0 has no `INSERT OR REPLACE`/UPSERT; partition/aux values are
 *     read from the base row, which the caller has already inserted).
 *
 * Uses `conn.query()` so the prepared statement is driver-cached across
 * backfill-loop calls.
 */
export function storeEmbedding(
  conn: EmbeddingWriteConn,
  table: EmbeddingTable,
  id: string,
  vec: Float32Array,
): void {
  if (readStorageMode(conn) === "vec0") {
    storeEmbeddingVec0(conn, table, id, vec);
    return;
  }
  conn
    .query(`UPDATE ${BASE_TABLE[table]} SET embedding = ? WHERE id = ?`)
    .run(toBlob(vec), id);
}

/**
 * `vec0` write path for {@link storeEmbedding}. `knowledge`/`entities` key
 * directly on `id`; `distillations`/`temporal` read their immutable partition
 * (and aux) values from the just-written base row. If the base row is gone (a
 * delete raced the fire-and-forget embed), there is nothing to index — skip.
 */
function storeEmbeddingVec0(
  conn: EmbeddingWriteConn,
  table: EmbeddingTable,
  id: string,
  vec: Float32Array,
): void {
  const blob = toBlob(vec);
  // vec0 in our pinned sqlite-vec supports neither `INSERT OR REPLACE` nor
  // `ON CONFLICT … DO UPDATE` on virtual tables, so an upsert is DELETE-by-key
  // then INSERT. The DELETE is a no-op on first write and removes the prior
  // index row on a re-embed. A crash in the two-statement gap leaves the base
  // row without an index row; for knowledge/entities/distillations startup
  // backfill re-indexes any base row missing from its vec0 table. temporal has
  // no startup backfill and DOES re-embed on content update (see temporal.ts
  // store()), so a crash in that gap silently drops one message's vector until
  // the next re-embed of the same id. The window is two adjacent synchronous
  // statements (sub-ms) and the blast radius is one message missing from vector
  // (not FTS) recall — bounded and non-corrupting, hence left unguarded here.
  switch (table) {
    case "knowledge":
      conn.query("DELETE FROM knowledge_vec WHERE id = ?").run(id);
      conn
        .query("INSERT INTO knowledge_vec(id, embedding) VALUES (?, ?)")
        .run(id, blob);
      return;
    case "entities":
      conn.query("DELETE FROM entity_vec WHERE id = ?").run(id);
      conn
        .query("INSERT INTO entity_vec(id, embedding) VALUES (?, ?)")
        .run(id, blob);
      return;
    case "distillations": {
      const row = conn
        .query("SELECT project_id, session_id FROM distillations WHERE id = ?")
        .get(id) as
        | { project_id: string; session_id: string }
        | null
        | undefined;
      if (!row) return;
      conn.query("DELETE FROM distillation_vec WHERE id = ?").run(id);
      conn
        .query(
          "INSERT INTO distillation_vec(id, project_id, session_id, embedding) VALUES (?, ?, ?, ?)",
        )
        .run(id, row.project_id, row.session_id, blob);
      return;
    }
    case "temporal": {
      const row = conn
        .query(
          "SELECT project_id, session_id FROM temporal_messages WHERE id = ?",
        )
        .get(id) as
        | { project_id: string; session_id: string }
        | null
        | undefined;
      if (!row) return;
      const chunkId = `${id}#0`;
      conn.query("DELETE FROM temporal_vec WHERE chunk_id = ?").run(chunkId);
      conn
        .query(
          "INSERT INTO temporal_vec(chunk_id, message_id, project_id, session_id, embedding) VALUES (?, ?, ?, ?, ?)",
        )
        .run(chunkId, id, row.project_id, row.session_id, blob);
      return;
    }
  }
}

/**
 * Persist the MULTI-VECTOR embedding for one temporal message: one `temporal_vec`
 * chunk per part-aware unit (see `buildEmbeddingUnits`), keyed `<messageId>#<ord>`.
 *
 * vec0-only — the `blob` layout has a single `embedding` column per row and so
 * cannot hold N vectors; the caller keeps a single part-selective vector there
 * via {@link storeEmbedding}. NO-OP outside vec0 mode.
 *
 * Re-embed semantics: a content update calls this again, so it first DELETEs
 * ALL chunks of the message (by the aux `message_id`) then re-inserts the new
 * set — vec0 has no upsert, and the chunk count can change between embeds, so a
 * per-`chunk_id` replace would orphan now-removed ords. Partition (and aux)
 * values come from the just-written base row; if it is gone (a delete raced the
 * fire-and-forget embed) there is nothing to index — skip. The DELETE + N
 * INSERTs are left unguarded (matching {@link storeEmbedding}'s vec0 path): a
 * crash mid-loop leaves the message with fewer chunks until its next re-embed —
 * bounded, non-corrupting, and the read collapses whatever chunks exist.
 */
export function storeTemporalChunks(
  conn: EmbeddingWriteConn,
  messageId: string,
  vecs: Float32Array[],
): void {
  if (readStorageMode(conn) !== "vec0") return;
  const row = conn
    .query("SELECT project_id, session_id FROM temporal_messages WHERE id = ?")
    .get(messageId) as
    | { project_id: string; session_id: string }
    | null
    | undefined;
  if (!row) return;
  conn.query("DELETE FROM temporal_vec WHERE message_id = ?").run(messageId);
  const insert = conn.query(
    "INSERT INTO temporal_vec(chunk_id, message_id, project_id, session_id, embedding) VALUES (?, ?, ?, ?, ?)",
  );
  for (let ord = 0; ord < vecs.length; ord++) {
    insert.run(
      `${messageId}#${ord}`,
      messageId,
      row.project_id,
      row.session_id,
      toBlob(vecs[ord]),
    );
  }
}

/**
 * Delete the embeddings for `ids` on `table`.
 *
 * NO-OP in blob layout: the embedding lives on the base row, so whatever deleted
 * the base row already removed it. Only the `vec0` layout keeps a separate index
 * row that must be deleted explicitly. `temporal_vec` is chunk-keyed, so it is
 * deleted by the aux `message_id` column (removes every chunk of each message).
 * Chunked under SQLite's bound-variable ceiling.
 */
export function deleteEmbeddings(
  conn: EmbeddingWriteConn,
  table: EmbeddingTable,
  ids: string[],
): void {
  if (!ids.length) return;
  if (readStorageMode(conn) !== "vec0") return;
  const vt = VEC_TABLE[table];
  const keyCol = table === "temporal" ? "message_id" : "id";
  const CHUNK = 900;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK);
    const ph = batch.map(() => "?").join(",");
    conn.query(`DELETE FROM ${vt} WHERE ${keyCol} IN (${ph})`).run(...batch);
  }
}

/**
 * Clear ALL embeddings across all four tables — used when the embedding config
 * changes (provider/model swap, same dimension) and every stored vector becomes
 * incompatible. Blob layout NULLs the base BLOB columns; vec0 layout empties the
 * `vec0` tables. (A *dimension* change additionally requires recreating the
 * fixed-width vec0 tables — see {@link ensureVec0Store}.)
 */
export function clearAllEmbeddings(conn: EmbeddingWriteConn): void {
  if (readStorageMode(conn) === "vec0") {
    for (const vt of VEC_TABLES) conn.query(`DELETE FROM ${vt}`).run();
    return;
  }
  conn.query("UPDATE knowledge SET embedding = NULL").run();
  conn.query("UPDATE distillations SET embedding = NULL").run();
  conn.query("UPDATE temporal_messages SET embedding = NULL").run();
  conn.query("UPDATE entities SET embedding = NULL").run();
}

// ---------------------------------------------------------------------------
// vec0 store lifecycle (DDL + kv_meta bookkeeping)
// ---------------------------------------------------------------------------

/**
 * Read the dimension the `vec0` tables were created with (kv_meta
 * {@link VEC_DIMENSION_KEY}), or `null` when unset / unparseable. Mirrors
 * {@link readStorageMode}'s defensive read.
 */
export function readVecDimension(conn: StorageModeConn): number | null {
  try {
    const row = conn
      .query("SELECT value FROM kv_meta WHERE key = ?")
      .get(VEC_DIMENSION_KEY) as { value?: string } | null | undefined;
    const n = row?.value != null ? Number(row.value) : Number.NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function setKv(conn: EmbeddingWriteConn, key: string, value: string): void {
  conn
    .query(
      "INSERT INTO kv_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
    )
    .run(key, value, value);
}

/** Persist this DB file's {@link VecStorageMode}. */
export function setStorageMode(
  conn: EmbeddingWriteConn,
  mode: VecStorageMode,
): void {
  setKv(conn, VEC_STORAGE_MODE_KEY, mode);
}

/**
 * Idempotently ensure the four `vec0` tables exist at vector dimension `dim`.
 *
 * - First call / already at `dim`: `CREATE … IF NOT EXISTS` (no-op if present).
 * - Stored dimension differs from `dim` (provider/model dimension swap): DROP +
 *   recreate at `dim`. The fixed-width vec0 tables cannot hold the new width;
 *   callers clear + re-embed around this, so dropping the rows is expected.
 *
 * Records `dim` under {@link VEC_DIMENSION_KEY}. Does NOT flip the storage mode
 * or backfill — see the cutover in embedding.ts. Re-runnable: a crash between
 * the DROP and the CREATE just re-runs both next time (`IF (NOT) EXISTS`).
 */
export function ensureVec0Store(conn: EmbeddingWriteConn, dim: number): void {
  const storedDim = readVecDimension(conn);
  if (storedDim !== null && storedDim !== dim) {
    for (const vt of VEC_TABLES) conn.query(`DROP TABLE IF EXISTS ${vt}`).run();
  }
  for (const ddl of vec0Ddl(dim)) conn.query(ddl).run();
  setKv(conn, VEC_DIMENSION_KEY, String(dim));
}

// ---------------------------------------------------------------------------
// blob → vec0 cutover helpers (pure SQL relocation; no re-embedding)
// ---------------------------------------------------------------------------

/** Whether the base table for `table` still has its `embedding` BLOB column.
 *  The cutover drops it per table; this gates the per-table copy so a re-run
 *  after a partial cutover skips already-migrated tables (the v55 boot-loop
 *  lesson — never read a dropped column). */
export function embeddingColumnExists(
  conn: EmbeddingWriteConn,
  table: EmbeddingTable,
): boolean {
  try {
    const rows = conn
      .query(`PRAGMA table_info(${BASE_TABLE[table]})`)
      .all() as Array<{ name: string }>;
    return rows.some((r) => r.name === "embedding");
  } catch {
    return false;
  }
}

/**
 * Copy existing blob embeddings on `table` into its `vec0` index via an
 * idempotent `INSERT … SELECT` that skips ids already present (FLAT vec0 inserts
 * at ~0.12 ms/vec, so even 106K temporal rows finish in ~13 s). Pure relocation
 * — no re-embedding.
 * Knowledge copies from `knowledge_current` so only current-version ids land in
 * `knowledge_vec` (matching the read-path join); temporal derives the
 * single-vector-era `chunk_id` (`id || '#0'`) and carries partition + aux values.
 */
export function copyBlobsToVec0(
  conn: EmbeddingWriteConn,
  table: EmbeddingTable,
): void {
  // vec0 (our pinned sqlite-vec) has no `INSERT OR REPLACE`, so idempotence /
  // resumability comes from skipping ids already present in the vec0 table via
  // `WHERE … NOT IN (SELECT <pk> FROM <vec0>)`. On the first pass the vec0 table
  // is empty so every eligible row copies; a re-run after a partial copy only
  // inserts the remainder. Embeddings are static during the one-time cutover, so
  // skipping an already-copied id (rather than replacing it) is equivalent.
  switch (table) {
    case "knowledge":
      conn
        .query(
          "INSERT INTO knowledge_vec(id, embedding) SELECT id, embedding FROM knowledge_current WHERE embedding IS NOT NULL AND id NOT IN (SELECT id FROM knowledge_vec)",
        )
        .run();
      return;
    case "entities":
      conn
        .query(
          "INSERT INTO entity_vec(id, embedding) SELECT id, embedding FROM entities WHERE embedding IS NOT NULL AND id NOT IN (SELECT id FROM entity_vec)",
        )
        .run();
      return;
    case "distillations":
      conn
        .query(
          "INSERT INTO distillation_vec(id, project_id, session_id, embedding) SELECT id, project_id, session_id, embedding FROM distillations WHERE embedding IS NOT NULL AND id NOT IN (SELECT id FROM distillation_vec)",
        )
        .run();
      return;
    case "temporal":
      conn
        .query(
          "INSERT INTO temporal_vec(chunk_id, message_id, project_id, session_id, embedding) SELECT id || '#0', id, project_id, session_id, embedding FROM temporal_messages WHERE embedding IS NOT NULL AND (id || '#0') NOT IN (SELECT chunk_id FROM temporal_vec)",
        )
        .run();
      return;
  }
}

/** Drop the base `embedding` BLOB column for `table` (reclaims its space via
 *  SQLite's table rewrite). Presence-aware: a re-run after the column is gone
 *  swallows the "no such column" error. The `knowledge_current` view's `k.*`
 *  expands at query time, so it adapts automatically. */
export function dropEmbeddingColumn(
  conn: EmbeddingWriteConn,
  table: EmbeddingTable,
): void {
  try {
    conn.query(`ALTER TABLE ${BASE_TABLE[table]} DROP COLUMN embedding`).run();
  } catch {
    // already dropped on a prior (crashed) cutover run — idempotent.
  }
}

/**
 * Reclaim dangling `vec0` rows whose backing base row no longer exists — a bulk
 * project / session / prune delete removes base rows but not the separate vec0
 * rows. These rows are already HARMLESS for correctness (recall hydration drops
 * a hit whose base row is missing, and a deleted project's rows live in their
 * own partition), so this is a bloat / recall-quality backstop, not a fix. Run
 * once at startup in vec0 mode. `knowledge_vec` is pinned to CURRENT versions
 * (the read path joins `knowledge_current`); `temporal_vec` keys on the aux
 * `message_id`. One bounded pass per table.
 */
export function gcVec0DanglingRows(conn: EmbeddingWriteConn): void {
  conn
    .query(
      "DELETE FROM knowledge_vec WHERE id NOT IN (SELECT id FROM knowledge_current)",
    )
    .run();
  conn
    .query("DELETE FROM entity_vec WHERE id NOT IN (SELECT id FROM entities)")
    .run();
  conn
    .query(
      "DELETE FROM distillation_vec WHERE id NOT IN (SELECT id FROM distillations)",
    )
    .run();
  conn
    .query(
      "DELETE FROM temporal_vec WHERE message_id NOT IN (SELECT id FROM temporal_messages)",
    )
    .run();
}

// ---------------------------------------------------------------------------
// Mode-aware "missing/has embedding" predicates for backfill detection
// ---------------------------------------------------------------------------

function vecKeyCol(table: EmbeddingTable): string {
  return table === "temporal" ? "message_id" : "id";
}

/**
 * WHERE fragment selecting rows of `table` that are MISSING an embedding under
 * `mode`: blob → `embedding IS NULL`; vec0 → `id NOT IN (SELECT <key> FROM
 * <t>_vec)` (the blob column no longer exists in vec0 mode). `alias` prefixes
 * the base column reference (e.g. `"e"` → `e.id …`).
 */
export function missingEmbeddingSql(
  table: EmbeddingTable,
  mode: VecStorageMode,
  alias = "",
): string {
  const p = alias ? `${alias}.` : "";
  if (mode === "vec0") {
    return `${p}id NOT IN (SELECT ${vecKeyCol(table)} FROM ${VEC_TABLE[table]})`;
  }
  return `${p}embedding IS NULL`;
}

/** WHERE fragment selecting rows of `table` that HAVE an embedding under `mode`
 *  — the complement of {@link missingEmbeddingSql}. */
export function hasEmbeddingSql(
  table: EmbeddingTable,
  mode: VecStorageMode,
  alias = "",
): string {
  const p = alias ? `${alias}.` : "";
  if (mode === "vec0") {
    return `${p}id IN (SELECT ${vecKeyCol(table)} FROM ${VEC_TABLE[table]})`;
  }
  return `${p}embedding IS NOT NULL`;
}

/**
 * Resolve the FROM table + presence filter for a by-id embedding POINT read
 * (`… WHERE id IN (…)`, NOT a KNN — vec0 supports primary-key SELECTs without
 * `MATCH`, returning the stored vector as the same float32 BLOB). blob layout
 * reads the base table/view + `AND embedding IS NOT NULL`; vec0 layout reads the
 * `vec0` table (every row has a vector → no filter). The caller supplies its
 * blob-mode source (e.g. `knowledge_current`). Only the `id`, `embedding`, and —
 * for distillations — `session_id` columns are guaranteed on both layouts.
 * Id-keyed tables only (knowledge/entities/distillations); temporal is
 * chunk-keyed and not point-read this way.
 */
export function embeddingByIdSource(
  table: EmbeddingTable,
  mode: VecStorageMode,
  blobTable: string,
): { table: string; presenceFilter: string } {
  if (mode === "vec0") return { table: VEC_TABLE[table], presenceFilter: "" };
  return { table: blobTable, presenceFilter: " AND embedding IS NOT NULL" };
}
