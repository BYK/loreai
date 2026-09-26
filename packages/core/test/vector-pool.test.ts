import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { close, db, ensureProject } from "../src/db";
import { pruneIdle } from "../src/temporal";
import {
  _resetVectorPoolForTest,
  _setTestVectorWorkerFactory,
  checkReadOffload,
  checkVecWorker,
  MAX_PENDING_READ_BYTES,
  MAX_PENDING_READ_JOBS,
  readPoolStats,
  setReadPoolTelemetryHook,
  READ_JOB_PRESSURED,
  READ_JOB_TIMED_OUT,
  shutdownVectorPool,
  shutdownVectorPoolAsync,
  tryPoolRead,
  tryPoolVectorSearch,
  VECTOR_SEARCH_TIMED_OUT,
  vectorSearchTimeoutMs,
} from "../src/vector-pool";
import type { ReadJobSpec } from "../src/read-job";
import type {
  VectorWorkerInbound,
  VectorWorkerInitData,
} from "../src/vector-worker-types";

// A deterministic stand-in for a node:worker_threads Worker. `onSearch` decides
// how the fake responds to each "search" message; `onRead` to each "read"
// message — so each test drives the pool through a specific path (result /
// error / timeout / death).
class FakeWorker extends EventEmitter {
  static instances: FakeWorker[] = [];
  terminated = false;
  readonly index: number;

  constructor(
    readonly onSearch: (
      w: FakeWorker,
      msg: Extract<VectorWorkerInbound, { type: "search" }>,
    ) => void,
    readonly onRead?: (
      w: FakeWorker,
      msg: Extract<VectorWorkerInbound, { type: "read" }>,
    ) => void,
  ) {
    super();
    this.index = FakeWorker.instances.length;
    FakeWorker.instances.push(this);
  }
  unref(): void {}
  postMessage(msg: VectorWorkerInbound): void {
    if (msg.type === "search") this.onSearch(this, msg);
    else if (msg.type === "read") this.onRead?.(this, msg);
  }
  terminate(): Promise<number> {
    this.terminated = true;
    this.emit("exit", 0);
    return Promise.resolve(0);
  }
  ready(vecAvailable: boolean): void {
    this.emit("message", { type: "ready", vecAvailable });
  }
  reply(id: number, hits: unknown[]): void {
    this.emit("message", { type: "result", id, hits });
  }
  replyRead(id: number, rows: unknown): void {
    this.emit("message", { type: "read-result", id, rows });
  }
  replyError(id: number, error: string): void {
    this.emit("message", { type: "error", id, error });
  }
  die(code = 1): void {
    this.emit("exit", code);
  }
  initError(error: string): void {
    this.emit("message", { type: "init-error", error });
  }
  crash(err: Error): void {
    this.emit("error", err);
  }
}

function factoryReturning(
  onSearch: (
    w: FakeWorker,
    msg: Extract<VectorWorkerInbound, { type: "search" }>,
  ) => void,
): (d: VectorWorkerInitData) => never {
  return (() => new FakeWorker(onSearch)) as unknown as (
    d: VectorWorkerInitData,
  ) => never;
}

function factoryReturningRead(
  onRead: (
    w: FakeWorker,
    msg: Extract<VectorWorkerInbound, { type: "read" }>,
  ) => void,
): (d: VectorWorkerInitData) => never {
  return (() => new FakeWorker(() => {}, onRead)) as unknown as (
    d: VectorWorkerInitData,
  ) => never;
}

const READ_JOB: ReadJobSpec = {
  sql: "SELECT id FROM knowledge_current WHERE project_id = ?",
  params: ["p1"],
  mode: "all",
};

const QUERY = new Float32Array([1, 0, 0]);
const KNOWLEDGE = { kind: "knowledge" as const, limit: 10 };

beforeEach(() => {
  FakeWorker.instances = [];
  _resetVectorPoolForTest();
});

afterEach(() => {
  _setTestVectorWorkerFactory(null);
  _resetVectorPoolForTest();
  delete process.env.LORE_DISABLE_VEC_WORKER;
  delete process.env.LORE_VEC_SEARCH_TIMEOUT_MS;
  vi.useRealTimers();
});

describe("vector-pool dispatch", () => {
  it("routes a search through the pool and returns its hits", async () => {
    _setTestVectorWorkerFactory(
      factoryReturning((w, msg) =>
        w.reply(msg.id, [{ id: "pooled", similarity: 0.9 }]),
      ),
    );
    const hits = await tryPoolVectorSearch(KNOWLEDGE, QUERY);
    expect(hits).toEqual([{ id: "pooled", similarity: 0.9 }]);
  });

  it("spawns a worker only once across multiple searches", async () => {
    _setTestVectorWorkerFactory(
      factoryReturning((w, msg) => w.reply(msg.id, [])),
    );
    await tryPoolVectorSearch(KNOWLEDGE, QUERY);
    const afterFirst = FakeWorker.instances.length;
    await tryPoolVectorSearch(KNOWLEDGE, QUERY);
    expect(FakeWorker.instances.length).toBe(afterFirst);
  });
});

describe("vector-pool kill switch / disable", () => {
  it("returns null when LORE_DISABLE_VEC_WORKER=1 (never spawns)", async () => {
    process.env.LORE_DISABLE_VEC_WORKER = "1";
    _setTestVectorWorkerFactory(
      factoryReturning((w, msg) =>
        w.reply(msg.id, [{ id: "x", similarity: 1 }]),
      ),
    );
    const hits = await tryPoolVectorSearch(KNOWLEDGE, QUERY);
    expect(hits).toBeNull();
    expect(FakeWorker.instances.length).toBe(0);
  });
});

describe("vectorSearchTimeoutMs env override", () => {
  const DEFAULT_MS = 10_000;

  it("uses the 10s default when unset", () => {
    delete process.env.LORE_VEC_SEARCH_TIMEOUT_MS;
    expect(vectorSearchTimeoutMs()).toBe(DEFAULT_MS);
  });

  it("honors a valid positive integer override", () => {
    process.env.LORE_VEC_SEARCH_TIMEOUT_MS = "2500";
    expect(vectorSearchTimeoutMs()).toBe(2500);
  });

  it("floors a fractional value", () => {
    process.env.LORE_VEC_SEARCH_TIMEOUT_MS = "100.9";
    expect(vectorSearchTimeoutMs()).toBe(100);
  });

  it.each(["abc", "", "  ", "0", "-5", "Infinity", "NaN"])(
    "ignores invalid/non-positive value %j and falls back to the default",
    (raw) => {
      // Guards the setTimeout(Infinity)/NaN foot-gun: a bad value must never
      // arm a never-firing (or immediately-firing) timer.
      process.env.LORE_VEC_SEARCH_TIMEOUT_MS = raw;
      expect(vectorSearchTimeoutMs()).toBe(DEFAULT_MS);
    },
  );
});

