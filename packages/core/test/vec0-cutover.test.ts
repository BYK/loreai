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
} from "../src/db/vec-store";
import { maybeCutoverToVec0 } from "../src/embedding";
import * as ltm from "../src/ltm";
import {
  fromBlob,
  runVectorQuery,
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
