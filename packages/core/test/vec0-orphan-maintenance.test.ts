import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { close, db, dbPath, ensureProject } from "../src/db";
import { isVecAvailable } from "../src/db/vec";
import { ensureVec0Store, setStorageMode } from "../src/db/vec-store";
import { toBlob } from "../src/vector-query";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { withTenant } from "../src/tenant";
import * as log from "../src/log";
import * as pool from "../src/vector-pool";
import {
  startVec0OrphanMaintenance,
  VEC0_ORPHAN_PAGE_SIZE,
} from "../src/vec0-orphan-maintenance";

db();
const describeVec = isVecAvailable() ? describe : describe.skip;
let stop: (() => void) | undefined;
let pid: string;
let beforeReply: (() => void) | undefined;
const specs: string[] = [];
const blob = toBlob(new Float32Array([1, 0, 0, 0]));

beforeEach(() => {
  vi.useFakeTimers();
  pid = ensureProject("/test/orphan-maintenance");
  db().query("DELETE FROM temporal_messages WHERE project_id = ?").run(pid);
  for (const table of [
    "knowledge_vec",
    "entity_vec",
    "distillation_vec",
    "temporal_vec",
  ])
    db().exec(`DROP TABLE IF EXISTS ${table}`);
  ensureVec0Store(db(), 4);
  setStorageMode(db(), "vec0");
  specs.length = 0;
  beforeReply = undefined;
  // Execute the actual read SQL against the native extension. Separate tests
  // exercise the real worker seam; this seam controls races after its snapshot.
  vi.spyOn(pool, "tryPoolRead").mockImplementation(async (spec) => {
    specs.push(spec.sql);
    const rows = db()
      .query(spec.sql)
      .all(...spec.params);
    beforeReply?.();
    beforeReply = undefined;
    return { rows };
  });
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
  log.registerSink({ info() {}, warn() {}, error() {}, captureException() {} });
  pool._setTestVectorWorkerFactory(null);
  pool._resetVectorPoolForTest();
  close();
});

function temporal(id: string, source = id) {
  db()
    .query(
      "INSERT INTO temporal_vec (chunk_id, message_id, session_id, project_id, embedding) VALUES (?, ?, 's', ?, ?)",
    )
    .run(id, source, pid, blob);
}
function base(id: string) {
  db()
    .query(
      "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, created_at) VALUES (?, ?, 's', 'user', 'x', 1, 1)",
    )
    .run(id, pid);
}
function keys() {
  return db()
    .query("SELECT chunk_id FROM temporal_vec ORDER BY chunk_id")
    .all();
}

