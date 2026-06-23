/**
 * Tests for `touchSession` and `buildIdleWorkHandler` in `src/idle.ts`.
 *
 * `evictIdleSessions` / `startIdleScheduler` are covered by eviction.test.ts.
 * Here we focus on the idle work handler's local steps (pruning, knowledge
 * export, dead-ref cleanup, lat refresh, cost persistence) and its skip
 * guards. The LLM-calling branches (distillation/curation/consolidation) are
 * intentionally NOT driven here — they couple to core worker internals and
 * the batch queue; on an empty DB they are correctly skipped.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildIdleWorkHandler,
  touchSession,
  consolidationCooldownActive,
  perCategoryThreshold,
  invalidateWarmupBodyAfterIdleDistill,
  shouldHoldPrefixWarm,
  CONSOLIDATION_COOLDOWN_MS,
  CONSOLIDATION_REATTEMPT_GROWTH,
} from "../src/idle";
import { recordConversationCost, clearAllCosts } from "../src/cost-tracker";
import { resetPipelineState } from "../src/pipeline";
import { compressBody } from "../src/cache-analytics";
import {
  ltm,
  loadSessionCosts,
  db,
  ensureProject,
  setCacheSizeSnapshot,
  evaluateCacheStrategy,
  setCachePricing,
  setConsecutiveBustsForTest,
  setLastTurnAtForTest,
  evictSession,
} from "@loreai/core";
import type { LLMClient } from "@loreai/core";
import type { SessionState } from "../src/translate/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionState(overrides?: Partial<SessionState>): SessionState {
  return {
    sessionID: "idle-session",
    projectPath: "/tmp/test-project",
    fingerprint: "fp-123",
    lastRequestTime: Date.now(),
    lastUserTurnTime: 0,
    messageCount: 5,
    turnsSinceCuration: 0,
    consecutiveTextOnlyTurns: 0,
    recallStore: new Map(),
    upstreamByProvider: new Map(),
    cacheAnalytics: {
      lastRequestBody: null,
      lastRequestBodyLength: 0,
      lastCacheRead: 0,
      lastCacheCreation: 0,
      turnCount: 0,
      bustCount: 0,
    },
    ...overrides,
  };
}

/** A no-op LLM client — handler steps that would call it are skipped here. */
function makeLLM(): LLMClient {
  return { prompt: vi.fn(async () => null) };
}

const tmpDirs: string[] = [];
function makeProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lore-idle-test-"));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(async () => {
  await resetPipelineState();
  clearAllCosts();
});

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
  tmpDirs.length = 0;
});

// ---------------------------------------------------------------------------
// touchSession
// ---------------------------------------------------------------------------

