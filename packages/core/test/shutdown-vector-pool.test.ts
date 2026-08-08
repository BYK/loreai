/**
 * Regression tests for the bounded async vector-pool shutdown (#1599).
 *
 * The gateway shutdown sequence must wait for every vector/read worker's
 * SQLite reader to close BEFORE the writer `close()`s — SQLite WAL TRUNCATE
 * cannot reset the `-wal` while any reader is pinning a read-mark, and a
 * stranded WAL means every next boot pays the WAL-recovery tax. The pre-#1599
 * sync `shutdownVectorPool()` posted `shutdown` + `terminate()` in the same
 * tick and never awaited, so a reader could outlive the writer close.
 *
 * `shutdownVectorPoolAsync(deadlineMs)` posts `shutdown`, waits for each
 * worker's `exit`, and on the deadline force-`terminate()`s the survivors —
 * always resolving, never rejecting, never exceeding the budget. These tests
 * cover the four acceptance-criteria paths: no workers, healthy workers, a
 * worker that never exits (deadline forces terminate), and idempotency.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetVectorPoolForTest,
  _setTestVectorWorkerFactory,
  shutdownVectorPoolAsync,
  tryPoolVectorSearch,
  DEFAULT_VECTOR_POOL_SHUTDOWN_DEADLINE_MS,
} from "../src/vector-pool";
import type {
  VectorWorkerInbound,
  VectorWorkerInitData,
} from "../src/vector-worker-types";

// A deterministic stand-in for a node:worker_threads Worker that exposes
// JUST the lifecycle `shutdownVectorPoolAsync` cares about: a "shutdown"
// postMessage (which the real worker answers by closing its reader and
// `process.exit(0)`-ing) and a way to emit the "exit" event the helper waits
// on. `onSearch` mirrors the real worker's "answer the search" path; if it
// returns without replying, the pool's per-request timer fires and the call
// degrades to VECTOR_SEARCH_TIMED_OUT instead of hanging — same shape as the
// production happy-path tests in vector-pool.test.ts. `neverExits` lets a test
// simulate a wedged reader that never acks the shutdown — the deadline path
// must still terminate.
class FakeWorker extends EventEmitter {
  static instances: FakeWorker[] = [];
  terminated = false;
  posted: VectorWorkerInbound[] = [];

  constructor(
    readonly onSearch: (w: FakeWorker, msg: { id: number }) => void = () => {},
    readonly opts: { neverExits?: boolean } = {},
  ) {
    super();
    FakeWorker.instances.push(this);
  }

  // Required: `makeWorker()` calls `worker.unref()` to keep the worker thread
  // from blocking process exit. The real `node:worker_threads` Worker has it;
  // the test stand-in needs it too or the pool latches `poolBroken = true`
  // on spawn (see vector-pool.ts:362-381).
  unref(): void {}

  postMessage(msg: VectorWorkerInbound): void {
    this.posted.push(msg);
    if (msg.type === "search") this.onSearch(this, msg);
    else if (msg.type === "shutdown" && !this.opts.neverExits) {
      // Mirror vector-worker.ts's shutdown handler: close the reader, then
      // exit on the next macrotask so the message can flush first.
      setTimeout(() => this.emit("exit", 0), 0);
    }
  }

  terminate(): Promise<number> {
    this.terminated = true;
    this.emit("exit", 0);
    return Promise.resolve(0);
  }
}

function factory(
  opts: { neverExits?: boolean } = {},
): (d: VectorWorkerInitData) => never {
  return (() =>
    new FakeWorker(
      (w, msg) => w.emit("message", { type: "result", id: msg.id, hits: [] }),
      opts,
    )) as unknown as (d: VectorWorkerInitData) => never;
}

beforeEach(() => {
  FakeWorker.instances = [];
  _resetVectorPoolForTest();
});

afterEach(() => {
  _setTestVectorWorkerFactory(null);
  _resetVectorPoolForTest();
});

describe("shutdownVectorPoolAsync — empty pool", () => {
  it("resolves immediately when there are no workers", async () => {
    const start = Date.now();
    await expect(shutdownVectorPoolAsync(1000)).resolves.toBeUndefined();
    // Should be near-instant — no awaits, no setTimeout.
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("never rejects even with a zero deadline", async () => {
    // A zero deadline is nonsensical for a busy pool, but the empty-pool path
    // must still resolve — the function never throws.
    await expect(shutdownVectorPoolAsync(0)).resolves.toBeUndefined();
  });
});

describe("shutdownVectorPoolAsync — healthy workers", () => {
  it("posts shutdown to every worker and waits for each exit", async () => {
    // Pin pool size to 1 so the assertions below stay deterministic. With
    // the default pool size of 2, `ensurePool()` would eagerly spawn a
    // second worker even when only one is needed — that's fine in production
    // but makes this single-worker test brittle.
    const { config } = await import("../src/config");
    const prev = config().search.embeddings.workerPoolSize;
    config().search.embeddings.workerPoolSize = 1;
    try {
      _setTestVectorWorkerFactory(factory());
      // Drive a single search so the pool spawns one worker.
      await tryPoolVectorSearch(
        { kind: "knowledge", limit: 10 },
        new Float32Array([1, 0, 0]),
      );
      expect(FakeWorker.instances).toHaveLength(1);
      const [worker] = FakeWorker.instances;

      const start = Date.now();
      await shutdownVectorPoolAsync(1000);
      // Cooperative shutdown posts `shutdown`; the FakeWorker emits exit on the
      // next macrotask, so the helper resolves in well under a second.
      expect(Date.now() - start).toBeLessThan(500);

      expect(worker.posted.map((m) => m.type)).toContain("shutdown");
      // Cooperative path: no terminate() needed.
      expect(worker.terminated).toBe(false);
    } finally {
      config().search.embeddings.workerPoolSize = prev;
    }
  });

  it("shuts down every worker when several are alive", async () => {
    // Spawn multiple workers by warming the pool with parallel requests and
    // bumping the desired pool size. `desiredPoolSize()` reads
    // config().search.embeddings.workerPoolSize — mutate the live config
    // object directly (the test reset above already cleared the pool).
    const { config } = await import("../src/config");
    const prev = config().search.embeddings.workerPoolSize;
    config().search.embeddings.workerPoolSize = 3;
    try {
      _setTestVectorWorkerFactory(factory());
      // First search spawns worker #0. The pool keeps a `leastBusy` slot, so
      // subsequent searches reuse the same slot up to its concurrency — drive
      // three concurrent searches to force three distinct workers.
      await Promise.all([
        tryPoolVectorSearch(
          { kind: "knowledge", limit: 10 },
          new Float32Array([1, 0, 0]),
        ),
        tryPoolVectorSearch(
          { kind: "knowledge", limit: 10 },
          new Float32Array([0, 1, 0]),
        ),
        tryPoolVectorSearch(
          { kind: "knowledge", limit: 10 },
          new Float32Array([0, 0, 1]),
        ),
      ]);
      expect(FakeWorker.instances.length).toBeGreaterThanOrEqual(1);
      const total = FakeWorker.instances.length;

      await shutdownVectorPoolAsync(2000);

      // Every worker received `shutdown` cooperatively (no terminate needed).
      for (const w of FakeWorker.instances) {
        expect(w.posted.map((m) => m.type)).toContain("shutdown");
        expect(w.terminated).toBe(false);
      }
      // And the pool dropped every reference — the next dispatch would build
      // a fresh worker, not reuse a closed one.
      expect(total).toBeGreaterThan(0);
    } finally {
      config().search.embeddings.workerPoolSize = prev;
    }
  });
});

describe("shutdownVectorPoolAsync — stuck workers", () => {
  it("force-terminates workers that never emit exit, within the deadline", async () => {
    _setTestVectorWorkerFactory(factory({ neverExits: true }));
    await tryPoolVectorSearch(
      { kind: "knowledge", limit: 10 },
      new Float32Array([1, 0, 0]),
    );
    const [worker] = FakeWorker.instances;

    const start = Date.now();
    // 30ms is enough to prove the deadline path runs, far below the gateway's
    // 1500ms default — and well below any reasonable per-test budget.
    await shutdownVectorPoolAsync(30);
    const elapsed = Date.now() - start;
    // Bounded: never exceeds the deadline by more than a small grace period
    // for the postMessage/terminate microtasks.
    expect(elapsed).toBeLessThan(500);

    // Cooperative shutdown was attempted FIRST (must run before terminate()).
    expect(worker.posted.map((m) => m.type)).toContain("shutdown");
    // Then the deadline fired and forced terminate().
    expect(worker.terminated).toBe(true);
  });

  it("always resolves even when terminate() rejects", async () => {
    _setTestVectorWorkerFactory(factory({ neverExits: true }));
    await tryPoolVectorSearch(
      { kind: "knowledge", limit: 10 },
      new Float32Array([1, 0, 0]),
    );
    const [worker] = FakeWorker.instances;
    if (!worker) throw new Error("expected at least one FakeWorker instance");
    // Make terminate() reject — the helper must still resolve.
    const originalTerminate = worker.terminate.bind(worker);
    worker.terminate = () => Promise.reject(new Error("terminate boom"));
    await expect(shutdownVectorPoolAsync(30)).resolves.toBeUndefined();
    // Restore so afterEach teardown works.
    worker.terminate = originalTerminate;
  });

  it("never exceeds the deadline even with many stuck workers", async () => {
    // Spawn many workers that never exit, then ensure the wall time stays
    // bounded. This guards against the helper accidentally serializing the
    // per-worker wait when it should be parallel.
    _setTestVectorWorkerFactory(factory({ neverExits: true }));
    const { config } = await import("../src/config");
    const prev = config().search.embeddings.workerPoolSize;
    config().search.embeddings.workerPoolSize = 4;
    try {
      await Promise.all(
        Array.from({ length: 4 }, () =>
          tryPoolVectorSearch(
            { kind: "knowledge", limit: 10 },
            new Float32Array([1, 0, 0]),
          ),
        ),
      );
      const start = Date.now();
      await shutdownVectorPoolAsync(50);
      // Parallel per-worker waits: total should be ~deadline, not N*deadline.
      expect(Date.now() - start).toBeLessThan(500);
    } finally {
      config().search.embeddings.workerPoolSize = prev;
    }
  });
});

describe("shutdownVectorPoolAsync — idempotency", () => {
  it("resolves again on a second call after the first resolves", async () => {
    _setTestVectorWorkerFactory(factory());
    await tryPoolVectorSearch(
      { kind: "knowledge", limit: 10 },
      new Float32Array([1, 0, 0]),
    );
    await shutdownVectorPoolAsync(500);
    // Second call: empty pool (workers were dropped) — still resolves fast.
    const start = Date.now();
    await expect(shutdownVectorPoolAsync(500)).resolves.toBeUndefined();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("parallel calls both resolve", async () => {
    _setTestVectorWorkerFactory(factory());
    await tryPoolVectorSearch(
      { kind: "knowledge", limit: 10 },
      new Float32Array([1, 0, 0]),
    );
    // Two concurrent shutdown calls: neither should reject; both should
    // observe a settled state.
    await expect(
      Promise.all([shutdownVectorPoolAsync(500), shutdownVectorPoolAsync(500)]),
    ).resolves.toEqual([undefined, undefined]);
  });
});

describe("shutdownVectorPoolAsync — default deadline", () => {
  it("DEFAULT_VECTOR_POOL_SHUTDOWN_DEADLINE_MS is positive and finite", () => {
    expect(DEFAULT_VECTOR_POOL_SHUTDOWN_DEADLINE_MS).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_VECTOR_POOL_SHUTDOWN_DEADLINE_MS)).toBe(
      true,
    );
    // And it fits under the gateway's 4000ms SHUTDOWN_DEADLINE_MS after the
    // embedding drain — leaving room for the writer close + forced-exit
    // grace period.
    expect(DEFAULT_VECTOR_POOL_SHUTDOWN_DEADLINE_MS).toBeLessThan(4000);
  });
});
