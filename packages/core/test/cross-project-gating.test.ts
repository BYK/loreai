import { describe, test, expect, beforeEach } from "vitest";
import { uuidv7 } from "uuidv7";
import { db, ensureProject } from "../src/db";
import * as ltm from "../src/ltm";

// Two unrelated real projects. PROJ_A owns a cross-project-marked entry; we
// assert it does NOT leak into PROJ_B's injected context unless it is actually
// relevant to PROJ_B's session.
const PROJ_A = "/test/xproj/project-a";
const PROJ_B = "/test/xproj/project-b";

const TITLE_PREFIX = "XPROJGATE_";

function cleanup() {
  db().query(`DELETE FROM knowledge WHERE title LIKE '${TITLE_PREFIX}%'`).run();
  db()
    .query(
      "DELETE FROM knowledge WHERE project_id IN (SELECT id FROM projects WHERE path LIKE '/test/xproj/%')",
    )
    .run();
}

describe("forSession cross-project gating", () => {
  beforeEach(cleanup);

  test("preference fast path: foreign cross-project pref is NOT blanket-injected", async () => {
    // Own project preference (project-scoped) — always injected.
    ltm.create({
      id: uuidv7(),
      projectPath: PROJ_B,
      category: "preference",
      title: `${TITLE_PREFIX}own_pref`,
      content: "In project B, always run the local lint script before commit",
      scope: "project",
      crossProject: false,
      confidence: 1.0,
      session: "s",
    });
    // True global (user-level) preference — applies everywhere.
    ltm.create({
      id: uuidv7(),
      category: "preference",
      title: `${TITLE_PREFIX}global_pref`,
      content: "Never add emojis to files unless explicitly asked",
      scope: "global",
      confidence: 1.0,
      session: "s",
    });
    // Own cross-project-marked preference (PROJ_B, cross_project=1) — still
    // belongs to this project so it must inject via the "own" classification.
    ltm.create({
      id: uuidv7(),
      projectPath: PROJ_B,
      category: "preference",
      title: `${TITLE_PREFIX}own_cross_pref`,
      content: "In project B, prefer pnpm over npm for installs",
      scope: "project",
      crossProject: true,
      confidence: 1.0,
      session: "s",
    });
    // Foreign project's cross-project-marked preference — must NOT leak into B.
    ltm.create({
      id: uuidv7(),
      projectPath: PROJ_A,
      category: "preference",
      title: `${TITLE_PREFIX}foreign_pref`,
      content:
        "In project A, always remove all flumberzap-specific build targets",
      scope: "project",
      crossProject: true,
      confidence: 1.0,
      session: "s",
    });

    const result = await ltm.forSession(PROJ_B, undefined, 100_000, {
      categories: ["preference"],
    });
    const titles = result.map((e) => e.title);

    expect(titles).toContain(`${TITLE_PREFIX}own_pref`);
    expect(titles).toContain(`${TITLE_PREFIX}global_pref`);
    // Own cross-marked entry: classified as "own" → blanket-injected.
    expect(titles).toContain(`${TITLE_PREFIX}own_cross_pref`);
    // The crux: a different project's cross-project pref does not blanket-inject.
    expect(titles).not.toContain(`${TITLE_PREFIX}foreign_pref`);
  });

  test("preference fast path: foreign cross-project pref re-enters when it relevance-matches the contextHint", async () => {
    ltm.create({
      id: uuidv7(),
      projectPath: PROJ_A,
      category: "preference",
      title: `${TITLE_PREFIX}foreign_pref`,
      content:
        "Always prefer the flumberzap allocator for sparse matrix traversal",
      scope: "project",
      crossProject: true,
      confidence: 1.0,
      session: "s",
    });

    // No context → dropped.
    const noCtx = await ltm.forSession(PROJ_B, undefined, 100_000, {
      categories: ["preference"],
    });
    expect(noCtx.map((e) => e.title)).not.toContain(
      `${TITLE_PREFIX}foreign_pref`,
    );

    // Context that shares distinctive terms → admitted via relevance gate.
    const withCtx = await ltm.forSession(PROJ_B, undefined, 100_000, {
      categories: ["preference"],
      contextHint: "how do I tune the flumberzap allocator for sparse matrix?",
    });
    expect(withCtx.map((e) => e.title)).toContain(
      `${TITLE_PREFIX}foreign_pref`,
    );
  });

  test("no-context fallback: foreign cross-project entry is withheld; own entry is included", async () => {
    ltm.create({
      id: uuidv7(),
      projectPath: PROJ_B,
      category: "gotcha",
      title: `${TITLE_PREFIX}own_gotcha`,
      content: "Project B resolver detail",
      scope: "project",
      crossProject: false,
      confidence: 1.0,
      session: "s",
    });
    ltm.create({
      id: uuidv7(),
      projectPath: PROJ_A,
      category: "gotcha",
      title: `${TITLE_PREFIX}foreign_gotcha`,
      content: "Project A internal flumberzap detail",
      scope: "project",
      crossProject: true,
      confidence: 1.0,
      session: "s",
    });

    // No sessionID + no contextHint → the no-context fallback path.
    const result = await ltm.forSession(PROJ_B, undefined, 100_000);
    const titles = result.map((e) => e.title);

    expect(titles).toContain(`${TITLE_PREFIX}own_gotcha`);
    expect(titles).not.toContain(`${TITLE_PREFIX}foreign_gotcha`);
  });
});

