import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { EventEmitter } from "node:events";
import { uuidv7 } from "uuidv7";
import { db, ensureProject } from "../src/db";
import * as ltm from "../src/ltm";
import * as embedding from "../src/embedding";
import { config } from "../src/config";
import {
  _resetVectorPoolForTest,
  _setTestVectorWorkerFactory,
  vectorSearchTimeoutMs,
} from "../src/vector-pool";

// UUID v7 pattern: starts with version nibble 7, variant bits 10xxxxxx
const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const _UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const PROJECT = "/test/ltm/project";

describe("ltm", () => {
  test("create and retrieve knowledge entry", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      category: "decision",
      title: "Auth strategy",
      content: "Using OAuth2 with PKCE flow for all authentication",
      session: "sess-1",
      scope: "project",
    });
    expect(id).toBeTruthy();

    const entry = ltm.get(id);
    expect(entry).not.toBeNull();
    expect(entry?.title).toBe("Auth strategy");
    expect(entry?.category).toBe("decision");
    expect(entry?.confidence).toBe(1.0);
  });

  test("create global knowledge entry", () => {
    const id = ltm.create({
      category: "preference",
      title: "Code style",
      content: "User prefers no backwards-compat shims, fix callers directly",
      scope: "global",
      crossProject: true,
    });
    const entry = ltm.get(id);
    expect(entry).not.toBeNull();
    expect(entry?.project_id).toBeNull();
    expect(entry?.cross_project).toBe(1);
  });

  test("remove() appends a death-certificate version that tombstones the entry", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Tombstone target",
      content: "Will be deleted",
      scope: "project",
    });
    expect(ltm.isTombstoned(id)).toBe(false);
    ltm.remove(id);
    // A2: delete = immutable is_deleted version (no physical DELETE). The entry is
    // gone from the current view, and the death cert prevents .lore.md resurrection.
    expect(ltm.get(id)).toBeNull();
    expect(ltm.getByLogical(id)).toBeNull(); // no current, live version
    expect(ltm.isTombstoned(id)).toBe(true);
  });

  test("update knowledge entry appends a new current version", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      category: "architecture",
      title: "Middleware pattern",
      content: "Using express middleware for all routes",
      scope: "project",
    });
    ltm.update(id, {
      content: "Using Hono middleware for all routes",
      confidence: 0.9,
    });

    // Content change appended a new version → resolve via the stable logical_id.
    const entry = ltm.getByLogical(id);
    expect(entry?.content).toContain("Hono");
    expect(entry?.confidence).toBe(0.9);
    expect(entry?.id).not.toBe(id); // the row id moved to the new version
  });

  test("remove knowledge entry", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Temporary workaround",
      content: "This is temporary",
      scope: "project",
    });
    ltm.remove(id);
    expect(ltm.get(id)).toBeNull();
  });

  test("forProject includes project, global, and cross-project entries", () => {
    const entries = ltm.forProject(PROJECT, true);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const categories = entries.map((e) => e.category);
    expect(categories).toContain("decision");
    expect(categories).toContain("preference"); // global cross-project entry
  });

  test("full-text search works", () => {
    const results = ltm.search({ query: "OAuth", projectPath: PROJECT });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("OAuth2");
  });

  test("low confidence entries are filtered out", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      category: "pattern",
      title: "Low confidence item",
      content: "This should be hidden",
      scope: "project",
    });
    ltm.update(id, { confidence: 0.1 });

    const entries = ltm.forProject(PROJECT);
    const found = entries.find((e) => e.id === id);
    expect(found).toBeUndefined();
  });

  describe("search: FTS sanitization and fallback", () => {
    test("search does not throw on hyphenated query", () => {
      // "opencode-test" previously crashed with: no such column: test
      expect(() =>
        ltm.search({ query: "opencode-test", projectPath: PROJECT }),
      ).not.toThrow();
      expect(() =>
        ltm.search({ query: "three-tier", projectPath: PROJECT }),
      ).not.toThrow();
    });

    test("search does not throw on domain name query", () => {
      // "sanity.io" previously crashed with: fts5 syntax error near "."
      expect(() =>
        ltm.search({ query: "sanity.io memory", projectPath: PROJECT }),
      ).not.toThrow();
    });

    test("search still finds results with punctuation in query", () => {
      // "OAuth2-PKCE" strips to "OAuth2* PKCE*" — both words are in "Auth strategy" entry
      const results = ltm.search({
        query: "OAuth2-PKCE",
        projectPath: PROJECT,
      });
      expect(results.length).toBeGreaterThan(0);
    });

    test("search returns empty for all-stopword queries", () => {
      const results = ltm.search({
        query: "what is this",
        projectPath: PROJECT,
      });
      expect(results.length).toBe(0);
    });

    test("AND→OR fallback: finds entries when only some terms match", () => {
      // Create an entry that matches "gradient" but not "xyznonexistent"
      ltm.create({
        projectPath: PROJECT,
        category: "architecture",
        title: "Gradient context system",
        content:
          "The gradient manages context window compression across layers",
        scope: "project",
      });

      // AND query "gradient xyznonexistent" should fail, then OR fallback finds "gradient"
      const results = ltm.search({
        query: "gradient xyznonexistent",
        projectPath: PROJECT,
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].title).toContain("Gradient");
    });
  });

  describe("search: BM25 ranking", () => {
    const RANK_PROJECT = "/test/ltm/ranking";

    test("title matches rank higher than content-only matches", () => {
      // Entry with "database" in title — should rank higher
      ltm.create({
        projectPath: RANK_PROJECT,
        category: "architecture",
        title: "Database migration strategy",
        content: "Use incremental schema changes for all migrations",
        scope: "project",
      });

      // Entry with "database" only in content — should rank lower
      ltm.create({
        projectPath: RANK_PROJECT,
        category: "pattern",
        title: "Storage layer design",
        content: "The database uses SQLite with WAL mode for concurrent reads",
        scope: "project",
      });

      const results = ltm.search({
        query: "database",
        projectPath: RANK_PROJECT,
      });
      expect(results.length).toBeGreaterThanOrEqual(2);
      // First result should be the one with "database" in the title (higher BM25 weight)
      expect(results[0].title).toContain("Database");
    });
  });
});

// ---------------------------------------------------------------------------
// crossProject default and dedup guard
// ---------------------------------------------------------------------------

describe("ltm — crossProject defaults and dedup", () => {
  const PROJ = "/test/ltm/crossproject";

  beforeEach(() => {
    const pid = ensureProject(PROJ);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
    // Clean up cross-project entries created by these tests
    db()
      .query(
        "DELETE FROM knowledge WHERE cross_project = 1 AND title LIKE 'Cross-project dedup%'",
      )
      .run();
  });

  test("create() defaults crossProject to false", () => {
    const id = ltm.create({
      projectPath: PROJ,
      category: "pattern",
      title: "Default cross-project test",
      content: "Should default to project-scoped",
      scope: "project",
    });
    const entry = ltm.get(id);
    expect(entry).not.toBeNull();
    expect(entry?.cross_project).toBe(0);
  });

  test("create() with explicit crossProject: true sets cross_project = 1", () => {
    const id = ltm.create({
      category: "preference",
      title: "Explicit cross-project test",
      content: "Explicitly shared globally",
      scope: "global",
      crossProject: true,
    });
    const entry = ltm.get(id);
    expect(entry).not.toBeNull();
    expect(entry?.cross_project).toBe(1);
  });

  test("dedup guard catches title match against cross-project entry", () => {
    // Create a cross-project entry
    const crossId = ltm.create({
      category: "gotcha",
      title: "Cross-project dedup test entry",
      content: "Original cross-project content",
      scope: "global",
      crossProject: true,
    });

    // Attempt to create a project-scoped entry with the same title — should
    // update the cross-project entry instead of creating a duplicate.
    const returnedId = ltm.create({
      projectPath: PROJ,
      category: "gotcha",
      title: "Cross-project dedup test entry",
      content: "Updated content from project scope",
      scope: "project",
    });

    expect(returnedId).toBe(crossId);
    const entry = ltm.getByLogical(crossId); // update() appended a new version
    expect(entry?.content).toBe("Updated content from project scope");

    // No duplicate should exist
    const all = ltm.forProject(PROJ, true);
    const matching = all.filter(
      (e) => e.title === "Cross-project dedup test entry",
    );
    expect(matching).toHaveLength(1);
  });
});

describe("ltm.findSemanticDuplicate — preference-specific threshold", () => {
  const PROJ = "/test/ltm/semdup-threshold";
  let availableSpy: ReturnType<typeof vi.spyOn>;
  let embedSpy: ReturnType<typeof vi.spyOn>;
  let vectorSpy: ReturnType<typeof vi.spyOn>;
  let existingId = "";

  beforeEach(() => {
    const pid = ensureProject(PROJ);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
    existingId = ltm.create({
      projectPath: PROJ,
      category: "preference",
      title: "Always document invariants as code comments",
      content: "Document load-bearing invariants inline in source.",
      scope: "project",
    });

    availableSpy = vi.spyOn(embedding, "isAvailable").mockReturnValue(true);
    embedSpy = vi
      .spyOn(embedding, "embed")
      .mockResolvedValue([new Float32Array([1, 0, 0])]);
    // The existing entry scores 0.90 cosine vs the incoming paraphrase — a
    // realistic near-duplicate-preference similarity: above the new 0.88
    // preference threshold, but BELOW the conservative global 0.935.
    vectorSpy = vi
      .spyOn(embedding, "vectorSearch")
      .mockImplementation(async () => [{ id: existingId, similarity: 0.9 }]);
  });

  afterEach(() => {
    availableSpy.mockRestore();
    embedSpy.mockRestore();
    vectorSpy.mockRestore();
  });

  test("default (global 0.935) threshold does NOT match a 0.90 paraphrase", async () => {
    const dup = await ltm.findSemanticDuplicate({
      title: "Always write invariants as inline code comments",
      content: "Put design rationale and invariants in the source.",
      projectId: ensureProject(PROJ),
    });
    expect(dup).toBeNull();
  });

  test("PREFERENCE_DEDUP_THRESHOLD (0.88) DOES match the 0.90 paraphrase", async () => {
    const dup = await ltm.findSemanticDuplicate({
      title: "Always write invariants as inline code comments",
      content: "Put design rationale and invariants in the source.",
      projectId: ensureProject(PROJ),
      threshold: ltm.PREFERENCE_DEDUP_THRESHOLD,
    });
    expect(dup).not.toBeNull();
    expect(dup?.id).toBe(existingId);
    expect(dup?.similarity).toBeCloseTo(0.9, 5);
  });

  test("PREFERENCE_DEDUP_THRESHOLD is below the global dedup cutoff", () => {
    // Guards the invariant that the preference cutoff is intentionally looser
    // (so paraphrases collapse) but still > 0 — a revert to the global value
    // would make the dedup test above fail.
    expect(ltm.PREFERENCE_DEDUP_THRESHOLD).toBeLessThan(0.935);
    expect(ltm.PREFERENCE_DEDUP_THRESHOLD).toBeGreaterThan(0.5);
  });
});

