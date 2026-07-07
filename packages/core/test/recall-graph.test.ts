import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LoreConfig } from "../src/config";
import { db, ensureProject } from "../src/db";
import * as embedding from "../src/embedding";
import * as entities from "../src/entities";
import * as ltm from "../src/ltm";
import { searchRecall } from "../src/recall";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function cleanup() {
  const d = db();
  d.exec("DELETE FROM entity_relations");
  d.exec("DELETE FROM knowledge_entity_refs");
  d.exec("DELETE FROM entity_aliases");
  d.exec("DELETE FROM entities");
  d.exec("DELETE FROM knowledge");
}

/** Create a project-scoped knowledge entry and link it to an entity. Returns
 *  the stable logical_id. The title/content intentionally avoid the entity's
 *  name so the entry is reachable ONLY through the entity graph. */
function seedLinkedKnowledge(input: {
  projectPath: string;
  entityId: string;
  title: string;
  content: string;
  crossProject?: boolean;
}): string {
  const id = ltm.create({
    projectPath: input.projectPath,
    scope: "project",
    category: "decision",
    title: input.title,
    content: input.content,
    crossProject: input.crossProject,
  });
  entities.linkKnowledge(id, input.entityId);
  return id;
}

// ---------------------------------------------------------------------------
// Unit tests — entities.graphExpand
// ---------------------------------------------------------------------------

