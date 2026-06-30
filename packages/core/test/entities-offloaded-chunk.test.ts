import { EventEmitter } from "node:events";
import { uuidv7 } from "uuidv7";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, ensureProject } from "../src/db";
import { getManyWithAliasesOffloaded } from "../src/entities";
import { runReadJob } from "../src/read-job";
import {
  _resetVectorPoolForTest,
  _setTestVectorWorkerFactory,
} from "../src/vector-pool";
import type {
  VectorWorkerInbound,
  VectorWorkerInitData,
} from "../src/vector-worker-types";

// #1022: the offloaded alias-batch helpers (batchLoadAliasesOffloaded /
// getManyWithAliasesOffloaded) built a single unbounded `IN (...)` over every
// id, unlike their sync siblings which chunk at 900. SQLite's bound-variable
// ceiling is 32766, so the bug is latent at small sizes — these tests assert the
// chunking *behaviour* (no read job ever binds more than 900 params), which is
// what the unbounded mutation violates. A recording read-worker captures every
// dispatched read job's bind-param count and executes it against the real DB so
// correctness is checked in the same pass.

const CHUNK = 900;

/** Read-worker fake: records every dispatched read spec, then answers it by
 *  running the job against the live in-process DB. */
class RecordingReadWorker extends EventEmitter {
  static specs: Array<{ sql: string; params: unknown[] }> = [];
  unref(): void {}
  postMessage(msg: VectorWorkerInbound): void {
    if (msg.type === "read") {
      RecordingReadWorker.specs.push({
        sql: msg.spec.sql,
        params: msg.spec.params,
      });
      const rows = runReadJob(db(), msg.spec);
      this.emit("message", { type: "read-result", id: msg.id, rows });
    }
  }
  terminate(): Promise<number> {
    this.emit("exit", 0);
    return Promise.resolve(0);
  }
}

function installRecordingFactory(): void {
  _setTestVectorWorkerFactory(
    (() => new RecordingReadWorker()) as unknown as (
      d: VectorWorkerInitData,
    ) => never,
  );
}

const PROJECT = "/test/entities-offloaded-chunk";

beforeEach(() => {
  RecordingReadWorker.specs = [];
  _resetVectorPoolForTest();
  installRecordingFactory();
  const pid = ensureProject(PROJECT);
  db().query("DELETE FROM entities WHERE project_id = ?").run(pid);
});

afterEach(() => {
  _setTestVectorWorkerFactory(null);
  _resetVectorPoolForTest();
});

/** Insert `n` entities (every other one carrying a single alias) in one
 *  transaction. Returns the ordered list of inserted ids. */
function seedEntities(n: number): string[] {
  const pid = ensureProject(PROJECT);
  const ids: string[] = [];
  const now = Date.now();
  const database = db();
  database.query("BEGIN").run();
  try {
    for (let i = 0; i < n; i++) {
      const id = uuidv7();
      ids.push(id);
      database
        .query(
          "INSERT INTO entities (id, project_id, entity_type, canonical_name, metadata, cross_project, created_at, updated_at) VALUES (?, ?, 'tool', ?, '{}', 0, ?, ?)",
        )
        .run(id, pid, `Entity ${i}`, now, now);
      if (i % 2 === 0) {
        database
          .query(
            "INSERT INTO entity_aliases (id, entity_id, alias_type, alias_value, source, created_at) VALUES (?, ?, 'name', ?, 'test', ?)",
          )
          .run(uuidv7(), id, `alias-${id}`, now);
      }
    }
    database.query("COMMIT").run();
  } catch (e) {
    database.query("ROLLBACK").run();
    throw e;
  }
  return ids;
}

describe("getManyWithAliasesOffloaded chunks unbounded IN (#1022)", () => {
  it("hydrates every entity + alias across the 900 boundary with no oversized bind list", async () => {
    // 1801 ids → ceil(1801/900) = 3 chunks for the entities scan AND 3 for the
    // alias scan (every id has a live row, so the alias load sees all 1801).
    const ids = seedEntities(1801);

    const map = await getManyWithAliasesOffloaded(ids);

    // Correctness: all rows hydrated; aliases attached to the even-index entities.
    expect(map.size).toBe(1801);
    let withAlias = 0;
    for (const id of ids) {
      const ent = map.get(id);
      expect(ent).toBeDefined();
      if (ent && ent.aliases.length > 0) {
        withAlias++;
        expect(ent.aliases[0].alias_value).toBe(`alias-${id}`);
      }
    }
    expect(withAlias).toBe(Math.ceil(1801 / 2)); // 901 even-index entities

    // Chunking invariant: NO dispatched read job may bind more than CHUNK
    // params. The unbounded mutation binds all 1801 at once → this fails.
    expect(RecordingReadWorker.specs.length).toBeGreaterThan(0);
    for (const spec of RecordingReadWorker.specs) {
      expect(spec.params.length).toBeLessThanOrEqual(CHUNK);
    }

    // Both scans must actually have split into multiple chunks.
    const entityScans = RecordingReadWorker.specs.filter((s) =>
      /FROM entities WHERE id IN/.test(s.sql),
    );
    const aliasScans = RecordingReadWorker.specs.filter((s) =>
      /FROM entity_aliases WHERE entity_id IN/.test(s.sql),
    );
    expect(entityScans.length).toBe(Math.ceil(1801 / CHUNK)); // 3
    expect(aliasScans.length).toBe(Math.ceil(1801 / CHUNK)); // 3

    // Chunks must partition the id set: union of entity-scan params === all ids.
    const scanned = new Set(entityScans.flatMap((s) => s.params as string[]));
    expect(scanned.size).toBe(1801);
    for (const id of ids) expect(scanned.has(id)).toBe(true);
  });

  it("returns an empty map without dispatching any read for no ids", async () => {
    const map = await getManyWithAliasesOffloaded([]);
    expect(map.size).toBe(0);
    expect(RecordingReadWorker.specs.length).toBe(0);
  });
});