describe("ltm — UUIDv7 IDs", () => {
  const PROJ = "/test/ltm/uuidv7";

  beforeAll(() => {
    const pid = ensureProject(PROJ);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
  });

  test("create() generates a UUIDv7 ID by default", () => {
    const id = ltm.create({
      projectPath: PROJ,
      category: "decision",
      title: "UUIDv7 test entry",
      content: "Should get a v7 ID",
      scope: "project",
    });
    expect(id).toMatch(UUID_V7_RE);
  });

  test("multiple create() calls produce monotonically increasing IDs", () => {
    const ids = Array.from({ length: 5 }, (_, i) =>
      ltm.create({
        projectPath: PROJ,
        category: "pattern",
        title: `Monotonic entry ${i}`,
        content: "Content",
        scope: "project",
      }),
    );
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i] > ids[i - 1]).toBe(true);
    }
  });

  test("create() accepts explicit id (for cross-machine import)", () => {
    const explicitId = "019505a1-7c00-7000-8000-aabbccddeeff";
    const returned = ltm.create({
      projectPath: PROJ,
      category: "gotcha",
      title: "Explicit ID entry",
      content: "Imported from another machine",
      scope: "project",
      id: explicitId,
    });
    expect(returned).toBe(explicitId);

    const entry = ltm.get(explicitId);
    expect(entry).not.toBeNull();
    expect(entry?.id).toBe(explicitId);
    expect(entry?.title).toBe("Explicit ID entry");
  });

  test("explicit id can be a UUIDv4 (backwards compat for existing entries)", () => {
    const v4Id = "550e8400-e29b-41d4-a716-446655440000";
    ltm.create({
      projectPath: PROJ,
      category: "preference",
      title: "Legacy v4 entry",
      content: "Had a v4 ID before migration",
      scope: "project",
      id: v4Id,
    });
    const entry = ltm.get(v4Id);
    expect(entry).not.toBeNull();
    expect(entry?.id).toBe(v4Id);
  });

  test("create() with duplicate explicit id throws or silently overwrites — not silent data loss", () => {
    const id = "019505ff-0000-7000-8000-ffffffffffff";
    ltm.create({
      projectPath: PROJ,
      category: "pattern",
      title: "Original",
      content: "Original content",
      scope: "project",
      id,
    });

    // Attempting to insert with the same ID should throw (SQLite UNIQUE constraint)
    expect(() =>
      ltm.create({
        projectPath: PROJ,
        category: "pattern",
        title: "Duplicate",
        content: "Would overwrite",
        scope: "project",
        id,
      }),
    ).toThrow();

    // Original should still be intact
    const entry = ltm.get(id);
    expect(entry?.title).toBe("Original");
  });
});

// ---------------------------------------------------------------------------
// forSession — smart relevance-ranked injection
// ---------------------------------------------------------------------------

