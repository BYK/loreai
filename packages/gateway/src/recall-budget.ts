import type { RecallCoverage } from "@loreai/core";
import type { GatewayUsage } from "./translate/types";

/** Finite backstop only; normal termination is time, tokens, bytes, items, or stall. */
export const MAX_RECALL_EXECUTIONS = 24;
/** Minimum budget for additional provider calls, excluding the principal turn. */
export const MAX_RECALL_CHAIN_TOKENS = 128_000;
/** Hard ceiling for additional calls even when the principal has a 1M context. */
export const MAX_RECALL_ADDITIONAL_TOKENS = 4_000_000;
export const MAX_RECALL_PRINCIPAL_TOKENS = 1_000_000;
export const MAX_RECALL_CHAIN_RESULT_BYTES = 512 * 1024;
export const MAX_RECALL_CHAIN_ITEMS = 64;
/** The formatter's configured maximum for source previews in one search. */
export const MAX_RECALL_SEARCH_ITEMS = 30;
export const RECALL_FINALIZATION_RESERVE_MS = 20_000;
export const RECALL_FINALIZATION_RESERVE_TOKENS = 4_096;
export const MAX_CONSECUTIVE_RECALL_NO_PROGRESS = 2;

export type RecallStopReason =
  | "time"
  | "tokens"
  | "result_bytes"
  | "items"
  | "stalled"
  | "execution";

type RecallBudgetOptions = {
  maxExecutions?: number;
  maxTokens?: number;
  /** Validated context window for the request's model. */
  modelContextTokens?: number;
  /** Whether the context window belongs to the effective upstream route. */
  allowExpandedContext?: boolean;
  maxResultBytes?: number;
  maxItems?: number;
  maxConsecutiveNoProgress?: number;
  /** Absolute foreground deadline. The policy reserves time for final synthesis. */
  deadlineAt?: number;
  now?: () => number;
};

/**
 * Request-owned recall ledger. It intentionally retains only counts and
 * short-lived hashed/opaque coverage keys supplied by core; it never logs or
 * exports source IDs, queries, rendered bodies, or fingerprints.
 */
export class RecallChainBudget {
  readonly maxExecutions: number;
  maxTokens: number;
  readonly maxResultBytes: number;
  readonly maxItems: number;
  readonly maxConsecutiveNoProgress: number;
  private readonly deadlineAt: number;
  private readonly now: () => number;
  private readonly modelContextTokens: number;
  private readonly deliveredCoverage = new Set<string>();
  private readonly deliveredItems = new Set<string>();
  private stop: RecallStopReason | undefined;
  private executions = 0;
  private items = 0;
  private reservedItems = 0;
  private readonly itemReservations: number[] = [];
  private resultBytes = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadInputTokens = 0;
  private cacheCreationInputTokens = 0;
  private consecutiveNoProgress = 0;
  private finalizationReserveTokens = RECALL_FINALIZATION_RESERVE_TOKENS;
  private principalRecorded = false;
  private readonly explicitMaxTokens: boolean;
  private readonly allowExpandedContext: boolean;
  private principalModel: string | undefined;
  private invalidContinuation = false;

