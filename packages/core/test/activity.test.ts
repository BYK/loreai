import { describe, expect, test } from "vitest";
import {
  ACTIVITY_LEGS,
  listActivity,
  type ActivityCursor,
} from "../src/activity";
import { ACTIVITY_KINDS, parseActivityQuery } from "../src/activity-query";
import { db, ensureProject } from "../src/db";
import {
  appendVersion,
  create,
  logicalIdOf,
  recordContradiction,
} from "../src/ltm";
import { currentTenantId, withTenant } from "../src/tenant";

const NOW = 1_700_000_000_000;

function createProject(name: string): { id: string; path: string } {
  const path = `/test/activity/${crypto.randomUUID()}`;
  const id = ensureProject(path);
  db().query("UPDATE projects SET name = ? WHERE id = ?").run(name, id);
  return { id, path };
}

function createEntry(
  path: string,
  title: string,
  content: string,
  origin: "curator" | "pattern" | "import" | "user" = "user",
): string {
  const versionId = create({
    projectPath: path,
    scope: "project",
    category: "pattern",
    title,
    content,
    origin,
  });
  return logicalIdOf(versionId);
}

function insertMessage(
  projectId: string,
  sessionId: string,
  content: string,
  createdAt: number,
  metadata: Record<string, unknown> = {},
): void {
  db()
    .query(
      `INSERT INTO temporal_messages
         (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
       VALUES (?, ?, ?, 'user', ?, 1, 0, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      projectId,
      sessionId,
      content,
      createdAt,
      JSON.stringify(metadata),
    );
}

function query(
  q: string,
  limit = 100,
  cursor: {
    t: number;
    k: (typeof ACTIVITY_KINDS)[number];
    id: string;
  } | null = null,
) {
  const parsed = parseActivityQuery(q);
  return listActivity({
    parsed,
    cursor,
    limit,
  });
}

describe("listActivity", () => {
  test("every append-only activity kind has exactly one registered leg", () => {
    expect(Object.keys(ACTIVITY_LEGS).sort()).toEqual(
      [...ACTIVITY_KINDS].sort(),
    );
    for (const kind of ACTIVITY_KINDS) {
      expect(ACTIVITY_LEGS[kind].kind).toBe(kind);
      expect(typeof ACTIVITY_LEGS[kind].select).toBe("function");
      expect(typeof ACTIVITY_LEGS[kind].hydrate).toBe("function");
    }
  });

  test("keyset pages through three-plus kinds with a shared timestamp without gaps", () => {
    const project = createProject("Activity Page Project");
    const first = createEntry(project.path, "Page entry one", "first", "user");
    const second = createEntry(
      project.path,
      "Page entry two",
      "second",
      "curator",
    );
    const sessionId = crypto.randomUUID();
    insertMessage(project.id, sessionId, "latest session content", NOW);
    db()
      .query(
        "UPDATE knowledge SET created_at = ?, updated_at = ? WHERE project_id = ?",
      )
      .run(NOW, NOW, project.id);
    db()
      .query(
        `UPDATE knowledge SET promotion_status = 'promoted', promoted_at = ?, updated_at = ?
         WHERE tenant_id = ? AND logical_id = ? AND is_current = 1`,
      )
      .run(NOW, NOW, currentTenantId(), first);
    expect(
      recordContradiction({
        logicalIdA: first,
        logicalIdB: second,
        projectId: project.id,
        similarity: 0.9,
        rationale: "A shared-time contradiction",
      }),
    ).toBe(true);
    db()
      .query(
        "UPDATE knowledge_contradictions SET updated_at = ? WHERE tenant_id = ?",
      )
      .run(NOW, currentTenantId());

    const q = `project:${project.id}`;
    const expected = query(q, 100).items;
    expect(expected.length).toBe(5);
    expect(new Set(expected.map((row) => row.last_activity_at))).toEqual(
      new Set([NOW]),
    );
    expect(new Set(expected.map((row) => row.kind))).toEqual(
      new Set(ACTIVITY_KINDS),
    );

    for (const limit of [1, 2, 3]) {
      const actual: typeof expected = [];
      let cursor: ActivityCursor | null = null;
      let pages = 0;
      do {
        const page = query(q, limit, cursor);
        actual.push(...page.items);
        cursor = page.next;
        pages++;
        expect(pages).toBeLessThanOrEqual(expected.length);
      } while (cursor);

      expect(actual.map(({ kind, id }) => `${kind}:${id}`)).toEqual(
        expected.map(({ kind, id }) => `${kind}:${id}`),
      );
      expect(
        new Set(
          actual.map(
            ({ kind, project_id, id }) => `${kind}:${project_id}:${id}`,
          ),
        ).size,
      ).toBe(expected.length);
    }
  });

  test("refreshes session metadata after activity data changes", () => {
    const project = createProject("Activity refresh project");
    insertMessage(project.id, "before-search", "an unrelated session", NOW);
    query("sqlite");

    insertMessage(
      project.id,
      "after-search",
      "SQLite gateway session",
      NOW + 1,
    );

    expect(
      query("sqlite").items.find(
        (item) => item.kind === "session" && item.id === "after-search",
      ),
    ).toMatchObject({
      title: "SQLite gateway session",
      last_activity_at: NOW + 1,
      total: 1,
    });
  });

  test("refreshes each project-filtered session scope independently", () => {
    const projectA = createProject("Activity refresh project A");
    const projectB = createProject("Activity refresh project B");
    insertMessage(projectA.id, "session-a", "SQLite project A session", NOW);
    insertMessage(projectB.id, "session-b", "SQLite project B session", NOW);

    expect(
      query(`project:${projectA.id} type:session sqlite`).items.map(
        ({ id }) => id,
      ),
    ).toEqual(["session-a"]);
    expect(
      query(`project:${projectB.id} type:session sqlite`).items.map(
        ({ id }) => id,
      ),
    ).toEqual(["session-b"]);
  });

  test("resolves project names and IDs, unions project tokens, and returns empty for misses", () => {
    const alpha = createProject("Alpha Workspace");
    const beta = createProject("Beta Workspace");
    const alphaEntry = createEntry(alpha.path, "Alpha knowledge", "alpha body");
    const betaEntry = createEntry(beta.path, "Beta knowledge", "beta body");

    expect(
      query('project:"alpha workspace" type:knowledge').items.map(
        (row) => row.id,
      ),
    ).toEqual([alphaEntry]);
    expect(
      query(`project:${beta.id} type:knowledge`).items.map((row) => row.id),
    ).toEqual([betaEntry]);
    expect(
      query(`project:"Alpha Workspace" project:${beta.id} type:knowledge`)
        .items.map((row) => row.id)
        .sort(),
    ).toEqual([alphaEntry, betaEntry].sort());
    expect(query('project:"no such project"').items).toEqual([]);
  });

  test("filters participants per kind and returns participants in registry order", () => {
    const project = createProject("Participant Project");
    const sessionId = crypto.randomUUID();
    insertMessage(project.id, sessionId, "agent-authored session", NOW, {
      agent: "codex",
    });
    const knowledgeId = createEntry(
      project.path,
      "Knowledge with origins",
      "knowledge body",
      "curator",
    );
    appendVersion(knowledgeId, {
      content: "revised knowledge body",
      origin: "pattern",
    });
    const otherKnowledgeId = createEntry(
      project.path,
      "Other knowledge",
      "other body",
      "import",
    );
    db()
      .query(
        `INSERT INTO knowledge_session_injections
           (session_id, logical_id, project_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(sessionId, knowledgeId, project.id, NOW);
    db()
      .query(
        `UPDATE knowledge SET promotion_status = 'promoted', promoted_at = ?
         WHERE tenant_id = ? AND logical_id = ? AND is_current = 1`,
      )
      .run(NOW, currentTenantId(), knowledgeId);
    expect(
      recordContradiction({
        logicalIdA: knowledgeId,
        logicalIdB: otherKnowledgeId,
        projectId: project.id,
        similarity: 0.8,
        rationale: "Conflict rationale",
      }),
    ).toBe(true);

    const session = query(`project:${project.id} type:session`).items[0];
    expect(session?.participants.map(({ id }) => id)).toEqual([
      "user",
      "codex",
      "lore",
    ]);
    expect(
      query(`project:${project.id} type:session with:codex`).items,
    ).toHaveLength(1);
    expect(
      query(`project:${project.id} type:session with:claude-code`).items,
    ).toHaveLength(0);
    expect(
      query(`project:${project.id} type:session with:lore`).items,
    ).toHaveLength(1);

    const knowledge = query(`project:${project.id} type:knowledge`).items;
    expect(
      knowledge
        .find((row) => row.id === knowledgeId)
        ?.participants.map(({ id }) => id),
    ).toEqual(["curator", "pattern"]);
    expect(
      query(`project:${project.id} type:knowledge with:curator`).items.map(
        (row) => row.id,
      ),
    ).toEqual([knowledgeId]);
    expect(
      query(`project:${project.id} type:knowledge with:pattern`).items.map(
        (row) => row.id,
      ),
    ).toEqual([knowledgeId]);
    expect(
      query(`project:${project.id} type:knowledge with:lore`).items,
    ).toHaveLength(0);

    const promotion = query(
      `project:${project.id} type:promotion with:lore`,
    ).items;
    expect(promotion).toHaveLength(1);
    expect(promotion[0]?.participants.map(({ id }) => id)).toEqual(["lore"]);
    const contradiction = query(
      `project:${project.id} type:contradiction with:lore`,
    ).items;
    expect(contradiction).toHaveLength(1);
    expect(contradiction[0]?.participants.map(({ id }) => id)).toEqual([
      "lore",
    ]);
  });

  test("sanitizes snippets and truncates at 160 Unicode characters", () => {
    const project = createProject("Snippet Project");
    const entryId = createEntry(
      project.path,
      "Sanitization sample",
      "placeholder",
    );
    const raw =
      "# Heading <b>bold</b> [link](https://example.test)\x1f\n> quoted\n- item \uD800 " +
      "x".repeat(180);
    db()
      .query(
        "UPDATE knowledge SET content = ? WHERE tenant_id = ? AND logical_id = ? AND is_current = 1",
      )
      .run(raw, currentTenantId(), entryId);

    const snippet = query(`project:${project.id} type:knowledge`).items[0]
      ?.snippet;
    const normalized = `Heading bold link quoted item \uFFFD ${"x".repeat(180)}`;
    expect(snippet).toBe(`${Array.from(normalized).slice(0, 159).join("")}…`);
    expect(Array.from(snippet ?? "")).toHaveLength(160);
    expect(snippet).not.toContain("<b>");
    expect(snippet).not.toContain("[link]");
  });

  test("appends a fuzzy tail after exact results and does not return a cursor", () => {
    const project = createProject("Fuzzy Activity Project");
    createEntry(
      project.path,
      "Exact result",
      "A note about Archtecture",
      "user",
    );
    createEntry(
      project.path,
      "Architecture guide",
      "A separate knowledge entry",
      "user",
    );

    const page = query(`project:${project.id} type:knowledge Archtecture`, 5);
    expect(page.items.map(({ match }) => match)).toEqual(["exact", "fuzzy"]);
    expect(page.items.map(({ title }) => title)).toEqual([
      "Exact result",
      "Architecture guide",
    ]);
    expect(page.next).toBeNull();
  });

  test("fuzzy tail matches multi-word title queries", () => {
    const project = createProject("Fuzzy Multiword Project");
    createEntry(
      project.path,
      "SQLite Gateway guide",
      "A note about the local database",
      "user",
    );

    const single = query(`project:${project.id} type:knowledge sqlte`, 5);
    expect(
      single.items.map(({ title, match }) => [title, match]),
    ).toContainEqual(["SQLite Gateway guide", "fuzzy"]);

    const multi = query(`project:${project.id} type:knowledge sqlte gatewy`, 5);
    expect(
      multi.items.map(({ title, match }) => [title, match]),
    ).toContainEqual(["SQLite Gateway guide", "fuzzy"]);
    expect(multi.next).toBeNull();
  });

  test("tenant-scopes session activity and title refresh", () => {
    const tenantA = "activity-session-tenant-a";
    const tenantB = "activity-session-tenant-b";
    const projectA = withTenant(tenantA, () =>
      createProject("Tenant A Activity"),
    );
    const projectB = withTenant(tenantB, () =>
      createProject("Tenant B Activity"),
    );
    const sessionA = crypto.randomUUID();
    const sessionB = crypto.randomUUID();
    withTenant(tenantA, () =>
      insertMessage(projectA.id, sessionA, "shared needle", NOW),
    );
    withTenant(tenantB, () =>
      insertMessage(projectB.id, sessionB, "shared needle", NOW),
    );

    const tenantBPage = withTenant(tenantB, () =>
      query("type:session shared needle"),
    );
    expect(tenantBPage.items.map(({ id }) => id)).toEqual([sessionB]);
    expect(
      withTenant(tenantB, () =>
        db()
          .query(
            "SELECT 1 FROM session_meta WHERE project_id = ? AND session_id = ?",
          )
          .get(projectA.id, sessionA),
      ),
    ).toBeNull();

    expect(
      withTenant(tenantA, () =>
        query("type:session shared needle").items.map(({ id }) => id),
      ),
    ).toEqual([sessionA]);
  });
});