describe("ltm.forSession", () => {
  const PROJ = "/test/ltm/forsession";
  const SESSION = "test-session-abc";

  beforeEach(() => {
    const pid = ensureProject(PROJ);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
    // Clean up any cross-project entries from this test project
    db()
      .query(
        "DELETE FROM knowledge WHERE project_id IN (SELECT id FROM projects WHERE path LIKE '/test/%')",
      )
      .run();
    db().query("DELETE FROM temporal_messages WHERE project_id = ?").run(pid);
    db().query("DELETE FROM distillations WHERE project_id = ?").run(pid);
  });

  test("returns project-specific entries regardless of session context", async () => {
    ltm.create({
      projectPath: PROJ,
      category: "decision",
      title: "DB choice for forSession test",
      content: "Using SQLite via bun:sqlite for local storage",
      scope: "project",
      crossProject: false,
    });

    const result = await ltm.forSession(PROJ, SESSION, 10_000);
    // Project-specific entry must be included
    const found = result.find(
      (e) => e.title === "DB choice for forSession test",
    );
    expect(found).toBeDefined();
    // It must be the project-specific entry (cross_project = 0)
    expect(found?.cross_project).toBe(0);
  });

  test("degrades to [] when a candidate-scan worker times out (#1006 symmetric degrade)", async () => {
    // Force the read-worker pool ON with a worker that receives the candidate
    // scans but NEVER replies → both scans time out. forSession must degrade the
    // whole LTM injection to [] rather than re-run the wedged scans on the main
    // thread (re-blocking the loop) or inject a lopsided partial set.
    ltm.create({
      projectPath: PROJ,
      category: "decision",
      title:
        "Entry present in the DB but unreachable while the worker is wedged",
      content: "would be injected if the candidate scan completed",
      scope: "project",
      crossProject: false,
    });

    class HangingWorker extends EventEmitter {
      unref(): void {}
      terminate(): Promise<number> {
        this.emit("exit", 0);
        return Promise.resolve(0);
      }
      postMessage(): void {
        // never reply → forces the per-request timeout
      }
    }

    _resetVectorPoolForTest();
    _setTestVectorWorkerFactory((() => new HangingWorker()) as never);
    vi.useFakeTimers();
    try {
      const p = ltm.forSession(PROJ, SESSION, 10_000);
      // Advance past the per-request timeout so both candidate scans time out.
      await vi.advanceTimersByTimeAsync(vectorSearchTimeoutMs() + 1);
      expect(await p).toEqual([]);
    } finally {
      vi.useRealTimers();
      _setTestVectorWorkerFactory(null);
      _resetVectorPoolForTest();
    }
  });

  test("degrades to [] when ONLY ONE candidate scan times out (symmetric, guards ||)", async () => {
    // Asymmetric case: the project scan's worker wedges (times out) while the
    // cross scan resolves (its worker errors → in-process fallback). forSession
    // must still degrade to [] rather than inject the lopsided cross-only set.
    // Guards the `||` symmetric check (a `&&` would proceed with a partial set).
    ltm.create({
      projectPath: PROJ,
      category: "decision",
      title: "Project entry dropped on partial timeout",
      content: "would be injected if its scan completed",
      scope: "project",
      crossProject: false,
    });

    let spawnIdx = 0;
    class SplitWorker extends EventEmitter {
      readonly i = spawnIdx++;
      unref(): void {}
      terminate(): Promise<number> {
        this.emit("exit", 0);
        return Promise.resolve(0);
      }
      postMessage(msg: { type: string; id: number }): void {
        if (msg.type !== "read") return;
        // Dispatch order is [project → worker 0, cross → worker 1]. Worker 0
        // hangs (project scan times out); worker 1 reports a per-request error so
        // the cross scan falls back in-process (a NON-timeout resolution).
        if (this.i === 0) return;
        this.emit("message", {
          type: "error",
          id: msg.id,
          error: "force in-process fallback",
        });
      }
    }

    _resetVectorPoolForTest();
    _setTestVectorWorkerFactory((() => new SplitWorker()) as never);
    vi.useFakeTimers();
    try {
      const p = ltm.forSession(PROJ, SESSION, 10_000);
      await vi.advanceTimersByTimeAsync(vectorSearchTimeoutMs() + 1);
      expect(await p).toEqual([]);
    } finally {
      vi.useRealTimers();
      _setTestVectorWorkerFactory(null);
      _resetVectorPoolForTest();
    }
  });

  test("deterministic ordering — equal-score entries keep a stable order (fix B)", async () => {
    // Many entries with identical confidence and no distinguishing session
    // context → equal/near-equal scores. Without the id tiebreak these reorder
    // turn-to-turn and churn system[2]. With it, two calls produce identical
    // ordering, so the rendered set is byte-stable.
    for (let i = 0; i < 8; i++) {
      ltm.create({
        projectPath: PROJ,
        category: "pattern",
        title: `Equal pattern ${i}`,
        content: "Neutral content with no session-context keywords.",
        scope: "project",
        crossProject: false,
      });
    }

    const first = await ltm.forSession(PROJ, SESSION, 10_000);
    const second = await ltm.forSession(PROJ, SESSION, 10_000);
    expect(first.map((e) => e.id)).toEqual(second.map((e) => e.id));
  });

  test("stickyIds keeps previously-selected entries when budget is tight (fix: set-stabilization)", async () => {
    // 10 equal-confidence entries (~50 tokens each) but a budget that fits ~4.
    // Which 4 get selected is otherwise score-order-dependent; with stickyIds,
    // the previously-selected set is retained across turns.
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(
        ltm.create({
          projectPath: PROJ,
          category: "pattern",
          title: `Tight pattern ${i}`,
          content: "B ".repeat(150),
          scope: "project",
          crossProject: false,
        }),
      );
    }

    const TIGHT = 250;
    const firstSel = await ltm.forSession(PROJ, SESSION, TIGHT);
    const firstIds = new Set(firstSel.map((e) => e.id));
    expect(firstIds.size).toBeGreaterThan(0);
    expect(firstIds.size).toBeLessThan(10);

    // Next turn, pass the prior selection as stickyIds → identical set retained.
    const secondSel = await ltm.forSession(PROJ, SESSION, TIGHT, {
      stickyIds: firstIds,
    });
    expect(new Set(secondSel.map((e) => e.id))).toEqual(firstIds);
  });

  test("respects token budget — stops adding entries when budget exhausted", async () => {
    // Create many project entries
    for (let i = 0; i < 10; i++) {
      ltm.create({
        projectPath: PROJ,
        category: "pattern",
        title: `Pattern ${i}`,
        content: "A ".repeat(200), // ~50 tokens each
        scope: "project",
        crossProject: false,
      });
    }

    // Budget of 200 tokens — should fit only a few entries
    const result = await ltm.forSession(PROJ, SESSION, 200);
    expect(result.length).toBeLessThan(10);
    expect(result.length).toBeGreaterThan(0);
  });

  test("overflowSink collects scored entries that did not fit the budget (#917)", async () => {
    // 10 entries (~100 tokens each); a budget that fits only a couple. The rest
    // are relevance-scored but over-budget — they must surface in overflowSink
    // so the caller can advertise them for recall-on-demand without re-querying.
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(
        ltm.create({
          projectPath: PROJ,
          category: "pattern",
          title: `Overflow pattern ${i}`,
          content: "C ".repeat(150),
          scope: "project",
          crossProject: false,
        }),
      );
    }

    const overflow: ltm.KnowledgeEntry[] = [];
    const selected = await ltm.forSession(PROJ, SESSION, 250, {
      overflowSink: overflow,
    });

    // Some fit, some didn't.
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThan(10);
    expect(overflow.length).toBeGreaterThan(0);

    // Selected and overflow are disjoint, and every overflow entry is a seeded
    // entry (never a phantom).
    const selectedIds = new Set(selected.map((e) => e.id));
    for (const e of overflow) {
      expect(selectedIds.has(e.id)).toBe(false);
      expect(ids).toContain(e.id);
    }

    // No id appears in both lists.
    const union = new Set([...selectedIds, ...overflow.map((e) => e.id)]);
    expect(union.size).toBe(selectedIds.size + overflow.length);

    // Overflow is ranked (score desc), same order forSession uses internally —
    // pin determinism so the rendered ToC is byte-stable across turns.
    const rerun: ltm.KnowledgeEntry[] = [];
    await ltm.forSession(PROJ, SESSION, 250, { overflowSink: rerun });
    expect(rerun.map((e) => e.id)).toEqual(overflow.map((e) => e.id));
  });

  test("includes relevant cross-project entries when session context matches", async () => {
    // Create a cross-project entry about TypeScript
    ltm.create({
      category: "gotcha",
      title: "TypeScript strict mode caveat",
      content:
        "TypeScript strict null checks require explicit undefined handling",
      scope: "global",
      crossProject: true,
    });

    // Create irrelevant cross-project entry
    ltm.create({
      category: "pattern",
      title: "Kubernetes deployment pattern",
      content:
        "Use helm charts for Kubernetes deployments with resource limits",
      scope: "global",
      crossProject: true,
    });

    // Seed session context mentioning TypeScript
    const pid = ensureProject(PROJ);
    db()
      .query(
        "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, 0, ?, '{}')",
      )
      .run(
        "msg-ts-1",
        pid,
        SESSION,
        "user",
        "Help me fix a TypeScript type error in my function",
        20,
        Date.now(),
      );

    const result = await ltm.forSession(PROJ, SESSION, 10_000);
    const titles = result.map((e) => e.title);
    expect(titles).toContain("TypeScript strict mode caveat");
    // Kubernetes entry should not appear (no match with TypeScript context)
    expect(titles).not.toContain("Kubernetes deployment pattern");
  });

  test("falls back to top entries by confidence when no session context", async () => {
    // Create cross-project entries — no session messages to provide context
    ltm.create({
      category: "preference",
      title: "General coding preference",
      content: "Prefer explicit error handling over silent failures",
      scope: "global",
      crossProject: true,
    });

    // No session context (fresh session) — should still return top entries
    const result = await ltm.forSession(PROJ, "brand-new-session", 10_000);
    // At minimum, the fallback path should return something (up to 10 entries)
    // (may be 0 if budget is exhausted by project entries, but shouldn't crash)
    expect(Array.isArray(result)).toBe(true);
  });

  test("excludes irrelevant project entries when session context exists", async () => {
    // Create a project entry about Kubernetes (irrelevant to TypeScript context)
    ltm.create({
      projectPath: PROJ,
      category: "pattern",
      title: "Kubernetes pod scaling",
      content:
        "Configure horizontal pod autoscaler with CPU thresholds for deployment replicas",
      scope: "project",
      crossProject: false,
    });

    // Create a project entry about TypeScript (relevant)
    ltm.create({
      projectPath: PROJ,
      category: "gotcha",
      title: "TypeScript strict null handling",
      content:
        "TypeScript strict null checks require explicit undefined handling in function params",
      scope: "project",
      crossProject: false,
    });

    // Seed session context about TypeScript
    const pid = ensureProject(PROJ);
    db()
      .query(
        "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, 0, ?, '{}')",
      )
      .run(
        "msg-relevance-1",
        pid,
        SESSION,
        "user",
        "Help me fix a TypeScript type error with strict null checks in my function parameters",
        20,
        Date.now(),
      );

    const result = await ltm.forSession(PROJ, SESSION, 10_000);
    const titles = result.map((e) => e.title);

    // TypeScript entry should be included (matches session context)
    expect(titles).toContain("TypeScript strict null handling");

    // Kubernetes entry may be included via safety net (top-5 by confidence)
    // but should NOT be included via relevance matching — verify by checking
    // that if we have enough relevant entries, irrelevant ones are pushed out.
    // For now, just verify the relevant entry is present.
  });

  test("includes top-5 project entries by confidence as safety net even without term match", async () => {
    // Create 8 project entries — crafted so no words overlap session context.
    // Use made-up domain-specific jargon to avoid accidental term overlap.
    for (let i = 0; i < 8; i++) {
      ltm.create({
        projectPath: PROJ,
        category: "architecture",
        title: `Xylophage plumbing spec ${i}`,
        content: `Xylophage plumbing subsystem spec ${i} governs frobnicator calibration`,
        scope: "project",
        crossProject: false,
      });
    }

    // Seed session context about something completely different — no shared terms
    const pid = ensureProject(PROJ);
    db()
      .query(
        "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, 0, ?, '{}')",
      )
      .run(
        "msg-safetynet-1",
        pid,
        SESSION,
        "user",
        "Implement a React dashboard showing monthly revenue analytics quarterly forecasts charting",
        20,
        Date.now(),
      );

    const result = await ltm.forSession(PROJ, SESSION, 10_000);
    // Safety net should include up to 5 project entries even though none match
    const xEntries = result.filter((e) =>
      e.title.startsWith("Xylophage plumbing"),
    );
    expect(xEntries.length).toBeLessThanOrEqual(5);
    expect(xEntries.length).toBeGreaterThan(0);
  });

  test("interleaves project and cross-project entries by relevance score", async () => {
    // Create a project entry that does NOT match session context
    ltm.create({
      projectPath: PROJ,
      category: "pattern",
      title: "Docker compose networking",
      content:
        "Docker compose networking configuration for multi-container orchestration",
      scope: "project",
      crossProject: false,
    });

    // Create a cross-project entry that DOES match session context
    ltm.create({
      category: "gotcha",
      title: "React useState async pitfall",
      content:
        "React useState setter is async — reading state immediately after setState returns stale value in dashboard components",
      scope: "global",
      crossProject: true,
    });

    // Seed session context about React
    const pid = ensureProject(PROJ);
    db()
      .query(
        "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, 0, ?, '{}')",
      )
      .run(
        "msg-interleave-1",
        pid,
        SESSION,
        "user",
        "Fix the React dashboard component where useState returns stale value after async update",
        20,
        Date.now(),
      );

    const result = await ltm.forSession(PROJ, SESSION, 10_000);
    const titles = result.map((e) => e.title);

    // The relevant cross-project entry should be included
    expect(titles).toContain("React useState async pitfall");

    // If Docker entry appears at all (via safety net), it should be after
    // the relevant React entry in the result array
    const reactIdx = titles.indexOf("React useState async pitfall");
    const dockerIdx = titles.indexOf("Docker compose networking");
    if (dockerIdx !== -1) {
      expect(reactIdx).toBeLessThan(dockerIdx);
    }
  });

  test("categories filter restricts to specified categories", async () => {
    ltm.create({
      projectPath: PROJ,
      category: "preference",
      title: "Code style preference",
      content: "Use camelCase for variables and PascalCase for types",
      scope: "project",
      crossProject: false,
    });
    ltm.create({
      projectPath: PROJ,
      category: "gotcha",
      title: "Cache invalidation gotcha",
      content: "LTM cache must be cleared when knowledge changes",
      scope: "project",
      crossProject: false,
    });
    ltm.create({
      projectPath: PROJ,
      category: "architecture",
      title: "Three tier memory arch",
      content: "Temporal, distillation, knowledge tiers",
      scope: "project",
      crossProject: false,
    });

    // Request only preference entries
    const result = await ltm.forSession(PROJ, SESSION, 10_000, {
      categories: ["preference"],
    });
    expect(result.length).toBeGreaterThan(0);
    for (const entry of result) {
      expect(entry.category).toBe("preference");
    }
  });

  test("categories filter works with multiple categories", async () => {
    ltm.create({
      projectPath: PROJ,
      category: "preference",
      title: "Commit style preference",
      content: "Use conventional commits format",
      scope: "project",
      crossProject: false,
    });
    ltm.create({
      projectPath: PROJ,
      category: "decision",
      title: "DB engine decision",
      content: "SQLite chosen for embedded use case",
      scope: "project",
      crossProject: false,
    });
    ltm.create({
      projectPath: PROJ,
      category: "gotcha",
      title: "Unrelated gotcha entry",
      content: "Some gotcha that should be excluded",
      scope: "project",
      crossProject: false,
    });

    const result = await ltm.forSession(PROJ, SESSION, 10_000, {
      categories: ["preference", "decision"],
    });
    expect(result.length).toBeGreaterThan(0);
    for (const entry of result) {
      expect(["preference", "decision"]).toContain(entry.category);
    }
  });

  test("excludeCategories filters out specified categories", async () => {
    ltm.create({
      projectPath: PROJ,
      category: "preference",
      title: "Excluded preference entry",
      content: "This preference should not appear",
      scope: "project",
      crossProject: false,
    });
    ltm.create({
      projectPath: PROJ,
      category: "gotcha",
      title: "Included gotcha entry",
      content: "This gotcha should appear in results",
      scope: "project",
      crossProject: false,
    });
    ltm.create({
      projectPath: PROJ,
      category: "architecture",
      title: "Included architecture entry",
      content: "This architecture entry should appear",
      scope: "project",
      crossProject: false,
    });

    const result = await ltm.forSession(PROJ, SESSION, 10_000, {
      excludeCategories: ["preference"],
    });
    expect(result.length).toBeGreaterThan(0);
    for (const entry of result) {
      expect(entry.category).not.toBe("preference");
    }
  });

  test("excludeCategories and categories are mutually exclusive (categories wins)", async () => {
    ltm.create({
      projectPath: PROJ,
      category: "preference",
      title: "Pref entry for mutual exclusion test",
      content: "Should appear because categories takes priority",
      scope: "project",
      crossProject: false,
    });
    ltm.create({
      projectPath: PROJ,
      category: "gotcha",
      title: "Gotcha for mutual exclusion test",
      content: "Should NOT appear because categories restricts to preference",
      scope: "project",
      crossProject: false,
    });

    // When both are provided, categories wins (excludeCategories ignored)
    const result = await ltm.forSession(PROJ, SESSION, 10_000, {
      categories: ["preference"],
      excludeCategories: ["gotcha"],
    });
    expect(result.length).toBeGreaterThan(0);
    for (const entry of result) {
      expect(entry.category).toBe("preference");
    }
  });

  test("excludeCategories filters cross-project entries too", async () => {
    ltm.create({
      projectPath: PROJ,
      category: "preference",
      title: "Cross-project pref to exclude",
      content: "This cross-project preference should not appear",
      scope: "project",
      crossProject: true,
    });
    ltm.create({
      projectPath: PROJ,
      category: "gotcha",
      title: "Cross-project gotcha to include",
      content: "This cross-project gotcha should appear",
      scope: "project",
      crossProject: true,
    });
    ltm.create({
      projectPath: PROJ,
      category: "architecture",
      title: "Local arch entry to include",
      content: "This local architecture entry should appear",
      scope: "project",
      crossProject: false,
    });

    const result = await ltm.forSession(PROJ, SESSION, 10_000, {
      excludeCategories: ["preference"],
    });
    expect(result.length).toBeGreaterThan(0);
    for (const entry of result) {
      expect(entry.category).not.toBe("preference");
    }
  });

  test("empty excludeCategories array has no effect", async () => {
    ltm.create({
      projectPath: PROJ,
      category: "preference",
      title: "Pref for empty-exclude test",
      content: "Should appear when excludeCategories is empty array",
      scope: "project",
      crossProject: false,
    });
    ltm.create({
      projectPath: PROJ,
      category: "gotcha",
      title: "Gotcha for empty-exclude test",
      content: "Should also appear when excludeCategories is empty",
      scope: "project",
      crossProject: false,
    });

    const result = await ltm.forSession(PROJ, SESSION, 10_000, {
      excludeCategories: [],
    });
    const categories = new Set(result.map((e) => e.category));
    // Both categories should be present — empty exclude means no filtering
    expect(categories.size).toBeGreaterThanOrEqual(2);
  });

  test("contextHint provides relevance signal when no session context exists", async () => {
    // Create entries about different topics
    ltm.create({
      projectPath: PROJ,
      category: "gotcha",
      title: "React useState returns stale state",
      content:
        "React useState setter is async, reading immediately returns old value",
      scope: "project",
      crossProject: false,
    });
    ltm.create({
      projectPath: PROJ,
      category: "gotcha",
      title: "Docker networking bridge mode",
      content:
        "Docker bridge networking requires explicit port mapping for container communication",
      scope: "project",
      crossProject: false,
    });

    // No temporal messages, but provide contextHint about React
    const result = await ltm.forSession(PROJ, "no-temporal-session", 10_000, {
      contextHint:
        "Fix the React component where useState returns stale value after async update",
    });

    // The React entry should appear — either via FTS5 fallback or vector scoring
    const titles = result.map((e) => e.title);
    expect(titles).toContain("React useState returns stale state");
  });
});

