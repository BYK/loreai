import { describe, expect, test } from "vitest";
import { db } from "../src/db";
import {
  create,
  forProject,
  get,
  getByLogical,
  hydrateKnowledgeEntry,
  logicalIdOf,
  remove,
  searchScored,
  searchScoredOtherProjects,
  update,
  type KnowledgeMetadata,
} from "../src/ltm";

// Per-test project paths give isolation without resetting the shared test DB
// (vitest setup file owns the DB lifecycle — see packages/core/test/setup.ts).
let projectCounter = 0;
const nextProject = () =>
  `/test/ltm-metadata/proj-${++projectCounter}-${Date.now()}`;

describe("KnowledgeEntry metadata round-trip (#627 Phase 1)", () => {
  test("create() persists metadata → read back returns parsed object", () => {
    const projectPath = nextProject();
    const meta: KnowledgeMetadata = { gitHead: "abc1234deadbeef" };
    create({
      projectPath,
      category: "decision",
      title: "Use a custom DB index",
      content: "db.ts:100: trade-off rationale",
      scope: "project",
      metadata: meta,
    });
    const got = forProject(projectPath, false).find(
      (e) => e.title === "Use a custom DB index",
    );
    expect(got?.metadata).toEqual(meta);
  });

  test("create() with no metadata → read back returns null (no regression)", () => {
    const projectPath = nextProject();
    create({
      projectPath,
      category: "decision",
      title: "Pre-Phase-1 entry",
      content: "no metadata was set",
      scope: "project",
    });
    const got = forProject(projectPath, false).find(
      (e) => e.title === "Pre-Phase-1 entry",
    );
    expect(got?.metadata).toBeNull();
  });

  test("create() with empty metadata object → NULL column (no junk rows)", () => {
    const projectPath = nextProject();
    create({
      projectPath,
      category: "decision",
      title: "Empty metadata opts out",
      content: "explicit empty object",
      scope: "project",
      metadata: {},
    });
    const got = forProject(projectPath, false).find(
      (e) => e.title === "Empty metadata opts out",
    );
    expect(got?.metadata).toBeNull();
  });

  test("hydrated metadata survives forSession() (read path hydration)", () => {
    const projectPath = nextProject();
    const meta: KnowledgeMetadata = { gitHead: "abc1234" };
    create({
      projectPath,
      category: "decision",
      title: "Hydrated through forSession",
      content: "x",
      scope: "project",
      metadata: meta,
    });
    const entries = forProject(projectPath, false);
    expect(
      entries.find((e) => e.title === "Hydrated through forSession")?.metadata,
    ).toEqual(meta);
  });

  test("hydrateKnowledgeEntry parses raw JSON rows", () => {
    const raw = {
      id: "abc",
      project_id: "p",
      metadata: '{"gitHead":"deadbeef1234567"}',
      category: "x",
      title: "t",
      content: "c",
      source_session: null,
      cross_project: 0,
      confidence: 1.0,
      created_at: 0,
      updated_at: 0,
      created_by: null,
      updated_by: null,
      sensitivity: "normal" as const,
      promotion_status: null,
      promoted_at: null,
      approval_status: "auto" as const,
      approved_by: null,
      approved_at: null,
      source_user_id: null,
      source_entry_id: null,
      last_accessed_at: null,
      worker_provider_id: null,
      worker_model_id: null,
      last_reinforced_at: null,
      logical_id: "abc",
    };
    const out = hydrateKnowledgeEntry(raw);
    expect(out.metadata).toEqual({ gitHead: "deadbeef1234567" });
  });

  test("hydrateKnowledgeEntry drops malformed JSON gracefully", () => {
    const raw = {
      id: "x",
      metadata: "not-json{",
      project_id: null,
      category: "x",
      title: "t",
      content: "c",
      source_session: null,
      cross_project: 0,
      confidence: 1.0,
      created_at: 0,
      updated_at: 0,
      created_by: null,
      updated_by: null,
      sensitivity: "normal" as const,
      promotion_status: null,
      promoted_at: null,
      approval_status: "auto" as const,
      approved_by: null,
      approved_at: null,
      source_user_id: null,
      source_entry_id: null,
      last_accessed_at: null,
      worker_provider_id: null,
      worker_model_id: null,
      last_reinforced_at: null,
      logical_id: "x",
    };
    const out = hydrateKnowledgeEntry(raw);
    expect(out.metadata).toBeNull(); // not a throw — slot, not a constraint
  });

  test("hydrateKnowledgeEntry returns null for null metadata column", () => {
    const raw = {
      id: "x",
      metadata: null,
      project_id: null,
      category: "x",
      title: "t",
      content: "c",
      source_session: null,
      cross_project: 0,
      confidence: 1.0,
      created_at: 0,
      updated_at: 0,
      created_by: null,
      updated_by: null,
      sensitivity: "normal" as const,
      promotion_status: null,
      promoted_at: null,
      approval_status: "auto" as const,
      approved_by: null,
      approved_at: null,
      source_user_id: null,
      source_entry_id: null,
      last_accessed_at: null,
      worker_provider_id: null,
      worker_model_id: null,
      last_reinforced_at: null,
      logical_id: "x",
    };
    expect(hydrateKnowledgeEntry(raw).metadata).toBeNull();
  });
});

