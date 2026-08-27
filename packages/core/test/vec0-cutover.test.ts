// End-to-end tests for the FLAT-vec0 storage layout: write/read round-trip,
// the blob→vec0 cutover (backfill + DROP COLUMN + flip, idempotent/resumable),
// vec0↔blob exact parity, partition pushdown + recency-cap removal, dimension
// change, delete maintenance, and the dangling-row GC backstop.
//
// All run against the real vec0-capable test connection (the vendored sqlite-vec
// loads in the node test runtime). The suite is skipped if the extension is
// somehow unavailable so a vec-less CI lane stays green.
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { config } from "../src/config";
import {
  close,
  db,
  ensureProject,
  getKV,
  mergeProjectInternal,
  setKV,
} from "../src/db";
import { isVecAvailable } from "../src/db/vec";
import {
  VEC_DIMENSION_KEY,
  VEC_STORAGE_MODE_KEY,
  clearAllEmbeddings,
  copyBlobsToVec0,
  deleteEmbeddings,
  dropEmbeddingColumn,
  embeddingByIdSource,
  embeddingColumnExists,
  ensureVec0Store,
  gcVec0DanglingRows,
  hasEmbeddingSql,
  missingEmbeddingSql,
  readStorageMode,
  readVecDimension,
  repartitionVec0Project,
  resetVecStorageModeLatch,
  setStorageMode,
  storeEmbedding,
  storeTemporalChunks,
  TEMPORAL_CHUNK_SIZE,
} from "../src/db/vec-store";
import {
  _restoreProvider,
  _saveAndClearProvider,
  backfillTemporalEmbeddings,
  checkConfigChange,
  embedInTokenBatches,
  MAX_TEMPORAL_CHUNKS_PER_MESSAGE,
  maybeCutoverToVec0,
  resetTemporalRechunkProgress,
} from "../src/embedding";
import * as log from "../src/log";
import {
  drainTemporalEmbeddingQueueOnce,
  enqueueTemporalEmbedding,
} from "../src/temporal-embedding-queue";
import * as ltm from "../src/ltm";
import {
  clearDistillations,
  clearKnowledge,
  clearProject,
  clearTemporal,
  deleteDistillation,
  deleteSession,
  moveSessions,
} from "../src/data";
import { prune } from "../src/temporal";
import {
  fromBlob,
  runVectorQuery,
  TEMPORAL_CHUNK_OVERFETCH,
  toBlob,
  type VectorHit,
} from "../src/vector-query";

const PROJECT = "/test/vec0-cutover";
const DIM = 4;
const BASE = ["knowledge", "entities", "distillations", "temporal_messages"];
const VEC = ["knowledge_vec", "entity_vec", "distillation_vec", "temporal_vec"];

function v(...xs: number[]): Float32Array {
  const a = new Float32Array(DIM);
  let n = 0;
  for (let i = 0; i < DIM; i++) {
    a[i] = xs[i] ?? 0;
    n += a[i] * a[i];
  }
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) a[i] /= n; // L2-normalize (system invariant)
  return a;
}

// Deterministic 32-bit RNG for reproducible KNN-equivalence fixtures.
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Random L2-normalized 4D vector. Tests that need DISTINCT, non-degenerate
// vectors use this in place of the helper `v(...)` to avoid accidental ties.
function unit4(rng: () => number): Float32Array {
  const a = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) a[i] = rng() * 2 - 1;
  let n = 0;
  for (let i = 0; i < DIM; i++) n += a[i] * a[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) a[i] /= n;
  return a;
}

let pid: string;

const passthroughSink: log.LogSink = {
  info() {},
  warn() {},
  error() {},
  captureException() {},
};

function recordSql(calls: string[]): log.LogSink {
  return {
    ...passthroughSink,
    withDbSpan<T>(sql: string, fn: () => T): T {
      calls.push(sql);
      return fn();
    },
  };
}

function expectExactTemporalDeletes(calls: string[], count: number): void {
  const deletes = calls.filter((sql) =>
    sql.startsWith("DELETE FROM temporal_vec WHERE "),
  );
  expect(deletes).toHaveLength(count);
  deletes.forEach((sql) => {
    expect(sql).not.toContain("message_id");
    expect(sql).not.toContain(" IN ");
    expect(sql.match(/chunk_id = \?/g)).toHaveLength(
      MAX_TEMPORAL_CHUNKS_PER_MESSAGE,
    );
  });
}

/** Return every test to a clean blob-layout state: drop vec0 tables, re-add any
 *  base `embedding` column a cutover test dropped, clear kv flags + base rows. */
function resetToBlob(): void {
  for (const vt of VEC) db().query(`DROP TABLE IF EXISTS ${vt}`).run();
  for (const t of BASE) {
    const cols = db().query(`PRAGMA table_info(${t})`).all() as Array<{
      name: string;
    }>;
    if (!cols.some((c) => c.name === "embedding")) {
      db().query(`ALTER TABLE ${t} ADD COLUMN embedding BLOB`).run();
    }
  }
  db()
    .query("DELETE FROM kv_meta WHERE key IN (?, ?)")
    .run(VEC_STORAGE_MODE_KEY, VEC_DIMENSION_KEY);
  for (const t of BASE) db().query(`DELETE FROM ${t}`).run();
  // These tests legitimately revert to a blob layout mid-process (production
  // never does — vec0 is monotonic). Clear the sticky vec0 latch so the next
  // case's fresh blob fixture is not pinned to vec0 by a prior case's cutover.
  resetVecStorageModeLatch();
}

beforeEach(() => {
  log.registerSink(passthroughSink);
  pid = ensureProject(PROJECT);
  resetToBlob();
});

afterEach(() => {
  log.registerSink(passthroughSink);
});

afterAll(() => {
  close();
});

// --- fixture inserters (base rows; embeddings stored separately) ------------
function insKnowledge(id: string, title = "", content = "", conf = 1.0): void {
  const now = Date.now();
  db()
    .query(
      "INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at, logical_id) VALUES (?, ?, 'test', ?, ?, ?, ?, ?)",
    )
    .run(id, pid, title, content, now, now, id);
  if (conf !== 1.0) {
    db()
      .query(
        "INSERT INTO knowledge_meta (logical_id, confidence) VALUES (?, ?) ON CONFLICT(logical_id) DO UPDATE SET confidence = ?",
      )
      .run(id, conf, conf);
  }
}
function insDistillation(id: string, sess = "s", archived = 0): void {
  db()
    .query(
      "INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, created_at, archived) VALUES (?, ?, ?, '', '', 'obs', '', 0, 0, ?, ?)",
    )
    .run(id, pid, sess, Date.now(), archived);
}
function insTemporal(id: string, sess: string, createdAt: number): void {
  db()
    .query(
      "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at) VALUES (?, ?, ?, 'user', 'm', 0, 0, ?)",
    )
    .run(id, pid, sess, createdAt);
}

// Open the connection so the vendored sqlite-vec extension loads before we read
// its availability (isVecAvailable() reflects the global set at first open).
db();
const describeVec = isVecAvailable() ? describe : describe.skip;