describe("entities.graphExpand — graph traversal scoring", () => {
  const PROJECT = "/test/recall-graph/unit";

  beforeEach(() => {
    cleanup();
    ensureProject(PROJECT);
  });

  test("empty seeds yield an empty expansion", () => {
    expect(entities.graphExpand([])).toEqual({ knowledge: [], entities: [] });
  });

  test("a seed's directly-linked knowledge is depth 0, reach 1", () => {
    const e = entities.create({
      entityType: "person",
      canonicalName: "Seed Person",
      crossProject: true,
    });
    const k = seedLinkedKnowledge({
      projectPath: PROJECT,
      entityId: e.id,
      title: "Anniversary dinner",
      content: "Reserve the corner table by the window.",
    });

    const exp = entities.graphExpand([e.id]);
    const hit = exp.knowledge.find((x) => x.logicalId === k);
    expect(hit).toBeDefined();
    expect(hit?.depth).toBe(0);
    expect(hit?.reach).toBe(1);
  });

  test("a 1-hop relation neighbor surfaces as a depth-1 entity, and its knowledge as depth-1 knowledge", () => {
    const a = entities.create({
      entityType: "person",
      canonicalName: "Alpha",
      crossProject: true,
    });
    const b = entities.create({
      entityType: "person",
      canonicalName: "Bravo",
      crossProject: true,
    });
    entities.addRelation(a.id, b.id, "colleague", { source: "test" });
    const kb = seedLinkedKnowledge({
      projectPath: PROJECT,
      entityId: b.id,
      title: "Deploy checklist",
      content: "Restart the worker after pulling.",
    });

    const exp = entities.graphExpand([a.id]);

    const neighbor = exp.entities.find((x) => x.id === b.id);
    expect(neighbor).toBeDefined();
    expect(neighbor?.depth).toBe(1);

    const kHit = exp.knowledge.find((x) => x.logicalId === kb);
    expect(kHit).toBeDefined();
    expect(kHit?.depth).toBe(1);
  });

  test("depth-0 knowledge outranks depth-1 knowledge", () => {
    const a = entities.create({
      entityType: "person",
      canonicalName: "Root",
      crossProject: true,
    });
    const n = entities.create({
      entityType: "person",
      canonicalName: "Neighbor",
      crossProject: true,
    });
    entities.addRelation(a.id, n.id, "colleague", { source: "test" });
    const kDirect = seedLinkedKnowledge({
      projectPath: PROJECT,
      entityId: a.id,
      title: "Direct fact",
      content: "Linked straight to the seed.",
    });
    const kNeighbor = seedLinkedKnowledge({
      projectPath: PROJECT,
      entityId: n.id,
      title: "Neighbor fact",
      content: "Linked only to the neighbor.",
    });

    const exp = entities.graphExpand([a.id]);
    const direct = exp.knowledge.find((x) => x.logicalId === kDirect);
    const neighbor = exp.knowledge.find((x) => x.logicalId === kNeighbor);
    expect(direct).toBeDefined();
    expect(neighbor).toBeDefined();
    expect((direct?.score ?? 0) > (neighbor?.score ?? 0)).toBe(true);
    // Ordering must reflect the scores: direct appears before neighbor.
    const di = exp.knowledge.findIndex((x) => x.logicalId === kDirect);
    const ni = exp.knowledge.findIndex((x) => x.logicalId === kNeighbor);
    expect(di).toBeLessThan(ni);
  });

  test("knowledge reached by multiple seeds outranks single-seed knowledge at the same depth", () => {
    const s1 = entities.create({
      entityType: "person",
      canonicalName: "S One",
      crossProject: true,
    });
    const s2 = entities.create({
      entityType: "person",
      canonicalName: "S Two",
      crossProject: true,
    });
    const shared = seedLinkedKnowledge({
      projectPath: PROJECT,
      entityId: s1.id,
      title: "Shared fact",
      content: "Referenced by two seeds.",
    });
    entities.linkKnowledge(shared, s2.id); // now reach 2
    const lone = seedLinkedKnowledge({
      projectPath: PROJECT,
      entityId: s1.id,
      title: "Lone fact",
      content: "Referenced by one seed.",
    });

    const exp = entities.graphExpand([s1.id, s2.id]);
    const sharedHit = exp.knowledge.find((x) => x.logicalId === shared);
    const loneHit = exp.knowledge.find((x) => x.logicalId === lone);
    expect(sharedHit?.reach).toBe(2);
    expect(loneHit?.reach).toBe(1);
    expect((sharedHit?.score ?? 0) > (loneHit?.score ?? 0)).toBe(true);
  });

  test("maxNeighbors caps the neighbor set", () => {
    const root = entities.create({
      entityType: "person",
      canonicalName: "Hub",
      crossProject: true,
    });
    for (let i = 0; i < 5; i++) {
      const nbr = entities.create({
        entityType: "person",
        canonicalName: `Spoke ${i}`,
        crossProject: true,
      });
      entities.addRelation(root.id, nbr.id, "colleague", { source: "test" });
    }
    const exp = entities.graphExpand([root.id], { maxNeighbors: 2 });
    expect(exp.entities.length).toBe(2);
  });

  test("includeKnowledge:false skips the knowledge fan-in (F4) but still returns neighbors", () => {
    const seed = entities.create({
      entityType: "person",
      canonicalName: "Hub Person",
      crossProject: true,
    });
    const neighbor = entities.create({
      entityType: "person",
      canonicalName: "Spoke Person",
      crossProject: true,
    });
    entities.addRelation(seed.id, neighbor.id, "colleague", { source: "test" });
    seedLinkedKnowledge({
      projectPath: PROJECT,
      entityId: seed.id,
      title: "Linked fact",
      content: "Reachable only through the entity graph.",
    });

    // Default (includeKnowledge true) surfaces the linked knowledge.
    expect(entities.graphExpand([seed.id]).knowledge.length).toBeGreaterThan(0);

    // includeKnowledge:false drops knowledge entirely (the refs query is never
    // issued); neighbor-entity expansion is unaffected.
    const exp = entities.graphExpand([seed.id], { includeKnowledge: false });
    expect(exp.knowledge).toEqual([]);
    expect(exp.entities.some((e) => e.id === neighbor.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — searchRecall entity-graph fan-in
// ---------------------------------------------------------------------------

describe("searchRecall — entity-graph fan-in", () => {
  const PROJECT = "/test/recall-graph/integration";

  beforeEach(() => {
    cleanup();
    ensureProject(PROJECT);
    // These tests isolate the GRAPH fan-in + visibility behavior. Vector search
    // is a separate retrieval path that can nondeterministically surface a
    // same-project entry by loose semantic proximity (it was doing so under the
    // full parallel suite, once background embeds landed — a flake). Force it
    // off so "reachable only via the graph" is a deterministic premise; the
    // vector path's own visibility is covered by the dedicated describe below.
    vi.spyOn(embedding, "isAvailable").mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a query matching an entity surfaces knowledge linked ONLY via the graph (#1)", async () => {
    const e = entities.create({
      entityType: "person",
      canonicalName: "Seylan Çinar Kaya",
      aliases: [{ type: "nickname", value: "Seylan" }],
      crossProject: true,
    });
    // Knowledge whose text never mentions "Seylan" — unreachable by FTS (and
    // vector is disabled for this block), so only the graph can surface it.
    const k = seedLinkedKnowledge({
      projectPath: PROJECT,
      entityId: e.id,
      title: "Anniversary reservation",
      content: "Book the riverside restaurant in Vienna for the celebration.",
    });

    const withGraph = await searchRecall({
      query: "Seylan",
      projectPath: PROJECT,
      scope: "all",
    });
    const found = withGraph.find(
      (r) => r.item.source === "knowledge" && r.item.item.logical_id === k,
    );
    expect(found).toBeDefined();

    // Red/green guard: disabling graph expansion makes the same entry
    // unreachable, proving the fan-in (not some other path) surfaced it.
    const cfg = LoreConfig.parse({}).search;
    cfg.graphExpansion = false;
    const withoutGraph = await searchRecall({
      query: "Seylan",
      projectPath: PROJECT,
      scope: "all",
      searchConfig: cfg,
    });
    expect(
      withoutGraph.some(
        (r) => r.item.source === "knowledge" && r.item.item.logical_id === k,
      ),
    ).toBe(false);
  });

  test("a 1-hop relation neighbor's knowledge surfaces, and the neighbor entity too (#2)", async () => {
    const a = entities.create({
      entityType: "person",
      canonicalName: "Onur Temizkan",
      crossProject: true,
    });
    const b = entities.create({
      entityType: "person",
      canonicalName: "Fatih Arslan",
      crossProject: true,
    });
    entities.addRelation(a.id, b.id, "colleague", { source: "test" });
    // Linked to B, never mentions the query term "Onur".
    const k = seedLinkedKnowledge({
      projectPath: PROJECT,
      entityId: b.id,
      title: "Release ritual",
      content: "Always tag the build before publishing.",
    });

    const results = await searchRecall({
      query: "Onur",
      projectPath: PROJECT,
      scope: "all",
    });

    // Neighbor knowledge surfaces via depth-1 traversal.
    expect(
      results.some(
        (r) => r.item.source === "knowledge" && r.item.item.logical_id === k,
      ),
    ).toBe(true);
    // The neighbor entity itself surfaces too.
    expect(
      results.some(
        (r) => r.item.source === "entity" && r.item.item.id === b.id,
      ),
    ).toBe(true);
  });

  test("does not leak another project's project-scoped knowledge linked to a shared entity", async () => {
    const OTHER = "/test/recall-graph/other";
    ensureProject(OTHER);
    // Cross-project entity is visible everywhere…
    const e = entities.create({
      entityType: "person",
      canonicalName: "Seylan Çinar Kaya",
      aliases: [{ type: "nickname", value: "Seylan" }],
      crossProject: true,
    });
    // …but the knowledge linked to it is project-scoped to OTHER (cross_project
    // = 0), so it must NOT surface when recalling from PROJECT.
    const k = seedLinkedKnowledge({
      projectPath: OTHER,
      entityId: e.id,
      title: "Other-project secret",
      content: "Sensitive detail confined to the other project.",
      crossProject: false,
    });

    const results = await searchRecall({
      query: "Seylan",
      projectPath: PROJECT,
      scope: "all",
    });
    expect(
      results.some(
        (r) => r.item.source === "knowledge" && r.item.item.logical_id === k,
      ),
    ).toBe(false);
  });

  test("does not leak another project's project-scoped neighbor entity related to a shared entity", async () => {
    const OTHER = "/test/recall-graph/other-entity";
    ensureProject(OTHER);
    // Cross-project seed entity — visible everywhere, matches the query.
    const seed = entities.create({
      entityType: "person",
      canonicalName: "Seylan Çinar Kaya",
      aliases: [{ type: "nickname", value: "Seylan" }],
      crossProject: true,
    });
    // A 1-hop relation neighbor that is project-scoped to OTHER (cross_project
    // = 0). graphExpand reaches it through the relation, so the ONLY thing
    // keeping it out of a PROJECT recall is recall's visibility filter — which
    // this test exists to guard against silent regression.
    const neighbor = entities.create({
      projectPath: OTHER,
      entityType: "person",
      canonicalName: "Private Other Person",
      crossProject: false,
    });
    entities.addRelation(seed.id, neighbor.id, "colleague", { source: "test" });

    const results = await searchRecall({
      query: "Seylan",
      projectPath: PROJECT,
      scope: "all",
    });
    // The neighbor entity belongs to OTHER and is not cross-project, so it must
    // not surface from PROJECT even though the graph reaches it.
    expect(
      results.some(
        (r) => r.item.source === "entity" && r.item.item.id === neighbor.id,
      ),
    ).toBe(false);
  });

  test("no entity seeds (knowledge scope) means no graph fan-in", async () => {
    const e = entities.create({
      entityType: "person",
      canonicalName: "Seylan Çinar Kaya",
      aliases: [{ type: "nickname", value: "Seylan" }],
      crossProject: true,
    });
    const k = seedLinkedKnowledge({
      projectPath: PROJECT,
      entityId: e.id,
      title: "Anniversary reservation",
      content: "Book the riverside restaurant in Vienna for the celebration.",
    });

    const results = await searchRecall({
      query: "Seylan",
      projectPath: PROJECT,
      scope: "knowledge",
    });
    // Entity search is gated out of "knowledge" scope, so there are no seeds and
    // the graph-only entry stays unreachable.
    expect(
      results.some(
        (r) => r.item.source === "knowledge" && r.item.item.logical_id === k,
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// searchRecall — knowledge VECTOR search project visibility
//
// vectorSearch() returns hits globally (not project-scoped), so recall must
// apply the same visibility predicate to knowledge vector hits that it applies
// to FTS and entity-vector hits — otherwise a semantic match leaks another
// project's project-scoped (cross_project = 0) knowledge. Embedding I/O is
// mocked so the hit set is deterministic regardless of the local model.
// ---------------------------------------------------------------------------

describe("searchRecall — knowledge vector visibility", () => {
  const PROJECT = "/test/recall-graph/vec-project";
  const OTHER = "/test/recall-graph/vec-other";

  beforeEach(() => {
    cleanup();
    ensureProject(PROJECT);
    ensureProject(OTHER);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("filters out another project's project-scoped knowledge while keeping cross-project + same-project hits", async () => {
    // OTHER project, cross_project = 0 — must NEVER surface in PROJECT recall.
    const otherId = ltm.create({
      projectPath: OTHER,
      scope: "project",
      category: "decision",
      title: "Other-project secret",
      content: "Sensitive detail confined to the other project.",
      crossProject: false,
    });
    // Same project — allowed.
    const mineId = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "My project note",
      content: "A note that belongs to this project.",
    });
    // Cross-project (cross_project = 1) — allowed from anywhere.
    const sharedId = ltm.create({
      projectPath: OTHER,
      scope: "project",
      category: "decision",
      title: "Shared cross-project note",
      content: "A globally shareable note.",
      crossProject: true,
    });

    // Force a deterministic vector hit set covering all three entries. For v1
    // rows the returned logical_id equals the row id vectorSearch would emit.
    vi.spyOn(embedding, "isAvailable").mockReturnValue(true);
    vi.spyOn(embedding, "embed").mockResolvedValue([
      new Float32Array([1, 0, 0]),
    ]);
    vi.spyOn(embedding, "vectorSearch").mockResolvedValue([
      { id: otherId, similarity: 0.99 },
      { id: mineId, similarity: 0.98 },
      { id: sharedId, similarity: 0.97 },
    ]);
    vi.spyOn(embedding, "vectorSearchDistillations").mockResolvedValue([]);
    vi.spyOn(embedding, "vectorSearchTemporal").mockResolvedValue([]);
    vi.spyOn(embedding, "vectorSearchEntities").mockResolvedValue([]);

    const results = await searchRecall({
      query: "anything",
      projectPath: PROJECT,
      scope: "all",
    });
    const hasKnowledge = (logicalId: string) =>
      results.some(
        (r) =>
          r.item.source === "knowledge" && r.item.item.logical_id === logicalId,
      );

    // The other project's project-scoped entry must be filtered out.
    expect(hasKnowledge(otherId)).toBe(false);
    // Same-project and cross-project entries are admitted.
    expect(hasKnowledge(mineId)).toBe(true);
    expect(hasKnowledge(sharedId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — ltm.getManyByLogicalOffloaded (batch graph-knowledge hydration)
// ---------------------------------------------------------------------------

describe("ltm.getManyByLogicalOffloaded — batch logical-id hydration", () => {
  const PROJECT = "/test/recall-graph/offload";

  beforeEach(() => {
    cleanup();
    ensureProject(PROJECT);
  });

  test("hydrates current entries keyed by logical_id, resolving through a superseded version", async () => {
    const a = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "Alpha entry",
      content: "alpha v1 body",
    });
    const b = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "Bravo entry",
      content: "bravo original body",
    });
    // Supersede A: appendVersion mints a fresh id, so the CURRENT row's id no
    // longer equals the logical_id — the case `get(id)` would miss but keying by
    // logical_id must still resolve.
    ltm.update(a, { content: "alpha v2 updated body" });

    const map = await ltm.getManyByLogicalOffloaded([a, b]);
    expect(map.size).toBe(2);
    // Keyed by the stable logical_id (a/b ARE logical_ids), not the version id.
    expect(map.get(a)?.logical_id).toBe(a);
    expect(map.get(a)?.id).not.toBe(a); // current version superseded v1
    expect(map.get(a)?.content).toContain("v2"); // returns CURRENT content
    expect(map.get(b)?.content).toContain("bravo");
  });

  test("absent logical_ids are dropped; empty input yields an empty map", async () => {
    const live = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "Live entry",
      content: "present body",
    });

    const map = await ltm.getManyByLogicalOffloaded([
      live,
      "missing-logical-id",
    ]);
    expect(map.size).toBe(1);
    expect(map.has(live)).toBe(true);
    expect(map.has("missing-logical-id")).toBe(false);

    expect((await ltm.getManyByLogicalOffloaded([])).size).toBe(0);
  });
});
