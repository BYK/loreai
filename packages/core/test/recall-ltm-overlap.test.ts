import { beforeEach, describe, expect, test } from "vitest";
import { db, ensureProject } from "../src/db";
import * as ltm from "../src/ltm";
import { runRecall } from "../src/recall";

// Recall should surface a hint when its hits overlap with knowledge entries
// that are already in the model's LTM context (system[1] catalog or durable
// prompt-delta pair). Without the hint, a fully-redundant recall tricks the
// model into thinking it has new information and emits a silent 3-token stop
// (ses_050c83e5affeLnTm79tRu5avfs / lore 0lDy9O8ouc2M1ulK, 2026-07-31).

const PROJECT = "/test/recall-ltm-overlap/project";

function cleanup() {
  db().exec("DELETE FROM knowledge");
  db().exec("DELETE FROM distillations");
  db().exec("DELETE FROM temporal_messages");
}

function seed(title: string, content: string): string {
  return ltm.create({
    projectPath: PROJECT,
    scope: "project",
    crossProject: false,
    category: "gotcha",
    title,
    content,
  });
}

/**
 * Seed a distillation whose observations contain the query tokens. The
 * distillation row is FTS-indexed via distillation_fts on its `observations`
 * column — running `runRecall({query})` with overlapping tokens will surface
 * it as a distillation source (not a knowledge source). Used to test the
 * knowledge-only overlap counting in the LTM-overlap hint.
 */
