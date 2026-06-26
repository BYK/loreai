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
});
