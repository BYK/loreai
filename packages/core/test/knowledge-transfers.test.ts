import { describe, test, expect, beforeEach } from "bun:test";
import { uuidv7 } from "uuidv7";
import { db, ensureProject } from "../src/db";
import * as ltm from "../src/ltm";
import * as data from "../src/data";
import { runRecall } from "../src/recall";

// Origin project of the promoted entry, and a DIFFERENT project where it is
// recalled/surfaced (the "foreign" project).
const ORIGIN = "/test/transfers/origin";
const FOREIGN = "/test/transfers/foreign";
const FOREIGN_SESSION = "transfers-session-1";

function cleanup() {
  // Remove all knowledge + transfers belonging to the test projects.
  db()
    .query(
      "DELETE FROM knowledge_transfers WHERE knowledge_id IN (SELECT id FROM knowledge WHERE project_id IN (SELECT id FROM projects WHERE path LIKE '/test/transfers/%')) OR recalled_in_project_id IN (SELECT id FROM projects WHERE path LIKE '/test/transfers/%')",
    )
    .run();
  db()
    .query(
      "DELETE FROM knowledge WHERE project_id IN (SELECT id FROM projects WHERE path LIKE '/test/transfers/%')",
    )
    .run();
  db()
    .query(
      "DELETE FROM temporal_messages WHERE project_id IN (SELECT id FROM projects WHERE path LIKE '/test/transfers/%')",
    )
    .run();
  db()
    .query(
      "DELETE FROM distillations WHERE project_id IN (SELECT id FROM projects WHERE path LIKE '/test/transfers/%')",
    )
    .run();
  ltm.__resetTransferDedup();
}

/** Create a promoted (cross_project=1) entry that retains its origin project. */
function createPromoted(title: string, content: string): string {
  return ltm.create({
    id: uuidv7(),
    projectPath: ORIGIN,
    category: "gotcha",
    title,
    content,
    scope: "project",
    crossProject: true,
    session: "origin-session",
  });
}

/** Seed session context in the FOREIGN project so relevance scoring matches. */
function seedForeignContext(text: string) {
  const pid = ensureProject(FOREIGN);
  db()
    .query(
      "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, 0, ?, '{}')",
    )
    .run(uuidv7(), pid, FOREIGN_SESSION, "user", text, 20, Date.now());
}

