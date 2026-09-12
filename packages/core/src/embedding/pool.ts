/** Host-owned queue and pool for local embedding workers. */

import { createHash } from "node:crypto";
import { freemem } from "node:os";
import { config } from "../config";
import * as log from "../log";
import {
  EMBED_POOL_ABS_MAX,
  PER_WORKER_MEM_BUDGET_BYTES,
  clampFreeToContainerLimit,
  desiredEmbedPoolSize,
} from "../embedding-cap";
import {
  EmbeddingQueueCapacityError,
  EmbeddingRequestAbortedError,
  EmbeddingWorkerWatchdogError,
  type EmbeddingProvider,
  LocalProviderUnavailableError,
  WORKER_SHUTDOWN_TIMEOUT_MS,
  isRecallEmbed,
} from "./contract";
import {
  LocalProvider,
  clearLocalProviderLatch,
  constrainedMemoryLimit,
  localEmbeddingState,
} from "./local";
import { OwnedRetirements } from "../owned-retirements";

function configuredEmbedPoolSize(): number | undefined {
  const raw = process.env.LORE_EMBED_POOL_SIZE;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
    // invalid env → ignore, fall through to config
  }
  const cfg = config().search.embeddings.embedPoolSize;
  if (typeof cfg === "number" && Number.isFinite(cfg) && cfg >= 1) {
    return Math.floor(cfg);
  }
  return undefined;
}

/**
 * Test seam: exposes {@link configuredEmbedPoolSize} so suites can assert the env/config resolution +
 * invalid-value fall-through (invalid env must resolve to `undefined`, never `NaN`) without spinning up
 * a pool.
 */
export function _configuredEmbedPoolSize(): number | undefined {
  return configuredEmbedPoolSize();
}

function configuredBackfillCpuDuty(): number | undefined {
  const raw = process.env.LORE_BACKFILL_CPU_DUTY;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n; // clamped in resolveBackfillCpuDuty
    // invalid env → ignore, fall through to config
  }
  const cfg = config().search.embeddings.backfillCpuDuty;
  if (typeof cfg === "number" && Number.isFinite(cfg) && cfg > 0) return cfg;
  return undefined;
}

/** Test seam for the retained legacy configuration resolution. */
export function _configuredBackfillCpuDuty(): number | undefined {
  return configuredBackfillCpuDuty();
}

let testEmbedPoolSize: number | null = null;
export function _setEmbedPoolSizeForTest(n: number | null): void {
  testEmbedPoolSize = n;
}

let testPoolFreememBytes: number | null = null;
export function _setPoolFreememForTest(bytes: number | null): void {
  testPoolFreememBytes = bytes;
}

interface EmbedSlot {
  provider: LocalProvider;
  inflight: number;
  healthy: boolean;
  recoveryGeneration: number | null;
  retirement: Promise<void> | null;
}

type PoolOperationState = "queued" | "running" | "completed";

interface PoolWaiter {
  settled: boolean;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (vectors: Float32Array[]) => void;
  reject: (error: Error) => void;
}

interface PoolOperation {
  key: string;
  texts: string[];
  byteSize: number;
  inputType: "document" | "query";
  priority: "high" | "normal";
  state: PoolOperationState;
  waiters: Set<PoolWaiter>;
  retainResult?: boolean;
  vectors?: Float32Array[];
  completedAt?: number;
}

interface TokenBatchCheckpoint {
  nextIndex: number;
  vectors: Float32Array[];
  updatedAt: number;
}

const COMPLETED_EMBED_REUSE_MS = 5 * 60_000;
const MAX_COMPLETED_EMBED_RESULTS = 8;
const MAX_QUEUED_EMBED_OPERATIONS = 256;
const MAX_QUEUED_EMBED_BYTES = 8 * 1024 * 1024;
const MAX_NORMAL_QUEUED_EMBED_OPERATIONS = 240;
const MAX_NORMAL_QUEUED_EMBED_BYTES = 7 * 1024 * 1024;
const MAX_WAITERS_PER_EMBED_OPERATION = 64;
const DEFAULT_EMBED_INIT_WATCHDOG_MS = 10 * 60_000;
const DEFAULT_EMBED_EXECUTION_WATCHDOG_MS = 5 * 60_000;
let embedInitWatchdogMs = DEFAULT_EMBED_INIT_WATCHDOG_MS;
let embedExecutionWatchdogMs = DEFAULT_EMBED_EXECUTION_WATCHDOG_MS;

