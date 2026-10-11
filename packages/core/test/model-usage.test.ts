/**
 * Tests for buildDailyModelUsage (#2026): session-count aggregation over
 * temporal_messages, provider/model metadata filters, day bounds, tenant
 * scoping, the model-tides v2 document shape, and read-pool failure policy.
 */
import { describe, test, expect, beforeEach, vi } from "vitest";
import { db, ensureProject } from "../src/db";
import { createHash } from "node:crypto";
import {
  buildDailyModelUsage,
  buildWeeklySnapshot,
  createOwner,
  deleteOwner,
  loadOwner,
  parseOwnedReport,
  parseSnapshot,
  saveOwner,
  snapshotSha256,
  weekStart,
  MAX_WEEKLY_CELLS,
  MAX_WEEKS,
  MAX_DAILY_CELLS,
  ModelUsageFilterError,
  ModelUsageLimitError,
  ModelUsageUnavailableError,
} from "../src/model-usage";
import { offloadAllOrTimeout, READ_JOB_TIMED_OUT } from "../src/read-offload";
import { withTenant, LOCAL_TENANT_ID } from "../src/tenant";

vi.mock("../src/read-offload", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/read-offload")>();
  return {
    ...original,
    offloadAllOrTimeout: vi.fn(original.offloadAllOrTimeout),
  };
});

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

