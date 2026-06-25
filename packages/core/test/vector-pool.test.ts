import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetVectorPoolForTest,
  _setTestVectorWorkerFactory,
  shutdownVectorPool,
  tryPoolVectorSearch,
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

describe("vector-pool fallback paths (resolve null, never throw)", () => {
  it("returns null when the worker reports a per-request error", async () => {
    _setTestVectorWorkerFactory(
      factoryReturning((w, msg) => w.replyError(msg.id, "boom")),
    );
    expect(await tryPoolVectorSearch(KNOWLEDGE, QUERY)).toBeNull();
  });

  it("returns null when the worker never replies (timeout)", async () => {
    vi.useFakeTimers();
    _setTestVectorWorkerFactory(factoryReturning(() => {}));
    const p = tryPoolVectorSearch(KNOWLEDGE, QUERY);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await p).toBeNull();
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

  it("clears the timer when postMessage throws (no leaked timer)", async () => {
    // A throw in the Promise executor rejects regardless, so asserting null is
    // vacuous — the actual S2 bug is the 5 s ref'd timer left armed. Assert it
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
});
