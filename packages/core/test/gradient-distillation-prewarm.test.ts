import { EventEmitter } from "node:events";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { db, ensureProject } from "../src/db";
import {
  calibrate,
  evictSession,
  inspectSessionState,
  prewarmDistillationSnapshot,
  setModelLimits,
  transform,
} from "../src/gradient";
import { runReadJob } from "../src/read-job";
import {
  _resetVectorPoolForTest,
  _setTestVectorWorkerFactory,
  vectorSearchTimeoutMs,
} from "../src/vector-pool";
import type {
  VectorWorkerInbound,
  VectorWorkerInitData,
} from "../src/vector-worker-types";
import type { LoreMessage, LoreMessageWithParts } from "../src/types";

// #1082: prewarmDistillationSnapshot pre-loads the session's distillation
// snapshot OFF-THREAD before the sync transform() runs. It must populate the
// SAME per-session snapshot transform() reads with byte-identical rows, respect
// the turn-boundary cache key, and — critically — leave the snapshot UNtouched
// on a worker timeout so transform() falls back to the identical sync load
// (never freeze an empty snapshot).

const PROJECT = "/test/gradient-distill-prewarm";

/** Read-worker fake: answers each read against the live DB, recording dispatched
 *  SQL so a test can prove the offload path was taken. */
class ServingReadWorker extends EventEmitter {
  static sqls: string[] = [];
  unref(): void {}
  postMessage(msg: VectorWorkerInbound): void {
    if (msg.type === "read") {
      ServingReadWorker.sqls.push(msg.spec.sql);
      const rows = runReadJob(db(), msg.spec);
      this.emit("message", { type: "read-result", id: msg.id, rows });
    }
  }
  terminate(): Promise<number> {
    this.emit("exit", 0);
    return Promise.resolve(0);
  }
}

/** Read-worker fake that never replies → forces the per-request timeout. */
class HangingReadWorker extends EventEmitter {
  unref(): void {}
  postMessage(): void {}
  terminate(): Promise<number> {
    this.emit("exit", 0);
    return Promise.resolve(0);
  }
}

function installFactory(make: () => EventEmitter): void {
  _resetVectorPoolForTest();
  _setTestVectorWorkerFactory(
    make as unknown as (d: VectorWorkerInitData) => never,
  );
}

let sessionCounter = 0;
function freshSession(): string {
  return `prewarm-sess-${sessionCounter++}`;
}

function userMsg(id: string, sessionID: string): LoreMessageWithParts {
  const info: LoreMessage = {
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
  };
  return { info, parts: [] };
}

/** A message carrying `text` (for driving transform() past the Layer 0
 *  passthrough so it actually reaches the distillation load). */
function makeMsg(
  id: string,
  role: "user" | "assistant",
  text: string,
  sessionID: string,
): LoreMessageWithParts {
  const info: LoreMessage =
    role === "user"
      ? {
          id,
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4-20250514",
          },
        }
      : {
          id,
          sessionID,
          role: "assistant",
          time: { created: Date.now() },
          parentID: `parent-${id}`,
          modelID: "claude-sonnet-4-20250514",
          providerID: "anthropic",
          mode: "build",
          path: { cwd: "/test", root: "/test" },
          cost: 0,
          tokens: {
            input: 100,
            output: 50,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        };
  return {
    info,
    parts: [
      {
        id: `part-${id}`,
        sessionID,
        messageID: id,
        type: "text",
        text,
        time: { start: Date.now(), end: Date.now() },
      },
    ],
  };
}

/** Insert a non-archived distillation. `createdAt`/`id` drive the (created_at
 *  ASC, id ASC) cache-stability ordering. */
function seedDistillation(
  sessionID: string,
  id: string,
  observations: string,
  createdAt: number,
  sourceIds: string[] = [],
): void {
  const pid = ensureProject(PROJECT);
  db()
    .query(
      `INSERT INTO distillations
         (id, project_id, session_id, narrative, facts, observations, source_ids,
          generation, token_count, call_type, created_at, archived)
       VALUES (?, ?, ?, '', '', ?, ?, 0, 10, 'auto', ?, 0)`,
    )
    .run(
      id,
      pid,
      sessionID,
      observations,
      JSON.stringify(sourceIds),
      createdAt,
    );
}

