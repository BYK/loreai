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
// us whether sqlite-vec is loaded on THAT connection (the two threads load the
// extension independently). Keeping this self-contained is what lets the worker
// bundle stay tiny — see build plumbing in packages/gateway/script.

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
 * STOPGAP — remove once an ANN index replaces brute-force scanning.
 * ----------------------------------------------------------------------------
 * `temporal_messages` is the rawest, highest-cardinality tier (100K+ rows on
 * busy installs), and every `vectorSearch*` over it was an UNBOUNDED O(n)
 * cosine scan — the dominant cost behind the pathological recall latency in
 * issue #999. This cap bounds the expensive cosine work to a fixed window.
 *
 * Capping by `created_at DESC` (rather than randomly) is architecturally
 * coherent, not just a perf hack: the temporal tier is "recent raw context",
 * while older messages are distilled into the distillation tier, which recall
 * searches separately (see {@link MAX_DISTILLATION_VECTOR_ROWS}). So old
 * content stays reachable via distillations even though it ages out of the
 * temporal vector window.
 *
 * 🔴 This cap exists ONLY because we brute-force every row. Once a real ANN
 * index lands (DiskANN via sqlite-vec ≥0.1.10's `vec0`, tracked under #999),
 * search becomes sublinear and there is no reason to hide older rows from it —
 * DELETE this constant and the `ORDER BY created_at DESC LIMIT` it drives, and
 * let the index see the whole corpus.
 */
export const MAX_TEMPORAL_VECTOR_ROWS = 4000;

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
 * `vecAvailable` indicates whether sqlite-vec is loaded on `conn`. When true we
 * use the native `vec_distance_cosine()` scan; on any error (or when false) we
 * fall back to the pure-JS brute force. Both paths return the same ordering and
 * scores for L2-normalized vectors (the system-wide invariant) — see db/vec.ts.
 *
 * Returns `DistillationVectorHit[]` for `kind === "allDistillations"` and
 * `VectorHit[]` for every other kind. The two share the same row shape minus
 * `session_id`, so callers narrow by spec.kind.
 */
export function runVectorQuery(
  conn: VectorQueryConn,
  vecAvailable: boolean,
  queryEmbedding: Float32Array,
  spec: VectorQuerySpec,
): VectorHit[] | DistillationVectorHit[] {
  switch (spec.kind) {
    case "knowledge":
      return runKnowledge(conn, vecAvailable, queryEmbedding, spec);
    case "entities":
      return runEntities(conn, vecAvailable, queryEmbedding, spec.limit);
    case "distillations":
      return runDistillations(conn, vecAvailable, queryEmbedding, spec.limit);
    case "allDistillations":
      return runAllDistillations(
        conn,
        vecAvailable,
        queryEmbedding,
        spec.projectId,
        spec.limit,
      );
    case "temporal":
      return runTemporal(
        conn,
        vecAvailable,
        queryEmbedding,
        spec.projectId,
        spec.limit,
        spec.sessionId,
      );
  }
}

function runKnowledge(
  conn: VectorQueryConn,
  vecAvailable: boolean,
  queryEmbedding: Float32Array,
  spec: { limit: number; excludeCategories?: string[] },
): VectorHit[] {
  const { limit, excludeCategories } = spec;
  if (vecAvailable) {
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
  vecAvailable: boolean,
  queryEmbedding: Float32Array,
  limit: number,
): VectorHit[] {
  if (vecAvailable) {
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
  vecAvailable: boolean,
  queryEmbedding: Float32Array,
  limit: number,
): VectorHit[] {
  if (vecAvailable) {
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
  vecAvailable: boolean,
  queryEmbedding: Float32Array,
  projectId: string,
  limit: number,
): DistillationVectorHit[] {
  if (vecAvailable) {
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
  vecAvailable: boolean,
  queryEmbedding: Float32Array,
  projectId: string,
  limit: number,
  sessionId?: string,
): VectorHit[] {
  if (vecAvailable) {
    try {
      // Score only the most-recent MAX_TEMPORAL_VECTOR_ROWS rows (the same
      // candidate window the JS path uses below). STOPGAP — see
      // MAX_TEMPORAL_VECTOR_ROWS: drop the inner ORDER BY/LIMIT once an ANN
      // index replaces brute-force scanning (#999).
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
  // STOPGAP recency cap — see MAX_TEMPORAL_VECTOR_ROWS (#999).
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
