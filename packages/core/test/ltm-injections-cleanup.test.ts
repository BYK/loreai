import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as data from "../src/data";
import {
  db,
  ensureProject,
  saveSessionTracking,
  withSavepoint,
} from "../src/db";
import * as ltm from "../src/ltm";
import { SourceWindowStore } from "../src/source-window-store";
import { withTenant } from "../src/tenant";

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

  test("deleting a session from another project cannot erase its owner state or bookkeeping", () => {
    const otherRoot = mkdtempSync(join(tmpdir(), "lore-inj-other-"));
    const sameTenantRoot = mkdtempSync(join(tmpdir(), "lore-inj-same-tenant-"));
    const sessionId = `project-isolated-delete-${++seedCounter}`;
    try {
      const ownerProject = withTenant("owner-tenant", () => {
        const project = ensureProject(root);
        saveSessionTracking(sessionId, {
          projectPath: root,
          projectPathProvisional: false,
          credentialFingerprint: "owner-tenant",
        });
        db()
          .query(
            `INSERT INTO session_prompt_deltas
               (session_id, seq, project_id, selector, content)
             VALUES (?, 1, ?, 'selector', 'private delta')`,
          )
          .run(sessionId, project);
        seedInjection({
          sessionId,
          logicalId: `owner-injection-${seedCounter}`,
          projectId: project,
        });
        return project;
      });
      withTenant("other-tenant", () => {
        ensureProject(otherRoot);
        expect(data.deleteSession(otherRoot, sessionId)).toEqual({
          messages_deleted: 0,
          distillations_deleted: 0,
        });
      });
      withTenant("owner-tenant", () => {
        ensureProject(sameTenantRoot);
        expect(data.deleteSession(sameTenantRoot, sessionId)).toEqual({
          messages_deleted: 0,
          distillations_deleted: 0,
        });
      });

      expect(
        db()
          .query("SELECT project_path FROM session_state WHERE session_id = ?")
          .get(sessionId),
      ).toEqual({ project_path: root });
      expect(
        db()
          .query(
            "SELECT tenant_id FROM session_state_owners WHERE session_id = ?",
          )
          .get(sessionId),
      ).toEqual({ tenant_id: "owner-tenant" });
      expect(
        db()
          .query(
            "SELECT project_id FROM session_prompt_deltas WHERE session_id = ?",
          )
          .get(sessionId),
      ).toEqual({ project_id: ownerProject });
      expect(injByProject(ownerProject)).toBe(1);

      withTenant("owner-tenant", () => data.deleteSession(root, sessionId));
      expect(
        db()
          .query("SELECT 1 FROM session_state WHERE session_id = ?")
          .get(sessionId),
      ).toBeNull();
      expect(injByProject(ownerProject)).toBe(0);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
      rmSync(sameTenantRoot, { recursive: true, force: true });
    }
  });

  test.each([
    ["clear", "other-tenant"],
    ["delete", "other-tenant"],
    ["clear", "owner-tenant"],
    ["delete", "owner-tenant"],
  ] as const)(
    "%s project preserves another project's state with the same session ID under %s",
    (operation, otherTenant) => {
      const otherRoot = mkdtempSync(join(tmpdir(), "lore-inj-collision-"));
      const sessionId = `bulk-project-collision-${++seedCounter}`;
      try {
        const ownerProject = withTenant("owner-tenant", () => {
          const project = ensureProject(root);
          saveSessionTracking(sessionId, {
            projectPath: root,
            projectPathProvisional: false,
            credentialFingerprint: "owner-tenant",
          });
          const window = new SourceWindowStore({
            projectPath: root,
            sessionID: sessionId,
            noStore: false,
          });
          withSavepoint("seed_owned_checkpoint", () => {
            expect(window.claim()).toBe(true);
            expect(window.publish({ private: "owned checkpoint" })).toBe(true);
          });
          return project;
        });
        const otherProject = withTenant(otherTenant, () => {
          const project = ensureProject(otherRoot);
          // A persisted message can share a global session ID with a state
          // already owned by another project. No owner state is created here.
          db()
            .query(
              `INSERT INTO temporal_messages
                 (id, project_id, session_id, role, content, tokens, distilled, created_at)
               VALUES (?, ?, ?, 'user', 'other project message', 0, 0, 1)`,
            )
            .run(`foreign-message-${seedCounter}`, project, sessionId);
          return project;
        });
        withTenant(otherTenant, () => {
          if (operation === "clear") data.clearProject(otherRoot);
          else data.deleteProject(otherProject);
        });
        expect(
          db()
            .query(
              "SELECT project_path FROM session_state WHERE session_id = ?",
            )
            .get(sessionId),
        ).toEqual({ project_path: root });
        expect(
          db()
            .query(
              "SELECT tenant_id FROM session_state_owners WHERE session_id = ?",
            )
            .get(sessionId),
        ).toEqual({ tenant_id: "owner-tenant" });
        expect(
          db()
            .query("SELECT project_id FROM source_windows WHERE session_id = ?")
            .get(sessionId),
        ).toEqual({ project_id: ownerProject });
        expect(
          withTenant("owner-tenant", () =>
            new SourceWindowStore({
              projectPath: root,
              sessionID: sessionId,
              noStore: false,
            }).load(),
          ),
        ).toEqual({ private: "owned checkpoint" });
      } finally {
        rmSync(otherRoot, { recursive: true, force: true });
      }
    },
  );

  test("deleteProject rejects an ID belonging to another tenant", () => {
    const sessionId = `foreign-project-id-${++seedCounter}`;
    const ownerProject = withTenant("owner-tenant", () => {
      const project = ensureProject(root);
      saveSessionTracking(sessionId, {
        projectPath: root,
        projectPathProvisional: false,
        credentialFingerprint: "owner-tenant",
      });
      return project;
    });
    expect(
      withTenant("other-tenant", () => data.deleteProject(ownerProject)),
    ).toBeNull();
    expect(
      db()
        .query("SELECT path, tenant_id FROM projects WHERE id = ?")
        .get(ownerProject),
    ).toEqual({ path: root, tenant_id: "owner-tenant" });
    expect(
      db()
        .query("SELECT project_path FROM session_state WHERE session_id = ?")
        .get(sessionId),
    ).toEqual({ project_path: root });
  });

  test.each(["clear", "delete"] as const)(
    "%s project removes its own confirmed source-only session state",
    (operation) => {
      const sessionId = `bulk-source-only-${++seedCounter}`;
      const project = ensureProject(root);
      saveSessionTracking(sessionId, {
        projectPath: root,
        projectPathProvisional: false,
      });
      const window = new SourceWindowStore({
        projectPath: root,
        sessionID: sessionId,
        noStore: false,
      });
      withSavepoint("seed_owned_source_only", () => {
        expect(window.claim()).toBe(true);
        expect(window.publish({ private: "owned" })).toBe(true);
      });
      if (operation === "clear") data.clearProject(root);
      else data.deleteProject(project);
      expect(
        db()
          .query("SELECT 1 FROM session_state WHERE session_id = ?")
          .get(sessionId),
      ).toBeNull();
      expect(
        db()
          .query("SELECT 1 FROM source_windows WHERE session_id = ?")
          .get(sessionId),
      ).toBeNull();
    },
  );

  test("deleteSession clears a provisional source-only checkpoint without touching another project", () => {
    const otherRoot = mkdtempSync(join(tmpdir(), "lore-inj-checkpoint-"));
    const sessionId = `source-only-delete-${++seedCounter}`;
    const siblingId = `source-only-sibling-${seedCounter}`;
    try {
      const project = ensureProject(root);
      const siblingProject = ensureProject(otherRoot);
      for (const [path, id] of [
        [root, sessionId],
        [otherRoot, siblingId],
      ] as const) {
        saveSessionTracking(id, {
          projectPath: path,
          projectPathProvisional: true,
        });
        const window = new SourceWindowStore({
          projectPath: path,
          sessionID: id,
          noStore: false,
        });
        withSavepoint("seed_provisional_checkpoint", () => {
          expect(window.claim()).toBe(true);
          expect(window.publish({ private: id })).toBe(true);
        });
      }
      expect(data.deleteSession(root, sessionId)).toEqual({
        messages_deleted: 0,
        distillations_deleted: 0,
      });
      expect(
        db()
          .query("SELECT project_id FROM source_windows WHERE session_id = ?")
          .get(sessionId),
      ).toBeNull();
      expect(
        db()
          .query("SELECT 1 FROM session_state WHERE session_id = ?")
          .get(sessionId),
      ).not.toBeNull();
      expect(
        db()
          .query("SELECT project_id FROM source_windows WHERE session_id = ?")
          .get(siblingId),
      ).toEqual({ project_id: siblingProject });
      expect(
        db().query("SELECT id FROM projects WHERE id = ?").get(project),
      ).not.toBeNull();
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});