describe("knowledge_transfers migration", () => {
  test("table exists with expected columns", () => {
    const row = db()
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_transfers'",
      )
      .get() as { name: string } | null;
    expect(row?.name).toBe("knowledge_transfers");

    const cols = (
      db().query("PRAGMA table_info(knowledge_transfers)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(cols).toContain("knowledge_id");
    expect(cols).toContain("recalled_in_project_id");
    expect(cols).toContain("hit_count");
    expect(cols).toContain("first_recalled_at");
    expect(cols).toContain("last_recalled_at");
  });
});

describe("ltm.recordTransfer / read helpers", () => {
  beforeEach(cleanup);

  test("first record inserts hit_count=1; second upserts to 2", () => {
    const id = createPromoted("Upsert entry", "content about widgets");
    const fpid = ensureProject(FOREIGN);

    ltm.recordTransfer({ knowledgeId: id, recalledInProjectId: fpid });
    let breakdown = ltm.transfersFor(id);
    expect(breakdown.length).toBe(1);
    expect(breakdown[0]!.hit_count).toBe(1);
    const firstAt = breakdown[0]!.first_recalled_at;

    ltm.recordTransfer({ knowledgeId: id, recalledInProjectId: fpid });
    breakdown = ltm.transfersFor(id);
    expect(breakdown.length).toBe(1);
    expect(breakdown[0]!.hit_count).toBe(2);
    // first_recalled_at is set once and preserved.
    expect(breakdown[0]!.first_recalled_at).toBe(firstAt);
    expect(breakdown[0]!.last_recalled_at).toBeGreaterThanOrEqual(firstAt);
  });

  test("transferCount = distinct foreign projects", () => {
    const id = createPromoted("Multi-project entry", "shared content");
    const f1 = ensureProject(FOREIGN);
    const f2 = ensureProject("/test/transfers/foreign-2");

    ltm.recordTransfer({ knowledgeId: id, recalledInProjectId: f1 });
    ltm.recordTransfer({ knowledgeId: id, recalledInProjectId: f1 }); // same project
    ltm.recordTransfer({ knowledgeId: id, recalledInProjectId: f2 });

    expect(ltm.transferCount(id)).toBe(2); // two distinct projects, not 3 hits
  });

  test("transferCounts batch map matches per-entry counts", () => {
    const a = createPromoted("Entry A", "alpha");
    const b = createPromoted("Entry B", "beta");
    const fpid = ensureProject(FOREIGN);
    ltm.recordTransfer({ knowledgeId: a, recalledInProjectId: fpid });

    const counts = ltm.transferCounts();
    expect(counts.get(a)).toBe(1);
    expect(counts.get(b) ?? 0).toBe(0);
  });

  test("empty recalled-in id is a no-op", () => {
    const id = createPromoted("No-op entry", "gamma");
    ltm.recordTransfer({ knowledgeId: id, recalledInProjectId: "" });
    expect(ltm.transferCount(id)).toBe(0);
  });
});

describe("forSession transfer recording", () => {
  beforeEach(cleanup);

  test("records a promoted foreign entry recalled in another project", async () => {
    createPromoted(
      "Caching layer decision",
      "Use an LRU cache for the resolver hot path",
    );
    seedForeignContext("How should I add a cache to the resolver hot path?");

    const fpid = ensureProject(FOREIGN);
    const result = await ltm.forSession(FOREIGN, FOREIGN_SESSION, 10_000);
    // Sanity: the promoted entry surfaced in the foreign project.
    const surfaced = result.find((e) => e.title === "Caching layer decision");
    expect(surfaced).toBeDefined();
    expect(surfaced!.cross_project).toBe(1);
    expect(surfaced!.project_id).not.toBe(fpid);

    expect(ltm.transferCount(surfaced!.id)).toBe(1);
  });

  test("throttle: second forSession within window does not double-count", async () => {
    createPromoted(
      "Retry backoff policy",
      "Honor Retry-After and cap exponential backoff",
    );
    seedForeignContext("What retry backoff policy should the client honor?");

    await ltm.forSession(FOREIGN, FOREIGN_SESSION, 10_000);
    await ltm.forSession(FOREIGN, FOREIGN_SESSION, 10_000);

    const counts = ltm.transferCounts();
    // At most 1 hit for any entry despite two forSession calls.
    for (const c of counts.values()) expect(c).toBeLessThanOrEqual(1);
  });

  test("does NOT record self-project entries", async () => {
    // A promoted entry whose origin IS the project it's recalled in.
    const id = ltm.create({
      id: uuidv7(),
      projectPath: FOREIGN,
      category: "gotcha",
      title: "Self project entry",
      content: "Local resolver detail for this very project",
      scope: "project",
      crossProject: true,
      session: "s",
    });
    seedForeignContext("Tell me about the local resolver detail");

    await ltm.forSession(FOREIGN, FOREIGN_SESSION, 10_000);
    expect(ltm.transferCount(id)).toBe(0);
  });
});

describe("runRecall transfer gating", () => {
  beforeEach(cleanup);

  test("records cross-project hits only when recordTransfers is set", async () => {
    const id = createPromoted(
      "Zigzag indexing trick",
      "Zigzag indexing trick for sparse matrix traversal",
    );
    const fpid = ensureProject(FOREIGN);

    // Without recordTransfers → nothing recorded.
    await runRecall({
      query: "zigzag indexing sparse matrix",
      scope: "all",
      projectPath: FOREIGN,
      sessionID: FOREIGN_SESSION,
      knowledgeEnabled: true,
    });
    expect(ltm.transferCount(id)).toBe(0);

    // With recordTransfers → the foreign promoted entry is counted.
    await runRecall({
      query: "zigzag indexing sparse matrix",
      scope: "all",
      projectPath: FOREIGN,
      sessionID: FOREIGN_SESSION,
      knowledgeEnabled: true,
      recordTransfers: true,
    });
    expect(ltm.transferCount(id)).toBeGreaterThanOrEqual(1);
    const breakdown = ltm.transfersFor(id);
    expect(breakdown[0]!.recalled_in_project_id).toBe(fpid);
  });

  test("recallById never records", async () => {
    const id = createPromoted("ById entry", "content for id lookup");
    await runRecall({
      query: "",
      id: `xk:${id}`,
      projectPath: FOREIGN,
      knowledgeEnabled: true,
      recordTransfers: true,
    });
    expect(ltm.transferCount(id)).toBe(0);
  });
});

describe("transfer cleanup on project deletion", () => {
  beforeEach(cleanup);

  test("clearProject removes rows for both project columns", () => {
    const id = createPromoted("Cleanup entry", "to be cleared");
    const fpid = ensureProject(FOREIGN);
    ltm.recordTransfer({ knowledgeId: id, recalledInProjectId: fpid });
    expect(ltm.transferCount(id)).toBe(1);

    // Clearing the FOREIGN (recalled-in) project drops the transfer row.
    data.clearProject(FOREIGN);
    expect(ltm.transferCount(id)).toBe(0);
  });

  test("clearProject of origin project also drops its transfer rows", () => {
    const id = createPromoted("Origin cleanup entry", "origin side");
    const fpid = ensureProject(FOREIGN);
    ltm.recordTransfer({ knowledgeId: id, recalledInProjectId: fpid });
    expect(ltm.transferCount(id)).toBe(1);

    data.clearProject(ORIGIN);
    // The origin knowledge row is gone, so its transfers are gone too.
    const remaining = db()
      .query(
        "SELECT COUNT(*) as c FROM knowledge_transfers WHERE knowledge_id = ?",
      )
      .get(id) as { c: number };
    expect(remaining.c).toBe(0);
  });
});
