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

function inject(title: string, at: number): string {
  vi.spyOn(Date, "now").mockReturnValue(at);
  const id = ltm.create({
    projectPath: PROJECT,
    category: "pattern",
    title,
    content: `content for ${title}`,
    scope: "project",
    confidence: 0.5,
  });
  const { logical_id } = entry(id);
  ltm.recordSessionInjections(SESSION, PROJECT, [
    { logical_id, cross_project: 0, category: "pattern" },
  ]);
  return id;
}

function entry(id: string): { logical_id: string; confidence: number } {
  return db()
    .query("SELECT logical_id, confidence FROM knowledge_current WHERE id = ?")
    .get(id) as { logical_id: string; confidence: number };
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
    ltm.recordSessionInjections(SESSION, PROJECT, [
      {
        logical_id: entry(id).logical_id,
        cross_project: 0,
        category: "pattern",
      },
    ]);

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
                  { logical_id: entry(existing.id).logical_id },
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
