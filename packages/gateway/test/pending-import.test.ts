import { describe, test, expect, beforeEach, vi } from "vitest";
import {
  registerPendingImport,
  hasPendingImport,
  flushPendingImport,
  _resetPendingImportForTest,
} from "../src/pending-import";

describe("pending-import", () => {
  beforeEach(() => {
    _resetPendingImportForTest();
  });

  test("no job registered → flush is a no-op", async () => {
    expect(hasPendingImport()).toBe(false);
    await expect(flushPendingImport()).resolves.toBeUndefined();
  });

  test("registered job runs on flush, exactly once", async () => {
    const job = vi.fn(async () => {});
    registerPendingImport(job);
    expect(hasPendingImport()).toBe(true);

    await flushPendingImport();
    expect(job).toHaveBeenCalledTimes(1);

    // Second flush: nothing left to run (one-shot).
    await flushPendingImport();
    expect(job).toHaveBeenCalledTimes(1);
    expect(hasPendingImport()).toBe(false);
  });

  test("job is cleared BEFORE it runs — re-entrant flush never double-fires", async () => {
    let seenPendingDuringRun: boolean | null = null;
    const job = vi.fn(async () => {
      // The pipeline calls flushPendingImport on every turn; a turn that lands
      // while the job is still running must not start a second copy.
      seenPendingDuringRun = hasPendingImport();
      await flushPendingImport(); // re-entrant — must be a no-op
    });

    registerPendingImport(job);
    await flushPendingImport();

    expect(job).toHaveBeenCalledTimes(1);
    expect(seenPendingDuringRun).toBe(false); // cleared before run
  });

  test("concurrent flushes run the job only once (running guard)", async () => {
    let resolveJob: () => void = () => {};
    const gate = new Promise<void>((r) => {
      resolveJob = r;
    });
    const job = vi.fn(async () => {
      await gate;
    });

    registerPendingImport(job);

    // Two turns fire flush before the first completes.
    const p1 = flushPendingImport();
    const p2 = flushPendingImport();
    resolveJob();
    await Promise.all([p1, p2]);

    expect(job).toHaveBeenCalledTimes(1);
  });

  test("running guard: a job that re-registers is not re-fired by a mid-run flush", async () => {
    let resolveOuter: () => void = () => {};
    const gate = new Promise<void>((r) => {
      resolveOuter = r;
    });
    const inner = vi.fn(async () => {});
    const outer = vi.fn(async () => {
      // Simulate the job re-arming a follow-up import while still running, then
      // a concurrent turn flushing. The `running` guard must suppress it — the
      // re-registered job only becomes eligible once the current run finishes.
      registerPendingImport(inner);
      const reentrant = flushPendingImport(); // must be a no-op while running
      await gate;
      await reentrant;
    });

    registerPendingImport(outer);
    const run = flushPendingImport();
    resolveOuter();
    await run;

    expect(outer).toHaveBeenCalledTimes(1);
    // `inner` was registered during the run; the mid-run flush must NOT have
    // fired it (running guard). It stays pending for the next explicit flush.
    expect(inner).not.toHaveBeenCalled();
    expect(hasPendingImport()).toBe(true);

    await flushPendingImport();
    expect(inner).toHaveBeenCalledTimes(1);
  });

  test("a throwing job does not reject flush and clears state", async () => {
    const job = vi.fn(async () => {
      throw new Error("extraction blew up");
    });
    registerPendingImport(job);

    await expect(flushPendingImport()).resolves.toBeUndefined();
    expect(job).toHaveBeenCalledTimes(1);
    // State cleared even after a throw — a later turn won't retry endlessly,
    // and the running guard is released.
    expect(hasPendingImport()).toBe(false);
  });

  test("registering again replaces the prior job", async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    registerPendingImport(first);
    registerPendingImport(second);

    await flushPendingImport();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