describeVec("vec0 write + read round-trip", () => {
  test("storeEmbedding writes to the vec0 table (not the base column)", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insKnowledge("k1", "t", "c");
    storeEmbedding(db(), "knowledge", "k1", v(1, 0, 0, 0));

    // base column untouched, vec0 table populated
    const base = db()
      .query("SELECT embedding FROM knowledge WHERE id = 'k1'")
      .get() as { embedding: Buffer | null };
    expect(base.embedding).toBeNull();
    const vecRow = db()
      .query("SELECT embedding FROM knowledge_vec WHERE id = 'k1'")
      .get() as { embedding: Uint8Array };
    expect(Array.from(fromBlob(vecRow.embedding))).toEqual(
      Array.from(v(1, 0, 0, 0)),
    );
  });

  test("storeEmbedding re-embed overwrites the existing vec0 row (upsert without INSERT OR REPLACE)", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insKnowledge("k1", "t", "c");
    insDistillation("d1", "s");
    insTemporal("t1", "sX", 1000);

    // Store an embedding, then a DIFFERENT one for the SAME id. vec0 in our
    // pinned sqlite-vec rejects `INSERT OR REPLACE`/UPSERT on virtual tables, so
    // the write path must DELETE-by-key then INSERT. If it ever reverts to
    // `INSERT OR REPLACE`, the second write throws "UNIQUE constraint failed"
    // and this test fails (non-vacuous guard). Covers all three keyings: plain
    // id (knowledge), id + partition lookup (distillations), chunk_id (temporal).
    storeEmbedding(db(), "knowledge", "k1", v(1, 0, 0, 0));
    storeEmbedding(db(), "knowledge", "k1", v(0, 1, 0, 0));
    storeEmbedding(db(), "distillations", "d1", v(1, 0, 0, 0));
    storeEmbedding(db(), "distillations", "d1", v(0, 1, 0, 0));
    storeEmbedding(db(), "temporal", "t1", v(1, 0, 0, 0));
    storeEmbedding(db(), "temporal", "t1", v(0, 1, 0, 0));

    // Exactly one row survives per id, holding the SECOND (overwriting) vector.
    const kn = db()
      .query("SELECT COUNT(*) n FROM knowledge_vec WHERE id = 'k1'")
      .get() as { n: number };
    expect(kn.n).toBe(1);
    const kRow = db()
      .query("SELECT embedding FROM knowledge_vec WHERE id = 'k1'")
      .get() as { embedding: Uint8Array };
    expect(Array.from(fromBlob(kRow.embedding))).toEqual(
      Array.from(v(0, 1, 0, 0)),
    );

    const dn = db()
      .query("SELECT COUNT(*) n FROM distillation_vec WHERE id = 'd1'")
      .get() as { n: number };
    expect(dn.n).toBe(1);
    const dRow = db()
      .query("SELECT embedding FROM distillation_vec WHERE id = 'd1'")
      .get() as { embedding: Uint8Array };
    expect(Array.from(fromBlob(dRow.embedding))).toEqual(
      Array.from(v(0, 1, 0, 0)),
    );

    // temporal is chunk-keyed (`id#0`): still exactly one chunk, new vector.
    const tn = db()
      .query("SELECT COUNT(*) n FROM temporal_vec WHERE message_id = 't1'")
      .get() as { n: number };
    expect(tn.n).toBe(1);
    const tRow = db()
      .query("SELECT embedding FROM temporal_vec WHERE chunk_id = 't1#0'")
      .get() as { embedding: Uint8Array };
    expect(Array.from(fromBlob(tRow.embedding))).toEqual(
      Array.from(v(0, 1, 0, 0)),
    );
  });

  test("runVectorQuery vec0 returns hits ranked by cosine, post-filtering confidence", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insKnowledge("near", "t", "c", 1.0);
    insKnowledge("far", "t", "c", 1.0);
    insKnowledge("lowconf", "t", "c", 0.1); // below the 0.2 floor → filtered out
    storeEmbedding(db(), "knowledge", "near", v(1, 0, 0, 0));
    storeEmbedding(db(), "knowledge", "far", v(0, 1, 0, 0));
    storeEmbedding(db(), "knowledge", "lowconf", v(1, 0, 0, 0)); // identical to query

    const hits = runVectorQuery(db(), "vec0", v(1, 0, 0, 0), {
      kind: "knowledge",
      limit: 10,
    }) as VectorHit[];
    const ids = hits.map((h) => h.id);
    expect(ids).toContain("near");
    expect(ids).toContain("far");
    expect(ids).not.toContain("lowconf"); // confidence post-filter
    expect(ids.indexOf("near")).toBeLessThan(ids.indexOf("far")); // closer first
  });

  test("temporal vec0 read scopes by project + session partition and returns message ids", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporal("a", "sX", 1000);
    insTemporal("b", "sY", 2000);
    storeEmbedding(db(), "temporal", "a", v(1, 0, 0, 0));
    storeEmbedding(db(), "temporal", "b", v(1, 0, 0, 0));

    const scoped = runVectorQuery(db(), "vec0", v(1, 0, 0, 0), {
      kind: "temporal",
      projectId: pid,
      sessionId: "sX",
      limit: 10,
    }) as VectorHit[];
    expect(scoped.map((h) => h.id)).toEqual(["a"]); // partition pushdown excludes sY
  });

  test("temporal vec0 read collapses a message's many chunks to one max-sim hit", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporal("t1", "sX", 1000);
    insTemporal("t2", "sX", 2000);

    // Multi-vector: t1 carries TWO chunks — #0 orthogonal to the query (sim 0),
    // #1 identical to it (sim 1). t2 carries ONE chunk, moderately near (sim
    // 0.6). The read must return each message ONCE, scored by its BEST chunk.
    const insChunk = (chunkId: string, msgId: string, vec: Float32Array) =>
      db()
        .query(
          "INSERT INTO temporal_vec(chunk_id, message_id, project_id, session_id, embedding) VALUES (?, ?, ?, ?, ?)",
        )
        .run(chunkId, msgId, pid, "sX", toBlob(vec));
    insChunk("t1#0", "t1", v(0, 1, 0, 0));
    insChunk("t1#1", "t1", v(1, 0, 0, 0));
    insChunk("t2#0", "t2", v(0.6, 0.8, 0, 0));

    const hits = runVectorQuery(db(), "vec0", v(1, 0, 0, 0), {
      kind: "temporal",
      projectId: pid,
      sessionId: "sX",
      limit: 10,
    }) as VectorHit[];

    // t1's two chunks collapse to a SINGLE hit (not one per chunk).
    expect(hits.filter((h) => h.id === "t1")).toHaveLength(1);
    // Ranked by best chunk: t1 (max-sim ≈ 1) ahead of t2 (≈ 0.6).
    expect(hits.map((h) => h.id)).toEqual(["t1", "t2"]);
    // t1 is scored by its NEAREST chunk (#1, sim ≈ 1), not its far chunk (#0, 0).
    expect(hits.find((h) => h.id === "t1")?.similarity).toBeCloseTo(1, 5);
  });

  test("temporal vec0 read collapses chunks across sessions when scoped to project only", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporal("t1", "sX", 1000);
    insTemporal("t2", "sY", 2000);
    // No sessionId → the project-scoped SQL branch. t1's two chunks live in
    // session sX, t2's single chunk in sY; both must surface, t1 deduped.
    const insChunk = (
      chunkId: string,
      msgId: string,
      sess: string,
      vec: Float32Array,
    ) =>
      db()
        .query(
          "INSERT INTO temporal_vec(chunk_id, message_id, project_id, session_id, embedding) VALUES (?, ?, ?, ?, ?)",
        )
        .run(chunkId, msgId, pid, sess, toBlob(vec));
    insChunk("t1#0", "t1", "sX", v(0, 1, 0, 0));
    insChunk("t1#1", "t1", "sX", v(1, 0, 0, 0));
    insChunk("t2#0", "t2", "sY", v(0.6, 0.8, 0, 0));

    const hits = runVectorQuery(db(), "vec0", v(1, 0, 0, 0), {
      kind: "temporal",
      projectId: pid,
      limit: 10,
    }) as VectorHit[];

    expect(hits.filter((h) => h.id === "t1")).toHaveLength(1);
    expect(hits.map((h) => h.id)).toEqual(["t1", "t2"]);
    expect(hits.find((h) => h.id === "t1")?.similarity).toBeCloseTo(1, 5);
  });

  test("temporal vec0 read widens the KNN window when chunk-collapse under-fills limit", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    for (const id of ["hot", "m1", "m2", "m3"]) insTemporal(id, "sX", 1000);
    const insChunk = (chunkId: string, msgId: string, vec: Float32Array) =>
      db()
        .query(
          "INSERT INTO temporal_vec(chunk_id, message_id, project_id, session_id, embedding) VALUES (?, ?, ?, ?, ?)",
        )
        .run(chunkId, msgId, pid, "sX", toBlob(vec));
    // "hot" owns MORE than the first window's worth of nearest chunks (all
    // identical to the query). The first KNN window is k0 = limit ×
    // TEMPORAL_CHUNK_OVERFETCH chunks; flooding hot beyond that means the window
    // is entirely hot's chunks, so the collapse yields a SINGLE message — the
    // read must widen the window to recover m1/m2/m3, then slice to the 2 best.
    const k0 = 2 * TEMPORAL_CHUNK_OVERFETCH;
    for (let i = 0; i < k0 + 8; i++) insChunk(`hot#${i}`, "hot", v(1, 0, 0, 0));
    insChunk("m1#0", "m1", v(0.9, 0.44, 0, 0)); // ≈0.898
    insChunk("m2#0", "m2", v(0.8, 0.6, 0, 0)); // 0.8
    insChunk("m3#0", "m3", v(0.7, 0.71, 0, 0)); // ≈0.702

    const hits = runVectorQuery(db(), "vec0", v(1, 0, 0, 0), {
      kind: "temporal",
      projectId: pid,
      sessionId: "sX",
      limit: 2,
    }) as VectorHit[];

    // Without the widen-retry the first window is all "hot" → only 1 message;
    // the widen recovers the next-best message and the slice trims to 2.
    expect(hits.map((h) => h.id)).toEqual(["hot", "m1"]);
  });
});

describeVec("vec0 ↔ blob exact parity (FLAT is exact)", () => {
  test("knowledge: vec0 and blob-js return identical ranking under the same filters", () => {
    // Seed identical data; store both blob (base column) and vec0 rows.
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    const vectors: Array<[string, Float32Array]> = [
      ["k1", v(1, 0.2, 0, 0)],
      ["k2", v(0.2, 1, 0, 0)],
      ["k3", v(0, 0, 1, 0)],
      ["k4", v(0.9, 0.1, 0.1, 0)],
    ];
    for (const [id, vec] of vectors) {
      insKnowledge(id, "t", "c");
      storeEmbedding(db(), "knowledge", id, vec); // vec0 write
      db()
        .query("UPDATE knowledge SET embedding = ? WHERE id = ?")
        .run(toBlob(vec), id); // blob write (parallel)
    }
    const q = v(1, 0, 0, 0);
    const vec0Hits = runVectorQuery(db(), "vec0", q, {
      kind: "knowledge",
      limit: 4,
    }) as VectorHit[];
    const blobHits = runVectorQuery(db(), "blob-js", q, {
      kind: "knowledge",
      limit: 4,
    }) as VectorHit[];
    expect(vec0Hits.map((h) => h.id)).toEqual(blobHits.map((h) => h.id));
    // Similarities match too (exact), within float tolerance.
    for (let i = 0; i < vec0Hits.length; i++) {
      expect(vec0Hits[i].similarity).toBeCloseTo(blobHits[i].similarity, 5);
    }
  });
});

