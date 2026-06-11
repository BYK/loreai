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
import { buildIdleWorkHandler, touchSession } from "../src/idle";
import { recordConversationCost, clearAllCosts } from "../src/cost-tracker";
import { resetPipelineState } from "../src/pipeline";
import { ltm, loadSessionCosts } from "@loreai/core";
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
