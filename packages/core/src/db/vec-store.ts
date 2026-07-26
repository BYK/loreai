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

/**
 * `kv_meta` key recording the temporal_vec partition layout version.
 *   - absent / undefined → original layout (project_id + session_id as
 *     compound PARTITION KEY, creating ~3 MB chunk per active session).
 *   - `"project_only"`   → rebuilt with project_id as sole PARTITION KEY;
 *     session_id is a stored aux column (`+session_id`).
 * Set atomically inside the vec0_rebuild savepoint.
 */
export const TEMPORAL_PARTITION_MODE_KEY = "vec.temporal_partition_mode";

/**
 * `kv_meta` key recording the `chunk_size` option used on `temporal_vec`. The
 * default sqlite-vec chunk holds 1024 vectors (~3 MB at 768 dims); Lore uses
 * 64 slots (~192 KB) so a sparse project partition does not reserve megabytes
 * for empty slots. Recorded atomically inside the rebuild savepoint so future
 * readers know the table is the compact variant and skip the redundant rebuild.
 */
export const TEMPORAL_CHUNK_SIZE_KEY = "vec.temporal_chunk_size";

/** sqlite-vec slots per temporal chunk (~192 KB at 768 dims). */
export const TEMPORAL_CHUNK_SIZE = 64;

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
 * keys shard the index so a project-scoped query touches only the matching
 * rows; `temporal_vec` uses `project_id` as the sole PARTITION KEY (removed
 * `session_id` from the partition tuple in PR #1494 to avoid ~10.5 GB chunk-
 * per-session over-allocation — 3,730 session partitions each needing a 3 MB
 * chunk at 8% utilization). `session_id` is retained as a stored aux column
 * (`+session_id`) for post-filter. `temporal_vec` is chunk-keyed (`chunk_id`,
 * `+message_id`) ahead of multi-vector chunking (single-vector era writes
 * exactly one chunk per message: `chunk_id = id#0`).
 * `CREATE … IF NOT EXISTS` so the routine is idempotent / re-runnable.
 */
