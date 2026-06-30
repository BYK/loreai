// End-to-end tests for the FLAT-vec0 storage layout: write/read round-trip,
// the blob→vec0 cutover (backfill + DROP COLUMN + flip, idempotent/resumable),
// vec0↔blob exact parity, partition pushdown + recency-cap removal, dimension
// change, delete maintenance, and the dangling-row GC backstop.
//
// All run against the real vec0-capable test connection (the vendored sqlite-vec
// loads in the node test runtime). The suite is skipped if the extension is
// somehow unavailable so a vec-less CI lane stays green.
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { close, db, ensureProject } from "../src/db";
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
  setStorageMode,
  storeEmbedding,
  storeTemporalChunks,
} from "../src/db/vec-store";
import {
  _restoreProvider,
  _saveAndClearProvider,
  embedTemporalMessage,
  maybeCutoverToVec0,
} from "../src/embedding";
import * as ltm from "../src/ltm";
import { partsToText } from "../src/temporal";
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
        if (embeddingColumnExists(db(), table)) copyBlobsToVec0(db(), table);
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
    copyBlobsToVec0(db(), "knowledge");
    copyBlobsToVec0(db(), "knowledge"); // re-run (crash-resume)
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
});
