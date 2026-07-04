import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import {
  embed,
  isAvailable,
  resetProvider,
  _configuredEmbedPoolSize,
  _resetLocalProviderProbe,
  _restoreProvider,
  _saveAndClearProvider,
  _setConstrainedMemoryForTest,
  _setEmbedPoolSizeForTest,
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
  gotShutdown = false;
  terminated = false;

  postMessage(msg: unknown): void {
    const m = msg as { type: string; id?: number };
    if (m.type === "embed" && typeof m.id === "number") {
      this.embedIds.push(m.id);
    } else if (m.type === "shutdown") {
      this.gotShutdown = true;
      // A real worker drains + exits; mirror that so awaitWorkerShutdown resolves.
      this.emit("exit", 0);
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

  /** Simulate a fatal model-init failure (permanent per-provider break). */
  initError(error = "model load failed"): void {
    this.emit("message", { type: "init-error", error });
  }
}

/** Install the factory and collect every fake worker it hands out. */
function installFakeWorkers(): FakeWorker[] {
  const fakes: FakeWorker[] = [];
  _setTestWorkerFactory(() => {
    const f = new FakeWorker();
    fakes.push(f);
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

  it("dispatches concurrent embeds to distinct workers in parallel", async () => {
    _setEmbedPoolSizeForTest(2);
    _setPoolFreememForTest(64 * GB); // ample → growth allowed
    const fakes = installFakeWorkers();

    const p1 = embed(["alpha"], "query");
    const p2 = embed(["beta"], "query");
    await flush();

    // Two workers spawned, each carrying exactly one request — not serialized
    // through a single worker (the whole point of #999).
    expect(fakes).toHaveLength(2);
    expect(fakes[0].embedIds).toHaveLength(1);
    expect(fakes[1].embedIds).toHaveLength(1);

    fakes[0].completeAll();
    fakes[1].completeAll();
    expect(await p1).toHaveLength(1);
    expect(await p2).toHaveLength(1);
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

  it("stays at a single worker under concurrency when memory is tight", async () => {
    _setEmbedPoolSizeForTest(2); // ceiling allows 2...
    _setPoolFreememForTest(0); // ...but no memory for a second ~680MB model
    const fakes = installFakeWorkers();

    const p1 = embed(["alpha"], "query");
    const p2 = embed(["beta"], "query");
    await flush();

    // Both requests queue on the one worker rather than loading a second model.
    expect(fakes).toHaveLength(1);
    expect(fakes[0].embedIds).toHaveLength(2);

    fakes[0].completeAll();
    expect(await p1).toHaveLength(1);
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
    expect(fakes[0].embedIds).toHaveLength(2);

    fakes[0].completeAll();
    expect(await p1).toHaveLength(1);
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

  it("LORE_EMBED_POOL_SIZE sets the ceiling (env-driven, no test override)", async () => {
    process.env.LORE_EMBED_POOL_SIZE = "2";
    _setPoolFreememForTest(64 * GB);
    const fakes = installFakeWorkers();

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
    fakes[0].completeAll();
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
    fakes[0].completeAll();
    await Promise.all([p1, p2]);
  });

  it("shuts down every worker in the pool", async () => {
    _setEmbedPoolSizeForTest(2);
    _setPoolFreememForTest(64 * GB);
    const fakes = installFakeWorkers();

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
