/**
 * Regression tests for `singleFlightStableLtm` — the per-session dedup
 * wrapper around the stable-LTM compute.
 *
 * Regression for the "Provider response headers timed out after 10000ms"
 * issue: when a client header-timeout retry burst fires 3 concurrent identical
 * turns at a cold session, all three must share ONE in-flight compute rather
 * than re-running ltm.forSession/entity/catalog on a duplicated critical path.
 * The settled value lands in `stableLtmCache` before the in-flight promise
 * resolves, so concurrent awaiters re-read it race-free.
 *
 * Uses `vi.resetModules()` to get a fresh pipeline module per test so the
 * module-level `stableLtmCache` and `stableLtmInFlight` maps are isolated.
 */
import { describe, test, expect, vi } from "vitest";

describe("singleFlightStableLtm", () => {
  test("concurrent callers share ONE compute; compute runs exactly once", async () => {
    vi.resetModules();
    const { singleFlightStableLtm } = await import("../src/pipeline");

    const compute = vi.fn(async () => ({
      formatted: "shared result",
      tokenCount: 42,
    }));

    // Fire 5 concurrent calls for the same session.
    const results = await Promise.all(
      [0, 0, 0, 0, 0].map(() => singleFlightStableLtm("session-A", compute)),
    );

    // All callers received the same settled value.
    expect(compute).toHaveBeenCalledTimes(1);
    for (const r of results)
      expect(r).toEqual({ formatted: "shared result", tokenCount: 42 });
  });

  test("serial callers (after settle) re-use the cache without re-computing", async () => {
    vi.resetModules();
    const { singleFlightStableLtm } = await import("../src/pipeline");

    const compute = vi.fn(async () => ({
      formatted: "first",
      tokenCount: 1,
    }));

    const first = await singleFlightStableLtm("session-B", compute);
    const second = await singleFlightStableLtm("session-B", compute);
    const third = await singleFlightStableLtm("session-B", compute);

    expect(compute).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(second).toEqual(third);
  });

  test("different sessions compute independently", async () => {
    vi.resetModules();
    const { singleFlightStableLtm } = await import("../src/pipeline");

    const compute = vi.fn(async (s: string) => ({
      formatted: `result-${s}`,
      tokenCount: s.length,
    }));

    const [a, b, c] = await Promise.all([
      singleFlightStableLtm("session-X", () => compute("X")),
      singleFlightStableLtm("session-Y", () => compute("Y")),
      singleFlightStableLtm("session-Z", () => compute("Z")),
    ]);

    expect(compute).toHaveBeenCalledTimes(3);
    expect(a).toEqual({ formatted: "result-X", tokenCount: 1 });
    expect(b).toEqual({ formatted: "result-Y", tokenCount: 1 });
    expect(c).toEqual({ formatted: "result-Z", tokenCount: 1 });
  });

  test("a throwing compute leaves the cache empty for the next attempt", async () => {
    vi.resetModules();
    const { singleFlightStableLtm } = await import("../src/pipeline");

    let attempts = 0;
    const flaky = vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw new Error("transient");
      return { formatted: "ok", tokenCount: 1 };
    });

    await expect(singleFlightStableLtm("session-flaky", flaky)).rejects.toThrow(
      "transient",
    );

    // The in-flight entry was cleared by the `finally`; the next call is a
    // fresh compute (NOT a join on the rejected promise).
    const recovered = await singleFlightStableLtm("session-flaky", flaky);
    expect(recovered).toEqual({ formatted: "ok", tokenCount: 1 });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  test("concurrent callers all see the settled value (race-free re-read)", async () => {
    vi.resetModules();
    const { singleFlightStableLtm } = await import("../src/pipeline");

    // A compute that writes a known value; the test verifies that every
    // concurrent caller read the SAME final value (not a stale one).
    const compute = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { formatted: "final", tokenCount: 99 };
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        singleFlightStableLtm("session-race", compute),
      ),
    );

    for (const r of results) {
      expect(r).toEqual({ formatted: "final", tokenCount: 99 });
    }
  });
});
