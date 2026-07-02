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

/** Like `throwingSink` but also records every `warn` message into `warns`, so a
 *  test can assert when a persistent miss escalates from info to warn. */
function recordingThrowingSink(
  match: RegExp,
  err: Error,
  warns: string[],
): LogSink {
  return {
    info() {},
    warn(...args: unknown[]) {
      warns.push(args.map(String).join(" "));
    },
    error() {},
    captureException() {},
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

    // Pass 1's id-select throws no-such-table; Passes 2-3 must still execute.
    registerSink(
      throwingSink(
        /SELECT id FROM temporal_messages/,
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

  test("a missing-object error while resolving the project (setup) skips the whole tick", () => {
    const msg = seedDistilledMessage(10 * DAY); // Pass 1 would delete this if prune proceeded
    expect(msg).toBeTruthy();

    // ensureProject's `SELECT … FROM projects` races the swap and throws
    // no-such-table *before* any pass runs. The whole tick must no-op, not abort.
    registerSink(
      throwingSink(
        /FROM projects WHERE path/,
        new Error("no such table: projects"),
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

    expect(result).toEqual({ ttlDeleted: 0, capDeleted: 0 });
    registerSink(passthroughSink);
    expect(temporalCount()).toBe(1); // setup skipped → no pass deleted anything
  });

  test("a persistent missing-object skip escalates from info to warn after N consecutive ticks", () => {
    const opts = {
      projectPath: PROJECT,
      retentionDays: 1,
      maxStorageMB: 999_999,
    };

    // A clean prune first resets the consecutive-skip streak to a known 0, so
    // this test is independent of whichever tests ran before it.
    registerSink(passthroughSink);
    prune(opts);

    const warns: string[] = [];
    registerSink(
      recordingThrowingSink(
        /SELECT id FROM distillations/,
        new Error("no such table: distillations"),
        warns,
      ),
    );

    // The first two consecutive missing-object ticks stay quiet (info only):
    // a transient swap window must not spam warn.
    prune(opts);
    prune(opts);
    expect(warns).toHaveLength(0);

    // The third consecutive miss crosses the escalation threshold → warn.
    prune(opts);
    expect(warns.length).toBeGreaterThanOrEqual(1);
    expect(warns[0]).toMatch(/consecutive/i);

    // A subsequent clean tick clears the streak so warn does not persist.
    registerSink(passthroughSink);
    prune(opts);
    const warnsAfterRecovery: string[] = [];
    registerSink(
      recordingThrowingSink(
        /SELECT id FROM distillations/,
        new Error("no such table: distillations"),
        warnsAfterRecovery,
      ),
    );
    prune(opts);
    expect(warnsAfterRecovery).toHaveLength(0);
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
