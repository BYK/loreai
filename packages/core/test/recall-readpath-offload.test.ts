import { uuidv7 } from "uuidv7";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { db, ensureProject } from "../src/db";
import * as embedding from "../src/embedding";
import * as entities from "../src/entities";
import * as ltm from "../src/ltm";
import { searchRecall } from "../src/recall";

// PR3 (#966): recall's entity FTS scans and per-vector-hit single-row
// hydration are routed off the main event loop. Hydration loops are now a
// single batched `WHERE id IN (...)` scan; entity FTS uses async offloaded
// variants. In the unit-test runtime the read-worker pool is disabled
// (NODE_ENV==="test", no factory), so `offloadAll` executes in-process — these
// tests therefore assert behavioural parity with the previous synchronous code.

// ---------------------------------------------------------------------------
// entities.searchAsync / searchCrossProjectReposAsync — parity with sync
// ---------------------------------------------------------------------------

describe("entities.searchAsync — parity with search() (#966)", () => {
  const PROJECT = "/test/offload/entities-search";

  beforeEach(() => {
    const pid = ensureProject(PROJECT);
    db().query("DELETE FROM entities WHERE project_id = ?").run(pid);
  });

  test("returns identical ids, order and aliases to sync search()", async () => {
    entities.create({
      projectPath: PROJECT,
      entityType: "service",
      canonicalName: "Zorptron Telemetry",
      aliases: [{ type: "url", value: "zorptron.example" }],
    });
    entities.create({
      projectPath: PROJECT,
      entityType: "tool",
      canonicalName: "Zorptron Buildkit",
    });

    const sync = entities.search({ query: "Zorptron", projectPath: PROJECT });
    const asyncRes = await entities.searchAsync({
      query: "Zorptron",
      projectPath: PROJECT,
    });

    expect(asyncRes.length).toBeGreaterThan(0);
    expect(asyncRes.map((e) => e.id)).toEqual(sync.map((e) => e.id));
    // Aliases hydrated identically (proves withAliasesOffloaded parity)
    expect(asyncRes.map((e) => e.aliases.map((a) => a.alias_value))).toEqual(
      sync.map((e) => e.aliases.map((a) => a.alias_value)),
    );
  });

  test("matches by alias too, like sync search()", async () => {
    const ent = entities.create({
      projectPath: PROJECT,
      entityType: "service",
      canonicalName: "Quuxbase",
      aliases: [{ type: "name", value: "quuxdb-handle" }],
    });
    const asyncRes = await entities.searchAsync({
      query: "quuxdb-handle",
      projectPath: PROJECT,
    });
    expect(asyncRes.map((e) => e.id)).toContain(ent.id);
  });

  test("empty query short-circuits to [] (matches sync)", async () => {
    expect(
      await entities.searchAsync({ query: "", projectPath: PROJECT }),
    ).toEqual([]);
    expect(entities.search({ query: "", projectPath: PROJECT })).toEqual([]);
  });
});

describe("entities.searchCrossProjectReposAsync — parity (#966)", () => {
  const PROJECT = "/test/offload/xrepo-current";
  const OTHER = "/test/offload/xrepo-other";

  beforeEach(() => {
    db()
      .query("DELETE FROM entities WHERE project_id = ?")
      .run(ensureProject(PROJECT));
    db()
      .query("DELETE FROM entities WHERE project_id = ?")
      .run(ensureProject(OTHER));
  });

  test("finds a repo owned by another project, identical to sync", async () => {
    const repo = entities.create({
      projectPath: OTHER,
      entityType: "repo",
      canonicalName: "wizbang-cli-typescript",
    });
    const sync = entities.searchCrossProjectRepos({
      query: "wizbang-cli-typescript",
      excludeProjectPath: PROJECT,
    });
    const asyncRes = await entities.searchCrossProjectReposAsync({
      query: "wizbang-cli-typescript",
      excludeProjectPath: PROJECT,
    });
    expect(asyncRes.map((e) => e.id)).toContain(repo.id);
    expect(asyncRes.map((e) => e.id)).toEqual(sync.map((e) => e.id));
  });

  test("excludes the excluded project's own repos (matches sync)", async () => {
    const own = entities.create({
      projectPath: PROJECT,
      entityType: "repo",
      canonicalName: "wizbang-homerepo",
    });
    const asyncRes = await entities.searchCrossProjectReposAsync({
      query: "wizbang-homerepo",
      excludeProjectPath: PROJECT,
    });
    expect(asyncRes.map((e) => e.id)).not.toContain(own.id);
  });
});

// ---------------------------------------------------------------------------
// entities.getManyWithAliasesOffloaded — batch entity vector hydration
// ---------------------------------------------------------------------------

