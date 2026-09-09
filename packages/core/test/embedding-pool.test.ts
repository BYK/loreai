import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import {
  embed,
  embedInTokenBatches,
  EmbeddingQueueCapacityError,
  EmbeddingRequestAbortedError,
  EmbeddingWorkerWatchdogError,
  ensureEmbeddingReady,
  isAvailable,
  LocalProviderUnavailableError,
  recallEmbedsInFlight,
  resetProvider,
  _configuredEmbedPoolSize,
  _getLocalInitRetryAtForTest,
  _resetLocalProviderProbe,
  _restoreProvider,
  _saveAndClearProvider,
  _setConstrainedMemoryForTest,
  _setEmbedPoolSizeForTest,
  _setEmbeddingWorkerWatchdogsForTest,
  _setLocalInitCooldownMsForTest,
  _setLocalInitRetryAtForTest,
  _setPoolFreememForTest,
  _setRecallEmbedsInFlightForTest,
  _setTestWorkerFactory,
} from "../src/embedding";

// Exercises the EmbeddingPool cross-worker dispatch (#999): least-busy routing,
// lazy + memory-gated growth, the broken-provider latch, and pool shutdown. A
// controllable fake worker (via the _setTestWorkerFactory seam) lets us hold a
// worker "busy" and observe which worker each embed lands on, without a real
// ONNX runtime. The per-worker OOM/self-heal lifecycle is covered separately in
// embedding-oom-recovery.test.ts (this file never touches it).

const GB = 1024 * 1024 * 1024;

/** Controllable stand-in for a node:worker_threads Worker. Records the ids of
 *  embed requests posted to it and only completes them when the test says so. */
class FakeWorker extends EventEmitter {
  readonly embedIds: number[] = [];
  embedPostCount = 0;
  gotShutdown = false;
  terminated = false;
  exitOnShutdown = true;
  throwOnNextEmbed = false;

  postMessage(msg: unknown): void {
    const m = msg as { type: string; id?: number };
    if (m.type === "embed" && typeof m.id === "number") {
      if (this.throwOnNextEmbed) {
        this.throwOnNextEmbed = false;
        throw new Error("worker died before postMessage");
      }
      this.embedPostCount++;
      this.embedIds.push(m.id);
    } else if (m.type === "shutdown") {
      this.gotShutdown = true;
      // A real worker drains + exits; mirror that so awaitWorkerShutdown resolves.
      if (this.exitOnShutdown) this.emit("exit", 0);
    }
  }
  ref(): void {}
  unref(): void {}
  terminate(): Promise<number> {
    this.terminated = true;
    this.emit("exit", 0);
    return Promise.resolve(0);
  }

  /** Resolve every embed request posted so far. */
  completeAll(): void {
    for (const id of this.embedIds.splice(0)) {
      this.emit("message", {
        type: "result",
        id,
        vectors: [new Float32Array([1, 0, 0])],
      });
    }
  }

  /** Resolve the oldest embed request posted so far. */
  completeNext(): void {
    const id = this.embedIds.shift();
    if (id === undefined) return;
    this.emit("message", {
      type: "result",
      id,
      vectors: [new Float32Array([1, 0, 0])],
    });
  }

  /** Mark the oldest posted request as entering tokenization/inference. */
  startNext(): void {
    const id = this.embedIds[0];
    if (id === undefined) return;
    this.emit("message", { type: "started", id });
  }

  /** Simulate a fatal model-init failure (permanent per-provider break). */
  initError(error = "model load failed"): void {
    this.emit("message", { type: "init-error", error });
  }

  crash(error = "worker crashed"): void {
    this.emit("error", new Error(error));
  }

  exit(): void {
    this.emit("exit", 0);
  }
}

/** Install the factory and collect every fake worker it hands out. */
function installFakeWorkers(
  onCreate?: (worker: FakeWorker, index: number) => void,
): FakeWorker[] {
  const fakes: FakeWorker[] = [];
  _setTestWorkerFactory(() => {
    const f = new FakeWorker();
    fakes.push(f);
    onCreate?.(f, fakes.length - 1);
    return f as unknown as Worker;
  });
  return fakes;
}

/** Flush the async ensureWorker (dynamic import) → postMessage chain. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** Attach handlers immediately so an expected rejection isn't flagged unhandled. */
function settle<T>(
  p: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; err: unknown }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (err) => ({ ok: false as const, err }),
  );
}

async function warmPool(fakes: FakeWorker[]): Promise<void> {
  const warm = embed(["bootstrap"], "document");
  await flush();
  expect(fakes).toHaveLength(1);
  fakes[0].completeAll();
  await warm;
}

