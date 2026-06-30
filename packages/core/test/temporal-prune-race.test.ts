import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { db, ensureProject } from "../src/db";
import { registerSink, type LogSink } from "../src/log";
import { prune } from "../src/temporal";

// #1001: the active db() connection is rebuilt by maintenance (overflow /
// split / magnet) several times per run; an idle prune can race that window and
// hit a connection where a table is momentarily absent
// (`SQLiteError: no such table: distillations`, observed in Pass 3). Each pass
// is now wrapped so a missing-object error is a no-op for that tick while the
// other passes still run; any other error propagates.
//
// We reproduce the symptom precisely without touching the schema: the DB query
// tracer (`withDbSpan`) wraps every executed statement, so a sink can throw for
// a chosen SQL string exactly as the live connection would during a swap.

const PROJECT = "/test/temporal-prune-race";
const DAY = 24 * 60 * 60 * 1000;

const passthroughSink: LogSink = {
  info() {},
  warn() {},
  error() {},
  captureException() {},
};

/** Sink that throws `err` for any executed SQL matching `match`, else passes
 *  through. Simulates the live connection failing on one pass mid-swap. */
function throwingSink(match: RegExp, err: Error): LogSink {
  return {
    ...passthroughSink,
    withDbSpan<T>(sql: string, fn: () => T): T {
      if (match.test(sql)) throw err;
      return fn();
    },
  };
}

function seedDistilledMessage(ageMs: number): string {
  const pid = ensureProject(PROJECT);
  const id = `prune-msg-${crypto.randomUUID()}`;
  db()
    .query(
      `INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
       VALUES (?, ?, 'sess', 'user', ?, 5, 1, ?, '{}')`,
    )
    .run(id, pid, "x".repeat(30), Date.now() - ageMs);
  return id;
}

function seedArchivedDistillation(ageMs: number): string {
  const pid = ensureProject(PROJECT);
  const id = crypto.randomUUID();
  db()
    .query(
      `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, archived, created_at)
       VALUES (?, ?, 'sess', '', '[]', 'obs', '[]', 0, 1, 1, ?)`,
    )
    .run(id, pid, Date.now() - ageMs);
  return id;
}

function temporalCount(): number {
  const pid = ensureProject(PROJECT);
  return (
    db()
      .query("SELECT COUNT(*) as c FROM temporal_messages WHERE project_id = ?")
      .get(pid) as { c: number }
  ).c;
}

function distillationExists(id: string): boolean {
  return (
    db().query("SELECT id FROM distillations WHERE id = ?").get(id) != null
  );
}

beforeEach(() => {
  const pid = ensureProject(PROJECT);
  db().query("DELETE FROM temporal_messages WHERE project_id = ?").run(pid);
  db().query("DELETE FROM distillations WHERE project_id = ?").run(pid);
});

afterEach(() => {
  registerSink(passthroughSink);
});

describe("temporal.prune resilience to a db()-swap missing-table race (#1001)", () => {
  test("a missing-object error in Pass 3 is swallowed; Passes 1-2 still commit", () => {
    seedDistilledMessage(10 * DAY); // older than retention → Pass 1 deletes
    const arch = seedArchivedDistillation(10 * DAY); // Pass 3 would delete it

    // Pass 3's DELETE throws no-such-table, as during a maintenance swap.
    registerSink(
      throwingSink(
        /DELETE FROM distillations/,
        new Error("no such table: distillations"),
      ),
    );

    let result: { ttlDeleted: number; capDeleted: number } | undefined;
    expect(() => {
      result = prune({
        projectPath: PROJECT,
        retentionDays: 1,
        maxStorageMB: 999_999,
      });
    }).not.toThrow();

    // Pass 1 committed its delete (partial progress returned)…
    expect(result?.ttlDeleted).toBe(1);
    registerSink(passthroughSink);
    expect(temporalCount()).toBe(0);
    // …but Pass 3 was skipped, so the archived distillation survives this tick.
    expect(distillationExists(arch)).toBe(true);
  });

  test("passes are independent: a Pass 1 missing-object error still lets Pass 3 run", () => {
    seedDistilledMessage(10 * DAY);
    const arch = seedArchivedDistillation(10 * DAY);

    // Pass 1's COUNT throws no-such-table; Passes 2-3 must still execute.
    registerSink(
      throwingSink(
        /SELECT COUNT\(\*\) as c FROM temporal_messages/,
        new Error("no such table: temporal_messages"),
      ),
    );

    let result: { ttlDeleted: number; capDeleted: number } | undefined;
    expect(() => {
      result = prune({
        projectPath: PROJECT,
        retentionDays: 1,
        maxStorageMB: 999_999,
      });
    }).not.toThrow();

    expect(result?.ttlDeleted).toBe(0); // Pass 1 skipped → nothing deleted there
    registerSink(passthroughSink);
    expect(temporalCount()).toBe(1); // Pass 1 delete never ran
    expect(distillationExists(arch)).toBe(false); // Pass 3 ran despite Pass 1 failing
  });

  test("a non-missing-object error propagates (not swallowed)", () => {
    seedArchivedDistillation(10 * DAY);
    registerSink(
      throwingSink(
        /DELETE FROM distillations/,
        new Error("database disk image is malformed"),
      ),
    );

    expect(() =>
      prune({
        projectPath: PROJECT,
        retentionDays: 1,
        maxStorageMB: 999_999,
      }),
    ).toThrow(/disk image is malformed/);
  });
});
