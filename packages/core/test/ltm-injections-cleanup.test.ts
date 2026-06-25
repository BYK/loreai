import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as data from "../src/data";
import { db, ensureProject } from "../src/db";
import * as ltm from "../src/ltm";

// #996: the outcome-reward injection log (knowledge_session_injections, #497) is
// the same orphan-leak class the #990 fix addressed — keyed on logical_id, no FK
// CASCADE — but it has a composite (session_id, logical_id) PK and a project_id,
// so it can't ride LOGICAL_ID_BOOKKEEPING_TABLES. Every knowledge hard-delete
// path must purge it by logical_id/project_id, and deleteSession by session_id.
// An UPDATE (new version, same logical_id) must NOT purge it — the loop reads it
// once per session, so it has to survive mid-session version edits.

let root: string;
let seedCounter = 0;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lore-inj-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function seed(): { id: string; logicalId: string } {
  const id = ltm.create({
    projectPath: root,
    scope: "project",
    crossProject: false,
    category: "gotcha",
    title: `Injection entry ${++seedCounter}`,
    content: "an entry whose confidence the outcome loop credits",
  });
  const logicalId = ltm.get(id)?.logical_id;
  if (!logicalId) throw new Error("seed failed");
  return { id, logicalId };
}

// Direct insert — the cleanup is under test, not recordSessionInjections().
function seedInjection(args: {
  sessionId: string;
  logicalId: string;
  projectId: string;
}): void {
  db()
    .query(
      `INSERT OR REPLACE INTO knowledge_session_injections
         (session_id, logical_id, project_id, created_at, credited)
       VALUES (?, ?, ?, ?, 0)`,
    )
    .run(args.sessionId, args.logicalId, args.projectId, Date.now());
}

function injByLogical(logicalId: string): number {
  return (
    db()
      .query(
        "SELECT COUNT(*) AS c FROM knowledge_session_injections WHERE logical_id = ?",
      )
      .get(logicalId) as { c: number }
  ).c;
}

function injBySession(sessionId: string): number {
  return (
    db()
      .query(
        "SELECT COUNT(*) AS c FROM knowledge_session_injections WHERE session_id = ?",
      )
      .get(sessionId) as { c: number }
  ).c;
}

function injByProject(projectId: string): number {
  return (
    db()
      .query(
        "SELECT COUNT(*) AS c FROM knowledge_session_injections WHERE project_id = ?",
      )
      .get(projectId) as { c: number }
  ).c;
}

describe("orphan injection-log cleanup on knowledge/session delete (#996)", () => {
  test("remove() purges injections for the entry, leaving siblings", () => {
    const a = seed();
    const b = seed();
    const pid = ensureProject(root);
    seedInjection({ sessionId: "s1", logicalId: a.logicalId, projectId: pid });
    seedInjection({ sessionId: "s1", logicalId: b.logicalId, projectId: pid });
    expect(injByLogical(a.logicalId)).toBe(1);
    expect(injByLogical(b.logicalId)).toBe(1);

    ltm.remove(a.logicalId);

    expect(injByLogical(a.logicalId)).toBe(0);
    expect(injByLogical(b.logicalId)).toBe(1); // sibling entry untouched
  });

  test("update() (new version) PRESERVES injections — survives version edits", () => {
    const { id, logicalId } = seed();
    const pid = ensureProject(root);
    seedInjection({ sessionId: "s1", logicalId, projectId: pid });

    // A content change appends a new version with the same logical_id; the
    // injection log must stay so the idle pass can still credit the session.
    ltm.update(id, {
      content: "changed content forces a brand new version row",
    });

    expect(ltm.getByLogical(logicalId)?.logical_id).toBe(logicalId);
    expect(injByLogical(logicalId)).toBe(1); // not purged
  });

  test("clearKnowledge() purges injections for the project (incl. orphans)", () => {
    const { logicalId } = seed();
    const pid = ensureProject(root);
    seedInjection({ sessionId: "s1", logicalId, projectId: pid });
    // A row whose knowledge entry is already gone — only a project_id sweep
    // reclaims it; a `logical_id IN (SELECT ... FROM knowledge)` shape would not.
    seedInjection({ sessionId: "s2", logicalId: "ghost", projectId: pid });
    expect(injByProject(pid)).toBe(2);

    data.clearKnowledge(root);

    expect(injByProject(pid)).toBe(0);
  });

  test("clearProject() purges injections for the project (incl. orphans)", () => {
    const { logicalId } = seed();
    const pid = ensureProject(root);
    seedInjection({ sessionId: "s1", logicalId, projectId: pid });
    seedInjection({ sessionId: "s2", logicalId: "ghost", projectId: pid });
    expect(injByProject(pid)).toBe(2);

    data.clearProject(root);

    expect(injByProject(pid)).toBe(0);
  });

  test("clearProject() leaves another project's injections untouched", () => {
    const { logicalId } = seed();
    const pid = ensureProject(root);
    const root2 = mkdtempSync(join(tmpdir(), "lore-inj-other-"));
    const pid2 = ensureProject(root2);
    seedInjection({ sessionId: "s1", logicalId, projectId: pid });
    seedInjection({ sessionId: "s9", logicalId: "other", projectId: pid2 });

    data.clearProject(root);

    expect(injByProject(pid)).toBe(0);
    expect(injByProject(pid2)).toBe(1); // different project untouched
    rmSync(root2, { recursive: true, force: true });
  });

  test("deleteProject() purges injections for the project (incl. orphans)", () => {
    const { logicalId } = seed();
    const pid = ensureProject(root);
    seedInjection({ sessionId: "s1", logicalId, projectId: pid });
    seedInjection({ sessionId: "s2", logicalId: "ghost", projectId: pid });
    expect(injByProject(pid)).toBe(2);

    data.deleteProject(pid);

    expect(injByProject(pid)).toBe(0);
  });

  test("deleteSession() purges injections for that session only", () => {
    const { logicalId } = seed();
    const pid = ensureProject(root);
    // session_id is global (not project-scoped); the DB persists across tests in
    // this file, so use ids unique to this test to keep injBySession() exact.
    const s1 = `del-keep-${++seedCounter}`;
    const s2 = `del-drop-${++seedCounter}`;
    seedInjection({ sessionId: s2, logicalId, projectId: pid });
    seedInjection({ sessionId: s1, logicalId, projectId: pid });
    expect(injBySession(s2)).toBe(1);
    expect(injBySession(s1)).toBe(1);

    data.deleteSession(root, s2);

    expect(injBySession(s2)).toBe(0);
    expect(injBySession(s1)).toBe(1); // sibling session untouched
  });
});