function seedDistillationMatching(queryTokens: string): string {
  const pid = ensureProject(PROJECT);
  const id = "019f0000-0000-7000-8000-000000000001";
  db()
    .query(
      `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, archived, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      pid,
      "s1",
      "",
      "[]",
      `Observed ${queryTokens} behavior in audit log`,
      "[]",
      0,
      20,
      0,
      Date.now(),
    );
  return id;
}

describe("recall — alreadyInLtmIds hint", () => {
  beforeEach(() => {
    cleanup();
    ensureProject(PROJECT);
  });

  test("no hint when no IDs overlap", async () => {
    seed("Adm's openrouter key is invalid", "do not use");
    seed("Burak's anthropic key works", "fresh from console");

    const out = await runRecall({
      query: "openrouter key",
      projectPath: PROJECT,
      sessionID: "s1",
      // Different IDs from what recall will hit — simulates a different
      // session's stable LTM snapshot.
      alreadyInLtmIds: new Set(["11111111-2222-7333-9444-555555555555"]),
    });

    expect(out).not.toContain("already in your LTM context");
    expect(out).not.toContain("results already");
  });

  test("partial overlap emits 'N of K knowledge entries already in LTM'", async () => {
    const idA = seed("Adm's openrouter key", "test value A");
    seed("Adm's openrouter key 2", "test value B");

    const out = await runRecall({
      query: "openrouter key",
      projectPath: PROJECT,
      sessionID: "s1",
      alreadyInLtmIds: new Set([idA]),
    });

    expect(out).toMatch(
      /1 of \d+ shown knowledge entries are already in your LTM/,
    );
    expect(out).toContain("Only the non-overlapping entries are new");
  });

  test("full overlap emits 'All K already in LTM'", async () => {
    const idA = seed("Adm's openrouter key", "test value A");
    const idB = seed("Adm's openrouter key 2", "test value B");

    const out = await runRecall({
      query: "openrouter key",
      projectPath: PROJECT,
      sessionID: "s1",
      alreadyInLtmIds: new Set([idA, idB]),
    });

    expect(out).toMatch(
      /All \d+ shown knowledge entries are already in your LTM/,
    );
    expect(out).toContain("No new information");
  });

  test("full knowledge overlap compares knowledge-vs-knowledge (Seer 15623149/0)", async () => {
    // Regression: when kept[] contains a mix of knowledge + distillation +
    // temporal, the full-overlap hint must compare `inLtmCount` (only
    // knowledge) against the knowledge-only subset, NOT `kept.length`.
    //
    // Setup mixes 2 knowledge entries with a matching distillation so
    // `kept.length` (3) > `knowledgeKeptCount` (2). With the bug, the full-
    // overlap branch would NOT fire (inLtmCount=2 ≠ kept.length=3) and
    // we'd see a misleading "2 of 3" partial hint instead of "All 2".
    const idA = seed("Openrouter config A", "auth A");
    const idB = seed("Openrouter config B", "auth B");
    seedDistillationMatching("openrouter token leak");

    const out = await runRecall({
      query: "openrouter",
      projectPath: PROJECT,
      sessionID: "s1",
      alreadyInLtmIds: new Set([idA, idB]),
    });

    // Full knowledge overlap (inLtmCount=2 === knowledgeKeptCount=2) → All 2.
    // A bug would emit "2 of 3" partial since kept.length=3.
    expect(out).toMatch(
      /All 2 shown knowledge entries are already in your LTM/,
    );
    expect(out).not.toMatch(
      /2 of \d+ shown knowledge entries are already in your LTM/,
    );
  });

  test("partial knowledge overlap uses knowledge-only denominator (Seer 15623354/0)", async () => {
    // Regression: the partial-overlap hint must use `knowledgeKeptCount`
    // as the denominator, not `kept.length`. Without this fix a recall
    // returning 1 knowledge (in LTM) + 1 distillation emits "1 of 2" —
    // looking like a small slice — when in fact 1 of 1 knowledge entry
    // is already in LTM and only the 1 distillation is new.
    const idA = seed("Openrouter config A", "auth A");
    seed("Openrouter config B", "auth B");
    seedDistillationMatching("openrouter token leak");

    const out = await runRecall({
      query: "openrouter",
      projectPath: PROJECT,
      sessionID: "s1",
      alreadyInLtmIds: new Set([idA]),
    });

    // Partial overlap (inLtmCount=1, knowledgeKeptCount=2, kept.length=3).
    // Expected denominator: 2 (knowledge only). The bug would emit "1 of 3".
    expect(out).toMatch(
      /1 of 2 shown knowledge entries are already in your LTM/,
    );
    expect(out).not.toMatch(/1 of \d+ shown entries are already in your LTM/);
  });

  test("hint only counts knowledge hits (distillations/temporal are skipped)", async () => {
    // Regression: the source-type filter inside `inLtmCount` must exclude
    // non-knowledge hits (distillations, temporal). Without the filter, a
    // distillation ID in `alreadyInLtmIds` would inflate the count from 1
    // to 2 — producing a misleading "All 2" full-overlap hint when only
    // 1 knowledge entry is actually in LTM.
    const idA = seed("Openrouter config", "auth A");
    seed("Openrouter config B", "auth B");
    const distillationId = seedDistillationMatching("openrouter token leak");

    const out = await runRecall({
      query: "openrouter",
      projectPath: PROJECT,
      sessionID: "s1",
      alreadyInLtmIds: new Set([idA, distillationId]),
    });

    // 1 knowledge entry is in LTM (idA); the distillation ID is also in the
    // set, but the source-type filter must keep the count at 1 (not 2).
    // With the bug, inLtmCount would equal knowledgeKeptCount=2 → full hint.
    // With the fix, inLtmCount=1 < knowledgeKeptCount=2 → partial hint.
    expect(out).toMatch(
      /1 of 2 shown knowledge entries are already in your LTM/,
    );
    expect(out).not.toMatch(
      /All 2 shown knowledge entries are already in your LTM/,
    );
  });

  test("empty alreadyInLtmIds behaves like undefined (no hint)", async () => {
    seed("Openrouter config", "auth A");

    const out = await runRecall({
      query: "openrouter",
      projectPath: PROJECT,
      sessionID: "s1",
      alreadyInLtmIds: new Set(),
    });

    expect(out).not.toContain("already in your LTM context");
  });

  test("undefined alreadyInLtmIds emits no hint (backwards compat)", async () => {
    seed("Openrouter config", "auth A");

    const out = await runRecall({
      query: "openrouter",
      projectPath: PROJECT,
      sessionID: "s1",
    });

    expect(out).not.toContain("already in your LTM context");
  });
});
