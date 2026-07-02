// Pure, dependency-light vector-search query logic.
//
// This module is the single source of truth for the cosine-similarity SQL and
// the JS brute-force fallback. It is imported by BOTH:
//   1. the main thread (embedding.ts), which runs it against the `db()`
//      singleton, and
//   2. the read-worker pool (vector-worker.ts), which runs it against each
//      worker's own read-only connection — off the main event loop.
//
// It MUST stay leaf-level: no transformers.js, no provider chain, no `db()`
// singleton, no config. The caller supplies the connection and a flag telling
// us which {@link VecReadMode} to run on THAT connection (the two threads load
// the extension independently, and the read mode collapses that capability with
// the DB's storage layout — see db/vec-store.ts). Keeping this self-contained is
// what lets the worker bundle stay tiny — see build plumbing in packages/gateway/script.

import type { VecReadMode } from "./db/vec-store";

/** A minimal structural view of a SQLite connection — just what the vector
 *  queries need. Satisfied by both node:sqlite and bun:sqlite connections. */
export interface VectorQueryConn {
  query(sql: string): {
    all(...params: unknown[]): unknown[];
  };
}

export type VectorHit = { id: string; similarity: number };

export type DistillationVectorHit = {
  id: string;
  session_id: string;
  similarity: number;
};

/** Discriminated description of one of the five vector searches. The query
 *  embedding is passed separately and STRUCTURED-CLONED across the worker
 *  boundary (~3 KB for 768 dims) — never transferred: a transfer would detach
 *  the caller's buffer and corrupt the in-process fallback that reuses it. */
export type VectorQuerySpec =
  | { kind: "knowledge"; limit: number; excludeCategories?: string[] }
  | { kind: "entities"; limit: number }
  | { kind: "distillations"; limit: number }
  | { kind: "allDistillations"; projectId: string; limit: number }
  | {
      kind: "temporal";
      projectId: string;
      limit: number;
      sessionId?: string;
    };

/**
 * Pure brute-force cap for `allDistillations` — fine for ~200 entries per
 * project. Safety-capped to prevent excessive CPU on long-running projects.
 */
export const MAX_DISTILLATION_VECTOR_ROWS = 500;

/**
 * Recency cap for the `temporal` brute-force scan — the most-recent N raw
 * messages (per project, or per session when session-scoped) that a vector
 * search will score.
 *
 * BLOB-STORE-ONLY — applies to the `blob-native` / `blob-js` read paths only.
 * ----------------------------------------------------------------------------
 * `temporal_messages` is the rawest, highest-cardinality tier (100K+ rows on
 * busy installs), and a brute-force `vectorSearch*` over it is an O(n) cosine
 * scan — the dominant cost behind the pathological recall latency in issue
 * #999. This cap bounds that expensive cosine work to a fixed window on the
 * runtimes that can ONLY brute-force (sqlite-vec unavailable, so the DB stays
 * in blob layout).
 *
 * Capping by `created_at DESC` (rather than randomly) is architecturally
 * coherent, not just a perf hack: the temporal tier is "recent raw context",
 * while older messages are distilled into the distillation tier, which recall
 * searches separately (see {@link MAX_DISTILLATION_VECTOR_ROWS}). So old
 * content stays reachable via distillations even though it ages out of the
 * temporal vector window.
 *
 * 🔴 The cap is NOT applied on the `vec0` path: a DB that cut over to `vec0`
 * storage serves temporal search from the FLAT-vec0 KNN index, which is
 * sublinear and sees the WHOLE corpus — the `ORDER BY created_at DESC LIMIT`
 * this constant drives exists only in the blob branches of `runTemporal`.
 */
export const MAX_TEMPORAL_VECTOR_ROWS = 4000;

/**
 * Over-fetch multiplier for `vec0` KNN reads that are post-filtered by a JOIN to
 * the base table (knowledge: `confidence`/`category`; distillations: `archived`
 * — mutable/cross-table predicates that can't be pushed into the vec0 `MATCH`).
 *
 * A vec0 `MATCH … AND k = N` returns exactly the N nearest rows; post-filter
 * attrition then drops the ones that fail the predicate, which could leave fewer
 * than `limit`. So we ask the index for {@link overfetchK}`(limit)` candidates
 * and re-`LIMIT` to `limit` after filtering. Reads with no post-filter
 * (entities, allDistillations, temporal) request `k = limit` directly.
 *
 * Unlike the blob {@link MAX_TEMPORAL_VECTOR_ROWS} / {@link MAX_DISTILLATION_VECTOR_ROWS}
 * recency caps, this is NOT a corpus-visibility limit — the vec0 index always
 * sees the whole corpus; this only widens the KNN candidate window.
 */