describeVec("blob → vec0 cutover", () => {
  function seedBlobs(): void {
    insKnowledge("k1", "t", "c");
    insDistillation("d1", "s", 0);
    insTemporal("t1", "s", 1000);
    db()
      .query("UPDATE knowledge SET embedding = ? WHERE id='k1'")
      .run(toBlob(v(1, 0, 0, 0)));
    db()
      .query("UPDATE distillations SET embedding = ? WHERE id='d1'")
      .run(toBlob(v(0, 1, 0, 0)));
    db()
      .query("UPDATE temporal_messages SET embedding = ? WHERE id='t1'")
      .run(toBlob(v(0, 0, 1, 0)));
  }

  const TABLES = [
    "knowledge",
    "entities",
    "distillations",
    "temporal",
  ] as const;

  /** Mirror maybeCutoverToVec0() at the test dimension: flip BEFORE drop, then
   *  reclaim — so mode==="blob" never coexists with a dropped column. */
  function runCutover(): void {
    if (readStorageMode(db()) === "blob") {
      ensureVec0Store(db(), DIM);
      for (const table of TABLES) {
        if (embeddingColumnExists(db(), table))
          copyBlobsToVec0(db(), table, DIM);
      }
      setStorageMode(db(), "vec0");
    }
    if (readStorageMode(db()) === "vec0") {
      for (const table of TABLES) {
        if (embeddingColumnExists(db(), table))
          dropEmbeddingColumn(db(), table);
      }
    }
  }

  test("relocates blobs, drops base columns, flips the mode, and reads from vec0", () => {
    seedBlobs();
    runCutover();

    // mode flipped + every base embedding column dropped
    expect(readStorageMode(db())).toBe("vec0");
    for (const t of [
      "knowledge",
      "entities",
      "distillations",
      "temporal",
    ] as const) {
      expect(embeddingColumnExists(db(), t)).toBe(false);
    }
    // vec0 tables carry the relocated vectors
    expect(
      (
        db().query("SELECT COUNT(*) n FROM knowledge_vec").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
    expect(
      (db().query("SELECT COUNT(*) n FROM temporal_vec").get() as { n: number })
        .n,
    ).toBe(1);
    // and a vec0 read finds the relocated knowledge row
    const hits = runVectorQuery(db(), "vec0", v(1, 0, 0, 0), {
      kind: "knowledge",
      limit: 5,
    }) as VectorHit[];
    expect(hits.map((h) => h.id)).toContain("k1");
  });

  test("is idempotent / resumable (re-running copy never duplicates)", () => {
    seedBlobs();
    ensureVec0Store(db(), DIM);
    copyBlobsToVec0(db(), "knowledge", DIM);
    copyBlobsToVec0(db(), "knowledge", DIM); // re-run (crash-resume)
    expect(
      (
        db().query("SELECT COUNT(*) n FROM knowledge_vec").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
    // a full second cutover pass after columns are dropped is a no-op (skips
    // already-migrated tables rather than reading a dropped column)
    runCutover();
    expect(() => runCutover()).not.toThrow();
    expect(readStorageMode(db())).toBe("vec0");
  });

  test("appendVersion works after the column is dropped, and demotes the old vec0 row", () => {
    // Seed a knowledge entry with a vec0 row, then cut over.
    insKnowledge("k1", "title", "v1");
    db()
      .query("UPDATE knowledge SET embedding = ? WHERE id='k1'")
      .run(toBlob(v(1, 0, 0, 0)));
    runCutover();
    expect(embeddingColumnExists(db(), "knowledge")).toBe(false);

    // appendVersion must NOT reference the dropped `embedding` column.
    const newId = ltm.appendVersion("k1", { content: "v2" });
    expect(newId).toBeTruthy();
    expect(newId).not.toBe("k1");
    // the demoted version's vec0 row is gone (knowledge_vec holds current only)
    const oldVec = db()
      .query("SELECT COUNT(*) n FROM knowledge_vec WHERE id = 'k1'")
      .get() as { n: number };
    expect(oldVec.n).toBe(0);
  });

  test("skips a stale-dimension blob instead of aborting the whole cutover", () => {
    // Valid DIM-dim blobs for k1 / d1 / t1.
    seedBlobs();
    // A temporal row whose blob was written under a DIFFERENT embedding
    // dimension: 2 floats = 8 bytes, vs DIM*4 = 16. Before the guard, the single
    // bulk `INSERT … SELECT` fed this into a fixed-width `float[DIM]` vec0 column,
    // which sqlite-vec rejects ("Expected 4 dimensions but received 2"), aborting
    // the ENTIRE cutover and stranding the DB in blob mode on every startup.
    insTemporal("t_stale", "s", 2000);
    db()
      .query("UPDATE temporal_messages SET embedding = ? WHERE id='t_stale'")
      .run(toBlob(new Float32Array([0.6, 0.8])));

    // One bad row must not brick the migration for the whole corpus.
    expect(() => runCutover()).not.toThrow();
    expect(readStorageMode(db())).toBe("vec0");

    // The valid-dim temporal row relocated; the stale-dim row was skipped.
    const tids = (
      db()
        .query("SELECT message_id FROM temporal_vec ORDER BY message_id")
        .all() as { message_id: string }[]
    ).map((r) => r.message_id);
    expect(tids).toEqual(["t1"]);
    // Valid-dim blobs on the other tables still migrated normally.
    expect(
      (
        db().query("SELECT COUNT(*) n FROM knowledge_vec").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
    expect(
      (
        db().query("SELECT COUNT(*) n FROM distillation_vec").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });

  test("a skipped stale-dimension row is removed and then recreated by the re-embed backfill", async () => {
    // The stale-dim row carries real content (>= 50 chars) so the full-corpus
    // re-chunk backfill will re-embed it. The whole point: its wrong-dim vector
    // is REMOVED by the cutover (skipped from the copy, base column dropped) and
    // REGENERATED at the correct dimension from its source text.
    const content =
      "The parser regression needs a completely fresh embedding vector here.";
    expect(content.length).toBeGreaterThanOrEqual(50);
    db()
      .query(
        "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at) VALUES ('t_stale', ?, 's', 'user', ?, 0, 0, 3000)",
      )
      .run(pid, content);
    db()
      .query("UPDATE temporal_messages SET embedding = ? WHERE id='t_stale'")
      .run(toBlob(new Float32Array([0.6, 0.8]))); // wrong dim → skipped

    runCutover();
    expect(readStorageMode(db())).toBe("vec0");
    // Removed: the stale-dim vector did not survive the copy.
    expect(
      (
        db()
          .query(
            "SELECT COUNT(*) n FROM temporal_vec WHERE message_id='t_stale'",
          )
          .get() as { n: number }
      ).n,
    ).toBe(0);

    // Recreated durably: the legacy walk admits the row without invoking a
    // provider, then the bounded scheduler drains it under a deterministic
    // DIM-length provider.
    db()
      .query("DELETE FROM kv_meta WHERE key IN (?, ?, ?)")
      .run(
        "lore:temporal_rechunk.done",
        "lore:temporal_rechunk.cursor",
        "lore:temporal_rechunk.attempts",
      );
    const token = _saveAndClearProvider();
    const configuredDimensions = config().search.embeddings.dimensions;
    try {
      config().search.embeddings.dimensions = DIM;
      _restoreProvider({
        provider: {
          maxBatchSize: 8,
          async embed(texts: string[]) {
            return texts.map(() => v(1, 0, 0, 0));
          },
        },
      });
      expect(await backfillTemporalEmbeddings()).toBe(1);
      expect(
        db()
          .query(
            "SELECT message_id FROM temporal_embedding_queue WHERE message_id = 't_stale'",
          )
          .get(),
      ).toEqual({ message_id: "t_stale" });
      expect(await drainTemporalEmbeddingQueueOnce()).toBe(1);
    } finally {
      config().search.embeddings.dimensions = configuredDimensions;
      _restoreProvider(token);
    }

    // The row now has a correctly-dimensioned vec0 chunk (DIM*4 bytes).
    const rows = db()
      .query(
        "SELECT length(embedding) AS n FROM temporal_vec WHERE message_id='t_stale'",
      )
      .all() as { n: number }[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.n === DIM * 4)).toBe(true);
  });

  test("copyBlobsToVec0 returns the count of stale-dimension blobs it skipped", () => {
    ensureVec0Store(db(), DIM);
    insTemporal("t_ok", "s", 1);
    insTemporal("t_bad1", "s", 2);
    insTemporal("t_bad2", "s", 3);
    db()
      .query("UPDATE temporal_messages SET embedding = ? WHERE id='t_ok'")
      .run(toBlob(v(1, 0, 0, 0))); // valid DIM-dim
    db()
      .query("UPDATE temporal_messages SET embedding = ? WHERE id='t_bad1'")
      .run(toBlob(new Float32Array([0.1, 0.2]))); // 2-dim → stale
    db()
      .query("UPDATE temporal_messages SET embedding = ? WHERE id='t_bad2'")
      .run(toBlob(new Float32Array([0.1, 0.2, 0.3]))); // 3-dim → stale

    // Two stale-dim blobs skipped; the one valid blob relocated.
    expect(copyBlobsToVec0(db(), "temporal", DIM)).toBe(2);
    expect(
      (db().query("SELECT COUNT(*) n FROM temporal_vec").get() as { n: number })
        .n,
    ).toBe(1);
  });
});

describeVec("recency-cap removal (vec0 sees the whole corpus)", () => {
  test("a relevant temporal message older than the blob window still surfaces in vec0", () => {
    // Exceed the blob recency cap so the OLDEST row is outside the blob window.
    const N = 4010; // > MAX_TEMPORAL_VECTOR_ROWS (4000)
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    // Oldest row (created_at=0) is the perfect match; the rest are orthogonal.
    insTemporal("oldest", "s", 0);
    storeEmbedding(db(), "temporal", "oldest", v(1, 0, 0, 0));
    db().query("BEGIN").run();
    for (let i = 1; i < N; i++) {
      insTemporal(`m${i}`, "s", i); // newer
      storeEmbedding(db(), "temporal", `m${i}`, v(0, 1, 0, 0));
    }
    db().query("COMMIT").run();

    const hits = runVectorQuery(db(), "vec0", v(1, 0, 0, 0), {
      kind: "temporal",
      projectId: pid,
      limit: 5,
    }) as VectorHit[];
    // The perfect match is the oldest row — outside the former 4000-row window,
    // yet vec0 (uncapped) surfaces it first.
    expect(hits[0]?.id).toBe("oldest");
  });
});

describeVec("dimension change", () => {
  test("ensureVec0Store drops + recreates the tables at the new dimension", () => {
    ensureVec0Store(db(), DIM);
    setStorageMode(db(), "vec0");
    insKnowledge("k1");
    storeEmbedding(db(), "knowledge", "k1", v(1, 0, 0, 0));
    expect(
      (
        db().query("SELECT COUNT(*) n FROM knowledge_vec").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
    expect(readVecDimension(db())).toBe(DIM);

    // A larger dimension makes the fixed-width tables incompatible → recreate.
    ensureVec0Store(db(), 8);
    expect(readVecDimension(db())).toBe(8);
    expect(
      (
        db().query("SELECT COUNT(*) n FROM knowledge_vec").get() as {
          n: number;
        }
      ).n,
    ).toBe(0); // recreated empty
    // and it now accepts 8-dim vectors
    const eight = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(() =>
      db()
        .query("INSERT INTO knowledge_vec(id, embedding) VALUES ('x', ?)")
        .run(toBlob(eight)),
    ).not.toThrow();
  });

  test("temporal vec0 records the compact chunk size at fresh install", () => {
    if (!isVecAvailable()) return;
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    // The shadows table only exists after the first INSERT, so write one
    // row first to materialize it.
    insTemporal("seed", "s", 1);
    storeEmbedding(db(), "temporal", "seed", v(1, 0, 0, 0));

    // Stored value must equal the const so future readers can gate rebuilds
    // against a chunk size recorded in `kv_meta`, not against the DDL string.
    expect(getKV("vec.temporal_chunk_size")).toBe(String(TEMPORAL_CHUNK_SIZE));
    // Walk every chunk the shadows table exposes — every chunk's `size` column
    // is the chunk capacity assigned at DDL time, never the occupancy.
    const chunkSizes = (
      db().query("SELECT size FROM temporal_vec_chunks").all() as Array<{
        size: number;
      }>
    ).map((r) => r.size);
    expect(chunkSizes.length).toBeGreaterThan(0);
    for (const size of chunkSizes) expect(size).toBe(TEMPORAL_CHUNK_SIZE);
  });
});

describeVec("chunk size is a storage-only optimization", () => {
  test("KNN top-k ordering is identical between 64-slot and 1024-slot chunks on the same vector set", () => {
    if (!isVecAvailable()) return;

    const conn = db();
    setStorageMode(conn, "vec0");
    ensureVec0Store(conn, DIM);

    // Clear any prior rows so this test owns the table.
    conn.query("DELETE FROM knowledge_vec").run();
    // Defensive cleanup: a previous run in this process may have left these
    // helper tables behind. CREATE without IF NOT EXISTS below would fail in
    // that case, and CREATE with IF NOT EXISTS would skip the second run and
    // collide on the same primary keys we want to re-insert.
    conn.query("DROP TABLE IF EXISTS knowledge_vec_compact").run();
    conn.query("DROP TABLE IF EXISTS knowledge_vec_wide").run();

    // Distinct random unit-4D vectors: stable, non-degenerate, no accidental
    // ties that would hide a chunk-size ordering swap.
    const rng = mulberry32(0x517e);
    const N = 200;
    const inserted: Array<{ id: string; vec: Float32Array }> = [];
    for (let i = 0; i < N; i++) {
      const u = unit4(rng);
      const id = `vec_${i.toString(36)}`;
      inserted.push({ id, vec: u });
    }

    // Compact layout: the 64-slot table we ship to users.
    conn
      .query(
        `CREATE VIRTUAL TABLE knowledge_vec_compact USING vec0(id TEXT PRIMARY KEY, embedding float[${DIM}] distance_metric=cosine, chunk_size=${TEMPORAL_CHUNK_SIZE})`,
      )
      .run();

    // Wide layout: the default 1024-slot baseline (~3 MB / chunk).
    conn
      .query(
        `CREATE VIRTUAL TABLE knowledge_vec_wide USING vec0(id TEXT PRIMARY KEY, embedding float[${DIM}] distance_metric=cosine, chunk_size=1024)`,
      )
      .run();

    for (const { id, vec } of inserted) {
      conn
        .query(
          "INSERT INTO knowledge_vec_compact (id, embedding) VALUES (?, ?)",
        )
        .run(id, toBlob(vec));
      conn
        .query("INSERT INTO knowledge_vec_wide (id, embedding) VALUES (?, ?)")
        .run(id, toBlob(vec));
    }

    // Pick a query vector that isn't in the corpus so distances are non-trivial.
    const q = unit4(rng);
    const k = 10;

    const compactTop = conn
      .query(
        "SELECT id FROM knowledge_vec_compact WHERE embedding MATCH ? AND k = ? ORDER BY distance",
      )
      .all(toBlob(q), k) as Array<{ id: string }>;
    const wideTop = conn
      .query(
        "SELECT id FROM knowledge_vec_wide WHERE embedding MATCH ? AND k = ? ORDER BY distance",
      )
      .all(toBlob(q), k) as Array<{ id: string }>;

    // Both layouts must agree on the top-k ordering — they share the same
    // cosine algorithm and the same vector data, only the chunk boundary
    // changes. Any divergence means a search-quality regression.
    expect(compactTop.map((r) => r.id)).toEqual(wideTop.map((r) => r.id));

    // Drop the helper tables so they don't leak into subsequent tests in
    // this file. The shadow tables (`*_auxiliary`, `*_rowids`, `*_chunks`,
    // `*_info`, `*_vector_chunks00`) are dropped alongside the virtual
    // table itself.
    conn.query("DROP TABLE knowledge_vec_compact").run();
    conn.query("DROP TABLE knowledge_vec_wide").run();
  });
});

describeVec("delete maintenance + GC", () => {
  test("deleteEmbeddings removes vec0 rows in vec0 mode and is a no-op in blob mode", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insKnowledge("k1");
    insTemporal("t1", "s", 1);
    storeEmbedding(db(), "knowledge", "k1", v(1, 0, 0, 0));
    storeEmbedding(db(), "temporal", "t1", v(1, 0, 0, 0));

    const calls: string[] = [];
    log.registerSink(recordSql(calls));
    deleteEmbeddings(db(), "knowledge", ["k1"]);
    deleteEmbeddings(db(), "temporal", ["t1"]);
    expectExactTemporalDeletes(calls, 1);
    expect(
      (
        db().query("SELECT COUNT(*) n FROM knowledge_vec").get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
    expect(
      (db().query("SELECT COUNT(*) n FROM temporal_vec").get() as { n: number })
        .n,
    ).toBe(0);

    // blob mode: no-op (no vec0 tables to touch)
    setStorageMode(db(), "blob");
    expect(() =>
      deleteEmbeddings(db(), "knowledge", ["whatever"]),
    ).not.toThrow();
  });

  test("deleteEmbeddings removes legacy temporal chunks beyond the current cap", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporal("legacy-over-cap", "s", 1);
    const insert = db().query(
      "INSERT INTO temporal_vec(chunk_id, message_id, project_id, session_id, embedding) VALUES (?, ?, ?, 's', ?)",
    );
    Array.from(
      { length: MAX_TEMPORAL_CHUNKS_PER_MESSAGE + 1 },
      (_, ord) => ord,
    ).forEach((ord) =>
      insert.run(
        `legacy-over-cap#${ord}`,
        "legacy-over-cap",
        pid,
        toBlob(v(1, 0, 0, 0)),
      ),
    );
    db()
      .query("DELETE FROM temporal_messages WHERE id = ?")
      .run("legacy-over-cap");

    const calls: string[] = [];
    log.registerSink(recordSql(calls));
    deleteEmbeddings(db(), "temporal", ["legacy-over-cap"]);

    expectExactTemporalDeletes(calls, 2);
    expect(
      (db().query("SELECT COUNT(*) n FROM temporal_vec").get() as { n: number })
        .n,
    ).toBe(0);
  });

  test("gcVec0DanglingRows reclaims vec0 rows whose base row is gone", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insKnowledge("keep");
    insTemporal("keepT", "s", 1);
    storeEmbedding(db(), "knowledge", "keep", v(1, 0, 0, 0));
    storeEmbedding(db(), "temporal", "keepT", v(1, 0, 0, 0));
    // orphan rows: vec0 entries with no backing base row
    db()
      .query("INSERT INTO knowledge_vec(id, embedding) VALUES ('orphan', ?)")
      .run(toBlob(v(0, 1, 0, 0)));
    db()
      .query(
        "INSERT INTO temporal_vec(chunk_id, message_id, project_id, session_id, embedding) VALUES ('orphanT#0','orphanT',?, 's', ?)",
      )
      .run(pid, toBlob(v(0, 1, 0, 0)));

    gcVec0DanglingRows(db());

    expect(
      db()
        .query("SELECT id FROM knowledge_vec ORDER BY id")
        .all()
        .map((r) => (r as { id: string }).id),
    ).toEqual(["keep"]);
    expect(
      db()
        .query("SELECT message_id FROM temporal_vec")
        .all()
        .map((r) => (r as { message_id: string }).message_id),
    ).toEqual(["keepT"]);
  });

  test("gcVec0DanglingRows sweeps ONLY the requested tables", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    // Orphan rows (no backing base row) in two different vec tables.
    db()
      .query(
        "INSERT INTO temporal_vec(chunk_id, message_id, project_id, session_id, embedding) VALUES ('oT#0','oT',?,'s',?)",
      )
      .run(pid, toBlob(v(0, 1, 0, 0)));
    db()
      .query(
        "INSERT INTO distillation_vec(id, project_id, session_id, embedding) VALUES ('oD',?,'s',?)",
      )
      .run(pid, toBlob(v(0, 1, 0, 0)));

    gcVec0DanglingRows(db(), ["temporal"]); // filter: temporal only

    expect(
      (db().query("SELECT COUNT(*) n FROM temporal_vec").get() as { n: number })
        .n,
    ).toBe(0); // swept
    expect(
      (
        db().query("SELECT COUNT(*) n FROM distillation_vec").get() as {
          n: number;
        }
      ).n,
    ).toBe(1); // NOT requested → left intact
  });

  test("clearAllEmbeddings empties vec0 tables in vec0 mode", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insKnowledge("k1");
    storeEmbedding(db(), "knowledge", "k1", v(1, 0, 0, 0));
    clearAllEmbeddings(db());
    expect(
      (
        db().query("SELECT COUNT(*) n FROM knowledge_vec").get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
  });
});

describeVec("data.ts deletes reclaim vec0 orphans (#1132)", () => {
  const tvec = () =>
    (db().query("SELECT COUNT(*) n FROM temporal_vec").get() as { n: number })
      .n;
  const dvec = () =>
    (
      db().query("SELECT COUNT(*) n FROM distillation_vec").get() as {
        n: number;
      }
    ).n;
  const kvec = () =>
    (db().query("SELECT COUNT(*) n FROM knowledge_vec").get() as { n: number })
      .n;

  test("clearTemporal reclaims temporal_vec chunks, leaves distillation_vec", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporal("t1", "s", 1);
    insDistillation("d1", "s", 0);
    storeEmbedding(db(), "temporal", "t1", v(1, 0, 0, 0));
    storeEmbedding(db(), "distillations", "d1", v(1, 0, 0, 0));
    expect(tvec()).toBe(1);

    clearTemporal(PROJECT);

    expect(tvec()).toBe(0); // reclaimed
    expect(dvec()).toBe(1); // table filter left distillations alone
  });

  test("clearDistillations reclaims distillation_vec, leaves temporal_vec", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporal("t1", "s", 1);
    insDistillation("d1", "s", 0);
    storeEmbedding(db(), "temporal", "t1", v(1, 0, 0, 0));
    storeEmbedding(db(), "distillations", "d1", v(1, 0, 0, 0));

    clearDistillations(PROJECT);

    expect(dvec()).toBe(0);
    expect(tvec()).toBe(1);
  });

  test("clearKnowledge reclaims knowledge_vec", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insKnowledge("k1");
    storeEmbedding(db(), "knowledge", "k1", v(1, 0, 0, 0));
    expect(kvec()).toBe(1);

    clearKnowledge(PROJECT);

    expect(kvec()).toBe(0);
  });

  test("deleteDistillation point-deletes its vec0 chunk, keeps others", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insDistillation("d1", "s", 0);
    insDistillation("d2", "s", 0);
    storeEmbedding(db(), "distillations", "d1", v(1, 0, 0, 0));
    storeEmbedding(db(), "distillations", "d2", v(0, 1, 0, 0));

    deleteDistillation("d1");

    expect(
      db()
        .query("SELECT id FROM distillation_vec ORDER BY id")
        .all()
        .map((r) => (r as { id: string }).id),
    ).toEqual(["d2"]);
  });

  test("deleteSession reclaims that session's chunks, keeps other sessions'", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporal("t_s1", "s1", 1);
    insDistillation("d_s1", "s1", 0);
    insTemporal("t_s2", "s2", 1);
    storeEmbedding(db(), "temporal", "t_s1", v(1, 0, 0, 0));
    storeEmbedding(db(), "distillations", "d_s1", v(1, 0, 0, 0));
    storeEmbedding(db(), "temporal", "t_s2", v(0, 1, 0, 0));

    deleteSession(PROJECT, "s1");

    expect(
      db()
        .query("SELECT message_id FROM temporal_vec ORDER BY message_id")
        .all()
        .map((r) => (r as { message_id: string }).message_id),
    ).toEqual(["t_s2"]); // s1's temporal chunk gone, s2's kept
    expect(dvec()).toBe(0); // s1's distillation chunk gone
  });

  test("clearProject reclaims all three vec tables", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insKnowledge("k1");
    insTemporal("t1", "s", 1);
    insDistillation("d1", "s", 0);
    storeEmbedding(db(), "knowledge", "k1", v(1, 0, 0, 0));
    storeEmbedding(db(), "temporal", "t1", v(1, 0, 0, 0));
    storeEmbedding(db(), "distillations", "d1", v(1, 0, 0, 0));

    clearProject(PROJECT);

    expect(kvec()).toBe(0);
    expect(tvec()).toBe(0);
    expect(dvec()).toBe(0);
  });

  test("clearing one project leaves ANOTHER project's vec0 rows intact", () => {
    // The reclaim sweep is a GLOBAL anti-join, not project-scoped. This pins the
    // load-bearing safety property: it only ever removes a vec row whose base row
    // is gone, so a live sibling project is never touched.
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    const pidB = ensureProject("/test/vec0-cutover-other");
    // Project A (the harness PROJECT/pid) — will be cleared.
    insKnowledge("kA");
    insTemporal("tA", "s", 1);
    insDistillation("dA", "s", 0);
    // Project B — inserted against pidB directly; must survive.
    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at, logical_id) VALUES ('kB', ?, 'test', '', '', 0, 0, 'kB')",
      )
      .run(pidB);
    db()
      .query(
        "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at) VALUES ('tB', ?, 's', 'user', 'm', 0, 0, 1)",
      )
      .run(pidB);
    db()
      .query(
        "INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, created_at, archived) VALUES ('dB', ?, 's', '', '', 'obs', '', 0, 0, 0, 0)",
      )
      .run(pidB);
    for (const [t, id] of [
      ["knowledge", "kA"],
      ["temporal", "tA"],
      ["distillations", "dA"],
      ["knowledge", "kB"],
      ["temporal", "tB"],
      ["distillations", "dB"],
    ] as const) {
      storeEmbedding(db(), t, id, v(1, 0, 0, 0));
    }

    clearProject(PROJECT); // project A only

    // A's chunks reclaimed; B's untouched because B's base rows still exist.
    expect(
      db()
        .query("SELECT id FROM knowledge_vec ORDER BY id")
        .all()
        .map((r) => (r as { id: string }).id),
    ).toEqual(["kB"]);
    expect(
      db()
        .query("SELECT message_id FROM temporal_vec ORDER BY message_id")
        .all()
        .map((r) => (r as { message_id: string }).message_id),
    ).toEqual(["tB"]);
    expect(
      db()
        .query("SELECT id FROM distillation_vec ORDER BY id")
        .all()
        .map((r) => (r as { id: string }).id),
    ).toEqual(["dB"]);
  });
});

