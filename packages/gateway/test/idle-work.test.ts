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
  CONSOLIDATION_COOLDOWN_MS,
  CONSOLIDATION_REATTEMPT_GROWTH,
} from "../src/idle";
import { recordConversationCost, clearAllCosts } from "../src/cost-tracker";
import { resetPipelineState } from "../src/pipeline";
import { compressBody } from "../src/cache-analytics";
import { ltm, loadSessionCosts, db, ensureProject } from "@loreai/core";
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
