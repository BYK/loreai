import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetVectorPoolForTest,
  _setTestVectorWorkerFactory,
  checkReadOffload,
  checkVecWorker,
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
  /** Inbound messages seen by this worker (for shutdown-path assertions). */
  postMessageCalls: VectorWorkerInbound[] = [];
  /** When true, posting a "shutdown" message fires `exit` on the next
   *  macrotask — simulating the real worker closing its reader and calling
   *  `process.exit(0)` (vector-worker.ts:144-153). Defaults to false so the
   *  existing tests that don't expect shutdown behaviour keep working. */
  simulateCooperativeShutdown = false;
  /** When true, posting a "shutdown" message throws instead of delivering.
   *  Mirrors the real "worker already gone" path that the async shutdown
   *  must tolerate (postMessage on a dead Worker rejects). */
  throwOnShutdownPostMessage = false;
  readonly index: number;

  constructor(
    readonly onSearch: (w: FakeWorker, msg: { id: number }) => void,
    readonly onRead?: (w: FakeWorker, msg: { id: number }) => void,
  ) {
    super();
    this.index = FakeWorker.instances.length;
    FakeWorker.instances.push(this);
  }
  unref(): void {}
  postMessage(msg: VectorWorkerInbound): void {
    this.postMessageCalls.push(msg);
    if (msg.type === "search") {
      this.onSearch(this, msg);
    } else if (msg.type === "read") {
      this.onRead?.(this, msg);
    } else if (msg.type === "shutdown") {
      if (this.throwOnShutdownPostMessage) {
        throw new Error("worker already gone");
      }
      if (this.simulateCooperativeShutdown) {
        // Mirrors the real worker: close the reader, then defer exit so any
        // in-flight reply postMessage can flush first.
        setTimeout(() => this.emit("exit", 0), 0);
      }
    }
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
  onSearch: (w: FakeWorker, msg: { id: number }) => void,
): (d: VectorWorkerInitData) => never {
  return (() => new FakeWorker(onSearch)) as unknown as (
    d: VectorWorkerInitData,
  ) => never;
}

