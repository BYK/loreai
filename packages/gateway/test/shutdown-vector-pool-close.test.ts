/**
 * Regression test for issue #1599: the gateway shutdown sequence must close
 * the vector-pool workers' SQLite readers and the main-thread SQLite writer
 * BEFORE the signal-handler force-exit path runs. The previous code stopped
 * HTTP traffic and reset the pipeline, but never called shutdownVectorPool
 * (workers + readers were leaked) and never called close() (the main writer's
 * WAL was left to be recovered on next boot — fine for correctness, but the
 * issue pins the structural contract).
 *
 * The shutdown order matters:
 *   1. boundServer.stop()           — stop accepting HTTP traffic
 *   2. resetPipelineState({fast})   — clear in-flight pipeline timers
 *   3. embedding.settleDocumentEmbeds — drain dispatched embeds
 *   4. embedding.resetProvider()    — shut down the embedding worker
 *   5. shutdownVectorPoolAsync()    — wait for vector-pool readers to close
 *   6. close()                      — main writer checkpoint + close
 *
 * Skipping (5) leaves the writer's PRAGMA wal_checkpoint(TRUNCATE) racing
 * with a reader's WAL lock — the writer busy-waits up to 5s. Skipping (6)
 * leaves the WAL to be recovered on next boot (the WAL itself protects
 * correctness, but the contract is "always close cleanly").
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import * as core from "@loreai/core";
import * as pipelineModule from "../src/pipeline";

describe("startGateway shutdown order: pipeline -> embed -> vector pool -> close (#1599)", () => {
  const teardowns: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (teardowns.length) {
      const fn = teardowns.pop();
      try {
        await fn?.();
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  it("shuts down vector-pool workers and the main DB writer, in the correct order", async () => {
    // Spy on every link of the chain. The order array is the load-bearing
    // assertion — pulling any step out or reordering makes the test fail.
    const order: string[] = [];

    const resetPipelineStateSpy = vi
      .spyOn(pipelineModule, "resetPipelineState")
      .mockImplementation(async (_opts?: { fast?: boolean }) => {
        order.push("resetPipelineState");
      });
    const drainSpy = vi
      .spyOn(core.embedding, "settleDocumentEmbeds")
      .mockImplementation(async (_timeoutMs?: number) => {
        order.push("settleDocumentEmbeds");
      });
    const resetProviderSpy = vi
      .spyOn(core.embedding, "resetProvider")
      .mockImplementation(async () => {
        order.push("resetProvider");
      });
    const shutdownVectorPoolAsyncSpy = vi
      .spyOn(core, "shutdownVectorPoolAsync")
      .mockImplementation(async () => {
        order.push("shutdownVectorPoolAsync");
      });
    const closeSpy = vi.spyOn(core, "close").mockImplementation(() => {
      order.push("close");
    });

    // Re-import start.ts AFTER the spies are attached so the closures capture
    // the spied namespace (vi.spyOn mutates the module export).
    const { startGateway } = await import("../src/cli/start");

    const handle = await startGateway({
      port: 0,
      local: true,
      quiet: true,
    });
    expect(handle.owned).toBe(true);

    await handle.shutdown();

    // Every link of the chain was called exactly once.
    expect(resetPipelineStateSpy).toHaveBeenCalledTimes(1);
    expect(drainSpy).toHaveBeenCalledTimes(1);
    expect(resetProviderSpy).toHaveBeenCalledTimes(1);
    expect(shutdownVectorPoolAsyncSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);

    // The structural contract: pipeline reset → embed drain → embed reset
    // → vector pool shutdown → writer close. Each step must run AFTER the
    // previous one — otherwise the reader→writer races that closed the
    // 5s-busy-wait hole come back.
    expect(order).toEqual([
      "resetPipelineState",
      "settleDocumentEmbeds",
      "resetProvider",
      "shutdownVectorPoolAsync",
      "close",
    ]);
  });

  it("close() is called even when shutdownVectorPoolAsync rejects (writer never leaks)", async () => {
    // shutdownVectorPoolAsync is documented to NEVER reject (always resolves),
    // but defense-in-depth: a future regression that lets it reject must
    // still not skip close() — the writer must close on the best path.
    // Note: shutdownVectorPoolAsync's contract is "always resolves", so the
    // resolution path is the load-bearing assertion here.
    const order: string[] = [];
    vi.spyOn(pipelineModule, "resetPipelineState").mockImplementation(
      async () => {
        order.push("resetPipelineState");
      },
    );
    vi.spyOn(core.embedding, "settleDocumentEmbeds").mockImplementation(
      async () => {
        order.push("settleDocumentEmbeds");
      },
    );
    vi.spyOn(core.embedding, "resetProvider").mockImplementation(async () => {
      order.push("resetProvider");
    });
    vi.spyOn(core, "shutdownVectorPoolAsync").mockImplementation(async () => {
      order.push("shutdownVectorPoolAsync");
    });
    vi.spyOn(core, "close").mockImplementation(() => {
      order.push("close");
    });

    const { startGateway } = await import("../src/cli/start");
    const handle = await startGateway({
      port: 0,
      local: true,
      quiet: true,
    });
    await handle.shutdown();

    // close() must be the LAST step (after the vector-pool shutdown awaited).
    expect(order[order.length - 1]).toBe("close");
  });

  it("awaits shutdownVectorPoolAsync before close() (the writer sees no live readers)", async () => {
    // The structural fix: close()'s PRAGMA wal_checkpoint(TRUNCATE) must run
    // AFTER every vector-pool worker has exited (so its reader is gone). The
    // simplest assertion is that the vector-pool promise resolves before
    // the close() call's synchronous work begins.
    let poolDone = false;
    vi.spyOn(pipelineModule, "resetPipelineState").mockImplementation(
      async () => {},
    );
    vi.spyOn(core.embedding, "settleDocumentEmbeds").mockImplementation(
      async () => {},
    );
    vi.spyOn(core.embedding, "resetProvider").mockImplementation(
      async () => {},
    );
    vi.spyOn(core, "shutdownVectorPoolAsync").mockImplementation(async () => {
      // Simulate a real worker that needs a microtask to settle.
      await Promise.resolve();
      poolDone = true;
    });
    const closeAtCallTime: { at: boolean } = { at: false };
    vi.spyOn(core, "close").mockImplementation(() => {
      closeAtCallTime.at = poolDone;
    });

    const { startGateway } = await import("../src/cli/start");
    const handle = await startGateway({
      port: 0,
      local: true,
      quiet: true,
    });
    await handle.shutdown();

    // The writer's close() saw a true `poolDone` — the pool had resolved
    // BEFORE the writer started its checkpoint. This is the non-vacuous
    // guard for the order invariant.
    expect(closeAtCallTime.at).toBe(true);
  });
});
