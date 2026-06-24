import { describe, expect, test } from "vitest";
import { db } from "../src/db";
import {
  create,
  forProject,
  get,
  getByLogical,
  hydrateKnowledgeEntry,
  logicalIdOf,
  searchScored,
  searchScoredOtherProjects,
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
  test("searchScored returns parsed metadata objects", () => {
    const projectPath = nextProject();
    create({
      projectPath,
      category: "decision",
      title: "Zircon storage engine choice",
      content: "we picked the zircon engine for durability",
      scope: "project",
      metadata: { gitHead: "5cored1234beef" },
    });
    const results = searchScored({ query: "zircon", projectPath });
    const hit = results.find((r) => r.title === "Zircon storage engine choice");
    expect(hit).toBeDefined();
    // The bug: raw FTS rows left metadata as a JSON string.
    expect(typeof hit!.metadata).toBe("object");
    expect(hit!.metadata).toEqual({ gitHead: "5cored1234beef" });
    // The extra FTS `rank` column survives hydration (spread preserves it).
    expect(typeof hit!.rank).toBe("number");
  });

  test("searchScoredOtherProjects returns parsed metadata objects", () => {
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
    const results = searchScoredOtherProjects({
      query: "quokka",
      excludeProjectPath: otherProject,
    });
    const hit = results.find((r) => r.title === "Quokka deployment runbook");
    expect(hit).toBeDefined();
    expect(typeof hit!.metadata).toBe("object");
    expect(hit!.metadata).toEqual({ gitHead: "0ther9999cafe" });
  });
});
