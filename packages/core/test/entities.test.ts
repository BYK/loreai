import { describe, test, expect, beforeEach } from "bun:test";
import { db } from "../src/db";
import * as entities from "../src/entities";
import { parseResponse, applyOps } from "../src/curator";

const PROJECT = "/test/entities/project";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function cleanup() {
  const d = db();
  d.exec("DELETE FROM entity_relations");
  d.exec("DELETE FROM knowledge_entity_refs");
  d.exec("DELETE FROM entity_aliases");
  d.exec("DELETE FROM entities");
}

describe("entities", () => {
  beforeEach(cleanup);

  // ---------------------------------------------------------------------------
  // Metadata
  // ---------------------------------------------------------------------------

  describe("metadata", () => {
    test("create with metadata stores and retrieves it", () => {
      const result = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "Alice",
        metadata: { role: "backend lead", description: "works on auth" },
      });
      expect(result.created).toBe(true);
      const entity = entities.get(result.id);
      expect(entity).not.toBeNull();
      expect(entity!.metadata).not.toBeNull();
      const meta = JSON.parse(entity!.metadata!);
      expect(meta.role).toBe("backend lead");
      expect(meta.description).toBe("works on auth");
    });

    test("create without metadata stores null", () => {
      const result = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "Bob",
      });
      const entity = entities.get(result.id);
      expect(entity!.metadata).toBeNull();
    });

    test("dedup merges metadata — existing non-empty values win", () => {
      const first = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "Charlie",
        metadata: { role: "frontend dev", description: "works on UI" },
      });
      expect(first.created).toBe(true);

      // Second create with same name — should dedup and merge
      const second = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "Charlie",
        metadata: { role: "backend dev", notes: "joined in 2024" },
      });
      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id);

      const entity = entities.get(first.id);
      const meta = JSON.parse(entity!.metadata!);
      expect(meta.role).toBe("frontend dev"); // existing wins
      expect(meta.description).toBe("works on UI"); // preserved
      expect(meta.notes).toBe("joined in 2024"); // new key fills gap
    });

    test("dedup with null incoming metadata does not clobber existing", () => {
      const first = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "Dana",
        metadata: { role: "designer" },
      });
      const second = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "Dana",
      });
      expect(second.id).toBe(first.id);
      const entity = entities.get(first.id);
      const meta = JSON.parse(entity!.metadata!);
      expect(meta.role).toBe("designer"); // unchanged
    });

    test("update replaces metadata", () => {
      const result = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "Eve",
        metadata: { role: "intern" },
      });
      entities.update(result.id, { metadata: { role: "senior", description: "promoted" } });
      const entity = entities.get(result.id);
      const meta = JSON.parse(entity!.metadata!);
      expect(meta.role).toBe("senior");
      expect(meta.description).toBe("promoted");
    });
  });

  // ---------------------------------------------------------------------------
  // mergeMetadata
  // ---------------------------------------------------------------------------

  describe("mergeMetadata", () => {
    test("null existing + incoming → incoming", () => {
      const result = entities.mergeMetadata(null, { role: "dev" });
      expect(result).toEqual({ role: "dev" });
    });

    test("existing + undefined incoming → existing", () => {
      const result = entities.mergeMetadata('{"role":"dev"}', undefined);
      expect(result).toEqual({ role: "dev" });
    });

    test("existing + empty incoming → existing", () => {
      const result = entities.mergeMetadata('{"role":"dev"}', {});
      expect(result).toEqual({ role: "dev" });
    });

    test("existing wins on conflict", () => {
      const result = entities.mergeMetadata(
        '{"role":"senior","description":"auth team"}',
        { role: "junior", notes: "new hire" },
      );
      expect(result).toEqual({
        role: "senior",
        description: "auth team",
        notes: "new hire",
      });
    });

    test("null existing + empty incoming → null", () => {
      const result = entities.mergeMetadata(null, {});
      expect(result).toBeNull();
    });

    test("null + undefined → null", () => {
      const result = entities.mergeMetadata(null, undefined);
      expect(result).toBeNull();
    });

    test("existing empty string values are overwritten by incoming", () => {
      const result = entities.mergeMetadata(
        '{"role":"","description":"auth team"}',
        { role: "dev" },
      );
      expect(result!.role).toBe("dev"); // empty string does not win
      expect(result!.description).toBe("auth team");
    });
  });

  // ---------------------------------------------------------------------------
  // Type-based cross_project defaults
  // ---------------------------------------------------------------------------

  describe("cross_project defaults", () => {
    test("person defaults to cross-project", () => {
      const result = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "CrossPerson",
      });
      const entity = entities.get(result.id);
      expect(entity!.cross_project).toBe(1);
    });

    test("repo defaults to project-scoped", () => {
      const result = entities.create({
        projectPath: PROJECT,
        entityType: "repo",
        canonicalName: "my-repo",
      });
      const entity = entities.get(result.id);
      expect(entity!.cross_project).toBe(0);
    });

    test("infra defaults to project-scoped", () => {
      const result = entities.create({
        projectPath: PROJECT,
        entityType: "infra",
        canonicalName: "staging-server",
      });
      const entity = entities.get(result.id);
      expect(entity!.cross_project).toBe(0);
    });

    test("explicit crossProject overrides default", () => {
      const result = entities.create({
        projectPath: PROJECT,
        entityType: "repo",
        canonicalName: "shared-repo",
        crossProject: true,
      });
      const entity = entities.get(result.id);
      expect(entity!.cross_project).toBe(1);
    });

    test("self is always cross-project", () => {
      const result = entities.create({
        projectPath: PROJECT,
        entityType: "self",
        canonicalName: "TestUser",
      });
      const entity = entities.get(result.id);
      expect(entity!.cross_project).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Self-entity
  // ---------------------------------------------------------------------------

  describe("self entity", () => {
    test("getSelfEntity returns null when no self entity exists", () => {
      expect(entities.getSelfEntity()).toBeNull();
    });

    test("create self entity and retrieve it", () => {
      const result = entities.create({
        projectPath: PROJECT,
        entityType: "self",
        canonicalName: "Test User",
        metadata: { description: "developer" },
      });
      expect(result.created).toBe(true);

      const self = entities.getSelfEntity();
      expect(self).not.toBeNull();
      expect(self!.entity_type).toBe("self");
      expect(self!.canonical_name).toBe("Test User");
    });
  });

  // ---------------------------------------------------------------------------
  // Relations
  // ---------------------------------------------------------------------------

  describe("relations", () => {
    test("addRelation creates a relation between two entities", () => {
      const a = entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "RelA" });
      const b = entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "RelB" });

      const relId = entities.addRelation(a.id, b.id, "friend", { source: "manual" });
      expect(relId).not.toBeNull();
      expect(relId).toMatch(UUID_RE);
    });

    test("addRelation rejects duplicate relation", () => {
      const a = entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "DupA" });
      const b = entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "DupB" });

      const first = entities.addRelation(a.id, b.id, "colleague");
      expect(first).not.toBeNull();
      const second = entities.addRelation(a.id, b.id, "colleague");
      expect(second).toBeNull();
    });

    test("multiple relation types between same pair", () => {
      const a = entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "MultiA" });
      const b = entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "MultiB" });

      expect(entities.addRelation(a.id, b.id, "friend")).not.toBeNull();
      expect(entities.addRelation(a.id, b.id, "colleague")).not.toBeNull();

      const rels = entities.relationsFor(a.id);
      expect(rels.length).toBe(2);
    });

    test("relationsFor returns relations from both sides", () => {
      const a = entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "SideA" });
      const b = entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "SideB" });

      entities.addRelation(a.id, b.id, "friend");

      const relsA = entities.relationsFor(a.id);
      expect(relsA.length).toBe(1);
      expect(relsA[0].other_name).toBe("SideB");

      const relsB = entities.relationsFor(b.id);
      expect(relsB.length).toBe(1);
      expect(relsB[0].other_name).toBe("SideA");
    });

    test("removeRelation deletes a relation", () => {
      const a = entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "RmA" });
      const b = entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "RmB" });

      const relId = entities.addRelation(a.id, b.id, "mentor")!;
      expect(entities.relationsFor(a.id).length).toBe(1);

      entities.removeRelation(relId);
      expect(entities.relationsFor(a.id).length).toBe(0);
    });

    test("getRelation finds specific relation between pair", () => {
      const a = entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "GetA" });
      const b = entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "GetB" });

      entities.addRelation(a.id, b.id, "partner");
      const rels = entities.getRelation(a.id, b.id, "partner");
      expect(rels.length).toBe(1);
      expect(rels[0].relation).toBe("partner");
    });

    test("getRelation finds bidirectionally", () => {
      const a = entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "BiA" });
      const b = entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "BiB" });

      entities.addRelation(a.id, b.id, "friend");
      // Query with reversed order
      const rels = entities.getRelation(b.id, a.id, "friend");
      expect(rels.length).toBe(1);
    });

    test("removing entity cleans up relations", () => {
      const a = entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "CleanA" });
      const b = entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "CleanB" });

      entities.addRelation(a.id, b.id, "colleague");
      entities.remove(a.id);
      expect(entities.relationsFor(b.id).length).toBe(0);
    });

    test("addRelation with metadata", () => {
      const a = entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "MetaRelA" });
      const b = entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "MetaRelB" });

      entities.addRelation(a.id, b.id, "friend", { metadata: { context: "met at conference" } });
      const rels = entities.getRelation(a.id, b.id, "friend");
      expect(rels.length).toBe(1);
      const meta = JSON.parse(rels[0].metadata!);
      expect(meta.context).toBe("met at conference");
    });

    test("formatRelationsForPrompt produces concise output", () => {
      const a = entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "FmtA" });
      const b = entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "FmtB" });
      const c = entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "FmtC" });

      entities.addRelation(a.id, b.id, "friend");
      entities.addRelation(a.id, c.id, "colleague");

      const result = entities.formatRelationsForPrompt(a.id);
      expect(result).toContain("friend of FmtB");
      expect(result).toContain("colleague of FmtC");
    });
  });

  // ---------------------------------------------------------------------------
  // formatForPrompt
  // ---------------------------------------------------------------------------

  describe("formatForPrompt", () => {
    test("includes metadata brief for non-self entities", () => {
      const result = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "PromptPerson",
        metadata: { role: "backend lead", description: "works on infra" },
      });
      const all = entities.forProject(PROJECT);
      const output = entities.formatForPrompt(all);
      expect(output).toContain("PromptPerson");
      expect(output).toContain("backend lead");
      expect(output).toContain('"works on infra"');
    });

    test("self entity gets 'you (the user)' marker", () => {
      entities.create({
        projectPath: PROJECT,
        entityType: "self",
        canonicalName: "TestSelf",
      });
      const all = entities.forProject(PROJECT);
      const output = entities.formatForPrompt(all);
      expect(output).toContain("TestSelf");
      expect(output).toContain("you (the user)");
    });

    test("self entity is grouped under 'person'", () => {
      entities.create({
        projectPath: PROJECT,
        entityType: "self",
        canonicalName: "GroupSelf",
      });
      const all = entities.forProject(PROJECT);
      const output = entities.formatForPrompt(all);
      expect(output).toContain("person:");
      expect(output).not.toContain("self:");
    });

    test("relationship tags shown for entities related to self", () => {
      const self = entities.create({
        projectPath: PROJECT,
        entityType: "self",
        canonicalName: "RelSelf",
      });
      const other = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "RelOther",
      });
      entities.addRelation(self.id, other.id, "friend");

      const all = entities.forProject(PROJECT);
      const output = entities.formatForPrompt(all);
      expect(output).toContain("[friend]");
    });

    test("metadata notes not shown in prompt", () => {
      entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "NotesPerson",
        metadata: { notes: "internal detail not for prompt" },
      });
      const all = entities.forProject(PROJECT);
      const output = entities.formatForPrompt(all);
      expect(output).not.toContain("internal detail not for prompt");
    });

    test("empty entities returns empty string", () => {
      expect(entities.formatForPrompt([])).toBe("");
    });
  });

  // ---------------------------------------------------------------------------
  // entitiesForSession
  // ---------------------------------------------------------------------------

  describe("entitiesForSession", () => {
    test("returns all entities when count <= cap", () => {
      entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "Sess1" });
      entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "Sess2" });

      const result = entities.entitiesForSession(PROJECT, 30);
      expect(result.length).toBe(2);
    });

    test("returns empty when maxInject is 0", () => {
      entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "Zero1" });
      const result = entities.entitiesForSession(PROJECT, 0);
      expect(result.length).toBe(0);
    });

    test("self entity always included when over cap", () => {
      const self = entities.create({
        projectPath: PROJECT,
        entityType: "self",
        canonicalName: "CapSelf",
      });
      // Create enough entities to exceed cap of 2
      entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "Cap1" });
      entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "Cap2" });
      entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "Cap3" });

      const result = entities.entitiesForSession(PROJECT, 2);
      expect(result.length).toBe(2);
      const selfIncluded = result.some((e) => e.entity_type === "self");
      expect(selfIncluded).toBe(true);
    });

    test("entities related to self are prioritized when over cap", () => {
      const self = entities.create({
        projectPath: PROJECT,
        entityType: "self",
        canonicalName: "PriSelf",
      });
      const friend = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "PriFriend",
      });
      entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "PriOther1" });
      entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "PriOther2" });

      entities.addRelation(self.id, friend.id, "friend");

      const result = entities.entitiesForSession(PROJECT, 2);
      expect(result.length).toBe(2);
      const ids = result.map((e) => e.id);
      expect(ids).toContain(self.id);
      expect(ids).toContain(friend.id);
    });
  });

  // ---------------------------------------------------------------------------
  // Curator integration: parseResponse + applyOps
  // ---------------------------------------------------------------------------

  describe("curator integration", () => {
    test("parseResponse handles entities with metadata", () => {
      const response = parseResponse(JSON.stringify({
        ops: [],
        entities: [
          {
            type: "person",
            canonical_name: "CuratorPerson",
            aliases: [{ type: "github", value: "@curator" }],
            metadata: { role: "reviewer", description: "code reviewer" },
          },
        ],
        relations: [],
      }));
      expect(response.entities.length).toBe(1);
      expect(response.entities[0].metadata).toEqual({ role: "reviewer", description: "code reviewer" });
    });

    test("parseResponse filters invalid metadata values", () => {
      const response = parseResponse(JSON.stringify({
        ops: [],
        entities: [
          {
            type: "person",
            canonical_name: "FilterPerson",
            metadata: { role: "valid", bad: 123, empty: "", toolong: "x".repeat(501) },
          },
        ],
        relations: [],
      }));
      expect(response.entities[0].metadata).toEqual({ role: "valid" });
    });

    test("parseResponse handles relations", () => {
      const response = parseResponse(JSON.stringify({
        ops: [],
        entities: [],
        relations: [
          { entity_a: "Alice", entity_b: "Bob", relation: "friend" },
          { entity_a: "Alice", entity_b: "Bob", relation: "invalid_type" }, // filtered
        ],
      }));
      expect(response.relations.length).toBe(1);
      expect(response.relations[0].relation).toBe("friend");
    });

    test("applyOps creates entities with metadata", () => {
      const result = applyOps([], {
        projectPath: PROJECT,
        detectedEntities: [
          {
            type: "service",
            canonical_name: "ApplyService",
            metadata: { description: "CI/CD platform" },
          },
        ],
      });
      expect(result.entitiesCreated).toBe(1);

      const resolved = entities.resolve("ApplyService");
      expect(resolved).not.toBeNull();
      const meta = JSON.parse(resolved!.metadata!);
      expect(meta.description).toBe("CI/CD platform");
    });

    test("applyOps creates relations between known entities", () => {
      const a = entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "OpRelA" });
      const b = entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "OpRelB" });

      const result = applyOps([], {
        projectPath: PROJECT,
        detectedRelations: [
          { entity_a: "OpRelA", entity_b: "OpRelB", relation: "colleague" },
        ],
      });
      expect(result.relationsCreated).toBe(1);

      const rels = entities.getRelation(a.id, b.id, "colleague");
      expect(rels.length).toBe(1);
    });

    test("applyOps skips relations for unknown entities", () => {
      entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "KnownPerson" });

      const result = applyOps([], {
        projectPath: PROJECT,
        detectedRelations: [
          { entity_a: "KnownPerson", entity_b: "UnknownPerson", relation: "friend" },
        ],
      });
      expect(result.relationsCreated).toBe(0);
    });

    test("legacy array format still works", () => {
      const response = parseResponse(JSON.stringify([
        { op: "create", category: "decision", title: "test", content: "test content", scope: "project" },
      ]));
      expect(response.ops.length).toBe(1);
      expect(response.entities.length).toBe(0);
      expect(response.relations.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Merge with relations
  // ---------------------------------------------------------------------------

  describe("merge", () => {
    test("merge moves relations from source to target", () => {
      const target = entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "MergeTarget" });
      const source = entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "MergeSource" });
      const other = entities.create({ projectPath: PROJECT, entityType: "person", canonicalName: "MergeOther" });

      entities.addRelation(source.id, other.id, "friend");
      entities.merge(target.id, source.id);

      // Source is deleted
      expect(entities.get(source.id)).toBeNull();
      // Relation moved to target
      const rels = entities.relationsFor(target.id);
      expect(rels.length).toBe(1);
      expect(rels[0].other_name).toBe("MergeOther");
    });
  });
});