export const VEC0_FILTER_OVERFETCH = 4;

/**
 * Over-fetch multiplier for the chunk-keyed `temporal_vec` KNN read. A temporal
 * message has MANY chunks under multi-vector part-aware embedding (one per
 * text/reasoning/tool unit — see `buildEmbeddingUnits`), so a bare `k = limit`
 * could return `limit` *chunks* that collapse to far fewer than `limit` distinct
 * messages. So we ask the index for {@link TEMPORAL_CHUNK_OVERFETCH}`× limit`
 * chunk candidates, collapse them to messages by max-sim (a message scores as
 * its best-matching chunk), and re-`LIMIT` to `limit`. Tunable; clamped to
 * {@link VEC0_MAX_K}. Degenerate-safe: in the single-chunk-per-message era this
 * just widens a candidate window that the collapse reduces 1:1 — same result.
 */
export const TEMPORAL_CHUNK_OVERFETCH = 8;

/**
 * sqlite-vec's hard ceiling on a KNN `k` (`SQLITE_VEC_VEC0_K_MAX`): a `MATCH …
 * AND k = N` with N > 4096 errors. Every vec0 `k` we bind is clamped to this.
 */
export const VEC0_MAX_K = 4096;

/** Clamp a desired KNN candidate count to {@link VEC0_MAX_K}. */
function vecK(n: number): number {
  return Math.min(n, VEC0_MAX_K);
}

function overfetchK(limit: number): number {
  return vecK(Math.max(limit * VEC0_FILTER_OVERFETCH, limit + 50));
}

// ---------------------------------------------------------------------------
// Math + BLOB helpers (moved here from embedding.ts so the worker can share
// them without pulling in the provider chain). Re-exported from embedding.ts
// for backwards compatibility with existing `embedding.toBlob` call sites.
// ---------------------------------------------------------------------------

/**
 * Cosine similarity between two L2-normalized Float32Array vectors.
 * All vectors in the system (local ONNX, Voyage, OpenAI) are L2-normalized
 * at embedding time, so dot product === cosine similarity. This skips the
 * per-vector norm accumulations and sqrt calls (~2× faster).
 * Returns -1.0 to 1.0 where 1.0 = identical direction.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = a.length;
  let dot = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Maintain a bounded descending-sorted array of the top k items by score.
 * For small k (10–50) and moderate n (200–500), the O(n*k) insert is faster
 * than O(n log n) sort due to lower constant factors and no allocation.
 */
export function topKInsert<T extends { similarity: number }>(
  topK: T[],
  item: T,
  k: number,
): void {
  const score = item.similarity;
  const len = topK.length;
  if (len >= k && score <= topK[len - 1].similarity) return;
  // Binary search for insert position in the descending-sorted array
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (topK[mid].similarity > score) lo = mid + 1;
    else hi = mid;
  }
  topK.splice(lo, 0, item);
  if (topK.length > k) topK.length = k;
}

