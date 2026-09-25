import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    availableParallelism: () => 4,
    cpus: () => Array(4).fill(actual.cpus()[0]),
  };
});

import { LocalProvider, _setTestWorkerFactory } from "../src/embedding/local";
import { EmbeddingPool, _setPoolFreememForTest } from "../src/embedding/pool";
import { _setConstrainedMemoryForTest } from "../src/embedding/local";
import type { WorkerInitData } from "../src/embedding-worker-types";

afterEach(() => _setTestWorkerFactory(null));

test("a four-core host passes the pool-aware native thread count to a worker", async () => {
  const inits: WorkerInitData[] = [];
  const worker = new EventEmitter() as EventEmitter & {
    postMessage: (message: { type: string; id?: number }) => void;
    unref: () => void;
    ref: () => void;
    terminate: () => Promise<number>;
  };
  worker.unref = () => {};
  worker.ref = () => {};
  worker.terminate = async () => {
    worker.emit("exit", 0);
    return 0;
  };
  worker.postMessage = (message) => {
    if (message.type === "embed") {
      queueMicrotask(() =>
        worker.emit("message", {
          type: "result",
          id: message.id,
          vectors: [new Float32Array(128)],
        }),
      );
    } else if (message.type === "shutdown") {
      worker.emit("exit", 0);
    }
  };
  _setTestWorkerFactory((data) => {
    inits.push(data);
    return worker as unknown as Worker;
  });
  const provider = new LocalProvider("test-model", 128, 2);
  try {
    await provider.embed(["small host"], "document");
    expect(inits).toHaveLength(1);
    expect(inits[0].intraOpThreads).toBe(1);
  } finally {
    await provider.shutdown();
  }
});

test("a four-core host bounds even a configured eight-worker pool to three", async () => {
  const oldEnv = process.env.NODE_ENV;
  const oldPoolSize = process.env.LORE_EMBED_POOL_SIZE;
  process.env.NODE_ENV = "production";
  process.env.LORE_EMBED_POOL_SIZE = "8";
  _setPoolFreememForTest(64 * 1024 ** 3);
  _setConstrainedMemoryForTest(0);
  const inits: WorkerInitData[] = [];
  const workers: Array<{ complete: () => void }> = [];
  _setTestWorkerFactory((data) => {
    inits.push(data);
    const worker = new EventEmitter() as EventEmitter & {
      postMessage: (message: { type: string; id?: number }) => void;
      unref: () => void;
      ref: () => void;
      terminate: () => Promise<number>;
    };
    const ids: number[] = [];
    worker.unref = () => {};
    worker.ref = () => {};
    worker.terminate = async () => {
      worker.emit("exit", 0);
      return 0;
    };
    worker.postMessage = (message) => {
      if (message.type === "embed" && message.id !== undefined) {
        ids.push(message.id);
      } else if (message.type === "shutdown") {
        worker.emit("exit", 0);
      }
    };
    workers.push({
      complete: () => {
        for (const id of ids.splice(0)) {
          worker.emit("message", {
            type: "result",
            id,
            vectors: [new Float32Array(128)],
          });
        }
      },
    });
    return worker as unknown as Worker;
  });
  const pool = new EmbeddingPool("test-model", 128);
  let pending: Promise<unknown>[] = [];
  try {
    const warm = pool.embed(["bootstrap"], "document");
    await new Promise((resolve) => setTimeout(resolve, 0));
    workers[0].complete();
    await warm;
    pending = Array.from({ length: 8 }, (_, index) =>
      pool.embed([`distinct work ${index}`], "document"),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inits).toHaveLength(3);
    expect(inits.every((init) => init.intraOpThreads === 1)).toBe(true);
  } finally {
    await pool.shutdown();
    await Promise.allSettled(pending);
    _setPoolFreememForTest(null);
    _setConstrainedMemoryForTest(null);
    if (oldEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldEnv;
    if (oldPoolSize === undefined) delete process.env.LORE_EMBED_POOL_SIZE;
    else process.env.LORE_EMBED_POOL_SIZE = oldPoolSize;
  }
});
