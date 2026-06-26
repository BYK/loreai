import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  offloadAll,
  offloadAllOrTimeout,
  offloadGet,
  READ_JOB_TIMED_OUT,
} from "../src/read-offload";
import {
  _resetVectorPoolForTest,
  _setTestVectorWorkerFactory,
  vectorSearchTimeoutMs,
} from "../src/vector-pool";
import type {
  VectorWorkerInbound,
  VectorWorkerInitData,
} from "../src/vector-worker-types";

// Minimal fake worker that answers "read" jobs with a fixed payload (or, when
// `hang` is set, never replies → forces a timeout), so we can prove the offload
// helpers prefer the pool result and degrade correctly.
class FakeReadWorker extends EventEmitter {
  constructor(
    private readonly payload: unknown,
    private readonly hang = false,
  ) {
    super();
  }
  unref(): void {}
  terminate(): Promise<number> {
    this.emit("exit", 0);
    return Promise.resolve(0);
  }
  postMessage(msg: VectorWorkerInbound): void {
    if (msg.type === "read" && !this.hang) {
      this.emit("message", {
        type: "read-result",
        id: msg.id,
        rows: this.payload,
      });
    }
  }
}

function poolReturning(payload: unknown): void {
  _setTestVectorWorkerFactory(
    (() => new FakeReadWorker(payload)) as unknown as (
      d: VectorWorkerInitData,
    ) => never,
  );
}

function poolHanging(): void {
  _setTestVectorWorkerFactory(
    (() => new FakeReadWorker(undefined, true)) as unknown as (
      d: VectorWorkerInitData,
    ) => never,
  );
}

beforeEach(() => {
  _resetVectorPoolForTest();
});

afterEach(() => {
  _setTestVectorWorkerFactory(null);
  _resetVectorPoolForTest();
  delete process.env.LORE_DISABLE_VEC_WORKER;
  vi.useRealTimers();
});

describe("read-offload in-process fallback (no pool)", () => {
  // With no test worker factory installed the pool is inert (NODE_ENV=test), so
  // both helpers must run the query against the real db() connection.
  it("offloadAll runs the query in-process and returns the rows", async () => {
    const rows = await offloadAll("SELECT ? AS x, ? AS y", ["hi", 7]);
    expect(rows).toEqual([{ x: "hi", y: 7 }]);
  });

  it("offloadGet runs the query in-process and returns the single row", async () => {
    const row = await offloadGet("SELECT ? AS x", ["only"]);
    expect(row).toEqual({ x: "only" });
  });

  it("falls back in-process even with LORE_DISABLE_VEC_WORKER=1 set", async () => {
    process.env.LORE_DISABLE_VEC_WORKER = "1";
    poolReturning([{ x: "should-not-be-used" }]);
    const rows = await offloadAll("SELECT ? AS x", ["real"]);
    expect(rows).toEqual([{ x: "real" }]);
  });
});

describe("read-offload pool path", () => {
  it("offloadAll returns the pool's rows, not the in-process scan", async () => {
    poolReturning([{ x: "from-pool" }]);
    // The SQL would return {x:"in-process"} if it ran on db(); the pool payload
    // proves the offloaded result is preferred.
    const rows = await offloadAll("SELECT 'in-process' AS x", []);
    expect(rows).toEqual([{ x: "from-pool" }]);
  });

  it("offloadGet returns a pool-served null as null (not re-queried)", async () => {
    // The pool ran a .get() that matched no row → null. The { rows } wrapper in
    // tryPoolRead means offloadGet returns that null directly instead of falling
    // back to the in-process query (which would have returned a row here).
    poolReturning(null);
    const row = await offloadGet("SELECT 'would-be-row' AS x", []);
    expect(row).toBeNull();
  });
});

describe("read-offload worker-timeout degradation (#1006)", () => {
  // On a worker timeout the offload helpers must DEGRADE to an empty result, NOT
  // re-run the (just-wedged) scan on the main thread. Each SQL below would
  // return a row in-process, so a non-empty result would prove a wrong fallback.
  it("offloadAll degrades to [] on timeout (does not re-run in-process)", async () => {
    vi.useFakeTimers();
    poolHanging();
    const p = offloadAll("SELECT 'in-process' AS x", []);
    await vi.advanceTimersByTimeAsync(vectorSearchTimeoutMs() + 1);
    expect(await p).toEqual([]);
  });

  it("offloadGet degrades to null on timeout (does not re-run in-process)", async () => {
    vi.useFakeTimers();
    poolHanging();
    const p = offloadGet("SELECT 'in-process' AS x", []);
    await vi.advanceTimersByTimeAsync(vectorSearchTimeoutMs() + 1);
    expect(await p).toBeNull();
  });
});

describe("offloadAllOrTimeout (surfaces the timeout instead of degrading)", () => {
  it("returns the pool rows on success", async () => {
    poolReturning([{ x: "ok" }]);
    expect(await offloadAllOrTimeout("SELECT 1", [])).toEqual([{ x: "ok" }]);
  });

  it("falls back in-process when the pool is unavailable", async () => {
    // No factory installed → pool inert → identical in-process query.
    expect(await offloadAllOrTimeout("SELECT ? AS x", ["v"])).toEqual([
      { x: "v" },
    ]);
  });

  it("surfaces READ_JOB_TIMED_OUT (NOT []) on timeout, so callers can degrade together", async () => {
    vi.useFakeTimers();
    poolHanging();
    const p = offloadAllOrTimeout("SELECT 'in-process' AS x", []);
    await vi.advanceTimersByTimeAsync(vectorSearchTimeoutMs() + 1);
    expect(await p).toBe(READ_JOB_TIMED_OUT);
  });
});
