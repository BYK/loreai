import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import {
  embed,
  isAvailable,
  LocalProviderUnavailableError,
  _persistEmbedCap,
  _readPersistedEmbedCap,
  _resetLocalProviderProbe,
  _restoreProvider,
  _saveAndClearProvider,
  _setTestWorkerFactory,
} from "../src/embedding";
import {
  backoffEmbedCap,
  MIN_EMBED_TOKENS,
  EMBED_TOKEN_CEILING,
} from "../src/embedding-cap";
import { EMBED_OOM_EXIT_CODE } from "../src/embedding-worker-types";
import { isStderrSilenced, silenceStderr } from "../src/log";

// Exercises the stateful OOM-recovery lifecycle in LocalProvider that the pure
// cap math can't reach: the worker on("exit") OOM branch → handleOomBackoff →
// resubmitPending, the floor latch, and a synchronous respawn failure (#858).
// A fake worker (the _setTestWorkerFactory seam) lets us drive worker exit/
// message events deterministically without a real ONNX runtime.

type EmbedMsg = { type: string; id: number; maxTokens: number };

/** Minimal stand-in for a node:worker_threads Worker. Captures posted messages
 *  and lets a test emit "message"/"error"/"exit" via EventEmitter. */
class FakeWorker extends EventEmitter {
  readonly posted: EmbedMsg[] = [];
  terminated = false;
  postMessage(msg: unknown): void {
    // Snapshot: the production payload object is mutated in place on re-submit
    // (p.payload.maxTokens = lowered), so storing the reference would let a
    // later backoff retroactively change an earlier captured message.
    this.posted.push({ ...(msg as EmbedMsg) });
  }
  ref(): void {}
  unref(): void {}
  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }
  lastPosted(): EmbedMsg {
    const m = this.posted.at(-1);
    if (!m) throw new Error("fake worker received no message");
    return m;
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

/** Flush pending microtasks + one macrotask so the async respawn/re-submit
 *  chain (resubmitPending → ensureWorker → re-post) settles. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/** Attach handlers immediately so a rejection that fires while we drive the
 *  worker (well before we assert on it) is never flagged as "unhandled". */
function settle<T>(
  p: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; err: unknown }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (err) => ({ ok: false as const, err }),
  );
}