export function vec0Ddl(dim: number): string[] {
  return [
    `CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_vec USING vec0(id TEXT PRIMARY KEY, embedding float[${dim}] distance_metric=cosine)`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS entity_vec USING vec0(id TEXT PRIMARY KEY, embedding float[${dim}] distance_metric=cosine)`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS distillation_vec USING vec0(id TEXT PRIMARY KEY, project_id TEXT PARTITION KEY, +session_id TEXT, embedding float[${dim}] distance_metric=cosine)`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS temporal_vec USING vec0(chunk_id TEXT PRIMARY KEY, +message_id TEXT, +session_id TEXT, project_id TEXT PARTITION KEY, embedding float[${dim}] distance_metric=cosine, chunk_size=${TEMPORAL_CHUNK_SIZE})`,
  ];
}

/** The four `vec0` virtual table names, in dependency-free order. */
export const VEC_TABLES = Object.freeze([
  "knowledge_vec",
  "entity_vec",
  "distillation_vec",
  "temporal_vec",
]);

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
 * Defaults to `"blob"` when the key is absent (every DB today) or holds an
 * unrecognized value — i.e. the safe layout that never assumes vec0 tables
 * exist.
 *
 * STICKY vec0 LATCH: the storage mode is monotonic — the cutover in
 * embedding.ts only ever flips blob→vec0 and (per its own invariant comment)
 * never reverts. Once we have observed `"vec0"` for the active DB connection we
 * return `"vec0"` unconditionally, even if a later `kv_meta` read throws. This
 * closes a TOCTOU race: the cutover flips the mode to vec0 and THEN drops the
 * base `embedding` columns, so once vec0 is live the base columns are gone. A
 * transient `kv_meta` read error (e.g. SQLITE_BUSY while the cutover is
 * checkpointing, or a concurrent curation pass) would otherwise fall back to
 * `"blob"` and route a query at the now-dropped `embedding` column, throwing
 * `no such column: embedding`. The latch is reset by {@link resetVecStorageModeLatch}
 * on connection close/swap (wired into `resetVecState`), so a test that swaps
 * to a fresh blob DB is never poisoned by a prior vec0 observation.
 *
 * The throw path still returns `"blob"` when vec0 has NOT yet been observed:
 * that is the brand-new-DB case (`kv_meta` table missing → THROWS), where the
 * base columns are guaranteed to still exist and blob is the correct, safe
 * layout.
 *
 * Cheap: a single indexed `kv_meta` lookup against the caller's own connection
 * (the prepared statement is driver-cached); a hot vec0 DB short-circuits before
 * touching SQLite at all.
 */
let observedVec0 = false;

/**
 * Reset the sticky vec0 storage-mode latch. Call whenever the DB connection is
 * closed or swapped (wired into `resetVecState`) so a subsequent fresh DB is
 * evaluated from scratch rather than inheriting a prior file's vec0 state.
 */
export function resetVecStorageModeLatch(): void {
  observedVec0 = false;
}

export function readStorageMode(conn: StorageModeConn): VecStorageMode {
  // Monotonic: once vec0 is live for this connection it never reverts, and the
  // base embedding columns have been dropped — never fall back to blob again.
  if (observedVec0) return "vec0";
  try {
    const row = conn
      .query("SELECT value FROM kv_meta WHERE key = ?")
      .get(VEC_STORAGE_MODE_KEY) as { value?: string } | null | undefined;
    if (row?.value === "vec0") {
      observedVec0 = true;
      return "vec0";
    }
    return "blob";
  } catch {
    // A missing kv_meta table or any read error → assume the safe blob layout.
    // Safe because we only reach here when vec0 has NOT yet been observed, i.e.
    // the base embedding columns still exist (the cutover drops them strictly
    // AFTER flipping the mode, and a successful vec0 read latches above).
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
  // Keep the sticky read latch consistent with the authoritative write so a
  // subsequent throwing `readStorageMode` (SQLITE_BUSY during the cutover
  // checkpoint, concurrent curation) never disagrees with what we just wrote.
  // Production only ever writes "vec0" (monotonic cutover); "blob" is written
  // by tests reverting the layout, and clearing the latch there keeps them honest.
  if (mode === "vec0") observedVec0 = true;
  else observedVec0 = false;
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
  const temporalExisted = Boolean(
    conn
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(VEC_TABLE.temporal),
  );
  const recreating = storedDim !== null && storedDim !== dim;
  if (recreating) {
    for (const vt of VEC_TABLES) conn.query(`DROP TABLE IF EXISTS ${vt}`).run();
  }
  for (const ddl of vec0Ddl(dim)) conn.query(ddl).run();
  setKv(conn, VEC_DIMENSION_KEY, String(dim));
  // Only a table we created here is known to use the current project-only DDL.
  // A same-dimension existing table can be the pre-vacuum compound partition
  // layout; never mark it converted or a later vacuum would skip its rebuild.
  if (!temporalExisted || recreating) {
    setKv(conn, TEMPORAL_PARTITION_MODE_KEY, "project_only");
    setKv(conn, TEMPORAL_CHUNK_SIZE_KEY, String(TEMPORAL_CHUNK_SIZE));
  }
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
  dim: number,
): number {
  // vec0 (our pinned sqlite-vec) has no `INSERT OR REPLACE`, so idempotence /
  // resumability comes from skipping ids already present in the vec0 table via
  // `WHERE … NOT IN (SELECT <pk> FROM <vec0>)`. On the first pass the vec0 table
  // is empty so every eligible row copies; a re-run after a partial copy only
  // inserts the remainder. Embeddings are static during the one-time cutover, so
  // skipping an already-copied id (rather than replacing it) is equivalent.
  //
  // 🔴 Dimension guard (`length(embedding) = dim * 4`): a correctly-dimensioned
  // embedding is exactly `dim * 4` bytes (Float32 = 4 bytes/element). A legacy
  // blob written under a DIFFERENT embedding dimension (e.g. a short-lived
  // 384-dim window among today's 768-dim rows) would make sqlite-vec's
  // fixed-width vec0 INSERT throw "Expected N dimensions but received M" — and
  // because the copy is one bulk `INSERT … SELECT`, a SINGLE stale row aborts the
  // ENTIRE cutover, stranding the DB in blob mode on every subsequent startup.
  // Skip stale-dim blobs here instead: the row is simply absent from vec0 after
  // the copy, and the very next re-embed backfill in the same startup pass
  // regenerates every SEARCH-ELIGIBLE skipped row at the correct dimension from
  // its source text (knowledge/entities/distillations via `missingEmbeddingSql`
  // = NOT IN <vec table>; temporal via the full re-chunk walk in
  // backfillTemporalEmbeddings). Rows outside a backfill's own eligibility filter
  // (low-confidence knowledge, archived/empty distillations, sub-50-char
  // temporal) simply lose an already-unsearchable stale vector — no search
  // regression, since a wrong-dim blob is unusable in every mode anyway. Either
  // way, one bad row can never brick the migration for the whole corpus.
  //
  // Returns the number of stale-dim blobs skipped so the caller can surface a
  // one-time notice (this is rare corpus corruption an operator should see).
  const expectedBytes = dim * 4;
  const staleSkipped = (source: string): number =>
    (
      conn
        .query(
          `SELECT COUNT(*) AS n FROM ${source} WHERE embedding IS NOT NULL AND length(embedding) <> ${expectedBytes}`,
        )
        .get() as { n: number }
    ).n;
  switch (table) {
    case "knowledge": {
      const skipped = staleSkipped("knowledge_current");
      conn
        .query(
          `INSERT INTO knowledge_vec(id, embedding) SELECT id, embedding FROM knowledge_current WHERE embedding IS NOT NULL AND length(embedding) = ${expectedBytes} AND id NOT IN (SELECT id FROM knowledge_vec)`,
        )
        .run();
      return skipped;
    }
    case "entities": {
      const skipped = staleSkipped("entities");
      conn
        .query(
          `INSERT INTO entity_vec(id, embedding) SELECT id, embedding FROM entities WHERE embedding IS NOT NULL AND length(embedding) = ${expectedBytes} AND id NOT IN (SELECT id FROM entity_vec)`,
        )
        .run();
      return skipped;
    }
    case "distillations": {
      const skipped = staleSkipped("distillations");
      conn
        .query(
          `INSERT INTO distillation_vec(id, project_id, session_id, embedding) SELECT id, project_id, session_id, embedding FROM distillations WHERE embedding IS NOT NULL AND length(embedding) = ${expectedBytes} AND id NOT IN (SELECT id FROM distillation_vec)`,
        )
        .run();
      return skipped;
    }
    case "temporal": {
      const skipped = staleSkipped("temporal_messages");
      conn
        .query(
          `INSERT INTO temporal_vec(chunk_id, message_id, project_id, session_id, embedding) SELECT id || '#0', id, project_id, session_id, embedding FROM temporal_messages WHERE embedding IS NOT NULL AND length(embedding) = ${expectedBytes} AND (id || '#0') NOT IN (SELECT chunk_id FROM temporal_vec)`,
        )
        .run();
      return skipped;
    }
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

/** The anti-join that reclaims one vec table's dangling rows. `knowledge_vec` is
 *  pinned to CURRENT versions (the read path joins `knowledge_current`);
 *  `temporal_vec` keys on the aux `message_id` (one message → many chunks). */
const VEC0_DANGLING_SWEEP: Record<EmbeddingTable, string> = {
  knowledge:
    "DELETE FROM knowledge_vec WHERE id NOT IN (SELECT id FROM knowledge_current)",
  entities: "DELETE FROM entity_vec WHERE id NOT IN (SELECT id FROM entities)",
  distillations:
    "DELETE FROM distillation_vec WHERE id NOT IN (SELECT id FROM distillations)",
  temporal:
    "DELETE FROM temporal_vec WHERE message_id NOT IN (SELECT id FROM temporal_messages)",
};

const ALL_EMBEDDING_TABLES: readonly EmbeddingTable[] = [
  "knowledge",
  "entities",
  "distillations",
  "temporal",
];

/**
 * Reclaim dangling `vec0` rows whose backing base row no longer exists — a bulk
 * project / session / prune delete removes base rows but not the separate vec0
 * rows. These rows are already HARMLESS for correctness (recall hydration drops
 * a hit whose base row is missing, and a deleted project's rows live in their
 * own partition), so this is a bloat / recall-quality backstop, not a fix. Runs
 * at startup in vec0 mode (all tables) and after a bulk base-row delete (scoped
 * to the tables that delete touched — see `data.ts`). One bounded anti-join pass
 * per requested table; each is a single scan (cheaper than a per-id delete on
 * the un-indexed `temporal_vec.message_id` aux column for large id sets).
 */
export function gcVec0DanglingRows(
  conn: EmbeddingWriteConn,
  tables: readonly EmbeddingTable[] = ALL_EMBEDDING_TABLES,
): void {
  for (const t of tables) conn.query(VEC0_DANGLING_SWEEP[t]).run();
}

/** Rows re-pointed per pass — bounds memory when a whole-project merge moves a
 *  large `temporal_vec` (each row carries a full embedding blob). */
const REPARTITION_BATCH = 500;

/**
 * Re-point the `project_id` PARTITION KEY of a project's `temporal_vec` /
 * `distillation_vec` rows when their base rows move to another project (a session
 * move or a whole-project merge). vec0 rejects `UPDATE` on a PARTITION KEY column
 * ("UPDATE on partition key columns are not supported yet"), so we DELETE each
 * index row and re-INSERT it under `toProjectId`, preserving the stored embedding
 * and the (unchanged) `session_id`. No-op outside vec0 mode.
 *
 * `sessionIds`: when provided, restricts to those sessions (session move); when
 * omitted, moves EVERY row of `fromProjectId` (project merge).
 *
 * NOT best-effort — callers MUST run this inside the move transaction and let a
 * failure roll the whole move back. A stale partition key silently breaks
 * project-scoped vector recall for the moved rows and has no backstop: the row
 * is mis-partitioned, not orphaned, so `gcVec0DanglingRows` never repairs it.
 * (`knowledge_vec` / `entity_vec` have no partition key, so they need no move.)
 */
export function repartitionVec0Project(
  conn: EmbeddingWriteConn,
  fromProjectId: string,
  toProjectId: string,
  sessionIds?: string[],
): void {
  if (fromProjectId === toProjectId) return; // moving a row out of its own scope
  if (sessionIds && sessionIds.length === 0) return;
  if (readStorageMode(conn) !== "vec0") return;

  // One scope for a merge; chunk the session `IN (…)` list under the bound-var
  // ceiling for a session move. Draining `LIMIT`ed batches terminates because a
  // moved row's `project_id` no longer matches `fromProjectId` (guarded above so
  // from≠to keeps the working set shrinking).
  const scopes: Array<{ where: string; params: unknown[] }> =
    sessionIds === undefined
      ? [{ where: "project_id = ?", params: [fromProjectId] }]
      : chunkIds(sessionIds, 900).map((batch) => ({
          where: `project_id = ? AND session_id IN (${batch.map(() => "?").join(",")})`,
          params: [fromProjectId, ...batch],
        }));

  // Hoist the constant DELETE/INSERT statements (the SELECT's WHERE is dynamic).
  const delT = conn.query("DELETE FROM temporal_vec WHERE chunk_id = ?");
  const insT = conn.query(
    "INSERT INTO temporal_vec(chunk_id, message_id, project_id, session_id, embedding) VALUES (?, ?, ?, ?, ?)",
  );
  const delD = conn.query("DELETE FROM distillation_vec WHERE id = ?");
  const insD = conn.query(
    "INSERT INTO distillation_vec(id, project_id, session_id, embedding) VALUES (?, ?, ?, ?)",
  );

  for (const { where, params } of scopes) {
    // temporal_vec: chunk_id PK, +message_id aux, +session_id aux, project_id PARTITION KEY.
    const selT = `SELECT chunk_id, message_id, session_id, embedding FROM temporal_vec WHERE ${where} LIMIT ${REPARTITION_BATCH}`;
    for (;;) {
      const rows = conn.query(selT).all(...params) as Array<{
        chunk_id: string;
        message_id: string;
        session_id: string;
        embedding: Uint8Array;
      }>;
      if (rows.length === 0) break;
      for (const r of rows) delT.run(r.chunk_id);
      for (const r of rows)
        insT.run(
          r.chunk_id,
          r.message_id,
          toProjectId,
          r.session_id,
          r.embedding,
        );
    }
    // distillation_vec: id PK, project_id PARTITION, +session_id aux.
    const selD = `SELECT id, session_id, embedding FROM distillation_vec WHERE ${where} LIMIT ${REPARTITION_BATCH}`;
    for (;;) {
      const rows = conn.query(selD).all(...params) as Array<{
        id: string;
        session_id: string;
        embedding: Uint8Array;
      }>;
      if (rows.length === 0) break;
      for (const r of rows) delD.run(r.id);
      for (const r of rows)
        insD.run(r.id, toProjectId, r.session_id, r.embedding);
    }
  }
}

/** Split `ids` into chunks of at most `size` (SQLite bound-variable ceiling). */
function chunkIds(ids: string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/**
 * Rebuild a `vec0` table to re-pack its mostly-empty chunks and reclaim disk
 * space. vec0 allocates vectors in fixed-size chunks (default 1,024 slots ×
 * `dim` × 4 bytes ≈ 3 MB for 768-dim) partitioned by `(project_id,
 * session_id)`. Once a chunk is touched, the entire 3 MB stays allocated even
 * if most of its slots become empty — sqlite-vec has no `optimize` command
 * (upstream issues #54, #184, #185, #220 are all open). On a heavily-used DB
 * this is the dominant size contributor: temporal_vec at 8% slot utilization
 * means ~92% of its packed-chunk bytes are empty slots.
 *
 * Strategy: stage every row in a TEMP table, DROP the virtual table (which
 * drops all its shadow tables — `_chunks`, `_vector_chunks00`, `_rowids`,
 * `_auxiliary`, `_info`), re-CREATE it at the current dimension, and re-INSERT
 * the staged rows. The virtual-table INSERT path re-packs the vectors into the
 * minimum number of chunks (~⌈N / 1024⌉), so on a 311K-row temporal_vec at
 * 8% utilization this collapses ~3,800 chunks into ~305 — reclaiming ~10 GB.
 *
 * Runs the whole drop+recreate+insert inside a SAVEPOINT, so the rebuild is
 * atomic by construction — a crash mid-rebuild rolls back the staging table,
 * the virtual-table DROP, and the re-CREATE, leaving the DB exactly as it was.
 * The whole staged copy is held in the temp DB (~3 KB/row), so on a 311K-row
 * table this is ~1 GB of transient disk; run during a maintenance window, not
 * on the idle tick.
 *
 * Returns row + chunk counts so the caller can surface the reclaim. No-op
 * outside vec0 mode (no vec0 tables to rebuild) or when the table is missing.
 */
/** Run `fn` inside a SQLite SAVEPOINT on `conn`. On success the savepoint is
 *  released; on error it is rolled back and released, then the error is
 *  re-thrown. A SAVEPOINT (not BEGIN) makes this safe whether the caller is
 *  already inside a transaction (nested) or not (top-level). `name` must be a
 *  bare SQL identifier — interpolated, never bound. */
function withSavepointOn<T>(
  conn: EmbeddingWriteConn,
  name: string,
  fn: () => T,
): T {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `withSavepointOn: invalid savepoint name ${JSON.stringify(name)}`,
    );
  }
  conn.query(`SAVEPOINT ${name}`).run();
  try {
    const result = fn();
    conn.query(`RELEASE ${name}`).run();
    return result;
  } catch (e) {
    conn.query(`ROLLBACK TO ${name}`).run();
    conn.query(`RELEASE ${name}`).run();
    throw e;
  }
}

/**
 * Read the stored temporal_vec partition mode from kv_meta.
 * Returns `"project_only"` when already converted, or `null` for the original
 * compound-key layout (absent key = old layout).
 */
function readTemporalPartitionMode(conn: StorageModeConn): string | null {
  try {
    const row = conn
      .query("SELECT value FROM kv_meta WHERE key = ?")
      .get(TEMPORAL_PARTITION_MODE_KEY) as
      | { value?: string }
      | null
      | undefined;
    return row?.value != null ? row.value : null;
  } catch {
    return null;
  }
}

/**
 * Returns the recorded temporal vec0 chunk size, or `null` for legacy tables
 * (the rebuild path then unconditionally re-runs to pick up compact chunks).
 */
function readTemporalChunkSize(conn: StorageModeConn): number | null {
  try {
    const row = conn
      .query("SELECT value FROM kv_meta WHERE key = ?")
      .get(TEMPORAL_CHUNK_SIZE_KEY) as { value?: string } | null | undefined;
    const size = Number(row?.value);
    return Number.isSafeInteger(size) && size > 0 ? size : null;
  } catch {
    return null;
  }
}

export function vec0Rebuild(
  conn: EmbeddingWriteConn,
  table: EmbeddingTable,
): { rowsRebuilt: number; beforeChunks: number; afterChunks: number } {
  if (readStorageMode(conn) !== "vec0") {
    return { rowsRebuilt: 0, beforeChunks: 0, afterChunks: 0 };
  }
  const vt = VEC_TABLE[table];
  const chunksTable = `${vt}_chunks`;
  const exists = conn
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(vt);
  if (!exists) return { rowsRebuilt: 0, beforeChunks: 0, afterChunks: 0 };

  // The vec0 virtual table exists but its `_chunks` shadow table may not if a
  // prior rebuild crashed between DROP and re-CREATE. Treat that as "nothing
  // to rebuild" rather than throwing a cryptic `no such table` error.
  const chunksExists = conn
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(chunksTable);
  if (!chunksExists) return { rowsRebuilt: 0, beforeChunks: 0, afterChunks: 0 };

  // temporal-only: skip if already converted to project_only with compact
  // chunks. The first `lore data vacuum` after upgrading to the new DDL
  // converts the layout; subsequent runs have nothing to reclaim.
  if (
    table === "temporal" &&
    readTemporalPartitionMode(conn) === "project_only" &&
    readTemporalChunkSize(conn) === TEMPORAL_CHUNK_SIZE
  ) {
    return { rowsRebuilt: 0, beforeChunks: 0, afterChunks: 0 };
  }

  const dim = readVecDimension(conn);
  if (dim === null) return { rowsRebuilt: 0, beforeChunks: 0, afterChunks: 0 };

  // Stage all rows in a TEMP table (regular SQLite storage, not vec0), drop
  // the virtual table, recreate it via the canonical DDL, and re-insert.
  // `vec0Ddl` returns DDL for all four tables; find the one matching `vt`.
  const staging = `_rebuild_${vt}`;
  const ddl = vec0Ddl(dim).find((d) =>
    d.includes(`CREATE VIRTUAL TABLE IF NOT EXISTS ${vt} `),
  );
  if (!ddl) throw new Error(`vec0Rebuild: no DDL for ${vt} at dim=${dim}`);

  // The whole rebuild runs inside a SAVEPOINT so the staging table's CREATE
  // and DROP are transactional with the rest of the rebuild. On error the
  // savepoint rollback undoes both the staging table and the virtual-table
  // DROP/CREATE, leaving the DB exactly as it was before the rebuild — no
  // leaked `_rebuild_*` temp table, no missing vec0 table. This makes the
  // function safe-by-default: the caller does NOT need to wrap it in an outer
  // transaction (though wrapping is still fine — the savepoint nests).
  return withSavepointOn(conn, "vec0_rebuild", () => {
    const beforeChunks = (
      conn.query(`SELECT COUNT(*) AS n FROM ${chunksTable}`).get() as {
        n: number;
      }
    ).n;

    let stagedCount = 0;
    switch (table) {
      case "temporal":
        conn
          .query(
            `CREATE TEMP TABLE ${staging} AS SELECT chunk_id, message_id, project_id, session_id, embedding FROM ${vt}`,
          )
          .run();
        break;
      case "distillations":
        conn
          .query(
            `CREATE TEMP TABLE ${staging} AS SELECT id, project_id, session_id, embedding FROM ${vt}`,
          )
          .run();
        break;
      case "knowledge":
      case "entities":
        conn
          .query(
            `CREATE TEMP TABLE ${staging} AS SELECT id, embedding FROM ${vt}`,
          )
          .run();
        break;
    }
    stagedCount = (
      conn.query(`SELECT COUNT(*) AS n FROM ${staging}`).get() as { n: number }
    ).n;

    conn.query(`DROP TABLE ${vt}`).run();
    conn.query(ddl).run();

    switch (table) {
      case "temporal":
        conn
          .query(
            `INSERT INTO ${vt}(chunk_id, message_id, project_id, session_id, embedding) SELECT chunk_id, message_id, project_id, session_id, embedding FROM ${staging}`,
          )
          .run();
        break;
      case "distillations":
        conn
          .query(
            `INSERT INTO ${vt}(id, project_id, session_id, embedding) SELECT id, project_id, session_id, embedding FROM ${staging}`,
          )
          .run();
        break;
      case "knowledge":
      case "entities":
        conn
          .query(
            `INSERT INTO ${vt}(id, embedding) SELECT id, embedding FROM ${staging}`,
          )
          .run();
        break;
    }
    conn.query(`DROP TABLE ${staging}`).run();

    const afterChunks = (
      conn.query(`SELECT COUNT(*) AS n FROM ${chunksTable}`).get() as {
        n: number;
      }
    ).n;
    const rowsRebuilt = (
      conn.query(`SELECT COUNT(*) AS n FROM ${vt}`).get() as { n: number }
    ).n;
    // Paranoia: a rebuild that loses rows indicates a bug in the staging flow.
    // Surface it via the row count (caller can assert).
    if (rowsRebuilt !== stagedCount) {
      throw new Error(
        `vec0Rebuild(${vt}): staged ${stagedCount} rows but rebuilt table has ${rowsRebuilt}`,
      );
    }
    // Record the partition mode AND compact chunk size for temporal so
    // subsequent rebuilds see the table as already-converted and skip.
    if (table === "temporal") {
      setKv(conn, TEMPORAL_PARTITION_MODE_KEY, "project_only");
      setKv(conn, TEMPORAL_CHUNK_SIZE_KEY, String(TEMPORAL_CHUNK_SIZE));
    }
    return { rowsRebuilt, beforeChunks, afterChunks };
  });
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