describeVec("moving a project re-points vec0 partition keys (#1138)", () => {
  // Enumerate a partition directly (proves the partition-key VALUE was re-pointed).
  const inT = (p: string) =>
    db()
      .query("SELECT message_id AS id FROM temporal_vec WHERE project_id = ?")
      .all(p)
      .map((r) => (r as { id: string }).id)
      .sort();
  const inD = (p: string) =>
    db()
      .query("SELECT id FROM distillation_vec WHERE project_id = ?")
      .all(p)
      .map((r) => (r as { id: string }).id)
      .sort();
  // Exercise the REAL read path (vector-query.ts:510): partition-filtered KNN.
  const recallT = (p: string) =>
    db()
      .query(
        "SELECT message_id AS id FROM temporal_vec WHERE embedding MATCH ? AND k = ? AND project_id = ? ORDER BY distance",
      )
      .all(toBlob(v(1, 0, 0, 0)), 10, p)
      .map((r) => (r as { id: string }).id)
      .sort();

  test("repartitionVec0Project re-points a session's chunks; other sessions stay", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    const pidB = ensureProject("/test/vec0-move-B");
    // sess1 (moved): two messages with DISTINCT vectors + a distillation.
    insTemporal("t1", "sess1", 1);
    insTemporal("t2", "sess1", 2);
    insDistillation("d1", "sess1", 0);
    // sess2 (same source project): a temporal AND a distillation that must STAY.
    // The distillation sibling guards the aux-column session_id filter against
    // over-moving (the inverse of the bug being fixed).
    insTemporal("t_keep", "sess2", 1);
    insDistillation("d_keep", "sess2", 0);
    storeEmbedding(db(), "temporal", "t1", v(1, 0, 0, 0));
    storeEmbedding(db(), "temporal", "t2", v(0, 1, 0, 0));
    storeEmbedding(db(), "distillations", "d1", v(1, 0, 0, 0));
    storeEmbedding(db(), "temporal", "t_keep", v(0, 0, 1, 0));
    storeEmbedding(db(), "distillations", "d_keep", v(0, 0, 1, 0));

    repartitionVec0Project(db(), pid, pidB, ["sess1"]);

    expect(inT(pidB)).toEqual(["t1", "t2"]); // sess1 chunks now under B
    expect(inT(pid)).toEqual(["t_keep"]); // sess2 temporal stays in A
    expect(inD(pidB)).toEqual(["d1"]);
    expect(inD(pid)).toEqual(["d_keep"]); // sess2 distillation stays in A
    // Embedding fidelity: a KNN probe under B ranks the exact-match vector first
    // (a corrupted/renormalized round-trip would scramble this ordering).
    expect(
      db()
        .query(
          "SELECT message_id AS id FROM temporal_vec WHERE embedding MATCH ? AND k = ? AND project_id = ? ORDER BY distance",
        )
        .all(toBlob(v(0, 1, 0, 0)), 2, pidB)
        .map((r) => (r as { id: string }).id),
    ).toEqual(["t2", "t1"]); // t2 (exact match) nearest, then t1
    // And the moved chunk is recallable under B, not A.
    expect(recallT(pid)).toEqual(["t_keep"]);
  });

  test("repartitionVec0Project with no sessionIds moves the WHOLE project (merge)", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    const pidB = ensureProject("/test/vec0-move-B2");
    insTemporal("t1", "sess1", 1);
    insTemporal("t2", "sess2", 1);
    insDistillation("d1", "sess1", 0);
    storeEmbedding(db(), "temporal", "t1", v(1, 0, 0, 0));
    storeEmbedding(db(), "temporal", "t2", v(1, 0, 0, 0));
    storeEmbedding(db(), "distillations", "d1", v(1, 0, 0, 0));

    repartitionVec0Project(db(), pid, pidB); // no session filter

    expect(inT(pidB)).toEqual(["t1", "t2"]);
    expect(inT(pid)).toEqual([]);
    expect(inD(pidB)).toEqual(["d1"]);
  });

  test("repartitionVec0Project is a no-op when from === to, on empty ids, and in blob mode", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    const pidB = ensureProject("/test/vec0-move-B3");
    insTemporal("t1", "sess1", 1);
    storeEmbedding(db(), "temporal", "t1", v(1, 0, 0, 0));

    repartitionVec0Project(db(), pid, pid, ["sess1"]); // from === to
    repartitionVec0Project(db(), pid, pidB, []); // empty session list
    expect(inT(pid)).toEqual(["t1"]); // untouched by both

    setStorageMode(db(), "blob");
    expect(() =>
      repartitionVec0Project(db(), pid, pidB, ["sess1"]),
    ).not.toThrow(); // blob no-op
  });

  test("moveSessions makes the moved session recallable under the new project", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporal("m1", "moveSess", 1);
    insDistillation("md1", "moveSess", 0);
    storeEmbedding(db(), "temporal", "m1", v(1, 0, 0, 0));
    storeEmbedding(db(), "distillations", "md1", v(1, 0, 0, 0));

    const toPath = "/test/vec0-move-target";
    moveSessions(["moveSess"], pid, toPath);
    const pidTarget = ensureProject(toPath);

    // Before this fix, these vec rows stayed under `pid` and were invisible to a
    // search scoped to the new project.
    expect(recallT(pidTarget)).toEqual(["m1"]);
    expect(inD(pidTarget)).toEqual(["md1"]);
    expect(inT(pid)).toEqual([]);
    expect(inD(pid)).toEqual([]);
  });

  test("mergeProjectInternal re-points the source project's vec0 rows", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    const target = ensureProject("/test/vec0-merge-target");
    insTemporal("s1", "sess1", 1);
    insDistillation("sd1", "sess1", 0);
    storeEmbedding(db(), "temporal", "s1", v(1, 0, 0, 0));
    storeEmbedding(db(), "distillations", "sd1", v(1, 0, 0, 0));

    mergeProjectInternal(pid, target);

    expect(inT(target)).toEqual(["s1"]);
    expect(inD(target)).toEqual(["sd1"]);
    expect(inT(pid)).toEqual([]);
    expect(inD(pid)).toEqual([]);
  });
});