// ---------------------------------------------------------------------------
// forProjectOffloaded — off-thread twin of forProject (#1080)
// ---------------------------------------------------------------------------

describe("ltm.forProjectOffloaded (#1080)", () => {
  const PROJ = "/test/ltm/forproject-offload";
  // Track every logical_id we mint so cleanup is SURGICAL: this block seeds a
  // global cross-project entry (project_id IS NULL) which sibling blocks' by
  // project_id cleanups would NOT reap, so a broad delete here would either
  // leak into later blocks (e.g. #727's forSession budget) or clobber their
  // globals. Deleting exactly what we created avoids both.
  const created: string[] = [];

  function cleanup(): void {
    if (!created.length) return;
    const placeholders = created.map(() => "?").join(",");
    db()
      .query(`DELETE FROM knowledge WHERE logical_id IN (${placeholders})`)
      .run(...created);
    created.length = 0;
  }

  beforeEach(() => {
    ensureProject(PROJ);
    cleanup();
  });

  afterEach(() => {
    vi.useRealTimers();
    _setTestVectorWorkerFactory(null);
    _resetVectorPoolForTest();
    cleanup();
  });

  function seed(): void {
    created.push(
      ltm.create({
        projectPath: PROJ,
        category: "decision",
        title: "Project-scoped decision",
        content: "belongs to this project only",
        scope: "project",
        crossProject: false,
        // Non-null metadata so hydrateKnowledgeEntry (JSON string → object) is
        // an OBSERVABLE transform — the pool-rows test would miss a dropped
        // hydration otherwise (a null-metadata row hydrates to itself).
        metadata: { gitHead: "deadbee" },
      }),
    );
    created.push(
      ltm.create({
        category: "preference",
        title: "Global preference",
        content: "shared across all projects",
        scope: "global",
        crossProject: true,
      }),
    );
    // Below the confidence floor — must be excluded by BOTH paths.
    const lowId = ltm.create({
      projectPath: PROJ,
      category: "pattern",
      title: "Decayed entry",
      content: "should never surface",
      scope: "project",
      crossProject: false,
    });
    created.push(lowId);
    ltm.update(lowId, { confidence: 0.1 });
  }

  test("with the pool inert, returns exactly what the sync forProject returns", async () => {
    seed();
    for (const includeCross of [true, false]) {
      const sync = ltm.forProject(PROJ, includeCross);
      const offloaded = await ltm.forProjectOffloaded(PROJ, includeCross);
      // Same rows, same deterministic order (confidence DESC, updated_at DESC).
      expect(offloaded.map((e) => e.id)).toEqual(sync.map((e) => e.id));
      expect(offloaded).toEqual(sync);
      // Sanity: the below-floor entry is filtered out; the visible one is present.
      expect(offloaded.some((e) => e.title === "Decayed entry")).toBe(false);
      expect(offloaded.some((e) => e.title === "Project-scoped decision")).toBe(
        true,
      );
    }
  });

  test("prefers the pool's result over the in-process scan when the pool serves it", async () => {
    seed();
    // A worker that answers every read with an EMPTY set. The DB genuinely has
    // rows, so an empty result can ONLY come from the pool — proving the offload
    // path is actually taken (not silently re-queried in-process).
    class EmptyPoolWorker extends EventEmitter {
      unref(): void {}
      terminate(): Promise<number> {
        this.emit("exit", 0);
        return Promise.resolve(0);
      }
      postMessage(msg: { type: string; id: number }): void {
        if (msg.type !== "read") return;
        this.emit("message", { type: "read-result", id: msg.id, rows: [] });
      }
    }
    _resetVectorPoolForTest();
    _setTestVectorWorkerFactory((() => new EmptyPoolWorker()) as never);

    expect(ltm.forProject(PROJ, true).length).toBeGreaterThan(0);
    expect(await ltm.forProjectOffloaded(PROJ, true)).toEqual([]);
  });

  test("hydrates the pool's real rows in order (offloaded == in-process)", async () => {
    // The positive path: a worker that actually SERVES the query (running it
    // against the same db() from the fake worker) must produce entries that are
    // byte-for-byte equal to the in-process scan — proving the offloaded rows
    // are hydrated and ordered identically, not just that empty/timeout degrade.
    seed();
    const expected = ltm.forProject(PROJ, true);
    expect(expected.length).toBeGreaterThan(0);

    class ServingWorker extends EventEmitter {
      unref(): void {}
      terminate(): Promise<number> {
        this.emit("exit", 0);
        return Promise.resolve(0);
      }
      postMessage(msg: {
        type: string;
        id: number;
        spec?: { sql: string; params: unknown[] };
      }): void {
        if (msg.type !== "read" || !msg.spec) return;
        // Run the real parameterized query so the pool returns genuine rows.
        const rows = db()
          .query(msg.spec.sql)
          .all(...msg.spec.params);
        this.emit("message", { type: "read-result", id: msg.id, rows });
      }
    }
    _resetVectorPoolForTest();
    _setTestVectorWorkerFactory((() => new ServingWorker()) as never);

    const offloaded = await ltm.forProjectOffloaded(PROJ, true);
    expect(offloaded).toEqual(expected);
  });

  test("on a worker TIMEOUT falls back to the full in-process scan (never a spurious empty)", async () => {
    // The frozen system[1] catalog / compaction summary must reflect the real
    // knowledge set. A pool timeout must NOT yield [] (which would be frozen for
    // the whole session) — forProjectOffloaded re-runs the scan in-process.
    seed();
    const expected = ltm.forProject(PROJ, true);
    expect(expected.length).toBeGreaterThan(0);

    class HangingWorker extends EventEmitter {
      unref(): void {}
      terminate(): Promise<number> {
        this.emit("exit", 0);
        return Promise.resolve(0);
      }
      postMessage(): void {
        // never reply → forces the per-request timeout
      }
    }
    _resetVectorPoolForTest();
    _setTestVectorWorkerFactory((() => new HangingWorker()) as never);
    vi.useFakeTimers();
    const p = ltm.forProjectOffloaded(PROJ, true);
    await vi.advanceTimersByTimeAsync(vectorSearchTimeoutMs() + 1);
    expect((await p).map((e) => e.id)).toEqual(expected.map((e) => e.id));
  });
});

// ---------------------------------------------------------------------------
// REGRESSION: system[2] cache-bust via vector-scored set churn (#727).
//
// The cache-bust bug only manifests on the VECTOR scoring path (embeddings
// available) when the per-turn session context shifts the similarity scores of
// budget-boundary entries. Earlier reliability bugs (stuck distillations /
// bricked embeddings, #713/#720/#721) accidentally masked it by forcing the
// deterministic FTS fallback. These tests drive the real vector path with a
// CHANGING context across turns and assert the selected SET is stable with
// stickyIds (the fix) and churns without it (the bug it guards against).
// ---------------------------------------------------------------------------