describeVec("idle vec0 orphan maintenance", () => {
  it("rolls back a partly deleted page and retries without advancing", async () => {
    temporal("first-orphan");
    temporal("second-orphan");
    db().exec("PRAGMA busy_timeout = 5678");
    let deletes = 0;
    log.registerSink({
      info() {},
      warn() {},
      error() {},
      captureException() {},
      withDbSpan(sql, fn) {
        if (sql.startsWith("DELETE FROM temporal_vec WHERE") && ++deletes === 2)
          throw new Error("second delete rejected");
        return fn();
      },
    });
    stop = startVec0OrphanMaintenance(() => false);
    await vi.advanceTimersByTimeAsync(4000);
    expect(keys()).toEqual([
      { chunk_id: "first-orphan" },
      { chunk_id: "second-orphan" },
    ]);
    expect(db().query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5678 });
    await vi.advanceTimersByTimeAsync(30000);
    expect(keys()).toEqual([]);
    expect(specs).toHaveLength(5);
  });

  it("executes discovery on the bundled native read worker", async () => {
    vi.useRealTimers();
    vi.mocked(pool.tryPoolRead).mockRestore();
    pool._setTestVectorWorkerFactory(
      (init) =>
        new Worker(resolve("packages/gateway/dist/vector-worker.cjs"), {
          workerData: init,
        }),
    );
    db()
      .query("INSERT INTO knowledge_vec (id, embedding) VALUES (?, ?)")
      .run("worker-orphan", blob);
    stop = startVec0OrphanMaintenance(() => false);
    await vi.waitFor(
      () => {
        expect(
          db()
            .query("SELECT id FROM knowledge_vec WHERE id = ?")
            .get("worker-orphan"),
        ).toBeNull();
      },
      { timeout: 10_000, interval: 25 },
    );
  });

  it.each([
    [
      "knowledge_vec",
      "INSERT INTO knowledge_vec (id, embedding) VALUES (?, ?)",
      ["orphan", blob],
    ],
    [
      "entity_vec",
      "INSERT INTO entity_vec (id, embedding) VALUES (?, ?)",
      ["orphan", blob],
    ],
    [
      "distillation_vec",
      "INSERT INTO distillation_vec (id, project_id, session_id, embedding) VALUES (?, 'p', 's', ?)",
      ["orphan", blob],
    ],
  ] as const)("covers the %s registry member", async (table, sql, params) => {
    db()
      .query(sql)
      .run(...params);
    stop = startVec0OrphanMaintenance(() => false);
    await vi.advanceTimersByTimeAsync(4000);
    expect(db().query(`SELECT id FROM ${table}`).all()).toEqual([]);
  });

  it("uses an indexed page cursor and exact-key vector lookup", async () => {
    temporal("orphan");
    stop = startVec0OrphanMaintenance(() => false);
    await vi.advanceTimersByTimeAsync(4000);
    const plan = db()
      .query(`EXPLAIN QUERY PLAN ${specs[3]}`)
      .all(0, VEC0_ORPHAN_PAGE_SIZE) as { detail: string }[];
    expect(plan.map((row) => row.detail).join("\n")).toContain(
      "SEARCH temporal_vec_rowids USING INTEGER PRIMARY KEY (rowid>?)",
    );
    // sqlite-vec's exact text-primary-key lookup is the 3 plan. The fullscan
    // plan would rescan the virtual table once per candidate.
    expect(plan.map((row) => row.detail).join("\n")).toMatch(
      /SCAN v VIRTUAL TABLE INDEX 3:/,
    );
  });

  it("does not busy-wait on the writer and restores the caller's timeout", async () => {
    temporal("orphan");
    db().exec("PRAGMA busy_timeout = 1234");
    const observed: number[] = [];
    log.registerSink({
      info() {},
      warn() {},
      error() {},
      captureException() {},
      withDbSpan(sql, fn) {
        if (sql.startsWith("DELETE FROM temporal_vec WHERE")) {
          const timeout = db().query("PRAGMA busy_timeout").get() as {
            timeout: number;
          };
          observed.push(timeout.timeout);
        }
        return fn();
      },
    });
    stop = startVec0OrphanMaintenance(() => false);
    await vi.advanceTimersByTimeAsync(4000);
    expect(observed).toEqual([0]);
    expect(db().query("PRAGMA busy_timeout").get()).toEqual({ timeout: 1234 });
  });

  it("deletes dangling exact chunk IDs while retaining backed chunks", async () => {
    base("live");
    temporal("live#0", "live");
    temporal("live#1", "live");
    temporal("old#0", "old");
    temporal("old#1", "old");
    stop = startVec0OrphanMaintenance(() => false);
    await vi.advanceTimersByTimeAsync(4000);
    expect(keys()).toEqual([{ chunk_id: "live#0" }, { chunk_id: "live#1" }]);
    expect(specs).toHaveLength(4);
  });

  it("advances bounded pages through healthy rows before later orphans", async () => {
    base("live");
    for (let i = 0; i < VEC0_ORPHAN_PAGE_SIZE + 1; i++)
      temporal(`live#${i}`, "live");
    temporal("orphan");
    stop = startVec0OrphanMaintenance(() => false);
    await vi.advanceTimersByTimeAsync(4000);
    expect(keys()).toHaveLength(VEC0_ORPHAN_PAGE_SIZE + 2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(keys()).toHaveLength(VEC0_ORPHAN_PAGE_SIZE + 1);
    expect(specs).toHaveLength(5);
  });

  it("rechecks a source restored after the worker snapshot", async () => {
    temporal("restored#0", "restored");
    stop = startVec0OrphanMaintenance(() => false);
    await vi.advanceTimersByTimeAsync(3000);
    beforeReply = () => base("restored");
    await vi.advanceTimersByTimeAsync(1000);
    expect(keys()).toEqual([{ chunk_id: "restored#0" }]);
  });

  it("rechecks a chunk replaced with a different live source", async () => {
    base("live");
    temporal("replaced", "missing");
    stop = startVec0OrphanMaintenance(() => false);
    await vi.advanceTimersByTimeAsync(3000);
    beforeReply = () => {
      db().query("DELETE FROM temporal_vec WHERE chunk_id = ?").run("replaced");
      temporal("replaced", "live");
    };
    await vi.advanceTimersByTimeAsync(1000);
    expect(keys()).toEqual([{ chunk_id: "replaced" }]);
  });

  it("retains current knowledge across tenants while pruning deleted and historical vectors", async () => {
    for (const [id, current, deleted, tenant] of [
      ["current-local", 1, 0, ""],
      ["current-other", 1, 0, "tenant-b"],
      ["old-version", 0, 0, "tenant-b"],
      ["deleted", 1, 1, "tenant-c"],
    ] as const) {
      db()
        .query(
          "INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at, logical_id, is_current, is_deleted, tenant_id) VALUES (?, ?, 'test', '', '', 1, 1, ?, ?, ?, ?)",
        )
        .run(id, pid, id, current, deleted, tenant);
      db()
        .query("INSERT INTO knowledge_vec (id, embedding) VALUES (?, ?)")
        .run(id, blob);
    }
    stop = withTenant("tenant-a", () =>
      startVec0OrphanMaintenance(() => false),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(
      db().query("SELECT id FROM knowledge_vec ORDER BY id").all(),
    ).toEqual([{ id: "current-local" }, { id: "current-other" }]);
    expect(
      db()
        .query("SELECT COUNT(*) AS n FROM knowledge WHERE project_id = ?")
        .get(pid),
    ).toEqual({ n: 4 });
  });

  it("rechecks a knowledge tombstone restored after the worker snapshot", async () => {
    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at, logical_id, is_deleted) VALUES ('restored', ?, 'test', '', '', 1, 1, 'restored', 1)",
      )
      .run(pid);
    db()
      .query("INSERT INTO knowledge_vec (id, embedding) VALUES (?, ?)")
      .run("restored", blob);
    beforeReply = () => {
      db()
        .query("UPDATE knowledge SET is_deleted = 0 WHERE id = ?")
        .run("restored");
    };
    stop = startVec0OrphanMaintenance(() => false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(db().query("SELECT id FROM knowledge_vec").all()).toEqual([
      { id: "restored" },
    ]);
  });

  it("binds SQL-looking and large vector IDs without touching live source rows", async () => {
    base("live");
    temporal("live#0", "live");
    temporal("x'); DROP TABLE temporal_messages; --");
    temporal("x".repeat(262_144));
    stop = startVec0OrphanMaintenance(() => false);
    await vi.advanceTimersByTimeAsync(4000);
    expect(keys()).toEqual([{ chunk_id: "live#0" }]);
    expect(
      db()
        .query("SELECT id FROM temporal_messages WHERE project_id = ?")
        .all(pid),
    ).toEqual([{ id: "live" }]);
  });

  it("retries a real competing writer lock without losing rows or busy timeout state", async () => {
    temporal("orphan");
    db().exec("PRAGMA busy_timeout = 1234");
    const observed: number[] = [];
    log.registerSink({
      info() {},
      warn() {},
      error() {},
      captureException() {},
      withDbSpan(sql, fn) {
        if (sql.startsWith("DELETE FROM temporal_vec WHERE")) {
          observed.push(
            (db().query("PRAGMA busy_timeout").get() as { timeout: number })
              .timeout,
          );
        }
        return fn();
      },
    });
    const other = new DatabaseSync(dbPath());
    let locked = false;
    try {
      stop = startVec0OrphanMaintenance(() => false);
      await vi.advanceTimersByTimeAsync(3000);
      beforeReply = () => {
        other.exec("BEGIN IMMEDIATE");
        locked = true;
      };
      await vi.advanceTimersByTimeAsync(1000);
      expect(observed).toEqual([0]);
      expect(keys()).toEqual([{ chunk_id: "orphan" }]);
      expect(db().query("PRAGMA busy_timeout").get()).toEqual({
        timeout: 1234,
      });
      other.exec("ROLLBACK");
      locked = false;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(keys()).toEqual([]);
      expect(observed).toEqual([0, 0]);
    } finally {
      if (locked) other.exec("ROLLBACK");
      other.close();
    }
  });

  it.each([null, pool.READ_JOB_TIMED_OUT] as const)(
    "backs off unavailable/timed out reads without a synchronous scan: %s",
    async (result) => {
      vi.mocked(pool.tryPoolRead).mockResolvedValue(result);
      temporal("orphan");
      stop = startVec0OrphanMaintenance(() => false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(pool.tryPoolRead).toHaveBeenCalledTimes(1);
      expect(keys()).toHaveLength(1);
    },
  );

  it("pauses reads and replays a page if foreground work starts during the read", async () => {
    temporal("orphan");
    let paused = true;
    stop = startVec0OrphanMaintenance(() => paused);
    await vi.advanceTimersByTimeAsync(4000);
    expect(specs).toHaveLength(0);
    paused = false;
    await vi.advanceTimersByTimeAsync(3000);
    beforeReply = () => {
      paused = true;
    };
    await vi.advanceTimersByTimeAsync(1000);
    expect(keys()).toHaveLength(1);
    paused = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(keys()).toHaveLength(0);
  });

  it.each(["stop", "reopen"])("ignores a late page after %s", async (event) => {
    temporal("orphan");
    stop = startVec0OrphanMaintenance(() => false);
    await vi.advanceTimersByTimeAsync(3000);
    beforeReply = () => {
      if (event === "stop") stop!();
      else {
        close();
        db();
      }
    };
    await vi.advanceTimersByTimeAsync(60_000);
    expect(keys()).toHaveLength(1);
    expect(specs).toHaveLength(4);
  });
});