describe("KnowledgeEntry.metadata column-level guarantees (#627 Phase 1)", () => {
  test("garbage in metadata column never crashes the read path", () => {
    // Write a row directly via SQL with a malformed metadata blob (simulates
    // a hand-edited .lore.md or pre-Phase-1 corruption). The hydration layer
    // must NOT throw — metadata is a slot, not a constraint.
    const projectPath = nextProject();
    const id = create({
      projectPath,
      category: "decision",
      title: "Garbage write",
      content: "x",
      scope: "project",
      metadata: { gitHead: "abc" },
    });
    // Directly corrupt the column.
    db()
      .query("UPDATE knowledge SET metadata = ? WHERE id = ?")
      .run("not-json{", id);
    // Read back — must not throw.
    const got = forProject(projectPath, false).find(
      (e) => e.title === "Garbage write",
    );
    expect(got).toBeDefined();
    expect(got!.metadata).toBeNull(); // graceful drop, not a crash
  });

  test("gitHead survives project retrieval (the most-read path)", () => {
    const projectPath = nextProject();
    create({
      projectPath,
      category: "gotcha",
      title: "Gotcha with gitHead",
      content: "x",
      scope: "project",
      metadata: { gitHead: "f00dface" },
    });
    const rows = forProject(projectPath, false);
    const got = rows.find((r) => r.title === "Gotcha with gitHead");
    expect(got?.metadata?.gitHead).toBe("f00dface");
  });
});