/** Convert Float32Array to Buffer for SQLite BLOB storage. */
export function toBlob(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/** Convert SQLite BLOB (Buffer/Uint8Array) back to Float32Array. */
export function fromBlob(blob: Buffer | Uint8Array): Float32Array {
  const bytes = new Uint8Array(blob);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

// ---------------------------------------------------------------------------
// Query runner
// ---------------------------------------------------------------------------

/**
 * Run one of the five vector searches against `conn`.
 *
 * `readMode` (resolved by the caller from the DB's storage layout × this
 * connection's sqlite-vec availability — see db/vec-store.ts) selects the
 * strategy:
 *   - `blob-native` uses the native `vec_distance_cosine()` scan, falling back
 *     to the pure-JS brute force on any error;
 *   - `blob-js` runs the pure-JS brute force directly;
 *   - `vec0` runs exact FLAT-vec0 KNN (`MATCH … AND k = ?`) over the whole
 *     corpus — no recency cap, since the index is sublinear, not brute force;
 *   - `degraded` (vec0 layout but no extension) returns `[]` — vector recall is
 *     impossible without the blobs, so we degrade gracefully rather than crash.
 * The blob and vec0 paths return the same ordering and scores for L2-normalized
 * vectors (the system-wide invariant) — see db/vec.ts.
 *
 * Returns `DistillationVectorHit[]` for `kind === "allDistillations"` and
 * `VectorHit[]` for every other kind. The two share the same row shape minus
 * `session_id`, so callers narrow by spec.kind.
 */
export function runVectorQuery(
  conn: VectorQueryConn,
  readMode: VecReadMode,
  queryEmbedding: Float32Array,
  spec: VectorQuerySpec,
): VectorHit[] | DistillationVectorHit[] {
  switch (spec.kind) {
    case "knowledge":
      return runKnowledge(conn, readMode, queryEmbedding, spec);
    case "entities":
      return runEntities(conn, readMode, queryEmbedding, spec.limit);
    case "distillations":
      return runDistillations(conn, readMode, queryEmbedding, spec.limit);
    case "allDistillations":
      return runAllDistillations(
        conn,
        readMode,
        queryEmbedding,
        spec.projectId,
        spec.limit,
      );
    case "temporal":
      return runTemporal(
        conn,
        readMode,
        queryEmbedding,
        spec.projectId,
        spec.limit,
        spec.sessionId,
      );
  }
}

/**
 * Defensive guard reached only after each helper has handled `degraded` (early
 * `return []`) and `vec0` (the FLAT-vec0 KNN branch) inline — so `readMode` here
 * is always `blob-native` or `blob-js`. If some future mode ever reaches it
 * unhandled it throws loudly rather than silently scanning the wrong layout.
 */
function assertBlobReadMode(readMode: VecReadMode): void {
  if (readMode === "vec0") {
    throw new Error("vec0 read path must be handled before assertBlobReadMode");
  }
}

function runKnowledge(
  conn: VectorQueryConn,
  readMode: VecReadMode,
  queryEmbedding: Float32Array,
  spec: { limit: number; excludeCategories?: string[] },
): VectorHit[] {
  if (readMode === "degraded") return [];
  const { limit, excludeCategories } = spec;
  if (readMode === "vec0") {
    // DiskANN-free FLAT vec0: exact KNN over the whole corpus (no recency cap).
    // Post-filter confidence/category (mutable / per-version) by joining the
    // current-version view; over-fetch so attrition leaves >= limit survivors,
    // and widen to a full scan if that still under-fills (blob-mode parity).
    const run = (k: number): VectorHit[] => {
      let sql =
        "WITH knn AS (SELECT id, distance FROM knowledge_vec WHERE embedding MATCH ? AND k = ?) " +
        "SELECT knn.id AS id, 1 - knn.distance AS similarity " +
        "FROM knn JOIN knowledge_current c ON c.id = knn.id WHERE c.confidence > 0.2";
      const params: unknown[] = [toBlob(queryEmbedding), k];
      if (excludeCategories?.length) {
        sql += ` AND c.category NOT IN (${excludeCategories.map(() => "?").join(",")})`;
        params.push(...excludeCategories);
      }
      sql += " ORDER BY knn.distance LIMIT ?";
      params.push(limit);
      return conn.query(sql).all(...params) as VectorHit[];
    };
    const k0 = overfetchK(limit);
    const hits = run(k0);
    // Post-filter attrition can leave < limit even when more valid rows exist
    // deeper; widen to the max KNN window (blob-mode parity, capped at 4096).
    return hits.length >= limit || k0 >= VEC0_MAX_K ? hits : run(VEC0_MAX_K);
  }
  assertBlobReadMode(readMode);
  if (readMode === "blob-native") {
    try {
      let sql =
        "SELECT id, 1 - vec_distance_cosine(embedding, ?) AS similarity FROM knowledge_current WHERE embedding IS NOT NULL AND confidence > 0.2";
      const params: unknown[] = [toBlob(queryEmbedding)];
      if (excludeCategories?.length) {
        sql += ` AND category NOT IN (${excludeCategories.map(() => "?").join(",")})`;
        params.push(...excludeCategories);
      }
      sql += " ORDER BY similarity DESC LIMIT ?";
      params.push(limit);
      return conn.query(sql).all(...params) as VectorHit[];
    } catch {
      // fall through to JS brute-force
    }
  }
  let sql =
    "SELECT id, embedding FROM knowledge_current WHERE embedding IS NOT NULL AND confidence > 0.2";
  const params: string[] = [];
  if (excludeCategories?.length) {
    sql += ` AND category NOT IN (${excludeCategories.map(() => "?").join(",")})`;
    params.push(...excludeCategories);
  }
  const rows = conn.query(sql).all(...params) as Array<{
    id: string;
    embedding: Buffer;
  }>;

  const topK: VectorHit[] = [];
  for (const row of rows) {
    const vec = fromBlob(row.embedding);
    const sim = cosineSimilarity(queryEmbedding, vec);
    topKInsert(topK, { id: row.id, similarity: sim }, limit);
  }
  return topK;
}

function runEntities(
  conn: VectorQueryConn,
  readMode: VecReadMode,
  queryEmbedding: Float32Array,
  limit: number,
): VectorHit[] {
  if (readMode === "degraded") return [];
  if (readMode === "vec0") {
    return conn
      .query(
        "SELECT id, 1 - distance AS similarity FROM entity_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance",
      )
      .all(toBlob(queryEmbedding), vecK(limit)) as VectorHit[];
  }
  assertBlobReadMode(readMode);
  if (readMode === "blob-native") {
    try {
      return conn
        .query(
          "SELECT id, 1 - vec_distance_cosine(embedding, ?) AS similarity FROM entities WHERE embedding IS NOT NULL ORDER BY similarity DESC LIMIT ?",
        )
        .all(toBlob(queryEmbedding), limit) as VectorHit[];
    } catch {
      // fall through to JS brute-force
    }
  }
  const rows = conn
    .query("SELECT id, embedding FROM entities WHERE embedding IS NOT NULL")
    .all() as Array<{ id: string; embedding: Buffer }>;

  const topK: VectorHit[] = [];
  for (const row of rows) {
    const vec = fromBlob(row.embedding);
    const sim = cosineSimilarity(queryEmbedding, vec);
    topKInsert(topK, { id: row.id, similarity: sim }, limit);
  }
  return topK;
}

function runDistillations(
  conn: VectorQueryConn,
  readMode: VecReadMode,
  queryEmbedding: Float32Array,
  limit: number,
): VectorHit[] {
  if (readMode === "degraded") return [];
  if (readMode === "vec0") {
    // `archived` flips on meta-distillation (mutable) → post-filter via join,
    // over-fetching so attrition leaves >= limit non-archived survivors, and
    // widening to a full scan if that still under-fills (blob-mode parity).
    const run = (k: number): VectorHit[] =>
      conn
        .query(
          "WITH knn AS (SELECT id, distance FROM distillation_vec WHERE embedding MATCH ? AND k = ?) " +
            "SELECT knn.id AS id, 1 - knn.distance AS similarity " +
            "FROM knn JOIN distillations d ON d.id = knn.id WHERE d.archived = 0 " +
            "ORDER BY knn.distance LIMIT ?",
        )
        .all(toBlob(queryEmbedding), k, limit) as VectorHit[];
    const k0 = overfetchK(limit);
    const hits = run(k0);
    return hits.length >= limit || k0 >= VEC0_MAX_K ? hits : run(VEC0_MAX_K);
  }
  assertBlobReadMode(readMode);
  if (readMode === "blob-native") {
    try {
      return conn
        .query(
          "SELECT id, 1 - vec_distance_cosine(embedding, ?) AS similarity FROM distillations WHERE embedding IS NOT NULL AND archived = 0 ORDER BY similarity DESC LIMIT ?",
        )
        .all(toBlob(queryEmbedding), limit) as VectorHit[];
    } catch {
      // fall through to JS brute-force
    }
  }
  const rows = conn
    .query(
      "SELECT id, embedding FROM distillations WHERE embedding IS NOT NULL AND archived = 0",
    )
    .all() as Array<{ id: string; embedding: Buffer }>;

  const topK: VectorHit[] = [];
  for (const row of rows) {
    const vec = fromBlob(row.embedding);
    const sim = cosineSimilarity(queryEmbedding, vec);
    topKInsert(topK, { id: row.id, similarity: sim }, limit);
  }
  return topK;
}

function runAllDistillations(
  conn: VectorQueryConn,
  readMode: VecReadMode,
  queryEmbedding: Float32Array,
  projectId: string,
  limit: number,
): DistillationVectorHit[] {
  if (readMode === "degraded") return [];
  if (readMode === "vec0") {
    // Project is a PARTITION KEY → the index scans only this project's rows.
    // No post-filter (includes archived, by contract) → k = limit. session_id
    // is an aux column returned straight from the index. Cap removed: the index
    // sees every distillation in the project, not a recency window.
    return conn
      .query(
        "SELECT id, session_id, 1 - distance AS similarity FROM distillation_vec WHERE embedding MATCH ? AND k = ? AND project_id = ? ORDER BY distance",
      )
      .all(
        toBlob(queryEmbedding),
        vecK(limit),
        projectId,
      ) as DistillationVectorHit[];
  }
  assertBlobReadMode(readMode);
  if (readMode === "blob-native") {
    try {
      // Rank by similarity within the same most-recent candidate window the JS
      // path uses (created_at DESC, capped at MAX_DISTILLATION_VECTOR_ROWS).
      return conn
        .query(
          "SELECT id, session_id, 1 - vec_distance_cosine(embedding, ?) AS similarity FROM (SELECT id, session_id, embedding FROM distillations WHERE embedding IS NOT NULL AND project_id = ? ORDER BY created_at DESC LIMIT ?) ORDER BY similarity DESC LIMIT ?",
        )
        .all(
          toBlob(queryEmbedding),
          projectId,
          MAX_DISTILLATION_VECTOR_ROWS,
          limit,
        ) as DistillationVectorHit[];
    } catch {
      // fall through to JS brute-force
    }
  }
  const rows = conn
    .query(
      "SELECT id, session_id, embedding FROM distillations WHERE embedding IS NOT NULL AND project_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(projectId, MAX_DISTILLATION_VECTOR_ROWS) as Array<{
    id: string;
    session_id: string;
    embedding: Buffer;
  }>;

  const topK: DistillationVectorHit[] = [];
  for (const row of rows) {
    const vec = fromBlob(row.embedding);
    const sim = cosineSimilarity(queryEmbedding, vec);
    topKInsert(
      topK,
      { id: row.id, session_id: row.session_id, similarity: sim },
      limit,
    );
  }
  return topK;
}

function runTemporal(
  conn: VectorQueryConn,
  readMode: VecReadMode,
  queryEmbedding: Float32Array,
  projectId: string,
  limit: number,
  sessionId?: string,
): VectorHit[] {
  if (readMode === "degraded") return [];
  if (readMode === "vec0") {
    // project_id (and session_id when scoped) are PARTITION KEYs → the index
    // scans only the matching shard (session-scoped is ~sub-ms). Cap removed:
    // the index sees the full history, not a recency window. `temporal_vec` is
    // chunk-keyed and a message may carry MANY chunks (multi-vector part-aware
    // embedding), so a bare `k = limit` could return `limit` *chunks* that
    // collapse to far fewer than `limit` distinct messages. Over-fetch
    // `TEMPORAL_CHUNK_OVERFETCH × limit` chunk candidates (nearest-first), then
    // collapse to one hit per message by max-sim — the message scores as its
    // best-matching chunk and is returned exactly once. The collapse is done in
    // JS rather than an outer `GROUP BY` because SQLite flattens a derived table
    // into the aggregating parent, which makes the vec0 KNN see a non-`distance`
    // ORDER BY and rejects the query; keeping the KNN standalone (its proven
    // `k = ? … ORDER BY distance` form) and grouping the bounded result set (≤ k
    // ≤ VEC0_MAX_K rows) in JS sidesteps that entirely. Degenerate-safe: with one
    // chunk per message the collapse is 1:1.
    const run = (k: number): VectorHit[] => {
      const vsql = sessionId
        ? "SELECT message_id AS id, 1 - distance AS similarity FROM temporal_vec WHERE embedding MATCH ? AND k = ? AND project_id = ? AND session_id = ? ORDER BY distance"
        : "SELECT message_id AS id, 1 - distance AS similarity FROM temporal_vec WHERE embedding MATCH ? AND k = ? AND project_id = ? ORDER BY distance";
      const vparams: unknown[] = sessionId
        ? [toBlob(queryEmbedding), k, projectId, sessionId]
        : [toBlob(queryEmbedding), k, projectId];
      const chunkHits = conn.query(vsql).all(...vparams) as VectorHit[];
      // Keep each message's best (max) sim. `chunkHits` is nearest-first, so the
      // first-seen sim for an id is already its best and Map insertion order is
      // best-first; the stable sort then orders messages by similarity with
      // nearest-chunk-first tie-breaking.
      const bestByMessage = new Map<string, number>();
      for (const h of chunkHits) {
        const prev = bestByMessage.get(h.id);
        if (prev === undefined || h.similarity > prev) {
          bestByMessage.set(h.id, h.similarity);
        }
      }
      return [...bestByMessage.entries()]
        .map(([id, similarity]) => ({ id, similarity }))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
    };
    const k0 = vecK(limit * TEMPORAL_CHUNK_OVERFETCH);
    const hits = run(k0);
    // Chunk-collapse attrition can leave < limit distinct messages even when more
    // exist deeper (a few messages own the k-nearest chunks); widen to the max
    // KNN window, mirroring runKnowledge/runDistillations' post-filter widen.
    return hits.length >= limit || k0 >= VEC0_MAX_K ? hits : run(VEC0_MAX_K);
  }
  assertBlobReadMode(readMode);
  if (readMode === "blob-native") {
    try {
      // Score only the most-recent MAX_TEMPORAL_VECTOR_ROWS rows (the same
      // candidate window the JS path uses below). This recency cap is the
      // BLOB-FALLBACK bound: the ANN replacement it once stood in for (#999,
      // resolved) already shipped as the uncapped, whole-corpus FLAT-vec0 KNN
      // path above — this branch runs only when sqlite-vec is unavailable and the
      // DB stays in blob layout. See MAX_TEMPORAL_VECTOR_ROWS.
      const vsql = sessionId
        ? "SELECT id, 1 - vec_distance_cosine(embedding, ?) AS similarity FROM (SELECT id, embedding FROM temporal_messages WHERE embedding IS NOT NULL AND project_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT ?) ORDER BY similarity DESC LIMIT ?"
        : "SELECT id, 1 - vec_distance_cosine(embedding, ?) AS similarity FROM (SELECT id, embedding FROM temporal_messages WHERE embedding IS NOT NULL AND project_id = ? ORDER BY created_at DESC LIMIT ?) ORDER BY similarity DESC LIMIT ?";
      const vparams: unknown[] = sessionId
        ? [
            toBlob(queryEmbedding),
            projectId,
            sessionId,
            MAX_TEMPORAL_VECTOR_ROWS,
            limit,
          ]
        : [toBlob(queryEmbedding), projectId, MAX_TEMPORAL_VECTOR_ROWS, limit];
      return conn.query(vsql).all(...vparams) as VectorHit[];
    } catch {
      // fall through to JS brute-force
    }
  }
  // Blob-fallback recency cap (JS brute-force). The primary path is the uncapped
  // whole-corpus vec0 KNN above (#999, resolved); see MAX_TEMPORAL_VECTOR_ROWS.
  const sql = sessionId
    ? "SELECT id, embedding FROM temporal_messages WHERE embedding IS NOT NULL AND project_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT ?"
    : "SELECT id, embedding FROM temporal_messages WHERE embedding IS NOT NULL AND project_id = ? ORDER BY created_at DESC LIMIT ?";
  const params = sessionId
    ? [projectId, sessionId, MAX_TEMPORAL_VECTOR_ROWS]
    : [projectId, MAX_TEMPORAL_VECTOR_ROWS];

  const rows = conn.query(sql).all(...params) as Array<{
    id: string;
    embedding: Buffer;
  }>;

  const topK: VectorHit[] = [];
  for (const row of rows) {
    const vec = fromBlob(row.embedding);
    const sim = cosineSimilarity(queryEmbedding, vec);
    topKInsert(topK, { id: row.id, similarity: sim }, limit);
  }
  return topK;
}