/** Test seam for independent worker-owned watchdogs. */
export function _setEmbeddingWorkerWatchdogsForTest(
  initMs: number | null,
  executionMs: number | null,
): void {
  embedInitWatchdogMs = initMs ?? DEFAULT_EMBED_INIT_WATCHDOG_MS;
  embedExecutionWatchdogMs = executionMs ?? DEFAULT_EMBED_EXECUTION_WATCHDOG_MS;
}

export function embeddingOperationKey(
  texts: string[],
  inputType: "document" | "query",
): string {
  const hash = createHash("sha256");
  hash.update(inputType);
  for (const value of texts) {
    hash.update("\0");
    hash.update(String(Buffer.byteLength(value)));
    hash.update(":");
    hash.update(value);
  }
  return hash.digest("hex");
}

function cloneEmbeddingVectors(vectors: Float32Array[]): Float32Array[] {
  return vectors.map((vector) => vector.slice());
}

class EmbeddingWorkerRetryCooldownError extends LocalProviderUnavailableError {
  readonly retryAt: number;

  constructor(retryAt: number) {
    super("embedding worker retry cooldown is active");
    this.name = "EmbeddingWorkerRetryCooldownError";
    this.retryAt = retryAt;
  }
}

/**
 * A pool of {@link LocalProvider} workers so concurrent embeds run in parallel instead of serializing
 * through a single worker (#999).
 */
export class EmbeddingPool implements EmbeddingProvider {
  readonly maxBatchSize = 256;

  private readonly modelId: string;
  private readonly dimensions: number;
  private readonly ceiling: number;
  private readonly slots: EmbedSlot[] = [];
  private readonly retiredWorkers = new OwnedRetirements<LocalProvider>();
  private readonly queue: PoolOperation[] = [];
  private queuedBytes = 0;
  private readonly operations = new Map<string, PoolOperation>();
  private readonly tokenBatchCheckpoints = new Map<
    string,
    TokenBatchCheckpoint
  >();
  private dispatching = false;
  private retryDispatchTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDispatchAt = 0;
  private closing = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(modelId: string, dimensions: number) {
    this.modelId = modelId;
    this.dimensions = dimensions;
    if (testEmbedPoolSize != null) {
      // Deterministic test override — bypass the memory gate entirely.
      this.ceiling = Math.max(
        1,
        Math.min(Math.floor(testEmbedPoolSize), EMBED_POOL_ABS_MAX),
      );
    } else if (process.env.NODE_ENV === "test") {
      // Keep existing single-worker suites deterministic regardless of CI RAM:
      // honor an explicit config/env ceiling (clamped like the prod branch),
      // else default to one worker.
      this.ceiling = Math.max(
        1,
        Math.min(configuredEmbedPoolSize() ?? 1, EMBED_POOL_ABS_MAX),
      );
    } else {
      this.ceiling = desiredEmbedPoolSize(
        this.liveFreemem(),
        configuredEmbedPoolSize(),
      );
    }
  }

  private pickSlot(): EmbedSlot {
    const now = Date.now();
    const healthySlots = this.slots.filter((slot) => slot.healthy);
    const terminallyUnavailable =
      localEmbeddingState.failureCause === "terminal" ||
      (localEmbeddingState.failureCause === "transient-init-exhausted" &&
        healthySlots.length === 0);
    if (this.closing || terminallyUnavailable) {
      throw new LocalProviderUnavailableError("embedding pool is unavailable");
    }
    // Primary worker: always present (its own OOM backoff, not pool sizing,
    // protects a constrained host — identical to today's single worker).
    if (this.slots.length === 0) {
      if (localEmbeddingState.initRetryAt > now) {
        throw new EmbeddingWorkerRetryCooldownError(
          localEmbeddingState.initRetryAt,
        );
      }
      // Admit exactly one recovery probe after the cooldown. The outstanding
      // failure debt below prevents pool growth until this slot succeeds.
      if (localEmbeddingState.initRetryAt > 0)
        localEmbeddingState.initRetryAt = 0;
      return this.spawnSlot(localEmbeddingState.initFailures > 0);
    }

    // During transient failure debt, route new work only to proven siblings.
    // Unproven slots may still finish their existing requests, but cannot
    // amplify a bad generation with more work or replacement spawns.
    const eligible =
      healthySlots.length > 0 &&
      (localEmbeddingState.initFailures > 0 ||
        localEmbeddingState.initRetryAt > 0 ||
        localEmbeddingState.failureCause === "transient-init-exhausted")
        ? healthySlots
        : this.slots;
    let best = eligible[0];
    for (const s of eligible) {
      if (s.inflight < best.inflight) best = s;
    }

    // Every worker is busy: add capacity only after one slot has completed a
    // real embed. Cold workers share the same HuggingFace cache; starting two
    // before either is healthy lets one read/purge the other's partial download.
    // Once bootstrap succeeds, retain the normal lazy, memory-gated growth.
    const canGrow =
      healthySlots.length > 0 &&
      best.inflight > 0 &&
      this.slots.length + this.retiredWorkers.size < this.ceiling &&
      this.liveFreemem() >= PER_WORKER_MEM_BUDGET_BYTES;
    if (canGrow) {
      if (localEmbeddingState.initRetryAt > 0) {
        if (localEmbeddingState.initRetryAt > now) return best;
        // The cooldown admits one recovery slot. Failure re-arms the next
        // backoff; success clears all transient debt.
        localEmbeddingState.initRetryAt = 0;
        return this.spawnSlot(true);
      }
      if (localEmbeddingState.initFailures === 0) return this.spawnSlot(false);
    }
    return best;
  }

