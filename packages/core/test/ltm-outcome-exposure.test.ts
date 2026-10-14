import { beforeEach, describe, expect, test, vi } from "vitest";
import fc from "fast-check";
import { db, ensureProject } from "../src/db";
import { registerSink, type LogSink } from "../src/log";
import * as ltm from "../src/ltm";
import { recordToolCalls } from "../src/temporal";
import type { LoreMessage, LoreToolState } from "../src/types";

const PROJECT = "/test/outcome-exposure";
const SESSION = "exposure-session";
let callSeq = 0;
const NOOP_SINK: LogSink = {
  info() {},
  warn() {},
  error() {},
  captureException() {},
};

function clearProject(): void {
  const pid = ensureProject(PROJECT);
  db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
  db().query("DELETE FROM tool_calls WHERE project_id = ?").run(pid);
  db()
    .query("DELETE FROM knowledge_session_injections WHERE project_id = ?")
    .run(pid);
}

function createEntry(title: string, at: number): string {
  vi.spyOn(Date, "now").mockReturnValue(at);
  return ltm.create({
    projectPath: PROJECT,
    category: "pattern",
    title,
    content: `content for ${title}`,
    scope: "project",
    confidence: 0.5,
  });
}

function inject(title: string, at: number): string {
  const id = createEntry(title, at);
  ltm.recordSessionInjections(SESSION, PROJECT, [entry(id)]);
  return id;
}

function entry(id: string): {
  id: string;
  logical_id: string;
  confidence: number;
  cross_project: number;
  category: string;
} {
  return db()
    .query(
      `SELECT id, logical_id, confidence, cross_project, category FROM knowledge_current
       WHERE logical_id = (SELECT logical_id FROM knowledge WHERE id = ?)`,
    )
    .get(id) as {
    id: string;
    logical_id: string;
    confidence: number;
    cross_project: number;
    category: string;
  };
}

function recordedVersion(id: string): string | null | undefined {
  const receipt = db()
    .query(
      `SELECT * FROM knowledge_session_injections
       WHERE session_id = ? AND logical_id = ?`,
    )
    .get(SESSION, entry(id).logical_id) as { version_id?: string | null };
  return receipt?.version_id;
}

function injection(id: string): {
  created_at: number;
  credited: number;
  verdict: "pass" | "fail" | null;
} {
  return db()
    .query(
      `SELECT created_at, credited, verdict FROM knowledge_session_injections
       WHERE session_id = ? AND logical_id = ?`,
    )
    .get(SESSION, entry(id).logical_id) as {
    created_at: number;
    credited: number;
    verdict: "pass" | "fail" | null;
  };
}