describeVec("maybeCutoverToVec0 (real orchestration, config dim = 768)", () => {
  const TABLES = [
    "knowledge",
    "entities",
    "distillations",
    "temporal",
  ] as const;
  // The real function uses the configured embedding dimension (768 in tests),
  // so seed blobs at that width.
  function v768(lead: number): Float32Array {
    const a = new Float32Array(768);
    a[lead] = 1; // already unit-norm
    return a;
  }

  test("full cutover: flips mode, drops every column, populates vec0; idempotent", () => {
    insKnowledge("k1");
    insTemporal("t1", "s", 1);
    db()
      .query("UPDATE knowledge SET embedding = ? WHERE id='k1'")
      .run(toBlob(v768(0)));
    db()
      .query("UPDATE temporal_messages SET embedding = ? WHERE id='t1'")
      .run(toBlob(v768(1)));
    expect(readStorageMode(db())).toBe("blob");

    maybeCutoverToVec0();

    expect(readStorageMode(db())).toBe("vec0");
    for (const t of TABLES) expect(embeddingColumnExists(db(), t)).toBe(false);
    expect(
      (
        db().query("SELECT COUNT(*) n FROM knowledge_vec").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
    // idempotent re-run is a no-op (mode already vec0, columns already gone)
    expect(() => maybeCutoverToVec0()).not.toThrow();
    expect(readStorageMode(db())).toBe("vec0");
  });

  test("B1: resumes a crash mid-reclaim (mode=vec0, only some columns dropped)", () => {
    // Simulate the post-flip / partial-drop state a crash can leave behind.
    ensureVec0Store(db(), 768);
    setStorageMode(db(), "vec0");
    dropEmbeddingColumn(db(), "knowledge"); // knowledge dropped; others remain
    expect(embeddingColumnExists(db(), "entities")).toBe(true);

    maybeCutoverToVec0(); // reclaim finishes the remaining drops

    expect(readStorageMode(db())).toBe("vec0");
    for (const t of TABLES) expect(embeddingColumnExists(db(), t)).toBe(false);
  });

  test("the real cutover skips a stale-dimension blob (768) and still completes", () => {
    // Exercises the real maybeCutoverToVec0 stale-skip path end-to-end (not just
    // the test-dimension mirror): a valid 768-dim row alongside a legacy 384-dim
    // (1536-byte) blob. (The operator notice is covered by the next test.)
    insTemporal("t_ok", "s", 1);
    insTemporal("t_stale", "s", 2);
    db()
      .query("UPDATE temporal_messages SET embedding = ? WHERE id='t_ok'")
      .run(toBlob(v768(0)));
    db()
      .query("UPDATE temporal_messages SET embedding = ? WHERE id='t_stale'")
      .run(toBlob(new Float32Array(384))); // wrong dim → skipped, not aborted
    expect(readStorageMode(db())).toBe("blob");

    expect(() => maybeCutoverToVec0()).not.toThrow();

    expect(readStorageMode(db())).toBe("vec0");
    const tids = (
      db()
        .query("SELECT message_id FROM temporal_vec ORDER BY message_id")
        .all() as { message_id: string }[]
    ).map((r) => r.message_id);
    expect(tids).toEqual(["t_ok"]); // valid relocated; stale-dim skipped
  });

  test("re-arms the temporal re-chunk walk on cutover so skipped/legacy rows get re-embedded", () => {
    // A stale done flag from a hypothetical prior state. The flag cannot actually
    // latch in blob mode (see the ordering invariant in backfillTemporalEmbeddings),
    // but the cutover must clear it regardless so a future refactor can never
    // strand the post-cutover temporal walk — that walk is what recreates the
    // stale-dim blobs this migration deliberately skips.
    setKV("lore:temporal_rechunk.done", "1");
    setKV("lore:temporal_rechunk.cursor", "some-old-cursor");
    insKnowledge("k1");
    db()
      .query("UPDATE knowledge SET embedding = ? WHERE id='k1'")
      .run(toBlob(v768(0)));
    expect(readStorageMode(db())).toBe("blob");

    maybeCutoverToVec0();

    expect(readStorageMode(db())).toBe("vec0");
    // Armed again: done cleared to "0", cursor reset to the start of the corpus.
    expect(getKV("lore:temporal_rechunk.done")).toBe("0");
    expect(getKV("lore:temporal_rechunk.cursor")).toBe("");
  });

  test("emits a single operator notice with the count SUMMED across tables", () => {
    // Seed stale-dim (384-dim, 1536-byte) blobs in TWO different base tables so
    // the notice must sum copyBlobsToVec0's per-table returns — a per-table-only
    // count would report 1, not 2. Each table also gets a valid 768-dim row so
    // the cutover relocates real data alongside the skips.
    const stale = () => toBlob(new Float32Array(384));
    insKnowledge("k_ok");
    insKnowledge("k_stale");
    insTemporal("t_ok", "s", 1);
    insTemporal("t_stale", "s", 2);
    db()
      .query("UPDATE knowledge SET embedding = ? WHERE id='k_ok'")
      .run(toBlob(v768(0)));
    db()
      .query("UPDATE knowledge SET embedding = ? WHERE id='k_stale'")
      .run(stale());
    db()
      .query("UPDATE temporal_messages SET embedding = ? WHERE id='t_ok'")
      .run(toBlob(v768(1)));
    db()
      .query("UPDATE temporal_messages SET embedding = ? WHERE id='t_stale'")
      .run(stale());
    expect(readStorageMode(db())).toBe("blob");

    const noticeSpy = vi.spyOn(log, "notice").mockImplementation(() => {});
    try {
      maybeCutoverToVec0();
      // Exactly one notice, carrying the SUM (2) across knowledge + temporal —
      // not a per-table 1, and not silence (a forced sum of 0 would skip it).
      expect(noticeSpy).toHaveBeenCalledTimes(1);
      expect(noticeSpy.mock.calls[0][0]).toContain(
        "2 stale-dimension embedding blob(s)",
      );
    } finally {
      noticeSpy.mockRestore();
    }
    expect(readStorageMode(db())).toBe("vec0");
  });

  test("emits NO operator notice when the corpus has no stale-dim blobs", () => {
    // Guards the `staleSkipped > 0` gate: a clean corpus must cut over silently.
    insKnowledge("k_ok");
    db()
      .query("UPDATE knowledge SET embedding = ? WHERE id='k_ok'")
      .run(toBlob(v768(0)));
    expect(readStorageMode(db())).toBe("blob");

    const noticeSpy = vi.spyOn(log, "notice").mockImplementation(() => {});
    try {
      maybeCutoverToVec0();
      expect(noticeSpy).not.toHaveBeenCalled();
    } finally {
      noticeSpy.mockRestore();
    }
    expect(readStorageMode(db())).toBe("vec0");
  });
});

describeVec("post-filter over-fetch widening (S1)", () => {
  test("distillations: returns `limit` non-archived even when nearer rows are all archived", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    // 60 archived rows nearest the query (beyond the initial over-fetch window
    // of overfetchK(3)=53), and 3 non-archived rows slightly farther. The first
    // KNN window is all-archived → 0 survivors → must widen to a full scan.
    for (let i = 0; i < 60; i++) {
      insDistillation(`arch${i}`, "s", 1);
      storeEmbedding(db(), "distillations", `arch${i}`, v(1, 0, 0, 0));
    }
    for (let i = 0; i < 3; i++) {
      insDistillation(`live${i}`, "s", 0);
      storeEmbedding(db(), "distillations", `live${i}`, v(0.9, 0.1, 0, 0));
    }
    const hits = runVectorQuery(db(), "vec0", v(1, 0, 0, 0), {
      kind: "distillations",
      limit: 3,
    }) as VectorHit[];
    expect(hits.length).toBe(3);
    expect(hits.every((h) => h.id.startsWith("live"))).toBe(true);
  });
});

describeVec("by-id vector point reads in vec0 mode (S2)", () => {
  test("embeddingByIdSource reads vectors (and the distillation session_id aux) back from vec0", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insKnowledge("k1");
    insDistillation("d1", "sess-A", 0);
    db()
      .query(
        "INSERT INTO entities (id, project_id, entity_type, canonical_name, cross_project, created_at, updated_at) VALUES ('e1', ?, 'tool', 'E', 0, ?, ?)",
      )
      .run(pid, Date.now(), Date.now());
    storeEmbedding(db(), "knowledge", "k1", v(1, 0, 0, 0));
    storeEmbedding(db(), "entities", "e1", v(0, 1, 0, 0));
    storeEmbedding(db(), "distillations", "d1", v(0, 0, 1, 0));

    // knowledge (mirrors the ltm.ts by-id reads, source view knowledge_current)
    const ks = embeddingByIdSource("knowledge", "vec0", "knowledge_current");
    const krow = db()
      .query(
        `SELECT id, embedding FROM ${ks.table} WHERE id IN ('k1')${ks.presenceFilter}`,
      )
      .get() as { embedding: Uint8Array };
    expect(Array.from(fromBlob(krow.embedding))).toEqual(
      Array.from(v(1, 0, 0, 0)),
    );

    // entities (mirrors entities.ts dedup)
    const es = embeddingByIdSource("entities", "vec0", "entities");
    expect(
      db()
        .query(
          `SELECT id FROM ${es.table} WHERE id IN ('e1')${es.presenceFilter}`,
        )
        .all().length,
    ).toBe(1);

    // distillations WITH session_id aux (mirrors pattern-echo.ts)
    const ds = embeddingByIdSource("distillations", "vec0", "distillations");
    const drow = db()
      .query(
        `SELECT id, session_id, embedding FROM ${ds.table} WHERE id IN ('d1')${ds.presenceFilter}`,
      )
      .get() as { session_id: string; embedding: Uint8Array };
    expect(drow.session_id).toBe("sess-A");
    expect(Array.from(fromBlob(drow.embedding))).toEqual(
      Array.from(v(0, 0, 1, 0)),
    );
  });
});