describe("vector-pool fallback paths (resolve null, never throw)", () => {
  it("returns null when the worker reports a per-request error", async () => {
    _setTestVectorWorkerFactory(
      factoryReturning((w, msg) => w.replyError(msg.id, "boom")),
    );
    expect(await tryPoolVectorSearch(KNOWLEDGE, QUERY)).toBeNull();
  });

  it("resolves the timeout sentinel (NOT null) when the worker never replies", async () => {
    // The sentinel is what tells the caller "the worker is slow — return empty,
    // don't re-run the scan in-process". Asserting the sentinel (not null) is
    // the non-vacuous guard: pre-fix the timeout rejected → caught → null, so
    // this would fail. (null is reserved for pool disabled/broken/errored.)
    vi.useFakeTimers();
    _setTestVectorWorkerFactory(factoryReturning(() => {}));
    const p = tryPoolVectorSearch(KNOWLEDGE, QUERY);
    await vi.advanceTimersByTimeAsync(vectorSearchTimeoutMs() + 1);
    expect(await p).toBe(VECTOR_SEARCH_TIMED_OUT);
  });

  it("returns null and latches broken when spawning throws (no retry)", async () => {
    let calls = 0;
    _setTestVectorWorkerFactory(() => {
      calls++;
      throw new Error("spawn failed");
    });
    expect(await tryPoolVectorSearch(KNOWLEDGE, QUERY)).toBeNull();
    const afterFirst = calls;
    expect(afterFirst).toBeGreaterThan(0);
    // Broken latch: the factory is not invoked again.
    expect(await tryPoolVectorSearch(KNOWLEDGE, QUERY)).toBeNull();
    expect(calls).toBe(afterFirst);
  });
});

describe("vector-pool health", () => {
  it("respawns fresh workers after the live ones die", async () => {
    _setTestVectorWorkerFactory(
      factoryReturning((w, msg) =>
        w.reply(msg.id, [{ id: "ok", similarity: 1 }]),
      ),
    );
    expect(await tryPoolVectorSearch(KNOWLEDGE, QUERY)).toEqual([
      { id: "ok", similarity: 1 },
    ]);
    const spawnedBefore = FakeWorker.instances.length;
    // Kill every worker.
    for (const w of FakeWorker.instances) w.die();
    // Next search must spawn new workers and still succeed.
    expect(await tryPoolVectorSearch(KNOWLEDGE, QUERY)).toEqual([
      { id: "ok", similarity: 1 },
    ]);
    expect(FakeWorker.instances.length).toBeGreaterThan(spawnedBefore);
  });

  it("dispatches a concurrent second search to a less-busy worker", async () => {
    const received: number[] = [];
    _setTestVectorWorkerFactory(
      factoryReturning((w, msg) => {
        received.push(w.index);
        // Only worker #1 answers; worker #0 holds its request open.
        if (w.index === 1) w.reply(msg.id, [{ id: "from1", similarity: 1 }]);
      }),
    );
    const held = tryPoolVectorSearch(KNOWLEDGE, QUERY); // → worker 0, never replies
    held.catch(() => {}); // resolved/cleared on teardown; don't leak rejection
    const second = await tryPoolVectorSearch(KNOWLEDGE, QUERY); // → worker 1
    expect(received).toEqual([0, 1]);
    expect(second).toEqual([{ id: "from1", similarity: 1 }]);
  });

  it("shutdownVectorPool terminates every spawned worker", async () => {
    _setTestVectorWorkerFactory(
      factoryReturning((w, msg) => w.reply(msg.id, [])),
    );
    await tryPoolVectorSearch(KNOWLEDGE, QUERY);
    expect(FakeWorker.instances.length).toBeGreaterThan(0);
    shutdownVectorPool();
    expect(FakeWorker.instances.every((w) => w.terminated)).toBe(true);
  });
});

