/**
 * Regression test for issue #1331: on graceful gateway shutdown, in-flight
 * fire-and-forget document embeds (esp. a distillation embed created this
 * session) must be DRAINED before the embedding worker is torn down, or their
 * `distillation_vec` rows are never written → silent recall degradation on
 * short/fast sessions.
 *
 * The `shutdown` closure built in `startGateway()` must call
 * `embedding.settleDocumentEmbeds(<bounded>)` before
 * `embedding.shutdownProvider()` (which kills the worker), then confirm full
 * quiescence afterward. Both waits must be bounded so a stuck embed can never
 * reintroduce the Ctrl+C hang.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { embedding } from "@loreai/core";

describe("startGateway shutdown drains in-flight embeds (issue #1331)", () => {
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

  it("drains document embeds before disabling the provider on shutdown", async () => {
    const { startGateway } = await import("../src/cli/start");

    const order: string[] = [];
    const drainArgs: Array<
      Parameters<typeof embedding.settleDocumentEmbeds>[0]
    > = [];
    const drainSpy = vi
      .spyOn(embedding, "settleDocumentEmbeds")
      .mockImplementation(
        async (
          timeoutMs?: Parameters<typeof embedding.settleDocumentEmbeds>[0],
        ) => {
          order.push("drain");
          drainArgs.push(timeoutMs);
        },
      );
    const resetSpy = vi
      .spyOn(embedding, "shutdownProvider")
      .mockImplementation(async () => {
        order.push("reset");
      });

    const handle = await startGateway({ port: 0, local: true, quiet: true });
    expect(handle.owned).toBe(true);

    await handle.shutdown();

    // First allow cooperative completion, then disable/stop the worker and
    // confirm no DB-capable continuation remains before SQLite can close.
    expect(order).toEqual(["drain", "reset", "drain"]);
    expect(drainSpy).toHaveBeenCalledTimes(2);
    expect(resetSpy).toHaveBeenCalledTimes(1);

    // Both phases are bounded. The final options form throws on deadline
    // instead of treating a still-live producer as quiescent.
    expect(typeof drainArgs[0]).toBe("number");
    expect(drainArgs[0]).toBeGreaterThan(0);
    expect(Number.isFinite(drainArgs[0])).toBe(true);
    expect(drainArgs[1]).toEqual({ deadlineMs: expect.any(Number) });
    expect((drainArgs[1] as { deadlineMs: number }).deadlineMs).toBeGreaterThan(
      0,
    );
  });
});
