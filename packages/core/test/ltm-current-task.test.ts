import { expect, test, vi } from "vitest";
import { db, ensureProject } from "../src/db";
import * as embedding from "../src/embedding";
import * as ltm from "../src/ltm";

test("current task outranks stale observations and recent tool output", async () => {
  const projectPath = "/test/ltm/current-task";
  const projectID = ensureProject(projectPath);
  const sessionID = "current-task-session";
  const needed = ltm.create({
    projectPath,
    scope: "project",
    category: "gotcha",
    title: "Tenant credential routing",
    content:
      "Scope gateway credentials to the tenant before forwarding requests.",
  });
  const distractor = ltm.create({
    projectPath,
    scope: "project",
    category: "gotcha",
    title: "Chart palette colors",
    content: "Use blue for chart labels and yellow for palette badges.",
  });
  db()
    .query(
      `INSERT INTO distillations
         (id, project_id, session_id, narrative, facts, observations,
          source_ids, generation, token_count, archived, created_at)
       VALUES (?, ?, ?, '', '', ?, '', 0, 30, 0, ?)`,
    )
    .run(
      "current-task-old-distillation",
      projectID,
      sessionID,
      "Chart palette colors and chart labels were changed earlier.",
      Date.now() - 10_000,
    );
  db()
    .query(
      `INSERT INTO temporal_messages
         (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
       VALUES (?, ?, ?, 'user', ?, 40, 0, ?, ?)`,
    )
    .run(
      "current-task-tool-result",
      projectID,
      sessionID,
      "[tool:read] Chart palette colors and chart labels were changed earlier.",
      Date.now(),
      '{"tools":["read"]}',
    );

  const available = vi.spyOn(embedding, "isAvailable").mockReturnValue(false);
  try {
    const selected = await ltm.forSession(projectPath, sessionID, 65, {
      contextHint: "Fix tenant-scoped gateway credential routing on requests.",
      deferEffects: true,
    });
    expect(selected.map((entry) => entry.id)).toContain(needed);
    expect(selected.map((entry) => entry.id)).not.toContain(distractor);
  } finally {
    available.mockRestore();
  }
});

test("tool results never become the fallback task query", async () => {
  const projectPath = "/test/ltm/tool-result-task";
  const projectID = ensureProject(projectPath);
  const sessionID = "tool-result-task-session";
  const needed = ltm.create({
    projectPath,
    scope: "project",
    category: "gotcha",
    title: "Tenant credential routing",
    content:
      "Scope gateway credentials to the tenant before forwarding requests.",
  });
  const distractor = ltm.create({
    projectPath,
    scope: "project",
    category: "gotcha",
    title: "Chart palette colors",
    content: "Use blue for chart labels and yellow for palette badges.",
  });
  const insertMessage = db().query(
    `INSERT INTO temporal_messages
       (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
     VALUES (?, ?, ?, 'user', ?, 40, 0, ?, ?)`,
  );
  insertMessage.run(
    "tool-result-task-user",
    projectID,
    sessionID,
    "Fix tenant-scoped gateway credential routing on requests.",
    Date.now() - 1000,
    "{}",
  );
  insertMessage.run(
    "tool-result-task-tool",
    projectID,
    sessionID,
    "[tool:read] Chart palette colors and chart labels were changed earlier.",
    Date.now(),
    '{"tools":["read"]}',
  );

  const available = vi.spyOn(embedding, "isAvailable").mockReturnValue(false);
  try {
    const selected = await ltm.forSession(projectPath, sessionID, 65, {
      deferEffects: true,
    });
    expect(selected.map((entry) => entry.id)).toContain(needed);
    expect(selected.map((entry) => entry.id)).not.toContain(distractor);
  } finally {
    available.mockRestore();
  }
});