function recordCheck(
  at: number,
  status: "pending" | "completed" | "error",
  options: { callID?: string; sessionID?: string; projectPath?: string } = {},
): string {
  vi.spyOn(Date, "now").mockReturnValue(at);
  const callID = options.callID ?? `call-${++callSeq}`;
  const sessionID = options.sessionID ?? SESSION;
  const projectPath = options.projectPath ?? PROJECT;
  const info: LoreMessage = {
    id: `message-${callID}`,
    sessionID,
    role: "assistant",
    time: { created: at },
    parentID: "parent",
    modelID: "test-model",
    providerID: "test-provider",
    mode: "build",
    path: { cwd: projectPath, root: projectPath },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  const input = { command: "pnpm test" };
  const state: LoreToolState =
    status === "pending"
      ? { status, input }
      : status === "completed"
        ? { status, input, output: "passed", time: { start: at, end: at + 10 } }
        : {
            status,
            input,
            error: "Command failed with exit code 1",
            time: { start: at, end: at + 10 },
          };
  recordToolCalls({
    projectPath,
    info,
    parts: [
      {
        id: `part-${callID}`,
        sessionID,
        messageID: info.id,
        type: "tool",
        tool: "bash",
        callID,
        state,
      },
    ],
  });
  return callID;
}

describe("outcome feedback follows each memory's exposure window", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    clearProject();
  });

  test.each(["completed", "error"] as const)(
    "%s checks before injection neither adjust nor consume feedback",
    (status) => {
      recordCheck(1000, status);
      const id = inject("late memory", 2000);

      expect(ltm.creditSessionOutcome(SESSION, PROJECT)).toEqual({
        verdict: "none",
        credited: 0,
      });
      expect(entry(id).confidence).toBe(0.5);
      expect(injection(id)).toEqual({
        created_at: 2000,
        credited: 0,
        verdict: null,
      });
      expect(ltm.outcomeImpact(entry(id).logical_id)).toEqual({
        passes: 0,
        fails: 0,
      });
    },
  );

  test("a pre-exposure check stays excluded when its result arrives later", () => {
    const callID = recordCheck(1000, "pending");
    const id = inject("diagnostic memory", 2000);
    recordToolCalls({
      projectPath: PROJECT,
      info: {
        id: "result-message",
        sessionID: SESSION,
        role: "user",
        time: { created: 3000 },
      },
      parts: [
        {
          id: "result-part",
          sessionID: SESSION,
          messageID: "result-message",
          type: "tool",
          tool: "result",
          callID,
          state: {
            status: "error",
            input: null,
            error: "Command failed with exit code 1",
            time: { start: 1000, end: 3000 },
          },
        },
      ],
    });
    expect(
      db()
        .query("SELECT created_at, status FROM tool_calls WHERE call_id = ?")
        .get(callID),
    ).toEqual({ created_at: 1000, status: "error" });

    expect(ltm.creditSessionOutcome(SESSION, PROJECT).credited).toBe(0);
    expect(entry(id).confidence).toBe(0.5);
    expect(injection(id).credited).toBe(0);
  });

  test("one idle pass assigns different verdicts to different exposure windows", () => {
    const early = inject("early memory", 1000);
    recordCheck(2000, "error");
    const late = inject("repair memory", 3000);
    recordCheck(4000, "completed");

    expect(ltm.creditSessionOutcome(SESSION, PROJECT)).toEqual({
      verdict: "fail",
      credited: 2,
    });
    expect(entry(early).confidence).toBeCloseTo(0.5 - ltm.OUTCOME_PENALTY);
    expect(entry(late).confidence).toBeCloseTo(0.5 + ltm.OUTCOME_REWARD);
    expect(injection(early).verdict).toBe("fail");
    expect(injection(late).verdict).toBe("pass");
    expect(ltm.outcomeImpact(entry(late).logical_id)).toEqual({
      passes: 1,
      fails: 0,
    });
  });

  test("neutral windows survive idle and are credited exactly once by a later check", () => {
    const early = inject("early memory", 1000);
    recordCheck(2000, "error");
    const late = inject("later memory", 3000);

    expect(ltm.creditSessionOutcome(SESSION, PROJECT)).toEqual({
      verdict: "fail",
      credited: 1,
    });
    expect(injection(late).credited).toBe(0);
    const check = recordCheck(4000, "completed");
    recordCheck(5000, "pending", { callID: check }); // history replay
    expect(ltm.creditSessionOutcome(SESSION, PROJECT)).toEqual({
      verdict: "pass",
      credited: 1,
    });
    expect(entry(early).confidence).toBeCloseTo(0.5 - ltm.OUTCOME_PENALTY);
    expect(entry(late).confidence).toBeCloseTo(0.5 + ltm.OUTCOME_REWARD);
    expect(ltm.creditSessionOutcome(SESSION, PROJECT).credited).toBe(0);
    expect(entry(late).confidence).toBeCloseTo(0.5 + ltm.OUTCOME_REWARD);
  });

  test("re-injection retains the first exposure time", () => {
    const id = inject("repeated memory", 1000);
    recordCheck(2000, "error");
    vi.spyOn(Date, "now").mockReturnValue(3000);
    ltm.recordSessionInjections(SESSION, PROJECT, [entry(id)]);

    expect(injection(id).created_at).toBe(1000);
    expect(ltm.creditSessionOutcome(SESSION, PROJECT).credited).toBe(1);
    expect(entry(id).confidence).toBeCloseTo(0.5 - ltm.OUTCOME_PENALTY);
  });

  test("checks in the same millisecond as injection are eligible", () => {
    const id = inject("same tick", 2000);
    recordCheck(2000, "completed");
    expect(ltm.creditSessionOutcome(SESSION, PROJECT).credited).toBe(1);
    expect(entry(id).confidence).toBeCloseTo(0.5 + ltm.OUTCOME_REWARD);
  });

  test.each([
    { sessionID: "other-session" },
    { projectPath: "/test/outcome-exposure-other" },
  ])("another project or session cannot provide feedback: %j", (options) => {
    const id = inject("isolated memory", 2000);
    recordCheck(3000, "error", options);
    expect(ltm.creditSessionOutcome(SESSION, PROJECT).credited).toBe(0);
    expect(entry(id).confidence).toBe(0.5);
  });

  test("large injection sets are credited without exceeding bind limits", () => {
    const ids = Array.from({ length: 1005 }, (_, i) =>
      inject(`batch memory ${i}`, 2000),
    );
    recordCheck(3000, "completed");
    const statements: string[] = [];
    registerSink({
      ...NOOP_SINK,
      withDbSpan(sql, fn) {
        statements.push(sql);
        return fn();
      },
    });
    try {
      expect(ltm.creditSessionOutcome(SESSION, PROJECT)).toEqual({
        verdict: "pass",
        credited: ids.length,
      });
    } finally {
      registerSink(NOOP_SINK);
    }
    expect(
      statements.filter((sql) => /FROM tool_calls/.test(sql)),
    ).toHaveLength(1);
    expect(
      Math.max(...statements.map((sql) => sql.match(/\?/g)?.length ?? 0)),
    ).toBeLessThanOrEqual(999);
    expect(injection(ids[0]).credited).toBe(1);
    expect(injection(ids.at(-1)!).credited).toBe(1);
    expect(entry(ids[0]).confidence).toBeCloseTo(0.5 + ltm.OUTCOME_REWARD);
    expect(entry(ids.at(-1)!).confidence).toBeCloseTo(0.5 + ltm.OUTCOME_REWARD);
    expect(ltm.creditSessionOutcome(SESSION, PROJECT).credited).toBe(0);
  });

  test("generated exposure, resolution, replay, and idle sequences preserve credit", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            action: fc.constantFrom(
              "inject",
              "pass",
              "fail",
              "pending",
              "resolve-pass",
              "resolve-fail",
              "replay",
              "idle",
            ),
            memory: fc.integer({ min: 0, max: 2 }),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        (actions) => {
          clearProject();
          const memories = new Map<
            number,
            { id: string; exposedAt: number; verdict: "pass" | "fail" | null }
          >();
          const checks: {
            callID: string;
            startedAt: number;
            status: "pending" | "completed" | "error";
          }[] = [];
          function idle(): void {
            let credited = 0;
            let verdict: "none" | "pass" | "fail" = "none";
            for (const memory of memories.values()) {
              if (memory.verdict) continue;
              const relevant = checks.filter(
                (check) => check.startedAt >= memory.exposedAt,
              );
              const outcome = relevant.some((check) => check.status === "error")
                ? "fail"
                : relevant.some((check) => check.status === "completed")
                  ? "pass"
                  : null;
              if (!outcome) continue;
              memory.verdict = outcome;
              credited++;
              if (outcome === "fail" || verdict === "none") verdict = outcome;
            }
            expect(ltm.creditSessionOutcome(SESSION, PROJECT)).toEqual({
              verdict,
              credited,
            });
            for (const memory of memories.values()) {
              const delta =
                memory.verdict === "fail"
                  ? -ltm.OUTCOME_PENALTY
                  : memory.verdict === "pass"
                    ? ltm.OUTCOME_REWARD
                    : 0;
              expect(entry(memory.id).confidence).toBeCloseTo(0.5 + delta);
              expect(injection(memory.id)).toEqual({
                created_at: memory.exposedAt,
                credited: memory.verdict ? 1 : 0,
                verdict: memory.verdict,
              });
            }
          }
          for (const [i, action] of actions.entries()) {
            const at = 1000 + i * 10;
            vi.spyOn(Date, "now").mockReturnValue(at);
            if (action.action === "inject") {
              const existing = memories.get(action.memory);
              if (existing) {
                ltm.recordSessionInjections(SESSION, PROJECT, [
                  entry(existing.id),
                ]);
              } else {
                memories.set(action.memory, {
                  id: inject(`generated memory ${action.memory}`, at),
                  exposedAt: at,
                  verdict: null,
                });
              }
            } else if (action.action === "idle") {
              idle();
            } else if (action.action === "replay") {
              const check = checks.at(-1);
              if (check) recordCheck(at, "pending", { callID: check.callID });
            } else if (action.action.startsWith("resolve-")) {
              const check = checks.find((check) => check.status === "pending");
              if (check) {
                check.status =
                  action.action === "resolve-pass" ? "completed" : "error";
                recordCheck(at, check.status, { callID: check.callID });
              }
            } else {
              const status =
                action.action === "pass"
                  ? "completed"
                  : action.action === "fail"
                    ? "error"
                    : "pending";
              checks.push({
                callID: recordCheck(at, status),
                startedAt: at,
                status,
              });
            }
          }
          idle();
          idle();
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("outcome feedback follows the injected memory version", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    clearProject();
  });

  test("records the selected version ID", () => {
    const id = inject("versioned memory", 1000);
    expect(recordedVersion(id)).toBe(entry(id).id);
  });

  test("the real selector and deferred effects expose the current version ID", async () => {
    const id = createEntry("selected current revision", 1000);
    vi.spyOn(Date, "now").mockReturnValue(2000);
    ltm.update(id, { content: "current revision selected for the agent" });
    const current = entry(id);
    const selected = await ltm.forSession(PROJECT, SESSION, 10_000, {
      deferEffects: true,
    });
    expect(
      selected.find((memory) => memory.logical_id === current.logical_id)?.id,
    ).toBe(current.id);
    ltm.recordForSessionEffects(PROJECT, SESSION, selected);
    expect(recordedVersion(id)).toBe(current.id);
    recordCheck(3000, "completed");
    expect(ltm.creditSessionOutcome(SESSION, PROJECT).credited).toBe(1);
    expect(entry(id).confidence).toBeCloseTo(0.5 + ltm.OUTCOME_REWARD);
  });

  test.each(["completed", "error"] as const)(
    "an unseen replacement receives no feedback from a %s check",
    (status) => {
      const id = inject("original memory", 1000);
      const original = entry(id);
      vi.spyOn(Date, "now").mockReturnValue(2000);
      ltm.update(id, { content: "corrected memory", confidence: 0.6 });
      expect(entry(id).id).not.toBe(original.id);
      recordCheck(3000, status);

      expect(ltm.creditSessionOutcome(SESSION, PROJECT)).toEqual({
        verdict: "none",
        credited: 0,
      });
      expect(entry(id).confidence).toBeCloseTo(0.6);
      expect(injection(id).credited).toBe(0);
      expect(ltm.outcomeImpact(original.logical_id)).toEqual({
        passes: 0,
        fails: 0,
      });
    },
  );

  test("a selection superseded before recording keeps its actual version", () => {
    const id = createEntry("selected memory", 1000);
    const selected = ltm.getByLogical(entry(id).logical_id);
    if (!selected) throw new Error("expected selected knowledge snapshot");
    vi.spyOn(Date, "now").mockReturnValue(2000);
    ltm.update(id, { content: "replacement not shown to this request" });
    vi.spyOn(Date, "now").mockReturnValue(3000);
    ltm.recordForSessionEffects(PROJECT, SESSION, [selected]);
    recordCheck(4000, "error");
    expect(ltm.creditSessionOutcome(SESSION, PROJECT).credited).toBe(0);
    expect(entry(id).confidence).toBe(0.5);
    expect(recordedVersion(id)).toBe(selected.id);
  });

  test("same-millisecond revisions are distinguished by version identity", () => {
    const id = inject("same-tick revision", 1000);
    const original = entry(id);
    ltm.update(id, { content: "new content in the same tick" });
    expect(entry(id).id).not.toBe(original.id);
    recordCheck(1000, "completed");
    expect(ltm.creditSessionOutcome(SESSION, PROJECT).credited).toBe(0);
    expect(entry(id).confidence).toBe(0.5);
    expect(recordedVersion(id)).toBe(original.id);
  });

  test("exposing a replacement starts its own uncredited window", () => {
    const id = inject("repairable memory", 1000);
    recordCheck(2000, "error");
    vi.spyOn(Date, "now").mockReturnValue(3000);
    ltm.update(id, { content: "repaired memory" });
    const replacement = entry(id);
    vi.spyOn(Date, "now").mockReturnValue(4000);
    ltm.recordSessionInjections(SESSION, PROJECT, [replacement]);
    recordCheck(5000, "completed");
    vi.spyOn(Date, "now").mockReturnValue(6000);
    ltm.recordSessionInjections(SESSION, PROJECT, [replacement]);

    expect(injection(id).created_at).toBe(4000);
    expect(ltm.creditSessionOutcome(SESSION, PROJECT)).toEqual({
      verdict: "pass",
      credited: 1,
    });
    expect(entry(id).confidence).toBeCloseTo(0.5 + ltm.OUTCOME_REWARD);
    expect(recordedVersion(id)).toBe(replacement.id);
    expect(ltm.creditSessionOutcome(SESSION, PROJECT).credited).toBe(0);
  });

  test("a stale version replay cannot overwrite a newer exposure", () => {
    const id = inject("replayed memory", 1000);
    const original = entry(id);
    vi.spyOn(Date, "now").mockReturnValue(2000);
    ltm.update(id, { content: "new version" });
    const replacement = entry(id);
    vi.spyOn(Date, "now").mockReturnValue(3000);
    ltm.recordSessionInjections(SESSION, PROJECT, [replacement]);
    recordCheck(4000, "completed");
    vi.spyOn(Date, "now").mockReturnValue(5000);
    ltm.recordSessionInjections(SESSION, PROJECT, [original]);

    expect(injection(id).created_at).toBe(3000);
    expect(ltm.creditSessionOutcome(SESSION, PROJECT).credited).toBe(1);
    expect(entry(id).confidence).toBeCloseTo(0.5 + ltm.OUTCOME_REWARD);
    expect(recordedVersion(id)).toBe(replacement.id);
  });

  test("credited old versions retain receipts without leaking impact or credit to replacements", () => {
    const id = inject("credited memory", 1000);
    const original = entry(id);
    recordCheck(2000, "completed");
    expect(ltm.creditSessionOutcome(SESSION, PROJECT).credited).toBe(1);
    expect(ltm.outcomeImpact(original.logical_id).passes).toBe(1);
    vi.spyOn(Date, "now").mockReturnValue(3000);
    ltm.update(id, { content: "replacement", confidence: 0.5 });
    const replacement = entry(id);
    vi.spyOn(Date, "now").mockReturnValue(4000);
    ltm.recordSessionInjections(SESSION, PROJECT, [replacement]);
    recordCheck(5000, "error");

    expect(injection(id)).toEqual({
      created_at: 1000,
      credited: 1,
      verdict: "pass",
    });
    expect(ltm.creditSessionOutcome(SESSION, PROJECT).credited).toBe(0);
    expect(entry(id).confidence).toBe(0.5);
    expect(ltm.outcomeImpact(original.logical_id)).toEqual({
      passes: 0,
      fails: 0,
    });
    expect(recordedVersion(id)).toBe(original.id);

    vi.spyOn(Date, "now").mockReturnValue(6000);
    ltm.recordSessionInjections("replacement-session", PROJECT, [replacement]);
    recordCheck(7000, "completed", { sessionID: "replacement-session" });
    expect(
      ltm.creditSessionOutcome("replacement-session", PROJECT).credited,
    ).toBe(1);
    expect(entry(id).confidence).toBeCloseTo(0.5 + ltm.OUTCOME_REWARD);
    expect(ltm.outcomeImpact(original.logical_id)).toEqual({
      passes: 1,
      fails: 0,
    });
  });

  test("confidence-only updates preserve version eligibility", () => {
    const id = inject("reconfirmed memory", 1000);
    const original = entry(id);
    vi.spyOn(Date, "now").mockReturnValue(2000);
    ltm.update(id, { confidence: 0.6 });
    expect(entry(id).id).toBe(original.id);
    recordCheck(3000, "completed");
    expect(ltm.creditSessionOutcome(SESSION, PROJECT).credited).toBe(1);
    expect(entry(id).confidence).toBeCloseTo(0.6 + ltm.OUTCOME_REWARD);
  });

  test("a revision changed between preflight and the credit lock stays neutral", () => {
    const id = inject("concurrent correction", 1000);
    recordCheck(2000, "completed");
    let corrected = false;
    registerSink({
      ...NOOP_SINK,
      withDbSpan(sql, fn) {
        const result = fn();
        if (
          !corrected &&
          sql.includes("SELECT") &&
          sql.includes("FROM knowledge_session_injections")
        ) {
          corrected = true;
          ltm.update(id, {
            content: "correction between reads",
            confidence: 0.6,
          });
        }
        return result;
      },
    });
    try {
      expect(ltm.creditSessionOutcome(SESSION, PROJECT)).toEqual({
        verdict: "none",
        credited: 0,
      });
    } finally {
      registerSink(NOOP_SINK);
    }
    expect(corrected).toBe(true);
    expect(entry(id).confidence).toBeCloseTo(0.6);
    expect(injection(id).credited).toBe(0);
  });

  test("missing IDs, mismatched identities, and foreign-project snapshots cannot create receipts", () => {
    const a = createEntry("memory A", 1000);
    const b = createEntry("memory B", 1000);
    const snapshot = entry(a);
    const other = ltm.create({
      projectPath: "/test/outcome-version-other",
      scope: "project",
      category: "pattern",
      title: "foreign memory",
      content: "other project content",
      confidence: 0.5,
    });
    ltm.recordSessionInjections(SESSION, PROJECT, [
      { logical_id: snapshot.logical_id },
      { ...snapshot, logical_id: entry(b).logical_id },
      entry(other),
    ]);
    expect(
      db()
        .query(
          "SELECT COUNT(*) AS n FROM knowledge_session_injections WHERE session_id = ?",
        )
        .get(SESSION),
    ).toEqual({ n: 0 });
    recordCheck(2000, "completed");
    expect(ltm.creditSessionOutcome(SESSION, PROJECT).credited).toBe(0);
    expect(entry(a).confidence).toBe(0.5);
    expect(entry(b).confidence).toBe(0.5);
    expect(entry(other).confidence).toBe(0.5);
  });

  test("credited legacy receipts retain history without guessing current-version impact", () => {
    const id = createEntry("legacy credited memory", 1000);
    const selected = entry(id);
    db()
      .query(`INSERT INTO knowledge_session_injections
      (session_id, logical_id, project_id, created_at, credited, verdict)
      VALUES (?, ?, ?, 1000, 1, 'fail')`)
      .run(SESSION, selected.logical_id, ensureProject(PROJECT));
    vi.spyOn(Date, "now").mockReturnValue(2000);
    ltm.recordSessionInjections(SESSION, PROJECT, [selected]);
    expect(ltm.outcomeImpact(selected.logical_id)).toEqual({
      passes: 0,
      fails: 0,
    });
    expect(recordedVersion(id)).toBeNull();
    expect(injection(id)).toEqual({
      created_at: 1000,
      credited: 1,
      verdict: "fail",
    });
    recordCheck(3000, "completed");
    expect(ltm.creditSessionOutcome(SESSION, PROJECT).credited).toBe(0);
    expect(entry(id).confidence).toBe(0.5);
  });

  test("unknown legacy provenance is neutral until a new explicit exposure", () => {
    const id = createEntry("legacy receipt memory", 1000);
    const selected = entry(id);
    db()
      .query(`INSERT INTO knowledge_session_injections
      (session_id, logical_id, project_id, created_at, credited)
      VALUES (?, ?, ?, 1000, 0)`)
      .run(SESSION, selected.logical_id, ensureProject(PROJECT));
    recordCheck(2000, "error");
    expect(ltm.creditSessionOutcome(SESSION, PROJECT).credited).toBe(0);
    expect(entry(id).confidence).toBe(0.5);
    vi.spyOn(Date, "now").mockReturnValue(3000);
    ltm.recordSessionInjections(SESSION, PROJECT, [selected]);
    expect(injection(id).created_at).toBe(3000);
    expect(recordedVersion(id)).toBe(selected.id);
    recordCheck(4000, "completed");
    expect(ltm.creditSessionOutcome(SESSION, PROJECT).verdict).toBe("pass");
    expect(entry(id).confidence).toBeCloseTo(0.5 + ltm.OUTCOME_REWARD);
  });

  test("generated revision, re-exposure, stale replay, and idle combinations preserve attribution", () => {
    fc.assert(
      fc.property(
        fc.record({
          before: fc.constantFrom("pending", "completed", "error"),
          after: fc.constantFrom("pending", "completed", "error"),
          firstIdle: fc.boolean(),
          contentEdit: fc.boolean(),
          exposeNew: fc.boolean(),
          replayOld: fc.boolean(),
        }),
        (scenario) => {
          clearProject();
          const id = inject("generated revision", 1000);
          const original = entry(id);
          recordCheck(2000, scenario.before);
          const initiallyCredited =
            scenario.firstIdle && scenario.before !== "pending";
          if (scenario.firstIdle) ltm.creditSessionOutcome(SESSION, PROJECT);
          vi.spyOn(Date, "now").mockReturnValue(3000);
          ltm.update(id, {
            ...(scenario.contentEdit
              ? { content: "replacement revision" }
              : {}),
            confidence: 0.5,
          });
          const current = entry(id);
          vi.spyOn(Date, "now").mockReturnValue(4000);
          if (scenario.exposeNew)
            ltm.recordSessionInjections(SESSION, PROJECT, [current]);
          vi.spyOn(Date, "now").mockReturnValue(5000);
          if (scenario.replayOld)
            ltm.recordSessionInjections(SESSION, PROJECT, [original]);
          recordCheck(6000, scenario.after);

          const replaced =
            !initiallyCredited && scenario.contentEdit && scenario.exposeNew;
          const exposedVersion = replaced ? current.id : original.id;
          const exposedAt = replaced ? 4000 : 1000;
          const outcomes = [
            { at: 2000, status: scenario.before },
            { at: 6000, status: scenario.after },
          ].filter((check) => check.at >= exposedAt);
          const outcome =
            initiallyCredited || exposedVersion !== current.id
              ? "none"
              : outcomes.some((check) => check.status === "error")
                ? "fail"
                : outcomes.some((check) => check.status === "completed")
                  ? "pass"
                  : "none";
          expect(ltm.creditSessionOutcome(SESSION, PROJECT)).toEqual({
            verdict: outcome,
            credited: outcome === "none" ? 0 : 1,
          });
          const delta =
            outcome === "fail"
              ? -ltm.OUTCOME_PENALTY
              : outcome === "pass"
                ? ltm.OUTCOME_REWARD
                : 0;
          expect(entry(id).confidence).toBeCloseTo(0.5 + delta);
          expect(recordedVersion(id)).toBe(exposedVersion);
          expect(injection(id).created_at).toBe(exposedAt);
          expect(injection(id).credited).toBe(
            initiallyCredited || outcome !== "none" ? 1 : 0,
          );
          const counted =
            exposedVersion === current.id ? injection(id).verdict : null;
          expect(ltm.outcomeImpact(original.logical_id)).toEqual({
            passes: counted === "pass" ? 1 : 0,
            fails: counted === "fail" ? 1 : 0,
          });
          expect(ltm.creditSessionOutcome(SESSION, PROJECT).credited).toBe(0);
          expect(entry(id).confidence).toBeCloseTo(0.5 + delta);
        },
      ),
      { numRuns: 100 },
    );
  });
});