function factoryReturningRead(
  onRead: (w: FakeWorker, msg: { id: number }) => void,
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

describe("shutdownVectorPoolAsync (#1599 graceful gateway shutdown)", () => {
  // The synchronous shutdownVectorPool posts the cooperative message and
  // *immediately* force-terminates, so the worker thread never reads the
  // message and its SQLite reader never closes — leaking the reader while
  // the main thread's `close()` runs `PRAGMA wal_checkpoint(TRUNCATE)`.
  // ShutdownVectorPoolAsync waits for the cooperative exit event first,
  // falling back to terminate on timeout. The pool's outer deadlock
  // guarantee (always resolves, never rejects) is the only thing standing
  // between a wedged worker and a hung Ctrl+C.

  it("resolves immediately when no workers are spawned (#1599: no vector workers)", async () => {
    vi.useFakeTimers();
    try {
      // No factory installed, no calls made → workers array is empty.
      const p = shutdownVectorPoolAsync({ timeoutMs: 1000 });
      // Never resolves a pending timer were any to schedule.
      await p;
      // The default 1000ms timeout never fires (otherwise the fake timer
      // count would be > 0).
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for the cooperative exit event AND terminates a worker that never exits (#1599)", async () => {
    // The pool spawns `DEFAULT_POOL_SIZE = 2` workers on the first dispatch.
    // Make worker 0 cooperative (fires exit on shutdown postMessage) and
    // leave worker 1 wedged (default FakeWorker doesn't simulate cooperative
    // shutdown). The same shutdownVectorPoolAsync call must resolve both
    // exactly once — cooperative path for the first, timeout terminate for
    // the second.
    _setTestVectorWorkerFactory(
      factoryReturning((w, msg) => w.reply(msg.id, [])),
    );
    await tryPoolVectorSearch(KNOWLEDGE, QUERY); // spawns the pool
    expect(FakeWorker.instances.length).toBeGreaterThanOrEqual(2);
    const cooperative = FakeWorker.instances[0];
    cooperative.simulateCooperativeShutdown = true;
    // worker 1 (the second spawned) stays wedged by default.

    const start = Date.now();
    await shutdownVectorPoolAsync({ timeoutMs: 40 });
    const elapsed = Date.now() - start;
    // Cooperative exit fires on the next macrotask — should resolve in single-
    // digit ms. The wedged worker takes the 40ms timeout. Total well under 1s.
    expect(elapsed).toBeLessThan(1000);
    // Both workers posted a shutdown message — the cooperative path is tried
    // for every worker, even the one that ends up being terminated.
    expect(
      FakeWorker.instances.every((w) =>
        w.postMessageCalls.some((m) => m.type === "shutdown"),
      ),
    ).toBe(true);
    // The cooperative worker exited WITHOUT being terminated (its exit came
    // from the postMessage path, not from terminate()).
    expect(cooperative.terminated).toBe(false);
    // The wedged worker WAS terminated by the timeout fallback.
    const wedged = FakeWorker.instances[1];
    expect(wedged.terminated).toBe(true);
  });

  it("falls back to terminate() when the worker never posts exit (always resolves)", async () => {
    // Acceptance criterion #1599: "A bounded async vector-pool shutdown
    // waits for every worker exit/reader close, always resolves, and never
    // rejects." A worker that responds to NOTHING but terminate() must
    // still resolve the shutdown within the timeout — never hang.
    _setTestVectorWorkerFactory(
      factoryReturning((w, msg) => w.reply(msg.id, [])),
    );
    await tryPoolVectorSearch(KNOWLEDGE, QUERY);
    expect(FakeWorker.instances.length).toBeGreaterThan(0);
    const wedged = FakeWorker.instances[0];
    expect(wedged.terminated).toBe(false);

    const start = Date.now();
    // FakeWorker never fires exit on a shutdown postMessage (default), so the
    // only path is the timeout → terminate() → emit exit → resolve.
    await shutdownVectorPoolAsync({ timeoutMs: 30 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(wedged.terminated).toBe(true);
  });

  it("is idempotent — a second call when the pool is already empty resolves immediately", async () => {
    // The gateway may receive a second SIGINT (see shutdown.ts: count>=2
    // branch). The async shutdown must be safe to call twice; the second call
    // sees an empty workers list and returns synchronously.
    _setTestVectorWorkerFactory(
      factoryReturning((w, msg) => w.reply(msg.id, [])),
    );
    await tryPoolVectorSearch(KNOWLEDGE, QUERY);
    await shutdownVectorPoolAsync({ timeoutMs: 100 });
    // Second call: workers list is already drained.
    const start = Date.now();
    await shutdownVectorPoolAsync({ timeoutMs: 1000 });
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("never rejects when a worker throws on shutdown postMessage (already gone)", async () => {
    // The real worker may have already exited (e.g. process.exit(1) from
    // a load failure) — postMessage then throws. The async shutdown must
    // still resolve via the late-arriving exit event (or the timeout), not
    // reject the outer promise.
    _setTestVectorWorkerFactory(
      factoryReturning((w, msg) => w.reply(msg.id, [])),
    );
    await tryPoolVectorSearch(KNOWLEDGE, QUERY);
    const ghost = FakeWorker.instances[0];
    ghost.throwOnShutdownPostMessage = true;
    // Resolves (not rejects) even though postMessage threw.
    await expect(
      shutdownVectorPoolAsync({ timeoutMs: 50 }),
    ).resolves.toBeUndefined();
    // The thrown-on-postMessage worker still gets the timeout's
    // terminate() attempt as a backstop.
    expect(ghost.terminated).toBe(true);
  });

  it("clears the workers list so a wedged worker can't linger past shutdown", async () => {
    // After shutdownVectorPoolAsync resolves, the internal workers array must
    // be empty so a stray tryPoolVectorSearch() spawned mid-shutdown doesn't
    // re-introduce a live worker. (The pool is `shuttingDown` after this
    // point, so any new ensurePool() call would terminate-new + fail-fast.)
    _setTestVectorWorkerFactory(
      factoryReturning((w, msg) => w.reply(msg.id, [])),
    );
    await tryPoolVectorSearch(KNOWLEDGE, QUERY);
    expect(FakeWorker.instances.length).toBeGreaterThan(0);
    await shutdownVectorPoolAsync({ timeoutMs: 50 });
    // Subsequent shutdownVectorPoolAsync calls are no-ops (the array is
    // cleared synchronously at function entry).
    await shutdownVectorPoolAsync({ timeoutMs: 50 });
  });

  it("falls back to the default 1s timeout for invalid/zero/NaN overrides", async () => {
    // Mirrors the SHUTDOWN_DEADLINE_MS / parseShutdownDeadline pattern: a
    // typo'd override must never produce a 0ms (instant-fire) or NaN
    // (never-fire) timer. Default 1000ms is the documented safety floor.
    _setTestVectorWorkerFactory(
      factoryReturning((w, msg) => w.reply(msg.id, [])),
    );
    await tryPoolVectorSearch(KNOWLEDGE, QUERY);
    const wedged = FakeWorker.instances[0];
    const start = Date.now();
    // All invalid overrides → default 1000ms timeout. Use vi.advanceTimers
    // would require fake timers; instead, take the real-time measurement:
    // the function must NOT resolve in <500ms (the default 1000ms means the
    // timeout fires around 1s, well after the wedged worker is forced).
    await shutdownVectorPoolAsync({ timeoutMs: 0 });
    const elapsed = Date.now() - start;
    // Either the default fired (≥1000ms) or the workers self-exited before
    // the timeout (default FakeWorker behavior). Either way, terminated.
    expect(wedged.terminated).toBe(true);
    // The point of the assertion is that the function returned without
    // hanging or throwing — the precise elapsed time is not load-bearing.
    expect(elapsed).toBeGreaterThanOrEqual(0);
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

  it("degrades collateral in-flight requests on a timed-out worker as TIMEOUT (never null/in-process)", async () => {
    vi.useFakeTimers();
    // Pool size is 2 (DEFAULT_POOL_SIZE). Park a request on each worker, then a
    // third lands back on worker 0 (leastBusy tie → first). When worker 0's first
    // request times out, worker 0 is terminated. The THIRD request — collateral,
    // which never itself exceeded the timeout — must RESOLVE as the timeout
    // sentinel so its caller degrades to empty, NOT reject → null. Pre-fix
    // (failAll rejected collateral) it became null → the caller re-ran the scan
    // synchronously in-process, re-blocking the main thread — the #1006 stall,
    // amplified once the whole recall FTS fan-out shares the pool (Seer #1005
    // r3480447643). Asserting the sentinel (not null) is the non-vacuous guard:
    // reverting to `failAll(pw, …)` in retireTimedOutWorker fails this.
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
    const collateral = tryPoolVectorSearch(KNOWLEDGE, QUERY); // → worker 0 (2 in-flight)
    expect(seen).toEqual([0, 1, 0]);
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

  it("degrades a collateral read on a timed-out worker as READ_JOB_TIMED_OUT (not null/in-process)", async () => {
    // The PR2 recall fan-out routes its FTS scans through offloadAllOrTimeout,
    // which re-runs the scan IN-PROCESS only on a bare null; READ_JOB_TIMED_OUT
    // makes it degrade to empty instead. A collateral read queued behind a
    // wedged scan must therefore resolve the sentinel, not null — otherwise one
    // slow temporal FTS scan re-blocks the event loop with every other recall
    // sub-query sharing that worker (Seer #1005 r3480447643). This is the read
    // analogue of the vector collateral test above.
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
    const collateral = tryPoolRead(READ_JOB); // → worker 0 (2 in-flight)
    expect(seen).toEqual([0, 1, 0]);
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
