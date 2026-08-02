import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { applyOps } from "../src/curator";
import { db, ensureProject } from "../src/db";
import * as entities from "../src/entities";
import { type LogSink, registerSink } from "../src/log";

const PROJECT = "/tmp/lore-curator-entity-ref-batch/project";

// A LogSink whose withDbSpan tallies how many times specific SQL statements are
// executed. Everything else is a no-op. withDbSpan MUST stay a pass-through
// (call fn() once, return its value) so query behavior is unchanged.
function countingSink(counts: Record<string, number>): LogSink {
  return {
    info() {},
    warn() {},
    error() {},
    captureException() {},
    withDbSpan<T>(sql: string, fn: () => T): T {
      if (sql.includes("canonical_name FROM entities")) {
        counts.entities = (counts.entities ?? 0) + 1;
      }
      if (sql.includes("FROM entity_aliases")) {
        counts.aliases = (counts.aliases ?? 0) + 1;
      }
      if (sql.includes("INSERT OR IGNORE INTO knowledge_entity_refs")) {
        counts.refInsert = (counts.refInsert ?? 0) + 1;
      }
      return fn();
    },
  };
}

const NOOP_SINK: LogSink = {
  info() {},
  warn() {},
  error() {},
  captureException() {},
};

describe("curator entity-ref sync is batched (no N+1 registry reload)", () => {
  beforeEach(() => {
    const pid = ensureProject(PROJECT);
    db().query("DELETE FROM knowledge_entity_refs").run();
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
    db().query("DELETE FROM entities").run();
    db().query("DELETE FROM entity_aliases").run();
  });

  afterEach(() => {
    // Restore a benign sink (no withDbSpan → pass-through) so the counting sink
    // can't leak into later tests in this file.
    registerSink(NOOP_SINK);
  });

  test("entities/aliases tables load once per curator pass, not once per entry", () => {
    // Three entities the knowledge entries will mention by canonical name.
    const alpha = entities.create({
      projectPath: PROJECT,
      entityType: "tool",
      canonicalName: "AlphaWidget",
    }).id;
    const bravo = entities.create({
      projectPath: PROJECT,
      entityType: "tool",
      canonicalName: "BravoWidget",
    }).id;
    const charlie = entities.create({
      projectPath: PROJECT,
      entityType: "tool",
      canonicalName: "CharlieWidget",
    }).id;

    const counts: Record<string, number> = {};
    registerSink(countingSink(counts));

    // Curator applies three genuine creates, each mentioning a distinct entity.
    const result = applyOps(
      [
        {
          op: "create",
          category: "decision",
          title: "Entry One",
          content: "We rely on AlphaWidget for the first thing.",
          scope: "project",
        },
        {
          op: "create",
          category: "decision",
          title: "Entry Two",
          content: "BravoWidget powers the second thing.",
          scope: "project",
        },
        {
          op: "create",
          category: "decision",
          title: "Entry Three",
          content: "CharlieWidget handles the third thing.",
          scope: "project",
        },
      ],
      { projectPath: PROJECT, sessionID: "sess-batch" },
    );

    expect(result.created).toBe(3);

    // The N+1: before batching, syncEntityRefs reloaded both tables once per
    // entry → 3 loads each. Batching loads them exactly once for the whole pass.
    expect(counts.entities).toBe(1);
    expect(counts.aliases).toBe(1);

    // Behavioral equivalence guard: each entity is still linked to its entry.
    expect(entities.knowledgeForEntity(alpha)).toHaveLength(1);
    expect(entities.knowledgeForEntity(bravo)).toHaveLength(1);
    expect(entities.knowledgeForEntity(charlie)).toHaveLength(1);
  });

  test("knowledge_entity_refs INSERT runs once per entry, not once per matched entity (LOREAI-GATEWAY-3Y, LOREAI-GATEWAY-4Q)", () => {
    // Three entities, each mentioned by canonical name in three knowledge
    // entries → 3 entries × 3 entity matches = 9 refs total. Pre-fix this
    // produced 9 separate INSERT statements. Post-fix it produces exactly 3
    // (one multi-row INSERT per entry).
    const e1 = entities.create({
      projectPath: PROJECT,
      entityType: "tool",
      canonicalName: "DeltaWidget",
    });
    const e2 = entities.create({
      projectPath: PROJECT,
      entityType: "tool",
      canonicalName: "EchoWidget",
    });
    const e3 = entities.create({
      projectPath: PROJECT,
      entityType: "tool",
      canonicalName: "FoxtrotWidget",
    });

    const counts: Record<string, number> = {};
    registerSink(countingSink(counts));

    const result = applyOps(
      [
        {
          op: "create",
          category: "decision",
          title: "Entry One",
          content:
            "DeltaWidget, EchoWidget, and FoxtrotWidget all participate in the first thing.",
          scope: "project",
        },
        {
          op: "create",
          category: "decision",
          title: "Entry Two",
          content:
            "DeltaWidget, EchoWidget, and FoxtrotWidget power the second thing.",
          scope: "project",
        },
        {
          op: "create",
          category: "decision",
          title: "Entry Three",
          content:
            "DeltaWidget, EchoWidget, and FoxtrotWidget handle the third thing.",
          scope: "project",
        },
      ],
      { projectPath: PROJECT, sessionID: "sess-multi-row" },
    );

    expect(result.created).toBe(3);

    // Three entries → exactly three INSERT statements (one multi-row per entry).
    // Pre-fix this was 9 (one per matched entity).
    expect(counts.refInsert).toBe(3);

    // Behavioral equivalence: every (entity, knowledge) pair is linked.
    for (const entityId of [e1.id, e2.id, e3.id]) {
      expect(entities.knowledgeForEntity(entityId)).toHaveLength(3);
    }
  });

  test("syncEntityRefs skips INSERT entirely when content matches no entities (empty-skip branch)", () => {
    // Seed an entity whose canonical name is NOT in the entry content. The
    // inner `if (linkedEntityIds.size)` guard at entities.ts:2107 must skip
    // the multi-row INSERT altogether — no statement, no Sentry span.
    // quality/REVIEW.md §5: skip/early-return branches are the highest-risk
    // surface and must have a test that makes the branch fire.
    entities.create({
      projectPath: PROJECT,
      entityType: "tool",
      canonicalName: "MysteryTool",
    });

    const counts: Record<string, number> = {};
    registerSink(countingSink(counts));

    const result = applyOps(
      [
        {
          op: "create",
          category: "decision",
          title: "Entry With No Entities",
          content: "This entry mentions nothing in the entity registry.",
          scope: "project",
        },
      ],
      { projectPath: PROJECT, sessionID: "sess-empty-skip" },
    );
    expect(result.created).toBe(1);

    // Empty linkedEntityIds → zero INSERT statements. The pre-fix per-row
    // loop also produced 0 statements on this path (loop didn't execute),
    // but the new `if (linkedEntityIds.size)` guard must preserve the same
    // observable behavior — and a regression that re-introduces the loop
    // unconditionally would still produce 0 here, so this test is the
    // canary that the guard is exercised, not that the count is exactly 0.
    expect(counts.refInsert ?? 0).toBe(0);
  });
});
