/**
 * Tests for moveSessions() and reassignKnowledge() in data.ts.
 *
 * Verifies that sessions can be moved between projects, carrying their
 * temporal_messages, distillations, tool_calls, session_state, and
 * source_session-linked knowledge entries.
 */
import { describe, test, expect, beforeEach } from "vitest";
import {
  appendSessionPromptDelta,
  db,
  ensureProject,
  saveSessionCosts,
  saveSessionTracking,
} from "../src/db";
import * as data from "../src/data";
import { SourceWindowStore } from "../src/source-window-store";
import { withTenant } from "../src/tenant";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const PROJECT_A = "/test/move/project-a";
const PROJECT_B = "/test/move/project-b";
const SESSION_1 = "move-test-sess-1";
const SESSION_2 = "move-test-sess-2";
const CHILD_SESSION = "move-test-child-1";

function insertMessage(projectId: string, sessionId: string, id: string): void {
  db()
    .query(
      `INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
       VALUES (?, ?, ?, 'user', 'test content', 10, 0, ?, '{}')`,
    )
    .run(id, projectId, sessionId, Date.now());
}

function insertDistillation(
  projectId: string,
  sessionId: string,
  id: string,
): void {
  db()
    .query(
      `INSERT INTO distillations (id, project_id, session_id, generation, narrative, facts, source_ids, token_count, created_at)
       VALUES (?, ?, ?, 0, 'distilled narrative', '[]', '[]', 50, ?)`,
    )
    .run(id, projectId, sessionId, Date.now());
}

function insertToolCall(
  projectId: string,
  sessionId: string,
  callId: string,
): void {
  db()
    .query(
      `INSERT INTO tool_calls (call_id, message_id, project_id, session_id, tool, status, created_at)
       VALUES (?, ?, ?, ?, 'test_tool', 'completed', ?)`,
    )
    .run(callId, `msg-for-${callId}`, projectId, sessionId, Date.now());
}

