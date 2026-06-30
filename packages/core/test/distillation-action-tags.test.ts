import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { db, ensureProject } from "../src/db";
import { run } from "../src/distillation";
import { registerSink, type LogSink } from "../src/log";
import type { LLMClient } from "../src/types";

// #1023: the action-tag preference-minting loop ran one leading-wildcard
// `observations LIKE '%[tag]%'` COUNT(DISTINCT session_id) full scan of
// `distillations` PER known tag. The fix collapses those K scans into ONE pass
// of mutually-independent `COUNT(DISTINCT CASE WHEN … THEN session_id END)`
// columns. These tests pin (a) the single-pass behaviour via the DB query
// tracer and (b) that per-tag counts stay independent and the 3-session
// threshold holds.

const PROJECT = "/test/distillation/action-tags";
const RUN_SESSION = "action-tags-run-sess";
// Deterministic base timestamp so segment detection yields one segment.
const T = new Date("2026-05-01T10:00:00Z").getTime();

const passthroughSink: LogSink = {
  info() {},
  warn() {},
  error() {},
  captureException() {},
};

/** Sink that records every traced SQL string (get/run/all execution). */
function recordingSink(calls: string[]): LogSink {
  return {
    ...passthroughSink,
    withDbSpan<T>(sql: string, fn: () => T): T {
      calls.push(sql);
      return fn();
    },
  };
}

function insertTemporalMessages(n: number, tokensEach: number): string[] {
  const pid = ensureProject(PROJECT);
  const ids: string[] = [];
  const content = "x".repeat(tokensEach * 3);
  for (let i = 0; i < n; i++) {
    const id = `at-msg-${crypto.randomUUID()}`;
    ids.push(id);
    db()
      .query(
        `INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
         VALUES (?, ?, ?, 'user', ?, ?, 0, ?, '{}')`,
      )
      .run(id, pid, RUN_SESSION, content, tokensEach, T + i * 1000);
  }
  return ids;
}

/** Seed a gen-0 distillation row carrying `observations` for a given session. */
function seedDistillation(sessionID: string, observations: string): void {
  const pid = ensureProject(PROJECT);
  db()
    .query(
      `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, archived, created_at)
       VALUES (?, ?, ?, '', '[]', ?, '[]', 0, ?, 0, ?)`,
    )
    .run(
      crypto.randomUUID(),
      pid,
      sessionID,
      observations,
      Math.ceil(observations.length / 3),
      Date.now(),
    );
}

function makeStubLLM(response: string): LLMClient & {
  prompts: Array<{ system: string; user: string }>;
} {
  const prompts: Array<{ system: string; user: string }> = [];
  return {
    prompts,
    prompt: async (system: string, user: string) => {
      prompts.push({ system, user });
      return response;
    },
  };
}

function prefExists(title: string): boolean {
  const pid = ensureProject(PROJECT);
  const row = db()
    .query(
      `SELECT id FROM knowledge_current
       WHERE project_id = ? AND LOWER(title) = LOWER(?)
       AND category = 'preference' AND confidence > 0 LIMIT 1`,
    )
    .get(pid, title) as { id: string } | null;
  return row != null;
}

beforeEach(() => {
  const pid = ensureProject(PROJECT);
  db().query("DELETE FROM temporal_messages WHERE project_id = ?").run(pid);
  db().query("DELETE FROM distillations WHERE project_id = ?").run(pid);
  db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
});

afterEach(() => {
  // Reset to a tracer-less sink so other tests see pass-through behavior.
  registerSink(passthroughSink);
});

describe("action-tag minting batches per-tag session counts (#1023)", () => {
  test("counts every tag in a single distillations scan, with independent per-tag thresholds", async () => {
    // requested-tests: present in 2 OTHER sessions; enforced-workflow: 1 other.
    // The run stores this segment's distillation (carrying BOTH tags) under
    // RUN_SESSION → requested-tests reaches 3 distinct sessions (mints),
    // enforced-workflow reaches 2 (does NOT mint).
    seedDistillation(
      "sess-A",
      "did things [requested-tests] [enforced-workflow]",
    );
    seedDistillation("sess-B", "more things [requested-tests]");

    insertTemporalMessages(6, 200);
    const observations =
      "user behaviour this segment [requested-tests] and [enforced-workflow] noted";
    const llm = makeStubLLM(`<observations>\n${observations}\n</observations>`);

    // Record SQL only for the run() under test.
    const calls: string[] = [];
    registerSink(recordingSink(calls));

    await run({
      llm,
      projectPath: PROJECT,
      sessionID: RUN_SESSION,
      force: true,
    });

    // Single-pass invariant: the per-tag count scan over `distillations` (the
    // one carrying `observations LIKE`) runs exactly ONCE, regardless of how
    // many known tags the segment had. The old per-tag loop ran it once per
    // tag (here: 2×) → this assertion fails under that mutation.
    const countScans = calls.filter(
      (sql) => /FROM distillations/.test(sql) && /observations LIKE/.test(sql),
    );
    expect(countScans.length).toBe(1);

    // Correctness: independent per-tag thresholds.
    expect(prefExists("Always write tests alongside implementation")).toBe(
      true,
    );
    expect(
      prefExists("Follow the established git workflow (branch, PR, review)"),
    ).toBe(false);
  });

  test("a tag below the 3-session threshold is not minted", async () => {
    // requested-tests in only 1 other session; +this run = 2 < 3.
    seedDistillation("sess-A", "did things [requested-tests]");

    insertTemporalMessages(6, 200);
    const llm = makeStubLLM(
      "<observations>\nthis run [requested-tests] only\n</observations>",
    );

    await run({
      llm,
      projectPath: PROJECT,
      sessionID: RUN_SESSION,
      force: true,
    });

    expect(prefExists("Always write tests alongside implementation")).toBe(
      false,
    );
  });
});
