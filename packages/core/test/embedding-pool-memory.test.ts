import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import {
  embed,
  _persistEmbedCap,
  _resetLocalProviderProbe,
  _restoreProvider,
  _saveAndClearProvider,
  _setConstrainedMemoryForTest,
  _setContainerFreeForTest,
  _setEmbedPoolSizeForTest,
  _setPoolFreememForTest,
  _setTestWorkerFactory,
} from "../src/embedding";
import { backoffEmbedCap, memoryModelEmbedCap } from "../src/embedding-cap";
import { EMBED_OOM_EXIT_CODE } from "../src/embedding-worker-types";

// Regression suite for the embedding-pool OOM that SIGKILLed the whole gateway
// (Onur's report): the pool grew to N workers, each independently sized its
// token cap to consume ~half of free memory, so the sum ran the host out of RAM.
// On the native ONNX path that OOM is an uncatchable SIGKILL — the ×0.7 backoff
// never fires — so the ONLY defense is never over-allocating in the first place.
// These tests pin the two guards: (1) each worker sizes from free / ceiling, and
// (2) the cap is re-clamped to CURRENT free memory on every request, not just at
// construction.

const GB = 1024 * 1024 * 1024;

type EmbedMsg = { type: string; id: number; maxTokens: number };

/** Minimal stand-in for a node:worker_threads Worker that captures the exact
 *  per-request payload the provider posts (snapshotting, since the production
 *  payload object is mutated in place on OOM re-submit). It never posts a
 *  "result", so the embed promise stays pending — which is fine, we only assert
 *  on what was sent to the worker. */
class CapturingWorker extends EventEmitter {
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

function installCapturingWorkers(): CapturingWorker[] {
  const fakes: CapturingWorker[] = [];
  _setTestWorkerFactory(() => {
    const f = new CapturingWorker();
    fakes.push(f);
    return f as unknown as Worker;
  });
  return fakes;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/** Attach handlers immediately so the never-resolving embed promise is never
 *  flagged as an unhandled rejection when the provider is torn down. */
function settle<T>(p: Promise<T>): Promise<unknown> {
  return p.then(
    (v) => v,
    (e) => e,
  );
}

describe("embedding pool memory sizing (OOM regression)", () => {
  let savedProvider: unknown;
  let savedVoyage: string | undefined;
  let savedOpenAI: string | undefined;

  beforeEach(() => {
    savedVoyage = process.env.VOYAGE_API_KEY;
    savedOpenAI = process.env.OPENAI_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    // Neutralize any real cgroup limit on the CI box so _setContainerFreeForTest
    // is the sole authority for free-memory sizing.
    _setConstrainedMemoryForTest(0);
    _resetLocalProviderProbe();
    savedProvider = _saveAndClearProvider();
  });

  afterEach(() => {
    _setTestWorkerFactory(null);
    _setEmbedPoolSizeForTest(null);
    _setPoolFreememForTest(null);
    _setContainerFreeForTest(null);
    _setConstrainedMemoryForTest(null);
    _resetLocalProviderProbe();
    _restoreProvider(savedProvider);
    if (savedVoyage !== undefined) process.env.VOYAGE_API_KEY = savedVoyage;
    if (savedOpenAI !== undefined) process.env.OPENAI_API_KEY = savedOpenAI;
  });

  it("sizes each pool worker's cap from free / ceiling, not full free memory", async () => {
    // Pin the learned cap high (freeMemBytes=0 → trust band ignores host free),
    // so the per-request cap is governed purely by the live free-memory model —
    // isolating the divisor.
    _persistEmbedCap(8192, 0);
    _setEmbedPoolSizeForTest(2); // ceiling = 2 → memDivisor = 2
    _setContainerFreeForTest(6 * GB);
    const fakes = installCapturingWorkers();

    void settle(embed(["some document text to embed"], "document"));
    await flush();

    expect(fakes).toHaveLength(1);
    const posted = fakes[0].lastPosted();
    const dividedCap = memoryModelEmbedCap((6 * GB) / 2);
    const undividedCap = memoryModelEmbedCap(6 * GB);

    // The cap must reflect this worker's SHARE (free / ceiling), so two such
    // workers together stay within one memory-fraction budget instead of each
    // claiming half and summing to an OOM.
    expect(posted.maxTokens).toBe(dividedCap);
    // Guard against the bug: sizing from full free (the pre-fix behavior) yields
    // a strictly larger cap. If these were equal the test couldn't see the fix.
    expect(dividedCap).toBeLessThan(undividedCap);
    expect(posted.maxTokens).toBeLessThan(undividedCap);
  });

  it("re-clamps the cap to CURRENT free memory when it drops after construction", async () => {
    // ceiling = 1 → divisor = 1, isolating the current-free clamp from the
    // divisor. The learned cap is pinned high so only live free memory moves it.
    _persistEmbedCap(8192, 0);
    _setEmbedPoolSizeForTest(1);
    const fakes = installCapturingWorkers();

    // Construct + first request while free memory is ample.
    _setContainerFreeForTest(6 * GB);
    void settle(embed(["first request while memory is ample"], "document"));
    await flush();
    expect(fakes).toHaveLength(1);
    const firstCap = fakes[0].lastPosted().maxTokens;

    // Free memory collapses (sibling workers + live sessions allocate). The next
    // request must be sized DOWN to what's now available — a construction-time
    // cap would trigger the uncatchable native OOM here.
    _setContainerFreeForTest(2 * GB);
    void settle(embed(["second request after memory dropped"], "document"));
    await flush();

    // Same worker (pool never grew — ceiling 1), so we see two posts on it.
    expect(fakes).toHaveLength(1);
    const secondCap = fakes[0].lastPosted().maxTokens;

    expect(firstCap).toBe(memoryModelEmbedCap(6 * GB));
    expect(secondCap).toBe(memoryModelEmbedCap(2 * GB));
    expect(secondCap).toBeLessThan(firstCap);
  });

  it("clamps the OOM-respawn resubmit to current free memory, not just the ×0.7 backoff", async () => {
    // The OOM-respawn resubmit payload is posted directly (no later
    // effectiveMaxTokens), so it is the ONLY cap on the native-SIGKILL retry
    // path. Pin the learned cap high, embed while memory is ample, then DROP
    // free BEFORE the worker OOMs: the resubmit must be sized to the dropped
    // free, not merely the ×0.7 backoff of the (larger) construction-time cap.
    _persistEmbedCap(8192, 0);
    _setEmbedPoolSizeForTest(1); // divisor 1 → isolate the clamp
    _setContainerFreeForTest(16 * GB);
    const fakes = installCapturingWorkers();

    void settle(embed(["a document to embed under ample memory"], "document"));
    await flush();
    expect(fakes).toHaveLength(1);
    const first = fakes[0].lastPosted();

    // Memory collapses, then the worker OOM-exits → respawn re-submits the same
    // request on a fresh worker.
    _setContainerFreeForTest(2 * GB);
    fakes[0].emit("exit", EMBED_OOM_EXIT_CODE);
    await flush();

    expect(fakes.length).toBeGreaterThanOrEqual(2);
    const resubmitted = fakes[1].lastPosted();
    expect(resubmitted.id).toBe(first.id);
    // min(backoff(first), memoryModelEmbedCap(2GB)) === memoryModelEmbedCap(2GB).
    expect(resubmitted.maxTokens).toBe(memoryModelEmbedCap(2 * GB));
    expect(resubmitted.maxTokens).toBeLessThan(
      backoffEmbedCap(first.maxTokens),
    );
  });
});
