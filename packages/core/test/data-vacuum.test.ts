import { afterEach, describe, expect, test } from "vitest";
import {
  checkpointWal,
  db,
  dbFileSizeBytes,
  ensureProject,
  freelistBytes,
  vacuum,
} from "../src/db";
import { isVecAvailable } from "../src/db/vec";
import {
  ensureVec0Store,
  resetVecStorageModeLatch,
  setStorageMode,
  storeTemporalChunks,
} from "../src/db/vec-store";

const PROJECT = "/test/data-vacuum";
const DIM = 4;

function v(...xs: number[]): Float32Array {
  const a = new Float32Array(DIM);
  let n = 0;
  for (let i = 0; i < DIM; i++) {
    a[i] = xs[i] ?? 0;
    n += a[i] * a[i];
  }
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) a[i] /= n;
  return a;
}

/** Reset vec0 state after each test so the next test starts from blob mode. */
afterEach(() => {
  for (const vt of [
    "knowledge_vec",
    "entity_vec",
    "distillation_vec",
    "temporal_vec",
  ]) {
    db().query(`DROP TABLE IF EXISTS ${vt}`).run();
  }
  for (const t of [
    "knowledge",
    "entities",
    "distillations",
    "temporal_messages",
  ]) {
    const cols = db().query(`PRAGMA table_info(${t})`).all() as Array<{
      name: string;
    }>;
    if (!cols.some((c) => c.name === "embedding")) {
      db().query(`ALTER TABLE ${t} ADD COLUMN embedding BLOB`).run();
    }
  }
  db()
    .query(
      "DELETE FROM kv_meta WHERE key IN ('vec.storage_mode', 'vec.dimension')",
    )
    .run();
  for (const t of [
    "knowledge",
    "entities",
    "distillations",
    "temporal_messages",
  ]) {
    db().query(`DELETE FROM ${t}`).run();
  }
  resetVecStorageModeLatch();
});

describe("VACUUM / free-page reclaim (#1221)", () => {
  test("vacuum() clears the freelist and shrinks the file", () => {
    db().exec(
      "CREATE TABLE IF NOT EXISTS vac_probe (id INTEGER PRIMARY KEY, b TEXT)",
    );
    for (let i = 0; i < 1000; i++)
      db().query("INSERT INTO vac_probe (b) VALUES (?)").run("x".repeat(2000));
    checkpointWal(); // flush inserts into the main file so it actually grows
    const grown = dbFileSizeBytes();

    db().exec("DELETE FROM vac_probe");
    checkpointWal(); // flush the deletes → freed pages land on the freelist
    // auto_vacuum=INCREMENTAL keeps freed pages on the freelist until reclaimed.
    expect(freelistBytes()).toBeGreaterThan(0);

    const r = vacuum();
    // VACUUM removes ALL free pages and returns the space to the OS.
    expect(freelistBytes()).toBe(0);
    expect(r.afterBytes).toBeLessThan(r.beforeBytes);
    expect(dbFileSizeBytes()).toBeLessThan(grown);
  });

  test("vacuum() runs vec0Rebuild for temporal_vec and reports stats", () => {
    if (!isVecAvailable()) return; // skip on vec-less CI lanes

    const pid = ensureProject(PROJECT);
    setStorageMode(db(), "vec0");
    ensureVec0Store(db(), DIM);

    // Insert 3 temporal messages with multi-vector chunks.
    const insTemporal = (id: string, sess: string, chunks: number) => {
      db()
        .query(
          "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at) VALUES (?, ?, ?, 'user', ?, 0, 0, ?)",
        )
        .run(id, pid, sess, `m-${id}`, Date.now());
      const vecs = Array.from({ length: chunks }, (_, i) =>
        v(1, 0, 0, i * 0.001),
      );
      storeTemporalChunks(db(), id, vecs);
    };
    insTemporal("m1", "s1", 4);
    insTemporal("m2", "s2", 4);
    insTemporal("m3", "s3", 4);

    const beforeChunks = (
      db().query("SELECT COUNT(*) AS n FROM temporal_vec_chunks").get() as {
        n: number;
      }
    ).n;
    expect(beforeChunks).toBeGreaterThanOrEqual(3);

    const r = vacuum();

    // vec0Rebuild stats should be present and show the rebuild ran.
    expect(r.vec0Rebuild).toBeDefined();
    expect(r.vec0Rebuild!.rowsRebuilt).toBe(12);
    expect(r.vec0Rebuild!.beforeChunks).toBe(beforeChunks);
    expect(r.vec0Rebuild!.afterChunks).toBeLessThanOrEqual(beforeChunks);

    // Every chunk row still present after the rebuild.
    const after = db()
      .query("SELECT chunk_id, message_id FROM temporal_vec ORDER BY chunk_id")
      .all() as Array<{ chunk_id: string; message_id: string }>;
    expect(after.length).toBe(12);
  });
});