  private liveFreemem(): number {
    const raw = testPoolFreememBytes != null ? testPoolFreememBytes : freemem();
    return clampFreeToContainerLimit(raw, constrainedMemoryLimit());
  }

  private spawnSlot(recoveryProbe = false): EmbedSlot {
    let slot: EmbedSlot;
    const provider = new LocalProvider(
      this.modelId,
      this.dimensions,
      this.ceiling,
      () => {
        void this.retireSlot(slot);
      },
    );
    slot = {
      // Pass the pool ceiling as the memory divisor so every worker sizes its
      // token cap from `free / ceiling`. The ceiling is itself memory-gated
      // (desiredEmbedPoolSize), so the workers the host is provisioned for
      // collectively stay within one `EMBED_MEM_FRACTION` share of free memory
      // instead of each independently claiming half and summing to an OOM.
      provider,
      inflight: 0,
      healthy: false,
      recoveryGeneration: recoveryProbe
        ? localEmbeddingState.initFailureGeneration
        : null,
      retirement: null,
    };
    this.slots.push(slot);
    return slot;
  }

  private retireSlot(slot: EmbedSlot): Promise<void> {
    if (slot.retirement) return slot.retirement;
    const index = this.slots.indexOf(slot);
    if (index === -1) return Promise.resolve();
    this.slots.splice(index, 1);
    this.preserveHealthyServiceAfterExhaustion();
    const shutdown = slot.provider.shutdown();
    void this.retiredWorkers.retireOnce(slot.provider, () => shutdown);
    const retirement = shutdown.catch(() => {});
    slot.retirement = retirement;
    void retirement.then(() => this.dispatch());
    return retirement;
  }

  private preserveHealthyServiceAfterExhaustion(): void {
    if (
      localEmbeddingState.failureCause !== "transient-init-exhausted" ||
      !this.hasHealthySlot()
    ) {
      return;
    }
    // The retry budget still stays exhausted, preventing another replacement
    // storm. Only the global FTS-only latch is invalid when a sibling works.
    clearLocalProviderLatch();
    localEmbeddingState.errorLogged = false;
  }

  private settleWaiter(
    operation: PoolOperation,
    waiter: PoolWaiter,
    outcome: { vectors: Float32Array[] } | { error: Error },
  ): void {
    if (waiter.settled) return;
    waiter.settled = true;
    operation.waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    if ("vectors" in outcome) {
      waiter.resolve(cloneEmbeddingVectors(outcome.vectors));
    } else {
      waiter.reject(outcome.error);
    }
  }

  private dropUnobservedQueuedOperation(operation: PoolOperation): void {
    if (operation.state !== "queued" || operation.waiters.size > 0) return;
    const index = this.queue.indexOf(operation);
    if (index !== -1) this.removeQueuedOperation(index);
    if (this.operations.get(operation.key) === operation) {
      this.operations.delete(operation.key);
    }
    operation.texts = [];
  }