describe("mode-aware detection predicates", () => {
  test("missingEmbeddingSql / hasEmbeddingSql switch on storage mode", () => {
    expect(missingEmbeddingSql("knowledge", "blob")).toBe("embedding IS NULL");
    expect(hasEmbeddingSql("knowledge", "blob")).toBe("embedding IS NOT NULL");
    expect(missingEmbeddingSql("knowledge", "vec0")).toBe(
      "id NOT IN (SELECT id FROM knowledge_vec)",
    );
    expect(hasEmbeddingSql("entities", "vec0", "e")).toBe(
      "e.id IN (SELECT id FROM entity_vec)",
    );
    // temporal keys vec0 by message_id, not id
    expect(missingEmbeddingSql("temporal", "vec0")).toBe(
      "id NOT IN (SELECT message_id FROM temporal_vec)",
    );
  });
});

// --- Phase 2 multi-vector temporal writes -----------------------------------
function chunkIds(messageId: string): string[] {
  return (
    db()
      .query(
        "SELECT chunk_id FROM temporal_vec WHERE message_id = ? ORDER BY chunk_id",
      )
      .all(messageId) as Array<{ chunk_id: string }>
  ).map((r) => r.chunk_id);
}

describeVec("multi-vector temporal writes (storeTemporalChunks)", () => {
  test("writes one vec0 chunk per vector, keyed <id>#<ord> with partition + aux", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporal("m1", "sX", 1000);
    storeTemporalChunks(db(), "m1", [
      v(1, 0, 0, 0),
      v(0, 1, 0, 0),
      v(0, 0, 1, 0),
    ]);

    const rows = db()
      .query(
        "SELECT chunk_id, message_id, project_id, session_id FROM temporal_vec WHERE message_id = 'm1' ORDER BY chunk_id",
      )
      .all() as Array<{
      chunk_id: string;
      message_id: string;
      project_id: string;
      session_id: string;
    }>;
    expect(rows.map((r) => r.chunk_id)).toEqual(["m1#0", "m1#1", "m1#2"]);
    expect(
      rows.every(
        (r) =>
          r.message_id === "m1" &&
          r.project_id === pid &&
          r.session_id === "sX",
      ),
    ).toBe(true);
  });

  test("re-embed replaces the WHOLE chunk set (a per-chunk-id upsert would orphan removed ords)", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporal("m1", "sX", 1000);
    storeTemporalChunks(db(), "m1", [
      v(1, 0, 0, 0),
      v(0, 1, 0, 0),
      v(0, 0, 1, 0),
    ]);
    // Re-embed to FEWER chunks: #1 and #2 must be deleted, not left dangling.
    const calls: string[] = [];
    log.registerSink(recordSql(calls));
    storeTemporalChunks(db(), "m1", [v(0, 0, 0, 1)]);
    expectExactTemporalDeletes(calls, 1);
    expect(chunkIds("m1")).toEqual(["m1#0"]);
  });

  test("empty replacement preserves the prior complete chunk set", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporal("m1", "sX", 1000);
    storeTemporalChunks(db(), "m1", [
      v(1, 0, 0, 0),
      v(0, 1, 0, 0),
      v(0, 0, 1, 0),
    ]);

    const calls: string[] = [];
    log.registerSink(recordSql(calls));
    storeTemporalChunks(db(), "m1", []);

    expect(
      calls.some((sql) => sql.startsWith("DELETE FROM temporal_vec")),
    ).toBe(false);
    expect(chunkIds("m1")).toEqual(["m1#0", "m1#1", "m1#2"]);
  });

  test("re-embed restores the prior complete chunk set when an insert fails", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporal("m1", "sX", 1000);
    storeTemporalChunks(db(), "m1", [
      v(1, 0, 0, 0),
      v(0, 1, 0, 0),
      v(0, 0, 1, 0),
    ]);

    let inserts = 0;
    log.registerSink({
      ...passthroughSink,
      withDbSpan<T>(sql: string, fn: () => T): T {
        if (sql.startsWith("INSERT INTO temporal_vec")) {
          inserts++;
          if (inserts === 2)
            throw new Error("injected temporal insert failure");
        }
        return fn();
      },
    });

    expect(() =>
      storeTemporalChunks(db(), "m1", [v(0, 0, 0, 1), v(1, 1, 0, 0)]),
    ).toThrow("injected temporal insert failure");
    expect(chunkIds("m1")).toEqual(["m1#0", "m1#1", "m1#2"]);
  });

  test("rejects chunk sets that cleanup cannot address", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporal("m1", "sX", 1000);

    expect(() =>
      storeTemporalChunks(
        db(),
        "m1",
        Array.from({ length: MAX_TEMPORAL_CHUNKS_PER_MESSAGE + 1 }, () =>
          v(1, 0, 0, 0),
        ),
      ),
    ).toThrow(
      `storeTemporalChunks: ${MAX_TEMPORAL_CHUNKS_PER_MESSAGE + 1} chunks exceeds the ${MAX_TEMPORAL_CHUNKS_PER_MESSAGE}-chunk limit`,
    );
    expect(chunkIds("m1")).toEqual([]);
  });

  test("rejects incomplete provider output before replacing a complete chunk set", async () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporal("m1", "sX", 1000);
    storeTemporalChunks(db(), "m1", [
      v(1, 0, 0, 0),
      v(0, 1, 0, 0),
      v(0, 0, 1, 0),
    ]);

    const token = _saveAndClearProvider();
    try {
      _restoreProvider({
        provider: {
          maxBatchSize: 8,
          async embed() {
            return [v(0, 0, 0, 1)];
          },
        },
      });
      await expect(
        embedInTokenBatches(["first chunk", "second chunk"], "document"),
      ).rejects.toThrow(
        "embedding provider returned an unexpected vector count",
      );
    } finally {
      _saveAndClearProvider();
      _restoreProvider(token);
    }
    expect(chunkIds("m1")).toEqual(["m1#0", "m1#1", "m1#2"]);
  });

  test("is a no-op (and never throws) outside vec0 mode", () => {
    // resetToBlob() left us in blob layout with no temporal_vec table at all.
    insTemporal("m1", "sX", 1000);
    expect(() =>
      storeTemporalChunks(db(), "m1", [v(1, 0, 0, 0)]),
    ).not.toThrow();
    const base = db()
      .query("SELECT embedding FROM temporal_messages WHERE id = 'm1'")
      .get() as { embedding: Buffer | null };
    expect(base.embedding).toBeNull(); // multi-vector never touches the blob col
  });

  test("skips when the base message row is gone (a delete raced the embed)", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    expect(() =>
      storeTemporalChunks(db(), "ghost", [v(1, 0, 0, 0)]),
    ).not.toThrow();
    expect(chunkIds("ghost")).toEqual([]);
  });

  test("does not recreate chunks when base-row deletion finishes before replacement starts", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporal("m1", "sX", 1000);
    storeTemporalChunks(db(), "m1", [v(1, 0, 0, 0)]);

    let raced = false;
    log.registerSink({
      ...passthroughSink,
      withDbSpan<T>(sql: string, fn: () => T): T {
        if (!raced && sql === "SAVEPOINT store_temporal_chunks") {
          raced = true;
          db().query("DELETE FROM temporal_messages WHERE id = ?").run("m1");
          deleteEmbeddings(db(), "temporal", ["m1"]);
        }
        return fn();
      },
    });

    storeTemporalChunks(db(), "m1", [v(0, 1, 0, 0)]);
    expect(raced).toBe(true);
    expect(chunkIds("m1")).toEqual([]);
  });
});