describe("single-row getters hydrate metadata (Seer #14858326, #627 Phase 1)", () => {
  test("get(id) returns a PARSED metadata object, not a raw JSON string", () => {
    const projectPath = nextProject();
    const id = create({
      projectPath,
      category: "decision",
      title: "Single-row get hydration",
      content: "x",
      scope: "project",
      metadata: { gitHead: "cafe1234beef" },
    });
    const got = get(id);
    expect(got).not.toBeNull();
    // The bug: get() used to return `metadata` as the raw string
    // '{"gitHead":"cafe1234beef"}'. Assert it's a structured object.
    expect(typeof got!.metadata).toBe("object");
    expect(got!.metadata).toEqual({ gitHead: "cafe1234beef" });
    expect(got!.metadata?.gitHead).toBe("cafe1234beef");
  });

  test("get(id) returns null metadata for a no-metadata entry", () => {
    const projectPath = nextProject();
    const id = create({
      projectPath,
      category: "decision",
      title: "Single-row get no metadata",
      content: "x",
      scope: "project",
    });
    expect(get(id)?.metadata).toBeNull();
  });

  test("get(id) drops malformed metadata without throwing", () => {
    const projectPath = nextProject();
    const id = create({
      projectPath,
      category: "decision",
      title: "Single-row get garbage",
      content: "x",
      scope: "project",
      metadata: { gitHead: "abc" },
    });
    db()
      .query("UPDATE knowledge SET metadata = ? WHERE id = ?")
      .run("not-json{", id);
    expect(() => get(id)).not.toThrow();
    expect(get(id)?.metadata).toBeNull();
  });

  test("get() returns null for a missing id (no crash on null row)", () => {
    expect(get("nonexistent-id")).toBeNull();
  });

  test("getByLogical(logicalId) returns a PARSED metadata object", () => {
    const projectPath = nextProject();
    const id = create({
      projectPath,
      category: "decision",
      title: "getByLogical hydration",
      content: "x",
      scope: "project",
      metadata: { gitHead: "deadbeef9999" },
    });
    const logicalId = logicalIdOf(id);
    const got = getByLogical(logicalId);
    expect(got).not.toBeNull();
    expect(typeof got!.metadata).toBe("object");
    expect(got!.metadata).toEqual({ gitHead: "deadbeef9999" });
  });

  test("getByLogical() returns null for a missing logical id", () => {
    expect(getByLogical("nonexistent-logical-id")).toBeNull();
  });
});

describe("scored search hydrates metadata (Seer #14860239, #627 Phase 1)", () => {
  test("searchScored returns parsed metadata objects", async () => {
    const projectPath = nextProject();
    create({
      projectPath,
      category: "decision",
      title: "Zircon storage engine choice",
      content: "we picked the zircon engine for durability",
      scope: "project",
      metadata: { gitHead: "5cored1234beef" },
    });
    const results = await searchScored({ query: "zircon", projectPath });
    const hit = results.find((r) => r.title === "Zircon storage engine choice");
    expect(hit).toBeDefined();
    // The bug: raw FTS rows left metadata as a JSON string.
    expect(typeof hit!.metadata).toBe("object");
    expect(hit!.metadata).toEqual({ gitHead: "5cored1234beef" });
    // The extra FTS `rank` column survives hydration (spread preserves it).
    expect(typeof hit!.rank).toBe("number");
  });

  test("searchScoredOtherProjects returns parsed metadata objects", async () => {
    const ownerProject = nextProject();
    const otherProject = nextProject();
    create({
      projectPath: ownerProject,
      category: "decision",
      title: "Quokka deployment runbook",
      content: "the quokka rollout uses blue-green",
      scope: "project",
      metadata: { gitHead: "0ther9999cafe" },
    });
    // Search from a DIFFERENT project so the owner project's entry surfaces as
    // a cross-project ("tunnel") result.
    const results = await searchScoredOtherProjects({
      query: "quokka",
      excludeProjectPath: otherProject,
    });
    const hit = results.find((r) => r.title === "Quokka deployment runbook");
    expect(hit).toBeDefined();
    expect(typeof hit!.metadata).toBe("object");
    expect(hit!.metadata).toEqual({ gitHead: "0ther9999cafe" });
  });
});