describe("EmbeddingPool dispatch (#999)", () => {
  let savedProvider: unknown;
  let savedVoyage: string | undefined;
  let savedOpenAI: string | undefined;
  let savedPoolEnv: string | undefined;
  let savedNodeEnv: string | undefined;

  beforeEach(() => {
    // Force the local provider (no remote fallback) and a fresh instance.
    savedVoyage = process.env.VOYAGE_API_KEY;
    savedOpenAI = process.env.OPENAI_API_KEY;
    savedPoolEnv = process.env.LORE_EMBED_POOL_SIZE;
    savedNodeEnv = process.env.NODE_ENV;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.LORE_EMBED_POOL_SIZE;
    // Neutralize any real cgroup limit on the CI box so the _setPoolFreememForTest
    // injections drive the live gate deterministically (the clamp is a no-op at
    // limit 0). The container-aware test below opts back in explicitly.
    _setConstrainedMemoryForTest(0);
    _resetLocalProviderProbe();
    savedProvider = _saveAndClearProvider();
  });

  afterEach(() => {
    _setTestWorkerFactory(null);
    _setEmbedPoolSizeForTest(null);
    _setEmbeddingWorkerWatchdogsForTest(null, null);
    _setLocalInitCooldownMsForTest(null);
    _setPoolFreememForTest(null);
    _setConstrainedMemoryForTest(null);
    _setRecallEmbedsInFlightForTest(0); // defensive: don't leak a stuck count
    _resetLocalProviderProbe();
    _restoreProvider(savedProvider);
    if (savedVoyage !== undefined) process.env.VOYAGE_API_KEY = savedVoyage;
    if (savedOpenAI !== undefined) process.env.OPENAI_API_KEY = savedOpenAI;
    if (savedPoolEnv !== undefined)
      process.env.LORE_EMBED_POOL_SIZE = savedPoolEnv;
    else delete process.env.LORE_EMBED_POOL_SIZE;
    // Restore NODE_ENV (a couple of tests flip it to exercise the production path).
    if (savedNodeEnv !== undefined) process.env.NODE_ENV = savedNodeEnv;
    else delete process.env.NODE_ENV;
  });

  it("serializes cold bootstrap before enabling parallel dispatch", async () => {
    _setEmbedPoolSizeForTest(2);
    _setPoolFreememForTest(64 * GB); // ample → growth allowed
    const fakes = installFakeWorkers();

    const p1 = embed(["alpha"], "query");
    const p2 = embed(["beta"], "query");
    await flush();

    // Until a real result proves model readiness, only one native batch is
    // dispatched so sibling initializers cannot race the shared model cache.
    expect(fakes).toHaveLength(1);
    expect(fakes[0].embedIds).toHaveLength(1);

    fakes[0].completeNext();
    expect(await p1).toHaveLength(1);
    await flush();
    expect(fakes[0].embedIds).toHaveLength(1);
    fakes[0].completeNext();
    expect(await p2).toHaveLength(1);

    // After bootstrap, genuine concurrent demand grows the pool as before.
    const p3 = embed(["gamma"], "query");
    const p4 = embed(["delta"], "query");
    await flush();
    expect(fakes).toHaveLength(2);
    expect(fakes[0].embedIds).toHaveLength(1);
    expect(fakes[1].embedIds).toHaveLength(1);
    fakes[0].completeAll();
    fakes[1].completeAll();
    expect(await p3).toHaveLength(1);
    expect(await p4).toHaveLength(1);
  });

  it("does not spawn a second worker for sequential (non-concurrent) embeds", async () => {
    _setEmbedPoolSizeForTest(2);
    _setPoolFreememForTest(64 * GB);
    const fakes = installFakeWorkers();

    const p1 = embed(["alpha"], "query");
    await flush();
    expect(fakes).toHaveLength(1);
    fakes[0].completeAll();
    expect(await p1).toHaveLength(1);

    // Worker 0 is now idle → the next embed reuses it; no second model loads.
    const p2 = embed(["beta"], "query");
    await flush();
    expect(fakes).toHaveLength(1);
    fakes[0].completeAll();
    expect(await p2).toHaveLength(1);
  });

  it("removes a cancelled queued request without restarting its worker", async () => {
    _setEmbedPoolSizeForTest(1);
    _setPoolFreememForTest(64 * GB);
    const fakes = installFakeWorkers();
    await warmPool(fakes);

    const blocked = embed(["blocked"], "document");
    const abort = new AbortController();
    const cancelled = settle(embed(["cancelled"], "document", abort.signal));
    await flush();
    expect(fakes).toHaveLength(1);
    expect(fakes[0].embedIds).toHaveLength(1);

    abort.abort();
    const outcome = await cancelled;
    expect(outcome).toEqual({
      ok: false,
      err: expect.any(EmbeddingRequestAbortedError),
    });
    expect(fakes[0].gotShutdown).toBe(false);

    fakes[0].completeNext();
    await expect(blocked).resolves.toHaveLength(1);

    const reused = embed(["reused"], "document");
    await flush();
    expect(fakes).toHaveLength(1);
    expect(fakes[0].embedIds).toHaveLength(1);
    fakes[0].completeNext();
    await expect(reused).resolves.toHaveLength(1);
  });

  it("settles an executing caller without releasing capacity or restarting the worker", async () => {
    _setEmbedPoolSizeForTest(1);
    const fakes = installFakeWorkers();
    await warmPool(fakes);

    const abort = new AbortController();
    const cancelled = settle(embed(["executing"], "document", abort.signal));
    const queued = embed(["queued"], "document");
    await flush();
    expect(fakes[0].embedIds).toHaveLength(1);

    abort.abort();
    await expect(cancelled).resolves.toEqual({
      ok: false,
      err: expect.any(EmbeddingRequestAbortedError),
    });
    expect(fakes[0].gotShutdown).toBe(false);
    expect(fakes[0].embedIds).toHaveLength(1);

    fakes[0].completeNext();
    await flush();
    expect(fakes[0].embedIds).toHaveLength(1);
    fakes[0].completeNext();
    await expect(queued).resolves.toHaveLength(1);
  });

  it("detaches a cold initialization waiter while initialization continues", async () => {
    _setEmbedPoolSizeForTest(1);
    const fakes = installFakeWorkers();
    const abort = new AbortController();
    const cancelled = settle(embed(["cold first"], "document", abort.signal));
    const remaining = embed(["cold second"], "document");
    await flush();
    expect(fakes).toHaveLength(1);
    expect(fakes[0].embedIds).toHaveLength(1);

    abort.abort();
    await expect(cancelled).resolves.toEqual({
      ok: false,
      err: expect.any(EmbeddingRequestAbortedError),
    });
    expect(fakes[0].gotShutdown).toBe(false);

    fakes[0].completeNext();
    await flush();
    expect(fakes[0].embedIds).toHaveLength(1);
    fakes[0].completeNext();
    await expect(remaining).resolves.toHaveLength(1);
    expect(fakes).toHaveLength(1);
  });

  it("reattaches an identical retry to abandoned execution instead of duplicating inference", async () => {
    _setEmbedPoolSizeForTest(1);
    const fakes = installFakeWorkers();
    await warmPool(fakes);

    const abort = new AbortController();
    const first = settle(
      embed(["same durable input"], "document", abort.signal),
    );
    await flush();
    expect(fakes[0].embedIds).toHaveLength(1);

    abort.abort();
    await first;
    const retry = embed(["same durable input"], "document");
    await flush();
    expect(fakes[0].embedIds).toHaveLength(1);

    fakes[0].completeNext();
    await expect(retry).resolves.toHaveLength(1);
    expect(fakes[0].gotShutdown).toBe(false);
  });

  it("resumes a token-batched retry without restarting its completed prefix", async () => {
    _setEmbedPoolSizeForTest(1);
    const fakes = installFakeWorkers();
    await warmPool(fakes);
    const baselinePosts = fakes[0].embedPostCount;
    const texts = ["a".repeat(9_000), "b".repeat(9_000)];
    const abort = new AbortController();
    const first = settle(embedInTokenBatches(texts, "document", abort.signal));

    await flush();
    expect(fakes[0].embedPostCount).toBe(baselinePosts + 1);
    fakes[0].completeNext();
    await flush();
    expect(fakes[0].embedPostCount).toBe(baselinePosts + 2);

    abort.abort();
    await expect(first).resolves.toEqual({
      ok: false,
      err: expect.any(EmbeddingRequestAbortedError),
    });
    const retrySignal = new AbortController();
    const retry = embedInTokenBatches(texts, "document", retrySignal.signal);
    await flush();
    expect(fakes[0].embedPostCount).toBe(baselinePosts + 2);

    fakes[0].completeNext();
    await expect(retry).resolves.toHaveLength(2);
    expect(fakes[0].embedPostCount).toBe(baselinePosts + 2);
  });

  it("removes a queued token batch when its caller cancels", async () => {
    _setEmbedPoolSizeForTest(1);
    const fakes = installFakeWorkers();
    await warmPool(fakes);
    const baselinePosts = fakes[0].embedPostCount;

    const blocked = embed(["occupy worker"], "document");
    await flush();
    expect(fakes[0].embedPostCount).toBe(baselinePosts + 1);

    const abort = new AbortController();
    const cancelled = settle(
      embedInTokenBatches(["x".repeat(9_000)], "document", abort.signal),
    );
    await flush();
    expect(fakes[0].embedPostCount).toBe(baselinePosts + 1);

    abort.abort();
    await expect(cancelled).resolves.toEqual({
      ok: false,
      err: expect.any(EmbeddingRequestAbortedError),
    });

    fakes[0].completeNext();
    await blocked;
    await flush();
    expect(fakes[0].embedPostCount).toBe(baselinePosts + 1);
  });

  it("bounds queued operations while reserving capacity for recall", async () => {
    _setEmbedPoolSizeForTest(1);
    const fakes = installFakeWorkers();
    await warmPool(fakes);

    const blocked = embed(["occupy bounded queue worker"], "document");
    await flush();
    const controllers = Array.from(
      { length: 240 },
      () => new AbortController(),
    );
    const queued = controllers.map((controller, index) =>
      settle(embed([`normal-queued-${index}`], "document", controller.signal)),
    );
    await flush();

    await expect(embed(["normal-overflow"], "document")).rejects.toBeInstanceOf(
      EmbeddingQueueCapacityError,
    );

    // The normal-work ceiling leaves 16 hard-cap slots for recall, even when
    // background document work has saturated its allocation.
    const recallControllers = Array.from(
      { length: 16 },
      () => new AbortController(),
    );
    const recalls = recallControllers.map((controller, index) =>
      settle(
        embed(
          [`latency-sensitive-recall-${index}`],
          "query",
          controller.signal,
        ),
      ),
    );
    await flush();
    await expect(embed(["hard-cap-overflow"], "query")).rejects.toBeInstanceOf(
      EmbeddingQueueCapacityError,
    );

    for (const controller of recallControllers) controller.abort();
    for (const controller of controllers) controller.abort();
    const outcomes = await Promise.all([...queued, ...recalls]);
    expect(outcomes.every((outcome) => !outcome.ok)).toBe(true);
    fakes[0].completeNext();
    await blocked;
  });

  it("bounds identical waiters and reopens admission after one cancels", async () => {
    _setEmbedPoolSizeForTest(1);
    const fakes = installFakeWorkers();
    await warmPool(fakes);
    const baselinePosts = fakes[0].embedPostCount;
    const controllers = Array.from({ length: 64 }, () => new AbortController());
    const waiters = controllers.map((controller) =>
      settle(embed(["identical flood"], "document", controller.signal)),
    );
    await flush();

    await expect(embed(["identical flood"], "document")).rejects.toBeInstanceOf(
      EmbeddingQueueCapacityError,
    );
    expect(fakes[0].embedPostCount).toBe(baselinePosts + 1);

    controllers[0].abort();
    await expect(waiters[0]).resolves.toEqual({
      ok: false,
      err: expect.any(EmbeddingRequestAbortedError),
    });
    const replacementController = new AbortController();
    const replacement = settle(
      embed(["identical flood"], "document", replacementController.signal),
    );
    replacementController.abort();
    for (const controller of controllers.slice(1)) controller.abort();
    const outcomes = await Promise.all([...waiters.slice(1), replacement]);
    expect(outcomes.every((outcome) => !outcome.ok)).toBe(true);

    fakes[0].completeNext();
    await flush();
    expect(fakes[0].embedPostCount).toBe(baselinePosts + 1);
  });

  it("reopens cumulative queued-byte capacity after cancellation", async () => {
    _setEmbedPoolSizeForTest(1);
    const fakes = installFakeWorkers();
    await warmPool(fakes);
    const baselinePosts = fakes[0].embedPostCount;
    const blocked = embed(["occupy byte-bounded queue worker"], "document");
    await flush();
    const firstText = "a".repeat(4 * 1024 * 1024);
    const secondText = "b".repeat(4 * 1024 * 1024);
    const firstController = new AbortController();
    const first = settle(
      embed([firstText], "document", firstController.signal),
    );
    await flush();

    // Each request is below 7 MiB, but their cumulative queued bytes are not.
    await expect(embed([secondText], "document")).rejects.toBeInstanceOf(
      EmbeddingQueueCapacityError,
    );

    firstController.abort();
    await expect(first).resolves.toEqual({
      ok: false,
      err: expect.any(EmbeddingRequestAbortedError),
    });

    const secondController = new AbortController();
    const second = settle(
      embed([secondText], "document", secondController.signal),
    );
    await flush();
    secondController.abort();
    await expect(second).resolves.toEqual({
      ok: false,
      err: expect.any(EmbeddingRequestAbortedError),
    });

    expect(fakes[0].embedPostCount).toBe(baselinePosts + 1);
    fakes[0].completeNext();
    await blocked;
  });

  it("enforces the hard queued-byte cap across normal and recall work", async () => {
    _setEmbedPoolSizeForTest(1);
    const fakes = installFakeWorkers();
    await warmPool(fakes);
    const blocked = embed(["occupy hard-byte-cap worker"], "document");
    await flush();

    const normalController = new AbortController();
    const normal = settle(
      embed(
        ["n".repeat(7 * 1024 * 1024 - 256 * 1024)],
        "document",
        normalController.signal,
      ),
    );
    const firstRecallController = new AbortController();
    const firstRecall = settle(
      embed(["q".repeat(1024 * 1024)], "query", firstRecallController.signal),
    );
    await flush();

    const secondRecallText = "r".repeat(512 * 1024);
    await expect(embed([secondRecallText], "query")).rejects.toBeInstanceOf(
      EmbeddingQueueCapacityError,
    );

    firstRecallController.abort();
    await expect(firstRecall).resolves.toEqual({
      ok: false,
      err: expect.any(EmbeddingRequestAbortedError),
    });
    const replacementController = new AbortController();
    const replacement = settle(
      embed([secondRecallText], "query", replacementController.signal),
    );
    replacementController.abort();
    normalController.abort();
    const outcomes = await Promise.all([normal, replacement]);
    expect(outcomes.every((outcome) => !outcome.ok)).toBe(true);

    fakes[0].completeNext();
    await blocked;
  });

  it("reuses a completed orphan result when a durable retry arrives", async () => {
    _setEmbedPoolSizeForTest(1);
    const fakes = installFakeWorkers();
    await warmPool(fakes);

    const abort = new AbortController();
    const first = settle(
      embed(["late durable result"], "document", abort.signal),
    );
    await flush();
    abort.abort();
    await first;

    fakes[0].completeNext();
    await flush();
    expect(fakes[0].embedIds).toHaveLength(0);

    await expect(
      embed(["late durable result"], "document"),
    ).resolves.toHaveLength(1);
    expect(fakes[0].embedIds).toHaveLength(0);
    expect(fakes[0].gotShutdown).toBe(false);
  });

  it("cancels one coalesced waiter without cancelling the shared operation", async () => {
    _setEmbedPoolSizeForTest(1);
    const fakes = installFakeWorkers();
    await warmPool(fakes);

    const abort = new AbortController();
    const cancelled = settle(embed(["shared"], "document", abort.signal));
    const remaining = embed(["shared"], "document");
    await flush();
    expect(fakes[0].embedIds).toHaveLength(1);

    abort.abort();
    await expect(cancelled).resolves.toEqual({
      ok: false,
      err: expect.any(EmbeddingRequestAbortedError),
    });
    fakes[0].completeNext();
    await expect(remaining).resolves.toHaveLength(1);
    expect(fakes[0].gotShutdown).toBe(false);
  });

  it("already-aborted input creates no worker", async () => {
    _setEmbedPoolSizeForTest(1);
    const fakes = installFakeWorkers();
    const abort = new AbortController();
    abort.abort();

    await expect(
      embed(["cancelled"], "document", abort.signal),
    ).rejects.toBeInstanceOf(EmbeddingRequestAbortedError);
    await flush();
    expect(fakes).toHaveLength(0);
  });

  it("retires and replaces a worker whose initialization watchdog expires", async () => {
    _setEmbedPoolSizeForTest(1);
    _setEmbeddingWorkerWatchdogsForTest(10, 60_000);
    const fakes = installFakeWorkers();

    await expect(embed(["stuck init"], "document")).rejects.toMatchObject({
      name: "EmbeddingWorkerWatchdogError",
      stage: "init",
    } satisfies Partial<EmbeddingWorkerWatchdogError>);
    expect(fakes[0].gotShutdown).toBe(true);

    const recovered = embed(["fresh worker"], "document");
    await flush();
    expect(fakes).toHaveLength(2);
    fakes[1].completeNext();
    await expect(recovered).resolves.toHaveLength(1);
  });

  it("uses a separate execution watchdog after worker start", async () => {
    _setEmbedPoolSizeForTest(1);
    _setEmbeddingWorkerWatchdogsForTest(60_000, 10);
    const fakes = installFakeWorkers();

    const stuck = embed(["stuck inference"], "document");
    await flush();
    fakes[0].startNext();
    await expect(stuck).rejects.toMatchObject({
      name: "EmbeddingWorkerWatchdogError",
      stage: "execution",
    } satisfies Partial<EmbeddingWorkerWatchdogError>);
    expect(fakes[0].gotShutdown).toBe(true);
  });

  it("counts a retiring worker against the capacity ceiling until exit", async () => {
    _setEmbedPoolSizeForTest(2);
    _setPoolFreememForTest(64 * GB);
    _setEmbeddingWorkerWatchdogsForTest(60_000, 10);
    const fakes = installFakeWorkers();
    await warmPool(fakes);

    const healthy = embed(["healthy sibling"], "document");
    const stuck = settle(embed(["stuck sibling"], "document"));
    await flush();
    expect(fakes).toHaveLength(2);
    fakes[1].exitOnShutdown = false;
    fakes[1].startNext();
    await expect(stuck).resolves.toMatchObject({
      ok: false,
      err: { name: "EmbeddingWorkerWatchdogError", stage: "execution" },
    });
    expect(fakes[1].gotShutdown).toBe(true);

    const firstQueued = embed(["first queued"], "document");
    const secondQueued = embed(["second queued"], "document");
    fakes[0].completeNext();
    await expect(healthy).resolves.toHaveLength(1);
    await flush();

    // The surviving slot accepts one job, but the retiring model prevents a
    // replacement from temporarily becoming a third resident worker.
    expect(fakes).toHaveLength(2);
    expect(fakes[0].embedIds).toHaveLength(1);

    fakes[1].exit();
    await flush();
    expect(fakes).toHaveLength(3);
    expect(fakes[2].embedIds).toHaveLength(1);
    fakes[0].completeNext();
    fakes[2].completeNext();
    await Promise.all([firstQueued, secondQueued]);
  });

  it("normalizes an initialization watchdog at the readiness boundary", async () => {
    _setEmbedPoolSizeForTest(1);
    _setEmbeddingWorkerWatchdogsForTest(10, 60_000);
    installFakeWorkers();

    const outcome = await settle(ensureEmbeddingReady({ deadlineMs: 1_000 }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.err).toBeInstanceOf(LocalProviderUnavailableError);
      expect(outcome.err).not.toBeInstanceOf(EmbeddingWorkerWatchdogError);
      expect((outcome.err as Error & { cause?: unknown }).cause).toMatchObject({
        name: "EmbeddingWorkerWatchdogError",
        stage: "init",
      });
    }
  });

  it("stays at a single worker under concurrency when memory is tight", async () => {
    _setEmbedPoolSizeForTest(2); // ceiling allows 2...
    _setPoolFreememForTest(0); // ...but no memory for a second ~680MB model
    const fakes = installFakeWorkers();

    const p1 = embed(["alpha"], "query");
    const p2 = embed(["beta"], "query");
    await flush();

    // The second request remains host-queued behind the one native batch.
    expect(fakes).toHaveLength(1);
    expect(fakes[0].embedIds).toHaveLength(1);

    fakes[0].completeNext();
    expect(await p1).toHaveLength(1);
    await flush();
    expect(fakes[0].embedIds).toHaveLength(1);
    fakes[0].completeNext();
    expect(await p2).toHaveLength(1);
  });

  it("stays at a single worker when the cgroup limit can't fit a second (container-aware)", async () => {
    // The regression that OOM-killed Aditya's Railway container: host freemem is
    // huge (os.freemem() is cgroup-blind) so the old gate would spawn a second
    // native-ONNX worker and blow past the container's memory.max → SIGKILL.
    _setEmbedPoolSizeForTest(2); // ceiling allows 2...
    _setPoolFreememForTest(64 * GB); // ...and the HOST reports ample free...
    _setConstrainedMemoryForTest(256 * 1024 * 1024); // ...but the container cap is 256 MiB.
    const fakes = installFakeWorkers();

    const p1 = embed(["alpha"], "query");
    const p2 = embed(["beta"], "query");
    await flush();

    // Clamped to 256 MiB (< one per-worker budget), the pool must NOT load a
    // second model despite the ceiling and the host's 64 GiB free figure.
    expect(fakes).toHaveLength(1);
    expect(fakes[0].embedIds).toHaveLength(1);

    fakes[0].completeNext();
    expect(await p1).toHaveLength(1);
    await flush();
    expect(fakes[0].embedIds).toHaveLength(1);
    fakes[0].completeNext();
    expect(await p2).toHaveLength(1);
  });

  it("degrades the whole provider to unavailable when a worker init-errors", async () => {
    _setEmbedPoolSizeForTest(1);
    const fakes = installFakeWorkers();

    const r = settle(embed(["alpha"], "query"));
    await flush();
    expect(fakes).toHaveLength(1);

    fakes[0].initError("model load failed");
    await flush();

    const outcome = await r;
    expect(outcome.ok).toBe(false);
    // The module-global broken latch is shared across the pool → FTS-only.
    expect(isAvailable()).toBe(false);
  });

  it("retires a transiently failed slot after a sibling recovers", async () => {
    _setEmbedPoolSizeForTest(2);
    _setPoolFreememForTest(64 * GB);
    const fakes = installFakeWorkers();
    await warmPool(fakes);

    const healthy = embed(["healthy"], "document");
    const failed = settle(embed(["failed"], "document"));
    await flush();
    expect(fakes).toHaveLength(2);

    fakes[1].initError(
      "Can't create a session. ERROR_CODE: 7, ERROR_MESSAGE: Failed to load model because protobuf parsing failed.",
    );
    fakes[0].completeAll();
    expect((await failed).ok).toBe(false);
    expect(await healthy).toHaveLength(1);
    expect(isAvailable()).toBe(true);

    const failedSlotPosts = fakes[1].embedIds.length;
    const next = embed(["backfill"], "document");
    await flush();
    expect(fakes).toHaveLength(2);
    expect(fakes[1].embedIds).toHaveLength(failedSlotPosts);
    expect(fakes[0].embedIds).toHaveLength(1);
    fakes[0].completeAll();
    expect(await next).toHaveLength(1);
  });

  it("does not replace failed slots before the transient retry cooldown", async () => {
    _setEmbedPoolSizeForTest(2);
    _setPoolFreememForTest(64 * GB);
    _setLocalInitCooldownMsForTest(60_000);
    const fakes = installFakeWorkers();

    const first = settle(embed(["first"], "document"));
    const second = settle(embed(["second"], "document"));
    await flush();
    expect(fakes).toHaveLength(1);
    fakes[0].initError("transient one");
    expect((await first).ok).toBe(false);
    expect((await second).ok).toBe(false);
    await flush();
    expect(_getLocalInitRetryAtForTest()).toBeGreaterThan(Date.now());

    const cooling = await settle(embed(["too soon"], "document"));
    expect(cooling.ok).toBe(false);
    expect(fakes).toHaveLength(1);

    _setLocalInitRetryAtForTest(Date.now() - 1);
    const retry = embed(["after cooldown"], "document");
    await flush();
    expect(fakes).toHaveLength(2);
    fakes[1].completeAll();
    expect(await retry).toHaveLength(1);
  });

  it("applies the same bounded cooldown to worker errors", async () => {
    _setEmbedPoolSizeForTest(1);
    _setLocalInitCooldownMsForTest(60_000);
    const fakes = installFakeWorkers();

    const first = settle(embed(["first"], "document"));
    await flush();
    fakes[0].crash("transient worker crash");
    expect((await first).ok).toBe(false);
    await flush();

    const cooling = await settle(embed(["too soon"], "document"));
    expect(cooling.ok).toBe(false);
    expect(fakes).toHaveLength(1);
    expect(_getLocalInitRetryAtForTest()).toBeGreaterThan(Date.now());

    for (let attempt = 2; attempt <= 3; attempt++) {
      _setLocalInitRetryAtForTest(Date.now() - 1);
      const retry = settle(embed([`worker crash ${attempt}`], "document"));
      await flush();
      expect(fakes).toHaveLength(attempt);
      fakes[attempt - 1].crash(`transient worker crash ${attempt}`);
      expect((await retry).ok).toBe(false);
      await flush();
    }

    _setLocalInitRetryAtForTest(Date.now() - 1);
    const exhausted = await settle(embed(["must not respawn"], "document"));
    expect(exhausted.ok).toBe(false);
    expect(fakes).toHaveLength(3);
  });

  it("admits one replacement after cooldown while a healthy sibling serves traffic", async () => {
    _setEmbedPoolSizeForTest(2);
    _setPoolFreememForTest(64 * GB);
    _setLocalInitCooldownMsForTest(60_000);
    const fakes = installFakeWorkers();

    const warm = embed(["warm"], "document");
    await flush();
    fakes[0].completeAll();
    await warm;

    const busy = embed(["busy healthy slot"], "document");
    const failed = settle(embed(["candidate slot"], "document"));
    await flush();
    expect(fakes).toHaveLength(2);
    fakes[1].initError("transient candidate failure");
    expect((await failed).ok).toBe(false);

    // The healthy sibling was already in flight when the candidate failed. Its
    // later success must restore service without erasing the candidate's retry
    // deadline and admitting an immediate replacement.
    fakes[0].completeAll();
    await busy;
    expect(_getLocalInitRetryAtForTest()).toBeGreaterThan(Date.now());

    const duringCooldown = embed(["served during cooldown"], "document");
    const alsoDuringCooldown = embed(
      ["also served during cooldown"],
      "document",
    );
    await flush();
    expect(fakes).toHaveLength(2);
    _setLocalInitRetryAtForTest(Date.now() - 1);

    const recovery = embed(["replacement probe"], "document");
    await flush();
    expect(fakes).toHaveLength(3);
    fakes[0].completeAll();
    fakes[2].completeAll();
    await flush();
    fakes[0].completeAll();
    fakes[2].completeAll();
    await Promise.all([duringCooldown, alsoDuringCooldown, recovery]);
  });

  it("bounds failed recovery probes while a healthy sibling remains available", async () => {
    _setEmbedPoolSizeForTest(2);
    _setPoolFreememForTest(64 * GB);
    _setLocalInitCooldownMsForTest(60_000);
    const fakes = installFakeWorkers();

    const warm = embed(["warm"], "document");
    await flush();
    fakes[0].completeAll();
    await warm;

    // Fail the initial growth candidate, then fail both bounded recovery probes.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const healthy = embed([`healthy-${attempt}`], "document");
      if (attempt > 1) _setLocalInitRetryAtForTest(Date.now() - 1);
      const candidate = settle(embed([`candidate-${attempt}`], "document"));
      await flush();
      expect(fakes).toHaveLength(attempt + 1);
      fakes[attempt].crash(`candidate crash ${attempt}`);
      expect((await candidate).ok).toBe(false);
      fakes[0].completeAll();
      await healthy;
      await flush();

      if (attempt < 3) {
        expect(_getLocalInitRetryAtForTest()).toBeGreaterThan(Date.now());
        const stillCooling = embed([`cooldown-${attempt}`], "document");
        const alsoCooling = embed([`cooldown-busy-${attempt}`], "document");
        await flush();
        expect(fakes).toHaveLength(attempt + 1);
        fakes[0].completeNext();
        await flush();
        fakes[0].completeNext();
        await Promise.all([stillCooling, alsoCooling]);
      }
    }

    // Exhaustion must not disable a proven sibling, but it must stop spawning.
    expect(isAvailable()).toBe(true);
    const afterExhaustion = embed(["healthy only"], "document");
    const queuedAfterExhaustion = embed(["still healthy only"], "document");
    await flush();
    expect(fakes).toHaveLength(4);
    fakes[0].completeNext();
    await flush();
    fakes[0].completeNext();
    await Promise.all([afterExhaustion, queuedAfterExhaustion]);
  });

  it("does not let a stale recovery probe clear a newer sibling failure", async () => {
    _setEmbedPoolSizeForTest(2);
    _setPoolFreememForTest(64 * GB);
    _setLocalInitCooldownMsForTest(60_000);
    const fakes = installFakeWorkers();

    const warm = embed(["warm"], "document");
    await flush();
    fakes[0].completeAll();
    await warm;

    // Build two failures while the healthy slot continues serving.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const healthy = embed([`healthy-${attempt}`], "document");
      if (attempt > 1) _setLocalInitRetryAtForTest(Date.now() - 1);
      const failed = settle(embed([`failed-${attempt}`], "document"));
      await flush();
      fakes[attempt].crash(`crash-${attempt}`);
      expect((await failed).ok).toBe(false);
      fakes[0].completeAll();
      await healthy;
    }

    // Admit generation-2 recovery, then let the healthy sibling create failure
    // generation 3 before that stale recovery completes.
    _setLocalInitRetryAtForTest(Date.now() - 1);
    const siblingFailure = settle(embed(["newer sibling failure"], "document"));
    const staleRecovery = embed(["stale recovery"], "document");
    await flush();
    expect(fakes).toHaveLength(4);
    fakes[0].crash("newer failure");
    expect((await siblingFailure).ok).toBe(false);
    fakes[3].completeAll();
    expect(await staleRecovery).toHaveLength(1);
    expect(isAvailable()).toBe(true);

    // The stale success restored service but did not reset the exhausted budget.
    const after = embed(["after stale success"], "document");
    const queued = embed(["no immediate replacement"], "document");
    await flush();
    expect(fakes).toHaveLength(4);
    fakes[3].completeNext();
    await flush();
    fakes[3].completeNext();
    await Promise.all([after, queued]);
  });

  it("applies bounded retry accounting when postMessage throws", async () => {
    _setEmbedPoolSizeForTest(1);
    _setLocalInitCooldownMsForTest(60_000);
    const fakes = installFakeWorkers((worker) => {
      worker.throwOnNextEmbed = true;
    });

    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) _setLocalInitRetryAtForTest(Date.now() - 1);
      const request = settle(embed([`post failure ${attempt}`], "document"));
      await flush();
      expect(fakes).toHaveLength(attempt);
      expect((await request).ok).toBe(false);
      if (attempt < 3) {
        expect(_getLocalInitRetryAtForTest()).toBeGreaterThan(Date.now());
      }
    }

    _setLocalInitRetryAtForTest(Date.now() - 1);
    expect((await settle(embed(["must not respawn"], "document"))).ok).toBe(
      false,
    );
    expect(fakes).toHaveLength(3);
  });

  it("applies bounded retry accounting when worker construction throws", async () => {
    _setEmbedPoolSizeForTest(1);
    _setLocalInitCooldownMsForTest(60_000);
    let spawnAttempts = 0;
    _setTestWorkerFactory(() => {
      spawnAttempts++;
      throw new Error("worker construction failed");
    });

    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) _setLocalInitRetryAtForTest(Date.now() - 1);
      const request = settle(embed([`spawn failure ${attempt}`], "document"));
      expect((await request).ok).toBe(false);
      expect(spawnAttempts).toBe(attempt);
      if (attempt < 3) {
        expect(_getLocalInitRetryAtForTest()).toBeGreaterThan(Date.now());
      }
    }

    _setLocalInitRetryAtForTest(Date.now() - 1);
    expect((await settle(embed(["must not respawn"], "document"))).ok).toBe(
      false,
    );
    expect(spawnAttempts).toBe(3);
  });

  it("retires and drains an idle worker error before reset completes", async () => {
    _setEmbedPoolSizeForTest(1);
    const fakes = installFakeWorkers();
    const warm = embed(["warm"], "document");
    await flush();
    fakes[0].completeAll();
    await warm;
    fakes[0].exitOnShutdown = false;

    fakes[0].crash("idle crash");
    await flush();
    expect(fakes[0].gotShutdown).toBe(true);
    expect(isAvailable()).toBe(false);

    let resetDone = false;
    const reset = resetProvider().then(() => {
      resetDone = true;
    });
    await flush();
    expect(resetDone).toBe(false);
    fakes[0].exit();
    await reset;
    expect(resetDone).toBe(true);
  });

  it("keeps a proven sibling available after transient failures", async () => {
    _setEmbedPoolSizeForTest(4);
    _setPoolFreememForTest(64 * GB);
    _setLocalInitCooldownMsForTest(0);
    const fakes = installFakeWorkers();
    await warmPool(fakes);

    const requests = Array.from({ length: 4 }, (_, index) =>
      settle(embed([`request-${index}`], "document")),
    );
    await flush();
    expect(fakes).toHaveLength(4);
    fakes[1].initError("transient one");
    fakes[2].initError("transient two");
    fakes[3].initError("transient three");
    expect(isAvailable()).toBe(true);

    fakes[0].completeAll();
    const outcomes = await Promise.all(requests);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(isAvailable()).toBe(true);

    const next = embed(["after sibling recovery"], "document");
    await flush();
    fakes[0].completeAll();
    expect(await next).toHaveLength(1);
  });

  it("does not clear a terminal provider latch when a sibling succeeds", async () => {
    _setEmbedPoolSizeForTest(2);
    _setPoolFreememForTest(64 * GB);
    const fakes = installFakeWorkers();
    await warmPool(fakes);

    const sibling = embed(["sibling"], "document");
    const failed = settle(embed(["terminal"], "document"));
    await flush();
    fakes[1].initError("Cannot find package 'onnxruntime-node'");
    fakes[0].completeAll();
    expect((await failed).ok).toBe(false);
    expect(await sibling).toHaveLength(1);
    expect(isAvailable()).toBe(false);
    await expect(ensureEmbeddingReady()).rejects.toBeInstanceOf(
      LocalProviderUnavailableError,
    );
  });

  it("settles an embed when reset races cold worker initialization", async () => {
    _setEmbedPoolSizeForTest(1);
    const fakes = installFakeWorkers();

    const pending = settle(embed(["cold reset"], "query"));
    const reset = resetProvider();
    const outcome = await pending;
    await reset;

    expect(outcome.ok).toBe(false);
    expect(recallEmbedsInFlight()).toBe(0);
    await flush();
    expect(fakes).toHaveLength(0);
  });

  it("settles an embed when reset races a warmed provider", async () => {
    _setEmbedPoolSizeForTest(1);
    const fakes = installFakeWorkers();
    const warm = embed(["warm"], "document");
    await flush();
    fakes[0].completeAll();
    await warm;

    const pending = settle(embed(["warm reset"], "query"));
    const reset = resetProvider();
    const outcome = await pending;
    await reset;

    expect(outcome.ok).toBe(false);
    expect(recallEmbedsInFlight()).toBe(0);
    expect(fakes[0].gotShutdown).toBe(true);
  });

  it("waits for retired workers when resetting the pool", async () => {
    _setEmbedPoolSizeForTest(2);
    _setPoolFreememForTest(64 * GB);
    const fakes = installFakeWorkers();
    await warmPool(fakes);
    const healthy = embed(["healthy"], "document");
    const failed = settle(embed(["failed"], "document"));
    await flush();
    fakes[1].exitOnShutdown = false;
    fakes[1].initError("transient failure");
    fakes[0].completeAll();
    expect((await failed).ok).toBe(false);
    await healthy;
    await flush();
    expect(fakes[1].gotShutdown).toBe(true);

    let resetDone = false;
    const reset = resetProvider().then(() => {
      resetDone = true;
    });
    await flush();
    expect(resetDone).toBe(false);
    fakes[1].exit();
    await reset;
    expect(resetDone).toBe(true);
    expect(fakes[0].gotShutdown).toBe(true);
  });

  it("LORE_EMBED_POOL_SIZE sets the ceiling (env-driven, no test override)", async () => {
    process.env.LORE_EMBED_POOL_SIZE = "2";
    _setPoolFreememForTest(64 * GB);
    const fakes = installFakeWorkers();
    await warmPool(fakes);

    const p1 = embed(["alpha"], "query");
    const p2 = embed(["beta"], "query");
    await flush();

    expect(fakes).toHaveLength(2);
    fakes[0].completeAll();
    fakes[1].completeAll();
    await Promise.all([p1, p2]);
  });

  it("ignores an invalid LORE_EMBED_POOL_SIZE and falls back to a single worker", async () => {
    process.env.LORE_EMBED_POOL_SIZE = "not-a-number";
    _setPoolFreememForTest(64 * GB);
    const fakes = installFakeWorkers();

    const p1 = embed(["alpha"], "query");
    const p2 = embed(["beta"], "query");
    await flush();

    // Invalid env → undefined → default ceiling of 1 in test mode.
    expect(fakes).toHaveLength(1);
    fakes[0].completeNext();
    await flush();
    fakes[0].completeNext();
    await Promise.all([p1, p2]);
  });

  // Direct assertions on the resolver so a regression in its validation is
  // caught even where the pool's downstream sanitizers (`?? 1`,
  // desiredEmbedPoolSize) would mask it via the worker count. Guards the
  // load-bearing "invalid env resolves to undefined (fall through), never NaN"
  // contract: dropping the isFinite/>=1 guard leaks NaN and fails these.
  describe("configuredEmbedPoolSize resolution", () => {
    it("returns undefined for an unset env (memory-gated default)", () => {
      delete process.env.LORE_EMBED_POOL_SIZE;
      expect(_configuredEmbedPoolSize()).toBeUndefined();
    });

    it("returns undefined (not NaN) for a non-numeric env", () => {
      process.env.LORE_EMBED_POOL_SIZE = "not-a-number";
      expect(_configuredEmbedPoolSize()).toBeUndefined();
    });

    it("returns undefined for a partially-numeric env (strict Number, not parseInt)", () => {
      process.env.LORE_EMBED_POOL_SIZE = "2x";
      expect(_configuredEmbedPoolSize()).toBeUndefined();
    });

    it("floors a valid numeric env to an integer", () => {
      process.env.LORE_EMBED_POOL_SIZE = "3";
      expect(_configuredEmbedPoolSize()).toBe(3);
      process.env.LORE_EMBED_POOL_SIZE = "3.9";
      expect(_configuredEmbedPoolSize()).toBe(3);
    });

    it("rejects out-of-range env values (< 1) as undefined", () => {
      process.env.LORE_EMBED_POOL_SIZE = "0";
      expect(_configuredEmbedPoolSize()).toBeUndefined();
      process.env.LORE_EMBED_POOL_SIZE = "-4";
      expect(_configuredEmbedPoolSize()).toBeUndefined();
    });
  });

  it("outside test mode, sizes the pool from free memory (production path)", async () => {
    // Flip out of NODE_ENV=test so the constructor takes the memory-gated
    // branch; the freemem seam keeps it deterministic.
    process.env.NODE_ENV = "production";
    _setPoolFreememForTest(64 * GB); // ample → default ceiling of 2
    const fakes = installFakeWorkers();
    await warmPool(fakes);

    const p1 = embed(["alpha"], "query");
    const p2 = embed(["beta"], "query");
    await flush();

    expect(fakes).toHaveLength(2);
    fakes[0].completeAll();
    fakes[1].completeAll();
    await Promise.all([p1, p2]);
  });

  it("outside test mode with tight memory, sizes the pool to a single worker", async () => {
    process.env.NODE_ENV = "production";
    _setPoolFreememForTest(0); // no headroom → ceiling 1
    const fakes = installFakeWorkers();

    const p1 = embed(["alpha"], "query");
    const p2 = embed(["beta"], "query");
    await flush();

    expect(fakes).toHaveLength(1);
    fakes[0].completeNext();
    await flush();
    fakes[0].completeNext();
    await Promise.all([p1, p2]);
  });

  it("shuts down every worker in the pool", async () => {
    _setEmbedPoolSizeForTest(2);
    _setPoolFreememForTest(64 * GB);
    const fakes = installFakeWorkers();
    await warmPool(fakes);

    const p1 = embed(["alpha"], "query");
    const p2 = embed(["beta"], "query");
    await flush();
    expect(fakes).toHaveLength(2);
    fakes[0].completeAll();
    fakes[1].completeAll();
    await Promise.all([p1, p2]);

    await resetProvider();
    expect(fakes[0].gotShutdown).toBe(true);
    expect(fakes[1].gotShutdown).toBe(true);
  });
});
