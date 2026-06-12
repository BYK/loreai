/**
 * Tests for the bounded embedding-worker shutdown (awaitWorkerShutdown).
 *
 * The real hazard: the worker can be mid-inference in an uninterruptible
 * single-threaded ONNX batch and never emit "exit", which used to hang process
 * shutdown indefinitely. These tests verify the cooperative path, the
 * force-terminate timeout path, and the already-gone path — all without
 * spawning a real worker thread.
 */
import { describe, test, expect, vi } from "vitest";
import { awaitWorkerShutdown } from "../src/embedding";
import type { WorkerInbound } from "../src/embedding-worker-types";

interface FakeOpts {
  /** Emit "exit" automatically (microtask) after a successful postMessage. */
  autoExit?: boolean;
  /** Throw from postMessage to simulate an already-dead worker. */
  throwOnPost?: boolean;
}

function makeFakeWorker(opts: FakeOpts = {}) {
  let exitCb: (() => void) | undefined;
  const calls = { posted: [] as WorkerInbound[], terminated: 0 };
  const worker = {
    on(_event: "exit", listener: () => void) {
      exitCb = listener;
      return worker;
    },
    postMessage(value: WorkerInbound) {
      if (opts.throwOnPost) throw new Error("worker already gone");
      calls.posted.push(value);
      if (opts.autoExit) queueMicrotask(() => exitCb?.());
    },
    async terminate() {
      calls.terminated++;
      // Real Worker.terminate() ends the thread (which fires "exit"); emulate.
      exitCb?.();
      return 0;
    },
  };
  return { worker, calls, emitExit: () => exitCb?.() };
}

describe("awaitWorkerShutdown", () => {
  test("resolves on cooperative exit without terminating", async () => {
    const { worker, calls } = makeFakeWorker({ autoExit: true });
    await awaitWorkerShutdown(worker, 1000);
    expect(calls.posted).toEqual([{ type: "shutdown" }]);
    expect(calls.terminated).toBe(0);
  });

  test("force-terminates when the worker never emits exit", async () => {
    const { worker, calls } = makeFakeWorker(); // never auto-exits
    const start = Date.now();
    await awaitWorkerShutdown(worker, 20);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(calls.posted).toEqual([{ type: "shutdown" }]);
    expect(calls.terminated).toBe(1);
  });

  test("resolves immediately when postMessage throws (already gone)", async () => {
    const { worker, calls } = makeFakeWorker({ throwOnPost: true });
    const terminateSpy = vi.spyOn(worker, "terminate");
    await awaitWorkerShutdown(worker, 1000);
    expect(calls.terminated).toBe(0);
    expect(terminateSpy).not.toHaveBeenCalled();
  });
});
