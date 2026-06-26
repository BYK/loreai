import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureProject } from "../src/db";
import * as temporal from "../src/temporal";
import * as latReader from "../src/lat-reader";
import {
  _resetVectorPoolForTest,
  _setTestVectorWorkerFactory,
  vectorSearchTimeoutMs,
} from "../src/vector-pool";
import type {
  VectorWorkerInbound,
  VectorWorkerInitData,
} from "../src/vector-worker-types";

// These tests exercise the OFFLOAD path of the recall FTS searches — the path
// that is dead under the default test config (poolEnabled() is false unless a
// worker factory is installed; vector-pool.ts:152). Installing a factory turns
// the pool on, so `offloadAllOrTimeout` actually dispatches to a (fake) worker
// and the `if (rows === READ_JOB_TIMED_OUT) return null;` translation inside
// each runner is finally on a live code path. Without these tests that line is
// only reachable in production and a mutant deleting it survives the whole
// suite (adversarial review of PR #1012).

/** A fake read-worker. `onRead` decides the reply (or silence → a timeout).
 *  Counts every "read" message it receives so a test can prove how far the
 *  relaxed cascade got before it gave up. */
class FakeReadWorker extends EventEmitter {
  static reads = 0;
  terminated = false;
  constructor(
    private readonly onRead: (w: FakeReadWorker, id: number) => void,
  ) {
    super();
  }
  unref(): void {}
  postMessage(msg: VectorWorkerInbound): void {
    if (msg.type === "read") {
      FakeReadWorker.reads++;
      this.onRead(this, msg.id);
    }
    // "search"/"shutdown" are irrelevant to these read-only tests.
  }
  terminate(): Promise<number> {
    this.terminated = true;
    this.emit("exit", 0);
    return Promise.resolve(0);
  }
  replyRead(id: number, rows: unknown): void {
    this.emit("message", { type: "read-result", id, rows });
  }
}

function installReadFactory(
  onRead: (w: FakeReadWorker, id: number) => void,
): void {
  _setTestVectorWorkerFactory(
    (() => new FakeReadWorker(onRead)) as unknown as (
      d: VectorWorkerInitData,
    ) => never,
  );
}

const PROJECT = "/test/recall-offload-timeout";

beforeEach(() => {
  FakeReadWorker.reads = 0;
  _resetVectorPoolForTest();
});

afterEach(() => {
  _setTestVectorWorkerFactory(null);
  _resetVectorPoolForTest();
  vi.useRealTimers();
});

describe("recall FTS searches degrade on a pool read timeout (#966 B)", () => {
  it("temporal.searchScored: a worker timeout aborts the cascade and returns [] (no in-process re-run)", async () => {
    // Never reply → every dispatched read times out. With the
    // `READ_JOB_TIMED_OUT → null` guard, the FIRST timeout aborts the whole
    // relaxed cascade, so the worker is dispatched exactly ONCE. Drop/invert
    // that guard and the timeout symbol leaks into runRelaxedSearchAsync, which
    // keeps relaxing → the worker is re-dispatched for every cascade step
    // (reads > 1) — this assertion catches it.
    vi.useFakeTimers();
    installReadFactory(() => {
      /* never reply */
    });
    ensureProject(PROJECT);
    // 4 terms (> minTerms 3) so a multi-step cascade exists to re-dispatch into.
    const p = temporal.searchScored({
      projectPath: PROJECT,
      query: "alpha beta gamma delta",
    });
    // Flush enough timeouts for the cascade to fully drain EITHER way, so the
    // assertion below distinguishes "aborted after 1" from "ran every step".
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(vectorSearchTimeoutMs() + 1);
    }
    expect(await p).toEqual([]);
    expect(FakeReadWorker.reads).toBe(1);
  });

  it("latReader.searchScored: a worker timeout aborts the cascade and returns []", async () => {
    vi.useFakeTimers();
    installReadFactory(() => {
      /* never reply */
    });
    ensureProject(PROJECT);
    const p = latReader.searchScored({
      projectPath: PROJECT,
      query: "alpha beta gamma delta",
    });
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(vectorSearchTimeoutMs() + 1);
    }
    expect(await p).toEqual([]);
    expect(FakeReadWorker.reads).toBe(1);
  });

  it("temporal.searchScored: returns the worker's rows on the offload SUCCESS path", async () => {
    // The positive translation: a non-timeout reply is returned as-is (the guard
    // must NOT fire). Inverting the guard to `!== READ_JOB_TIMED_OUT` would drop
    // these rows and return [] — this catches that.
    const pid = ensureProject(PROJECT);
    const pooled = [
      {
        id: "pooled-1",
        project_id: pid,
        session_id: "s1",
        role: "user",
        content: "pooled offload row",
        tokens: 3,
        distilled: 0,
        created_at: 1,
        metadata: "{}",
        rank: -1.5,
      },
    ];
    installReadFactory((w, id) => w.replyRead(id, pooled));
    const out = await temporal.searchScored({
      projectPath: PROJECT,
      query: "alpha beta gamma delta",
    });
    expect(out).toEqual(pooled);
    // The exact-AND query already matched, so the cascade never relaxed.
    expect(FakeReadWorker.reads).toBe(1);
  });
});
