import type { RecallCoverage } from "@loreai/core";

export const RECALL_FINALIZATION_RESERVE_MS = 20_000;
export const MAX_CONSECUTIVE_RECALL_NO_PROGRESS = 2;

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
      const key = `${item.identity}\u0000${item.revision}\u0000${item.kind ?? "detail"}\u0000${item.offset}\u0000${item.length}`;
      if (!this.deliveredCoverage.has(key)) {
        this.deliveredCoverage.add(key);
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
