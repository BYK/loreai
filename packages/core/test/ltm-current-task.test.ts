import { expect, test, vi } from "vitest";
import { db, ensureProject } from "../src/db";
import * as embedding from "../src/embedding";
import * as ltm from "../src/ltm";
import * as temporal from "../src/temporal";

test("a bare acknowledgment retains blanket-eligible knowledge", async () => {
  const projectPath = "/test/ltm/acknowledgment";
  const standing = ltm.create({
    projectPath,
    scope: "global",
    category: "gotcha",
    title: "Standing API rule",
    content: "Validate the project scope of each lookup.",
  });
  const available = vi.spyOn(embedding, "isAvailable").mockReturnValue(false);
  try {
    const blank = await ltm.forSession(projectPath, "ack-session", 200, {
      deferEffects: true,
    });
    const acknowledged = await ltm.forSession(projectPath, "ack-session", 200, {
      contextHint: "ok",
      deferEffects: true,
    });
    expect(blank.map((entry) => entry.id)).toContain(standing);
    expect(acknowledged.map((entry) => entry.id)).toContain(standing);
  } finally {
    available.mockRestore();
  }
});

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
    confidence: 0.5,
  });
  const distractor = ltm.create({
    projectPath,
    scope: "project",
    category: "gotcha",
    title: "Chart palette colors",
    content: "Use blue for chart labels and yellow for palette badges.",
    confidence: 0.95,
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
  for (const index of Array.from({ length: 12 }, (_, i) => i)) {
    insertMessage.run(
      `tool-result-task-tool-${index}`,
      projectID,
      sessionID,
      "[tool:read] Chart palette colors and chart labels were changed earlier.",
      Date.now() + index + 1,
      '{"tools":["read"]}',
    );
  }

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

test("a mixed user message keeps its task text while excluding its tool output", async () => {
  const projectPath = "/test/ltm/mixed-user-task";
  const sessionID = "mixed-user-task-session";
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
  temporal.store({
    projectPath,
    info: {
      id: "mixed-user-old",
      sessionID,
      role: "user",
      time: { created: Date.now() - 1_000 },
    },
    parts: [
      {
        id: "mixed-user-old-text",
        sessionID,
        messageID: "mixed-user-old",
        type: "text",
        text: "Change table spacing and row margins.",
      },
    ],
  });
  temporal.store({
    projectPath,
    info: {
      id: "mixed-user-new",
      sessionID,
      role: "user",
      time: { created: Date.now() },
    },
    parts: [
      {
        id: "mixed-user-new-text",
        sessionID,
        messageID: "mixed-user-new",
        type: "text",
        text: "Fix tenant-scoped gateway credential routing on requests.",
      },
      {
        id: "mixed-user-new-tool",
        sessionID,
        messageID: "mixed-user-new",
        type: "tool",
        tool: "read",
        callID: "mixed-user-call",
        state: {
          status: "completed",
          output: `${"x".repeat(8_192)}\n\x1f${"Fix chart palette colors and chart labels. ".repeat(20)}`,
        },
      },
    ],
  });

  const stored = db()
    .query(
      "SELECT metadata FROM temporal_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(sessionID) as { metadata: string };
  expect(JSON.parse(stored.metadata)).toMatchObject({
    taskText: "Fix tenant-scoped gateway credential routing on requests.",
  });
  expect(stored.metadata.length).toBeLessThan(1_024);
  const available = vi.spyOn(embedding, "isAvailable").mockReturnValue(false);
  try {
    const selected = await ltm.forSession(projectPath, sessionID, 40, {
      deferEffects: true,
    });
    expect(selected.map((entry) => entry.id)).toContain(needed);
    expect(selected.map((entry) => entry.id)).not.toContain(distractor);
  } finally {
    available.mockRestore();
  }
});