describe("touchSession", () => {
  test("updates lastRequestTime for a known session", () => {
    const sessions = new Map<string, SessionState>();
    const state = makeSessionState({ lastRequestTime: 0 });
    sessions.set("s1", state);
    touchSession(sessions, "s1");
    expect(state.lastRequestTime).toBeGreaterThan(0);
  });

  test("is a no-op for an unknown session", () => {
    const sessions = new Map<string, SessionState>();
    expect(() => touchSession(sessions, "nope")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// consolidationCooldownActive (pure decision — no LLM, no DB)
// ---------------------------------------------------------------------------

describe("consolidationCooldownActive", () => {
  const now = 1_000_000_000_000;
  const fresh = (
    over: Partial<{
      attemptedAt: number;
      entryCount: number;
      topCategoryCount: number;
    }> = {},
  ) => ({
    attemptedAt: now,
    entryCount: 50,
    topCategoryCount: 14,
    ...over,
  });

  test("no prior cooldown → not active (allowed to run)", () => {
    expect(consolidationCooldownActive(undefined, now, 50, 14)).toBe(false);
  });

  test("within the window with flat counts → active (sticky skip)", () => {
    const cd = fresh();
    expect(consolidationCooldownActive(cd, now + 60_000, 50, 14)).toBe(true);
  });

  test("stays sticky when the entry count DECREASES (eviction/delete)", () => {
    // A decrease yields no new merge candidate, so the prior "nothing to
    // merge" verdict still holds — must not re-trigger.
    const cd = fresh({ entryCount: 50 });
    expect(consolidationCooldownActive(cd, now + 60_000, 49, 14)).toBe(true);
  });

  test("stays sticky on small growth (<= reattempt threshold)", () => {
    const cd = fresh({ entryCount: 50 });
    expect(
      consolidationCooldownActive(
        cd,
        now + 60_000,
        50 + CONSOLIDATION_REATTEMPT_GROWTH,
        14,
      ),
    ).toBe(true);
  });

  test("re-attempts when the entry count GROWS past the threshold", () => {
    const cd = fresh({ entryCount: 50 });
    expect(
      consolidationCooldownActive(
        cd,
        now + 60_000,
        50 + CONSOLIDATION_REATTEMPT_GROWTH + 1,
        14,
      ),
    ).toBe(false);
  });

  test("re-attempts when the top category grows", () => {
    const cd = fresh({ topCategoryCount: 14 });
    expect(consolidationCooldownActive(cd, now + 60_000, 50, 15)).toBe(false);
  });

  test("expires after the cooldown window elapses", () => {
    const cd = fresh();
    expect(
      consolidationCooldownActive(cd, now + CONSOLIDATION_COOLDOWN_MS, 50, 14),
    ).toBe(false);
  });
});

describe("perCategoryThreshold", () => {
  test("is proportional to maxEntries (0.3 ratio), preserving the historical 12/40", () => {
    expect(perCategoryThreshold(40)).toBe(12);
    expect(perCategoryThreshold(200)).toBe(60);
    expect(perCategoryThreshold(100)).toBe(30);
  });
});

describe("invalidateWarmupBodyAfterIdleDistill", () => {
  function stateWithBody(): SessionState {
    return makeSessionState({
      cacheAnalytics: {
        lastRequestBody: compressBody('{"model":"x"}'),
        lastRequestBodyLength: 10,
        lastCacheRead: 0,
        lastCacheCreation: 0,
        turnCount: 0,
        bustCount: 0,
      },
    });
  }

  test("drops a compressed session's stored body after a prefix mutation", () => {
    const s1 = stateWithBody();
    expect(invalidateWarmupBodyAfterIdleDistill(s1, true, 1)).toBe(true);
    expect(s1.cacheAnalytics.lastRequestBody).toBeNull();

    const s3 = stateWithBody();
    expect(invalidateWarmupBodyAfterIdleDistill(s3, true, 3)).toBe(true);
    expect(s3.cacheAnalytics.lastRequestBody).toBeNull();
  });

  test("preserves a layer-0 (full-passthrough) body — no distilled prefix in it", () => {
    const s = stateWithBody();
    expect(invalidateWarmupBodyAfterIdleDistill(s, true, 0)).toBe(false);
    expect(s.cacheAnalytics.lastRequestBody).not.toBeNull();
  });

  test("preserves the body when the prefix did not mutate", () => {
    const s = stateWithBody();
    expect(invalidateWarmupBodyAfterIdleDistill(s, false, 2)).toBe(false);
    expect(s.cacheAnalytics.lastRequestBody).not.toBeNull();
  });

  test("no-ops when there is no stored body", () => {
    const s = makeSessionState(); // lastRequestBody: null
    expect(invalidateWarmupBodyAfterIdleDistill(s, true, 2)).toBe(false);
    expect(s.cacheAnalytics.lastRequestBody).toBeNull();
  });
});

describe("shouldHoldPrefixWarm (D6′ defer decision)", () => {
  function econ(
    strategy: "hold-warm" | "cool-bust" | "cool-full-write",
    confident: boolean,
  ) {
    return { result: { strategy, confident }, decidedAt: Date.now() };
  }

  test("hold-warm + no bust pressure → defer prefix rewrites", () => {
    expect(shouldHoldPrefixWarm(econ("hold-warm", true), false)).toBe(true);
  });

  test("hold-warm + bust pressure → flush (churning busts cache anyway)", () => {
    expect(shouldHoldPrefixWarm(econ("hold-warm", true), true)).toBe(false);
  });

  test("cool-bust / cool-full-write → never defer (prefix busting anyway)", () => {
    expect(shouldHoldPrefixWarm(econ("cool-bust", true), false)).toBe(false);
    expect(shouldHoldPrefixWarm(econ("cool-full-write", true), false)).toBe(
      false,
    );
  });

  test("non-confident strategy or null → flush (legacy aggressive behavior)", () => {
    expect(shouldHoldPrefixWarm(econ("hold-warm", false), false)).toBe(false);
    expect(shouldHoldPrefixWarm(null, false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildIdleWorkHandler
// ---------------------------------------------------------------------------

describe("buildIdleWorkHandler", () => {
  test("runs local idle steps on an empty project without calling the LLM", async () => {
    const llm = makeLLM();
    const handler = buildIdleWorkHandler(llm);
    const projectPath = makeProjectDir();
    const state = makeSessionState({ projectPath, turnsSinceCuration: 0 });

    await expect(handler("idle-empty", state)).resolves.toBeUndefined();
    // No undistilled messages and no knowledge entries → all worker LLM
    // steps (distillation/curation/consolidation) are skipped.
    expect(llm.prompt).not.toHaveBeenCalled();
  });

  // #497: the idle knowledge-lifecycle step credits injected entries by the
  // session's verifier outcome. These drive the real handler end-to-end.
  function seedInjectedEntry(
    projectPath: string,
    sessionID: string,
    confidence: number,
  ): string {
    const pid = ensureProject(projectPath);
    const id = ltm.create({
      projectPath,
      category: "pattern",
      title: `wire-${sessionID}`,
      content: "knowledge in context",
      scope: "project",
      confidence,
    });
    const logicalId = (
      db().query("SELECT logical_id FROM knowledge WHERE id = ?").get(id) as {
        logical_id: string;
      }
    ).logical_id;
    ltm.recordSessionInjections(sessionID, projectPath, [
      { logical_id: logicalId, cross_project: 0, category: "pattern" },
    ]);
    // A verifier tool call; the caller sets its final status (completed/error).
    db()
      .query(
        `INSERT INTO tool_calls
           (call_id, message_id, project_id, session_id, tool, status, error_type, error_message, duration_ms, created_at, verifier)
         VALUES (?, ?, ?, ?, 'bash', 'pending', NULL, NULL, 0, ?, 1)`,
      )
      .run(`tc-${sessionID}`, `m-${sessionID}`, pid, sessionID, Date.now());
    return id;
  }

  test("idle credits injected knowledge on a PASS verifier outcome (boost)", async () => {
    const projectPath = makeProjectDir();
    const sessionID = "idle-outcome-pass";
    const id = seedInjectedEntry(projectPath, sessionID, 0.5);
    // Mark the verifier tool call as completed (PASS).
    db()
      .query("UPDATE tool_calls SET status = 'completed' WHERE session_id = ?")
      .run(sessionID);

    const handler = buildIdleWorkHandler(makeLLM());
    await handler(sessionID, makeSessionState({ sessionID, projectPath }));

    const conf = (
      db().query("SELECT confidence FROM knowledge WHERE id = ?").get(id) as {
        confidence: number;
      }
    ).confidence;
    expect(conf).toBeCloseTo(0.5 + ltm.OUTCOME_REWARD, 6);
  });

  test("idle credits injected knowledge on a FAIL verifier outcome (penalty)", async () => {
    const projectPath = makeProjectDir();
    const sessionID = "idle-outcome-fail";
    const id = seedInjectedEntry(projectPath, sessionID, 0.5);
    db()
      .query("UPDATE tool_calls SET status = 'error' WHERE session_id = ?")
      .run(sessionID);

    const handler = buildIdleWorkHandler(makeLLM());
    await handler(sessionID, makeSessionState({ sessionID, projectPath }));

    const conf = (
      db().query("SELECT confidence FROM knowledge WHERE id = ?").get(id) as {
        confidence: number;
      }
    ).confidence;
    expect(conf).toBeCloseTo(0.5 - ltm.OUTCOME_PENALTY, 6);
  });

  test("drives force-distill + meta-consolidation but preserves a layer-0 warmup body", async () => {
    const projectPath = makeProjectDir();
    const sessionID = "idle-distill-wiring";
    const pid = ensureProject(projectPath);
    const T = Date.now();

    // Undistilled messages → force-distill runs and creates a gen-0 segment.
    for (let i = 0; i < 6; i++) {
      db()
        .query(
          `INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
           VALUES (?, ?, ?, 'user', ?, ?, 0, ?, '{}')`,
        )
        .run(
          `wire-msg-${i}`,
          pid,
          sessionID,
          "x".repeat(600),
          200,
          T + i * 1000,
        );
    }
    // >= metaThreshold (20) gen-0 distillations → meta-consolidation runs.
    for (let i = 0; i < 20; i++) {
      db()
        .query(
          `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, archived, created_at)
           VALUES (?, ?, ?, '', '', ?, '[]', 0, ?, 0, ?)`,
        )
        .run(`wire-g0-${i}`, pid, sessionID, `obs ${i} `.repeat(20), 50, T + i);
    }

    // Stub returns compressed observations so both distill + meta succeed.
    const llm: LLMClient = {
      prompt: vi.fn(
        async () => "<observations>\nshort summary\n</observations>",
      ),
    };
    const state = makeSessionState({
      sessionID,
      projectPath,
      turnsSinceCuration: 0,
      cacheAnalytics: {
        lastRequestBody: compressBody('{"model":"x","messages":[]}'),
        lastRequestBodyLength: 20,
        lastCacheRead: 0,
        lastCacheCreation: 0,
        turnCount: 0,
        bustCount: 0,
      },
    });

    const prev = process.env.LORE_BATCH_DISABLED;
    process.env.LORE_BATCH_DISABLED = "1"; // direct (synchronous) distillation
    try {
      await buildIdleWorkHandler(llm)(sessionID, state);
    } finally {
      if (prev === undefined) delete process.env.LORE_BATCH_DISABLED;
      else process.env.LORE_BATCH_DISABLED = prev;
    }

    // The handler drove force-distill + meta-consolidation (prefix mutated), but
    // this session never transformed → getLastLayer == 0 → its full-passthrough
    // warmup body is preserved (only COMPRESSED sessions are invalidated).
    expect(state.cacheAnalytics.lastRequestBody).not.toBeNull();
  });

  // D6′ deferred prefix work — drive the real handler and assert via the worker
  // LLM call. Shared helpers below.
  const D6_PRICE = {
    readPerToken: 0.3 / 1_000_000,
    writePerToken: 3.75 / 1_000_000,
  };
  const D6_INPUTS = {
    pReturn: 0.9,
    expectedCycles: 4,
    expectedFutureTurns: 50,
  };

  // Store a confident strategy for the session. (10k/10k → hold-warm;
  // 800k/100k → cool-bust, verified by the assertions at each call site.)
  function d6SetStrategy(sessionID: string, full: number, compressed: number) {
    setCachePricing(3.75, 0.3);
    setCacheSizeSnapshot(sessionID, full, compressed);
    return evaluateCacheStrategy(sessionID, D6_INPUTS, D6_PRICE)?.strategy;
  }

  function d6SeedMessages(sessionID: string, n: number): string {
    const projectPath = makeProjectDir();
    const pid = ensureProject(projectPath);
    for (let i = 0; i < n; i++) {
      db()
        .query(
          `INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
           VALUES (?, ?, ?, 'user', ?, ?, 0, ?, '{}')`,
        )
        .run(`${sessionID}-m${i}`, pid, sessionID, "x".repeat(600), 200, i);
    }
    return projectPath;
  }

  // Seed >= metaThreshold (20) gen-0 distillations on an already-distilled
  // project (no undistilled messages), so the meta-consolidation gate is the
  // ONLY step that can call the worker LLM.
  function d6SeedGen0(sessionID: string): string {
    const projectPath = makeProjectDir();
    const pid = ensureProject(projectPath);
    for (let i = 0; i < 20; i++) {
      db()
        .query(
          `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, archived, created_at)
           VALUES (?, ?, ?, '', '', ?, '[]', 0, ?, 0, ?)`,
        )
        .run(
          `${sessionID}-g0-${i}`,
          pid,
          sessionID,
          `obs ${i} `.repeat(20),
          50,
          i,
        );
    }
    return projectPath;
  }

  async function d6RunIdle(sessionID: string, projectPath: string) {
    const llm: LLMClient = {
      prompt: vi.fn(async () => "<observations>x</observations>"),
    };
    const prev = process.env.LORE_BATCH_DISABLED;
    process.env.LORE_BATCH_DISABLED = "1"; // direct (synchronous) distillation
    try {
      await buildIdleWorkHandler(llm)(
        sessionID,
        makeSessionState({ sessionID, projectPath, turnsSinceCuration: 0 }),
      );
    } finally {
      if (prev === undefined) delete process.env.LORE_BATCH_DISABLED;
      else process.env.LORE_BATCH_DISABLED = prev;
    }
    return llm;
  }

  // Distillation gate: a sub-minMessages backlog is deferred on hold-warm but
  // force-distilled on cool-bust. The worker LLM is reached only for cool-bust.
  test("D6′: hold-warm defers idle distillation below minMessages; cool-bust flushes", async () => {
    const warm = "idle-d6-distill-holdwarm";
    const warmPath = d6SeedMessages(warm, 3); // < minMessages (5)
    expect(d6SetStrategy(warm, 10_000, 10_000)).toBe("hold-warm");
    expect((await d6RunIdle(warm, warmPath)).prompt).not.toHaveBeenCalled();
    evictSession(warm);

    const cool = "idle-d6-distill-coolbust";
    const coolPath = d6SeedMessages(cool, 3);
    expect(d6SetStrategy(cool, 800_000, 100_000)).toBe("cool-bust");
    expect((await d6RunIdle(cool, coolPath)).prompt).toHaveBeenCalled();
    evictSession(cool);
  });

  // Meta gate: with >= metaThreshold gen-0 and no undistilled messages, the
  // `g0 >= metaThreshold && !holdingWarm` gate is the only LLM caller. hold-warm
  // defers meta-consolidation; cool-bust runs it. (Kills the `&& !holdingWarm`
  // mutation — the distillation gate can't reach this branch.)
  test("D6′: hold-warm defers meta-consolidation; cool-bust runs it", async () => {
    const warm = "idle-d6-meta-holdwarm";
    const warmPath = d6SeedGen0(warm);
    expect(d6SetStrategy(warm, 10_000, 10_000)).toBe("hold-warm");
    expect((await d6RunIdle(warm, warmPath)).prompt).not.toHaveBeenCalled();
    evictSession(warm);

    const cool = "idle-d6-meta-coolbust";
    const coolPath = d6SeedGen0(cool);
    expect(d6SetStrategy(cool, 800_000, 100_000)).toBe("cool-bust");
    expect((await d6RunIdle(cool, coolPath)).prompt).toHaveBeenCalled();
    evictSession(cool);
  });

  // Urgency override: a hold-warm session under bust pressure
  // (consecutiveBusts >= BUST_PRESSURE_THRESHOLD) flushes anyway — a churning
  // session is busting cache regardless of intent. Same sub-minMessages backlog
  // that the first test deferred now force-distills because of the bust pressure.
  test("D6′: bust pressure overrides hold-warm and force-distills", async () => {
    const sessionID = "idle-d6-bust-override";
    const projectPath = d6SeedMessages(sessionID, 3); // < minMessages
    expect(d6SetStrategy(sessionID, 10_000, 10_000)).toBe("hold-warm");
    // Mark the session as churning AFTER the strategy is stored.
    setConsecutiveBustsForTest(sessionID, 3); // >= BUST_PRESSURE_THRESHOLD
    expect((await d6RunIdle(sessionID, projectPath)).prompt).toHaveBeenCalled();
    evictSession(sessionID);
  });

  // Seed an arbitrary number of gen-0 distillations (no undistilled messages),
  // so the meta-consolidation gate is the only step that can call the worker
  // LLM. Count chosen to sit BETWEEN the bust-pressure floor (10) and the
  // default metaThreshold (20) so the effective-threshold value decides whether
  // meta fires.
  function seedGen0N(sessionID: string, n: number): string {
    const projectPath = makeProjectDir();
    const pid = ensureProject(projectPath);
    for (let i = 0; i < n; i++) {
      db()
        .query(
          `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, archived, created_at)
           VALUES (?, ?, ?, '', '', ?, '[]', 0, ?, 0, ?)`,
        )
        .run(
          `${sessionID}-g0-${i}`,
          pid,
          sessionID,
          `obs ${i} `.repeat(20),
          50,
          i,
        );
    }
    return projectPath;
  }

  // Wiring guard for Fix (2): the idle handler must thread getLastTurnAt() into
  // effectiveMetaThreshold. With bust pressure and 12 gen-0 segments (between
  // the floor 10 and the default threshold 20), the deep-idle gate decides
  // whether meta fires:
  //   - recent lastTurnAt (< 5 min) → threshold stays 20 → 12 < 20 → meta SKIPPED
  //   - old lastTurnAt   (> 5 min)  → threshold drops to 10 → 12 >= 10 → meta RUNS
  // If the call site passed a constant (e.g. 0) instead of getLastTurnAt(), the
  // "recent" case would also drop to 10 and meta would fire — so the
  // not.toHaveBeenCalled() assertion below kills that mutation.
  test("D6′: idle threads getLastTurnAt — recent turn under bust pressure defers meta", async () => {
    const sessionID = "idle-d6-recent-no-meta";
    const projectPath = seedGen0N(sessionID, 12);
    setConsecutiveBustsForTest(sessionID, 3); // bust pressure → holdingWarm=false
    setLastTurnAtForTest(sessionID, Date.now()); // recent → NOT deep-idle
    // threshold stays at config (20); 12 gen-0 < 20 → meta-consolidation skipped.
    expect(
      (await d6RunIdle(sessionID, projectPath)).prompt,
    ).not.toHaveBeenCalled();
    evictSession(sessionID);
  });

  test("D6′: idle threads getLastTurnAt — deep-idle turn under bust pressure runs meta", async () => {
    const sessionID = "idle-d6-deepidle-meta";
    const projectPath = seedGen0N(sessionID, 12);
    setConsecutiveBustsForTest(sessionID, 3); // bust pressure → holdingWarm=false
    // 6 min ago → deep-idle → threshold drops to floor 10; 12 >= 10 → meta runs.
    setLastTurnAtForTest(sessionID, Date.now() - 6 * 60 * 1000);
    expect((await d6RunIdle(sessionID, projectPath)).prompt).toHaveBeenCalled();
    evictSession(sessionID);
  });

  test("exports a knowledge file when the project has entries", async () => {
    const llm = makeLLM();
    const handler = buildIdleWorkHandler(llm);
    const projectPath = makeProjectDir();
    ltm.create({
      projectPath,
      category: "gotcha",
      title: "Idle test entry",
      content: "Some knowledge content for the idle export test.",
      scope: "project",
    });
    const state = makeSessionState({ projectPath, turnsSinceCuration: 0 });

    await handler("idle-export", state);

    // Default config enables loreFile + agentsFile → writes AGENTS.md (+ .lore.md).
    const files = readdirSync(projectPath);
    expect(files.some((f) => f === "AGENTS.md" || f === ".lore.md")).toBe(true);
  });

  test("runs consolidation when a category is over threshold, then the cooldown skips the next tick", async () => {
    const llm = makeLLM(); // prompt() returns null → consolidation is a no-op
    const handler = buildIdleWorkHandler(llm);
    const projectPath = makeProjectDir();
    // Seed one category well past the per-category consolidation threshold so
    // the consolidation block fires regardless of the threshold/cap values on
    // whichever branch of the stack runs this (they grow up the stack). 75
    // comfortably clears the largest per-category threshold in the stack.
    for (let i = 0; i < 75; i++) {
      ltm.create({
        projectPath,
        category: "preference",
        title: `Pref ${i}`,
        content: `Preference number ${i} content.`,
        scope: "project",
      });
    }
    const state = makeSessionState({
      sessionID: "idle-consolidate",
      projectPath,
      turnsSinceCuration: 0, // keep curation from firing — isolate consolidation
    });
    const prompt = llm.prompt as ReturnType<typeof vi.fn>;

    // First idle tick: over threshold → consolidation runs and calls the LLM.
    // The no-op completion arms the cooldown.
    await handler("idle-consolidate", state);
    const callsAfterFirst = prompt.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Second idle tick: entry count unchanged → cooldown is active → the
    // consolidation block is skipped, so the LLM is not called again.
    await handler("idle-consolidate", state);
    expect(prompt.mock.calls.length).toBe(callsAfterFirst);
  });

  test("consolidation that makes progress deletes the entry and clears the cooldown", async () => {
    const projectPath = makeProjectDir();
    // 74 full-confidence entries plus one low-confidence target (75 total, well
    // past the largest per-category threshold in the stack). The target, being
    // the lowest confidence, is always in the consolidation set on every branch
    // — whether the global batched path (lowest-confidence tail) or the
    // category-focused path (whole category) is taken.
    for (let i = 0; i < 74; i++) {
      ltm.create({
        projectPath,
        category: "preference",
        title: `Keep ${i}`,
        content: `Preference number ${i} content.`,
        scope: "project",
      });
    }
    const targetId = ltm.create({
      projectPath,
      category: "preference",
      title: "Merge me",
      content: "A near-duplicate preference the consolidator removes.",
      scope: "project",
      confidence: 0.3,
    });
    // LLM returns a consolidation delete op for the target → result.deleted > 0
    // → the "made progress" branch (clears the cooldown).
    const llm: LLMClient = {
      prompt: vi.fn(async () =>
        JSON.stringify({
          ops: [{ op: "delete", id: targetId, reason: "dup" }],
        }),
      ),
    };
    const handler = buildIdleWorkHandler(llm);
    const state = makeSessionState({
      sessionID: "idle-consolidate-progress",
      projectPath,
      turnsSinceCuration: 0,
    });

    await handler("idle-consolidate-progress", state);

    expect(llm.prompt).toHaveBeenCalled();
    expect(ltm.get(targetId)).toBeNull(); // consolidation deleted it
  });

  test("persists the session cost snapshot when conversation cost exists", async () => {
    const llm = makeLLM();
    const handler = buildIdleWorkHandler(llm);
    const projectPath = makeProjectDir();
    recordConversationCost("idle-cost", "__test_fake_model__", {
      input_tokens: 1000,
      output_tokens: 500,
    });
    const state = makeSessionState({
      sessionID: "idle-cost",
      projectPath,
      turnsSinceCuration: 0,
    });

    await expect(handler("idle-cost", state)).resolves.toBeUndefined();

    const persisted = loadSessionCosts("idle-cost");
    expect(persisted).not.toBeNull();
    expect(persisted?.conversationTurns).toBe(1);
  });
});