describe("vector-pool structural-failure latch (review #989)", () => {
  it("latches broken after repeated worker deaths (no respawn storm)", async () => {
    // Every dispatched worker dies — a stand-in for a broken bundle / a worker
    // that crashes on load (which surfaces asynchronously as exit).
    _setTestVectorWorkerFactory(factoryReturning((w) => w.die()));
    for (let i = 0; i < 12; i++) {
      expect(await tryPoolVectorSearch(KNOWLEDGE, QUERY)).toBeNull();
    }
    const spawnedAtLatch = FakeWorker.instances.length;
    // Latched: further calls neither spawn a worker nor throw.
    expect(await tryPoolVectorSearch(KNOWLEDGE, QUERY)).toBeNull();
    expect(FakeWorker.instances.length).toBe(spawnedAtLatch);
  });

  it("late success from a retired reader cannot clear the structural failure streak", async () => {
    _setTestVectorWorkerFactory(factoryReturning((w) => w.die()));
    const first = await tryPoolVectorSearch(KNOWLEDGE, QUERY);
    expect(first).toBeNull();
    const retired = FakeWorker.instances[0];
    for (let i = 0; i < 12; i++) {
      retired.reply(9999, []); // A stale reply is not a healthy new worker.
      expect(await tryPoolVectorSearch(KNOWLEDGE, QUERY)).toBeNull();
    }
    const spawnedAtLatch = FakeWorker.instances.length;
    retired.reply(9999, []);
    expect(await tryPoolVectorSearch(KNOWLEDGE, QUERY)).toBeNull();
    expect(FakeWorker.instances.length).toBe(spawnedAtLatch);
  });

  it("terminates a dead worker instead of leaking its thread", async () => {
    _setTestVectorWorkerFactory(
      factoryReturning((w, msg) => w.reply(msg.id, [])),
    );
    await tryPoolVectorSearch(KNOWLEDGE, QUERY);
    const victim = FakeWorker.instances[0];
    victim.die();
    expect(victim.terminated).toBe(false);
    // The next search runs ensurePool, which must terminate the dead worker.
    await tryPoolVectorSearch(KNOWLEDGE, QUERY);
    expect(victim.terminated).toBe(true);
  });

  it("unref()'s the per-request timeout timer so a pending search can't delay exit", async () => {
    // The actual review-#989 bug: the per-request timeout timer was ref'd, so an
    // in-flight search would hold the event loop open on shutdown even though
    // the worker is unref'd. Spy on the real timer object's unref() — asserting
    // it's called is the only non-vacuous check (removing the source line fails
    // this). The worker replies synchronously, so the timer is also cleared and
    // never leaks.
    const realSetTimeout = globalThis.setTimeout;
    const unref = vi.fn();
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      const t = realSetTimeout(handler, ms, ...rest);
      (t as unknown as { unref: () => void }).unref = unref;
      return t;
    }) as never);
    try {
      _setTestVectorWorkerFactory(
        factoryReturning((w, msg) =>
          w.reply(msg.id, [{ id: "ok", similarity: 1 }]),
        ),
      );
      await tryPoolVectorSearch(KNOWLEDGE, QUERY);
      expect(unref).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("treats a worker init-error message as a structural death", async () => {
    // A reader connection that fails to open surfaces as an init-error message,
    // marking the worker structurally dead. Asserting only null would be vacuous
    // (the timeout fallback also resolves the sentinel); instead assert the dead
    // worker is terminated on the next ensurePool. Pre-fix mutation (init-error
    // -> no markDead): the victim stays alive and this fails.
    _setTestVectorWorkerFactory(
      factoryReturning((w, msg) => w.reply(msg.id, [])),
    );
    await tryPoolVectorSearch(KNOWLEDGE, QUERY); // healthy worker spawned
    const victim = FakeWorker.instances[0];
    victim.initError("reader open failed"); // init-error message → markDead
    expect(victim.terminated).toBe(false);
    // The next search runs ensurePool, which must terminate the dead worker.
    await tryPoolVectorSearch(KNOWLEDGE, QUERY);
    expect(victim.terminated).toBe(true);
  });

  it("treats a worker 'error' event as a structural death", async () => {
    // Same non-vacuous shape as above: a crashed worker must be recognized as
    // dead and terminated on the next ensurePool, not merely produce a null.
    _setTestVectorWorkerFactory(
      factoryReturning((w, msg) => w.reply(msg.id, [])),
    );
    await tryPoolVectorSearch(KNOWLEDGE, QUERY); // healthy worker spawned
    const victim = FakeWorker.instances[0];
    victim.crash(new Error("worker thread crashed")); // error event → markDead
    expect(victim.terminated).toBe(false);
    await tryPoolVectorSearch(KNOWLEDGE, QUERY);
    expect(victim.terminated).toBe(true);
  });

  it("clears the timer when postMessage throws (no leaked timer)", async () => {
    // A throw in the Promise executor rejects regardless, so asserting null is
    // vacuous — the actual S2 bug is the per-request ref'd timer left armed. Assert it
    // was cleared (pre-fix: 1 leaked timer; post-fix: 0).
    vi.useFakeTimers();
    _setTestVectorWorkerFactory((() => {
      const w = new FakeWorker(() => {});
      // Simulate the worker dying between leastBusy() and postMessage().
      w.postMessage = () => {
        throw new Error("dead pipe");
      };
      return w;
    }) as never);
    expect(await tryPoolVectorSearch(KNOWLEDGE, QUERY)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("vector-pool timeout cancellation (#1006 follow-up)", () => {
  it("terminates the wedged worker on timeout (cancelling its uninterruptible scan)", async () => {
    vi.useFakeTimers();
    let served: FakeWorker | undefined;
    _setTestVectorWorkerFactory(
      factoryReturning((w) => {
        served = w; // receive the search but never reply → force a timeout
      }),
    );
    const p = tryPoolVectorSearch(KNOWLEDGE, QUERY);
    await vi.advanceTimersByTimeAsync(vectorSearchTimeoutMs() + 1);
    expect(await p).toBe(VECTOR_SEARCH_TIMED_OUT);
    // The worker running the doomed synchronous scan is terminated so its thread
    // is freed and leastBusy() stops routing new work behind the stuck scan.
    expect(served?.terminated).toBe(true);
  });

  it("recovers after a timeout: the next search is NOT routed to the wedged worker", async () => {
    vi.useFakeTimers();
    let mode: "hang" | "reply" = "hang";
    // Tag each reply with the serving worker's index so we can prove which
    // worker handled the recovery search.
    _setTestVectorWorkerFactory(
      factoryReturning((w, msg) => {
        if (mode === "reply") {
          w.reply(msg.id, [{ id: `from-${w.index}`, similarity: 1 }]);
        }
      }),
    );
    // First search lands on worker 0 (leastBusy tie → first) and hangs.
    const timedOut = tryPoolVectorSearch(KNOWLEDGE, QUERY);
    await vi.advanceTimersByTimeAsync(vectorSearchTimeoutMs() + 1);
    expect(await timedOut).toBe(VECTOR_SEARCH_TIMED_OUT);
    const wedged = FakeWorker.instances[0];
    expect(wedged.index).toBe(0);
    expect(wedged.terminated).toBe(true);

    mode = "reply";
    vi.useRealTimers();
    // The follow-up must be served by a different, live worker — NOT the wedged
    // one. Pre-cancellation (worker 0 left alive, in-flight deleted), leastBusy
    // sees worker 0 as idle and reuses it → the result would be tagged "from-0".
    const hits = await tryPoolVectorSearch(KNOWLEDGE, QUERY);
    expect(hits).toHaveLength(1);
    expect(hits).not.toContainEqual({ id: "from-0", similarity: 1 });
  });

  it("never latches the pool broken on repeated timeouts (slowness != structural failure)", async () => {
    vi.useFakeTimers();
    let mode: "hang" | "reply" = "hang";
    _setTestVectorWorkerFactory(
      factoryReturning((w, msg) => {
        if (mode === "reply") w.reply(msg.id, [{ id: "ok", similarity: 1 }]);
      }),
    );
    // Far more consecutive timeouts than MAX_STRUCTURAL_FAILURES (6). If a
    // timeout counted as a structural failure, the pool would latch broken and
    // every later caller would get null (the in-process fallback) — exactly the
    // main-thread stall the worker offload exists to avoid.
    for (let i = 0; i < 10; i++) {
      const p = tryPoolVectorSearch(KNOWLEDGE, QUERY);
      await vi.advanceTimersByTimeAsync(vectorSearchTimeoutMs() + 1);
      expect(await p).toBe(VECTOR_SEARCH_TIMED_OUT);
    }
    mode = "reply";
    vi.useRealTimers();
    // Still alive: a replying worker is served rather than bypassed.
    expect(await tryPoolVectorSearch(KNOWLEDGE, QUERY)).toEqual([
      { id: "ok", similarity: 1 },
    ]);
  });

  it("times out a queued search without posting it behind a wedged worker", async () => {
    vi.useFakeTimers();
    // The third search remains host-queued and its deadline expires without
    // sending it to a busy worker. It must retain the no-synchronous-fallback
    // timeout contract, even when the first worker is retired.
    const seen: number[] = [];
    _setTestVectorWorkerFactory(
      factoryReturning((w) => {
        seen.push(w.index); // never reply
      }),
    );
    const first = tryPoolVectorSearch(KNOWLEDGE, QUERY); // → worker 0
    first.catch(() => {});
    const filler = tryPoolVectorSearch(KNOWLEDGE, QUERY); // → worker 1
    filler.catch(() => {});
    const collateral = tryPoolVectorSearch(KNOWLEDGE, QUERY);
    expect(seen).toEqual([0, 1]);
    await vi.advanceTimersByTimeAsync(vectorSearchTimeoutMs() + 1);
    expect(await first).toBe(VECTOR_SEARCH_TIMED_OUT);
    expect(await collateral).toBe(VECTOR_SEARCH_TIMED_OUT);
  });
});

describe("vector-pool generic read jobs (tryPoolRead)", () => {
  it("routes a read through the pool and returns { rows }", async () => {
    const rows = [{ id: "a" }, { id: "b" }];
    _setTestVectorWorkerFactory(
      factoryReturningRead((w, msg) => w.replyRead(msg.id, rows)),
    );
    const res = await tryPoolRead(READ_JOB);
    expect(res).toEqual({ rows });
  });

  it("wraps a no-row null reply as { rows: null }, not a bare null", async () => {
    // Load-bearing: a `.get()` that matched no row legitimately resolves null.
    // The { rows } wrapper distinguishes "pool ran it, result was null" from
    // "pool unavailable" (a bare null → caller re-runs in-process). Dropping the
    // wrapper would make the caller needlessly re-query.
    _setTestVectorWorkerFactory(
      factoryReturningRead((w, msg) => w.replyRead(msg.id, null)),
    );
    const res = await tryPoolRead({
      sql: "SELECT 1 WHERE 0",
      params: [],
      mode: "get",
    });
    expect(res).not.toBeNull();
    expect(res).toEqual({ rows: null });
  });

  it("returns null (fall back) when LORE_DISABLE_VEC_WORKER=1, never spawns", async () => {
    process.env.LORE_DISABLE_VEC_WORKER = "1";
    _setTestVectorWorkerFactory(
      factoryReturningRead((w, msg) => w.replyRead(msg.id, [{ id: "x" }])),
    );
    expect(await tryPoolRead(READ_JOB)).toBeNull();
    expect(FakeWorker.instances.length).toBe(0);
  });

  it("returns null when the worker reports a per-request error", async () => {
    _setTestVectorWorkerFactory(
      factoryReturningRead((w, msg) => w.replyError(msg.id, "bad sql")),
    );
    expect(await tryPoolRead(READ_JOB)).toBeNull();
  });

  it("resolves READ_JOB_TIMED_OUT (not null) and retires the wedged worker on timeout", async () => {
    // Same #1006 contract as vector search: a read timeout means the worker is
    // slow, NOT that the pool is unavailable. Returning the sentinel (not null)
    // tells offload helpers to degrade to empty instead of re-running the scan
    // in-process (which would re-block the loop). The wedged worker is retired.
    vi.useFakeTimers();
    let served: FakeWorker | undefined;
    _setTestVectorWorkerFactory(
      factoryReturningRead((w) => {
        served = w; // receive the read but never reply → force a timeout
      }),
    );
    const p = tryPoolRead(READ_JOB);
    await vi.advanceTimersByTimeAsync(vectorSearchTimeoutMs() + 1);
    expect(await p).toBe(READ_JOB_TIMED_OUT);
    expect(served?.terminated).toBe(true);
  });

  it("times out a queued read without posting it behind a wedged worker", async () => {
    // Host-queued reads retain the no-synchronous-fallback timeout contract.
    vi.useFakeTimers();
    const seen: number[] = [];
    _setTestVectorWorkerFactory(
      factoryReturningRead((w) => {
        seen.push(w.index); // never reply
      }),
    );
    const first = tryPoolRead(READ_JOB); // → worker 0
    first.catch(() => {});
    const filler = tryPoolRead(READ_JOB); // → worker 1
    filler.catch(() => {});
    const collateral = tryPoolRead(READ_JOB);
    expect(seen).toEqual([0, 1]);
    await vi.advanceTimersByTimeAsync(vectorSearchTimeoutMs() + 1);
    expect(await first).toBe(READ_JOB_TIMED_OUT);
    expect(await collateral).toBe(READ_JOB_TIMED_OUT);
  });

  it("shares one worker pool across reads (spawns once)", async () => {
    _setTestVectorWorkerFactory(
      factoryReturningRead((w, msg) => w.replyRead(msg.id, [])),
    );
    await tryPoolRead(READ_JOB);
    const afterFirst = FakeWorker.instances.length;
    expect(afterFirst).toBeGreaterThan(0);
    await tryPoolRead(READ_JOB);
    expect(FakeWorker.instances.length).toBe(afterFirst);
  });
});

describe("bounded read-pool admission (#1739)", () => {
  const job = (name: string): ReadJobSpec => ({
    sql: `SELECT '${name}'`,
    params: [],
    mode: "all",
  });

  it("bounds queued jobs and bytes, reporting pressure without posting rejected work", async () => {
    const posted: string[] = [];
    _setTestVectorWorkerFactory(
      factoryReturningRead((_w, msg) => {
        posted.push(msg.spec.sql);
      }),
    );
    const held = [tryPoolRead(job("held-0")), tryPoolRead(job("held-1"))];
    const pending = Array.from({ length: MAX_PENDING_READ_JOBS }, (_, i) =>
      tryPoolRead(job(`queued-${i}`)),
    );
    const rejected = await tryPoolRead(job("rejected"));
    expect(rejected).toBe(READ_JOB_PRESSURED);
    expect(readPoolStats().pendingCount).toBe(MAX_PENDING_READ_JOBS);
    expect(readPoolStats().pendingBytes).toBeLessThanOrEqual(
      MAX_PENDING_READ_BYTES,
    );
    expect(readPoolStats().runningCount).toBe(2);
    expect(posted).toEqual(["SELECT 'held-0'", "SELECT 'held-1'"]);
    shutdownVectorPool();
    await Promise.all([...held, ...pending]);
  });

  it("reserves foreground admission and schedules background fairly under sustained foreground load", async () => {
    const posted: Array<{ worker: FakeWorker; id: number; name: string }> = [];
    _setTestVectorWorkerFactory(
      factoryReturningRead((worker, msg) => {
        posted.push({ worker, id: msg.id, name: msg.spec.sql });
      }),
    );
    const initial = [tryPoolRead(job("held-0")), tryPoolRead(job("held-1"))];
    const background = Array.from({ length: 4 }, (_, i) =>
      tryPoolRead(job(`background-${i}`), { priority: "background" }),
    );
    const foreground = Array.from({ length: 12 }, (_, i) =>
      tryPoolRead(job(`foreground-${i}`)),
    );
    expect(posted).toHaveLength(2);
    posted[0].worker.replyRead(posted[0].id, []);
    expect(posted[2].name).toBe("SELECT 'foreground-0'");
    for (let i = 2; i < 8; i++) {
      posted[i].worker.replyRead(posted[i].id, []);
    }
    expect(posted.slice(2, 8).some((p) => p.name.includes("background"))).toBe(
      true,
    );
    shutdownVectorPool();
    await Promise.all([...initial, ...background, ...foreground]);
  });

  it("expires and aborts queued jobs without posting them or retiring a busy worker", async () => {
    vi.useFakeTimers();
    const posted: string[] = [];
    _setTestVectorWorkerFactory(
      factoryReturningRead((_w, msg) => {
        posted.push(msg.spec.sql);
      }),
    );
    const held = [tryPoolRead(job("held-0")), tryPoolRead(job("held-1"))];
    const controller = new AbortController();
    const aborted = tryPoolRead(job("aborted"), { signal: controller.signal });
    controller.abort();
    expect(await aborted).toBe(READ_JOB_TIMED_OUT);
    expect(posted).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(vectorSearchTimeoutMs() + 1);
    expect(FakeWorker.instances.slice(0, 2).every((w) => w.terminated)).toBe(
      true,
    );
    expect(await Promise.all(held)).toEqual([
      READ_JOB_TIMED_OUT,
      READ_JOB_TIMED_OUT,
    ]);
    expect(posted).not.toContain("SELECT 'aborted'");
  });

  it("expires a queued deadline without retiring either worker running another job", async () => {
    vi.useFakeTimers();
    const posted: string[] = [];
    _setTestVectorWorkerFactory(
      factoryReturningRead((_w, msg) => {
        posted.push(msg.spec.sql);
      }),
    );
    process.env.LORE_VEC_SEARCH_TIMEOUT_MS = "1000";
    const held = [tryPoolRead(job("held-0")), tryPoolRead(job("held-1"))];
    process.env.LORE_VEC_SEARCH_TIMEOUT_MS = "10";
    const queued = tryPoolRead(job("queued-short"));
    await vi.advanceTimersByTimeAsync(11);
    expect(await queued).toBe(READ_JOB_TIMED_OUT);
    expect(posted).toEqual(["SELECT 'held-0'", "SELECT 'held-1'"]);
    expect(FakeWorker.instances.every((worker) => !worker.terminated)).toBe(
      true,
    );
    expect(readPoolStats()).toMatchObject({ pendingCount: 0, runningCount: 2 });
    shutdownVectorPool();
    await Promise.all(held);
  });

  it("keeps a retired worker's physical slot occupied until termination is confirmed", async () => {
    vi.useFakeTimers();
    const posted: string[] = [];
    const release: Array<() => void> = [];
    _setTestVectorWorkerFactory((() => {
      const worker = new FakeWorker(
        () => {},
        (w, msg) => {
          posted.push(msg.spec.sql);
          if (msg.spec.sql.includes("queued")) w.replyRead(msg.id, []);
        },
      );
      worker.terminate = () =>
        new Promise<number>((resolve) => {
          release.push(() => {
            worker.terminated = true;
            worker.die(0);
            resolve(0);
          });
        });
      return worker;
    }) as unknown as (d: VectorWorkerInitData) => never);

    const held = [tryPoolRead(job("held-0")), tryPoolRead(job("held-1"))];
    await vi.advanceTimersByTimeAsync(100);
    const queued = tryPoolRead(job("queued"));
    await vi.advanceTimersByTimeAsync(vectorSearchTimeoutMs() - 100);
    expect(await Promise.all(held)).toEqual([
      READ_JOB_TIMED_OUT,
      READ_JOB_TIMED_OUT,
    ]);
    expect(posted).toEqual(["SELECT 'held-0'", "SELECT 'held-1'"]);
    expect(readPoolStats().pendingCount).toBe(1);
    expect(release).toHaveLength(2);
    expect(readPoolStats().retiringCount).toBe(2);
    release[0]();
    await vi.waitFor(() => expect(posted).toContain("SELECT 'queued'"));
    expect(await queued).toEqual({ rows: [] });
    release[1]();
  });

  it("reserves queue space for foreground work when background admission fills", async () => {
    const posted: string[] = [];
    _setTestVectorWorkerFactory(
      factoryReturningRead((_w, msg) => posted.push(msg.spec.sql)),
    );
    const held = [tryPoolRead(job("held-0")), tryPoolRead(job("held-1"))];
    const background = Array.from({ length: 32 }, (_, i) =>
      tryPoolRead(job(`background-${i}`), { priority: "background" }),
    );
    expect(
      await tryPoolRead(job("over-background-cap"), { priority: "background" }),
    ).toBe(READ_JOB_PRESSURED);
    const foreground = tryPoolRead(job("foreground"));
    expect(readPoolStats().pendingCount).toBe(33);
    expect(posted).toHaveLength(2);
    shutdownVectorPool();
    await Promise.all([...held, ...background, foreground]);
  });

  it("reports one terminal outcome for an aborted running read that later replies", async () => {
    const posted: Array<{ worker: FakeWorker; id: number; sql: string }> = [];
    const terminal: string[] = [];
    setReadPoolTelemetryHook((sample) => {
      if (!["admitted", "started", "pressure"].includes(sample.outcome)) {
        terminal.push(sample.outcome);
      }
    });
    _setTestVectorWorkerFactory(
      factoryReturningRead((worker, msg) =>
        posted.push({ worker, id: msg.id, sql: msg.spec.sql }),
      ),
    );
    const controller = new AbortController();
    const aborted = tryPoolRead(job("aborted"), {
      signal: controller.signal,
    });
    const companion = tryPoolRead(job("companion"));
    expect(posted).toHaveLength(2);

    controller.abort();
    expect(await aborted).toBe(READ_JOB_TIMED_OUT);
    const queued = tryPoolRead(job("after-abort"));
    expect(readPoolStats()).toMatchObject({
      runningCount: 2,
      pendingCount: 1,
    });
    expect(posted).toHaveLength(2);

    posted[0].worker.replyRead(posted[0].id, []);
    expect(posted[2].sql).toBe("SELECT 'after-abort'");
    expect(readPoolStats()).toMatchObject({
      runningCount: 2,
      pendingCount: 0,
    });
    expect(terminal).toEqual(["cancelled"]);
    shutdownVectorPool();
    await Promise.all([companion, queued]);
    expect(terminal).toEqual(["cancelled", "unavailable", "unavailable"]);
  });

  it("rejects a byte-oversized job before a worker sees its payload", async () => {
    const posted: string[] = [];
    _setTestVectorWorkerFactory(
      factoryReturningRead((_w, msg) => posted.push(msg.spec.sql)),
    );
    const result = await tryPoolRead({
      sql: "SELECT ?",
      params: [new Uint8Array(MAX_PENDING_READ_BYTES + 1)],
      mode: "all",
    });
    expect(result).toBe(READ_JOB_PRESSURED);
    expect(posted).toEqual([]);
    expect(readPoolStats().pendingBytes).toBe(0);
  });

  it("copies queued payloads and tightens typed-array views before accounting them", async () => {
    const posted: Array<{
      worker: FakeWorker;
      msg: Extract<VectorWorkerInbound, { type: "read" }>;
    }> = [];
    _setTestVectorWorkerFactory(
      factoryReturningRead((worker, msg) => {
        posted.push({ worker, msg });
      }),
    );
    const held = [tryPoolRead(job("held-0")), tryPoolRead(job("held-1"))];
    const backing = new Uint8Array(MAX_PENDING_READ_BYTES * 2);
    backing[3] = 7;
    const narrow = backing.subarray(3, 4);
    const spec: ReadJobSpec = {
      sql: "SELECT ?",
      params: [narrow],
      mode: "all",
    };
    const queued = tryPoolRead(spec);
    spec.sql = "SELECT 'mutated'";
    spec.params.push(new Uint8Array(MAX_PENDING_READ_BYTES));
    narrow[0] = 9;
    expect(readPoolStats().pendingBytes).toBeLessThan(1024);
    posted[0].worker.replyRead(posted[0].msg.id, []);
    const actual = posted[2].msg.spec;
    expect(actual.sql).toBe("SELECT ?");
    expect(actual.params).toHaveLength(1);
    expect(actual.params[0]).toEqual(new Uint8Array([7]));
    expect((actual.params[0] as Uint8Array).buffer.byteLength).toBe(1);
    posted[2].worker.replyRead(posted[2].msg.id, []);
    await queued;
    shutdownVectorPool();
    await Promise.all(held);
  });

  it("snapshots a queued vector spec and embedding before caller mutation", async () => {
    const posted: Array<{
      worker: FakeWorker;
      msg: Extract<VectorWorkerInbound, { type: "search" }>;
    }> = [];
    _setTestVectorWorkerFactory(
      factoryReturning((worker, msg) => {
        posted.push({ worker, msg });
      }),
    );
    const held = [
      tryPoolVectorSearch(KNOWLEDGE, QUERY),
      tryPoolVectorSearch(KNOWLEDGE, QUERY),
    ];
    const spec = {
      kind: "knowledge" as const,
      limit: 1,
      excludeCategories: ["original"],
    };
    const backing = new Float32Array(1024 * 1024);
    backing[4] = 0.5;
    const narrow = backing.subarray(4, 5);
    const queued = tryPoolVectorSearch(spec, narrow);
    spec.limit = 99;
    spec.excludeCategories[0] = "mutated";
    narrow[0] = 0.9;
    posted[0].worker.reply(posted[0].msg.id, []);
    expect(posted[2].msg.spec).toEqual({
      kind: "knowledge",
      limit: 1,
      excludeCategories: ["original"],
    });
    expect(posted[2].msg.embedding).toEqual(new Float32Array([0.5]));
    expect(posted[2].msg.embedding.buffer.byteLength).toBe(4);
    posted[2].worker.reply(posted[2].msg.id, []);
    await queued;
    shutdownVectorPool();
    await Promise.all(held);
  });

  it("drops extra binary spec fields and keeps malformed priorities off telemetry", async () => {
    const posted: Array<{
      worker: FakeWorker;
      msg: Extract<VectorWorkerInbound, { type: "search" }>;
    }> = [];
    const priorities: string[] = [];
    setReadPoolTelemetryHook((sample) => priorities.push(sample.priority));
    _setTestVectorWorkerFactory(
      factoryReturning((worker, msg) => posted.push({ worker, msg })),
    );
    const held = [
      tryPoolVectorSearch(KNOWLEDGE, QUERY),
      tryPoolVectorSearch(KNOWLEDGE, QUERY),
    ];
    const spec = {
      ...KNOWLEDGE,
      extra: new ArrayBuffer(MAX_PENDING_READ_BYTES * 4),
    };
    const queued = tryPoolVectorSearch(spec, QUERY, {
      priority: "tenant-secret" as "foreground",
    });
    expect(readPoolStats().pendingBytes).toBeLessThan(1024);
    posted[0].worker.reply(posted[0].msg.id, []);
    expect(Object.keys(posted[2].msg.spec)).not.toContain("extra");
    expect(priorities.every((priority) => priority === "foreground")).toBe(
      true,
    );
    posted[2].worker.reply(posted[2].msg.id, []);
    await queued;
    shutdownVectorPool();
    await Promise.all(held);
  });

  it("does not strand an admitted job when the second worker fails to spawn", async () => {
    let spawned = 0;
    _setTestVectorWorkerFactory((() => {
      if (++spawned === 2) throw new Error("second slot unavailable");
      return new FakeWorker(
        () => {},
        () => {},
      );
    }) as unknown as (d: VectorWorkerInitData) => Worker);
    expect(await tryPoolRead(job("first"))).toBeNull();
    expect(readPoolStats()).toMatchObject({ pendingCount: 0, runningCount: 0 });
    expect(spawned).toBe(2);
    expect(FakeWorker.instances[0].terminated).toBe(true);
  });

  it("drains queued work on database replacement and serves new work on fresh workers", async () => {
    db();
    const posted: string[] = [];
    _setTestVectorWorkerFactory(
      factoryReturningRead((worker, msg) => {
        posted.push(msg.spec.sql);
        if (msg.spec.sql.includes("fresh"))
          worker.replyRead(msg.id, [{ generation: "new" }]);
      }),
    );
    const old = [
      tryPoolRead(job("old-0")),
      tryPoolRead(job("old-1")),
      tryPoolRead(job("old-queued")),
    ];
    close();
    db();
    const fresh = tryPoolRead(job("fresh"));
    expect(await Promise.all(old)).toEqual([null, null, null]);
    expect(await fresh).toEqual({ rows: [{ generation: "new" }] });
    expect(posted).toEqual([
      "SELECT 'old-0'",
      "SELECT 'old-1'",
      "SELECT 'fresh'",
    ]);
  });

  it("drains queued jobs before graceful shutdown without posting them", async () => {
    const posted: string[] = [];
    _setTestVectorWorkerFactory(
      factoryReturningRead((_worker, msg) => {
        posted.push(msg.spec.sql);
      }),
    );
    const held = [tryPoolRead(job("held-0")), tryPoolRead(job("held-1"))];
    const queued = tryPoolRead(job("queued"));
    await shutdownVectorPoolAsync(10);
    expect(await Promise.all([...held, queued])).toEqual([
      READ_JOB_TIMED_OUT,
      READ_JOB_TIMED_OUT,
      READ_JOB_TIMED_OUT,
    ]);
    expect(posted).toEqual(["SELECT 'held-0'", "SELECT 'held-1'"]);
    expect(readPoolStats()).toMatchObject({ pendingCount: 0, runningCount: 0 });
  });

  it("reports admission, queue age and service timing through the read-pool hook", async () => {
    vi.useFakeTimers();
    const samples: Array<{
      outcome: string;
      kind: string;
      pendingCount: number;
      oldestPendingMs: number;
      queueMs?: number;
      serviceMs?: number;
    }> = [];
    setReadPoolTelemetryHook((sample) => samples.push(sample));
    const posted: Array<{ worker: FakeWorker; id: number }> = [];
    _setTestVectorWorkerFactory(
      factoryReturningRead((worker, msg) => {
        posted.push({ worker, id: msg.id });
      }),
    );
    const held = [tryPoolRead(job("held-0")), tryPoolRead(job("held-1"))];
    const queued = tryPoolRead(job("queued"));
    expect(
      samples.some(
        (sample) => sample.outcome === "admitted" && sample.pendingCount === 1,
      ),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(readPoolStats().oldestPendingMs).toBeGreaterThanOrEqual(0);
    posted[0].worker.replyRead(posted[0].id, []);
    const started = samples.find(
      (sample) =>
        sample.outcome === "started" &&
        sample.queueMs !== undefined &&
        sample.queueMs > 0,
    );
    expect(started?.queueMs).toBeGreaterThan(0);
    expect(samples.every((sample) => sample.kind === "sql")).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    posted[2].worker.replyRead(posted[2].id, []);
    expect(
      samples.some(
        (sample) => sample.outcome === "ok" && (sample.serviceMs ?? 0) > 0,
      ),
    ).toBe(true);
    await queued;
    shutdownVectorPool();
    await Promise.all(held);
  });

  it("labels the background pruning read without including SQL in telemetry", async () => {
    const kinds: string[] = [];
    setReadPoolTelemetryHook((sample) => kinds.push(sample.kind));
    _setTestVectorWorkerFactory(
      factoryReturningRead((worker, msg) =>
        worker.replyRead(msg.id, [{ b: 0 }]),
      ),
    );
    expect(
      await tryPoolRead(
        { ...job("prune"), telemetryKind: "temporal-prune" },
        { priority: "background" },
      ),
    ).toEqual({ rows: [{ b: 0 }] });
    expect(kinds).toEqual([
      "temporal-prune",
      "temporal-prune",
      "temporal-prune",
    ]);
  });

  it("dispatches the idle size scan to the background read worker", async () => {
    const projectPath = `/tmp/idle-prune-worker-${crypto.randomUUID()}`;
    const pid = ensureProject(projectPath);
    const posted: ReadJobSpec[] = [];
    const priorities: string[] = [];
    setReadPoolTelemetryHook((sample) => {
      if (sample.kind === "temporal-prune") priorities.push(sample.priority);
    });
    _setTestVectorWorkerFactory(
      factoryReturningRead((worker, msg) => {
        posted.push(msg.spec);
        worker.replyRead(msg.id, [{ b: 0, has_distilled: null }]);
      }),
    );
    expect(
      await pruneIdle({ projectPath, retentionDays: 120, maxStorageMB: 1 }),
    ).toEqual({ ttlDeleted: 0, capDeleted: 0, sizeScanComplete: true });
    expect(posted).toEqual([
      {
        sql: "SELECT SUM(LENGTH(content)) as b, MAX(distilled) as has_distilled FROM temporal_messages WHERE project_id = ?",
        params: [pid],
        mode: "all",
        telemetryKind: "temporal-prune",
      },
    ]);
    expect(priorities).toEqual(["background", "background", "background"]);
  });

  it("keeps a running aborted job charged until its reply, then serves the next job once", async () => {
    const posted: Array<{ worker: FakeWorker; id: number; sql: string }> = [];
    _setTestVectorWorkerFactory(
      factoryReturningRead((worker, msg) => {
        posted.push({ worker, id: msg.id, sql: msg.spec.sql });
      }),
    );
    const controller = new AbortController();
    const aborted = tryPoolRead(job("running"), { signal: controller.signal });
    const filler = tryPoolRead(job("filler"));
    const next = tryPoolRead(job("next"));
    controller.abort();
    expect(await aborted).toBe(READ_JOB_TIMED_OUT);
    expect(readPoolStats()).toMatchObject({ pendingCount: 1, runningCount: 2 });
    expect(posted).toHaveLength(2);
    posted[0].worker.replyRead(posted[0].id, []);
    posted[0].worker.replyRead(posted[0].id, [{ id: "late" }]);
    expect(posted.map((p) => p.sql)).toEqual([
      "SELECT 'running'",
      "SELECT 'filler'",
      "SELECT 'next'",
    ]);
    posted[2].worker.replyRead(posted[2].id, [{ id: "once" }]);
    expect(await next).toEqual({ rows: [{ id: "once" }] });
    shutdownVectorPool();
    await filler;
  });

  it("round-trips queued SQL through the production worker bundle", async () => {
    const bundle = new URL(
      "../../gateway/dist/vector-worker.cjs",
      import.meta.url,
    );
    if (!existsSync(bundle))
      throw new Error(
        "Build the gateway bundle before the real-worker smoke test",
      );
    const dir = mkdtempSync(join(tmpdir(), "lore-read-pool-"));
    const previousPath = process.env.LORE_DB_PATH;
    try {
      const path = join(dir, "smoke.db");
      const db = new DatabaseSync(path);
      db.exec("PRAGMA journal_mode = WAL");
      db.close();
      process.env.LORE_DB_PATH = path;
      _setTestVectorWorkerFactory(
        (data) => new Worker(bundle, { workerData: data }),
      );
      const requests = [
        tryPoolRead(job("one")),
        tryPoolRead(job("two")),
        tryPoolRead(job("three")),
      ];
      expect(readPoolStats()).toMatchObject({
        runningCount: 2,
        pendingCount: 1,
      });
      expect(await Promise.all(requests)).toEqual([
        { rows: [{ "'one'": "one" }] },
        { rows: [{ "'two'": "two" }] },
        { rows: [{ "'three'": "three" }] },
      ]);
      await shutdownVectorPoolAsync();
    } finally {
      if (previousPath === undefined) delete process.env.LORE_DB_PATH;
      else process.env.LORE_DB_PATH = previousPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("embedding.vectorSearch routes through the pool", () => {
  it("returns the pool's hits, not the in-process scan", async () => {
    _setTestVectorWorkerFactory(
      factoryReturning((w, msg) =>
        w.reply(msg.id, [{ id: "via-pool", similarity: 0.42 }]),
      ),
    );
    const { vectorSearch } = await import("../src/embedding");
    const hits = await vectorSearch(QUERY, 5);
    expect(hits).toEqual([{ id: "via-pool", similarity: 0.42 }]);
  });

  it("returns empty on pool timeout and does NOT re-run the scan in-process", async () => {
    // The stall bug: on a pool timeout the consumer used to fall back to the
    // synchronous O(n) scan on the main thread. Spy on the in-process query so
    // the guard is non-vacuous — pre-fix this spy WOULD be called (and its
    // result returned); post-fix the consumer returns [] without touching it.
    const vq = await import("../src/vector-query");
    const { vectorSearch } = await import("../src/embedding");
    const spy = vi
      .spyOn(vq, "runVectorQuery")
      .mockReturnValue([{ id: "IN-PROCESS", similarity: 1 }]);
    try {
      _setTestVectorWorkerFactory(factoryReturning(() => {})); // never replies
      vi.useFakeTimers();
      const p = vectorSearch(QUERY, 5);
      await vi.advanceTimersByTimeAsync(vectorSearchTimeoutMs() + 1);
      expect(await p).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("checkVecWorker (off-thread read-pool vec probe, #1033)", () => {
  // The real worker posts `ready` at construction; checkVecWorker attaches its
  // listeners synchronously after spawn, so the fake must emit on a macrotask
  // (after the listeners exist) — emitting synchronously in the constructor
  // would be missed, exactly unlike a real worker_threads MessagePort which
  // buffers until a listener is attached.
  function factoryEmitting(
    action: (w: FakeWorker) => void,
  ): (d: VectorWorkerInitData) => never {
    return (() => {
      const w = new FakeWorker(() => {});
      setTimeout(() => action(w), 0);
      return w;
    }) as unknown as (d: VectorWorkerInitData) => never;
  }

  it("reports ready + vecAvailable=true when the worker loads native vec", async () => {
    _setTestVectorWorkerFactory(factoryEmitting((w) => w.ready(true)));
    const r = await checkVecWorker();
    expect(r).toEqual({ status: "ready", vecAvailable: true });
    // The probe worker is always torn down before resolving.
    expect(FakeWorker.instances[0]?.terminated).toBe(true);
  });

  it("reports ready + vecAvailable=false when the worker falls back to JS", async () => {
    _setTestVectorWorkerFactory(factoryEmitting((w) => w.ready(false)));
    const r = await checkVecWorker();
    expect(r).toEqual({ status: "ready", vecAvailable: false });
  });

  it("reports init-error when the worker's reader connection fails to open", async () => {
    _setTestVectorWorkerFactory(
      factoryEmitting((w) => w.initError("open boom")),
    );
    const r = await checkVecWorker();
    expect(r).toEqual({
      status: "init-error",
      vecAvailable: false,
      error: "open boom",
    });
  });

  it("reports spawn-error when the worker emits 'error'", async () => {
    _setTestVectorWorkerFactory(
      factoryEmitting((w) => w.crash(new Error("crash boom"))),
    );
    const r = await checkVecWorker();
    expect(r).toEqual({
      status: "spawn-error",
      vecAvailable: false,
      error: "crash boom",
    });
  });

  it("reports spawn-error when the worker exits before reporting readiness", async () => {
    _setTestVectorWorkerFactory(factoryEmitting((w) => w.die(1)));
    const r = await checkVecWorker();
    expect(r.status).toBe("spawn-error");
    expect(r.vecAvailable).toBe(false);
    expect(r.error).toContain("exited before reporting readiness");
  });

  it("reports spawn-error when spawning throws synchronously", async () => {
    _setTestVectorWorkerFactory(() => {
      throw new Error("no worker");
    });
    const r = await checkVecWorker();
    expect(r).toEqual({
      status: "spawn-error",
      vecAvailable: false,
      error: "no worker",
    });
  });

  it("reports timeout when the worker never reports readiness", async () => {
    // Worker that never emits ready/init-error/exit (stays silent).
    _setTestVectorWorkerFactory(factoryEmitting(() => {}));
    const r = await checkVecWorker(20);
    expect(r).toEqual({ status: "timeout", vecAvailable: false });
    // The wedged probe worker is terminated so it can't leak a thread.
    expect(FakeWorker.instances[0]?.terminated).toBe(true);
  });

  it("spawns exactly one probe worker via the factory seam", async () => {
    // Guards against accidental real-worker spawns in unit tests: with a factory
    // installed, exactly one fake is created per probe.
    _setTestVectorWorkerFactory(factoryEmitting((w) => w.ready(true)));
    await checkVecWorker();
    expect(FakeWorker.instances.length).toBe(1);
  });
});

describe("checkReadOffload (off-thread read-job round-trip probe, #1029)", () => {
  // Like the real worker, the fake must emit on a macrotask (after
  // checkReadOffload attaches its listeners). `onReadReply` decides how the fake
  // answers the `read` request checkReadOffload posts once it sees `ready`.
  function factoryReadProbe(
    onReadReply: (w: FakeWorker, id: number) => void,
    vecAvailable = true,
  ): (d: VectorWorkerInitData) => never {
    return (() => {
      const w = new FakeWorker(
        () => {},
        (worker, msg) => onReadReply(worker, msg.id),
      );
      setTimeout(() => w.ready(vecAvailable), 0);
      return w;
    }) as unknown as (d: VectorWorkerInitData) => never;
  }

  // A worker that emits an arbitrary lifecycle action (init-error / crash /
  // silence) on a macrotask and never answers a read request.
  function factoryEmitting(
    action: (w: FakeWorker) => void,
  ): (d: VectorWorkerInitData) => never {
    return (() => {
      const w = new FakeWorker(() => {});
      setTimeout(() => action(w), 0);
      return w;
    }) as unknown as (d: VectorWorkerInitData) => never;
  }

  it("reports ok when the worker boots and round-trips the read job", async () => {
    _setTestVectorWorkerFactory(
      factoryReadProbe((w, id) => w.replyRead(id, { one: 1 })),
    );
    const r = await checkReadOffload();
    expect(r).toEqual({ status: "ok" });
    // The probe worker is always torn down before resolving.
    expect(FakeWorker.instances[0]?.terminated).toBe(true);
  });

  it("reports init-error when the worker's reader connection fails to open", async () => {
    _setTestVectorWorkerFactory(
      factoryEmitting((w) => w.initError("open boom")),
    );
    const r = await checkReadOffload();
    expect(r).toEqual({ status: "init-error", error: "open boom" });
  });

  it("reports read-error when the worker throws running the job", async () => {
    _setTestVectorWorkerFactory(
      factoryReadProbe((w, id) => w.replyError(id, "scan boom")),
    );
    const r = await checkReadOffload();
    expect(r).toEqual({ status: "read-error", error: "scan boom" });
  });

  it("reports bad-result when the worker returns an unexpected row", async () => {
    _setTestVectorWorkerFactory(
      factoryReadProbe((w, id) => w.replyRead(id, { one: 2 })),
    );
    const r = await checkReadOffload();
    expect(r.status).toBe("bad-result");
    expect(r.error).toBe(JSON.stringify({ one: 2 }));
  });

  it("reports bad-result when the worker returns a null row", async () => {
    _setTestVectorWorkerFactory(
      factoryReadProbe((w, id) => w.replyRead(id, null)),
    );
    const r = await checkReadOffload();
    expect(r.status).toBe("bad-result");
  });

  it("reports spawn-error when the worker emits 'error'", async () => {
    _setTestVectorWorkerFactory(
      factoryEmitting((w) => w.crash(new Error("crash boom"))),
    );
    const r = await checkReadOffload();
    expect(r).toEqual({ status: "spawn-error", error: "crash boom" });
  });

  it("reports spawn-error when the worker exits before returning a result", async () => {
    // Boots (ready) but dies when the read request arrives — no read-result.
    _setTestVectorWorkerFactory(factoryReadProbe((w) => w.die(1)));
    const r = await checkReadOffload();
    expect(r.status).toBe("spawn-error");
    expect(r.error).toContain("exited before returning a read result");
  });

  it("reports spawn-error when spawning throws synchronously", async () => {
    _setTestVectorWorkerFactory(() => {
      throw new Error("no worker");
    });
    const r = await checkReadOffload();
    expect(r).toEqual({ status: "spawn-error", error: "no worker" });
  });

  it("reports timeout when the worker never boots", async () => {
    // Worker that never emits ready/init-error/exit (stays silent).
    _setTestVectorWorkerFactory(factoryEmitting(() => {}));
    const r = await checkReadOffload(20);
    expect(r).toEqual({ status: "timeout" });
    // The wedged probe worker is terminated so it can't leak a thread.
    expect(FakeWorker.instances[0]?.terminated).toBe(true);
  });

  it("spawns directly, bypassing the poolEnabled kill switch", async () => {
    // checkReadOffload must probe the worker seam even when the pool is disabled
    // by config/env — otherwise a disabled ambient config would mask a broken
    // SEA seam. With LORE_DISABLE_VEC_WORKER set (poolEnabled() → false), it
    // still spawns and round-trips.
    process.env.LORE_DISABLE_VEC_WORKER = "1";
    _setTestVectorWorkerFactory(
      factoryReadProbe((w, id) => w.replyRead(id, { one: 1 })),
    );
    const r = await checkReadOffload();
    expect(r).toEqual({ status: "ok" });
    expect(FakeWorker.instances.length).toBe(1);
  });
});
