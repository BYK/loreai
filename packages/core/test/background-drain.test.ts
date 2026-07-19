import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import {
  embedKnowledgeEntry,
  isAvailable,
  recallEmbedsInFlight,
  settleDocumentEmbeds,
  warmupEmbedding,
  _persistEmbedCap,
  _resetLocalProviderProbe,
  _restoreProvider,
  _saveAndClearProvider,
  _setTestWorkerFactory,
} from "../src/embedding";
import { settleBackgroundWork } from "../src/distillation";
import { config, load } from "../src/config";

// Guards the issue #885 fix: fire-and-forget document embeds (embedKnowledgeEntry
// / embedDistillation / embedEntity) and non-urgent pattern-echo work must be
// DRAINABLE so a promise can't resolve after the test harness closes/swaps the
// DB (which trips the production-DB guard in ensureProject, or writes to the
// wrong DB). We drive a fake embedding worker so the in-flight embed is pending
// on demand and assert the drain actually waits for it.

type EmbedMsg = { type: string; id: number; maxTokens: number };

class FakeWorker extends EventEmitter {
  readonly posted: EmbedMsg[] = [];
  postMessage(msg: unknown): void {
    this.posted.push({ ...(msg as EmbedMsg) });
  }
  ref(): void {}
  unref(): void {}
  terminate(): Promise<number> {
    return Promise.resolve(0);
  }
  lastPosted(): EmbedMsg {
    const m = this.posted.at(-1);
    if (!m) throw new Error("fake worker received no message");
    return m;
  }
}

