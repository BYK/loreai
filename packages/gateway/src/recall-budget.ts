import type { RecallCoverage } from "@loreai/core";

export const RECALL_FINALIZATION_RESERVE_MS = 20_000;
export const MAX_CONSECUTIVE_RECALL_NO_PROGRESS = 2;
/** One full search result, retained only to prove immediate duplicate coverage. */
export const MAX_RETAINED_RECALL_COVERAGE = 30;
/** Bound adversarial identity and revision strings in request-owned liveness state. */
export const MAX_RETAINED_RECALL_COVERAGE_KEY_CHARS = 512;

export type RecallStopReason = "time" | "stalled";

type RecallBudgetOptions = {
  maxConsecutiveNoProgress?: number;
  /** Absolute foreground deadline. Reserve time for final synthesis. */
  deadlineAt?: number;
  now?: () => number;
};

/**
 * Request-owned recall liveness ledger. Productive recall never stops because
 * of an arbitrary count or cumulative quota. Only the request deadline and a
 * proven lack of new source coverage force the next provider turn to finalize.
 */
export class RecallChainBudget {
  readonly maxConsecutiveNoProgress: number;
  private readonly deadlineAt: number;
  private readonly now: () => number;
  private readonly deliveredCoverage = new Set<string>();
  private stop: RecallStopReason | undefined;
  private consecutiveNoProgress = 0;

  constructor(options: RecallBudgetOptions = {}) {
    this.maxConsecutiveNoProgress =
      options.maxConsecutiveNoProgress ?? MAX_CONSECUTIVE_RECALL_NO_PROGRESS;
    this.now = options.now ?? Date.now;
    const startedAt = this.now();
    this.deadlineAt =
      options.deadlineAt === undefined
        ? startedAt + 300_000 - RECALL_FINALIZATION_RESERVE_MS
        : Math.max(
            startedAt,
            options.deadlineAt - RECALL_FINALIZATION_RESERVE_MS,
          );
  }

  /** Check liveness before starting another recall operation. */
  admit(): RecallStopReason | undefined {
    if (this.stop) return this.stop;
    if (this.now() >= this.deadlineAt) return this.setStop("time");
    return undefined;
  }

  /** Track whether an executed recall delivered new source coverage. */
  record(coverage?: readonly RecallCoverage[]): RecallStopReason | undefined {
    // Older in-process adapters may not provide coverage. Never infer a stall
    // when the gateway cannot prove that the operation made no progress.
    let progressed = coverage === undefined;
    for (const item of coverage ?? []) {
      // An existing source with empty content is still useful only when a
      // complete detail lookup proves that no body exists.
      if (
        item.length <= 0 &&
        !(item.kind === "detail" && item.complete && item.length === 0)
      ) {
        continue;
      }
      const kind = item.kind ?? "detail";
      const offset = String(item.offset);
      const length = String(item.length);
      const keyLength =
        item.identity.length +
        item.revision.length +
        kind.length +
        offset.length +
        length.length +
        4;
      if (keyLength > MAX_RETAINED_RECALL_COVERAGE_KEY_CHARS) {
        progressed = true;
        continue;
      }
      const key = `${item.identity}\u0000${item.revision}\u0000${kind}\u0000${offset}\u0000${length}`;
      if (!this.deliveredCoverage.has(key)) {
        this.deliveredCoverage.add(key);
        // Bound liveness state without turning eviction into proof of a stall.
        if (this.deliveredCoverage.size > MAX_RETAINED_RECALL_COVERAGE) {
          const oldest = this.deliveredCoverage.values().next();
          if (!oldest.done) this.deliveredCoverage.delete(oldest.value);
        }
        progressed = true;
      }
    }
    if (progressed) this.consecutiveNoProgress = 0;
    else this.consecutiveNoProgress++;

    if (!this.stop && this.now() >= this.deadlineAt) this.setStop("time");
    if (
      !this.stop &&
      this.consecutiveNoProgress > this.maxConsecutiveNoProgress
    ) {
      this.setStop("stalled");
    }
    return this.stop;
  }

  stopReason(): RecallStopReason | undefined {
    return this.stop;
  }

  snapshot(): {
    consecutiveNoProgress: number;
    stopReason?: RecallStopReason;
  } {
    return {
      consecutiveNoProgress: this.consecutiveNoProgress,
      ...(this.stop ? { stopReason: this.stop } : {}),
    };
  }

  /** True when the next provider turn must be dedicated to final synthesis. */
  mustFinalizeNext(): boolean {
    return this.stop !== undefined || this.now() >= this.deadlineAt;
  }

  private setStop(reason: RecallStopReason): RecallStopReason {
    this.stop ??= reason;
    return this.stop;
  }
}
