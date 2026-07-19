import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import {
  embed,
  isAvailable,
  LocalProviderUnavailableError,
  _persistEmbedCap,
  _resetLocalProviderProbe,
  _restoreProvider,
  _saveAndClearProvider,
  _setConstrainedMemoryForTest,
  _setContainerFreeForTest,
  _setTestWorkerFactory,
} from "../src/embedding";
import { EMBED_OOM_EXIT_CODE } from "../src/embedding-worker-types";
import type { WorkerInitData } from "../src/embedding-worker-types";

// Exercises the native→WASM fallback lifecycle in LocalProvider (#1379): when a
// native worker reports `init-needs-wasm` (it loaded the ONNX addon but couldn't
// parse an intact model — the Bun ↔ onnxruntime-node incompatibility), the main
// thread must respawn a FRESH worker forcing WASM and re-submit in-flight work.
// A fake worker (the _setTestWorkerFactory seam) drives the message/exit events
// deterministically without a real ONNX runtime.

type EmbedMsg = { type: string; id: number; maxTokens: number };

class FakeWorker extends EventEmitter {
  readonly posted: EmbedMsg[] = [];
  terminated = false;
  postMessage(msg: unknown): void {
    this.posted.push({ ...(msg as EmbedMsg) });
  }
  ref(): void {}
  unref(): void {}
  terminate(): Promise<number> {
    this.terminated = true;
    // Faithful to node:worker_threads: terminate() asynchronously emits an
    // `exit` event (non-zero code). The main thread's per-worker handler guard
    // (#1387-B1) must ignore this stale exit so it can't latch the provider or
    // clobber the freshly-spawned WASM worker. Emitting it here is what makes
    // this suite able to catch that regression.
    queueMicrotask(() => this.emit("exit", 1));
    return Promise.resolve(0);
  }
  lastPosted(): EmbedMsg {
    const m = this.posted.at(-1);
    if (!m) throw new Error("fake worker received no message");
    return m;
  }
}

/** Install the factory and collect (fake, initData) pairs it hands out. */
function installFakeWorkers(): Array<{
  fake: FakeWorker;
  init: WorkerInitData;
}> {
  const spawns: Array<{ fake: FakeWorker; init: WorkerInitData }> = [];
  _setTestWorkerFactory((init) => {
    const fake = new FakeWorker();
    spawns.push({ fake, init });
    return fake as unknown as Worker;
  });
  return spawns;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

function settle<T>(
  p: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; err: unknown }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (err) => ({ ok: false as const, err }),
  );
}