  private attachWaiter(
    operation: PoolOperation,
    signal?: AbortSignal,
  ): Promise<Float32Array[]> {
    if (signal?.aborted) {
      return Promise.reject(new EmbeddingRequestAbortedError());
    }
    if (operation.state === "completed" && operation.vectors) {
      const vectors = cloneEmbeddingVectors(operation.vectors);
      if (this.operations.get(operation.key) === operation) {
        this.operations.delete(operation.key);
      }
      operation.vectors = undefined;
      return Promise.resolve(vectors);
    }
    if (operation.waiters.size >= MAX_WAITERS_PER_EMBED_OPERATION) {
      return Promise.reject(new EmbeddingQueueCapacityError());
    }

    return new Promise<Float32Array[]>((resolve, reject) => {
      const waiter: PoolWaiter = { settled: false, signal, resolve, reject };
      const onAbort = (): void => {
        this.settleWaiter(operation, waiter, {
          error: new EmbeddingRequestAbortedError(),
        });
        if (operation.state === "running" && operation.waiters.size === 0) {
          operation.retainResult = true;
        }
        this.dropUnobservedQueuedOperation(operation);
      };
      waiter.onAbort = onAbort;
      operation.waiters.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  private enqueueOperation(operation: PoolOperation): void {
    this.queuedBytes += operation.byteSize;
    if (operation.priority === "high") {
      let insertAt = 0;
      while (
        insertAt < this.queue.length &&
        this.queue[insertAt].priority === "high"
      ) {
        insertAt++;
      }
      this.queue.splice(insertAt, 0, operation);
      return;
    }
    this.queue.push(operation);
  }

  private removeQueuedOperation(index: number): PoolOperation | undefined {
    const [operation] = this.queue.splice(index, 1);
    if (operation) {
      this.queuedBytes = Math.max(0, this.queuedBytes - operation.byteSize);
    }
    if (this.queue.length === 0) this.clearRetryDispatchTimer();
    return operation;
  }

  private clearRetryDispatchTimer(): void {
    if (this.retryDispatchTimer) clearTimeout(this.retryDispatchTimer);
    this.retryDispatchTimer = null;
    this.retryDispatchAt = 0;
  }

  private scheduleRetryDispatch(retryAt: number): void {
    if (this.retryDispatchTimer && this.retryDispatchAt === retryAt) return;
    this.clearRetryDispatchTimer();
    this.retryDispatchAt = retryAt;
    const timer = setTimeout(
      () => {
        if (this.retryDispatchTimer !== timer) return;
        this.retryDispatchTimer = null;
        this.retryDispatchAt = 0;
        this.dispatch();
      },
      Math.max(0, retryAt - Date.now()),
    );
    this.retryDispatchTimer = timer;
  }

  private canEnqueueOperation(
    priority: PoolOperation["priority"],
    byteSize: number,
  ): boolean {
    const maxOperations =
      priority === "high"
        ? MAX_QUEUED_EMBED_OPERATIONS
        : MAX_NORMAL_QUEUED_EMBED_OPERATIONS;
    const maxBytes =
      priority === "high"
        ? MAX_QUEUED_EMBED_BYTES
        : MAX_NORMAL_QUEUED_EMBED_BYTES;
    return (
      byteSize <= maxBytes &&
      this.queue.length < maxOperations &&
      this.queuedBytes <= maxBytes - byteSize
    );
  }

  private pruneCompletedOperations(now = Date.now()): void {
    const completed: PoolOperation[] = [];
    for (const [key, operation] of this.operations) {
      if (operation.state !== "completed") continue;
      if (
        operation.completedAt === undefined ||
        now - operation.completedAt > COMPLETED_EMBED_REUSE_MS
      ) {
        this.operations.delete(key);
        operation.vectors = undefined;
      } else {
        completed.push(operation);
      }
    }
    completed.sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
    while (completed.length > MAX_COMPLETED_EMBED_RESULTS) {
      const operation = completed.shift();
      if (!operation) break;
      if (this.operations.get(operation.key) === operation) {
        this.operations.delete(operation.key);
      }
      operation.vectors = undefined;
    }
  }

  private pruneTokenBatchCheckpoints(now = Date.now()): void {
    const retained = [...this.tokenBatchCheckpoints.entries()]
      .filter(([, checkpoint]) => {
        if (now - checkpoint.updatedAt <= COMPLETED_EMBED_REUSE_MS) return true;
        checkpoint.vectors = [];
        return false;
      })
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    this.tokenBatchCheckpoints.clear();
    for (const [key, checkpoint] of retained.slice(
      -MAX_COMPLETED_EMBED_RESULTS,
    )) {
      this.tokenBatchCheckpoints.set(key, checkpoint);
    }
    for (const [, checkpoint] of retained.slice(
      0,
      -MAX_COMPLETED_EMBED_RESULTS,
    )) {
      checkpoint.vectors = [];
    }
  }

  /** Consume one interrupted call's successful prefix. */
  takeTokenBatchCheckpoint(key: string): TokenBatchCheckpoint | undefined {
    this.pruneTokenBatchCheckpoints();
    const checkpoint = this.tokenBatchCheckpoints.get(key);
    if (!checkpoint) return undefined;
    this.tokenBatchCheckpoints.delete(key);
    return {
      ...checkpoint,
      vectors: cloneEmbeddingVectors(checkpoint.vectors),
    };
  }

  /** Retain bounded progress only after an interrupted durable drain. */
  storeTokenBatchCheckpoint(
    key: string,
    nextIndex: number,
    vectors: Float32Array[],
  ): void {
    if (this.closing || nextIndex <= 0 || vectors.length !== nextIndex) return;
    this.tokenBatchCheckpoints.set(key, {
      nextIndex,
      vectors: cloneEmbeddingVectors(vectors),
      updatedAt: Date.now(),
    });
    this.pruneTokenBatchCheckpoints();
  }

  private recordSlotSuccess(slot: EmbedSlot): void {
    slot.healthy = true;
    if (
      slot.recoveryGeneration !== null &&
      slot.recoveryGeneration === localEmbeddingState.initFailureGeneration
    ) {
      slot.recoveryGeneration = null;
      if (localEmbeddingState.initFailures > 0) {
        log.info(
          `local embedding provider recovered after ${localEmbeddingState.initFailures} failed init attempt(s)`,
        );
      }
      localEmbeddingState.initFailures = 0;
      localEmbeddingState.initRetryAt = 0;
      if (localEmbeddingState.failureCause === "transient-init-exhausted") {
        clearLocalProviderLatch();
      }
      localEmbeddingState.errorLogged = false;
      return;
    }

    slot.recoveryGeneration = null;
    // An already in-flight sibling proves service is still available, but must
    // not erase another slot's retry debt or admit immediate respawns.
    this.preserveHealthyServiceAfterExhaustion();
  }

  private async runOperation(
    operation: PoolOperation,
    slot: EmbedSlot,
  ): Promise<void> {
    let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectWatchdog!: (error: Error) => void;
    const watchdog = new Promise<never>((_resolve, reject) => {
      rejectWatchdog = reject;
    });
    const armWatchdog = (
      stage: "init" | "execution",
      timeoutMs: number,
    ): void => {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      watchdogTimer = setTimeout(
        () => {
          log.error(
            `embedding worker watchdog expired: stage=${stage} timeout_ms=${timeoutMs}`,
          );
          rejectWatchdog(new EmbeddingWorkerWatchdogError(stage));
        },
        Math.max(1, timeoutMs),
      );
      watchdogTimer.unref?.();
    };
    armWatchdog("init", embedInitWatchdogMs);

    try {
      // Deliberately omit every caller's AbortSignal. The operation owns the
      // worker slot until native inference settles; callers only own waiters.
      const vectors = await Promise.race([
        slot.provider.embed(
          operation.texts,
          operation.inputType,
          undefined,
          () => armWatchdog("execution", embedExecutionWatchdogMs),
        ),
        watchdog,
      ]);
      this.recordSlotSuccess(slot);
      const retainResult =
        operation.retainResult === true && operation.waiters.size === 0;
      operation.state = "completed";
      operation.completedAt = Date.now();
      operation.vectors = retainResult
        ? cloneEmbeddingVectors(vectors)
        : undefined;
      operation.texts = [];
      for (const waiter of operation.waiters) {
        this.settleWaiter(operation, waiter, { vectors });
      }
      if (retainResult) {
        this.pruneCompletedOperations(operation.completedAt);
      } else if (this.operations.get(operation.key) === operation) {
        this.operations.delete(operation.key);
      }
    } catch (error) {
      if (this.operations.get(operation.key) === operation) {
        this.operations.delete(operation.key);
      }
      operation.texts = [];
      operation.vectors = undefined;
      const ownedError =
        error instanceof Error
          ? error
          : new Error("embedding worker operation failed");
      for (const waiter of operation.waiters) {
        this.settleWaiter(operation, waiter, { error: ownedError });
      }
      if (
        error instanceof LocalProviderUnavailableError ||
        error instanceof EmbeddingWorkerWatchdogError
      ) {
        await this.retireSlot(slot);
      }
    } finally {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      slot.inflight--;
      this.dispatch();
    }
  }

  private dispatch(): void {
    if (this.closing || this.dispatching) return;
    this.dispatching = true;
    try {
      while (this.queue.length > 0) {
        const operation = this.queue[0];
        if (operation.waiters.size === 0) {
          this.dropUnobservedQueuedOperation(operation);
          continue;
        }

        // A retiring worker still owns its native model/heap until confirmed
        // exit. Do not replace the last active slot (or exceed the ceiling via
        // pool growth) while that memory remains live. Retirement completion
        // re-enters dispatch above.
        if (this.slots.length === 0 && this.retiredWorkers.size > 0) break;

        let slot: EmbedSlot;
        try {
          slot = this.pickSlot();
        } catch (error) {
          if (error instanceof EmbeddingWorkerRetryCooldownError) {
            this.scheduleRetryDispatch(error.retryAt);
            break;
          }
          this.removeQueuedOperation(0);
          if (this.operations.get(operation.key) === operation) {
            this.operations.delete(operation.key);
          }
          const ownedError =
            error instanceof Error
              ? error
              : new LocalProviderUnavailableError();
          for (const waiter of operation.waiters) {
            this.settleWaiter(operation, waiter, { error: ownedError });
          }
          continue;
        }
        this.clearRetryDispatchTimer();
        if (slot.inflight > 0) break;

        this.removeQueuedOperation(0);
        operation.state = "running";
        slot.inflight++;
        void this.runOperation(operation, slot);
      }
    } finally {
      this.dispatching = false;
    }
  }

  embed(
    texts: string[],
    inputType: "document" | "query",
    signal?: AbortSignal,
  ): Promise<Float32Array[]> {
    if (signal?.aborted) {
      return Promise.reject(new EmbeddingRequestAbortedError());
    }
    if (this.closing) {
      return Promise.reject(
        new LocalProviderUnavailableError("embedding pool is unavailable"),
      );
    }

    this.pruneCompletedOperations();
    const ownedTexts = texts.slice();
    const key = embeddingOperationKey(ownedTexts, inputType);
    const existing = this.operations.get(key);
    if (existing) return this.attachWaiter(existing, signal);
    const priority = isRecallEmbed(ownedTexts, inputType) ? "high" : "normal";
    const byteSize = ownedTexts.reduce(
      (total, text) => total + Buffer.byteLength(text),
      0,
    );
    if (!this.canEnqueueOperation(priority, byteSize)) {
      return Promise.reject(new EmbeddingQueueCapacityError());
    }

    const operation: PoolOperation = {
      key,
      texts: ownedTexts,
      byteSize,
      inputType,
      priority,
      state: "queued",
      waiters: new Set(),
    };
    this.operations.set(key, operation);
    const result = this.attachWaiter(operation, signal);
    if (operation.waiters.size > 0) {
      this.enqueueOperation(operation);
      this.dispatch();
    }
    return result;
  }

  hasHealthySlot(): boolean {
    return this.slots.some((slot) => slot.healthy);
  }

  shutdown(timeoutMs = WORKER_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    this.clearRetryDispatchTimer();
    const shutdownError = new LocalProviderUnavailableError(
      "embedding pool shut down",
    );
    for (const operation of this.operations.values()) {
      for (const waiter of operation.waiters) {
        this.settleWaiter(operation, waiter, { error: shutdownError });
      }
      operation.texts = [];
      operation.vectors = undefined;
    }
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.operations.clear();
    for (const checkpoint of this.tokenBatchCheckpoints.values()) {
      checkpoint.vectors = [];
    }
    this.tokenBatchCheckpoints.clear();
    const providers = this.slots.splice(0).map((s) => s.provider);
    this.shutdownPromise = (async () => {
      const active = providers.map((provider) => provider.shutdown(timeoutMs));
      const outcomes = await Promise.allSettled(active);
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : [],
      );
      try {
        await this.retiredWorkers.settle({
          failureMessage: "embedding worker termination was not confirmed",
        });
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "embedding worker termination was not confirmed",
        );
      }
    })();
    return this.shutdownPromise;
  }
}
