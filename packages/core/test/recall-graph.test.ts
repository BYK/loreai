import { beforeEach, describe, expect, test } from "vitest";
import { LoreConfig } from "../src/config";
import { db, ensureProject } from "../src/db";
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
});

// ---------------------------------------------------------------------------
// Integration tests — searchRecall entity-graph fan-in
// ---------------------------------------------------------------------------

describe("searchRecall — entity-graph fan-in", () => {
  const PROJECT = "/test/recall-graph/integration";

  beforeEach(() => {
    cleanup();
    ensureProject(PROJECT);
  });

  test("a query matching an entity surfaces knowledge linked ONLY via the graph (#1)", async () => {
    const e = entities.create({
      entityType: "person",
      canonicalName: "Seylan Çinar Kaya",
      aliases: [{ type: "nickname", value: "Seylan" }],
      crossProject: true,
    });
    // Knowledge whose text never mentions "Seylan" — unreachable by FTS/vector.
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
