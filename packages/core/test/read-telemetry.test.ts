import { afterEach, describe, expect, it } from "vitest";
import * as ltm from "../src/ltm";
import {
  ReadPathTimer,
  type ReadPathTiming,
  setReadPathTimingHook,
} from "../src/read-telemetry";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => setReadPathTimingHook(null));

describe("ReadPathTimer", () => {
  it("accumulates awaited time; syncBlocking = total - awaited", async () => {
    let captured: ReadPathTiming | undefined;
    setReadPathTimingHook((t) => {
      captured = t;
    });

    const timer = new ReadPathTimer();
    await timer.await(sleep(25));
    timer.emit("recall", 7, "all");

    expect(captured).toBeDefined();
    const t = captured as ReadPathTiming;
    expect(t.op).toBe("recall");
    expect(t.scope).toBe("all");
    expect(t.candidateCount).toBe(7);
    // The await suspended for ~25ms; allow scheduling slack.
    expect(t.awaitedMs).toBeGreaterThanOrEqual(15);
    expect(t.totalMs).toBeGreaterThanOrEqual(t.awaitedMs);
    expect(t.syncBlockingMs).toBeCloseTo(t.totalMs - t.awaitedMs, 5);
    expect(t.syncBlockingMs).toBeGreaterThanOrEqual(0);
  });

  it("await() forwards the resolved value", async () => {
    setReadPathTimingHook(() => {});
    const v = await new ReadPathTimer().await(Promise.resolve(42));
    expect(v).toBe(42);
  });

  it("with no awaits, awaitedMs is 0 and syncBlocking >= 0", () => {
    let captured: ReadPathTiming | undefined;
    setReadPathTimingHook((t) => {
      captured = t;
    });
    new ReadPathTimer().emit("recall", 0);
    expect((captured as ReadPathTiming).awaitedMs).toBe(0);
    expect((captured as ReadPathTiming).syncBlockingMs).toBeGreaterThanOrEqual(
      0,
    );
  });

  it("emit is a no-op when no hook is registered", () => {
    setReadPathTimingHook(null);
    expect(() => new ReadPathTimer().emit("forSession", 0)).not.toThrow();
  });

  it("emit never throws even if the hook throws", () => {
    setReadPathTimingHook(() => {
      throw new Error("boom");
    });
    expect(() => new ReadPathTimer().emit("forSession", 1)).not.toThrow();
  });
});

describe("forSession fires the read-path timing hook", () => {
  it("emits op=forSession with a candidate count once entries exist", async () => {
    const PROJECT = "/test/read-telemetry/forsession";
    ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Vector worker pool",
      content: "Offload vector search onto a read-worker pool.",
      session: "s1",
      scope: "project",
    });

    const seen: ReadPathTiming[] = [];
    setReadPathTimingHook((t) => seen.push(t));

    await ltm.forSession(PROJECT, "s1", 4000);

    const t = seen.find((x) => x.op === "forSession");
    expect(t).toBeDefined();
    expect((t as ReadPathTiming).candidateCount).toBeGreaterThanOrEqual(1);
    expect((t as ReadPathTiming).totalMs).toBeGreaterThanOrEqual(0);
    expect((t as ReadPathTiming).syncBlockingMs).toBeGreaterThanOrEqual(0);
  });

  it("emits op=forSession (candidateCount 0) on the empty-knowledge fast path (Seer #993)", async () => {
    // A project with NO knowledge entries hits the `!crossEntries && !
    // projectEntries` early return — the FASTEST path. It must still emit, or
    // the read-path distribution is skewed toward slower, non-empty turns.
    const PROJECT = `/test/read-telemetry/forsession-empty-${Date.now()}`;

    const seen: ReadPathTiming[] = [];
    setReadPathTimingHook((t) => seen.push(t));

    const out = await ltm.forSession(PROJECT, "s-empty", 4000);
    expect(out).toEqual([]);

    const t = seen.find((x) => x.op === "forSession");
    expect(
      t,
      "empty-knowledge forSession must still emit timing",
    ).toBeDefined();
    expect((t as ReadPathTiming).candidateCount).toBe(0);
    expect((t as ReadPathTiming).syncBlockingMs).toBeGreaterThanOrEqual(0);
  });
});