describe("entities.getManyWithAliasesOffloaded (#966)", () => {
  const PROJECT = "/test/offload/getmany-entities";

  beforeEach(() => {
    db()
      .query("DELETE FROM entities WHERE project_id = ?")
      .run(ensureProject(PROJECT));
  });

  test("hydrates entities + aliases keyed by id, parity with getWithAliases()", async () => {
    const a = entities.create({
      projectPath: PROJECT,
      entityType: "person",
      canonicalName: "Hydra Alpha",
      aliases: [{ type: "nickname", value: "Al" }],
    });
    const b = entities.create({
      projectPath: PROJECT,
      entityType: "person",
      canonicalName: "Hydra Beta",
    });

    const map = await entities.getManyWithAliasesOffloaded([a.id, b.id]);
    expect(map.size).toBe(2);
    expect(map.get(a.id)).toEqual(entities.getWithAliases(a.id));
    expect(map.get(b.id)).toEqual(entities.getWithAliases(b.id));
    expect(map.get(a.id)?.aliases.map((x) => x.alias_value)).toContain("Al");
  });

  test("alias ordering matches getWithAliases for a multi-alias entity", async () => {
    // Guards the offloaded `ORDER BY alias_type, alias_value` — a single-alias
    // entity can't catch an ordering regression, so seed several aliases across
    // types and assert the offloaded hydration preserves the same order.
    const ent = entities.create({
      projectPath: PROJECT,
      entityType: "person",
      canonicalName: "Multi Alias Person",
      aliases: [
        { type: "nickname", value: "Zed" },
        { type: "nickname", value: "Abe" },
        { type: "github", value: "ghhandle" },
        { type: "email", value: "x@example.test" },
      ],
    });
    const map = await entities.getManyWithAliasesOffloaded([ent.id]);
    const offloadedOrder = map
      .get(ent.id)
      ?.aliases.map((a) => `${a.alias_type}:${a.alias_value}`);
    const syncOrder = entities
      .getWithAliases(ent.id)
      ?.aliases.map((a) => `${a.alias_type}:${a.alias_value}`);
    expect(offloadedOrder).toEqual(syncOrder);
    // And the order is the documented (alias_type, alias_value) sort. create()
    // also auto-adds a `name:` alias from the canonical name.
    expect(offloadedOrder).toEqual([
      "email:x@example.test",
      "github:ghhandle",
      "name:Multi Alias Person",
      "nickname:Abe",
      "nickname:Zed",
    ]);
  });

  test("empty id list → empty map (no query issued)", async () => {
    expect((await entities.getManyWithAliasesOffloaded([])).size).toBe(0);
  });

  test("ids with no live row are absent from the map", async () => {
    const map = await entities.getManyWithAliasesOffloaded([
      "019eac47-0000-0000-0000-000000000000",
    ]);
    expect(map.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ltm.getManyOffloaded — batch knowledge vector hydration
// ---------------------------------------------------------------------------

describe("ltm.getManyOffloaded (#966)", () => {
  const PROJ = "/test/offload/ltm-getmany";

  beforeEach(() => {
    db()
      .query("DELETE FROM knowledge WHERE project_id = ?")
      .run(ensureProject(PROJ));
  });

  test("batch-hydrates current entries keyed by id, parity with get()", async () => {
    const id1 = ltm.create({
      projectPath: PROJ,
      scope: "project",
      category: "decision",
      title: "Getmany One",
      content: "body one",
    });
    const id2 = ltm.create({
      projectPath: PROJ,
      scope: "project",
      category: "pattern",
      title: "Getmany Two",
      content: "body two",
    });

    const map = await ltm.getManyOffloaded([id1, id2]);
    expect(map.size).toBe(2);
    expect(map.get(id1)).toEqual(ltm.get(id1));
    expect(map.get(id2)?.title).toBe("Getmany Two");
  });

  test("empty id list → empty map", async () => {
    expect((await ltm.getManyOffloaded([])).size).toBe(0);
  });

  test("unknown id is absent from the map", async () => {
    const map = await ltm.getManyOffloaded([
      "019eac47-0000-0000-0000-000000000000",
    ]);
    expect(map.size).toBe(0);
  });

  test("excludes superseded versions — knowledge_current parity with get()", async () => {
    const id = ltm.create({
      projectPath: PROJ,
      scope: "project",
      category: "decision",
      title: "Versioned Entry",
      content: "v1 body",
    });
    ltm.update(id, { content: "v2 body" }); // appends a version → id superseded
    // get() reads knowledge_current (is_current=1) so the superseded row misses.
    expect(ltm.get(id)).toBeNull();
    const map = await ltm.getManyOffloaded([id]);
    expect(map.has(id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// recall vector-hit hydration — batched + offloaded, ordering + miss-drop
// ---------------------------------------------------------------------------

describe("recall vector-hit hydration is batched + offloaded (#966)", () => {
  const PROJ = "/test/offload/recall-vec";
  const SESSION = "offload-vec-session";

  let availableSpy: ReturnType<typeof vi.spyOn>;
  let embedSpy: ReturnType<typeof vi.spyOn>;
  let kSpy: ReturnType<typeof vi.spyOn>;
  let dSpy: ReturnType<typeof vi.spyOn>;
  let tSpy: ReturnType<typeof vi.spyOn>;
  let eSpy: ReturnType<typeof vi.spyOn>;

  function seedTemporal(content: string): string {
    const pid = ensureProject(PROJ);
    const id = uuidv7();
    db()
      .query(
        "INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, 0, ?, '{}')",
      )
      .run(id, pid, SESSION, "user", content, 20, Date.now());
    return id;
  }

  function seedDistillation(observations: string): string {
    const pid = ensureProject(PROJ);
    const id = uuidv7();
    db()
      .query(
        `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, archived, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        pid,
        SESSION,
        "",
        "[]",
        observations,
        "[]",
        0,
        Math.ceil(observations.length / 3),
        0,
        Date.now(),
      );
    return id;
  }

  beforeEach(() => {
    const pid = ensureProject(PROJ);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
    db().query("DELETE FROM distillations WHERE project_id = ?").run(pid);
    db().query("DELETE FROM temporal_messages WHERE project_id = ?").run(pid);
    db().query("DELETE FROM entities WHERE project_id = ?").run(pid);

    availableSpy = vi.spyOn(embedding, "isAvailable").mockReturnValue(true);
    embedSpy = vi
      .spyOn(embedding, "embed")
      .mockResolvedValue([new Float32Array([1, 0, 0])]);
    // Default every vector search to empty; each test overrides the one it needs.
    kSpy = vi.spyOn(embedding, "vectorSearch").mockResolvedValue([]);
    dSpy = vi
      .spyOn(embedding, "vectorSearchDistillations")
      .mockResolvedValue([]);
    tSpy = vi.spyOn(embedding, "vectorSearchTemporal").mockResolvedValue([]);
    eSpy = vi.spyOn(embedding, "vectorSearchEntities").mockResolvedValue([]);
  });

  afterEach(() => {
    availableSpy.mockRestore();
    embedSpy.mockRestore();
    kSpy.mockRestore();
    dSpy.mockRestore();
    tSpy.mockRestore();
    eSpy.mockRestore();
  });

  test("hydrates distillation vector hits and drops misses", async () => {
    // Non-matching observation text so the row is surfaced ONLY via the vector
    // stub (not BM25) — proves hydrateVectorRows fetched it.
    const distId = seedDistillation("qqzz vector-only distillation payload");
    dSpy.mockResolvedValue([
      { id: distId, similarity: 0.9 },
      { id: uuidv7(), similarity: 0.5 }, // miss → dropped, must not crash
    ]);

    const results = await searchRecall({
      query: "totallyunrelatedtoken",
      projectPath: PROJ,
      scope: "all",
    });
    const distIds = results
      .filter((r) => r.item.source === "distillation")
      .map((r) => r.item.item.id);
    expect(distIds).toContain(distId);
    expect(distIds.length).toBe(1); // the miss was dropped
  });

  test("hydrates temporal vector hits and drops misses", async () => {
    const tId = seedTemporal("qqzz vector-only temporal payload");
    tSpy.mockResolvedValue([
      { id: tId, similarity: 0.9 },
      { id: uuidv7(), similarity: 0.5 },
    ]);

    const results = await searchRecall({
      query: "totallyunrelatedtoken",
      projectPath: PROJ,
      scope: "all",
    });
    const tIds = results
      .filter((r) => r.item.source === "temporal")
      .map((r) => r.item.item.id);
    expect(tIds).toContain(tId);
    expect(tIds.length).toBe(1);
  });

  test("hydrates knowledge vector hits via getManyOffloaded", async () => {
    const kId = ltm.create({
      projectPath: PROJ,
      scope: "project",
      category: "decision",
      title: "Vectoronly Knowledge",
      content: "qqzz vector-only knowledge payload",
    });
    kSpy.mockResolvedValue([
      { id: kId, similarity: 0.9 },
      { id: "019eac47-0000-0000-0000-000000000000", similarity: 0.4 },
    ]);

    const results = await searchRecall({
      query: "totallyunrelatedtoken",
      projectPath: PROJ,
      scope: "all",
    });
    const kIds = results
      .filter((r) => r.item.source === "knowledge")
      .map((r) => r.item.item.id);
    expect(kIds).toContain(kId);
    expect(kIds).not.toContain("019eac47-0000-0000-0000-000000000000");
  });

  test("hydrates entity vector hits + preserves the visibility predicate", async () => {
    const visible = entities.create({
      projectPath: PROJ,
      entityType: "person",
      canonicalName: "Vectoronly Visible",
    });
    // A project-scoped infra entity owned by ANOTHER project must be filtered
    // out by the visibility predicate even when the vector stub returns it.
    const hidden = entities.create({
      projectPath: "/test/offload/recall-vec-other",
      entityType: "infra",
      canonicalName: "Vectoronly Hidden Infra",
    });
    eSpy.mockResolvedValue([
      { id: visible.id, similarity: 0.9 },
      { id: hidden.id, similarity: 0.8 },
    ]);

    const results = await searchRecall({
      query: "totallyunrelatedtoken",
      projectPath: PROJ,
      scope: "all",
    });
    const entIds = results
      .filter((r) => r.item.source === "entity")
      .map((r) => r.item.item.id);
    expect(entIds).toContain(visible.id);
    expect(entIds).not.toContain(hidden.id);
  });
});