describeVec("temporal re-chunk durable admission", () => {
  const DONE_KEY = "lore:temporal_rechunk.done";
  const CURSOR_KEY = "lore:temporal_rechunk.cursor";
  const MAX_ROWID_KEY = "lore:temporal_rechunk.max_rowid";
  const CONFIG_KEY = "lore:embedding_config";
  const LONG =
    "A temporal message with enough semantic content for durable embedding admission.";

  beforeEach(() => {
    db()
      .query("DELETE FROM kv_meta WHERE key IN (?, ?, ?, ?)")
      .run(DONE_KEY, CURSOR_KEY, MAX_ROWID_KEY, CONFIG_KEY);
    db().query("DELETE FROM temporal_embedding_queue").run();
  });

  function insertContent(id: string, content = LONG, distilled = 0): void {
    db()
      .query(
        "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at) VALUES (?, ?, 'sX', 'user', ?, 0, ?, 0)",
      )
      .run(id, pid, content, distilled);
  }

  function queuedIds(): string[] {
    return (
      db()
        .query(
          "SELECT message_id FROM temporal_embedding_queue ORDER BY message_id",
        )
        .all() as Array<{ message_id: string }>
    ).map((row) => row.message_id);
  }

  test("schedules the whole legacy corpus without invoking a provider and invalidates stale vectors", async () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insertContent("m1", LONG, 1);
    storeTemporalChunks(db(), "m1", [v(1, 0, 0, 0)]);
    const token = _saveAndClearProvider();
    const embed = vi.fn(async () => [v(1, 0, 0, 0)]);
    try {
      _restoreProvider({ provider: { maxBatchSize: 8, embed } });
      expect(await backfillTemporalEmbeddings()).toBe(1);
    } finally {
      _restoreProvider(token);
    }

    expect(embed).not.toHaveBeenCalled();
    expect(chunkIds("m1")).toEqual([]);
    expect(queuedIds()).toEqual(["m1"]);
    expect(getKV(CURSOR_KEY)).toBe("m1");
    expect(getKV(DONE_KEY)).toBe("1");
  });

  test("schedules legacy content past an embedded NUL with consistent progress counts", async () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insertContent("nul-row", `x\0${"a".repeat(100)}`);
    const info = vi.spyOn(log, "info");
    try {
      expect(await backfillTemporalEmbeddings()).toBe(1);
      expect(queuedIds()).toEqual(["nul-row"]);
      expect(getKV(CURSOR_KEY)).toBe("nul-row");
      expect(getKV(DONE_KEY)).toBe("1");
      const lines = info.mock.calls.map((call) => call.map(String).join(" "));
      expect(
        lines.some((line) =>
          /1 messages to scan \(0\/1 already done, 0%\)/.test(line),
        ),
      ).toBe(true);
      expect(
        lines.some((line) =>
          /100% complete \(1\/1 messages\) · \+1 scheduled this run/.test(line),
        ),
      ).toBe(true);
    } finally {
      info.mockRestore();
    }
  });

  test("preserves a valid vector when identical work is already queued", async () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insertContent("m1");
    storeTemporalChunks(db(), "m1", [v(1, 0, 0, 0)]);
    enqueueTemporalEmbedding("m1", LONG);

    expect(await backfillTemporalEmbeddings()).toBe(0);

    expect(queuedIds()).toEqual(["m1"]);
    expect(chunkIds("m1")).toEqual(["m1#0"]);
    expect(getKV(CURSOR_KEY)).toBe("m1");
    expect(getKV(DONE_KEY)).toBe("1");
  });

  test("is a no-op in blob mode and never latches done", async () => {
    insertContent("m1");
    expect(await backfillTemporalEmbeddings()).toBe(0);
    expect(queuedIds()).toEqual([]);
    expect(getKV(DONE_KEY)).toBeNull();
  });

  test("does nothing after durable admission is complete", async () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insertContent("m1");
    setKV(DONE_KEY, "1");
    expect(await backfillTemporalEmbeddings()).toBe(0);
    expect(queuedIds()).toEqual([]);
  });

  test("resumes strictly after the persisted cursor and skips short rows", async () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insertContent("a_short", "tiny");
    insertContent("m1");
    insertContent("m2");
    insertContent("m3");
    setKV(CURSOR_KEY, "m2");

    expect(await backfillTemporalEmbeddings()).toBe(1);
    expect(queuedIds()).toEqual(["m3"]);
    expect(getKV(CURSOR_KEY)).toBe("m3");
    expect(getKV(DONE_KEY)).toBe("1");
  });

  test("resetTemporalRechunkProgress re-arms durable admission", async () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insertContent("m1");
    expect(await backfillTemporalEmbeddings()).toBe(1);
    db().query("DELETE FROM temporal_embedding_queue").run();
    expect(await backfillTemporalEmbeddings()).toBe(0);

    resetTemporalRechunkProgress();
    expect(await backfillTemporalEmbeddings()).toBe(1);
    expect(queuedIds()).toEqual(["m1"]);
  });

  test("checkConfigChange re-arms durable admission after clearing vectors", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), config().search.embeddings.dimensions);
    setKV(DONE_KEY, "1");
    setKV(CONFIG_KEY, "stale-fingerprint");
    expect(checkConfigChange()).toBe(true);
    expect(getKV(DONE_KEY)).toBe("0");
    expect(getKV(CURSOR_KEY)).toBe("");
  });

  test("atomically commits queue admission, vector invalidation, and cursor progress", async () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insertContent("m1");
    storeTemporalChunks(db(), "m1", [v(1, 0, 0, 0)]);

    db().exec(`CREATE TRIGGER reject_temporal_admission
      BEFORE INSERT ON temporal_embedding_queue
      BEGIN SELECT RAISE(ABORT, 'reject temporal admission'); END`);
    await expect(backfillTemporalEmbeddings()).rejects.toThrow(
      "reject temporal admission",
    );
    db().exec("DROP TRIGGER reject_temporal_admission");
    expect(queuedIds()).toEqual([]);
    expect(chunkIds("m1")).toEqual(["m1#0"]);
    expect(getKV(CURSOR_KEY)).toBeNull();
  });

  test("parks before admission and ignores a throwing host gate", async () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insertContent("m1");
    let checks = 0;
    expect(
      await backfillTemporalEmbeddings({
        shouldPause: () => checks++ === 0,
      }),
    ).toBe(1);
    expect(checks).toBeGreaterThanOrEqual(2);

    resetTemporalRechunkProgress();
    db().query("DELETE FROM temporal_embedding_queue").run();
    expect(
      await backfillTemporalEmbeddings({
        shouldPause: () => {
          throw new Error("host predicate failed");
        },
      }),
    ).toBe(1);
  });

  test("does not chase live rows inserted after its durable snapshot", async () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insertContent("m1");
    let inserted = false;

    expect(
      await backfillTemporalEmbeddings({
        shouldPause: () => {
          if (inserted) return false;
          inserted = true;
          insertContent("m2");
          enqueueTemporalEmbedding("m2", LONG);
          return false;
        },
      }),
    ).toBe(1);

    expect(queuedIds()).toEqual(["m1", "m2"]);
    expect(getKV(CURSOR_KEY)).toBe("m1");
    expect(getKV(DONE_KEY)).toBe("1");
  });

  test("reports cumulative scheduling progress across restarts", async () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insertContent("m1");
    insertContent("m2");
    insertContent("m3");
    insertContent("m4");
    setKV(CURSOR_KEY, "m2");
    const info = vi.spyOn(log, "info");
    try {
      expect(await backfillTemporalEmbeddings()).toBe(2);
      const lines = info.mock.calls.map((call) => call.map(String).join(" "));
      expect(
        lines.some((line) =>
          /2 messages to scan \(2\/4 already done, 50%\), resuming/.test(line),
        ),
      ).toBe(true);
      expect(
        lines.some((line) =>
          /100% complete \(4\/4 messages\) · \+2 scheduled this run/.test(line),
        ),
      ).toBe(true);
    } finally {
      info.mockRestore();
    }
  });
});

