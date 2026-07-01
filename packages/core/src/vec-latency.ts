// Vector KNN read-latency telemetry (#1065).
//
// Post the vec0 cutover (#999 / #1051) the pathological O(n) blob scan is gone,
// but we had no PRODUCTION signal proving the p50/p95 latency win on real DBs —
// only spike-bench numbers. This module records the wall-clock latency of every
// vector KNN read (the single `poolOrInProcess` chokepoint in embedding.ts) into
// a small per-cohort rolling window so the gateway can:
//   1. log a periodic p50/p95 heartbeat line (per-install visibility), and
//   2. forward each sample to Sentry as a distribution (cross-install
//      percentiles, incl. nightly).
//
// Samples are tagged by {@link VecReadMode} — the (storage layout × sqlite-vec
// availability) cohort — so a healthy vec0 host (sub-second) is separable from a
// silently degraded JS-fallback host (multi-second). That split is the whole
// point: without it we could not tell a regression (a host that fell back to JS
// brute force, or a pathological partition) from a healthy rollout.
//
// @loreai/core stays Sentry-free: the gateway registers the hook and owns the
// SDK coupling (mirrors read-telemetry.ts).

import type { VecReadMode } from "./db/vec-store";

/** One recorded vector KNN read. */
export interface VecReadLatencySample {
  /** (storage layout × vec availability) cohort the read ran under. */
  readMode: VecReadMode;
  /** Wall-clock latency of the whole read job (pool queue + IPC + KNN, or the
   *  in-process fallback scan), in milliseconds. */
  elapsedMs: number;
}

/** Rolling-window p50/p95 latency for one cohort. */
export interface VecReadLatencyStat {
  readMode: VecReadMode;
  /** Samples currently in the rolling window for this cohort. */
  count: number;
  /** Median read latency over the window, milliseconds. */
  p50: number;
  /** 95th-percentile read latency over the window, milliseconds. */
  p95: number;
}

/** Per-cohort rolling window size. Bounds memory (≤ 4 cohorts × this many
 *  numbers) and keeps the percentiles reflective of RECENT behavior rather than
 *  the whole process lifetime. */
export const VEC_LATENCY_WINDOW = 256;

const windows = new Map<VecReadMode, number[]>();
let totalRecorded = 0;
let hook: ((s: VecReadLatencySample) => void) | null = null;

/** Register a host telemetry hook fired once per recorded read. Pass null to
 *  clear. The hook must not throw; errors are swallowed. */
export function setVecReadLatencyHook(
  fn: ((s: VecReadLatencySample) => void) | null,
): void {
  hook = fn;
}

/**
 * Record one vector KNN read's latency into its cohort's rolling window and
 * fire the host hook. Non-finite / negative values are ignored so a clock
 * anomaly can never poison the percentiles. Never throws — telemetry must never
 * break the read path.
 */
export function recordVecReadLatency(
  readMode: VecReadMode,
  elapsedMs: number,
): void {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;
  let buf = windows.get(readMode);
  if (!buf) {
    buf = [];
    windows.set(readMode, buf);
  }
  buf.push(elapsedMs);
  // Ring behaviour: drop the oldest sample once the window is full.
  if (buf.length > VEC_LATENCY_WINDOW) buf.shift();
  totalRecorded++;
  const h = hook;
  if (h) {
    try {
      h({ readMode, elapsedMs });
    } catch {
      // Telemetry must never break the read path.
    }
  }
}

/** Nearest-rank percentile of an ASC-sorted array. `p` in [0, 100]. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

/**
 * Snapshot per-cohort rolling p50/p95. Cohorts with no samples are omitted.
 * Sorted by `readMode` for a stable, deterministic heartbeat line.
 */
export function vecReadLatencyStats(): VecReadLatencyStat[] {
  const out: VecReadLatencyStat[] = [];
  for (const [readMode, buf] of windows) {
    if (buf.length === 0) continue;
    const sorted = [...buf].sort((a, b) => a - b);
    out.push({
      readMode,
      count: sorted.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
    });
  }
  out.sort((a, b) => a.readMode.localeCompare(b.readMode));
  return out;
}

/**
 * Monotonic count of all reads ever recorded (across cohorts). The gateway
 * heartbeat compares this between ticks so it only logs when new reads happened
 * — no log spam during idle periods.
 */
export function vecReadLatencyTotalSamples(): number {
  return totalRecorded;
}

/**
 * Render the per-cohort rolling p50/p95 as a single heartbeat line for the
 * gateway idle log, e.g. `vec0 p50=12ms p95=45ms n=203 | degraded p50=...`.
 * Returns null when there are no samples yet (nothing to log). Latencies are
 * rounded to whole milliseconds.
 */
export function formatVecReadLatencyHeartbeat(
  stats: VecReadLatencyStat[] = vecReadLatencyStats(),
): string | null {
  if (stats.length === 0) return null;
  return stats
    .map(
      (s) =>
        `${s.readMode} p50=${Math.round(s.p50)}ms p95=${Math.round(s.p95)}ms n=${s.count}`,
    )
    .join(" | ");
}

/** Test-only: clear all windows, the total counter, and the hook. */
export function _resetVecReadLatencyForTest(): void {
  windows.clear();
  totalRecorded = 0;
  hook = null;
}
