/**
 * Instrumentation for the busy-session fixture (plan §16.1): input-to-next-
 * paint, frame intervals, long tasks, parse time, queue high-water marks,
 * mounted nodes, retained memory. Browser-only observers are attached
 * defensively — a missing API is reported as `null`, never as zero.
 */

export interface MetricsReport {
  /** p95 of input → next paint, ms (`event` timing entries). */
  inputToPaintP95: number | null;
  /** Frame intervals from requestAnimationFrame, ms. */
  frames: { count: number; p95: number | null; max: number | null };
  /** `longtask` entries over 50 ms. */
  longTasks: { count: number; totalMs: number; maxMs: number | null };
  /** Time spent inside the fixture's own apply step, ms. */
  apply: { count: number; totalMs: number; p95: number | null };
  /** Pending events waiting to be applied, high-water mark. */
  queueHighWater: number;
  /** Retained bytes when `performance.memory` exists (Chromium only). */
  heapUsedBytes: number | null;
  /**
   * Replace-event payloads received so far and the characters they carried:
   * text deltas (6–42 chars) plus the larger tool-call and tool-output edits.
   */
  deltas: { count: number; chars: number; minChars: number; maxChars: number };
}

export function percentile(
  values: readonly number[],
  p: number,
): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, rank)] ?? null;
}

/** Bounded sample store: keeps the newest `limit` values. */
class Samples {
  private values: number[] = [];
  private total = 0;
  private sumAll = 0;
  private maxValue: number | null = null;
  constructor(private readonly limit = 5_000) {}
  push(value: number) {
    this.values.push(value);
    if (this.values.length > this.limit) this.values.shift();
    this.total++;
    this.sumAll += value;
    this.maxValue =
      this.maxValue === null ? value : Math.max(this.maxValue, value);
  }
  get count() {
    return this.total;
  }
  get max() {
    return this.maxValue;
  }
  p95() {
    return percentile(this.values, 95);
  }
  /** Sum over every pushed value, not just the retained window. */
  sum() {
    return this.sumAll;
  }
}

interface MemoryPerformance extends Performance {
  memory?: { usedJSHeapSize: number };
}

function heapUsed(): number | null {
  if (typeof performance === "undefined") return null;
  const memory = (performance as MemoryPerformance).memory;
  return memory ? memory.usedJSHeapSize : null;
}

export class BusyMetrics {
  private readonly inputs = new Samples();
  private readonly frames = new Samples();
  private readonly applies = new Samples();
  private longTaskCount = 0;
  private longTaskTotal = 0;
  private longTaskMax: number | null = null;
  private queueHigh = 0;
  private deltaCount = 0;
  private deltaChars = 0;
  private deltaMin = Number.POSITIVE_INFINITY;
  private deltaMax = 0;
  private observers: PerformanceObserver[] = [];
  private raf: number | null = null;
  private lastFrame: number | null = null;
  private replayedBuffer = false;

  /** Idempotent: a second `start()` replaces the observers instead of stacking them. */
  start() {
    this.stop();
    // Entries recorded before the first start (generation, first render) are
    // replayed once; a restart must not count them again.
    const buffered = !this.replayedBuffer;
    this.replayedBuffer = true;
    if (typeof PerformanceObserver !== "undefined") {
      const supported = PerformanceObserver.supportedEntryTypes;
      if (supported.includes("event")) {
        const events = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const e = entry as PerformanceEventTiming;
            // `duration` is start → next paint, in 8ms buckets.
            this.inputs.push(e.duration);
          }
        });
        // `durationThreshold` (Event Timing) is not in lib.dom yet; 16 ms
        // keeps trivially fast inputs out of the sample.
        const init: PerformanceObserverInit & { durationThreshold: number } = {
          type: "event",
          buffered,
          durationThreshold: 16,
        };
        events.observe(init);
        this.observers.push(events);
      }
      if (supported.includes("longtask")) {
        const tasks = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            this.longTaskCount++;
            this.longTaskTotal += entry.duration;
            this.longTaskMax =
              this.longTaskMax === null
                ? entry.duration
                : Math.max(this.longTaskMax, entry.duration);
          }
        });
        tasks.observe({ type: "longtask", buffered });
        this.observers.push(tasks);
      }
    }
    if (typeof requestAnimationFrame !== "undefined") {
      const frame = (now: number) => {
        if (this.lastFrame !== null) this.frames.push(now - this.lastFrame);
        this.lastFrame = now;
        this.raf = requestAnimationFrame(frame);
      };
      this.raf = requestAnimationFrame(frame);
    }
  }

  stop() {
    for (const o of this.observers) o.disconnect();
    this.observers = [];
    if (this.raf !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(this.raf);
    }
    this.raf = null;
    this.lastFrame = null;
  }

  /** Record one apply step and the queue depth it drained. */
  recordApply(ms: number, queued: number) {
    this.applies.push(ms);
    this.queueHigh = Math.max(this.queueHigh, queued);
  }

  recordDelta(chars: number) {
    this.deltaCount++;
    this.deltaChars += chars;
    this.deltaMin = Math.min(this.deltaMin, chars);
    this.deltaMax = Math.max(this.deltaMax, chars);
  }

  report(): MetricsReport {
    return {
      inputToPaintP95: this.inputs.p95(),
      frames: {
        count: this.frames.count,
        p95: this.frames.p95(),
        max: this.frames.max,
      },
      longTasks: {
        count: this.longTaskCount,
        totalMs: Math.round(this.longTaskTotal),
        maxMs: this.longTaskMax === null ? null : Math.round(this.longTaskMax),
      },
      apply: {
        count: this.applies.count,
        totalMs: Math.round(this.applies.sum()),
        p95: this.applies.p95(),
      },
      queueHighWater: this.queueHigh,
      heapUsedBytes: heapUsed(),
      deltas: {
        count: this.deltaCount,
        chars: this.deltaChars,
        minChars: this.deltaCount === 0 ? 0 : this.deltaMin,
        maxChars: this.deltaMax,
      },
    };
  }
}