describe("buildDailyModelUsage", () => {
  test("empty database yields a valid empty document", async () => {
    const doc = await buildDailyModelUsage();
    expect(doc).toEqual({
      format: "model-tides-daily",
      version: 2,
      source: "lore",
      days: [],
    });
  });

  test("multiple turns of one session/model/day count once", async () => {
    for (let i = 0; i < 4; i++) {
      add({
        sessionId: "s1",
        createdAt: DAY1 + i * 60_000,
        metadata: assistantMeta("claude-sonnet-4"),
      });
    }
    const doc = await buildDailyModelUsage();
    expect(doc.days).toEqual([
      { day: "2025-03-01", models: { "anthropic/claude-sonnet-4": 1 } },
    ]);
  });

  test("same session on two days counts once per day", async () => {
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
    const doc = await buildDailyModelUsage();
    expect(doc.days).toEqual([
      { day: "2025-03-01", models: { "anthropic/claude-sonnet-4": 1 } },
      { day: "2025-03-02", models: { "anthropic/claude-sonnet-4": 1 } },
    ]);
  });

  test("two models same day count one each; models sorted by key", async () => {
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
    const doc = await buildDailyModelUsage();
    expect(doc.days).toHaveLength(1);
    expect(Object.keys(doc.days[0].models)).toEqual([
      "anthropic/claude-sonnet-4",
      "openai/gpt-5",
    ]);
    expect(doc.days[0].models["openai/gpt-5"]).toBe(1);
    expect(doc.days[0].models["anthropic/claude-sonnet-4"]).toBe(1);
  });

  test("same session_id in two projects counts twice", async () => {
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
    const doc = await buildDailyModelUsage();
    expect(doc.days[0].models["anthropic/claude-sonnet-4"]).toBe(2);
  });

  test("excludes user messages and missing/invalid model metadata", async () => {
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
    expect((await buildDailyModelUsage()).days).toEqual([]);
  });

  test("drops invalid model names, keeps a 320-char model", async () => {
    const good = "anthropic/" + "m".repeat(310); // total length exactly 320
    add({
      sessionId: "s1",
      createdAt: DAY1,
      metadata: assistantMeta("trailing-space "),
    });
    add({
      sessionId: "s2",
      createdAt: DAY1,
      metadata: assistantMeta("ctrl\u0001x"),
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
    const doc = await buildDailyModelUsage();
    expect(doc.days).toEqual([{ day: "2025-03-01", models: { [good]: 1 } }]);
  });

  test("from/to bounds are inclusive UTC days at exact millisecond edges", async () => {
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
    const doc = await buildDailyModelUsage({
      from: "2025-03-01",
      to: "2025-03-01",
    });
    expect(doc.days).toEqual([
      { day: "2025-03-01", models: { "anthropic/claude-sonnet-4": 2 } },
    ]);
    const all = await buildDailyModelUsage({
      from: "2025-03-01",
      to: "2025-03-02",
    });
    expect(all.days[1].models["anthropic/claude-sonnet-4"]).toBe(1);
  });

  test("projectId filter scopes counts to one project", async () => {
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
    const doc = await buildDailyModelUsage({ projectId: pidB });
    expect(doc.days[0].models).toEqual({
      "anthropic/claude-sonnet-4": 1,
    });
  });

  test("rows from another tenant's project are not counted", async () => {
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
    expect((await buildDailyModelUsage()).days).toEqual([]);
    expect(
      (await buildDailyModelUsage({ projectId: foreignPid })).days,
    ).toEqual([]);
  });

  test("rejects unreal and inverted date filters", async () => {
    await expect(buildDailyModelUsage({ from: "2026-02-30" })).rejects.toThrow(
      ModelUsageFilterError,
    );
    await expect(buildDailyModelUsage({ from: "not-a-date" })).rejects.toThrow(
      ModelUsageFilterError,
    );
    await expect(
      buildDailyModelUsage({ from: "2025-03-02", to: "2025-03-01" }),
    ).rejects.toThrow(ModelUsageFilterError);
    // Same day from == to is a valid single-day range.
    expect(
      (await buildDailyModelUsage({ from: "2025-03-01", to: "2025-03-01" }))
        .days,
    ).toEqual([]);
  });

  test("days before MIN_WEEK_TIME are dropped", async () => {
    add({
      sessionId: "s1",
      createdAt: Date.UTC(1990, 0, 1),
      metadata: assistantMeta("claude-sonnet-4"),
    });
    expect((await buildDailyModelUsage()).days).toEqual([]);
  });

  test("throws ModelUsageUnavailableError when the read pool times out", async () => {
    vi.mocked(offloadAllOrTimeout).mockResolvedValueOnce(READ_JOB_TIMED_OUT);
    await expect(buildDailyModelUsage()).rejects.toThrow(
      ModelUsageUnavailableError,
    );
  });

  test(
    "throws ModelUsageLimitError past MAX_DAILY_CELLS with real data",
    { timeout: 60_000 },
    async () => {
      // Seed MAX_DAILY_CELLS + 1 distinct (day, model) cells in one
      // transaction: ~549 days x 365 models, all valid.
      const base = Date.UTC(2024, 0, 1);
      const stmt = db().query(
        `INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
         VALUES (?, ?, ?, 'assistant', 'c', 1, 0, ?, ?)`,
      );
      db().query("BEGIN").run();
      for (let i = 0; i < MAX_DAILY_CELLS + 1; i++) {
        stmt.run(
          `cap-${i}`,
          pid,
          `cap-s${i % 64}`,
          base + Math.floor(i / 365) * 86_400_000 + (i % 365) * 60_000,
          JSON.stringify({ providerID: "p", modelID: `m${i % 365}` }),
        );
      }
      db().query("COMMIT").run();
      await expect(buildDailyModelUsage()).rejects.toThrow(
        ModelUsageLimitError,
      );
    },
  );
});

describe("weekly snapshot", () => {
  const doc = (days: { day: string; models: Record<string, number> }[]) => ({
    format: "model-tides-daily" as const,
    version: 2 as const,
    source: "lore" as const,
    days,
  });

  test("weekStart buckes days into Monday-UTC weeks", () => {
    expect(weekStart(Date.UTC(2025, 2, 3))).toBe("2025-03-03"); // Mon
    expect(weekStart(Date.UTC(2025, 2, 9))).toBe("2025-03-03"); // Sun
    expect(weekStart(Date.UTC(2025, 2, 10))).toBe("2025-03-10"); // next Mon
    expect(() => weekStart(Date.UTC(1990, 0, 1))).toThrow(RangeError);
  });

  test("buildWeeklySnapshot sums daily counts per week and sorts", async () => {
    const snap = buildWeeklySnapshot(
      doc([
        { day: "2025-03-04", models: { "b/m2": 2, "a/m1": 1 } },
        { day: "2025-03-06", models: { "a/m1": 3 } },
        { day: "2025-03-11", models: { "a/m1": 1 } },
      ]),
    );
    expect(snap).toEqual({
      format: "model-tides-weekly",
      version: 2,
      weeks: [
        { week: "2025-03-03", models: { "a/m1": 4, "b/m2": 2 } },
        { week: "2025-03-10", models: { "a/m1": 1 } },
      ],
    });
  });

  test("limit errors name the limit and the actual value", () => {
    const manyWeeks = Array.from({ length: MAX_WEEKS + 1 }, (_, i) => ({
      day: new Date(Date.UTC(2000, 0, 4) + i * 7 * 86_400_000)
        .toISOString()
        .slice(0, 10),
      models: { "a/m": 1 },
    }));
    expect(() => buildWeeklySnapshot(doc(manyWeeks))).toThrow(
      `${MAX_WEEKS + 1} weeks; Model Tides accepts at most ${MAX_WEEKS}`,
    );
    const manyCells = [
      {
        day: "2025-03-04",
        models: Object.fromEntries(
          Array.from({ length: MAX_WEEKLY_CELLS + 1 }, (_, i) => [
            `p/m${i}`,
            1,
          ]),
        ),
      },
    ];
    expect(() => buildWeeklySnapshot(doc(manyCells))).toThrow(
      `${MAX_WEEKLY_CELLS + 1} model-week cells; Model Tides accepts at most ${MAX_WEEKLY_CELLS}`,
    );
  });

  test("snapshotSha256 matches sha256 of the serialized snapshot", () => {
    const snap = buildWeeklySnapshot(
      doc([{ day: "2025-03-04", models: { "a/m1": 1 } }]),
    );
    expect(snapshotSha256(snap)).toBe(
      createHash("sha256").update(JSON.stringify(snap)).digest("hex"),
    );
  });

  test("parseSnapshot/parseOwnedReport reject malformed input", () => {
    expect(() => parseSnapshot({ format: "x" })).toThrow(
      "Invalid weekly snapshot.",
    );
    const report = parseOwnedReport(
      {
        id: "7b2f9a3e-1c4d-7e5f-8a6b-0c1d2e3f4a5b",
        published: true,
        inAggregate: false,
        revision: 3,
        metricVersion: 2,
        counts: [{ week: "2025-03-03", model: "a/m", count: 2 }],
      },
      "7b2f9a3e-1c4d-7e5f-8a6b-0c1d2e3f4a5b",
    );
    expect(report.snapshot?.weeks[0]).toEqual({
      week: "2025-03-03",
      models: { "a/m": 2 },
    });
    expect(() =>
      parseOwnedReport({ id: "nope" }, "7b2f9a3e-1c4d-7e5f-8a6b-0c1d2e3f4a5b"),
    ).toThrow("Invalid personal report.");
  });
});

describe("owner credential", () => {
  const owner = {
    id: "7b2f9a3e-1c4d-7e5f-8a6b-0c1d2e3f4a5b",
    token: "A".repeat(43),
  };

  test("save/load/delete round-trips per tenant in kv_meta", () => {
    withTenant(LOCAL_TENANT_ID, () => {
      deleteOwner();
      expect(loadOwner()).toBeNull();
      saveOwner(owner);
      expect(loadOwner()).toEqual(owner);
      // Another tenant sees nothing.
      withTenant("other-tenant", () => expect(loadOwner()).toBeNull());
      deleteOwner();
      expect(loadOwner()).toBeNull();
    });
  });

  test("createOwner inserts only once — a second create conflicts", () => {
    withTenant(LOCAL_TENANT_ID, () => {
      deleteOwner();
      createOwner(owner);
      expect(loadOwner()).toEqual(owner);
      expect(() => createOwner({ ...owner, token: "B".repeat(43) })).toThrow();
      expect(loadOwner()).toEqual(owner);
      deleteOwner();
    });
  });

  test("rejects malformed credentials", () => {
    expect(() => saveOwner({ id: "bad", token: owner.token })).toThrow(
      "Invalid local private key.",
    );
    expect(() => saveOwner({ id: owner.id, token: "short" })).toThrow(
      "Invalid local private key.",
    );
  });
});
