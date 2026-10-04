/**
 * Tests for listProjects() `last_activity` (max of last temporal message
 * created_at and last knowledge_current updated_at) and the recency-first
 * ordering it introduces (#1918).
 */
import { describe, test, expect } from "vitest";
import { db, ensureProject } from "../src/db";
import { listProjects } from "../src/data";

function insertMessage(projectId: string, id: string, createdAt: number): void {
  db()
    .query(
      `INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
       VALUES (?, ?, 'last-activity-session', 'user', 'test content', 10, 0, ?, '{}')`,
    )
    .run(id, projectId, createdAt);
}

function insertKnowledge(
  projectId: string,
  id: string,
  updatedAt: number,
): void {
  db()
    .query(
      `INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at, logical_id)
       VALUES (?, ?, 'pattern', 'Test Knowledge', 'test content', ?, ?, ?)`,
    )
    .run(id, projectId, updatedAt, updatedAt, id);
}

describe("listProjects last_activity", () => {
  test("project with only messages gets last message created_at", () => {
    const path = `/test/last-activity/messages-only-${crypto.randomUUID()}`;
    const id = ensureProject(path);
    insertMessage(id, `m1-${id}`, 1_000);
    insertMessage(id, `m2-${id}`, 4_000);
    const project = listProjects().find((p) => p.id === id);
    expect(project?.last_activity).toBe(4_000);
  });

  test("newer knowledge updated_at wins over messages", () => {
    const path = `/test/last-activity/knowledge-newer-${crypto.randomUUID()}`;
    const id = ensureProject(path);
    insertMessage(id, `m1-${id}`, 2_000);
    insertKnowledge(id, `k1-${id}`, 9_000);
    const project = listProjects().find((p) => p.id === id);
    expect(project?.last_activity).toBe(9_000);
  });

  test("empty project gets null and sorts after active projects", () => {
    const activePath = `/test/last-activity/active-${crypto.randomUUID()}`;
    const emptyPath = `/test/last-activity/empty-${crypto.randomUUID()}`;
    const activeId = ensureProject(activePath);
    const emptyId = ensureProject(emptyPath);
    insertMessage(activeId, `m1-${activeId}`, 5_000);
    const projects = listProjects();
    const emptyIndex = projects.findIndex((p) => p.id === emptyId);
    const activeIndex = projects.findIndex((p) => p.id === activeId);
    expect(projects[emptyIndex]?.last_activity).toBeNull();
    expect(activeIndex).toBeLessThan(emptyIndex);
  });

  test("orders by last_activity desc regardless of project creation order", () => {
    // Adversarial order: the older-created project gets the newest activity.
    const olderPath = `/test/last-activity/older-${crypto.randomUUID()}`;
    const newerPath = `/test/last-activity/newer-${crypto.randomUUID()}`;
    const olderId = ensureProject(olderPath);
    // created_at is stamped inside ensureProject, so force a gap.
    db()
      .query("UPDATE projects SET created_at = ? WHERE id = ?")
      .run(1_000, olderId);
    const newerId = ensureProject(newerPath);
    db()
      .query("UPDATE projects SET created_at = ? WHERE id = ?")
      .run(9_000, newerId);
    insertMessage(olderId, `m1-${olderId}`, 8_000);
    insertMessage(newerId, `m1-${newerId}`, 2_000);
    const projects = listProjects();
    expect(projects.findIndex((p) => p.id === olderId)).toBeLessThan(
      projects.findIndex((p) => p.id === newerId),
    );
  });
});
