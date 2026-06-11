import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  runBackground,
  isBackgroundPaused,
  tripCircuitBreaker,
  resetBackgroundLimiter,
  backgroundLimiterStats,
  getConsecutiveTrips,
  remainingPauseSeconds,
  scaleBackgroundConcurrency,
  shouldShedLowPriority,
  BACKOFF_SCHEDULE,
  _tripRaw,
  _setConcurrencyForTest,
} from "../src/background-limiter";

describe("background-limiter", () => {
  beforeEach(() => resetBackgroundLimiter());

  test("starts at the minimum concurrency of 2", async () => {
    let maxConcurrent = 0;
    let current = 0;

    const tasks = Array.from({ length: 5 }, (_, i) =>
      runBackground(async () => {
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        await new Promise((r) => setTimeout(r, 50));
        current--;
        return i;
      }),
    );

    await Promise.all(tasks);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  test("returns task result when not paused", async () => {
    const result = await runBackground(async () => 42);
    expect(result).toBe(42);
  });

  test("circuit breaker skips work when tripped", async () => {
    tripCircuitBreaker(10); // 10 seconds
    expect(isBackgroundPaused()).toBe(true);

    let called = false;
    const result = await runBackground(async () => {
      called = true;
      return "done";
    });

    expect(called).toBe(false);
    expect(result).toBeUndefined();
  });

  test("circuit breaker auto-resets after duration", async () => {
    _tripRaw(0.1); // 100ms — bypasses escalation schedule for test speed
    expect(isBackgroundPaused()).toBe(true);

    await new Promise((r) => setTimeout(r, 150));
    expect(isBackgroundPaused()).toBe(false);
  });

  test("circuit breaker only extends, never shortens", () => {
    // First trip: max(600, schedule[0]=60) = 600s
    tripCircuitBreaker(600);
    const stats1 = backgroundLimiterStats();

    // Second trip: max(2, schedule[1]=120) = 120s — shorter than 600s, should be ignored
    tripCircuitBreaker(2);
    const stats2 = backgroundLimiterStats();

    // Pause should still be ~600s, not shortened
    expect(stats2.pauseRemainingSeconds).toBeGreaterThanOrEqual(
      stats1.pauseRemainingSeconds - 1,
    );
  });

  test("stats reflect active/pending counts", async () => {
    let resolve!: () => void;
    const blocker = new Promise<void>((r) => {
      resolve = r;
    });

    const task1 = runBackground(() => blocker);
    const task2 = runBackground(() => blocker);
    const task3 = runBackground(async () => {});

    // Allow event loop to process
    await new Promise((r) => setTimeout(r, 10));

    const stats = backgroundLimiterStats();
    expect(stats.activeCount).toBe(2);
    expect(stats.pendingCount).toBe(1);
    expect(stats.paused).toBe(false);

    resolve();
    await Promise.all([task1, task2, task3]);
  });

  test("not paused by default", () => {
    expect(isBackgroundPaused()).toBe(false);
    expect(backgroundLimiterStats().paused).toBe(false);
  });

  test("propagates task errors", async () => {
    const err = new Error("boom");
    await expect(
      runBackground(async () => {
        throw err;
      }),
    ).rejects.toThrow("boom");
  });

  test("skips queued tasks when circuit breaker trips while waiting", async () => {
    let resolve!: () => void;
    const blocker = new Promise<void>((r) => {
      resolve = r;
    });

    // Fill both concurrency slots
    const task1 = runBackground(() => blocker);
    const task2 = runBackground(() => blocker);

    // Queue a third task — it will wait
    let thirdCalled = false;
    const task3 = runBackground(async () => {
      thirdCalled = true;
      return "done";
    });

    // Trip the circuit breaker while task3 is queued
    await new Promise((r) => setTimeout(r, 10));
    tripCircuitBreaker(10);

    // Release the blockers — task3 should now execute but be skipped
    resolve();
    const results = await Promise.all([task1, task2, task3]);

    expect(thirdCalled).toBe(false);
    expect(results[2]).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Escalating backoff
  // ---------------------------------------------------------------------------

  test("consecutive trips produce escalating durations", () => {
    // Each trip should use the next entry in BACKOFF_SCHEDULE
    for (let i = 0; i < BACKOFF_SCHEDULE.length; i++) {
      tripCircuitBreaker();
      expect(getConsecutiveTrips()).toBe(i + 1);
      // The pause should be at least the scheduled duration
      const remaining = backgroundLimiterStats().pauseRemainingSeconds;
      expect(remaining).toBeGreaterThanOrEqual(BACKOFF_SCHEDULE[i] - 1);
    }

    // Beyond the schedule, stays at the last (max) value
    tripCircuitBreaker();
    expect(getConsecutiveTrips()).toBe(BACKOFF_SCHEDULE.length + 1);
    const remaining = backgroundLimiterStats().pauseRemainingSeconds;
    expect(remaining).toBeGreaterThanOrEqual(
      BACKOFF_SCHEDULE[BACKOFF_SCHEDULE.length - 1] - 1,
    );
  });

  test("consecutiveTrips resets after breaker naturally expires", async () => {
    // Use tripCircuitBreaker to increment consecutiveTrips, then override
    // the actual pause duration with _tripRaw for test speed.
    tripCircuitBreaker(); // sets consecutiveTrips = 1
    expect(getConsecutiveTrips()).toBe(1);
    _tripRaw(0.1); // override to 100ms pause

    await new Promise((r) => setTimeout(r, 150));

    // Checking isBackgroundPaused triggers the reset
    expect(isBackgroundPaused()).toBe(false);
    expect(getConsecutiveTrips()).toBe(0);
  });

  test("retryAfterSeconds respects escalation via max()", () => {
    // First trip: schedule says 60s, but server says 10s → use 60s
    tripCircuitBreaker(10);
    const remaining1 = backgroundLimiterStats().pauseRemainingSeconds;
    expect(remaining1).toBeGreaterThanOrEqual(59);

    // Reset and trip again with server saying 300s (higher than schedule)
    resetBackgroundLimiter();
    tripCircuitBreaker(300);
    const remaining2 = backgroundLimiterStats().pauseRemainingSeconds;
    expect(remaining2).toBeGreaterThanOrEqual(299);
  });

  test("resetBackgroundLimiter clears consecutiveTrips", () => {
    tripCircuitBreaker();
    tripCircuitBreaker();
    expect(getConsecutiveTrips()).toBe(2);

    resetBackgroundLimiter();
    expect(getConsecutiveTrips()).toBe(0);
    expect(isBackgroundPaused()).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Queue depth cap
  // ---------------------------------------------------------------------------

  test("rejects new tasks when queue is full", async () => {
    let resolve!: () => void;
    const blocker = new Promise<void>((r) => {
      resolve = r;
    });

    // Fill both concurrency slots
    const active1 = runBackground(() => blocker);
    const active2 = runBackground(() => blocker);

    // Queue up to the limit (MAX_PENDING_QUEUE = 50)
    const queued: Promise<unknown>[] = [];
    for (let i = 0; i < 50; i++) {
      queued.push(runBackground(async () => `task-${i}`, `task-${i}`));
    }

    // Allow event loop to process submissions
    await new Promise((r) => setTimeout(r, 10));
    expect(backgroundLimiterStats().pendingCount).toBe(50);

    // The 51st submission should be rejected (returns undefined immediately)
    const overflow = await runBackground(
      async () => "should-not-run",
      "overflow-task",
    );
    expect(overflow).toBeUndefined();

    // Pending count should NOT have increased
    expect(backgroundLimiterStats().pendingCount).toBe(50);

    // Clean up — release everything
    resolve();
    await Promise.all([active1, active2, ...queued]);
  });

  // ---------------------------------------------------------------------------
  // Per-provider circuit breaker isolation
  // ---------------------------------------------------------------------------

  describe("per-provider circuit breaker", () => {
    test("a 429 from one provider does not pause another provider", () => {
      tripCircuitBreaker(10, "openrouter");
      expect(isBackgroundPaused("openrouter")).toBe(true);
      // Anthropic work is unaffected.
      expect(isBackgroundPaused("anthropic")).toBe(false);
      // Unknown-provider (undefined) work is NOT paused by a provider-scoped trip.
      expect(isBackgroundPaused()).toBe(false);
    });

    test("runBackground skips only the tripped provider's work", async () => {
      tripCircuitBreaker(10, "openrouter");

      let openrouterRan = false;
      const r1 = await runBackground(
        async () => {
          openrouterRan = true;
          return "or";
        },
        "or-task",
        "openrouter",
      );
      expect(openrouterRan).toBe(false);
      expect(r1).toBeUndefined();

      let anthropicRan = false;
      const r2 = await runBackground(
        async () => {
          anthropicRan = true;
          return "an";
        },
        "an-task",
        "anthropic",
      );
      expect(anthropicRan).toBe(true);
      expect(r2).toBe("an");
    });

    test("global-fallback trip (no provider) pauses ALL providers", () => {
      tripCircuitBreaker(10); // no providerID → GLOBAL_KEY
      expect(isBackgroundPaused()).toBe(true);
      expect(isBackgroundPaused("anthropic")).toBe(true);
      expect(isBackgroundPaused("openrouter")).toBe(true);
    });

    test("escalation is tracked independently per provider", () => {
      tripCircuitBreaker(undefined, "openrouter");
      tripCircuitBreaker(undefined, "openrouter");
      expect(getConsecutiveTrips("openrouter")).toBe(2);
      // A different provider starts fresh.
      expect(getConsecutiveTrips("anthropic")).toBe(0);
      tripCircuitBreaker(undefined, "anthropic");
      expect(getConsecutiveTrips("anthropic")).toBe(1);
      expect(getConsecutiveTrips("openrouter")).toBe(2);
    });

    test("a provider breaker auto-resets independently after expiry", async () => {
      _tripRaw(0.1, "openrouter");
      expect(isBackgroundPaused("openrouter")).toBe(true);
      await new Promise((r) => setTimeout(r, 150));
      expect(isBackgroundPaused("openrouter")).toBe(false);
      // Escalation reset for that provider after natural expiry.
      expect(getConsecutiveTrips("openrouter")).toBe(0);
    });

    test("remainingPauseSeconds is scoped per provider", () => {
      tripCircuitBreaker(300, "openrouter");
      expect(remainingPauseSeconds("openrouter")).toBeGreaterThanOrEqual(299);
      expect(remainingPauseSeconds("anthropic")).toBe(0);
    });

    test("global-fallback remaining time bleeds into every provider", () => {
      tripCircuitBreaker(300); // global
      expect(remainingPauseSeconds("anthropic")).toBeGreaterThanOrEqual(299);
      expect(remainingPauseSeconds("openrouter")).toBeGreaterThanOrEqual(299);
    });
  });

  // ---------------------------------------------------------------------------
  // Dynamic concurrency scaling
  // ---------------------------------------------------------------------------

  describe("scaleBackgroundConcurrency", () => {
    const ENV_KEY = "LORE_BACKGROUND_CONCURRENCY";
    let savedEnv: string | undefined;

    beforeEach(() => {
      savedEnv = process.env[ENV_KEY];
      delete process.env[ENV_KEY];
      resetBackgroundLimiter();
    });

    afterEach(() => {
      if (savedEnv === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = savedEnv;
    });

    test("scales up with active session count (0.5 per session)", async () => {
      scaleBackgroundConcurrency(8); // ceil(8 * 0.5) = 4
      // Run more tasks than the cap and observe max concurrency.
      let maxConcurrent = 0;
      let current = 0;
      const tasks = Array.from({ length: 10 }, () =>
        runBackground(async () => {
          current++;
          maxConcurrent = Math.max(maxConcurrent, current);
          await new Promise((r) => setTimeout(r, 30));
          current--;
        }),
      );
      await Promise.all(tasks);
      expect(maxConcurrent).toBeGreaterThan(2);
      expect(maxConcurrent).toBeLessThanOrEqual(4);
    });

    test("never drops below the minimum of 2", () => {
      scaleBackgroundConcurrency(0);
      // Two concurrent slots should be available even with no sessions.
      let resolve!: () => void;
      const blocker = new Promise<void>((r) => {
        resolve = r;
      });
      const t1 = runBackground(() => blocker);
      const t2 = runBackground(() => blocker);
      const t3 = runBackground(async () => {});
      return new Promise<void>((done) => {
        setTimeout(async () => {
          const stats = backgroundLimiterStats();
          expect(stats.activeCount).toBe(2);
          expect(stats.pendingCount).toBe(1);
          resolve();
          await Promise.all([t1, t2, t3]);
          done();
        }, 10);
      });
    });

    test("clamps to the built-in maximum of 12", async () => {
      scaleBackgroundConcurrency(1000); // ceil(500) clamped to 12
      let maxConcurrent = 0;
      let current = 0;
      const tasks = Array.from({ length: 20 }, () =>
        runBackground(async () => {
          current++;
          maxConcurrent = Math.max(maxConcurrent, current);
          await new Promise((r) => setTimeout(r, 30));
          current--;
        }),
      );
      await Promise.all(tasks);
      expect(maxConcurrent).toBeLessThanOrEqual(12);
      expect(maxConcurrent).toBeGreaterThan(2);
    });

    test("respects LORE_BACKGROUND_CONCURRENCY as a hard ceiling", async () => {
      process.env[ENV_KEY] = "3";
      scaleBackgroundConcurrency(1000); // would be 12, capped to env=3
      let maxConcurrent = 0;
      let current = 0;
      const tasks = Array.from({ length: 10 }, () =>
        runBackground(async () => {
          current++;
          maxConcurrent = Math.max(maxConcurrent, current);
          await new Promise((r) => setTimeout(r, 30));
          current--;
        }),
      );
      await Promise.all(tasks);
      expect(maxConcurrent).toBeLessThanOrEqual(3);
    });

    test("scales back down when sessions go away", () => {
      scaleBackgroundConcurrency(20); // up to 10
      scaleBackgroundConcurrency(2); // back down to 2 (ceil(1) -> min 2)
      // Only 2 slots active now: third task queues.
      let resolve!: () => void;
      const blocker = new Promise<void>((r) => {
        resolve = r;
      });
      const t1 = runBackground(() => blocker);
      const t2 = runBackground(() => blocker);
      const t3 = runBackground(async () => {});
      return new Promise<void>((done) => {
        setTimeout(async () => {
          expect(backgroundLimiterStats().activeCount).toBe(2);
          expect(backgroundLimiterStats().pendingCount).toBe(1);
          resolve();
          await Promise.all([t1, t2, t3]);
          done();
        }, 10);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Low-priority load shedding
  // ---------------------------------------------------------------------------

  test("shouldShedLowPriority: false below 50% of cap, true at/above", async () => {
    expect(shouldShedLowPriority()).toBe(false);

    let resolve!: () => void;
    const blocker = new Promise<void>((r) => {
      resolve = r;
    });

    // Use the test hook to keep concurrency at 2 so submissions queue.
    _setConcurrencyForTest(2);
    const active1 = runBackground(() => blocker);
    const active2 = runBackground(() => blocker);

    const queued: Promise<unknown>[] = [];
    // 24 pending (< 25 threshold = 50% of 50) → not shedding yet
    for (let i = 0; i < 24; i++) {
      queued.push(runBackground(() => blocker, `q-${i}`));
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(backgroundLimiterStats().pendingCount).toBe(24);
    expect(shouldShedLowPriority()).toBe(false);

    // One more → 25 pending = threshold → shedding
    queued.push(runBackground(() => blocker, "q-24"));
    await new Promise((r) => setTimeout(r, 10));
    expect(backgroundLimiterStats().pendingCount).toBe(25);
    expect(shouldShedLowPriority()).toBe(true);

    resolve();
    await Promise.all([active1, active2, ...queued]);
  });
});
