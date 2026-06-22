import { beforeEach, describe, expect, test } from "vitest";
import { db, ensureProject } from "../src/db";
import * as ltm from "../src/ltm";
import {
  extractCommand,
  isVerifierCall,
  sessionVerifierVerdict,
} from "../src/tool-trace";

const PROJECT = "/test/outcome-reward";

let callSeq = 0;
function insertToolCall(
  pid: string,
  opts: {
    session: string;
    tool?: string;
    status: "completed" | "error" | "pending";
    verifier?: 0 | 1 | null;
  },
): void {
  callSeq++;
  db()
    .query(
      `INSERT INTO tool_calls
         (call_id, message_id, project_id, session_id, tool, status, error_type, error_message, duration_ms, created_at, verifier)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `call-${callSeq}`,
      `msg-${callSeq}`,
      pid,
      opts.session,
      opts.tool ?? "bash",
      opts.status,
      opts.status === "error" ? "command_failed" : null,
      null,
      0,
      1000 + callSeq,
      opts.verifier ?? null,
    );
}

function getEntry(id: string): {
  logical_id: string;
  confidence: number;
  cross_project: number;
  category: string;
  project_id: string | null;
} {
  return db()
    .query(
      "SELECT logical_id, confidence, cross_project, category, project_id FROM knowledge WHERE id = ?",
    )
    .get(id) as {
    logical_id: string;
    confidence: number;
    cross_project: number;
    category: string;
    project_id: string | null;
  };
}

function makeProjectEntry(title: string, confidence: number): string {
  return ltm.create({
    projectPath: PROJECT,
    category: "pattern",
    title,
    content: `content for ${title}`,
    scope: "project",
    confidence,
  });
}

describe("outcome-reward: verifier detection (tool-trace)", () => {
  test("extractCommand handles bash shapes and bare strings", () => {
    expect(extractCommand({ command: "pnpm test" })).toBe("pnpm test");
    expect(extractCommand({ cmd: "tsc" })).toBe("tsc");
    expect(extractCommand("vitest run")).toBe("vitest run");
    expect(extractCommand({})).toBeNull();
    expect(extractCommand(null)).toBeNull();
    expect(extractCommand(42)).toBeNull();
  });

  test("isVerifierCall recognizes test/build/typecheck/lint runners", () => {
    for (const cmd of [
      "pnpm test",
      "pnpm run test",
      "npm test",
      "yarn build",
      "bun run typecheck",
      "tsc --noEmit",
      "vitest run packages/core",
      "go test ./...",
      "cargo test",
      "eslint . --fix",
      "biome check src",
      "pytest -q",
      "ruff check",
    ]) {
      expect(isVerifierCall({ command: cmd })).toBe(true);
    }
  });

  test("isVerifierCall ignores incidental commands (no false positives)", () => {
    for (const cmd of [
      "grep -r foo .",
      "ls -la",
      "cat package.json",
      "git status",
      "cd packages/core",
      "echo testing", // 'test' only as a substring of a word → not matched
      "mkdir build-output",
      // Merely MENTIONING a runner (not invoking it) must not count — the token
      // is not at command position. These are the high-frequency false-positives.
      "cat vitest.config.ts",
      "vim biome.json",
      "ls eslint.config.js",
      "grep ruff pyproject.toml",
      "echo 'run mypy soon'",
      "git checkout -- pytest.ini",
    ]) {
      expect(isVerifierCall({ command: cmd })).toBe(false);
    }
    // Non-extractable input is never a verifier.
    expect(isVerifierCall({ filePath: "x" })).toBe(false);
    expect(isVerifierCall(undefined)).toBe(false);
  });

  test("isVerifierCall matches a runner that leads any command segment or benign prefix", () => {
    for (const cmd of [
      "cd packages/core && pnpm test", // runner leads the 2nd segment
      "rm -rf dist; pnpm build", // after a semicolon
      "npx vitest run", // benign npx prefix
      "sudo cargo test", // sudo prefix
      "CI=1 pnpm test", // leading env assignment
      "env FOO=bar tsc --noEmit", // env prefix
    ]) {
      expect(isVerifierCall({ command: cmd })).toBe(true);
    }
  });
});

describe("outcome-reward: sessionVerifierVerdict", () => {
  let pid: string;
  beforeEach(() => {
    pid = ensureProject(PROJECT);
    db().query("DELETE FROM tool_calls WHERE project_id = ?").run(pid);
  });

  test("no verifier calls → none (incidental failures ignored)", () => {
    // A non-verifier command that failed must NOT register as a verifier fail.
    insertToolCall(pid, { session: "s1", status: "error", verifier: 0 });
    insertToolCall(pid, { session: "s1", status: "completed", verifier: null });
    expect(sessionVerifierVerdict(PROJECT, "s1")).toBe("none");
  });

  test("verifier completed → pass", () => {
    insertToolCall(pid, { session: "s2", status: "completed", verifier: 1 });
    expect(sessionVerifierVerdict(PROJECT, "s2")).toBe("pass");
  });

  test("verifier errored → fail", () => {
    insertToolCall(pid, { session: "s3", status: "error", verifier: 1 });
    expect(sessionVerifierVerdict(PROJECT, "s3")).toBe("fail");
  });

  test("any verifier failure makes the session fail (fail dominates a later pass)", () => {
    insertToolCall(pid, { session: "s4", status: "error", verifier: 1 });
    insertToolCall(pid, { session: "s4", status: "completed", verifier: 1 });
    expect(sessionVerifierVerdict(PROJECT, "s4")).toBe("fail");
  });
});

describe("outcome-reward: recordSessionInjections", () => {
  let pid: string;
  beforeEach(() => {
    pid = ensureProject(PROJECT);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
    db()
      .query("DELETE FROM knowledge_session_injections WHERE project_id = ?")
      .run(pid);
  });

  test("records project entries; skips cross_project and lat.md synthetics", () => {
    const e = makeProjectEntry("inj-1", 0.5);
    const entry = getEntry(e);
    ltm.recordSessionInjections("sess-rec", PROJECT, [
      { logical_id: entry.logical_id, cross_project: 0, category: "pattern" },
      { logical_id: "shared-x", cross_project: 1, category: "pattern" },
      { logical_id: "lat-x", cross_project: 0, category: "lat.md" },
      { logical_id: undefined, cross_project: 0, category: "pattern" },
    ]);
    const rows = db()
      .query(
        "SELECT logical_id FROM knowledge_session_injections WHERE session_id = ?",
      )
      .all("sess-rec") as { logical_id: string }[];
    expect(rows.map((r) => r.logical_id)).toEqual([entry.logical_id]);
  });

  test("is idempotent and never resets the credited flag on re-injection", () => {
    const e = makeProjectEntry("inj-2", 0.5);
    const lid = getEntry(e).logical_id;
    const inj = [{ logical_id: lid, cross_project: 0, category: "pattern" }];
    ltm.recordSessionInjections("sess-idem", PROJECT, inj);
    // Simulate a credit having happened.
    db()
      .query(
        "UPDATE knowledge_session_injections SET credited = 1 WHERE session_id = ?",
      )
      .run("sess-idem");
    // Re-inject the same entry on a later turn.
    ltm.recordSessionInjections("sess-idem", PROJECT, inj);
    const row = db()
      .query(
        "SELECT COUNT(*) AS n, MAX(credited) AS credited FROM knowledge_session_injections WHERE session_id = ?",
      )
      .get("sess-idem") as { n: number; credited: number };
    expect(row.n).toBe(1); // no duplicate
    expect(row.credited).toBe(1); // not reset to 0
  });

  test("no-op when sessionID is undefined", () => {
    ltm.recordSessionInjections(undefined, PROJECT, [
      { logical_id: "x", cross_project: 0, category: "pattern" },
    ]);
    const n = db()
      .query(
        "SELECT COUNT(*) AS n FROM knowledge_session_injections WHERE logical_id = 'x'",
      )
      .get() as { n: number };
    expect(n.n).toBe(0);
  });
});

describe("outcome-reward: creditSessionOutcome", () => {
  let pid: string;
  beforeEach(() => {
    pid = ensureProject(PROJECT);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
    db().query("DELETE FROM tool_calls WHERE project_id = ?").run(pid);
    db()
      .query("DELETE FROM knowledge_session_injections WHERE project_id = ?")
      .run(pid);
  });

  function inject(session: string, id: string): void {
    const entry = getEntry(id);
    ltm.recordSessionInjections(session, PROJECT, [
      {
        logical_id: entry.logical_id,
        cross_project: entry.cross_project,
        category: entry.category,
      },
    ]);
  }

  test("PASS verdict boosts injected entries by OUTCOME_REWARD (capped at ceiling)", () => {
    const e = makeProjectEntry("c-pass", 0.5);
    inject("sp", e);
    insertToolCall(pid, { session: "sp", status: "completed", verifier: 1 });
    const res = ltm.creditSessionOutcome("sp", PROJECT);
    expect(res.verdict).toBe("pass");
    expect(res.credited).toBe(1);
    expect(getEntry(e).confidence).toBeCloseTo(0.5 + ltm.OUTCOME_REWARD, 6);
  });

  test("PASS does not boost an entry already at the ceiling", () => {
    const e = makeProjectEntry("c-ceil", ltm.OUTCOME_BOOST_CEILING);
    inject("sc", e);
    insertToolCall(pid, { session: "sc", status: "completed", verifier: 1 });
    ltm.creditSessionOutcome("sc", PROJECT);
    expect(getEntry(e).confidence).toBeCloseTo(ltm.OUTCOME_BOOST_CEILING, 6);
  });

  test("PASS NEVER demotes a high-confidence entry above the ceiling (anti-deflation)", () => {
    // The `confidence < ceiling` guard's critical second job: an entry already
    // ABOVE the ceiling (e.g. a curator-minted 0.95) injected into a passing
    // session must be left UNTOUCHED — not flattened to the ceiling by MIN().
    // Without the guard this would silently collapse the whole 0.8–1.0 band to
    // 0.8 on every passing session (top entries are injected nearly always).
    const e = makeProjectEntry("c-above", 0.95);
    inject("sa", e);
    insertToolCall(pid, { session: "sa", status: "completed", verifier: 1 });
    ltm.creditSessionOutcome("sa", PROJECT);
    expect(getEntry(e).confidence).toBe(0.95);
  });

  test("PASS boost is clamped to the ceiling (near-ceiling entry)", () => {
    const e = makeProjectEntry("c-near", ltm.OUTCOME_BOOST_CEILING - 0.005);
    inject("sn", e);
    insertToolCall(pid, { session: "sn", status: "completed", verifier: 1 });
    ltm.creditSessionOutcome("sn", PROJECT);
    expect(getEntry(e).confidence).toBeCloseTo(ltm.OUTCOME_BOOST_CEILING, 6);
  });

  test("FAIL verdict penalizes injected entries by OUTCOME_PENALTY (floored at 0)", () => {
    const e = makeProjectEntry("c-fail", 0.5);
    inject("sf", e);
    insertToolCall(pid, { session: "sf", status: "error", verifier: 1 });
    const res = ltm.creditSessionOutcome("sf", PROJECT);
    expect(res.verdict).toBe("fail");
    expect(getEntry(e).confidence).toBeCloseTo(0.5 - ltm.OUTCOME_PENALTY, 6);
  });

  test("FAIL floors confidence at 0, never negative", () => {
    const e = makeProjectEntry("c-floor", 0.02);
    inject("sfl", e);
    insertToolCall(pid, { session: "sfl", status: "error", verifier: 1 });
    ltm.creditSessionOutcome("sfl", PROJECT);
    expect(getEntry(e).confidence).toBe(0);
  });

  test("NONE verdict is a no-op (no verifier ran)", () => {
    const e = makeProjectEntry("c-none", 0.5);
    inject("snone", e);
    insertToolCall(pid, { session: "snone", status: "error", verifier: 0 }); // non-verifier
    const res = ltm.creditSessionOutcome("snone", PROJECT);
    expect(res.verdict).toBe("none");
    expect(res.credited).toBe(0);
    expect(getEntry(e).confidence).toBe(0.5);
    // injections stay uncredited so a later verifier outcome can still credit them.
    const credited = db()
      .query(
        "SELECT credited FROM knowledge_session_injections WHERE session_id = 'snone'",
      )
      .get() as { credited: number };
    expect(credited.credited).toBe(0);
  });

  test("is idempotent — a second credit pass does nothing", () => {
    const e = makeProjectEntry("c-idem", 0.5);
    inject("si", e);
    insertToolCall(pid, { session: "si", status: "completed", verifier: 1 });
    ltm.creditSessionOutcome("si", PROJECT);
    const afterFirst = getEntry(e).confidence;
    const second = ltm.creditSessionOutcome("si", PROJECT);
    expect(second.credited).toBe(0);
    expect(getEntry(e).confidence).toBe(afterFirst);
  });

  test("never touches a PROMOTED entry (project_id set, cross_project=1) — the cross_project=0 backstop", () => {
    // A promoted entry keeps its origin project_id but is cross_project=1. The
    // `project_id = pid` guard alone would NOT protect it (project_id matches),
    // so this exercises the `cross_project = 0` backstop specifically — a global
    // (project_id=NULL) entry would be masked by the project_id guard and leave
    // the backstop unverified.
    const e = makeProjectEntry("c-promoted", 0.5);
    const entry = getEntry(e);
    db().query("UPDATE knowledge SET cross_project = 1 WHERE id = ?").run(e);
    expect(getEntry(e).cross_project).toBe(1);
    expect(entry.project_id).not.toBeNull();
    // Force an injection row (recordSessionInjections would normally skip it).
    db()
      .query(
        `INSERT INTO knowledge_session_injections (session_id, logical_id, project_id, created_at, credited)
         VALUES (?, ?, ?, ?, 0)`,
      )
      .run("sx", entry.logical_id, pid, Date.now());
    insertToolCall(pid, { session: "sx", status: "error", verifier: 1 });
    ltm.creditSessionOutcome("sx", PROJECT);
    expect(getEntry(e).confidence).toBe(0.5); // unchanged — shared knowledge protected
  });

  test("does not adjust a deleted current version (is_deleted = 1)", () => {
    const e = makeProjectEntry("c-deleted", 0.5);
    inject("sd", e);
    db().query("UPDATE knowledge SET is_deleted = 1 WHERE id = ?").run(e);
    insertToolCall(pid, { session: "sd", status: "error", verifier: 1 });
    ltm.creditSessionOutcome("sd", PROJECT);
    expect(getEntry(e).confidence).toBe(0.5); // tombstoned → left alone
  });

  test("no injections → none verdict, zero credited", () => {
    insertToolCall(pid, { session: "empty", status: "completed", verifier: 1 });
    const res = ltm.creditSessionOutcome("empty", PROJECT);
    expect(res.verdict).toBe("none");
    expect(res.credited).toBe(0);
  });
});

describe("outcome-reward: outcomeImpact (observability, #497 follow-up)", () => {
  let pid: string;
  beforeEach(() => {
    pid = ensureProject(PROJECT);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
    db().query("DELETE FROM tool_calls WHERE project_id = ?").run(pid);
    db()
      .query("DELETE FROM knowledge_session_injections WHERE project_id = ?")
      .run(pid);
  });

  /** Credit one entry in a fresh session with the given verdict. */
  function creditOnce(
    logicalId: string,
    session: string,
    verdict: "pass" | "fail",
  ): void {
    db()
      .query(
        `INSERT INTO knowledge_session_injections (session_id, logical_id, project_id, created_at, credited)
         VALUES (?, ?, ?, ?, 0)`,
      )
      .run(session, logicalId, pid, Date.now());
    insertToolCall(pid, {
      session,
      status: verdict === "pass" ? "completed" : "error",
      verifier: 1,
    });
    ltm.creditSessionOutcome(session, PROJECT);
  }

  test("aggregates pass/fail co-occurrence counts across sessions", () => {
    const e = makeProjectEntry("imp-1", 0.5);
    const lid = getEntry(e).logical_id;
    creditOnce(lid, "i-a", "pass");
    creditOnce(lid, "i-b", "pass");
    creditOnce(lid, "i-c", "fail");

    const impact = ltm.outcomeImpact(lid);
    expect(impact.passes).toBe(2);
    expect(impact.fails).toBe(1);
  });

  test("does not count uncredited (NULL-verdict) rows", () => {
    // Pins the `verdict IN ('pass','fail')` filter: a still-uncredited (NULL
    // verdict) injection must not be counted toward passes/fails.
    const e = makeProjectEntry("imp-null", 0.5);
    const lid = getEntry(e).logical_id;
    creditOnce(lid, "i-pass", "pass");
    db()
      .query(
        `INSERT INTO knowledge_session_injections (session_id, logical_id, project_id, created_at, credited, verdict)
         VALUES (?, ?, ?, ?, 0, NULL)`,
      )
      .run("i-later-uncredited", lid, pid, Date.now() + 60_000);

    const impact = ltm.outcomeImpact(lid);
    expect(impact.passes).toBe(1);
    expect(impact.fails).toBe(0);
  });

  test("zero for an entry that has never been credited", () => {
    const e = makeProjectEntry("imp-2", 0.5);
    const impact = ltm.outcomeImpact(getEntry(e).logical_id);
    expect(impact).toEqual({ passes: 0, fails: 0 });
  });

  test("a NONE-verdict session records no verdict (uncredited, not counted)", () => {
    const e = makeProjectEntry("imp-3", 0.5);
    const lid = getEntry(e).logical_id;
    db()
      .query(
        `INSERT INTO knowledge_session_injections (session_id, logical_id, project_id, created_at, credited)
         VALUES (?, ?, ?, ?, 0)`,
      )
      .run("i-none", lid, pid, Date.now());
    // No verifier tool call → verdict 'none' → nothing recorded.
    ltm.creditSessionOutcome("i-none", PROJECT);
    expect(ltm.outcomeImpact(lid)).toEqual({ passes: 0, fails: 0 });
  });
});