function insertKnowledge(
  projectId: string | null,
  id: string,
  opts?: { sourceSession?: string; crossProject?: boolean },
): void {
  const now = Date.now();
  db()
    .query(
      `INSERT INTO knowledge (id, project_id, category, title, content, source_session, cross_project, created_at, updated_at, logical_id)
       VALUES (?, ?, 'pattern', 'Test Knowledge', 'test content', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      projectId ?? null,
      opts?.sourceSession ?? null,
      opts?.crossProject ? 1 : 0,
      now,
      now,
      id, // logical_id = id, matching create()/production
    );
  // confidence lives on the knowledge_meta register now (A2 3b), keyed by logical_id.
  db()
    .query(
      "INSERT INTO knowledge_meta (logical_id, confidence, last_reinforced_at, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run(id, 0.8, now, now);
}

function insertInjection(
  projectId: string,
  sessionId: string,
  logicalId: string,
): void {
  db()
    .query(
      `INSERT INTO knowledge_session_injections (session_id, logical_id, project_id, created_at, credited)
       VALUES (?, ?, ?, ?, 0)`,
    )
    .run(sessionId, logicalId, projectId, Date.now());
}

function countInProject(table: string, projectId: string): number {
  return (
    db()
      .query(`SELECT COUNT(*) as c FROM ${table} WHERE project_id = ?`)
      .get(projectId) as { c: number }
  ).c;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("moveSessions", () => {
  let pidA: string;
  let pidB: string;

  beforeEach(() => {
    // Clean up any leftover data from previous runs.
    const database = db();
    database.query("DELETE FROM temporal_messages").run();
    database.query("DELETE FROM distillations").run();
    database.query("DELETE FROM tool_calls").run();
    database.query("DELETE FROM session_prompt_deltas").run();
    database.query("DELETE FROM knowledge WHERE embedding IS NOT NULL").run();
    database.query("DELETE FROM knowledge").run();
    database.query("DELETE FROM knowledge_session_injections").run();
    database.query("DELETE FROM session_state").run();

    pidA = ensureProject(PROJECT_A);
    pidB = ensureProject(PROJECT_B);
  });

  test("moves temporal_messages, distillations, tool_calls between projects", () => {
    insertMessage(pidA, SESSION_1, "msg-move-1");
    insertMessage(pidA, SESSION_1, "msg-move-2");
    insertDistillation(pidA, SESSION_1, "dist-move-1");
    insertToolCall(pidA, SESSION_1, "tc-move-1");

    // Also insert data for session_2 that should NOT move
    insertMessage(pidA, SESSION_2, "msg-stay-1");

    const result = data.moveSessions([SESSION_1], pidA, PROJECT_B);

    expect(result.sessions_moved).toBe(1);
    expect(result.messages_moved).toBe(2);
    expect(result.distillations_moved).toBe(1);
    expect(result.tool_calls_moved).toBe(1);
    expect(result.movedSessionIds).toContain(SESSION_1);

    // Verify data moved to project B
    expect(countInProject("temporal_messages", pidB)).toBe(2);
    expect(countInProject("distillations", pidB)).toBe(1);
    expect(countInProject("tool_calls", pidB)).toBe(1);

    // Verify session_2 data stayed in project A
    expect(countInProject("temporal_messages", pidA)).toBe(1);
  });

  test("moves session prompt deltas between projects", () => {
    insertMessage(pidA, SESSION_1, "msg-delta-1");
    insertMessage(pidA, SESSION_2, "msg-delta-stay");
    appendSessionPromptDelta({
      sessionID: SESSION_1,
      projectID: pidA,
      selector: JSON.stringify({ target: "messages", insertAt: 1 }),
      content: JSON.stringify({
        role: "user",
        content: [{ type: "text", text: "moved" }],
      }),
    });
    appendSessionPromptDelta({
      sessionID: SESSION_2,
      projectID: pidA,
      selector: JSON.stringify({ target: "messages", insertAt: 1 }),
      content: JSON.stringify({
        role: "user",
        content: [{ type: "text", text: "stays" }],
      }),
    });

    const result = data.moveSessions([SESSION_1], pidA, PROJECT_B);

    expect(result.sessions_moved).toBe(1);
    expect(countInProject("session_prompt_deltas", pidB)).toBe(1);
    expect(countInProject("session_prompt_deltas", pidA)).toBe(1);
  });

  test("moves source_session-linked knowledge entries", () => {
    insertMessage(pidA, SESSION_1, "msg-k-1");
    insertKnowledge(pidA, "k-linked-1", { sourceSession: SESSION_1 });
    insertKnowledge(pidA, "k-unlinked-1"); // no source_session — should stay

    const result = data.moveSessions([SESSION_1], pidA, PROJECT_B);

    expect(result.knowledge_moved).toBe(1);
    // Linked knowledge moved
    expect(countInProject("knowledge", pidB)).toBe(1);
    // Unlinked knowledge stayed
    expect(countInProject("knowledge", pidA)).toBe(1);
  });

  test("moves outcome-reward injection log rows with the session (#996)", () => {
    insertMessage(pidA, SESSION_1, "msg-inj-1");
    insertInjection(pidA, SESSION_1, "k-inj-moved");
    insertInjection(pidA, SESSION_2, "k-inj-stay"); // other session — stays

    data.moveSessions([SESSION_1], pidA, PROJECT_B);

    // The moved session's injections must follow it: creditSessionOutcome filters
    // on the session's CURRENT project, so leaving them under A silently drops the
    // credits (and orphans the rows if A is later deleted).
    expect(countInProject("knowledge_session_injections", pidB)).toBe(1);
    // The unmoved session's injection stayed in A.
    expect(countInProject("knowledge_session_injections", pidA)).toBe(1);
  });

  test("moves a confirmed session_state project binding", () => {
    insertMessage(pidA, SESSION_1, "msg-ss-1");
    saveSessionTracking(SESSION_1, {
      projectPath: PROJECT_A,
      projectPathProvisional: false,
    });

    data.moveSessions([SESSION_1], pidA, PROJECT_B);

    const row = db()
      .query(
        "SELECT project_path, project_path_provisional FROM session_state WHERE session_id = ?",
      )
      .get(SESSION_1) as {
      project_path: string;
      project_path_provisional: number;
    } | null;

    expect(row).not.toBeNull();
    expect(row?.project_path).toBe(PROJECT_B);
    expect(row?.project_path_provisional).toBe(0); // confident after explicit move
  });

  test("returns zero counts for empty session list", () => {
    const result = data.moveSessions([], pidA, PROJECT_B);
    expect(result.sessions_moved).toBe(0);
    expect(result.messages_moved).toBe(0);
  });

  test("returns zero counts when source and target are the same project", () => {
    insertMessage(pidA, SESSION_1, "msg-same-1");
    const result = data.moveSessions([SESSION_1], pidA, PROJECT_A);
    expect(result.sessions_moved).toBe(0);
    expect(result.messages_moved).toBe(0);
    // Data stays in place
    expect(countInProject("temporal_messages", pidA)).toBe(1);
  });

  test("rejects a foreign source project before creating a destination", () => {
    const foreign = withTenant("another-tenant", () =>
      ensureProject("/test/move/foreign-project"),
    );
    withTenant("another-tenant", () =>
      insertMessage(foreign, "foreign-session", "foreign-message"),
    );
    const destination = "/test/move/uncreated-destination";

    expect(() =>
      data.moveSessions(["foreign-session"], foreign, destination),
    ).toThrow("source project unavailable");
    expect(
      db()
        .query("SELECT project_id FROM temporal_messages WHERE id = ?")
        .get("foreign-message"),
    ).toEqual({ project_id: foreign });
    expect(
      db().query("SELECT 1 FROM projects WHERE path = ?").get(destination),
    ).toBeNull();
  });

  test("does not rebind foreign sessions or children supplied with an owned source", () => {
    const foreign = withTenant("another-tenant", () =>
      ensureProject("/test/move/foreign-children"),
    );
    insertMessage(pidA, SESSION_1, "owned-message");
    saveSessionTracking(SESSION_1, {
      projectPath: PROJECT_A,
      projectPathProvisional: false,
    });
    withTenant("another-tenant", () => {
      insertMessage(foreign, "foreign-parent", "foreign-parent-message");
      insertMessage(foreign, "foreign-child", "foreign-child-message");
      saveSessionTracking("foreign-parent", {
        projectPath: "/test/move/foreign-children",
      });
      saveSessionTracking("foreign-child", {
        projectPath: "/test/move/foreign-children",
        parentSessionId: SESSION_1,
      });
    });

    const result = data.moveSessions(
      [SESSION_1, "foreign-parent"],
      pidA,
      PROJECT_B,
    );

    expect(result.movedSessionIds).toEqual([SESSION_1]);
    expect(result.sessions_moved).toBe(1);
    expect(
      db()
        .query("SELECT project_path FROM session_state WHERE session_id = ?")
        .get("foreign-parent"),
    ).toEqual({ project_path: "/test/move/foreign-children" });
    expect(
      db()
        .query("SELECT project_path FROM session_state WHERE session_id = ?")
        .get("foreign-child"),
    ).toEqual({ project_path: "/test/move/foreign-children" });
    expect(countInProject("temporal_messages", foreign)).toBe(2);
    expect(countInProject("temporal_messages", pidB)).toBe(1);
  });

  test("moves source rows without rebinding a colliding foreign-owned state", () => {
    const id = "colliding-tenant-session";
    const foreignPath = "/test/move/foreign-collision";
    withTenant("foreign-tenant", () => {
      ensureProject(foreignPath);
      saveSessionTracking(id, {
        projectPath: foreignPath,
        credentialFingerprint: "foreign-tenant",
      });
    });
    // The foreign state exists first. The authorized source then acquires a
    // temporal row using the same global session ID.
    insertMessage(pidA, id, "source-colliding-message");

    const result = data.moveSessions([id], pidA, PROJECT_B, {
      includeChildren: false,
    });

    expect(result.messages_moved).toBe(1);
    expect(result.movedSessionIds).toEqual([]);
    expect(
      db()
        .query("SELECT project_id FROM temporal_messages WHERE id = ?")
        .get("source-colliding-message"),
    ).toEqual({ project_id: pidB });
    expect(
      db()
        .query("SELECT project_path FROM session_state WHERE session_id = ?")
        .get(id),
    ).toEqual({ project_path: foreignPath });
  });

  test("does not rebind a credential-bound state using only a local source row", () => {
    const id = "local-credential-collision";
    insertMessage(pidA, id, "local-row");
    saveSessionTracking(id, {
      projectPath: PROJECT_A,
      projectPathProvisional: false,
      credentialFingerprint: "another-credential",
    });

    const result = data.moveSessions([id], pidA, PROJECT_B, {
      includeChildren: false,
    });
    expect(result.messages_moved).toBe(1);
    expect(result.movedSessionIds).toEqual([]);
    expect(
      db()
        .query("SELECT project_path FROM session_state WHERE session_id = ?")
        .get(id),
    ).toEqual({ project_path: PROJECT_A });
  });

  test.each([
    { path: PROJECT_B, provisional: true },
    { path: null, provisional: true },
  ])(
    "moves source rows without rebinding a same-tenant state bound to $path",
    ({ path, provisional }) => {
      const id = `colliding-local-${path ?? "unbound"}`;
      // The other state predates the source row and has the same global ID.
      saveSessionTracking(id, {
        ...(path === null ? {} : { projectPath: path }),
        projectPathProvisional: provisional,
      });
      insertMessage(pidA, id, `source-row-${id}`);

      const result = data.moveSessions([id], pidA, PROJECT_B, {
        includeChildren: false,
      });

      expect(result.messages_moved).toBe(1);
      expect(result.movedSessionIds).toEqual([]);
      expect(
        db()
          .query("SELECT project_id FROM temporal_messages WHERE id = ?")
          .get(`source-row-${id}`),
      ).toEqual({ project_id: pidB });
      expect(
        db()
          .query("SELECT project_path FROM session_state WHERE session_id = ?")
          .get(id),
      ).toEqual({ project_path: path });
    },
  );

  test("cost-first state records an owner before its source rows move", () => {
    const id = "cost-first-source-state";
    saveSessionCosts(id, {
      conversationCost: 0,
      workerCost: 0,
      conversationTurns: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      warmupSavings: 0,
      warmupCost: 0,
      warmupHits: 0,
      ttlSavings: 0,
      ttlHits: 0,
      batchSavings: 0,
      avoidedCompactions: 0,
      avoidedCompactionCost: 0,
    });
    expect(
      db()
        .query(
          "SELECT tenant_id FROM session_state_owners WHERE session_id = ?",
        )
        .get(id),
    ).toEqual({ tenant_id: "" });
    saveSessionTracking(id, {
      projectPath: PROJECT_A,
      projectPathProvisional: false,
    });
    insertMessage(pidA, id, "cost-first-temporal");

    expect(data.moveSessions([id], pidA, PROJECT_B).movedSessionIds).toEqual([
      id,
    ]);
    expect(
      db()
        .query("SELECT project_path FROM session_state WHERE session_id = ?")
        .get(id),
    ).toEqual({ project_path: PROJECT_B });
  });

  test("rejects an unverifiable legacy state rather than splitting its move", () => {
    const id = "unowned-legacy-state";
    db()
      .query(
        "INSERT INTO session_state (session_id, force_min_layer, updated_at, project_path) VALUES (?, 0, ?, ?)",
      )
      .run(id, Date.now(), PROJECT_A);
    insertMessage(pidA, id, "legacy-source-message");

    expect(() => data.moveSessions([id], pidA, PROJECT_B)).toThrow(
      "session state ownership unavailable",
    );
    expect(
      db()
        .query("SELECT project_id FROM temporal_messages WHERE id = ?")
        .get("legacy-source-message"),
    ).toEqual({ project_id: pidA });
  });

  test("does not create a destination for a rejected legacy state move", () => {
    const id = "unowned-new-destination";
    const destination = "/test/rejected-unowned-destination";
    db()
      .query(
        "INSERT INTO session_state (session_id, force_min_layer, updated_at, project_path) VALUES (?, 0, ?, ?)",
      )
      .run(id, Date.now(), PROJECT_A);
    insertMessage(pidA, id, "unowned-new-destination-message");

    expect(() =>
      data.moveSessions([id], pidA, destination, { includeChildren: false }),
    ).toThrow("session state ownership unavailable");
    expect(
      db().query("SELECT id FROM projects WHERE path = ?").get(destination),
    ).toBeNull();
    expect(
      db()
        .query("SELECT path FROM project_path_aliases WHERE path = ?")
        .get(destination),
    ).toBeNull();
    expect(
      db()
        .query("SELECT project_id FROM temporal_messages WHERE id = ?")
        .get("unowned-new-destination-message"),
    ).toEqual({ project_id: pidA });
  });

  test("rejects an unowned source-only lease before splitting legacy state", () => {
    const id = "unowned-source-only-state";
    db()
      .query(
        "INSERT INTO session_state (session_id, force_min_layer, updated_at, project_path) VALUES (?, 0, ?, ?)",
      )
      .run(id, Date.now(), PROJECT_A);
    new SourceWindowStore({
      projectPath: PROJECT_A,
      sessionID: id,
      noStore: false,
    });

    expect(() =>
      data.moveSessions([id], pidA, PROJECT_B, { includeChildren: false }),
    ).toThrow("session state ownership unavailable");
    expect(
      db()
        .query("SELECT project_id FROM source_windows WHERE session_id = ?")
        .get(id),
    ).toEqual({ project_id: pidA });
  });

  test.each([
    { bound: false, path: null, fingerprint: "foreign-tenant" },
    { bound: true, path: PROJECT_A, fingerprint: "foreign-tenant" },
    { bound: true, path: PROJECT_A, fingerprint: "" },
  ])(
    "does not rebind a foreign state through a source-only lease (bound=$bound fingerprint=$fingerprint)",
    ({ bound, path, fingerprint }) => {
      const foreignId = `foreign-source-only-${bound}-${fingerprint || "local-looking"}`;
      withTenant("foreign-tenant", () =>
        saveSessionTracking(foreignId, {
          credentialFingerprint: fingerprint,
          ...(path === null ? {} : { projectPath: path }),
        }),
      );
      // An unbound state can acquire a lease before its first response; another
      // tenant can also use the same project path. Neither proves ownership.
      new SourceWindowStore({
        projectPath: PROJECT_A,
        sessionID: foreignId,
        noStore: false,
      });
      expect(
        db()
          .query("SELECT project_id FROM source_windows WHERE session_id = ?")
          .get(foreignId),
      ).toEqual({ project_id: pidA });

      const result = data.moveSessions([foreignId], pidA, PROJECT_B, {
        includeChildren: false,
      });
      expect(result.movedSessionIds).toEqual([]);
      expect(
        db()
          .query("SELECT project_path FROM session_state WHERE session_id = ?")
          .get(foreignId),
      ).toEqual({ project_path: path });
    },
  );

  test("rebinds a confirmed source-only lease before any temporal row exists", () => {
    const id = "owned-source-only";
    saveSessionTracking(id, {
      projectPath: PROJECT_A,
      projectPathProvisional: false,
    });
    expect(
      db()
        .query(
          "SELECT tenant_id FROM session_state_owners WHERE session_id = ?",
        )
        .get(id),
    ).toEqual({ tenant_id: "" });
    new SourceWindowStore({
      projectPath: PROJECT_A,
      sessionID: id,
      noStore: false,
    });
    expect(countInProject("temporal_messages", pidA)).toBe(0);

    const result = data.moveSessions([id], pidA, PROJECT_B, {
      includeChildren: false,
    });
    expect(result.movedSessionIds).toEqual([id]);
    expect(
      db()
        .query("SELECT project_path FROM session_state WHERE session_id = ?")
        .get(id),
    ).toEqual({ project_path: PROJECT_B });
  });

  test.each([false, true])(
    "never rebinds a colliding provisional source state through a lease (temporal=%s)",
    (temporal) => {
      const id = `provisional-collision-${temporal}`;
      // The state predates the separately sourced row or lease.
      saveSessionTracking(id, {
        projectPath: PROJECT_A,
        projectPathProvisional: true,
      });
      if (temporal) insertMessage(pidA, id, `provisional-source-${id}`);
      else
        new SourceWindowStore({
          projectPath: PROJECT_A,
          sessionID: id,
          noStore: false,
        });

      const result = data.moveSessions([id], pidA, PROJECT_B, {
        includeChildren: false,
      });
      expect(result.movedSessionIds).toEqual([]);
      expect(
        db()
          .query(
            "SELECT project_path, project_path_provisional FROM session_state WHERE session_id = ?",
          )
          .get(id),
      ).toEqual({ project_path: PROJECT_A, project_path_provisional: 1 });
      if (temporal) expect(result.messages_moved).toBe(1);
    },
  );

  test("expands child sessions by default via parent_session_id", () => {
    insertMessage(pidA, SESSION_1, "msg-parent-1");
    insertMessage(pidA, CHILD_SESSION, "msg-child-1");

    // Set up parent-child relationship
    saveSessionTracking(SESSION_1, {
      projectPath: PROJECT_A,
      projectPathProvisional: false,
    });
    saveSessionTracking(CHILD_SESSION, {
      projectPath: PROJECT_A,
      projectPathProvisional: false,
      parentSessionId: SESSION_1,
    });

    const result = data.moveSessions([SESSION_1], pidA, PROJECT_B);

    // Both parent and child should be moved
    expect(result.sessions_moved).toBe(2);
    expect(result.messages_moved).toBe(2);
    expect(result.movedSessionIds).toContain(SESSION_1);
    expect(result.movedSessionIds).toContain(CHILD_SESSION);
    expect(countInProject("temporal_messages", pidB)).toBe(2);
  });

  test("does not expand children when includeChildren is false", () => {
    insertMessage(pidA, SESSION_1, "msg-noexp-1");
    insertMessage(pidA, CHILD_SESSION, "msg-noexp-child-1");

    saveSessionTracking(SESSION_1, {
      projectPath: PROJECT_A,
      projectPathProvisional: false,
    });
    saveSessionTracking(CHILD_SESSION, {
      projectPath: PROJECT_A,
      projectPathProvisional: false,
      parentSessionId: SESSION_1,
    });

    const result = data.moveSessions([SESSION_1], pidA, PROJECT_B, {
      includeChildren: false,
    });

    // Only the parent should move
    expect(result.sessions_moved).toBe(1);
    expect(result.messages_moved).toBe(1);
    expect(countInProject("temporal_messages", pidB)).toBe(1);
    // Child stays
    expect(countInProject("temporal_messages", pidA)).toBe(1);
  });

  test("moves multiple sessions at once", () => {
    insertMessage(pidA, SESSION_1, "msg-multi-1");
    insertMessage(pidA, SESSION_2, "msg-multi-2");

    const result = data.moveSessions([SESSION_1, SESSION_2], pidA, PROJECT_B);

    expect(result.sessions_moved).toBe(2);
    expect(result.messages_moved).toBe(2);
    expect(countInProject("temporal_messages", pidA)).toBe(0);
    expect(countInProject("temporal_messages", pidB)).toBe(2);
  });

  test("creates target project if it does not exist", () => {
    const newProjectPath = `/test/move/new-project-${Date.now()}`;
    insertMessage(pidA, SESSION_1, "msg-new-1");

    const result = data.moveSessions([SESSION_1], pidA, newProjectPath);

    expect(result.sessions_moved).toBe(1);
    expect(result.messages_moved).toBe(1);
    // Verify the new project was created
    const projects = data.listProjects();
    expect(projects.find((p) => p.path === newProjectPath)).toBeDefined();
  });
});

describe("reassignKnowledge", () => {
  let pidA: string;
  let pidB: string;

  beforeEach(() => {
    const database = db();
    database.query("DELETE FROM knowledge WHERE embedding IS NOT NULL").run();
    database.query("DELETE FROM knowledge").run();
    pidA = ensureProject(PROJECT_A);
    pidB = ensureProject(PROJECT_B);
  });

  test("moves a single knowledge entry to a different project", () => {
    insertKnowledge(pidA, "k-reassign-1");

    const success = data.reassignKnowledge("k-reassign-1", PROJECT_B);

    expect(success).toBe(true);
    expect(countInProject("knowledge", pidA)).toBe(0);
    expect(countInProject("knowledge", pidB)).toBe(1);
  });

  test("returns false for non-existent entry", () => {
    const success = data.reassignKnowledge("non-existent-id", PROJECT_B);
    expect(success).toBe(false);
  });

  test("returns true when already in the target project (idempotent)", () => {
    insertKnowledge(pidA, "k-idempotent-1");
    const success = data.reassignKnowledge("k-idempotent-1", PROJECT_A);
    expect(success).toBe(true);
    expect(countInProject("knowledge", pidA)).toBe(1);
  });

  test("preserves cross_project flag", () => {
    insertKnowledge(pidA, "k-cross-1", { crossProject: true });

    data.reassignKnowledge("k-cross-1", PROJECT_B);

    const row = db()
      .query("SELECT cross_project FROM knowledge WHERE id = ?")
      .get("k-cross-1") as { cross_project: number };
    expect(row.cross_project).toBe(1);
  });

  test("clears cross_project when moving from global to project", () => {
    insertKnowledge("", "k-global-1", { crossProject: true });

    data.reassignKnowledge("k-global-1", PROJECT_A);

    const row = db()
      .query("SELECT cross_project, project_id FROM knowledge WHERE id = ?")
      .get("k-global-1") as {
      cross_project: number;
      project_id: string | null;
    };
    expect(row.cross_project).toBe(0);
    expect(row.project_id).toBe(pidA);
  });
});