describe("embedding OOM recovery (worker-mock)", () => {
  let savedProvider: unknown;
  let savedVoyage: string | undefined;
  let savedOpenAI: string | undefined;

  beforeEach(() => {
    // Force the local provider (no remote fallback) and a fresh instance.
    savedVoyage = process.env.VOYAGE_API_KEY;
    savedOpenAI = process.env.OPENAI_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    _resetLocalProviderProbe();
    savedProvider = _saveAndClearProvider();
  });

  afterEach(() => {
    _setTestWorkerFactory(null);
    _resetLocalProviderProbe();
    _restoreProvider(savedProvider);
    if (savedVoyage !== undefined) process.env.VOYAGE_API_KEY = savedVoyage;
    if (savedOpenAI !== undefined) process.env.OPENAI_API_KEY = savedOpenAI;
  });

  it("OOM exit lowers the cap ×0.7, persists it, respawns, and re-submits the in-flight request at the lowered cap", async () => {
    // freeMemBytes=0 → reconcileEmbedCap trusts this cap regardless of host free
    // memory (otherwise a freemem swing under parallel CI load reconciles to the
    // memory-model cap and this test flakes). The persisted 8192 is deliberately
    // STALE (learned before the WASM bound) — the provider must start at the
    // WASM ceiling, not 8192, exercising the trust-band bound in the live path.
    _persistEmbedCap(8192, 0);
    const fakes = installFakeWorkers();

    const promise = embed(["hello world"], "query");
    await flush();

    expect(fakes).toHaveLength(1);
    const first = fakes[0].lastPosted();
    expect(first.type).toBe("embed");
    expect(first.maxTokens).toBe(EMBED_TOKEN_CEILING);

    // The worker OOMs on the oversized input → exits with the OOM code.
    fakes[0].emit("exit", EMBED_OOM_EXIT_CODE);
    await flush();

    // Respawned on a fresh worker; same request re-submitted at the ×0.7 cap.
    expect(fakes).toHaveLength(2);
    const resubmitted = fakes[1].lastPosted();
    expect(resubmitted.id).toBe(first.id);
    expect(resubmitted.maxTokens).toBe(backoffEmbedCap(EMBED_TOKEN_CEILING));
    expect(resubmitted.maxTokens).toBeLessThan(first.maxTokens);
    // The lowered cap was persisted so a restart doesn't re-walk the backoff.
    expect(_readPersistedEmbedCap()?.cap).toBe(resubmitted.maxTokens);

    // The respawned worker succeeds → the caller's original promise resolves.
    fakes[1].emit("message", {
      type: "result",
      id: resubmitted.id,
      vectors: [new Float32Array([0.1, 0.2, 0.3])],
    });
    const vectors = await promise;
    expect(vectors).toHaveLength(1);
  });

  it("OOM at the floor latches FTS-only and rejects the pending request (no respawn)", async () => {
    // freeMemBytes=0 → trusted as-is (see the model-max test), so the provider
    // deterministically starts at the floor regardless of host free memory.
    _persistEmbedCap(MIN_EMBED_TOKENS, 0);
    const fakes = installFakeWorkers();

    const result = settle(embed(["hello world"], "query"));
    await flush();
    expect(fakes).toHaveLength(1);
    expect(fakes[0].lastPosted().maxTokens).toBe(MIN_EMBED_TOKENS);

    // OOM at the floor can't back off further → latch instead of respawning.
    fakes[0].emit("exit", EMBED_OOM_EXIT_CODE);
    await flush();

    expect(fakes).toHaveLength(1); // did NOT respawn
    const r = await result;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.err).toBeInstanceOf(LocalProviderUnavailableError);
    expect(isAvailable()).toBe(false); // degraded to FTS-only
  });

  it("rejects pending requests when the respawn itself fails synchronously", async () => {
    _persistEmbedCap(8192, 0);
    let calls = 0;
    const fakes: FakeWorker[] = [];
    _setTestWorkerFactory(() => {
      calls += 1;
      // The respawn (2nd spawn) throws synchronously, before any worker event
      // handler is attached — nothing else will ever settle the pending request.
      if (calls >= 2) throw new Error("synthetic spawn failure");
      const f = new FakeWorker();
      fakes.push(f);
      return f as unknown as Worker;
    });

    const result = settle(embed(["hello world"], "query"));
    await flush();
    expect(fakes).toHaveLength(1);

    fakes[0].emit("exit", EMBED_OOM_EXIT_CODE);
    await flush();

    expect(calls).toBe(2); // respawn was attempted
    const r = await result;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.err).toBeInstanceOf(LocalProviderUnavailableError);
  });

  it("descends the full backoff ladder to the floor across repeated OOMs, then latches", async () => {
    _persistEmbedCap(8192, 0);
    const fakes = installFakeWorkers();

    const result = settle(embed(["hello world"], "query"));
    await flush();

    let lastCap = Number.POSITIVE_INFINITY;
    let latched = false;
    for (let i = 0; i < 30 && !latched; i++) {
      const before = fakes.length;
      const current = fakes[fakes.length - 1];
      const cap = current.lastPosted().maxTokens;
      expect(cap).toBeLessThanOrEqual(lastCap); // monotone non-increasing
      lastCap = cap;
      current.emit("exit", EMBED_OOM_EXIT_CODE);
      await flush();
      if (fakes.length === before) latched = true; // no respawn → latched
    }

    expect(latched).toBe(true);
    expect(lastCap).toBe(MIN_EMBED_TOKENS); // bottomed out at the floor before latching
    const r = await result;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.err).toBeInstanceOf(LocalProviderUnavailableError);
    expect(isAvailable()).toBe(false);
  });

  it("snapshots the host's stderr-silence flag into workerData on every spawn", async () => {
    // A worker thread has its OWN globalThis, so the main thread's
    // log.silenceStderr() can't reach it — the value must ride in via workerData
    // or the worker's [lore] OOM line corrupts the host TUI. The global test
    // setup resets the silence flag after each test.
    _persistEmbedCap(8192, 0);
    const seen: Array<boolean | undefined> = [];
    _setTestWorkerFactory((initData) => {
      seen.push(initData.stderrSilenced);
      return new FakeWorker() as unknown as Worker;
    });

    silenceStderr(true);
    expect(isStderrSilenced()).toBe(true);
    void settle(embed(["hello world"], "query"));
    await flush();

    // The spawn captured the live silence state (true), not a hardcoded default.
    expect(seen.at(-1)).toBe(true);
  });
});
