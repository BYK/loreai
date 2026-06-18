import { describe, it, expect } from "vitest";
import {
  ensureProject,
  recordCacheBustObservation,
  getCacheBustStats,
  summarizeCacheBustStats,
  type CacheBustStat,
} from "../src/index";

describe("cache_bust_stats (v47 — issue #791 measure-first counters)", () => {
  it("accumulates turns and write_tokens per (project,cause,relocatable)", () => {
    const p = ensureProject("/tmp/lore-cbs-accumulate");
    recordCacheBustObservation({
      projectID: p,
      cause: "system-host-change",
      relocatable: true,
      writeTokens: 100,
    });
    recordCacheBustObservation({
      projectID: p,
      cause: "system-host-change",
      relocatable: true,
      writeTokens: 50,
    });
    const rows = getCacheBustStats(p);
    expect(rows).toHaveLength(1);
    expect(rows[0].cause).toBe("system-host-change");
    expect(rows[0].relocatable).toBe(true);
    expect(rows[0].turns).toBe(2);
    expect(rows[0].writeTokens).toBe(150);
  });

  it("separates rows by relocatable flag and by cause", () => {
    const p = ensureProject("/tmp/lore-cbs-separate");
    recordCacheBustObservation({
      projectID: p,
      cause: "system-host-change",
      relocatable: true,
      writeTokens: 10,
    });
    recordCacheBustObservation({
      projectID: p,
      cause: "system-host-change",
      relocatable: false,
      writeTokens: 20,
    });
    recordCacheBustObservation({
      projectID: p,
      cause: "incremental",
      relocatable: false,
      writeTokens: 0,
    });
    const rows = getCacheBustStats(p);
    expect(rows).toHaveLength(3);
  });

  it("scopes counters by project", () => {
    const a = ensureProject("/tmp/lore-cbs-a");
    const b = ensureProject("/tmp/lore-cbs-b");
    recordCacheBustObservation({
      projectID: a,
      cause: "window-shift",
      relocatable: false,
      writeTokens: 5,
    });
    expect(getCacheBustStats(a).length).toBeGreaterThanOrEqual(1);
    expect(getCacheBustStats(b)).toHaveLength(0);
  });

  it("returns all rows across projects when no project filter is given", () => {
    const a = ensureProject("/tmp/lore-cbs-all-1");
    const b = ensureProject("/tmp/lore-cbs-all-2");
    recordCacheBustObservation({
      projectID: a,
      cause: "tools-change",
      relocatable: false,
      writeTokens: 1,
    });
    recordCacheBustObservation({
      projectID: b,
      cause: "tools-change",
      relocatable: false,
      writeTokens: 1,
    });
    const rows = getCacheBustStats();
    const causes = rows.filter((r) => r.cause === "tools-change");
    expect(causes.length).toBeGreaterThanOrEqual(2);
  });
});

describe("summarizeCacheBustStats (gate arithmetic — issue #791)", () => {
  function stat(
    cause: string,
    relocatable: boolean,
    turns: number,
    writeTokens: number,
  ): CacheBustStat {
    return {
      projectID: "p",
      cause,
      relocatable,
      turns,
      writeTokens,
      updatedAt: 0,
    };
  }

  it("excludes incremental and first-turn from the bust denominator", () => {
    const g = summarizeCacheBustStats([
      stat("incremental", false, 1200, 0),
      stat("first-turn", false, 5, 0),
      stat("window-shift", false, 40, 1_500_000),
      stat("system-host-change", true, 18, 720_000),
      stat("system-host-change", false, 3, 90_000),
      stat("system-ltm-change", false, 2, 30_000),
    ]);
    expect(g.totalTurns).toBe(1268);
    // busts = window-shift + both host + ltm (NOT incremental/first-turn)
    expect(g.bustTurns).toBe(63);
    expect(g.bustTokens).toBe(2_340_000);
    expect(g.hostTurns).toBe(21);
    expect(g.hostTokens).toBe(810_000);
    expect(g.relocatableTurns).toBe(18);
    expect(g.relocatableTokens).toBe(720_000);
  });

  it("only counts relocatable tokens for system-host-change rows", () => {
    // A relocatable flag on a non-host cause must never count toward the gate.
    const g = summarizeCacheBustStats([stat("window-shift", true, 10, 5000)]);
    expect(g.hostTurns).toBe(0);
    expect(g.relocatableTurns).toBe(0);
    expect(g.relocatableTokens).toBe(0);
    expect(g.bustTurns).toBe(10);
  });

  it("returns all-zero aggregates for empty input (no divide-by-zero)", () => {
    const g = summarizeCacheBustStats([]);
    expect(g).toEqual({
      totalTurns: 0,
      bustTurns: 0,
      bustTokens: 0,
      hostTurns: 0,
      hostTokens: 0,
      relocatableTurns: 0,
      relocatableTokens: 0,
    });
  });
});
