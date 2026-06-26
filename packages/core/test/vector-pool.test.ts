import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetVectorPoolForTest,
  _setTestVectorWorkerFactory,
  shutdownVectorPool,
  tryPoolVectorSearch,
  VECTOR_SEARCH_TIMED_OUT,
  vectorSearchTimeoutMs,
} from "../src/vector-pool";
import type {
  VectorWorkerInbound,
  VectorWorkerInitData,
} from "../src/vector-worker-types";

// A deterministic stand-in for a node:worker_threads Worker. `onSearch` decides
// how the fake responds to each "search" message, so each test drives the pool
// through a specific path (result / error / timeout / death).
class FakeWorker extends EventEmitter {
  static instances: FakeWorker[] = [];
  terminated = false;
  readonly index: number;

  constructor(readonly onSearch: (w: FakeWorker, msg: { id: number }) => void) {
    super();
    this.index = FakeWorker.instances.length;
    FakeWorker.instances.push(this);
  }
  unref(): void {}
  postMessage(msg: VectorWorkerInbound): void {
    if (msg.type === "search") this.onSearch(this, msg);
  }
  terminate(): Promise<number> {
    this.terminated = true;
    this.emit("exit", 0);
    return Promise.resolve(0);
  }
  reply(id: number, hits: unknown[]): void {
    this.emit("message", { type: "result", id, hits });
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

  it.each([
    "abc",
    "",
    "  ",
    "0",
    "-5",
    "Infinity",
    "NaN",
  ])("ignores invalid/non-positive value %j and falls back to the default", (raw) => {
    // Guards the setTimeout(Infinity)/NaN foot-gun: a bad value must never
    // arm a never-firing (or immediately-firing) timer.
    process.env.LORE_VEC_SEARCH_TIMEOUT_MS = raw;
    expect(vectorSearchTimeoutMs()).toBe(DEFAULT_MS);
  });
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
    _setTestVectorWorkerFactory((() => {
      calls++;
      throw new Error("spawn failed");
    }) as never);
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
    // worker is terminated on the next ensurePool — a side effect the timeout
    // path never produces. Pre-fix mutation (init-error → no markDead): the
    // victim stays alive and this fails.
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
      w.postMessage = (() => {
        throw new Error("dead pipe");
      }) as never;
      return w;
    }) as never);
    expect(await tryPoolVectorSearch(KNOWLEDGE, QUERY)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
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
