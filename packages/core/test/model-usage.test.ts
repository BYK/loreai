/**
 * Tests for buildDailyModelUsage (#2026): session-count aggregation over
 * temporal_messages, provider/model metadata filters, day bounds, tenant
 * scoping, and the model-tides v2 document shape.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { db, ensureProject } from "../src/db";
import {
  buildDailyModelUsage,
  _setMaxDailyCellsForTest,
  ModelUsageFilterError,
  ModelUsageLimitError,
} from "../src/model-usage";
import { withTenant } from "../src/tenant";

const PROJECT = "/test/model-usage/project";
const PROJECT_B = "/test/model-usage/project-b";

const DAY1 = Date.UTC(2025, 2, 1); // 2025-03-01T00:00:00.000Z
const DAY2 = Date.UTC(2025, 2, 2);

function insertMessage(
  projectId: string,
  opts: {
    id: string;
    sessionId: string;
    role?: string;
    createdAt: number;
    metadata?: string | null;
  },
): void {
  db()
    .query(
      `INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
       VALUES (?, ?, ?, ?, 'content', 10, 0, ?, ?)`,
    )
    .run(
      opts.id,
      projectId,
      opts.sessionId,
      opts.role ?? "assistant",
      opts.createdAt,
      opts.metadata ?? null,
    );
}

function assistantMeta(
  modelID: unknown,
  providerID: unknown = "anthropic",
): string {
  return JSON.stringify({ modelID, providerID, mode: "gateway" });
}

let pid: string;
let pidB: string;
let seq = 0;
function add(
  opts: Omit<Parameters<typeof insertMessage>[1], "id">,
  projectId = pid,
): void {
  insertMessage(projectId, { ...opts, id: `m-${seq++}` });
}

beforeEach(() => {
  // Rows persist across tests in this file's shared DB.
  db().query("DELETE FROM temporal_messages").run();
  pid = ensureProject(PROJECT);
  pidB = ensureProject(PROJECT_B);
});

afterEach(() => {
  _setMaxDailyCellsForTest();
});

describe("buildDailyModelUsage", () => {
  test("empty database yields a valid empty document", () => {
    const doc = buildDailyModelUsage();
    expect(doc).toEqual({
      format: "model-tides-daily",
      version: 2,
      source: "lore",
      days: [],
    });
  });

  test("multiple turns of one session/model/day count once", () => {
    for (let i = 0; i < 4; i++) {
      add({
        sessionId: "s1",
        createdAt: DAY1 + i * 60_000,
        metadata: assistantMeta("claude-sonnet-4"),
      });
    }
    const doc = buildDailyModelUsage();
    expect(doc.days).toEqual([
      { day: "2025-03-01", models: { "anthropic/claude-sonnet-4": 1 } },
    ]);
  });

  test("same session on two days counts once per day", () => {
    add({
      sessionId: "s1",
      createdAt: DAY1 + 60_000,
      metadata: assistantMeta("claude-sonnet-4"),
    });
    add({
      sessionId: "s1",
      createdAt: DAY2 + 60_000,
      metadata: assistantMeta("claude-sonnet-4"),
    });
    const doc = buildDailyModelUsage();
    expect(doc.days).toEqual([
      { day: "2025-03-01", models: { "anthropic/claude-sonnet-4": 1 } },
      { day: "2025-03-02", models: { "anthropic/claude-sonnet-4": 1 } },
    ]);
  });

  test("two models same day count one each; models sorted by key", () => {
    add({
      sessionId: "s1",
      createdAt: DAY1,
      metadata: assistantMeta("gpt-5", "openai"),
    });
    add({
      sessionId: "s1",
      createdAt: DAY1 + 60_000,
      metadata: assistantMeta("claude-sonnet-4"),
    });
    const doc = buildDailyModelUsage();
    expect(doc.days).toHaveLength(1);
    expect(Object.keys(doc.days[0].models)).toEqual([
      "anthropic/claude-sonnet-4",
      "openai/gpt-5",
    ]);
    expect(doc.days[0].models["openai/gpt-5"]).toBe(1);
    expect(doc.days[0].models["anthropic/claude-sonnet-4"]).toBe(1);
  });

  test("same session_id in two projects counts twice", () => {
    add({
      sessionId: "shared",
      createdAt: DAY1,
      metadata: assistantMeta("claude-sonnet-4"),
    });
    add(
      {
        sessionId: "shared",
        createdAt: DAY1 + 60_000,
        metadata: assistantMeta("claude-sonnet-4"),
      },
      pidB,
    );
    const doc = buildDailyModelUsage();
    expect(doc.days[0].models["anthropic/claude-sonnet-4"]).toBe(2);
  });

  test("excludes user messages and missing/invalid model metadata", () => {
    const base = { sessionId: "s1", createdAt: DAY1 };
    add({ ...base, role: "user", metadata: assistantMeta("claude-sonnet-4") });
    add({ ...base, sessionId: "s2", metadata: assistantMeta("unknown") });
    add({ ...base, sessionId: "s3", metadata: assistantMeta("gateway") });
    add({ ...base, sessionId: "s4", metadata: assistantMeta("") });
    add({ ...base, sessionId: "s5", metadata: assistantMeta(42) });
    add({ ...base, sessionId: "s6", metadata: '{"modelID":"x"}' }); // no providerID
    add({ ...base, sessionId: "s7", metadata: '{"providerID":"anthropic"}' });
    add({ ...base, sessionId: "s8", metadata: null });
    add({ ...base, sessionId: "s9", metadata: assistantMeta(5, null) });
    expect(buildDailyModelUsage().days).toEqual([]);
  });

  test("drops invalid model names, keeps a 320-char model", () => {
    const good = "anthropic/" + "m".repeat(310); // total length exactly 320
    add({
      sessionId: "s1",
      createdAt: DAY1,
      metadata: assistantMeta("trailing-space "),
    });
    add({
      sessionId: "s2",
      createdAt: DAY1,
      metadata: assistantMeta("ctrlx"),
    });
    add({
      sessionId: "s3",
      createdAt: DAY1,
      metadata: assistantMeta("m".repeat(311)), // model total 321
    });
    add({
      sessionId: "s4",
      createdAt: DAY1,
      metadata: assistantMeta("m".repeat(310)),
    });
    const doc = buildDailyModelUsage();
    expect(doc.days).toEqual([{ day: "2025-03-01", models: { [good]: 1 } }]);
  });

  test("from/to bounds are inclusive UTC days at exact millisecond edges", () => {
    add({
      sessionId: "s1",
      createdAt: DAY1, // 00:00:00.000
      metadata: assistantMeta("claude-sonnet-4"),
    });
    add({
      sessionId: "s2",
      createdAt: DAY2 - 1, // 2025-03-01T23:59:59.999
      metadata: assistantMeta("claude-sonnet-4"),
    });
    add({
      sessionId: "s3",
      createdAt: DAY2, // excluded when to=2025-03-01
      metadata: assistantMeta("claude-sonnet-4"),
    });
    const doc = buildDailyModelUsage({ from: "2025-03-01", to: "2025-03-01" });
    expect(doc.days).toEqual([
      { day: "2025-03-01", models: { "anthropic/claude-sonnet-4": 2 } },
    ]);
    const all = buildDailyModelUsage({ from: "2025-03-01", to: "2025-03-02" });
    expect(all.days[1].models["anthropic/claude-sonnet-4"]).toBe(1);
  });

  test("projectId filter scopes counts to one project", () => {
    add({
      sessionId: "s1",
      createdAt: DAY1,
      metadata: assistantMeta("claude-sonnet-4"),
    });
    add(
      {
        sessionId: "s2",
        createdAt: DAY1,
        metadata: assistantMeta("claude-sonnet-4"),
      },
      pidB,
    );
    expect(buildDailyModelUsage({ projectId: pidB }).days[0].models).toEqual({
      "anthropic/claude-sonnet-4": 1,
    });
  });

  test("rows from another tenant's project are not counted", () => {
    const foreignPid = withTenant("model-usage-foreign", () =>
      ensureProject("/test/model-usage/foreign"),
    );
    withTenant("model-usage-foreign", () =>
      insertMessage(foreignPid, {
        id: "foreign-m",
        sessionId: "fs",
        createdAt: DAY1,
        metadata: assistantMeta("claude-sonnet-4"),
      }),
    );
    expect(buildDailyModelUsage().days).toEqual([]);
    expect(buildDailyModelUsage({ projectId: foreignPid }).days).toEqual([]);
  });

  test("rejects unreal and inverted date filters", () => {
    expect(() => buildDailyModelUsage({ from: "2026-02-30" })).toThrow(
      ModelUsageFilterError,
    );
    expect(() => buildDailyModelUsage({ from: "not-a-date" })).toThrow(
      ModelUsageFilterError,
    );
    expect(() =>
      buildDailyModelUsage({ from: "2025-03-02", to: "2025-03-01" }),
    ).toThrow(ModelUsageFilterError);
    // Same day from == to is a valid single-day range.
    expect(
      buildDailyModelUsage({ from: "2025-03-01", to: "2025-03-01" }).days,
    ).toEqual([]);
  });

  test("throws ModelUsageLimitError past the cell cap", () => {
    _setMaxDailyCellsForTest(2);
    for (const sessionId of ["s1", "s2", "s3"]) {
      add({
        sessionId,
        createdAt: DAY1,
        metadata: assistantMeta(`${sessionId}-model`),
      });
    }
    expect(() => buildDailyModelUsage()).toThrow(ModelUsageLimitError);
  });

  test("days before MIN_WEEK_TIME are dropped", () => {
    add({
      sessionId: "s1",
      createdAt: Date.UTC(1990, 0, 1),
      metadata: assistantMeta("claude-sonnet-4"),
    });
    expect(buildDailyModelUsage().days).toEqual([]);
  });
});