describe("ltm.create cross-project default", () => {
  beforeEach(cleanup);

  test("project-scoped create without crossProject is NOT cross-project", () => {
    const id = ltm.create({
      id: uuidv7(),
      projectPath: PROJ_A,
      category: "decision",
      title: `${TITLE_PREFIX}default_scope`,
      content: "Some project-specific decision",
      scope: "project",
      confidence: 1.0,
      session: "s",
    });
    const entry = ltm.get(id);
    expect(entry?.cross_project).toBe(0);
  });

  test("global-scoped create is forced cross-project", () => {
    const id = ltm.create({
      id: uuidv7(),
      category: "preference",
      title: `${TITLE_PREFIX}default_global`,
      content: "A universal user preference",
      scope: "global",
      confidence: 1.0,
      session: "s",
    });
    const entry = ltm.get(id);
    expect(entry?.cross_project).toBe(1);
    expect(entry?.project_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Migration v38: demote over-eagerly cross-marked rows.
//
// The migration runs once at DB init, so we validate the EXACT conservative
// UPDATE the migration applies (keep this SQL in sync with MIGRATIONS v38 in
// db.ts) against seeded rows representing each case.
// ---------------------------------------------------------------------------
describe("migration v38 demotion semantics", () => {
  beforeEach(cleanup);

  // Same WHERE clause as MIGRATIONS v38 in db.ts, plus a title-prefix filter
  // so it never mutates other suites' rows in the shared test DB. The
  // updated_at assignment mirrors the real migration for fidelity.
  const DEMOTION_SQL = `
    UPDATE knowledge
       SET cross_project = 0,
           updated_at = (CAST(strftime('%s','now') AS INTEGER) * 1000)
     WHERE cross_project = 1
       AND project_id IS NOT NULL
       AND promotion_status IS NULL
       AND title LIKE '${TITLE_PREFIX}%'`;

  test("demotes curator-default rows, preserves promoted + global", () => {
    const pidA = ensureProject(PROJ_A);

    // (1) curator-default cross-marked project row → SHOULD be demoted.
    const curatorId = uuidv7();
    db()
      .query(
        `INSERT INTO knowledge (id, project_id, category, title, content, cross_project, confidence, created_at, updated_at, promotion_status, approval_status)
         VALUES (?, ?, 'gotcha', ?, 'x', 1, 1.0, 0, 0, NULL, 'auto')`,
      )
      .run(curatorId, pidA, `${TITLE_PREFIX}curator_default`);

    // (2) auto-promoted row (earned cross-project) → SHOULD be preserved.
    const promotedId = uuidv7();
    db()
      .query(
        `INSERT INTO knowledge (id, project_id, category, title, content, cross_project, confidence, created_at, updated_at, promotion_status, approval_status)
         VALUES (?, ?, 'gotcha', ?, 'x', 1, 1.0, 0, 0, 'promoted', 'auto')`,
      )
      .run(promotedId, pidA, `${TITLE_PREFIX}promoted`);

    // (3) true global (project_id NULL) → SHOULD be preserved.
    const globalId = uuidv7();
    db()
      .query(
        `INSERT INTO knowledge (id, project_id, category, title, content, cross_project, confidence, created_at, updated_at, promotion_status, approval_status)
         VALUES (?, NULL, 'preference', ?, 'x', 1, 1.0, 0, 0, NULL, 'auto')`,
      )
      .run(globalId, `${TITLE_PREFIX}global`);

    db().query(DEMOTION_SQL).run();

    const read = (id: string) =>
      (
        db()
          .query("SELECT cross_project FROM knowledge WHERE id = ?")
          .get(id) as { cross_project: number } | undefined
      )?.cross_project;

    expect(read(curatorId)).toBe(0); // demoted
    expect(read(promotedId)).toBe(1); // preserved
    expect(read(globalId)).toBe(1); // preserved
  });
});
