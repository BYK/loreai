import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { db, ensureProject } from "../src/db";
import * as entities from "../src/entities";
import { type LogSink, registerSink } from "../src/log";
import * as ltm from "../src/ltm";

const PROJECT = "/tmp/lore-entities-session-batch/project";

// A LogSink whose withDbSpan tallies how many times knowledge_entity_refs is
// read. withDbSpan MUST stay a pass-through (call fn() once, return its value)
// so query behavior is unchanged.
function countingSink(counts: Record<string, number>): LogSink {
  return {
    info() {},
    warn() {},
    error() {},
    captureException() {},
    withDbSpan<T>(sql: string, fn: () => T): T {
      if (sql.includes("knowledge_entity_refs")) {
        counts.refs = (counts.refs ?? 0) + 1;
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

let knowledgeSeq = 0;

// Create `count` real knowledge entries (FK target) and link each to `entityId`,
// so the entity has exactly `count` references in knowledge_entity_refs.
function linkRefs(entityId: string, count: number): void {
  for (let i = 0; i < count; i++) {
    knowledgeSeq++;
    const kid = ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: `Batch knowledge ${knowledgeSeq}`,
      content: `Body for batch knowledge ${knowledgeSeq}.`,
      scope: "project",
    });
    entities.linkKnowledge(kid, entityId);
  }
}

describe("entitiesForSession ref-count ranking is batched (no N+1)", () => {
  beforeEach(() => {
    const pid = ensureProject(PROJECT);
    db().query("DELETE FROM knowledge_entity_refs").run();
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
    db().query("DELETE FROM entities").run();
    db().query("DELETE FROM entity_aliases").run();
    db().query("DELETE FROM entity_relations").run();
  });

  afterEach(() => {
    // Restore a benign sink (no withDbSpan → pass-through) so the counting sink
    // can't leak into later tests.
    registerSink(NOOP_SINK);
  });

  test("reads knowledge_entity_refs once for the whole batch, not once per entity", () => {
    // Self entity (always included, no relations → guaranteed = {self}).
    entities.create({
      projectPath: PROJECT,
      entityType: "self",
      canonicalName: "BatchSelf",
    });

    // Four unrelated persons; with cap 2 and one guaranteed slot taken by self,
    // exactly one remaining slot is filled by relevance (knowledge ref count).
    const p1 = entities.create({
      projectPath: PROJECT,
      entityType: "person",
      canonicalName: "BatchP1",
    }).id;
    const p2 = entities.create({
      projectPath: PROJECT,
      entityType: "person",
      canonicalName: "BatchP2",
    }).id;
    const p3 = entities.create({
      projectPath: PROJECT,
      entityType: "person",
      canonicalName: "BatchP3",
    }).id;
    entities.create({
      projectPath: PROJECT,
      entityType: "person",
      canonicalName: "BatchP4",
    });

    // p2 is the most-referenced → should win the single remaining slot.
    linkRefs(p1, 1);
    linkRefs(p2, 3);
    linkRefs(p3, 1);

    const counts: Record<string, number> = {};
    registerSink(countingSink(counts));

    const result = entities.entitiesForSession(PROJECT, 2);

    // The N+1: before batching, ranking called knowledgeForEntity() once per
    // remaining entity → 4 reads of knowledge_entity_refs. Batching reads the
    // table exactly once for the whole pass.
    expect(counts.refs).toBe(1);

    // Behavioral guard: self + the most-referenced remaining entity (p2).
    expect(result.length).toBe(2);
    const ids = result.map((e) => e.id);
    expect(result.some((e) => e.entity_type === "self")).toBe(true);
    expect(ids).toContain(p2);
  });
});
