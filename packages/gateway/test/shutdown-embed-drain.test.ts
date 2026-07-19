/**
 * Regression test for issue #1331: on graceful gateway shutdown, in-flight
 * fire-and-forget document embeds (esp. a distillation embed created this
 * session) must be DRAINED before the embedding worker is torn down, or their
 * `distillation_vec` rows are never written → silent recall degradation on
 * short/fast sessions.
 *
 * The `shutdown` closure built in `startGateway()` must call
 * `embedding.settleDocumentEmbeds(<bounded>)` BEFORE `embedding.resetProvider()`
 * (which kills the worker), and the drain must be bounded so a stuck embed can
 * never reintroduce the Ctrl+C hang.
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

  it("calls settleDocumentEmbeds(bounded) before resetProvider on shutdown", async () => {
    const { startGateway } = await import("../src/cli/start");

    const order: string[] = [];
    let drainArg: number | undefined = -1;
    const drainSpy = vi
      .spyOn(embedding, "settleDocumentEmbeds")
      .mockImplementation(async (timeoutMs?: number) => {
        order.push("drain");
        drainArg = timeoutMs;
      });
    const resetSpy = vi
      .spyOn(embedding, "resetProvider")
      .mockImplementation(async () => {
        order.push("reset");
      });

    const handle = await startGateway({ port: 0, local: true, quiet: true });
    expect(handle.owned).toBe(true);

    await handle.shutdown();

    // Drain must run, and run BEFORE the worker is reset/killed.
    expect(order).toEqual(["drain", "reset"]);
    expect(drainSpy).toHaveBeenCalledTimes(1);
    expect(resetSpy).toHaveBeenCalledTimes(1);

    // The drain is BOUNDED (a finite, positive deadline) — never an unbounded
    // wait that could hang Ctrl+C.
    expect(typeof drainArg).toBe("number");
    expect(drainArg).toBeGreaterThan(0);
    expect(Number.isFinite(drainArg)).toBe(true);
  });
});
