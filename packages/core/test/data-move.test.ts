/**
 * Tests for moveSessions() and reassignKnowledge() in data.ts.
 *
 * Verifies that sessions can be moved between projects, carrying their
 * temporal_messages, distillations, tool_calls, session_state, and
 * source_session-linked knowledge entries.
 */
import { describe, test, expect, beforeEach } from "vitest";
import { db, ensureProject, saveSessionTracking } from "../src/db";
import * as data from "../src/data";

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
  projectId: string,
  id: string,
  opts?: { sourceSession?: string; crossProject?: boolean },
): void {
  db()
    .query(
      `INSERT INTO knowledge (id, project_id, category, title, content, source_session, cross_project, confidence, created_at, updated_at)
       VALUES (?, ?, 'pattern', 'Test Knowledge', 'test content', ?, ?, 0.8, ?, ?)`,
    )
    .run(
      id,
      projectId,
      opts?.sourceSession ?? null,
      opts?.crossProject ? 1 : 0,
      Date.now(),
      Date.now(),
    );
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
    database.query("DELETE FROM knowledge WHERE embedding IS NOT NULL").run();
    database.query("DELETE FROM knowledge").run();
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

  test("updates session_state project_path and provisional flag", () => {
    insertMessage(pidA, SESSION_1, "msg-ss-1");
    saveSessionTracking(SESSION_1, {
      projectPath: PROJECT_A,
      projectPathProvisional: true,
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

  test("expands child sessions by default via parent_session_id", () => {
    insertMessage(pidA, SESSION_1, "msg-parent-1");
    insertMessage(pidA, CHILD_SESSION, "msg-child-1");

    // Set up parent-child relationship
    saveSessionTracking(SESSION_1, { projectPath: PROJECT_A });
    saveSessionTracking(CHILD_SESSION, {
      projectPath: PROJECT_A,
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

    saveSessionTracking(SESSION_1, { projectPath: PROJECT_A });
    saveSessionTracking(CHILD_SESSION, {
      projectPath: PROJECT_A,
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
});
