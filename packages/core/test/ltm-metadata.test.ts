import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { db } from "../src/db";
import {
  create,
  forProject,
  hydrateKnowledgeEntry,
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
