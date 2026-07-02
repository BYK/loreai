// End-to-end tests for the FLAT-vec0 storage layout: write/read round-trip,
// the blob→vec0 cutover (backfill + DROP COLUMN + flip, idempotent/resumable),
// vec0↔blob exact parity, partition pushdown + recency-cap removal, dimension
// change, delete maintenance, and the dangling-row GC backstop.
//
// All run against the real vec0-capable test connection (the vendored sqlite-vec
// loads in the node test runtime). The suite is skipped if the extension is
// somehow unavailable so a vec-less CI lane stays green.
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
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
  setStorageMode,
  storeEmbedding,
  storeTemporalChunks,
} from "../src/db/vec-store";
import {
  _restoreProvider,
  _saveAndClearProvider,
  backfillTemporalEmbeddings,
  checkConfigChange,
  embedTemporalMessage,
  LocalProviderUnavailableError,
  MAX_TEMPORAL_CHUNKS_PER_MESSAGE,
  maybeCutoverToVec0,
  resetTemporalRechunkProgress,
} from "../src/embedding";
import * as log from "../src/log";
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
import { partsToText, prune } from "../src/temporal";
import type { LorePart } from "../src/types";
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

let pid: string;

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
}

beforeEach(() => {
  pid = ensureProject(PROJECT);
  resetToBlob();
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

    // Recreated: backfillTemporalEmbeddings walks the full corpus and rebuilds
    // the row's vectors from `content`. Clear the walk's KV flags so it is
    // un-armed, then run it under a deterministic DIM-length mock provider.
    db()
      .query("DELETE FROM kv_meta WHERE key IN (?, ?, ?)")
      .run(
        "lore:temporal_rechunk.done",
        "lore:temporal_rechunk.cursor",
        "lore:temporal_rechunk.attempts",
      );
    const token = _saveAndClearProvider();
    try {
      _restoreProvider({
        provider: {
          maxBatchSize: 8,
          async embed(texts: string[]) {
            return texts.map(() => v(1, 0, 0, 0));
          },
        },
      });
      expect(await backfillTemporalEmbeddings()).toBe(1);
    } finally {
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
});

describeVec("delete maintenance + GC", () => {
  test("deleteEmbeddings removes vec0 rows in vec0 mode and is a no-op in blob mode", () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insKnowledge("k1");
    insTemporal("t1", "s", 1);
    storeEmbedding(db(), "knowledge", "k1", v(1, 0, 0, 0));
    storeEmbedding(db(), "temporal", "t1", v(1, 0, 0, 0));

    deleteEmbeddings(db(), "knowledge", ["k1"]);
    deleteEmbeddings(db(), "temporal", ["t1"]); // by message_id (aux)
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
// Part fixtures mirror temporal.partsToText so content is byte-identical to prod.
function textPart(text: string): LorePart {
  return { type: "text", text } as LorePart;
}
function reasoningPart(text: string): LorePart {
  return { type: "reasoning", text } as LorePart;
}
function toolPart(tool: string, output: string): LorePart {
  return {
    type: "tool",
    tool,
    state: { status: "completed", output },
  } as unknown as LorePart;
}
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
    storeTemporalChunks(db(), "m1", [v(0, 0, 0, 1)]);
    expect(chunkIds("m1")).toEqual(["m1#0"]);
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

  test("embedTemporalMessage (vec0) embeds each part-aware unit and stores one chunk per unit", async () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporal("m1", "sX", 1000);
    const content = partsToText([
      textPart("Investigating the failure."),
      reasoningPart("Likely the parser."),
      toolPart("read", `src/parse.ts\n${"BODY ".repeat(2000)}`),
    ]);

    let captured: string[] | null = null;
    const token = _saveAndClearProvider();
    try {
      _restoreProvider({
        provider: {
          maxBatchSize: 8,
          async embed(texts: string[]) {
            captured = texts;
            return texts.map((_t, i) => v(1, i, 0, 0));
          },
        },
      });
      embedTemporalMessage("m1", content);
      // Fire-and-forget: poll until the embed → storeTemporalChunks chain lands.
      for (let i = 0; i < 100; i++) {
        if (
          (
            db()
              .query(
                "SELECT COUNT(*) n FROM temporal_vec WHERE message_id = 'm1'",
              )
              .get() as { n: number }
          ).n >= 3
        ) {
          break;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    } finally {
      _restoreProvider(token);
    }

    // One embed text per unit; the tool BODY is dropped (header + first line).
    expect(captured).toEqual([
      "Investigating the failure.",
      "[reasoning] Likely the parser.",
      "[tool:read] src/parse.ts",
    ]);
    expect((captured as unknown as string[]).join("\n")).not.toContain("BODY");
    // And exactly three chunks were written, one per unit.
    expect(chunkIds("m1")).toEqual(["m1#0", "m1#1", "m1#2"]);
  });

  test("embedTemporalMessage (vec0) drops empty/whitespace units — no empty chunk", async () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporal("m1", "sX", 1000);
    // A whitespace-only text part sits between two real units; it must be
    // filtered out so the embedder never sees an empty string and no empty
    // chunk is written (ords stay dense over the surviving units).
    const content = partsToText([
      textPart("   "),
      textPart("Investigating the parser bug in detail."),
      toolPart("read", "src/parse.ts\nirrelevant body"),
    ]);

    let captured: string[] | null = null;
    const token = _saveAndClearProvider();
    try {
      _restoreProvider({
        provider: {
          maxBatchSize: 8,
          async embed(texts: string[]) {
            captured = texts;
            return texts.map((_t, i) => v(1, i, 0, 0));
          },
        },
      });
      embedTemporalMessage("m1", content);
      for (let i = 0; i < 100; i++) {
        if (
          (
            db()
              .query(
                "SELECT COUNT(*) n FROM temporal_vec WHERE message_id = 'm1'",
              )
              .get() as { n: number }
          ).n >= 2
        ) {
          break;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    } finally {
      _restoreProvider(token);
    }

    // The whitespace unit is gone: only the two real units are embedded/stored.
    expect(captured).toEqual([
      "Investigating the parser bug in detail.",
      "[tool:read] src/parse.ts",
    ]);
    expect(chunkIds("m1")).toEqual(["m1#0", "m1#1"]);
  });

  test("embedTemporalMessage (vec0) sub-batches the unit embeds — never one oversized worker request", async () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporal("m1", "sX", 1000);
    // 9 units > MAX_BACKFILL_CHUNK (8) so nextBatch must split into >1 worker
    // request; if the path ever reverts to a single embed() call this drops to
    // one batch and the assertion below fails.
    const units = Array.from(
      { length: 9 },
      (_, i) => `Investigating step ${i} of the parser regression.`,
    );
    const content = partsToText(units.map((u) => textPart(u)));

    const calls: string[][] = [];
    const token = _saveAndClearProvider();
    try {
      _restoreProvider({
        provider: {
          maxBatchSize: 8,
          async embed(texts: string[]) {
            calls.push([...texts]);
            return texts.map((_t, i) => v(1, i, 0, 0));
          },
        },
      });
      embedTemporalMessage("m1", content);
      for (let i = 0; i < 200; i++) {
        if (
          (
            db()
              .query(
                "SELECT COUNT(*) n FROM temporal_vec WHERE message_id = 'm1'",
              )
              .get() as { n: number }
          ).n >= 9
        ) {
          break;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    } finally {
      _restoreProvider(token);
    }

    // The embed was split across multiple worker requests...
    expect(calls.length).toBeGreaterThan(1);
    // ...yet every unit was embedded exactly once, in order, and stored.
    expect(calls.flat()).toEqual(units);
    expect(chunkIds("m1").length).toBe(9);
  });

  test("embedTemporalMessage (vec0) caps chunk fan-out, folding the overflow tail into the final chunk", async () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporal("m1", "sX", 1000);
    const cap = MAX_TEMPORAL_CHUNKS_PER_MESSAGE;
    // One more unit than the cap allows → exactly `cap` chunks, with the last
    // two units merged into the final chunk (nothing dropped from the vector).
    const units = Array.from(
      { length: cap + 1 },
      (_, i) => `unit-${i}-distinct-payload`,
    );
    const content = partsToText(units.map((u) => textPart(u)));

    const calls: string[][] = [];
    const token = _saveAndClearProvider();
    try {
      _restoreProvider({
        provider: {
          maxBatchSize: 8,
          async embed(texts: string[]) {
            calls.push([...texts]);
            return texts.map((_t, i) => v(1, i, 0, 0));
          },
        },
      });
      embedTemporalMessage("m1", content);
      for (let i = 0; i < 400; i++) {
        if (
          (
            db()
              .query(
                "SELECT COUNT(*) n FROM temporal_vec WHERE message_id = 'm1'",
              )
              .get() as { n: number }
          ).n >= cap
        ) {
          break;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    } finally {
      _restoreProvider(token);
    }

    const flat = calls.flat();
    // Fan-out is bounded at the cap, not cap+1.
    expect(flat.length).toBe(cap);
    expect(chunkIds("m1").length).toBe(cap);
    // The final chunk's text merges the two overflow units — neither is dropped.
    const last = flat[flat.length - 1];
    expect(last).toContain(`unit-${cap - 1}-`);
    expect(last).toContain(`unit-${cap}-`);
  });
});

describeVec("temporal re-chunk backfill (backfillTemporalEmbeddings)", () => {
  const DONE_KEY = "lore:temporal_rechunk.done";
  const CURSOR_KEY = "lore:temporal_rechunk.cursor";
  const ATTEMPTS_KEY = "lore:temporal_rechunk.attempts";
  const CONFIG_KEY = "lore:embedding_config";

  // kv_meta persists across cases within a file; resetToBlob() only clears the
  // storage-mode/dimension keys, so clear the walk's flags (+ the embedding
  // config fingerprint) here so each case starts un-armed.
  beforeEach(() => {
    db()
      .query("DELETE FROM kv_meta WHERE key IN (?, ?, ?, ?)")
      .run(DONE_KEY, CURSOR_KEY, ATTEMPTS_KEY, CONFIG_KEY);
  });

  // A 3-unit message (prose + reasoning + reduced tool envelope), well over the
  // 50-char embed threshold; the tool BODY never reaches the embedder.
  const MULTI = partsToText([
    textPart("Investigating the parser regression in detail."),
    reasoningPart("Likely the tokenizer boundary."),
    toolPart("read", `src/parse.ts\n${"BODY ".repeat(200)}`),
  ]);
  const MULTI_UNITS = [
    "Investigating the parser regression in detail.",
    "[reasoning] Likely the tokenizer boundary.",
    "[tool:read] src/parse.ts",
  ];

  // A single-unit message (one prose part, no reasoning/tool parts) comfortably
  // over the 50-char embed floor, so each row triggers exactly ONE embed call —
  // the per-embed cursor snapshots then line up one-to-one with rows.
  const LONG = partsToText([
    textPart(
      "A single prose unit comfortably over the fifty character embed floor.",
    ),
  ]);

  function insTemporalContent(
    id: string,
    content: string,
    distilled = 0,
  ): void {
    db()
      .query(
        "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at) VALUES (?, ?, 'sX', 'user', ?, 0, ?, 0)",
      )
      .run(id, pid, content, distilled);
  }

  // Run `body` with a deterministic mock provider; `calls` records each worker
  // request so the tests can assert what was (and wasn't) embedded. `shouldThrow`
  // lets a case simulate a transient remote failure (a plain Error, NOT
  // LocalProviderUnavailableError) on batches whose text matches.
  async function withProviderThrowing(
    shouldThrow: (texts: string[]) => boolean,
    body: (calls: string[][]) => Promise<void>,
  ): Promise<void> {
    const calls: string[][] = [];
    const token = _saveAndClearProvider();
    try {
      _restoreProvider({
        provider: {
          maxBatchSize: 8,
          async embed(texts: string[]) {
            calls.push([...texts]);
            if (shouldThrow(texts)) throw new Error("simulated remote 429");
            return texts.map((_t, i) => v(1, i, 0, 0));
          },
        },
      });
      await body(calls);
    } finally {
      _restoreProvider(token);
    }
  }

  function withProvider(
    body: (calls: string[][]) => Promise<void>,
  ): Promise<void> {
    return withProviderThrowing(() => false, body);
  }

  // A single-unit message whose text carries a POISON marker the throwing
  // provider keys on.
  const POISON = partsToText([
    textPart("This message triggers a simulated remote failure POISON."),
  ]);
  const isPoison = (texts: string[]) => texts.some((t) => t.includes("POISON"));

  test("re-chunks legacy single-vector messages (incl. distilled) into the multi-vector set, then latches done", async () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    // A DISTILLED row — it keeps its embedding and stays in the search path, so
    // the walk must re-chunk it too (this is the whole point of "full corpus").
    insTemporalContent("m1", MULTI, /* distilled */ 1);
    storeTemporalChunks(db(), "m1", [v(1, 0, 0, 0)]); // legacy: a single #0 chunk
    expect(chunkIds("m1")).toEqual(["m1#0"]);

    await withProvider(async (calls) => {
      expect(await backfillTemporalEmbeddings()).toBe(1);
      // The three part-aware units were embedded; the tool BODY was dropped.
      expect(calls.flat()).toEqual(MULTI_UNITS);
      expect(calls.flat().join("\n")).not.toContain("BODY");
    });

    // The single legacy chunk was replaced by the complete multi-vector set.
    expect(chunkIds("m1")).toEqual(["m1#0", "m1#1", "m1#2"]);
    // Walk reached the end → latched done, cursor at the last id.
    expect(getKV(DONE_KEY)).toBe("1");
    expect(getKV(CURSOR_KEY)).toBe("m1");
  });

  test("is a no-op in blob mode and does NOT latch done (a later cutover must still run it)", async () => {
    // resetToBlob() left us in blob layout (no temporal_vec table at all).
    insTemporalContent("m1", MULTI);
    await withProvider(async (calls) => {
      expect(await backfillTemporalEmbeddings()).toBe(0);
      expect(calls).toEqual([]); // provider never touched
    });
    expect(getKV(DONE_KEY)).toBeNull(); // NOT latched
  });

  test("does nothing once done is latched (one-shot)", async () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporalContent("m1", MULTI);
    setKV(DONE_KEY, "1");
    await withProvider(async (calls) => {
      expect(await backfillTemporalEmbeddings()).toBe(0);
      expect(calls).toEqual([]);
    });
    expect(chunkIds("m1")).toEqual([]); // nothing embedded
  });

  test("resumes from the persisted cursor — rows at or below it are skipped", async () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporalContent("m1", MULTI);
    insTemporalContent("m2", MULTI);
    insTemporalContent("m3", MULTI);
    setKV(CURSOR_KEY, "m2"); // resume strictly after m2

    await withProvider(async () => {
      expect(await backfillTemporalEmbeddings()).toBe(1); // only m3
    });

    expect(chunkIds("m1")).toEqual([]); // below the cursor — untouched
    expect(chunkIds("m2")).toEqual([]); // == cursor — excluded (id > cursor)
    expect(chunkIds("m3").length).toBe(3); // re-chunked
    expect(getKV(CURSOR_KEY)).toBe("m3");
    expect(getKV(DONE_KEY)).toBe("1");
  });

  test("skips messages below the 50-char embed threshold", async () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporalContent("a_short", "too short"); // < 50 chars — skipped
    insTemporalContent("b_long", MULTI);

    await withProvider(async () => {
      expect(await backfillTemporalEmbeddings()).toBe(1);
    });

    expect(chunkIds("a_short")).toEqual([]);
    expect(chunkIds("b_long").length).toBe(3);
  });

  test("resetTemporalRechunkProgress re-arms the walk after it has converged", async () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporalContent("m1", MULTI);

    await withProvider(async () => {
      expect(await backfillTemporalEmbeddings()).toBe(1);
    });
    expect(getKV(DONE_KEY)).toBe("1");

    // Already done → a second walk is a no-op.
    await withProvider(async (calls) => {
      expect(await backfillTemporalEmbeddings()).toBe(0);
      expect(calls).toEqual([]);
    });

    // Re-arm (as checkConfigChange does after clearing vectors).
    resetTemporalRechunkProgress();
    expect(getKV(DONE_KEY)).toBe("0");
    expect(getKV(CURSOR_KEY)).toBe("");

    // Now it walks the corpus again.
    await withProvider(async () => {
      expect(await backfillTemporalEmbeddings()).toBe(1);
    });
    expect(chunkIds("m1").length).toBe(3);
  });

  test("checkConfigChange re-arms the temporal walk after a detected config change", () => {
    setStorageMode(db(), "vec0");
    // Build the vec0 store at the REAL config dimension so checkConfigChange's
    // ensureVec0Store(configDim) is a no-op (no DROP/recreate) — the wiring
    // assertion is then independent of the model's embedding dimension.
    ensureVec0Store(db(), config().search.embeddings.dimensions);
    setKV(DONE_KEY, "1"); // pretend a prior session converged
    setKV(CONFIG_KEY, "stale-fingerprint"); // force a detected change

    expect(checkConfigChange()).toBe(true);

    // The clear wiped temporal vectors, so the walk is re-armed to refill them.
    expect(getKV(DONE_KEY)).toBe("0");
    expect(getKV(CURSOR_KEY)).toBe("");
  });

  test("counts only messages that actually got chunks — a no-unit row advances but isn't counted", async () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    // A >=50-char row that reduces to zero embeddable units (all whitespace →
    // the lone text unit trims empty and is filtered). store() never persists
    // such a row, but the walk reads rows directly, so it must advance the
    // cursor + latch done WITHOUT being counted or writing a chunk.
    insTemporalContent("m1", " ".repeat(60));
    insTemporalContent("m2", MULTI);

    await withProvider(async (calls) => {
      expect(await backfillTemporalEmbeddings()).toBe(1); // only m2 counted
      expect(calls.flat()).toEqual(MULTI_UNITS); // embedder never saw the empty row
    });

    expect(chunkIds("m1")).toEqual([]); // no chunk written for the empty row
    expect(chunkIds("m2").length).toBe(3);
    expect(getKV(DONE_KEY)).toBe("1"); // walk still reached the end
    expect(getKV(CURSOR_KEY)).toBe("m2"); // and advanced past the empty row
  });

  test("a transient row error skips forward but does NOT latch done — the next startup retries it", async () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporalContent("m1", POISON); // fails on this pass (simulated 429)
    insTemporalContent("m2", MULTI); // succeeds

    // Pass 1: m1 throws a plain Error, the walk skips forward to embed m2, but
    // rewinds the cursor to retry m1 instead of latching done over the gap.
    await withProviderThrowing(isPoison, async () => {
      expect(await backfillTemporalEmbeddings()).toBe(1); // only m2 succeeded
    });
    expect(chunkIds("m1")).toEqual([]); // errored — left on its legacy vector
    expect(chunkIds("m2").length).toBe(3); // re-chunked
    expect(getKV(DONE_KEY)).toBeNull(); // NOT latched — there was a gap
    expect(getKV(ATTEMPTS_KEY)).toBe("1");
    expect(getKV(CURSOR_KEY)).toBe(""); // rewound to before the first failure

    // Pass 2: the transient error is gone; the walk resumes from the rewind,
    // re-chunks m1, and now latches done.
    await withProvider(async () => {
      expect(await backfillTemporalEmbeddings()).toBe(2); // m1 + m2 (idempotent)
    });
    expect(chunkIds("m1")).toEqual(["m1#0"]); // POISON is one unit → one chunk
    expect(getKV(DONE_KEY)).toBe("1");
    expect(getKV(ATTEMPTS_KEY)).toBe("0");
  });

  test("a permanently un-embeddable row is given up on after the bounded passes", async () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporalContent("m1", POISON); // always fails

    // Each pass rewinds and retries; after MAX_TEMPORAL_RECHUNK_RETRY_PASSES the
    // walk gives up and latches done (m1 stays on its legacy single vector).
    await withProviderThrowing(isPoison, async () => {
      expect(await backfillTemporalEmbeddings()).toBe(0);
      expect(getKV(DONE_KEY)).toBeNull();
      expect(getKV(ATTEMPTS_KEY)).toBe("1");

      expect(await backfillTemporalEmbeddings()).toBe(0);
      expect(getKV(DONE_KEY)).toBeNull();
      expect(getKV(ATTEMPTS_KEY)).toBe("2");

      // Third pass hits the cap → give up, latch done, clear the counter.
      expect(await backfillTemporalEmbeddings()).toBe(0);
      expect(getKV(DONE_KEY)).toBe("1");
      expect(getKV(ATTEMPTS_KEY)).toBe("0");
    });
    expect(chunkIds("m1")).toEqual([]);

    // Done is latched, so further startups are a no-op even while still failing.
    await withProviderThrowing(isPoison, async (calls) => {
      expect(await backfillTemporalEmbeddings()).toBe(0);
      expect(calls).toEqual([]);
    });
  });

  test("checkpoints the cursor after each row, not once per page (mid-page progress is durable)", async () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    // Three single-unit rows land in one page (< TEMPORAL_RECHUNK_PAGE). Each
    // embed call snapshots the persisted cursor: with per-row checkpointing,
    // row K sees row K-1's id already durable; with per-page checkpointing all
    // three snapshots would still be null (nothing is persisted until the page
    // ends), so a restart mid-page would redo the whole page and — on a machine
    // that restarts more often than a page takes — never converge.
    insTemporalContent("r1", LONG);
    insTemporalContent("r2", LONG);
    insTemporalContent("r3", LONG);

    const seen: (string | null)[] = [];
    const token = _saveAndClearProvider();
    try {
      _restoreProvider({
        provider: {
          maxBatchSize: 8,
          async embed(texts: string[]) {
            seen.push(getKV(CURSOR_KEY));
            return texts.map((_t, i) => v(1, i, 0, 0));
          },
        },
      });
      expect(await backfillTemporalEmbeddings()).toBe(3);
    } finally {
      _restoreProvider(token);
    }

    // By the time row K is embedded, row K-1's id is already durable.
    expect(seen).toEqual([null, "r1", "r2"]);
    expect(getKV(CURSOR_KEY)).toBe("r3");
    expect(getKV(DONE_KEY)).toBe("1");
  });

  test("mid-page checkpoint pins at the retry point after a transient failure (crash-safe gap)", async () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporalContent("p1", POISON); // transient-fails this pass
    insTemporalContent("p2", LONG); // succeeds after the failure
    insTemporalContent("p3", LONG); // succeeds

    // Snapshot the persisted cursor at each embed. Once p1 fails, retryFrom is
    // pinned at its predecessor (""), and EVERY subsequent per-row checkpoint
    // must persist that retry point — not the advancing cursor — so a crash
    // before the pass ends still resumes at the gap (p1) rather than skipping
    // it. If the checkpoint wrote the bare `cursor`, p2/p3 would observe "p1"/
    // "p2" and a crash would latch done over the un-retried gap.
    const seen: (string | null)[] = [];
    const token = _saveAndClearProvider();
    try {
      _restoreProvider({
        provider: {
          maxBatchSize: 8,
          async embed(texts: string[]) {
            seen.push(getKV(CURSOR_KEY));
            if (texts.some((t) => t.includes("POISON"))) {
              throw new Error("simulated remote 429");
            }
            return texts.map((_t, i) => v(1, i, 0, 0));
          },
        },
      });
      await backfillTemporalEmbeddings();
    } finally {
      _restoreProvider(token);
    }

    expect(seen).toEqual([null, "", ""]);
    // End-of-pass rewind leaves the durable cursor at the gap, un-latched.
    expect(getKV(CURSOR_KEY)).toBe("");
    expect(getKV(DONE_KEY)).toBeNull();
  });

  test("a mid-page provider outage stops at the last completed row without latching done", async () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporalContent("r1", LONG);
    insTemporalContent("r2", LONG); // provider goes away on this row
    insTemporalContent("r3", LONG);

    // The per-row checkpoint moved WHERE the outage stop persists its cursor, so
    // guard it directly: the break must fire before the row's cursor advance and
    // before its checkpoint, leaving the durable cursor at the last COMPLETED row
    // (r1) so the next startup resumes and retries the outage row — never latches
    // done over the gap.
    let call = 0;
    const token = _saveAndClearProvider();
    try {
      _restoreProvider({
        provider: {
          maxBatchSize: 8,
          async embed(texts: string[]) {
            call++;
            if (call === 2) throw new LocalProviderUnavailableError();
            return texts.map((_t, i) => v(1, i, 0, 0));
          },
        },
      });
      expect(await backfillTemporalEmbeddings()).toBe(1); // only r1 completed
    } finally {
      _restoreProvider(token);
    }

    expect(getKV(CURSOR_KEY)).toBe("r1"); // not advanced past the outage row
    expect(getKV(DONE_KEY)).toBeNull(); // walk didn't reach the end
    expect(chunkIds("r1").length).toBe(1); // completed before the outage
    expect(chunkIds("r2")).toEqual([]); // outage row — untouched
    expect(chunkIds("r3")).toEqual([]); // never reached
  });

  test("idle-gate: parks before each row's embed and resumes when it clears", async () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporalContent("r1", LONG);

    // shouldPause is consulted BEFORE the embed and re-polled until it clears.
    // Busy on the first check, idle after → the row parks once, then embeds.
    const events: string[] = [];
    let checks = 0;
    const shouldPause = () => {
      const paused = checks === 0;
      checks++;
      events.push(paused ? "pause" : "go");
      return paused;
    };
    const token = _saveAndClearProvider();
    try {
      _restoreProvider({
        provider: {
          maxBatchSize: 8,
          async embed(texts: string[]) {
            events.push("embed");
            return texts.map((_t, i) => v(1, i, 0, 0));
          },
        },
      });
      expect(await backfillTemporalEmbeddings({ shouldPause })).toBe(1);
    } finally {
      _restoreProvider(token);
    }

    // Gate checked → park → gate checked → clear → embed. Without gating the
    // sequence would be just ["embed"].
    expect(events).toEqual(["pause", "go", "embed"]);
  });

  test("idle-gate: a throwing shouldPause never bricks the walk", async () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporalContent("r1", LONG);

    // A buggy host predicate must be treated as "not paused" so the walk still
    // converges (rather than rejecting out of the fire-and-forget backfill).
    const shouldPause = () => {
      throw new Error("host predicate blew up");
    };
    await withProvider(async () => {
      expect(await backfillTemporalEmbeddings({ shouldPause })).toBe(1);
    });
    expect(chunkIds("r1").length).toBe(1);
    expect(getKV(DONE_KEY)).toBe("1");
  });

  test("logs the up-front backlog so a long walk is visible in the logs", async () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporalContent("m1", MULTI);
    insTemporalContent("m2", MULTI);
    insTemporalContent("short", "tiny"); // < 50 chars — excluded from the count

    const info = vi.spyOn(log, "info");
    try {
      await withProvider(async () => {
        expect(await backfillTemporalEmbeddings()).toBe(2);
      });
      const lines = info.mock.calls.map((c: unknown[]) =>
        c.map(String).join(" "),
      );
      // Startup line surfaces the backlog AND the cumulative baseline (fresh run
      // ⇒ 0/2 done). `short` (<50 chars) is excluded from both counts.
      expect(
        lines.some((l) =>
          /temporal re-chunk: 2 messages to scan \(0\/2 already done, 0%\)/.test(
            l,
          ),
        ),
      ).toBe(true);
      // On a clean completion `baseDone + scanned === total`, so the final line
      // reads exactly 100% — the cumulative metric, not a per-process tally.
      expect(
        lines.some((l) =>
          /temporal re-chunk: 100% complete \(2\/2 messages\)/.test(l),
        ),
      ).toBe(true);
    } finally {
      info.mockRestore();
    }
  });

  test("cumulative progress counts prior runs (resuming), not just this process", async () => {
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);
    insTemporalContent("m1", MULTI);
    insTemporalContent("m2", MULTI);
    insTemporalContent("m3", MULTI);
    insTemporalContent("m4", MULTI);
    setKV(CURSOR_KEY, "m2"); // pretend m1,m2 were re-chunked in a prior run

    const info = vi.spyOn(log, "info");
    try {
      await withProvider(async () => {
        expect(await backfillTemporalEmbeddings()).toBe(2); // only m3,m4 this run
      });
      const lines = info.mock.calls.map((c: unknown[]) =>
        c.map(String).join(" "),
      );
      // startup: 2 remain, but 2 of 4 are already done (50%) — resuming
      expect(
        lines.some((l) =>
          /temporal re-chunk: 2 messages to scan \(2\/4 already done, 50%\), resuming/.test(
            l,
          ),
        ),
      ).toBe(true);
      // completion: cumulative 4/4 (100%), NOT the per-process 2/4 — this is what
      // distinguishes `baseDone + scanned` from `processed`.
      expect(
        lines.some((l) =>
          /temporal re-chunk: 100% complete \(4\/4 messages\) · \+2 re-chunked this run/.test(
            l,
          ),
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