describe("embedding native→WASM fallback (#1379)", () => {
  let savedProvider: unknown;
  let savedVoyage: string | undefined;
  let savedOpenAI: string | undefined;

  beforeEach(() => {
    savedVoyage = process.env.VOYAGE_API_KEY;
    savedOpenAI = process.env.OPENAI_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    _setConstrainedMemoryForTest(0);
    _setContainerFreeForTest(16 * 1024 * 1024 * 1024);
    _resetLocalProviderProbe();
    savedProvider = _saveAndClearProvider();
  });

  afterEach(() => {
    _setTestWorkerFactory(null);
    _setContainerFreeForTest(null);
    _setConstrainedMemoryForTest(null);
    _resetLocalProviderProbe();
    _restoreProvider(savedProvider);
    if (savedVoyage !== undefined) process.env.VOYAGE_API_KEY = savedVoyage;
    if (savedOpenAI !== undefined) process.env.OPENAI_API_KEY = savedOpenAI;
  });

  it("respawns forcing WASM and re-submits the in-flight request on init-needs-wasm", async () => {
    _persistEmbedCap(8192, 0);
    const spawns = installFakeWorkers();

    const promise = embed(["hello world"], "query");
    await flush();

    expect(spawns).toHaveLength(1);
    // First worker spawned WITHOUT forceWasm (prefers native).
    expect(spawns[0].init.forceWasm ?? false).toBe(false);
    const first = spawns[0].fake.lastPosted();
    expect(first.type).toBe("embed");

    // Native loaded the addon but couldn't parse the (intact) model.
    spawns[0].fake.emit("message", {
      type: "init-needs-wasm",
      error: "Failed to load model because protobuf parsing failed",
    });
    await flush();

    // A fresh worker was spawned WITH forceWasm, and the native one terminated.
    expect(spawns).toHaveLength(2);
    expect(spawns[1].init.forceWasm).toBe(true);
    expect(spawns[0].fake.terminated).toBe(true);

    // The original request was re-submitted to the WASM worker (same id).
    const resubmitted = spawns[1].fake.lastPosted();
    expect(resubmitted.type).toBe("embed");
    expect(resubmitted.id).toBe(first.id);

    // WASM worker succeeds → the caller's promise resolves.
    spawns[1].fake.emit("message", {
      type: "result",
      id: resubmitted.id,
      vectors: [new Float32Array([0.1, 0.2, 0.3])],
    });
    const vectors = await promise;
    expect(vectors).toHaveLength(1);
    expect(isAvailable()).toBe(true);
  });

  it("keeps forceWasm sticky across a later OOM respawn", async () => {
    _persistEmbedCap(8192, 0);
    const spawns = installFakeWorkers();

    const result = settle(embed(["hello world"], "query"));
    await flush();

    // Native → WASM fallback.
    spawns[0].fake.emit("message", {
      type: "init-needs-wasm",
      error: "protobuf parsing failed",
    });
    await flush();
    expect(spawns).toHaveLength(2);
    expect(spawns[1].init.forceWasm).toBe(true);

    // The WASM worker then OOMs → respawn must STILL force WASM (never bounce
    // back to the native runtime that already failed).
    spawns[1].fake.emit("exit", EMBED_OOM_EXIT_CODE);
    await flush();
    expect(spawns).toHaveLength(3);
    expect(spawns[2].init.forceWasm).toBe(true);

    spawns[2].fake.emit("message", {
      type: "result",
      id: spawns[2].fake.lastPosted().id,
      vectors: [new Float32Array([0.1])],
    });
    const r = await result;
    expect(r.ok).toBe(true);
  });

  it("treats a second init-needs-wasm (WASM also fails) as a genuine init failure — no respawn loop", async () => {
    _persistEmbedCap(8192, 0);
    const spawns = installFakeWorkers();

    const result = settle(embed(["hello world"], "query"));
    await flush();

    // Native fails → respawn onto WASM (spawn #2).
    spawns[0].fake.emit("message", {
      type: "init-needs-wasm",
      error: "protobuf parsing failed",
    });
    await flush();
    expect(spawns).toHaveLength(2);

    // WASM ALSO reports it can't load — one-shot latch: do NOT respawn again.
    spawns[1].fake.emit("message", {
      type: "init-needs-wasm",
      error: "protobuf parsing failed",
    });
    await flush();

    expect(spawns).toHaveLength(2); // did NOT loop into a 3rd spawn
    const r = await result;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.err).toBeInstanceOf(LocalProviderUnavailableError);
  });

  it("stays available and re-submits when the native worker emits the full real protocol (init-needs-wasm + trailing per-request error + terminate exit)", async () => {
    // #1387-B1+B2 regression: the REAL native worker, on a WASM-fallback init,
    // (1) posts `init-needs-wasm`, (2) rejects the triggering request so
    // processEmbed posts a trailing `{type:"error", id}`, and (3) is terminated
    // by the main thread, which asynchronously emits `exit(1)`. Naively, (2)
    // drops the pending before resubmit and (3) latches the provider broken —
    // both reproduce the #1379 symptom (isAvailable()===false, embed dropped).
    // The fix (worker suppresses the trailing error under wasmRespawnRequested;
    // main thread guards handlers per-worker) must keep the caller alive.
    _persistEmbedCap(8192, 0);
    const spawns = installFakeWorkers();

    const promise = embed(["hello world"], "query");
    await flush();
    expect(spawns).toHaveLength(1);
    const first = spawns[0].fake.lastPosted();

    // Native can't parse the intact model → request WASM respawn. The worker
    // does NOT post a per-request error for this request (it's being resubmitted).
    spawns[0].fake.emit("message", {
      type: "init-needs-wasm",
      error: "Failed to load model because protobuf parsing failed",
    });
    // The REAL worker's processEmbed catch would fire right after — with the B2
    // fix it stays silent, but a regressed worker (or the main thread not
    // guarding it) would post this trailing error for the SAME request id.
    // Emitting it here asserts the main thread does NOT let it drop the pending
    // before the resubmit. (Post-fix the worker won't send it; this models the
    // adversarial worst case where it still arrives.)
    spawns[0].fake.emit("message", {
      type: "error",
      id: first.id,
      error: "embedding worker awaiting WASM respawn",
    });
    await flush();

    // Fresh WASM worker spawned; the stale native worker was terminated and its
    // async exit(1) must have been ignored (per-worker handler guard).
    expect(spawns).toHaveLength(2);
    expect(spawns[1].init.forceWasm).toBe(true);
    expect(spawns[0].fake.terminated).toBe(true);

    // The request was re-submitted to the WASM worker (not dropped by a trailing
    // error and not lost to the terminated worker's exit).
    const resubmitted = spawns[1].fake.lastPosted();
    expect(resubmitted.type).toBe("embed");
    expect(resubmitted.id).toBe(first.id);

    // WASM worker succeeds → caller resolves; provider stays available.
    spawns[1].fake.emit("message", {
      type: "result",
      id: resubmitted.id,
      vectors: [new Float32Array([0.1])],
    });
    const vectors = await promise;
    expect(vectors).toHaveLength(1);
    expect(isAvailable()).toBe(true);
  });
});