describe("update()/remove() refresh metadata on new versions (#627 Phase 2)", () => {
  // Helper: read the metadata column straight off the current base-table row
  // (including is_deleted death certs, which knowledge_current hides).
  const rawCurrentMetadata = (logicalId: string): string | null => {
    const row = db()
      .query(
        "SELECT metadata FROM knowledge WHERE logical_id = ? AND is_current = 1 LIMIT 1",
      )
      .get(logicalId) as { metadata: string | null } | undefined;
    return row ? row.metadata : null;
  };

  test("content-changing update stamps the new version with fresh gitHead", () => {
    const projectPath = nextProject();
    const id = create({
      projectPath,
      category: "decision",
      title: "Index strategy",
      content: "original content at commit A",
      scope: "project",
      metadata: { gitHead: "aaaaaaa" },
    });
    update(id, {
      content: "revised content at commit B",
      metadata: { gitHead: "bbbbbbb" },
    });
    const after = getByLogical(logicalIdOf(id));
    expect(after?.content).toBe("revised content at commit B");
    // The bug (Phase 1): appendVersion forward-copied the mint-time gitHead.
    expect(after?.metadata).toEqual({ gitHead: "bbbbbbb" });
  });

  test("content-changing update with NO metadata forward-copies prior gitHead", () => {
    const projectPath = nextProject();
    const id = create({
      projectPath,
      category: "decision",
      title: "Forward-copy entry",
      content: "v1 content",
      scope: "project",
      metadata: { gitHead: "ccccccc" },
    });
    // No metadata supplied (e.g. a CLI/.lore.md caller with no session gitHead).
    update(id, { content: "v2 content" });
    const after = getByLogical(logicalIdOf(id));
    expect(after?.content).toBe("v2 content");
    expect(after?.metadata).toEqual({ gitHead: "ccccccc" });
  });

  test("content-changing update with empty metadata forward-copies (never wipes)", () => {
    const projectPath = nextProject();
    const id = create({
      projectPath,
      category: "decision",
      title: "Empty-meta entry",
      content: "v1 content",
      scope: "project",
      metadata: { gitHead: "ddddddd" },
    });
    // An empty session metadata must not erase a previously-recorded gitHead.
    update(id, { content: "v2 content", metadata: {} });
    const after = getByLogical(logicalIdOf(id));
    expect(after?.metadata).toEqual({ gitHead: "ddddddd" });
  });

  test("metric-only update (no content change) leaves metadata untouched", () => {
    const projectPath = nextProject();
    const id = create({
      projectPath,
      category: "decision",
      title: "Metric-only entry",
      content: "stable content",
      scope: "project",
      metadata: { gitHead: "eeeeeee" },
    });
    // No content change → no new version → metadata stays on the v1 row even
    // though a fresh gitHead is supplied. Version rows are immutable (A2).
    update(id, { confidence: 0.9, metadata: { gitHead: "fffffff" } });
    const after = getByLogical(logicalIdOf(id));
    expect(after?.metadata).toEqual({ gitHead: "eeeeeee" });
  });

  test("byte-identical re-observation does not append → metadata untouched", () => {
    const projectPath = nextProject();
    const id = create({
      projectPath,
      category: "decision",
      title: "Re-observed entry",
      content: "unchanged content",
      scope: "project",
      metadata: { gitHead: "1111111" },
    });
    update(id, {
      content: "unchanged content",
      metadata: { gitHead: "2222222" },
    });
    const after = getByLogical(logicalIdOf(id));
    expect(after?.metadata).toEqual({ gitHead: "1111111" });
  });

  test("remove() stamps the death-cert version with the delete-time gitHead", () => {
    const projectPath = nextProject();
    const id = create({
      projectPath,
      category: "decision",
      title: "Doomed entry",
      content: "about to be deleted",
      scope: "project",
      metadata: { gitHead: "3333333" },
    });
    const logicalId = logicalIdOf(id);
    remove(id, { gitHead: "4444444" });
    // The entry is gone from the live view…
    expect(getByLogical(logicalId)).toBeNull();
    // …but the immutable death-cert version records where it was deleted.
    expect(rawCurrentMetadata(logicalId)).toBe(
      JSON.stringify({ gitHead: "4444444" }),
    );
  });

  test("remove() with no metadata forward-copies the entry's last gitHead", () => {
    const projectPath = nextProject();
    const id = create({
      projectPath,
      category: "decision",
      title: "Doomed entry (forward-copy)",
      content: "about to be deleted",
      scope: "project",
      metadata: { gitHead: "5555555" },
    });
    const logicalId = logicalIdOf(id);
    remove(id);
    expect(rawCurrentMetadata(logicalId)).toBe(
      JSON.stringify({ gitHead: "5555555" }),
    );
  });
});
