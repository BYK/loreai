import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { close, db, ensureProject, getKV, setKV } from "../src/db";
import {
  type EmbeddingTable,
  type VecReadMode,
  type VecStorageMode,
  VEC_STORAGE_MODE_KEY,
  clearAllEmbeddings,
  readStorageMode,
  resetVecStorageModeLatch,
  resolveReadMode,
  storeEmbedding,
} from "../src/db/vec-store";
import { fromBlob } from "../src/vector-query";
import { runVectorQuery, type VectorQuerySpec } from "../src/vector-query";

const PROJECT = "/test/vec-store";

// ---------------------------------------------------------------------------
// resolveReadMode — the full (storage mode × vec availability) matrix
// ---------------------------------------------------------------------------

describe("resolveReadMode", () => {
  const cases: Array<[VecStorageMode, boolean, VecReadMode]> = [
    ["blob", true, "blob-native"],
    ["blob", false, "blob-js"],
    ["vec0", true, "vec0"],
    ["vec0", false, "degraded"],
  ];
  for (const [mode, vecAvailable, expected] of cases) {
    test(`${mode} × vecAvailable=${vecAvailable} → ${expected}`, () => {
      expect(resolveReadMode(mode, vecAvailable)).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// readStorageMode — defaults to the safe "blob" layout
// ---------------------------------------------------------------------------

describe("readStorageMode", () => {
  beforeEach(() => {
    ensureProject(PROJECT);
    // Clear any prior mode so each case starts from the default.
    db().query("DELETE FROM kv_meta WHERE key = ?").run(VEC_STORAGE_MODE_KEY);
    // Clear the sticky vec0 latch so a prior case's vec0 observation does not
    // bleed into a case that expects the default blob layout.
    resetVecStorageModeLatch();
  });

  afterAll(() => {
    db().query("DELETE FROM kv_meta WHERE key = ?").run(VEC_STORAGE_MODE_KEY);
    resetVecStorageModeLatch();
    close();
  });

  test("defaults to 'blob' when the key is absent", () => {
    expect(getKV(VEC_STORAGE_MODE_KEY)).toBeNull();
    expect(readStorageMode(db())).toBe("blob");
  });

  test("returns 'vec0' when the stored value is exactly 'vec0'", () => {
    setKV(VEC_STORAGE_MODE_KEY, "vec0");
    expect(readStorageMode(db())).toBe("vec0");
  });

  test("falls back to 'blob' for any unrecognized stored value", () => {
    setKV(VEC_STORAGE_MODE_KEY, "garbage");
    expect(readStorageMode(db())).toBe("blob");
  });

  test("falls back to 'blob' when the read throws (e.g. missing table)", () => {
    const throwingConn = {
      query() {
        throw new Error("no such table: kv_meta");
      },
    };
    expect(readStorageMode(throwingConn)).toBe("blob");
  });

  test("STICKY: once vec0 is observed, a later throwing read still returns 'vec0' (cutover race)", () => {
    // Regression for the vec0 cutover TOCTOU: the cutover flips the mode to
    // vec0 THEN drops the base `embedding` columns. If a subsequent kv_meta
    // read throws (SQLITE_BUSY during the cutover checkpoint, or a concurrent
    // curation pass) and we fell back to "blob", a query would hit the
    // now-dropped `embedding` column and throw `no such column: embedding`.
    // The latch pins vec0 once observed.
    setKV(VEC_STORAGE_MODE_KEY, "vec0");
    expect(readStorageMode(db())).toBe("vec0"); // observes + latches
    const throwingConn = {
      query() {
        throw new Error("database is locked");
      },
    };
    // Without the latch this would fall back to "blob"; with it, stays "vec0".
    expect(readStorageMode(throwingConn)).toBe("vec0");
  });

  test("STICKY latch resets after resetVecStorageModeLatch (fresh blob DB not poisoned)", () => {
    setKV(VEC_STORAGE_MODE_KEY, "vec0");
    expect(readStorageMode(db())).toBe("vec0"); // latch armed
    resetVecStorageModeLatch();
    db().query("DELETE FROM kv_meta WHERE key = ?").run(VEC_STORAGE_MODE_KEY);
    // Latch cleared + key absent → a fresh (blob) DB reads blob again.
    expect(readStorageMode(db())).toBe("blob");
  });
});

// ---------------------------------------------------------------------------
// runVectorQuery — "degraded" short-circuits before touching the connection
// ---------------------------------------------------------------------------

describe("runVectorQuery degraded read mode", () => {
  const specs: VectorQuerySpec[] = [
    { kind: "knowledge", limit: 5 },
    { kind: "entities", limit: 5 },
    { kind: "distillations", limit: 5 },
    { kind: "allDistillations", projectId: "p", limit: 5 },
    { kind: "temporal", projectId: "p", limit: 5 },
  ];

  // A connection that explodes if touched — proves "degraded" short-circuits
  // before running any SQL (vec0 tables are unreadable without the extension).
  const explodingConn = {
    query(): { all(): unknown[] } {
      throw new Error("degraded must not query the connection");
    },
  };

  const query = new Float32Array([1, 0, 0]);

  for (const spec of specs) {
    test(`degraded → [] without querying (${spec.kind})`, () => {
      expect(runVectorQuery(explodingConn, "degraded", query, spec)).toEqual(
        [],
      );
    });
  }
});

// ---------------------------------------------------------------------------
// storeEmbedding — writes the Float32 BLOB onto the correct base table
// ---------------------------------------------------------------------------

describe("storeEmbedding (blob layout)", () => {
  let pid: string;

  beforeEach(() => {
    pid = ensureProject(PROJECT);
    // Defense-in-depth: these are blob-layout tests; clear any sticky vec0 latch
    // a prior describe may have armed so readStorageMode reads blob here.
    resetVecStorageModeLatch();
    db().query("DELETE FROM knowledge").run();
    db().query("DELETE FROM entities").run();
    db().query("DELETE FROM distillations").run();
    db().query("DELETE FROM temporal_messages").run();
  });

  afterAll(() => {
    close();
  });

  function vec(): Float32Array {
    return new Float32Array([0.1, 0.2, 0.3]);
  }

  function readBack(table: string, id: string): Buffer | null {
    const row = db()
      .query(`SELECT embedding FROM ${table} WHERE id = ?`)
      .get(id) as { embedding: Buffer | null } | null;
    return row?.embedding ?? null;
  }

  test("knowledge → updates the knowledge.embedding column", () => {
    const now = Date.now();
    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at, logical_id) VALUES (?, ?, 'test', '', '', ?, ?, ?)",
      )
      .run("k1", pid, now, now, "k1");
    expect(readBack("knowledge", "k1")).toBeNull();
    storeEmbedding(db(), "knowledge", "k1", vec());
    expect(Array.from(fromBlob(readBack("knowledge", "k1") as Buffer))).toEqual(
      Array.from(vec()),
    );
  });

  test("entities → updates the entities.embedding column", () => {
    const now = Date.now();
    db()
      .query(
        "INSERT INTO entities (id, project_id, entity_type, canonical_name, cross_project, created_at, updated_at) VALUES (?, ?, 'tool', 'E', 0, ?, ?)",
      )
      .run("e1", pid, now, now);
    storeEmbedding(db(), "entities", "e1", vec());
    expect(Array.from(fromBlob(readBack("entities", "e1") as Buffer))).toEqual(
      Array.from(vec()),
    );
  });

  test("distillations → updates the distillations.embedding column", () => {
    const now = Date.now();
    db()
      .query(
        "INSERT INTO distillations (id, project_id, session_id, narrative, facts, source_ids, generation, token_count, created_at, archived) VALUES (?, ?, 's', '', '', '', 0, 0, ?, 0)",
      )
      .run("d1", pid, now);
    storeEmbedding(db(), "distillations", "d1", vec());
    expect(
      Array.from(fromBlob(readBack("distillations", "d1") as Buffer)),
    ).toEqual(Array.from(vec()));
  });

  test("temporal → updates the temporal_messages.embedding column", () => {
    const now = Date.now();
    db()
      .query(
        "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at) VALUES (?, ?, 's', 'user', 'm', 0, 0, ?)",
      )
      .run("t1", pid, now);
    storeEmbedding(db(), "temporal", "t1", vec());
    expect(
      Array.from(fromBlob(readBack("temporal_messages", "t1") as Buffer)),
    ).toEqual(Array.from(vec()));
  });
});

// ---------------------------------------------------------------------------
// clearAllEmbeddings — NULLs every base table's embedding column
// ---------------------------------------------------------------------------

describe("clearAllEmbeddings (blob layout)", () => {
  beforeEach(() => {
    // Defense-in-depth: blob-layout test; clear any sticky vec0 latch a prior
    // describe may have armed so readStorageMode reads blob here.
    resetVecStorageModeLatch();
  });

  afterAll(() => {
    close();
  });

  test("NULLs embeddings across all four tables", () => {
    const pid = ensureProject(PROJECT);
    db().query("DELETE FROM knowledge").run();
    db().query("DELETE FROM entities").run();
    db().query("DELETE FROM distillations").run();
    db().query("DELETE FROM temporal_messages").run();
    const now = Date.now();
    const v = new Float32Array([1, 0, 0]);

    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at, logical_id) VALUES ('k', ?, 'test', '', '', ?, ?, 'k')",
      )
      .run(pid, now, now);
    db()
      .query(
        "INSERT INTO entities (id, project_id, entity_type, canonical_name, cross_project, created_at, updated_at) VALUES ('e', ?, 'tool', 'E', 0, ?, ?)",
      )
      .run(pid, now, now);
    db()
      .query(
        "INSERT INTO distillations (id, project_id, session_id, narrative, facts, source_ids, generation, token_count, created_at, archived) VALUES ('d', ?, 's', '', '', '', 0, 0, ?, 0)",
      )
      .run(pid, now);
    db()
      .query(
        "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at) VALUES ('t', ?, 's', 'user', 'm', 0, 0, ?)",
      )
      .run(pid, now);

    const tables: Array<[EmbeddingTable, string, string]> = [
      ["knowledge", "knowledge", "k"],
      ["entities", "entities", "e"],
      ["distillations", "distillations", "d"],
      ["temporal", "temporal_messages", "t"],
    ];
    for (const [logical, , id] of tables) {
      storeEmbedding(db(), logical, id, v);
    }
    for (const [, physical, id] of tables) {
      const row = db()
        .query(`SELECT embedding FROM ${physical} WHERE id = ?`)
        .get(id) as { embedding: Buffer | null };
      expect(row.embedding).not.toBeNull();
    }

    clearAllEmbeddings(db());

    for (const [, physical, id] of tables) {
      const row = db()
        .query(`SELECT embedding FROM ${physical} WHERE id = ?`)
        .get(id) as { embedding: Buffer | null };
      expect(row.embedding).toBeNull();
    }
  });
});