beforeAll(() => {
  ensureProject(PROJECT);
  // transform() needs model limits + zero overhead to run in a unit test.
  setModelLimits({ context: 10_000, output: 2_000 });
  calibrate(0);
});

beforeEach(() => {
  ServingReadWorker.sqls = [];
  const pid = ensureProject(PROJECT);
  db().query("DELETE FROM distillations WHERE project_id = ?").run(pid);
});

afterEach(() => {
  vi.useRealTimers();
  _setTestVectorWorkerFactory(null);
  _resetVectorPoolForTest();
});

describe("prewarmDistillationSnapshot (#1082)", () => {
  it("populates the snapshot off-thread with rows in (created_at, id) order", async () => {
    const SESSION = freshSession();
    // Out-of-insertion-order created_at + a same-ms id tie-break pair.
    seedDistillation(SESSION, "d-b", "second", 2000, ["s2"]);
    seedDistillation(SESSION, "d-a", "first", 1000, ["s1a", "s1b"]);
    seedDistillation(SESSION, "d-c", "tie-2", 3000);
    seedDistillation(SESSION, "d-aa", "tie-1", 3000); // same ms as d-c → id tie-break

    installFactory(() => new ServingReadWorker());
    await prewarmDistillationSnapshot(PROJECT, SESSION, [
      userMsg("u1", SESSION),
    ]);

    const snap = inspectSessionState(SESSION)?.distillationSnapshot;
    expect(snap).not.toBeNull();
    expect(snap?.lastUserMsgId).toBe("u1");
    // created_at ASC, id ASC: 1000(d-a), 2000(d-b), 3000(d-aa < d-c)
    expect(snap?.rows.map((r) => r.id)).toEqual(["d-a", "d-b", "d-aa", "d-c"]);
    // source_ids JSON is parsed back into arrays.
    expect(snap?.rows.find((r) => r.id === "d-a")?.source_ids).toEqual([
      "s1a",
      "s1b",
    ]);
    expect(snap?.rows.find((r) => r.id === "d-c")?.source_ids).toEqual([]);
    // The scan was actually dispatched to the worker pool.
    expect(
      ServingReadWorker.sqls.some((s) => /FROM distillations\b/.test(s)),
    ).toBe(true);

    evictSession(SESSION);
  });

  it("matches the in-process load exactly (pool served == pool inert)", async () => {
    const SEED: Array<[string, string, number]> = [
      ["p-1", "alpha", 100],
      ["p-2", "beta", 200],
      ["p-3", "gamma", 300],
    ];
    const A = freshSession();
    const B = freshSession();
    for (const [id, obs, ts] of SEED) {
      seedDistillation(A, `${id}-a`, obs, ts, [id]);
      seedDistillation(B, `${id}-b`, obs, ts, [id]);
    }

    // A: pool serves the read. B: no factory → in-process fallback.
    installFactory(() => new ServingReadWorker());
    await prewarmDistillationSnapshot(PROJECT, A, [userMsg("ua", A)]);
    _setTestVectorWorkerFactory(null);
    _resetVectorPoolForTest();
    await prewarmDistillationSnapshot(PROJECT, B, [userMsg("ub", B)]);

    const rowsA = inspectSessionState(A)?.distillationSnapshot?.rows ?? [];
    const rowsB = inspectSessionState(B)?.distillationSnapshot?.rows ?? [];
    // Same observations + parsed source_ids + numeric metadata in the same order
    // (ids differ only by the per-session suffix).
    const project = (r: (typeof rowsA)[number]) => [
      r.observations,
      r.source_ids,
      r.generation,
      r.token_count,
      r.created_at,
      r.r_compression,
      r.c_norm,
    ];
    expect(rowsA.map(project)).toEqual(rowsB.map(project));
    expect(rowsA.length).toBe(3);

    evictSession(A);
    evictSession(B);
  });

  it("is a no-op on a cache hit (same last user message)", async () => {
    const SESSION = freshSession();
    seedDistillation(SESSION, "h-1", "hi", 100);

    installFactory(() => new ServingReadWorker());
    await prewarmDistillationSnapshot(PROJECT, SESSION, [
      userMsg("same", SESSION),
    ]);
    const firstRows = inspectSessionState(SESSION)?.distillationSnapshot?.rows;
    expect(firstRows?.length).toBe(1);

    // Swap in a worker that would HANG if consulted. A second prewarm for the
    // SAME turn key must short-circuit (cache hit) and return without loading.
    installFactory(() => new HangingReadWorker());
    ServingReadWorker.sqls = [];
    await prewarmDistillationSnapshot(PROJECT, SESSION, [
      userMsg("same", SESSION),
    ]);
    // Snapshot unchanged; no new dispatch (it never reached the hanging worker).
    expect(inspectSessionState(SESSION)?.distillationSnapshot?.rows).toBe(
      firstRows,
    );

    evictSession(SESSION);
  });

  it("leaves the snapshot UNtouched on a worker timeout (transform falls back)", async () => {
    const SESSION = freshSession();
    seedDistillation(SESSION, "t-1", "would load if the pool answered", 100);

    installFactory(() => new HangingReadWorker());
    vi.useFakeTimers();
    const p = prewarmDistillationSnapshot(PROJECT, SESSION, [
      userMsg("u1", SESSION),
    ]);
    await vi.advanceTimersByTimeAsync(vectorSearchTimeoutMs() + 1);
    await p;

    // Snapshot NOT populated — a spurious empty snapshot would make transform()
    // drop the distilled prefix for the whole turn.
    expect(
      inspectSessionState(SESSION)?.distillationSnapshot ?? null,
    ).toBeNull();

    evictSession(SESSION);
  });

  it("returns immediately for a session-less input", async () => {
    installFactory(() => new HangingReadWorker()); // would hang if consulted
    await expect(
      prewarmDistillationSnapshot(PROJECT, undefined, []),
    ).resolves.toBeUndefined();
  });

  it("transform() consumes the prewarmed snapshot without re-reading the DB (end-to-end seam)", async () => {
    const SESSION = freshSession();
    seedDistillation(SESSION, "e2e-1", "prewarmed observation", 100, ["x"]);
    // Enough content to blow past the Layer 0 passthrough (context=10k tokens),
    // so transformInner actually reaches loadDistillationsCached.
    const messages: LoreMessageWithParts[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(
        makeMsg(
          `e2e-m${i}`,
          i % 2 === 0 ? "user" : "assistant",
          "C ".repeat(1200),
          SESSION,
        ),
      );
    }
    messages.push(makeMsg("u-e2e", "user", "C ".repeat(1200), SESSION));

    // Prewarm populates the snapshot from the DB.
    await prewarmDistillationSnapshot(PROJECT, SESSION, messages);
    expect(
      inspectSessionState(SESSION)?.distillationSnapshot?.rows.length,
    ).toBe(1);

    // Now DELETE the rows from the DB. A cache MISS in transform() would re-run
    // the sync loadDistillations against the (now empty) table and overwrite the
    // snapshot with []. A cache HIT reuses the prewarmed rows and never reads.
    db().query("DELETE FROM distillations WHERE session_id = ?").run(SESSION);

    transform({ messages, projectPath: PROJECT, sessionID: SESSION });

    // Snapshot still holds the prewarmed row → transform() cache-hit the
    // prewarmed snapshot (and the prewarm/transform cache keys aligned).
    const after = inspectSessionState(SESSION)?.distillationSnapshot;
    expect(after?.rows.map((r) => r.id)).toEqual(["e2e-1"]);

    evictSession(SESSION);
  });
});
