// Read-path timing telemetry hook (wired by the gateway to Sentry).
//
// @loreai/core stays Sentry-free; the gateway registers a hook here and forwards
// the timings to Sentry as distributions, so aggregate data across all users
// (incl. nightly installs) is visible without coupling core to a telemetry SDK.
//
// Purpose: now that the O(n) vector scan runs off-thread (#966 / #989), this
// measures how much SYNCHRONOUS main-thread time the two hot read paths still
// cost — `ltm.forSession()` (per turn) and `recall.searchRecall()` (per tool
// call) — to decide whether further offloading (FTS / hydration / scoring) is
// worth it. `syncBlockingMs = totalMs - awaitedMs`: the awaits (embed + the
// now-pool-backed vector search) are sequential, so the remainder is a faithful
// order-of-magnitude read of this call's own main-thread blocking.

import { performance } from "node:perf_hooks";

/** One read-path call's timing. All times in milliseconds. */
export interface ReadPathTiming {
  /** Which hot path. */
  op: "forSession" | "recall";
  /** Recall scope, when op === "recall". */
  scope?: string;
  /** Wall-clock duration of the whole call. */
  totalMs: number;
  /** Sum of awaited (off-thread / async) time: embed + pool vector search. */
  awaitedMs: number;
  /** totalMs - awaitedMs — approximate main-thread blocking time. */
  syncBlockingMs: number;
  /** Number of candidate rows the call scored (context for the blocking cost). */
  candidateCount: number;
}

let readPathTimingHook: ((t: ReadPathTiming) => void) | null = null;

/** Register a host telemetry hook fired after each forSession/recall call.
 *  Pass null to clear. The hook must not throw; errors are swallowed. */
export function setReadPathTimingHook(
  fn: ((t: ReadPathTiming) => void) | null,
): void {
  readPathTimingHook = fn;
}

/**
 * Accumulates awaited (suspended) time so a caller can separate off-thread waits
 * from its own synchronous main-thread work. Create one per call, wrap each
 * `await` in `t.await(promise)`, then build the timing from `t.elapsed()` and
 * `t.awaited`.
 */
export class ReadPathTimer {
  private readonly start = performance.now();
  awaited = 0;

  /** Time the suspension across one awaited promise. */
  async await<T>(p: Promise<T>): Promise<T> {
    const s = performance.now();
    try {
      return await p;
    } finally {
      this.awaited += performance.now() - s;
    }
  }

  /** Wall-clock ms since construction. */
  elapsed(): number {
    return performance.now() - this.start;
  }

  /** Fire the timing hook (no-op when unregistered). Never throws. */
  emit(op: ReadPathTiming["op"], candidateCount: number, scope?: string): void {
    const hook = readPathTimingHook;
    if (!hook) return;
    const totalMs = this.elapsed();
    try {
      hook({
        op,
        scope,
        totalMs,
        awaitedMs: this.awaited,
        syncBlockingMs: Math.max(0, totalMs - this.awaited),
        candidateCount,
      });
    } catch {
      // Telemetry must never break the read path.
    }
  }
}
