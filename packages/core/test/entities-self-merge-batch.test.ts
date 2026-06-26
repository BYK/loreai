import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { db } from "../src/db";
import * as entities from "../src/entities";
import { type LogSink, registerSink } from "../src/log";

// A LogSink whose withDbSpan tallies how many times entity_aliases is read.
// withDbSpan MUST stay a pass-through (call fn() once, return its value) so
// query behavior is unchanged.
function countingSink(counts: Record<string, number>): LogSink {
  return {
    info() {},
    warn() {},
    error() {},
    captureException() {},
    withDbSpan<T>(sql: string, fn: () => T): T {
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

describe("mergeSelfPersonDuplicates alias lookup is batched (no N+1)", () => {
  beforeEach(() => {
    db().query("DELETE FROM entity_aliases").run();
    db().query("DELETE FROM entities").run();
  });

  afterEach(() => {
    // Restore a benign sink (no withDbSpan → pass-through) so the counting sink
    // can't leak into later tests.
    registerSink(NOOP_SINK);
  });

  test("reads entity_aliases once for the whole person scan, not once per person", () => {
    // Self entity with no overlapping identity → no person will merge, so the
    // merge() write path never runs and only the alias *reads* are counted.
    const self = entities.create({
      entityType: "self",
      canonicalName: "MergeSelf",
      aliases: [{ type: "email", value: "self@example.com", source: "config" }],
      crossProject: true,
    });

    // Four unrelated persons (names and aliases disjoint from self) — each one
    // forces the per-person alias lookup in the unbatched code.
    for (let i = 1; i <= 4; i++) {
      entities.create({
        entityType: "person",
        canonicalName: `MergePerson${i}`,
        aliases: [
          { type: "github", value: `unrelated-handle-${i}`, source: "curator" },
        ],
        crossProject: true,
      });
    }

    // biome-ignore lint/style/noNonNullAssertion: just created
    const selfEntity = entities.getWithAliases(self.id)!;

    const counts: Record<string, number> = {};
    registerSink(countingSink(counts));

    const merged = entities.mergeSelfPersonDuplicates(selfEntity);

    // No matches → no merges (so no merge-path entity_aliases writes inflate
    // the count).
    expect(merged).toBe(0);

    // The N+1: before batching, the loop read entity_aliases once per person
    // → 4 reads. Batching reads the table exactly once for the whole scan.
    expect(counts.aliases).toBe(1);
  });
});
