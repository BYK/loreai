import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import {
  embedKnowledgeEntry,
  isAvailable,
  settleDocumentEmbeds,
  _persistEmbedCap,
  _resetLocalProviderProbe,
  _restoreProvider,
  _saveAndClearProvider,
  _setTestWorkerFactory,
} from "../src/embedding";
import { settleBackgroundWork } from "../src/distillation";

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