describeVec("prune drops the pruned rows' vec0 chunks (no orphans)", () => {
  const DAY = 24 * 60 * 60 * 1000;

  function insDistilledTemporal(id: string, ageDays: number, size = 100): void {
    db()
      .query(
        "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at) VALUES (?, ?, 's', 'user', ?, ?, 1, ?)",
      )
      .run(
        id,
        pid,
        "x".repeat(size),
        Math.ceil(size / 4),
        Date.now() - ageDays * DAY,
      );
  }
  function insArchivedDistillation(
    id: string,
    ageDays: number,
    archived: 0 | 1,
  ): void {
    db()
      .query(
        "INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, created_at, archived) VALUES (?, ?, 's', '', '', 'obs', '', 0, 0, ?, ?)",
      )
      .run(id, pid, Date.now() - ageDays * DAY, archived);
  }
  const tvec = (id: string) =>
    (
      db()
        .query("SELECT COUNT(*) n FROM temporal_vec WHERE message_id = ?")
        .get(id) as { n: number }
    ).n;
  const dvec = (id: string) =>
    (
      db()
        .query("SELECT COUNT(*) n FROM distillation_vec WHERE id = ?")
        .get(id) as { n: number }
    ).n;

  test("TTL pass drops the pruned message's temporal_vec chunk, keeps survivors'", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insDistilledTemporal("t_old", 130);
    insDistilledTemporal("t_new", 10);
    storeEmbedding(db(), "temporal", "t_old", v(1, 0, 0, 0));
    storeEmbedding(db(), "temporal", "t_new", v(0, 1, 0, 0));
    expect(tvec("t_old")).toBe(1);
    expect(tvec("t_new")).toBe(1);

    const res = prune({
      projectPath: PROJECT,
      retentionDays: 120,
      maxStorageMB: 1024,
    });
    expect(res.ttlDeleted).toBe(1);

    // The pruned message's chunk is gone — NOT left dangling in temporal_vec —
    // while the survivor keeps its chunk.
    expect(tvec("t_old")).toBe(0);
    expect(tvec("t_new")).toBe(1);
  });

  test("size-cap pass drops the evicted messages' temporal_vec chunks", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    const size = 400 * 1024; // 3 × ~400 KB = ~1.2 MB, cap 1 MB → oldest evicted
    insDistilledTemporal("c_old", 5, size);
    insDistilledTemporal("c_mid", 3, size);
    insDistilledTemporal("c_new", 1, size);
    storeEmbedding(db(), "temporal", "c_old", v(1, 0, 0, 0));
    storeEmbedding(db(), "temporal", "c_mid", v(0, 1, 0, 0));
    storeEmbedding(db(), "temporal", "c_new", v(0, 0, 1, 0));

    const res = prune({
      projectPath: PROJECT,
      retentionDays: 120,
      maxStorageMB: 1,
    });
    expect(res.capDeleted).toBeGreaterThan(0);

    // The oldest was evicted → its chunk must be gone too; the newest survives.
    expect(tvec("c_old")).toBe(0);
    expect(tvec("c_new")).toBe(1);
  });

  test("archived-distillation pass drops the pruned distillation_vec rows", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insArchivedDistillation("d_old_arch", 130, 1); // old + archived → pruned
    insArchivedDistillation("d_new_arch", 10, 1); // recent archived → kept
    insArchivedDistillation("d_old_live", 130, 0); // old but not archived → kept
    storeEmbedding(db(), "distillations", "d_old_arch", v(1, 0, 0, 0));
    storeEmbedding(db(), "distillations", "d_new_arch", v(0, 1, 0, 0));
    storeEmbedding(db(), "distillations", "d_old_live", v(0, 0, 1, 0));
    expect(dvec("d_old_arch")).toBe(1);

    prune({ projectPath: PROJECT, retentionDays: 120, maxStorageMB: 1024 });

    expect(dvec("d_old_arch")).toBe(0); // pruned row's vec chunk dropped
    expect(dvec("d_new_arch")).toBe(1); // recent archived kept
    expect(dvec("d_old_live")).toBe(1); // non-archived kept
  });
});