function installFakeWorkers(): FakeWorker[] {
  const fakes: FakeWorker[] = [];
  _setTestWorkerFactory(() => {
    const f = new FakeWorker();
    fakes.push(f);
    return f as unknown as Worker;
  });
  return fakes;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe("background-work drain (issue #885)", () => {
  let savedProvider: unknown;
  let savedVoyage: string | undefined;
  let savedOpenAI: string | undefined;

  beforeEach(() => {
    // Force the local provider onto the fake worker (no remote fallback, fresh
    // instance) so embed() is driven deterministically and never touches a real
    // ONNX model.
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

  it("settleDocumentEmbeds awaits an in-flight fire-and-forget document embed", async () => {
    _persistEmbedCap(8192, 0); // trust cap as-is regardless of host free memory
    const fakes = installFakeWorkers();
    expect(isAvailable()).toBe(true);

    // Fire-and-forget: returns void, schedules an embed on the (fake) worker.
    embedKnowledgeEntry("k-885", "title", "content");
    await flush();
    expect(fakes).toHaveLength(1);
    expect(fakes[0].lastPosted().type).toBe("embed");

    // The drain must NOT resolve while the embed is still pending — otherwise a
    // promise leaks past the test boundary (the flake).
    let drained = false;
    const drain = settleDocumentEmbeds().then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);

    // Worker replies → embed resolves → storeEmbedding runs → drain resolves.
    fakes[0].emit("message", {
      type: "result",
      id: fakes[0].lastPosted().id,
      vectors: [new Float32Array([0.1, 0.2, 0.3])],
    });
    await drain;
    expect(drained).toBe(true);
  });

  it("settleBackgroundWork also drains in-flight document embeds", async () => {
    _persistEmbedCap(8192, 0);
    const fakes = installFakeWorkers();

    embedKnowledgeEntry("k-885-b", "title", "content");
    await flush();
    expect(fakes).toHaveLength(1);

    let drained = false;
    const drain = settleBackgroundWork().then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);

    fakes[0].emit("message", {
      type: "result",
      id: fakes[0].lastPosted().id,
      vectors: [new Float32Array([0.1, 0.2, 0.3])],
    });
    await drain;
    expect(drained).toBe(true);
  });

  it("drains are no-ops when nothing is in flight", async () => {
    await expect(settleDocumentEmbeds()).resolves.toBeUndefined();
    await expect(settleBackgroundWork()).resolves.toBeUndefined();
  });
});

// Guards the issue #1331 fix: a distillation embed still in flight when the
// gateway is torn down must be drained BEFORE the worker is shut down, or its
// `distillation_vec` row is never written → silent recall degradation on
// short/fast sessions. The drain is BOUNDED so a slow/stuck embed can't
// reintroduce the Ctrl+C hang; and the worker is warm-started at gateway
// startup so the first real embed is fast enough to finish within the turn.
describe("bounded document-embed drain (issue #1331)", () => {
  let savedProvider: unknown;
  let savedVoyage: string | undefined;
  let savedOpenAI: string | undefined;

  beforeEach(() => {
    savedVoyage = process.env.VOYAGE_API_KEY;
    savedOpenAI = process.env.OPENAI_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    _resetLocalProviderProbe();
    savedProvider = _saveAndClearProvider();
  });

  afterEach(async () => {
    _setTestWorkerFactory(null);
    _resetLocalProviderProbe();
    _restoreProvider(savedProvider);
    if (savedVoyage !== undefined) process.env.VOYAGE_API_KEY = savedVoyage;
    else delete process.env.VOYAGE_API_KEY;
    if (savedOpenAI !== undefined) process.env.OPENAI_API_KEY = savedOpenAI;
    else delete process.env.OPENAI_API_KEY;
    // Restore default (local) config for any suite that runs after us.
    await load(process.cwd());
  });

  it("settleDocumentEmbeds(timeoutMs) resolves at the deadline even with a pending embed", async () => {
    _persistEmbedCap(8192, 0);
    const fakes = installFakeWorkers();
    expect(isAvailable()).toBe(true);

    // Fire an embed and never let the (fake) worker reply — it stays pending.
    embedKnowledgeEntry("k-1331", "title", "content");
    await flush();
    expect(fakes).toHaveLength(1);

    // A bounded drain must RESOLVE at the deadline rather than hang on the
    // never-completing embed (this is what keeps Ctrl+C snappy).
    const start = Date.now();
    await settleDocumentEmbeds(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(1000);

    // Complete the embed so it doesn't leak into the shared in-flight set and
    // stall a later test's drain (the module-level set persists across tests).
    fakes[0].emit("message", {
      type: "result",
      id: fakes[0].lastPosted().id,
      vectors: [new Float32Array([0.1, 0.2, 0.3])],
    });
    await settleDocumentEmbeds();
  });

  it("settleDocumentEmbeds(timeoutMs) returns immediately once the embed completes", async () => {
    _persistEmbedCap(8192, 0);
    const fakes = installFakeWorkers();

    embedKnowledgeEntry("k-1331-b", "title", "content");
    await flush();
    expect(fakes).toHaveLength(1);

    // Worker replies → embed resolves → a generous-deadline drain returns fast.
    fakes[0].emit("message", {
      type: "result",
      id: fakes[0].lastPosted().id,
      vectors: [new Float32Array([0.1, 0.2, 0.3])],
    });
    await flush();
    const start = Date.now();
    await settleDocumentEmbeds(5000);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe("warmupEmbedding (issue #1331)", () => {
  let savedProvider: unknown;
  let savedVoyage: string | undefined;
  let savedOpenAI: string | undefined;

  beforeEach(() => {
    savedVoyage = process.env.VOYAGE_API_KEY;
    savedOpenAI = process.env.OPENAI_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    _resetLocalProviderProbe();
    savedProvider = _saveAndClearProvider();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    _setTestWorkerFactory(null);
    _resetLocalProviderProbe();
    _restoreProvider(savedProvider);
    if (savedVoyage !== undefined) process.env.VOYAGE_API_KEY = savedVoyage;
    else delete process.env.VOYAGE_API_KEY;
    if (savedOpenAI !== undefined) process.env.OPENAI_API_KEY = savedOpenAI;
    else delete process.env.OPENAI_API_KEY;
    await load(process.cwd());
  });

  it("fires exactly one 'document' embed on a local provider", async () => {
    _persistEmbedCap(8192, 0);
    const fakes = installFakeWorkers();
    expect(isAvailable()).toBe(true);
    expect(config().search.embeddings.provider).toBe("local");

    warmupEmbedding();
    await flush();

    // The warmup posted exactly one embed to the local worker.
    expect(fakes).toHaveLength(1);
    expect(fakes[0].posted.filter((m) => m.type === "embed")).toHaveLength(1);

    // Drain the in-flight warmup so it doesn't leak into the shared set.
    fakes[0].emit("message", {
      type: "result",
      id: fakes[0].lastPosted().id,
      vectors: [new Float32Array([0.1, 0.2, 0.3])],
    });
    await settleDocumentEmbeds();
  });

  it("does NOT count the warmup as a recall embed (no self-gating of backfill)", async () => {
    _persistEmbedCap(8192, 0);
    const fakes = installFakeWorkers();

    // Drive the real embed path (no spy) so the recall counter is exercised;
    // the fake worker won't reply until we tell it to, keeping the embed in
    // flight while we check the counter.
    warmupEmbedding();
    await flush();

    // A 'document' embed must never touch the recall-in-flight counter, or it
    // would park the temporal backfill on itself.
    expect(recallEmbedsInFlight()).toBe(0);

    // Complete + drain so nothing leaks into the shared in-flight set.
    fakes[0].emit("message", {
      type: "result",
      id: fakes[0].lastPosted().id,
      vectors: [new Float32Array([0.1, 0.2, 0.3])],
    });
    await settleDocumentEmbeds();
  });

  it("is a no-op for a remote provider — never hits the network (no quota burn)", async () => {
    // Voyage WITH a key → provider is available but NOT local. Removing the
    // local-only guard would make warmup call VoyageProvider.embed → a real
    // fetch to the Voyage API. Spy on fetch to prove warmup never does that.
    process.env.VOYAGE_API_KEY = "test-voyage-key-abcdefghijklmnop";
    await load(process.cwd());
    (config().search.embeddings as { provider: string }).provider = "voyage";
    _resetLocalProviderProbe();
    _saveAndClearProvider();
    expect(isAvailable()).toBe(true); // remote provider is available…

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), {
        status: 200,
      }),
    );

    warmupEmbedding();
    await flush();

    // …but warmup must skip it — no HTTP request, so no remote quota burned.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