  constructor(options: RecallBudgetOptions = {}) {
    this.maxExecutions = options.maxExecutions ?? MAX_RECALL_EXECUTIONS;
    this.maxTokens = options.maxTokens ?? MAX_RECALL_CHAIN_TOKENS;
    this.explicitMaxTokens = options.maxTokens !== undefined;
    this.allowExpandedContext =
      options.allowExpandedContext ?? options.modelContextTokens !== undefined;
    if (
      options.modelContextTokens !== undefined &&
      (!Number.isSafeInteger(options.modelContextTokens) ||
        options.modelContextTokens < 1)
    ) {
      throw new Error(
        "recall budget modelContextTokens must be a positive integer",
      );
    }
    this.modelContextTokens = Math.min(
      options.modelContextTokens ?? MAX_RECALL_PRINCIPAL_TOKENS,
      MAX_RECALL_PRINCIPAL_TOKENS,
    );
    this.maxResultBytes =
      options.maxResultBytes ?? MAX_RECALL_CHAIN_RESULT_BYTES;
    this.maxItems = options.maxItems ?? MAX_RECALL_CHAIN_ITEMS;
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

  /** Record the sunk principal turn without charging it to the recall budget. */
  recordPrincipalUsage(
    usage: Partial<GatewayUsage> | undefined,
    model: { expectedModel?: string; actualModel?: string },
    completeUsage: boolean,
  ): RecallStopReason | undefined {
    if (this.principalRecorded)
      throw new Error("recall budget principal usage already recorded");
    this.principalRecorded = true;
    if (!usage) return this.stop;
    const principalTokens =
      validTokens(usage.inputTokens) +
      validTokens(usage.outputTokens) +
      validTokens(usage.cacheReadInputTokens) +
      validTokens(usage.cacheCreationInputTokens);
    // A routed provider can answer with a different, narrower model. Only
    // matching principal identity can justify a budget above the old 128k cap.
    const matchesModel =
      completeUsage &&
      !!model.expectedModel &&
      model.expectedModel === model.actualModel;
    if (
      !Number.isSafeInteger(principalTokens) ||
      principalTokens >
        (matchesModel
          ? this.modelContextTokens
          : Math.min(this.modelContextTokens, MAX_RECALL_CHAIN_TOKENS))
    ) {
      return this.setStop("tokens");
    }
    if (matchesModel && this.allowExpandedContext && !this.explicitMaxTokens) {
      // Two productive follow-ups and a full-context final answer fit inside
      // the additional budget. Small turns keep the existing 128k floor.
      this.maxTokens = Math.min(
        MAX_RECALL_ADDITIONAL_TOKENS,
        Math.max(MAX_RECALL_CHAIN_TOKENS, 4 * principalTokens),
      );
      this.finalizationReserveTokens = Math.max(
        RECALL_FINALIZATION_RESERVE_TOKENS,
        Math.min(principalTokens, Math.floor(this.maxTokens / 4)),
      );
      this.principalModel = model.actualModel;
    } else {
      // Unverified identity or route may only spend the original combined cap.
      this.recordUsage(usage);
    }
    return this.stop;
  }

  /** Reserve the maximum source count an operation can expose. */
  admit(maxDeliveredItems = 1): RecallStopReason | undefined {
    if (this.stop) return this.stop;
    if (!Number.isSafeInteger(maxDeliveredItems) || maxDeliveredItems < 1) {
      throw new Error(
        "recall budget maxDeliveredItems must be a positive integer",
      );
    }
    if (this.now() >= this.deadlineAt) return this.setStop("time");
    if (this.totalTokens() >= this.tokenAdmissionLimit())
      return this.setStop("tokens");
    if (this.resultBytes >= this.maxResultBytes)
      return this.setStop("result_bytes");
    if (this.items + this.reservedItems + maxDeliveredItems > this.maxItems)
      return this.setStop("items");
    if (this.executions >= this.maxExecutions) return this.setStop("execution");
    this.executions++;
    this.reservedItems += maxDeliveredItems;
    this.itemReservations.push(maxDeliveredItems);
    return undefined;
  }

  /** Account each additional provider call; missing values remain conservatively zero. */
  recordUsage(
    usage: Partial<GatewayUsage> | undefined,
  ): RecallStopReason | undefined {
    if (!usage) {
      if (this.maxTokens > MAX_RECALL_CHAIN_TOKENS) this.setStop("tokens");
      return this.stop;
    }
    this.inputTokens += validTokens(usage.inputTokens);
    this.outputTokens += validTokens(usage.outputTokens);
    this.cacheReadInputTokens += validTokens(usage.cacheReadInputTokens);
    this.cacheCreationInputTokens += validTokens(
      usage.cacheCreationInputTokens,
    );
    if (!this.stop && this.totalTokens() >= this.maxTokens)
      this.setStop("tokens");
    return this.stop;
  }

  /** Never use a principal's expanded budget for a different model or unmetered call. */
  continuationModelMatches(model: string | undefined): boolean {
    return (
      this.maxTokens <= MAX_RECALL_CHAIN_TOKENS ||
      (!!model && model === this.principalModel)
    );
  }

  recordContinuationUsage(
    usage: Partial<GatewayUsage> | undefined,
    model: string | undefined,
    completeUsage: boolean,
  ): RecallStopReason | undefined {
    const stop = this.recordUsage(usage);
    const continuationTokens = usage
      ? validTokens(usage.inputTokens) +
        validTokens(usage.outputTokens) +
        validTokens(usage.cacheReadInputTokens) +
        validTokens(usage.cacheCreationInputTokens)
      : 0;
    if (
      this.maxTokens > MAX_RECALL_CHAIN_TOKENS &&
      (!this.continuationModelMatches(model) ||
        !completeUsage ||
        !Number.isSafeInteger(continuationTokens) ||
        continuationTokens > this.modelContextTokens)
    ) {
      this.invalidContinuation = true;
      return this.setStop("tokens");
    }
    return stop;
  }

  /** Account rendered bytes and delivered source coverage after execution. */
  record(input: {
    resultBytes: number;
    coverage?: readonly RecallCoverage[];
  }): RecallStopReason | undefined {
    if (!Number.isSafeInteger(input.resultBytes) || input.resultBytes < 0) {
      throw new Error(
        "recall budget resultBytes must be a non-negative integer",
      );
    }
    this.resultBytes += input.resultBytes;
    // Replace this operation's conservative reservation with the distinct
    // source identities that actually reached the model. Old adapters may not
    // provide coverage, so consume the reservation instead of undercounting.
    const reservedItems = this.itemReservations.shift() ?? 0;
    this.reservedItems = Math.max(0, this.reservedItems - reservedItems);
    let deliveredItems = input.coverage === undefined ? reservedItems : 0;
    // Older in-process adapters may not yet provide coverage. Do not infer a
    // stall from absent metadata; explicit [] remains a no-progress outcome.
    let progressed = input.coverage === undefined;
    for (const item of input.coverage ?? []) {
      // An existing source with empty content is still a useful, complete
      // answer: it establishes that no further body exists. Search previews
      // always carry a non-zero marker, so only complete detail pages qualify.
      if (
        item.length <= 0 &&
        !(item.kind === "detail" && item.complete && item.length === 0)
      ) {
        continue;
      }
      // Full details and distinct ranges/revisions each carry new coverage.
      const key = `${item.identity}\u0000${item.revision}\u0000${item.kind ?? "detail"}\u0000${item.offset}\u0000${item.length}`;
      if (!this.deliveredCoverage.has(key)) {
        this.deliveredCoverage.add(key);
        progressed = true;
      }
      const itemKey = `${item.identity}\u0000${item.revision}`;
      if (!this.deliveredItems.has(itemKey)) {
        this.deliveredItems.add(itemKey);
        deliveredItems++;
      }
    }
    this.items += deliveredItems;
    if (progressed) this.consecutiveNoProgress = 0;
    else this.consecutiveNoProgress++;

    if (!this.stop && this.now() >= this.deadlineAt) this.setStop("time");
    if (!this.stop && this.executions >= this.maxExecutions)
      this.setStop("execution");
    if (!this.stop && this.resultBytes >= this.maxResultBytes)
      this.setStop("result_bytes");
    if (!this.stop && this.items >= this.maxItems) this.setStop("items");
    if (!this.stop && this.totalTokens() >= this.maxTokens)
      this.setStop("tokens");
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

  /** A full final or recovery call may finish exactly at the ceiling, never above it. */
  exceedsTokenCeiling(): boolean {
    return this.totalTokens() > this.maxTokens;
  }

  /** A stopped chain may recover only when expanded calls were metered and fit their model. */
  canRecover(): boolean {
    return !this.invalidContinuation && !this.exceedsTokenCeiling();
  }

  snapshot(): {
    executions: number;
    items: number;
    reservedItems: number;
    resultBytes: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    consecutiveNoProgress: number;
    stopReason?: RecallStopReason;
  } {
    return {
      executions: this.executions,
      items: this.items,
      reservedItems: this.reservedItems,
      resultBytes: this.resultBytes,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadInputTokens: this.cacheReadInputTokens,
      cacheCreationInputTokens: this.cacheCreationInputTokens,
      consecutiveNoProgress: this.consecutiveNoProgress,
      ...(this.stop ? { stopReason: this.stop } : {}),
    };
  }

  private totalTokens(): number {
    return (
      this.inputTokens +
      this.outputTokens +
      this.cacheReadInputTokens +
      this.cacheCreationInputTokens
    );
  }

  private tokenAdmissionLimit(): number {
    return (
      this.maxTokens -
      Math.min(this.finalizationReserveTokens, Math.floor(this.maxTokens / 4))
    );
  }

  /** True when the next provider turn must be dedicated to final synthesis. */
  mustFinalizeNext(): boolean {
    const reserve = Math.min(
      this.finalizationReserveTokens,
      Math.floor(this.maxTokens / 4),
    );
    return (
      this.stop !== undefined ||
      this.now() >= this.deadlineAt ||
      this.totalTokens() >= this.maxTokens - 2 * reserve
    );
  }

  private setStop(reason: RecallStopReason): RecallStopReason {
    this.stop ??= reason;
    return this.stop;
  }
}

function validTokens(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;
}