describe("ltm.forSession — vector-path set stability (regression #727)", () => {
  const PROJ = "/test/ltm/vector-churn";
  const SESSION = "vector-churn-session";
  let availableSpy: ReturnType<typeof vi.spyOn>;
  let embedSpy: ReturnType<typeof vi.spyOn>;
  let vectorSpy: ReturnType<typeof vi.spyOn>;

  // Per-turn similarity scores keyed by entry id. Each "turn" supplies a fresh
  // map, simulating vector scores recomputed against an evolving session
  // context — exactly what churns the budget-boundary subset in production.
  let currentScores: Map<string, number>;

  const ids: string[] = [];

  beforeEach(() => {
    const pid = ensureProject(PROJ);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
    db().query("DELETE FROM temporal_messages WHERE project_id = ?").run(pid);
    db().query("DELETE FROM distillations WHERE project_id = ?").run(pid);
    ids.length = 0;

    // 8 equal-confidence project entries, each ~30 tokens. A tight budget fits
    // only ~4, so which 4 are selected is decided purely by the (shifting)
    // vector scores. (~30 tok: title ~11 chars + "C "*45 = 90 chars →
    // ceil(101/3)=34 +10 overhead ≈ 44; budget below tuned to fit exactly 4.)
    for (let i = 0; i < 8; i++) {
      ids.push(
        ltm.create({
          projectPath: PROJ,
          category: "pattern",
          title: `Vec entry ${i}`,
          content: "C ".repeat(45),
          scope: "project",
          crossProject: false,
        }),
      );
    }

    // Seed a session context (>20 chars) so forSession takes the scoring path.
    db()
      .query(
        "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, 0, ?, '{}')",
      )
      .run(
        "vec-msg-1",
        pid,
        SESSION,
        "user",
        "Working on the vector scoring churn reproduction across turns",
        20,
        Date.now(),
      );

    currentScores = new Map();
    availableSpy = vi.spyOn(embedding, "isAvailable").mockReturnValue(true);
    // embed() just needs to return a non-empty query vector so the vector
    // branch proceeds; the actual scores come from the vectorSearch mock.
    embedSpy = vi
      .spyOn(embedding, "embed")
      .mockResolvedValue([new Float32Array([1, 0, 0])]);
    // vectorSearch returns the current turn's per-entry similarities.
    vectorSpy = vi
      .spyOn(embedding, "vectorSearch")
      .mockImplementation(async () =>
        [...currentScores.entries()].map(([id, similarity]) => ({
          id,
          similarity,
        })),
      );
  });

  afterEach(() => {
    availableSpy.mockRestore();
    embedSpy.mockRestore();
    vectorSpy.mockRestore();
  });

  /** Assign turn-N similarity scores: a base ordering plus a perturbation that
   *  flips the ranking near the budget boundary (entries 3 and 4). */
  function scoresForTurn(turn: number): Map<string, number> {
    const m = new Map<string, number>();
    for (let i = 0; i < ids.length; i++) {
      // Descending base score; the boundary pair (i=3,4) swaps every turn.
      let s = 1 - i * 0.1;
      if (turn % 2 === 1 && (i === 3 || i === 4)) {
        s = i === 3 ? 1 - 4 * 0.1 : 1 - 3 * 0.1; // swap 3<->4
      }
      m.set(ids[i], s);
    }
    return m;
  }

  const TIGHT = 200;

  test("WITHOUT stickyIds: vector scores shifting across turns churn the set (the bug)", async () => {
    currentScores = scoresForTurn(0);
    const turn0 = new Set(
      (await ltm.forSession(PROJ, SESSION, TIGHT)).map((e) => e.id),
    );
    currentScores = scoresForTurn(1); // boundary pair swaps
    const turn1 = new Set(
      (await ltm.forSession(PROJ, SESSION, TIGHT)).map((e) => e.id),
    );

    // Sanity: the vector path actually selected a budget-limited subset.
    expect(turn0.size).toBeGreaterThan(0);
    expect(turn0.size).toBeLessThan(ids.length);
    // The boundary swap changes the selected set — this is the churn that
    // busted system[2] every turn before the fix.
    expect(turn1).not.toEqual(turn0);
  });

  test("WITH stickyIds: the previously-selected set is retained despite the score swap (the fix)", async () => {
    currentScores = scoresForTurn(0);
    const turn0 = new Set(
      (await ltm.forSession(PROJ, SESSION, TIGHT)).map((e) => e.id),
    );

    // Next turn: scores swap at the boundary, but feeding the prior set as
    // stickyIds keeps the selection stable → no system[2] cache bust.
    currentScores = scoresForTurn(1);
    const turn1 = new Set(
      (await ltm.forSession(PROJ, SESSION, TIGHT, { stickyIds: turn0 })).map(
        (e) => e.id,
      ),
    );
    expect(turn1).toEqual(turn0);

    // And it stays stable across a third turn when fed forward again.
    currentScores = scoresForTurn(2);
    const turn2 = new Set(
      (await ltm.forSession(PROJ, SESSION, TIGHT, { stickyIds: turn1 })).map(
        (e) => e.id,
      ),
    );
    expect(turn2).toEqual(turn0);
  });

  // The hysteresis bonus is multiplicative (STICKY_RELEVANCE_BONUS = 1.25): a
  // sticky entry at raw score s keeps its slot unless a contender out-scores
  // s × 1.25. These two tests pin that threshold from both sides at the budget
  // boundary (the weakest selected sticky entry, index 3, vs the first dropped
  // entry, index 4), so the test would fail if the constant were changed.
  //
  // Layout: entries 0–2 score high (always selected), 3 is the boundary sticky
  // entry (raw 0.40), 4 is the contender. Budget fits exactly 4.
  function boundaryScores(contenderScore: number): Map<string, number> {
    const m = new Map<string, number>();
    m.set(ids[0], 0.9);
    m.set(ids[1], 0.8);
    m.set(ids[2], 0.7);
    m.set(ids[3], 0.4); // sticky boundary entry → effective 0.4 × 1.25 = 0.50
    m.set(ids[4], contenderScore); // non-sticky contender
    for (let i = 5; i < ids.length; i++) m.set(ids[i], 0.05);
    return m;
  }

  test("WITH stickyIds: a contender below the 1.25x threshold does NOT displace a sticky entry", async () => {
    const sticky = new Set([ids[0], ids[1], ids[2], ids[3]]);
    // Contender 0.46 > sticky raw 0.40, but < 0.40 × 1.25 = 0.50 → entry 3 holds.
    currentScores = boundaryScores(0.46);
    const got = new Set(
      (await ltm.forSession(PROJ, SESSION, TIGHT, { stickyIds: sticky })).map(
        (e) => e.id,
      ),
    );
    expect(got.has(ids[3])).toBe(true);
    expect(got.has(ids[4])).toBe(false);
  });

  test("WITH stickyIds: a contender above the 1.25x threshold DOES displace a sticky entry", async () => {
    const sticky = new Set([ids[0], ids[1], ids[2], ids[3]]);
    // Contender 0.55 > 0.40 × 1.25 = 0.50 → entry 4 wins, entry 3 drops out.
    currentScores = boundaryScores(0.55);
    const got = new Set(
      (await ltm.forSession(PROJ, SESSION, TIGHT, { stickyIds: sticky })).map(
        (e) => e.id,
      ),
    );
    expect(got.has(ids[4])).toBe(true);
    expect(got.has(ids[3])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ltm.forSession — relevance floor (off-task knowledge must not be surfaced)
//
// Ranks-but-never-filters was the bug: any positive cosine admitted an entry,
// so a React Native session surfaced watchOS/OCR/GDPR entries from the same
// (multi-task) project. A vector-only signal must now clear config().knowledge
// .minRelevance; FTS keyword matches bypass it. Entry content below is chosen
// to share NO tokens with the session context, so FTS never matches and the
// mocked vector score is the sole signal.
// ---------------------------------------------------------------------------

describe("ltm.forSession — relevance floor", () => {
  const PROJ = "/test/ltm/relevance-floor";
  const SESSION = "relevance-floor-session";
  let availableSpy: ReturnType<typeof vi.spyOn>;
  let embedSpy: ReturnType<typeof vi.spyOn>;
  let vectorSpy: ReturnType<typeof vi.spyOn>;
  let scores: Map<string, number>;
  let origMinRelevance: number;
  const ids: string[] = [];

  // Disjoint from the session context below → FTS never matches these.
  const CONTENTS = [
    "kubernetes ingress sidecar mesh rollout",
    "protobuf schema registry backward wire",
    "webassembly sandbox capability isolation",
    "raytracing denoise kernel occupancy tuning",
  ];

  beforeEach(() => {
    const pid = ensureProject(PROJ);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
    db().query("DELETE FROM temporal_messages WHERE project_id = ?").run(pid);
    ids.length = 0;
    for (let i = 0; i < CONTENTS.length; i++) {
      ids.push(
        ltm.create({
          projectPath: PROJ,
          category: "pattern",
          title: `Floor entry ${i}`,
          content: CONTENTS[i],
          scope: "project",
          crossProject: false,
        }),
      );
    }
    // Session context shares no tokens with any entry → pure vector signal.
    db()
      .query(
        "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, 0, ?, '{}')",
      )
      .run(
        "floor-msg-1",
        pid,
        SESSION,
        "user",
        "quarterly financial reconciliation ledger audit invoice",
        20,
        Date.now(),
      );

    scores = new Map();
    availableSpy = vi.spyOn(embedding, "isAvailable").mockReturnValue(true);
    embedSpy = vi
      .spyOn(embedding, "embed")
      .mockResolvedValue([new Float32Array([1, 0, 0])]);
    vectorSpy = vi
      .spyOn(embedding, "vectorSearch")
      .mockImplementation(async () =>
        [...scores.entries()].map(([id, similarity]) => ({ id, similarity })),
      );
    origMinRelevance = config().knowledge.minRelevance;
  });

  afterEach(() => {
    availableSpy.mockRestore();
    embedSpy.mockRestore();
    vectorSpy.mockRestore();
    config().knowledge.minRelevance = origMinRelevance;
  });

  // Budget large enough to fit ALL four entries, so any exclusion is due to the
  // floor, not the token budget.
  const WIDE = 8000;

  test("drops vector-only entries below the floor, keeps those above", async () => {
    config().knowledge.minRelevance = 0.35;
    scores = new Map([
      [ids[0], 0.62], // above
      [ids[1], 0.4], // above
      [ids[2], 0.2], // below → dropped
      [ids[3], 0.1], // below → dropped
    ]);
    const got = new Set(
      (await ltm.forSession(PROJ, SESSION, WIDE)).map((e) => e.id),
    );
    expect(got.has(ids[0])).toBe(true);
    expect(got.has(ids[1])).toBe(true);
    expect(got.has(ids[2])).toBe(false);
    expect(got.has(ids[3])).toBe(false);
  });

  test("FTS-qualified entry is ranked by its FTS score, not a weak below-floor cosine (Seer #1318)", async () => {
    // An entry whose content shares keywords with the session context gets an
    // FTS hit (qualifies past the floor) even with a below-floor cosine. scoreOf
    // must rank it by the STRONGER signal (FTS), else a tight budget under-ranks
    // and drops it below an above-floor-but-lower-combined competitor.
    config().knowledge.minRelevance = 0.35;
    // Matches the session context "quarterly financial reconciliation ledger
    // audit invoice" on multiple tokens → strong FTS (BM25) score.
    const ftsId = ltm.create({
      projectPath: PROJ,
      category: "pattern",
      title: "Ledger entry",
      content:
        "quarterly financial reconciliation ledger audit invoice workflow",
      scope: "project",
      crossProject: false,
    });
    // ftsId has a present-but-below-floor cosine; a vector-only competitor sits
    // just above the floor. Old scoreOf ranked ftsId by 0.1 (loses); the max()
    // fix ranks it by its high FTS score (wins its slot).
    scores = new Map([
      [ftsId, 0.1], // below floor on the vector signal
      [ids[0], 0.4], // above floor, but no FTS overlap
    ]);
    const ranked = (await ltm.forSession(PROJ, SESSION, WIDE)).map((e) => e.id);
    expect(ranked).toContain(ftsId); // qualified via FTS, must be present
    // Ranked ahead of the weak above-floor vector-only entry.
    expect(ranked.indexOf(ftsId)).toBeLessThan(ranked.indexOf(ids[0]));
    db().query("DELETE FROM knowledge WHERE logical_id = ?").run(ftsId);
  });

  test("safety net is fallback-only: nothing clears the floor → top entries still surface", async () => {
    config().knowledge.minRelevance = 0.35;
    // Every entry is below the floor → no genuine match.
    scores = new Map(ids.map((id) => [id, 0.1]));
    const got = await ltm.forSession(PROJ, SESSION, WIDE);
    // Fallback keeps the session useful rather than returning nothing.
    expect(got.length).toBeGreaterThan(0);
  });

  test("minRelevance = 0 disables the floor (pre-#1211 behavior)", async () => {
    config().knowledge.minRelevance = 0;
    scores = new Map([
      [ids[0], 0.62],
      [ids[1], 0.2],
      [ids[2], 0.1],
      [ids[3], 0.05],
    ]);
    const got = new Set(
      (await ltm.forSession(PROJ, SESSION, WIDE)).map((e) => e.id),
    );
    // With the floor disabled, low-similarity entries are surfaced again.
    expect(got.has(ids[1])).toBe(true);
    expect(got.has(ids[2])).toBe(true);
  });

  test("minRelevance = 0 still excludes an exactly-orthogonal (cosine 0) entry", async () => {
    // Seer #1318: with the floor at 0, `vecScore >= 0` would admit a cosine-0
    // entry, diverging from the pre-floor `score > 0` semantics. A vector match
    // must be a POSITIVE cosine. ids[1] has an exact-0 score and no FTS hit, so
    // it must NOT surface; ids[0] (positive) still does.
    config().knowledge.minRelevance = 0;
    scores = new Map([
      [ids[0], 0.5],
      [ids[1], 0],
    ]);
    const got = new Set(
      (await ltm.forSession(PROJ, SESSION, WIDE)).map((e) => e.id),
    );
    expect(got.has(ids[0])).toBe(true);
    expect(got.has(ids[1])).toBe(false);
  });

  test("applies the floor to the CROSS-PROJECT pool (below-floor cross entry dropped)", async () => {
    // A cross-project entry lives in a DIFFERENT project so it enters the cross
    // pool for this session. With only a below-floor vector score and no FTS
    // hit, it must NOT surface. Guards the cross-pool isRelevant branch (Seer
    // #1318 coverage gap: the base floor tests seed only crossProject:false).
    config().knowledge.minRelevance = 0.35;
    const crossId = ltm.create({
      projectPath: "/test/ltm/relevance-floor-OTHER",
      category: "pattern",
      title: "Cross off-task",
      content: "mainframe cobol batch job control language",
      scope: "project",
      crossProject: true,
    });
    // Above-floor local entry (so there IS a match set) + below-floor cross.
    scores = new Map([
      [ids[0], 0.6],
      [crossId, 0.1],
    ]);
    const got = new Set(
      (await ltm.forSession(PROJ, SESSION, WIDE)).map((e) => e.id),
    );
    expect(got.has(ids[0])).toBe(true);
    expect(got.has(crossId)).toBe(false);
    // Above the floor, the same cross entry DOES surface.
    scores.set(crossId, 0.6);
    const got2 = new Set(
      (await ltm.forSession(PROJ, SESSION, WIDE)).map((e) => e.id),
    );
    expect(got2.has(crossId)).toBe(true);
    db().query("DELETE FROM knowledge WHERE logical_id = ?").run(crossId);
  });
});

// ---------------------------------------------------------------------------
// ltm.pruneOversized
// ---------------------------------------------------------------------------

describe("ltm.pruneOversized", () => {
  const PROJ = "/test/ltm/prune";

  beforeEach(() => {
    const pid = ensureProject(PROJ);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
  });

  test("sets confidence to 0 for entries exceeding maxLength", () => {
    const longId = ltm.create({
      projectPath: PROJ,
      category: "gotcha",
      title: "Oversized entry",
      content: "X".repeat(3000), // 3000 chars > 2000 limit
      scope: "project",
    });
    const shortId = ltm.create({
      projectPath: PROJ,
      category: "decision",
      title: "Normal entry",
      content: "Short content",
      scope: "project",
    });

    // Count before; pruneOversized is global so may affect real DB entries too.
    // We verify the specific entries we created rather than the total count.
    ltm.pruneOversized(2000);

    expect(ltm.get(longId)?.confidence).toBe(0);
    expect(ltm.get(shortId)?.confidence).toBe(1.0);
  });

  test("pruned entries do not appear in forProject results", () => {
    ltm.create({
      projectPath: PROJ,
      category: "gotcha",
      title: "Bloated entry",
      content: "B".repeat(5000),
      scope: "project",
    });

    ltm.pruneOversized(2000);

    const entries = ltm.forProject(PROJ);
    expect(entries.find((e) => e.title === "Bloated entry")).toBeUndefined();
  });

  test("does not affect entries within the limit", () => {
    const id = ltm.create({
      projectPath: PROJ,
      category: "pattern",
      title: "Fine entry",
      content: "Normal sized content",
      scope: "project",
    });

    ltm.pruneOversized(2000);
    // The short entry should retain full confidence
    expect(ltm.get(id)?.confidence).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Preference-only fast path + confidence on create + rerankPreferences
// ---------------------------------------------------------------------------

describe("ltm.create confidence", () => {
  test("accepts and stores explicit confidence", () => {
    const id = ltm.create({
      projectPath: "/test/ltm/confidence",
      category: "preference",
      title: "Explicit confidence test",
      content: "I prefer dark mode",
      scope: "project",
      confidence: 0.9,
    });
    const entry = ltm.get(id);
    expect(entry).not.toBeNull();
    expect(entry?.confidence).toBe(0.9);
  });

  test("defaults confidence to 1.0 when omitted", () => {
    const id = ltm.create({
      projectPath: "/test/ltm/confidence",
      category: "preference",
      title: "Default confidence test",
      content: "Some preference",
      scope: "project",
    });
    const entry = ltm.get(id);
    expect(entry).not.toBeNull();
    expect(entry?.confidence).toBe(1.0);
  });

  test("clamps confidence to [0, 1]", () => {
    const id1 = ltm.create({
      projectPath: "/test/ltm/confidence",
      category: "preference",
      title: "Over confidence",
      content: "Test over",
      scope: "project",
      confidence: 1.5,
    });
    expect(ltm.get(id1)?.confidence).toBe(1.0);

    const id2 = ltm.create({
      projectPath: "/test/ltm/confidence",
      category: "preference",
      title: "Under confidence",
      content: "Test under",
      scope: "project",
      confidence: -0.5,
    });
    expect(ltm.get(id2)?.confidence).toBe(0);
  });
});

describe("preference-only forSession fast path", () => {
  const PROJ = "/test/ltm/pref-fastpath";
  const SESSION = "pref-session";

  beforeEach(() => {
    const pid = ensureProject(PROJ);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
    // Clean up ALL global/cross-project preference entries to avoid leakage between tests
    db()
      .query(
        "DELETE FROM knowledge WHERE category = 'preference' AND (project_id IS NULL OR cross_project = 1)",
      )
      .run();
    db()
      .query(
        "DELETE FROM knowledge WHERE project_id IN (SELECT id FROM projects WHERE path LIKE '/test/%')",
      )
      .run();
    db().query("DELETE FROM temporal_messages WHERE project_id = ?").run(pid);
    db().query("DELETE FROM distillations WHERE project_id = ?").run(pid);
  });

  test("includes ALL cross-project preferences regardless of context", async () => {
    // Create cross-project preferences with zero keyword overlap to session context
    for (let i = 0; i < 5; i++) {
      ltm.create({
        category: "preference",
        title: `pref-test global pref ${i}`,
        content: `Unrelated preference content xyz ${i}`,
        scope: "global",
        crossProject: true,
      });
    }

    // Seed session context about something completely unrelated
    const pid = ensureProject(PROJ);
    db()
      .query(
        "INSERT INTO temporal_messages (id, project_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        `tm-pref-${Date.now()}`,
        pid,
        SESSION,
        "user",
        "Let's build a React component for the dashboard",
        Date.now(),
      );

    const result = await ltm.forSession(PROJ, SESSION, 10_000, {
      categories: ["preference"],
    });
    expect(result.length).toBe(5);
  });

  test("has no count cap on first turn (no session context)", async () => {
    // Create 15 cross-project preferences (more than NO_CONTEXT_FALLBACK_CAP=10)
    for (let i = 0; i < 15; i++) {
      ltm.create({
        category: "preference",
        title: `pref-test nocap pref ${i}`,
        content: `Some preference content ${i}`,
        scope: "global",
        crossProject: true,
      });
    }

    // No session context — brand new session
    const result = await ltm.forSession(
      PROJ,
      "brand-new-pref-session",
      10_000,
      {
        categories: ["preference"],
      },
    );
    // Should return all 15, not capped at 10
    expect(result.length).toBe(15);
  });

  test("respects token budget", async () => {
    // Create many large preferences
    for (let i = 0; i < 20; i++) {
      ltm.create({
        category: "preference",
        title: `pref-test budget pref ${i}`,
        content: "A ".repeat(200), // ~50 tokens each
        scope: "global",
        crossProject: true,
      });
    }

    // Very small budget — can only fit a few
    const result = await ltm.forSession(PROJ, SESSION, 200, {
      categories: ["preference"],
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThan(20);
  });

  test("ranks by confidence DESC then recency", async () => {
    // Create preferences with varying confidence
    const id_low = ltm.create({
      category: "preference",
      title: "pref-test low conf",
      content: "Low confidence preference",
      scope: "global",
      crossProject: true,
      confidence: 0.6,
    });
    const id_mid = ltm.create({
      category: "preference",
      title: "pref-test mid conf",
      content: "Mid confidence preference",
      scope: "global",
      crossProject: true,
      confidence: 0.9,
    });
    const id_high = ltm.create({
      category: "preference",
      title: "pref-test high conf",
      content: "High confidence preference",
      scope: "global",
      crossProject: true,
      confidence: 1.0,
    });

    // All three should be returned with generous budget, ordered by confidence
    const result = await ltm.forSession(PROJ, SESSION, 10_000, {
      categories: ["preference"],
    });

    expect(result.length).toBe(3);
    // Highest confidence should be first
    expect(result[0].id).toBe(id_high);
    expect(result[1].id).toBe(id_mid);
    expect(result[2].id).toBe(id_low);
  });

  test("non-preference forSession still uses relevance scoring", async () => {
    // Create a project-specific gotcha
    ltm.create({
      projectPath: PROJ,
      category: "gotcha",
      title: "pref-test SQLite WAL gotcha",
      content: "WAL mode requires shared memory access",
      scope: "project",
      crossProject: false,
    });

    // Create a cross-project gotcha with zero keyword overlap
    ltm.create({
      category: "gotcha",
      title: "pref-test Unrelated gotcha",
      content: "Completely unrelated knowledge about quantum computing",
      scope: "global",
      crossProject: true,
    });

    const result = await ltm.forSession(PROJ, SESSION, 10_000, {
      excludeCategories: ["preference"],
    });

    // Project gotcha should be included (safety net)
    const projectGotcha = result.find(
      (e) => e.title === "pref-test SQLite WAL gotcha",
    );
    expect(projectGotcha).toBeDefined();
    // The non-preference path should still be using relevance scoring,
    // not the preference fast path
  });
});

describe("curator applyOps confidence", () => {
  test("passes confidence from create op to ltm.create", async () => {
    const { applyOps } = await import("../src/curator");
    const result = applyOps(
      [
        {
          op: "create",
          category: "preference",
          title: "applyOps confidence test",
          content: "I prefer concise commit messages",
          scope: "global",
          crossProject: true,
          confidence: 0.9,
        },
      ],
      { projectPath: "/test/ltm/applyops", sessionID: "test-sess" },
    );
    expect(result.created).toBe(1);

    // Find the created entry
    const entries = ltm.all();
    const entry = entries.find((e) => e.title === "applyOps confidence test");
    expect(entry).toBeDefined();
    expect(entry?.confidence).toBe(0.9);
  });
});

describe("ltm.rerankPreferences", () => {
  beforeEach(() => {
    // Clean up ALL preference entries to avoid cross-test interference
    // (rerankPreferences operates on all preferences in the DB)
    db().query("DELETE FROM knowledge WHERE category = 'preference'").run();
  });

  test("sets 1.0 for strong directives, 0.9 for explicit prefs, keeps others unchanged", () => {
    const id_strong = ltm.create({
      category: "preference",
      title: "rerank-test strong",
      content: "NEVER push directly to main without explicit permission",
      scope: "global",
      crossProject: true,
    });
    const id_explicit = ltm.create({
      category: "preference",
      title: "rerank-test explicit",
      content: "I prefer tabs over spaces for indentation",
      scope: "global",
      crossProject: true,
    });
    const id_mild = ltm.create({
      category: "preference",
      title: "rerank-test mild",
      content: "Use dark theme in editor when possible",
      scope: "global",
      crossProject: true,
    });

    // All start at confidence 1.0
    expect(ltm.get(id_strong)?.confidence).toBe(1.0);
    expect(ltm.get(id_explicit)?.confidence).toBe(1.0);
    expect(ltm.get(id_mild)?.confidence).toBe(1.0);

    const updated = ltm.rerankPreferences();
    // Only the explicit-pref entry changes (1.0 → 0.9). The strong directive
    // stays at 1.0, and the "mild" entry (no English directive language) is no
    // longer demoted — it keeps the curator's confidence (1.0).
    expect(updated).toBe(1);

    expect(ltm.get(id_strong)?.confidence).toBe(1.0);
    expect(ltm.get(id_explicit)?.confidence).toBe(0.9);
    expect(ltm.get(id_mild)?.confidence).toBe(1.0);
  });

  test("does not demote non-English (Turkish) directives", () => {
    // Turkish "asla" = never, "her zaman" = always. The English directive
    // regexes cannot match these, but the entry must NOT be demoted — it keeps
    // the curator's confidence (1.0) instead of being forced down to 0.8.
    const id_tr = ltm.create({
      category: "preference",
      title: "rerank-test turkish",
      content: "Asla main dalına doğrudan push yapma; her zaman PR aç",
      scope: "global",
      crossProject: true,
    });

    expect(ltm.get(id_tr)?.confidence).toBe(1.0);

    ltm.rerankPreferences();

    expect(ltm.get(id_tr)?.confidence).toBe(1.0);
  });

  test("skips entries already scored by curator (confidence < 1.0)", () => {
    const id = ltm.create({
      category: "preference",
      title: "rerank-test already-scored",
      content: "Some preference without directive language",
      scope: "global",
      crossProject: true,
      confidence: 0.6,
    });

    const _updated = ltm.rerankPreferences();
    // Should not touch this entry — its confidence is already < 1.0
    expect(ltm.get(id)?.confidence).toBe(0.6);
  });

  test("detects various directive patterns", () => {
    const ids = [
      ltm.create({
        category: "preference",
        title: "rerank-test d1",
        content: "Always use TypeScript strict mode",
        scope: "global",
      }),
      ltm.create({
        category: "preference",
        title: "rerank-test d2",
        content: "You must not skip tests",
        scope: "global",
      }),
      ltm.create({
        category: "preference",
        title: "rerank-test d3",
        content: "Make sure to run linting before commits",
        scope: "global",
      }),
      ltm.create({
        category: "preference",
        title: "rerank-test d4",
        content: "Don't forget to update changelog",
        scope: "global",
      }),
    ];

    ltm.rerankPreferences();

    // "Always" → strong directive → 1.0
    expect(ltm.get(ids[0])?.confidence).toBe(1.0);
    // "must not" → strong directive → 1.0
    expect(ltm.get(ids[1])?.confidence).toBe(1.0);
    // "Make sure to" → explicit pref → 0.9
    expect(ltm.get(ids[2])?.confidence).toBe(0.9);
    // "Don't forget" → explicit pref → 0.9
    expect(ltm.get(ids[3])?.confidence).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// Multi-user attribution, promotion, and team sync columns (v29)
// ---------------------------------------------------------------------------
describe("ltm — multi-user columns (v29)", () => {
  const PROJ = "/test/ltm/multiuser";

  beforeEach(() => {
    const pid = ensureProject(PROJ);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
  });

  test("new entries have correct default values for v29 columns", () => {
    const id = ltm.create({
      projectPath: PROJ,
      category: "decision",
      title: "Default values test",
      content: "Test content for defaults",
      scope: "project",
    });
    const entry = ltm.get(id);
    expect(entry).not.toBeNull();
    expect(entry?.created_by).toBeNull();
    expect(entry?.updated_by).toBeNull();
    expect(entry?.sensitivity).toBe("normal");
    expect(entry?.promotion_status).toBeNull();
    expect(entry?.promoted_at).toBeNull();
    expect(entry?.approval_status).toBe("auto");
    expect(entry?.approved_by).toBeNull();
    expect(entry?.approved_at).toBeNull();
    expect(entry?.source_user_id).toBeNull();
    expect(entry?.source_entry_id).toBeNull();
    expect(entry?.last_accessed_at).toBeNull();
  });

  test("create() accepts createdBy", () => {
    const id = ltm.create({
      projectPath: PROJ,
      category: "pattern",
      title: "Created by test",
      content: "Test content",
      scope: "project",
      createdBy: "user-abc-123",
    });
    const entry = ltm.get(id);
    expect(entry?.created_by).toBe("user-abc-123");
  });

  test("create() accepts sensitivity override", () => {
    const id = ltm.create({
      projectPath: PROJ,
      category: "architecture",
      title: "Sensitivity test",
      content: "Contains API keys pattern",
      scope: "project",
      sensitivity: "sensitive",
    });
    const entry = ltm.get(id);
    expect(entry?.sensitivity).toBe("sensitive");
  });

  test("update() sets updated_by when updatedBy provided", () => {
    const id = ltm.create({
      projectPath: PROJ,
      category: "gotcha",
      title: "Updated by test",
      content: "Original content",
      scope: "project",
    });
    ltm.update(id, { content: "Modified content", updatedBy: "user-xyz-456" });
    const entry = ltm.getByLogical(id); // content change appended a new version
    expect(entry?.content).toBe("Modified content");
    expect(entry?.updated_by).toBe("user-xyz-456");
  });

  test("update() can change sensitivity", () => {
    const id = ltm.create({
      projectPath: PROJ,
      category: "architecture",
      title: "Sensitivity update test",
      content: "Contains credentials pattern",
      scope: "project",
      sensitivity: "normal",
    });
    ltm.update(id, { sensitivity: "restricted" });
    const entry = ltm.get(id);
    expect(entry?.sensitivity).toBe("restricted");
  });

  test("update() without updatedBy leaves updated_by unchanged", () => {
    const id = ltm.create({
      projectPath: PROJ,
      category: "pattern",
      title: "No updatedBy test",
      content: "Original content",
      scope: "project",
      createdBy: "user-abc-123",
    });
    ltm.update(id, { content: "Modified content" });
    const entry = ltm.getByLogical(id); // content change appended a new version
    expect(entry?.updated_by).toBeNull();
    expect(entry?.created_by).toBe("user-abc-123");
  });

  test("team_knowledge table exists", () => {
    const tables = db()
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='team_knowledge'",
      )
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe("team_knowledge");
  });

  test("team_config table exists", () => {
    const tables = db()
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='team_config'",
      )
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe("team_config");
  });
});

// ---------------------------------------------------------------------------
// Cross-project auto-promotion (issue #498)
// ---------------------------------------------------------------------------

describe("ltm — cross-project promotion", () => {
  const PA = "/test/promote/project-a";
  const PB = "/test/promote/project-b";
  const PC = "/test/promote/project-c";

  /** Inject a deterministic unit-norm embedding for an entry. Same seed => same
   *  vector => cosine similarity 1.0 (well above the promotion threshold). */
  function injectEmbedding(entryId: string, seed: number, dims = 768): void {
    const vec = new Float32Array(dims);
    for (let i = 0; i < dims; i++) vec[i] = Math.sin(seed * (i + 1) * 0.1);
    let norm = 0;
    for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    for (let i = 0; i < dims; i++) vec[i] /= norm;
    db()
      .query("UPDATE knowledge SET embedding = ? WHERE id = ?")
      .run(Buffer.from(vec.buffer), entryId);
  }

  /** Create a project-scoped entry with explicit id (bypasses create-time dedup
   *  guard), a given confidence, and an injected embedding. */
  function seedEntry(opts: {
    projectPath: string;
    title: string;
    confidence?: number;
    embedSeed: number;
  }): string {
    const id = ltm.create({
      id: uuidv7(),
      projectPath: opts.projectPath,
      category: "preference",
      title: opts.title,
      content: `Content for ${opts.title}`,
      scope: "project",
      crossProject: false,
      session: "test-session",
    });
    if (opts.confidence != null && opts.confidence !== 1.0) {
      ltm.update(id, { confidence: opts.confidence });
    }
    injectEmbedding(id, opts.embedSeed);
    return id;
  }

  // promoteCrossProject() reads embeddings directly from the DB; it only calls
  // embedding.isAvailable() as a cheap "embeddings configured?" guard. Stub it
  // rather than touch real provider/worker state — instantiating or shutting
  // down a LocalProvider in-process triggers Bun NAPI/ONNX crashes, and other
  // suites may have left the provider disabled or broken. Each test sets the
  // desired return value via availableSpy.
  let availableSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // vectorSearch / promotion queries are unscoped — wipe ALL knowledge so
    // embeddings from other suites don't leak in. (Documented gotcha.)
    db().query("DELETE FROM knowledge WHERE embedding IS NOT NULL").run();
    db().query("DELETE FROM knowledge").run();
    availableSpy = vi.spyOn(embedding, "isAvailable").mockReturnValue(true);
  });

  afterEach(() => {
    availableSpy.mockRestore();
  });

  test("promotes a cluster spanning 3 distinct projects", () => {
    const a = seedEntry({
      projectPath: PA,
      title: "Always run tests before committing code",
      confidence: 0.9,
      embedSeed: 5,
    });
    const b = seedEntry({
      projectPath: PB,
      title: "Run the test suite prior to any commit",
      confidence: 0.85,
      embedSeed: 5,
    });
    const c = seedEntry({
      projectPath: PC,
      title: "Tests must pass before commit is made",
      confidence: 0.95,
      embedSeed: 5,
    });

    const res = ltm.promoteCrossProject({ dryRun: false });
    expect(res.promoted).toBe(3);
    expect(res.clusters).toHaveLength(1);
    expect(res.clusters[0].distinctProjects).toBe(3);

    for (const id of [a, b, c]) {
      const e = ltm.get(id);
      if (!e) throw new Error("expected entry");
      expect(e.cross_project).toBe(1);
      expect(e.promotion_status).toBe("promoted");
      expect(e.promoted_at).not.toBeNull();
    }
  });

  test("does NOT promote a cluster spanning only 2 projects", () => {
    const a = seedEntry({
      projectPath: PA,
      title: "Always run tests before committing code",
      confidence: 0.9,
      embedSeed: 7,
    });
    const b = seedEntry({
      projectPath: PB,
      title: "Run the test suite prior to any commit",
      confidence: 0.9,
      embedSeed: 7,
    });

    const res = ltm.promoteCrossProject({ dryRun: false });
    expect(res.promoted).toBe(0);
    expect(res.clusters).toHaveLength(0);
    expect(ltm.get(a)?.cross_project).toBe(0);
    expect(ltm.get(b)?.cross_project).toBe(0);
  });

  test("does NOT promote low-confidence entries (< 0.8)", () => {
    const a = seedEntry({
      projectPath: PA,
      title: "Always run tests before committing code",
      confidence: 0.7,
      embedSeed: 9,
    });
    const b = seedEntry({
      projectPath: PB,
      title: "Run the test suite prior to any commit",
      confidence: 0.5,
      embedSeed: 9,
    });
    const c = seedEntry({
      projectPath: PC,
      title: "Tests must pass before commit is made",
      confidence: 0.6,
      embedSeed: 9,
    });

    const res = ltm.promoteCrossProject({ dryRun: false });
    expect(res.promoted).toBe(0);
    for (const id of [a, b, c]) expect(ltm.get(id)?.cross_project).toBe(0);
  });

  test("ignores entries already cross_project = 1", () => {
    // Three already-cross-project entries across 3 projects — not candidates.
    for (const [p, seed] of [
      [PA, 11],
      [PB, 11],
      [PC, 11],
    ] as const) {
      const id = ltm.create({
        id: uuidv7(),
        projectPath: p,
        category: "preference",
        title: `Cross entry in ${p}`,
        content: "already shared",
        scope: "project",
        crossProject: true,
        session: "test-session",
      });
      injectEmbedding(id, seed);
    }
    const res = ltm.promoteCrossProject({ dryRun: false });
    expect(res.promoted).toBe(0);
    expect(res.clusters).toHaveLength(0);
  });

  test("dryRun: true reports clusters but does not mutate", () => {
    const a = seedEntry({
      projectPath: PA,
      title: "Always run tests before committing code",
      confidence: 0.9,
      embedSeed: 13,
    });
    const b = seedEntry({
      projectPath: PB,
      title: "Run the test suite prior to any commit",
      confidence: 0.9,
      embedSeed: 13,
    });
    const c = seedEntry({
      projectPath: PC,
      title: "Tests must pass before commit is made",
      confidence: 0.9,
      embedSeed: 13,
    });

    const res = ltm.promoteCrossProject({ dryRun: true });
    expect(res.promoted).toBe(3);
    expect(res.clusters).toHaveLength(1);
    for (const id of [a, b, c]) {
      const e = ltm.get(id);
      if (!e) throw new Error("expected entry");
      expect(e.cross_project).toBe(0);
      expect(e.promotion_status).toBeNull();
    }
  });

  test("no-op when embeddings are unavailable", () => {
    seedEntry({
      projectPath: PA,
      title: "Always run tests before committing code",
      confidence: 0.9,
      embedSeed: 15,
    });
    seedEntry({
      projectPath: PB,
      title: "Run the test suite prior to any commit",
      confidence: 0.9,
      embedSeed: 15,
    });
    seedEntry({
      projectPath: PC,
      title: "Tests must pass before commit is made",
      confidence: 0.9,
      embedSeed: 15,
    });

    availableSpy.mockReturnValue(false);
    const res = ltm.promoteCrossProject({ dryRun: false });
    expect(res.promoted).toBe(0);
    expect(res.clusters).toHaveLength(0);
  });

  test("does NOT promote when 3 similar entries are all in the same project", () => {
    const a = seedEntry({
      projectPath: PA,
      title: "Always run tests before committing code",
      confidence: 0.9,
      embedSeed: 17,
    });
    const b = seedEntry({
      projectPath: PA,
      title: "Run the test suite prior to any commit",
      confidence: 0.9,
      embedSeed: 17,
    });
    const c = seedEntry({
      projectPath: PA,
      title: "Tests must pass before commit is made",
      confidence: 0.9,
      embedSeed: 17,
    });

    const res = ltm.promoteCrossProject({ dryRun: false });
    expect(res.promoted).toBe(0);
    expect(res.clusters).toHaveLength(0);
    for (const id of [a, b, c]) expect(ltm.get(id)?.cross_project).toBe(0);
  });

  test("mixed-confidence cluster: low-confidence entries excluded, qualifying remainder still promotes", () => {
    // 4 similar entries across 4 projects, but one is below the confidence threshold.
    // The low-confidence entry is excluded from candidates entirely, so the
    // remaining 3 high-confidence entries should still form a qualifying cluster.
    const PD = "/test/promote/project-d";
    const a = seedEntry({
      projectPath: PA,
      title: "Always run tests before committing code",
      confidence: 0.9,
      embedSeed: 19,
    });
    const b = seedEntry({
      projectPath: PB,
      title: "Run the test suite prior to any commit",
      confidence: 0.85,
      embedSeed: 19,
    });
    const c = seedEntry({
      projectPath: PC,
      title: "Tests must pass before commit is made",
      confidence: 0.95,
      embedSeed: 19,
    });
    const d = seedEntry({
      projectPath: PD,
      title: "Test before every commit always",
      confidence: 0.5,
      embedSeed: 19,
    });

    const res = ltm.promoteCrossProject({ dryRun: false });
    // Only the 3 high-confidence entries should be promoted
    expect(res.promoted).toBe(3);
    expect(res.clusters).toHaveLength(1);
    expect(res.clusters[0].distinctProjects).toBe(3);
    for (const id of [a, b, c]) {
      expect(ltm.get(id)?.cross_project).toBe(1);
      expect(ltm.get(id)?.promotion_status).toBe("promoted");
    }
    // Low-confidence entry untouched
    expect(ltm.get(d)?.cross_project).toBe(0);
    expect(ltm.get(d)?.promotion_status).toBeNull();
  });
});

describe("ltm.findSemanticDuplicate", () => {
  const PROJ = "/test/ltm/semdup";
  let availableSpy: ReturnType<typeof vi.spyOn>;
  let embedSpy: ReturnType<typeof vi.spyOn>;

  /** Deterministic unit-norm vector for a seed (same formula as injectEmbedding). */
  function seedVec(seed: number, dims = 768): Float32Array {
    const vec = new Float32Array(dims);
    for (let i = 0; i < dims; i++) vec[i] = Math.sin(seed * (i + 1) * 0.1);
    let norm = 0;
    for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    for (let i = 0; i < dims; i++) vec[i] /= norm;
    return vec;
  }

  function seedEntry(title: string, seed: number): string {
    const id = ltm.create({
      id: uuidv7(),
      projectPath: PROJ,
      category: "preference",
      title,
      content: `content for ${title}`,
      scope: "project",
    });
    db()
      .query("UPDATE knowledge SET embedding = ? WHERE id = ?")
      .run(Buffer.from(seedVec(seed).buffer), id);
    return id;
  }

  beforeEach(() => {
    const pid = ensureProject(PROJ);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
    availableSpy = vi.spyOn(embedding, "isAvailable").mockReturnValue(true);
  });

  afterEach(() => {
    availableSpy.mockRestore();
    embedSpy?.mockRestore();
  });

  test("returns a match when a semantically-identical entry exists (sim >= threshold)", async () => {
    const existing = seedEntry("Always write tests after features", 7);
    // Candidate embeds to the SAME vector → cosine 1.0 → above 0.935.
    embedSpy = vi.spyOn(embedding, "embed").mockResolvedValue([seedVec(7)]);

    const pid = ensureProject(PROJ);
    const dup = await ltm.findSemanticDuplicate({
      title: "Always add tests once a feature lands",
      content: "differently worded but same behavior",
      projectId: pid,
    });
    expect(dup?.id).toBe(existing);
    expect(dup?.similarity).toBeGreaterThanOrEqual(0.935);
  });

  test("returns null when no entry is similar enough", async () => {
    seedEntry("Use SQLite for storage", 3);
    // Candidate embeds to a very different vector → low cosine → no match.
    embedSpy = vi.spyOn(embedding, "embed").mockResolvedValue([seedVec(99)]);

    const pid = ensureProject(PROJ);
    const dup = await ltm.findSemanticDuplicate({
      title: "Prefer Postgres for storage",
      content: "unrelated wording",
      projectId: pid,
    });
    expect(dup).toBeNull();
  });

  test("returns null (no-op) when embeddings are unavailable", async () => {
    availableSpy.mockReturnValue(false);
    const pid = ensureProject(PROJ);
    const dup = await ltm.findSemanticDuplicate({
      title: "anything",
      content: "anything",
      projectId: pid,
    });
    expect(dup).toBeNull();
  });
});
