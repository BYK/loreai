import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import {
  embed,
  isAvailable,
  LocalProviderUnavailableError,
  _resetLocalProviderProbe,
  _restoreProvider,
  _saveAndClearProvider,
  _setLocalInitCooldownMsForTest,
  _setTestWorkerFactory,
} from "../src/embedding";

// Drives the LocalProvider init lifecycle via a fake worker to prove that a
// TRANSIENT model-init failure (e.g. the ONNX model read while a concurrent
// process was still writing it during a multi-instance restart) self-heals —
// a fresh-worker retry after a cooldown — instead of latching the provider
// FTS-only for the whole process lifetime. A persistent failure still latches
// after the retry budget; a missing optional stack latches immediately.

type PostedMsg = { type: string; id: number };

class FakeWorker extends EventEmitter {
  readonly posted: PostedMsg[] = [];
  terminated = false;
  postMessage(msg: unknown): void {
    this.posted.push({ ...(msg as PostedMsg) });
  }
  ref(): void {}
  unref(): void {}
  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }
  lastPosted(): PostedMsg {
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

function settle<T>(
  p: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; err: unknown }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (err) => ({ ok: false as const, err }),
  );
}

// A transient parse failure of an intact model (the reported production error).
const TRANSIENT_ERR =
  "Can't create a session. ERROR_CODE: 7, ERROR_MESSAGE: Failed to load model because protobuf parsing failed.";
// A non-self-healing cause: the optional local-embedding stack isn't installed.
const MISSING_STACK_ERR = "Cannot find package 'onnxruntime-node'";

describe("local embedding init retry (transient self-heal)", () => {
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

  afterEach(() => {
    _setTestWorkerFactory(null);
    _setLocalInitCooldownMsForTest(null);
    _resetLocalProviderProbe();
    _restoreProvider(savedProvider);
    if (savedVoyage !== undefined) process.env.VOYAGE_API_KEY = savedVoyage;
    if (savedOpenAI !== undefined) process.env.OPENAI_API_KEY = savedOpenAI;
  });

  /** Spawn the next worker, fail its init with `error`, and assert the in-flight
   *  embed rejected with LocalProviderUnavailableError. */
  async function failInit(fakes: FakeWorker[], error: string): Promise<void> {
    const p = settle(embed(["q"], "query"));
    await flush();
    const worker = fakes.at(-1);
    if (!worker) throw new Error("no worker spawned");
    worker.emit("message", { type: "init-error", error });
    await flush();
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.err).toBeInstanceOf(LocalProviderUnavailableError);
  }

  it("stays FTS-only during the cooldown without prematurely retrying", async () => {
    _setLocalInitCooldownMsForTest(60_000); // long → still cooling down
    const fakes = installFakeWorkers();
    await failInit(fakes, TRANSIENT_ERR);

    // Cooling down → unavailable, and crucially NOT respawning a worker yet.
    expect(isAvailable()).toBe(false);
    expect(isAvailable()).toBe(false);
    expect(fakes).toHaveLength(1);
  });

  it("retries a fresh worker after the cooldown and recovers on success", async () => {
    _setLocalInitCooldownMsForTest(0); // retry on the next availability check
    const fakes = installFakeWorkers();
    await failInit(fakes, TRANSIENT_ERR);

    // Cooldown elapsed → available again (this discards the dead pool).
    expect(isAvailable()).toBe(true);

    // The next embed spawns a FRESH worker; complete it → recovery.
    const p2 = settle(embed(["q2"], "query"));
    await flush();
    expect(fakes.length).toBeGreaterThanOrEqual(2);
    const worker = fakes.at(-1);
    if (!worker) throw new Error("no fresh worker spawned");
    worker.emit("message", {
      type: "result",
      id: worker.lastPosted().id,
      vectors: [new Float32Array([1, 2, 3])],
    });
    const r2 = await p2;
    expect(r2.ok).toBe(true);
    expect(isAvailable()).toBe(true);
  });

  it("latches permanently only after the retry budget is exhausted", async () => {
    _setLocalInitCooldownMsForTest(0);
    const fakes = installFakeWorkers();

    await failInit(fakes, TRANSIENT_ERR); // attempt 1
    expect(isAvailable()).toBe(true); // retry armed
    await failInit(fakes, TRANSIENT_ERR); // attempt 2
    expect(isAvailable()).toBe(true); // retry armed
    await failInit(fakes, TRANSIENT_ERR); // attempt 3 → give up

    expect(isAvailable()).toBe(false); // permanently broken
    expect(isAvailable()).toBe(false); // stays broken (no further retries)
  });

  it("latches immediately (no retry) when the optional stack is missing", async () => {
    _setLocalInitCooldownMsForTest(0);
    const fakes = installFakeWorkers();
    await failInit(fakes, MISSING_STACK_ERR);

    // A missing optional stack will not self-heal → broken on the first failure.
    expect(isAvailable()).toBe(false);
    expect(fakes).toHaveLength(1); // never respawned
  });
});
