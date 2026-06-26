import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { applyOps } from "../src/curator";
import { db, ensureProject } from "../src/db";
import { type LogSink, registerSink } from "../src/log";
import * as ltm from "../src/ltm";

const PROJECT = "/tmp/lore-curator-ensureproject-hoist/project";
const OTHER_PROJECT = "/tmp/lore-curator-ensureproject-hoist/other-project";

// ensureProject()'s fast-path lookup. Counting this exact statement isolates
// project-resolution calls from any other `projects` access.
const ENSURE_PROJECT_SQL = "SELECT id, git_remote FROM projects WHERE path = ?";

function countingSink(counts: Record<string, number>): LogSink {
  return {
    info() {},
    warn() {},
    error() {},
    captureException() {},
    withDbSpan<T>(sql: string, fn: () => T): T {
      if (sql.includes(ENSURE_PROJECT_SQL)) {
        counts.projects = (counts.projects ?? 0) + 1;
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

describe("applyOps resolves the project id once (no per-op ensureProject N+1)", () => {
  beforeEach(() => {
    const pid = ensureProject(PROJECT);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
    const otherPid = ensureProject(OTHER_PROJECT);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(otherPid);
  });

  afterEach(() => {
    registerSink(NOOP_SINK);
  });

  test("project table is resolved once for a multi-op update+delete batch", () => {
    // Five project-scoped entries. Created before the sink is registered so
    // setup's ensureProject calls aren't counted.
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) {
      ids.push(
        ltm.create({
          projectPath: PROJECT,
          category: "decision",
          title: `Hoist entry ${i}`,
          content: `Original content ${i}.`,
          scope: "project",
        }),
      );
    }

    const counts: Record<string, number> = {};
    registerSink(countingSink(counts));

    // Exercise BOTH per-op ownership guards (update branch + delete branch).
    const result = applyOps(
      [
        { op: "update" as const, id: ids[0], content: "Updated 0." },
        { op: "update" as const, id: ids[1], content: "Updated 1." },
        { op: "update" as const, id: ids[2], content: "Updated 2." },
        { op: "delete" as const, id: ids[3], reason: "obsolete" },
        { op: "delete" as const, id: ids[4], reason: "obsolete" },
      ],
      { projectPath: PROJECT, sessionID: "sess-hoist" },
    );

    expect(result.updated).toBe(3);
    expect(result.deleted).toBe(2);

    // The N+1: before hoisting, each update/delete ownership guard called
    // ensureProject() → one project lookup per op (5 total). Hoisting resolves
    // the project id exactly once for the whole batch.
    expect(counts.projects).toBe(1);
  });

  test("cross-project ownership guard still skips foreign entries with a single resolve", () => {
    // One entry owned by THIS project, one owned by a DIFFERENT project. The
    // ownership guard must skip the foreign entry (no mutate/delete) — and the
    // resolved project id must still be reused across the skip path, so the
    // projects table is read exactly once even though the guard fires on both
    // an own-project op and a foreign-project op.
    const ownId = ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Own entry",
      content: "Own original.",
      scope: "project",
    });
    const foreignId = ltm.create({
      projectPath: OTHER_PROJECT,
      category: "decision",
      title: "Foreign entry",
      content: "Foreign original.",
      scope: "project",
    });

    const counts: Record<string, number> = {};
    registerSink(countingSink(counts));

    const result = applyOps(
      [
        { op: "update" as const, id: ownId, content: "Own updated." },
        { op: "update" as const, id: foreignId, content: "Foreign updated." },
        { op: "delete" as const, id: foreignId, reason: "obsolete" },
      ],
      { projectPath: PROJECT, sessionID: "sess-hoist-foreign" },
    );

    // Only the own-project update is applied; the foreign update + delete are
    // both skipped by the ownership guard.
    expect(result.updated).toBe(1);
    expect(result.deleted).toBe(0);

    // The foreign entry is untouched (not mutated, not deleted).
    const foreign = ltm.get(foreignId) ?? ltm.getByLogical(foreignId);
    expect(foreign?.content).toBe("Foreign original.");

    // Resolved once and reused across both guard hits (own + foreign).
    expect(counts.projects).toBe(1);
  });
});
