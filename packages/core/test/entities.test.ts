import { describe, test, expect, beforeEach } from "vitest";
import { db, ensureProject } from "../src/db";
import * as entities from "../src/entities";
import * as ltm from "../src/ltm";
import { parseResponse, applyOps } from "../src/curator";

const PROJECT = "/test/entities/project";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function cleanup() {
  const d = db();
  d.exec("DELETE FROM entity_relations");
  d.exec("DELETE FROM knowledge_entity_refs");
  d.exec("DELETE FROM entity_aliases");
  d.exec("DELETE FROM entities");
  d.exec("DELETE FROM dedup_feedback");
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
      expect(entity?.metadata).not.toBeNull();
      if (!entity?.metadata) throw new Error("expected metadata");
      const meta = JSON.parse(entity.metadata);
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
      expect(entity?.metadata).toBeNull();
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
      if (!entity?.metadata) throw new Error("expected metadata");
      const meta = JSON.parse(entity.metadata);
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
      if (!entity?.metadata) throw new Error("expected metadata");
      const meta = JSON.parse(entity.metadata);
      expect(meta.role).toBe("designer"); // unchanged
    });

    test("update replaces metadata", () => {
      const result = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "Eve",
        metadata: { role: "intern" },
      });
      entities.update(result.id, {
        metadata: { role: "senior", description: "promoted" },
      });
      const entity = entities.get(result.id);
      if (!entity?.metadata) throw new Error("expected metadata");
      const meta = JSON.parse(entity.metadata);
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
      expect(result?.role).toBe("dev"); // empty string does not win
      expect(result?.description).toBe("auth team");
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
      expect(entity?.cross_project).toBe(1);
    });

    test("repo defaults to project-scoped", () => {
      const result = entities.create({
        projectPath: PROJECT,
        entityType: "repo",
        canonicalName: "my-repo",
      });
      const entity = entities.get(result.id);
      expect(entity?.cross_project).toBe(0);
    });

    test("infra defaults to project-scoped", () => {
      const result = entities.create({
        projectPath: PROJECT,
        entityType: "infra",
        canonicalName: "staging-server",
      });
      const entity = entities.get(result.id);
      expect(entity?.cross_project).toBe(0);
    });

    test("explicit crossProject overrides default", () => {
      const result = entities.create({
        projectPath: PROJECT,
        entityType: "repo",
        canonicalName: "shared-repo",
        crossProject: true,
      });
      const entity = entities.get(result.id);
      expect(entity?.cross_project).toBe(1);
    });

    test("self is always cross-project", () => {
      const result = entities.create({
        projectPath: PROJECT,
        entityType: "self",
        canonicalName: "TestUser",
      });
      const entity = entities.get(result.id);
      expect(entity?.cross_project).toBe(1);
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
      expect(self?.entity_type).toBe("self");
      expect(self?.canonical_name).toBe("Test User");
    });
  });

  // ---------------------------------------------------------------------------
  // Relations
  // ---------------------------------------------------------------------------

  describe("relations", () => {
    test("addRelation creates a relation between two entities", () => {
      const a = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "RelA",
      });
      const b = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "RelB",
      });

      const relId = entities.addRelation(a.id, b.id, "friend", {
        source: "manual",
      });
      expect(relId).not.toBeNull();
      expect(relId).toMatch(UUID_RE);
    });

    test("addRelation rejects duplicate relation", () => {
      const a = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "DupA",
      });
      const b = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "DupB",
      });

      const first = entities.addRelation(a.id, b.id, "colleague");
      expect(first).not.toBeNull();
      const second = entities.addRelation(a.id, b.id, "colleague");
      expect(second).toBeNull();
    });

    test("multiple relation types between same pair", () => {
      const a = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "MultiA",
      });
      const b = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "MultiB",
      });

      expect(entities.addRelation(a.id, b.id, "friend")).not.toBeNull();
      expect(entities.addRelation(a.id, b.id, "colleague")).not.toBeNull();

      const rels = entities.relationsFor(a.id);
      expect(rels.length).toBe(2);
    });

    test("relationsFor returns relations from both sides", () => {
      const a = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "SideA",
      });
      const b = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "SideB",
      });

      entities.addRelation(a.id, b.id, "friend");

      const relsA = entities.relationsFor(a.id);
      expect(relsA.length).toBe(1);
      expect(relsA[0].other_name).toBe("SideB");

      const relsB = entities.relationsFor(b.id);
      expect(relsB.length).toBe(1);
      expect(relsB[0].other_name).toBe("SideA");
    });

    test("removeRelation deletes a relation", () => {
      const a = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "RmA",
      });
      const b = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "RmB",
      });

      const relId = entities.addRelation(a.id, b.id, "mentor");
      expect(relId).toBeTruthy();
      if (!relId) throw new Error("expected relation id");
      expect(entities.relationsFor(a.id).length).toBe(1);

      entities.removeRelation(relId);
      expect(entities.relationsFor(a.id).length).toBe(0);
    });

    test("getRelation finds specific relation between pair", () => {
      const a = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "GetA",
      });
      const b = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "GetB",
      });

      entities.addRelation(a.id, b.id, "partner");
      const rels = entities.getRelation(a.id, b.id, "partner");
      expect(rels.length).toBe(1);
      expect(rels[0].relation).toBe("partner");
    });

    test("getRelation finds bidirectionally", () => {
      const a = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "BiA",
      });
      const b = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "BiB",
      });

      entities.addRelation(a.id, b.id, "friend");
      // Query with reversed order
      const rels = entities.getRelation(b.id, a.id, "friend");
      expect(rels.length).toBe(1);
    });

    test("removing entity cleans up relations", () => {
      const a = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "CleanA",
      });
      const b = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "CleanB",
      });

      entities.addRelation(a.id, b.id, "colleague");
      entities.remove(a.id);
      expect(entities.relationsFor(b.id).length).toBe(0);
    });

    test("addRelation with metadata", () => {
      const a = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "MetaRelA",
      });
      const b = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "MetaRelB",
      });

      entities.addRelation(a.id, b.id, "friend", {
        metadata: { context: "met at conference" },
      });
      const rels = entities.getRelation(a.id, b.id, "friend");
      expect(rels.length).toBe(1);
      const relMeta = rels[0]?.metadata;
      if (!relMeta) throw new Error("expected relation metadata");
      const meta = JSON.parse(relMeta);
      expect(meta.context).toBe("met at conference");
    });

    test("formatRelationsForPrompt produces concise output", () => {
      const a = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "FmtA",
      });
      const b = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "FmtB",
      });
      const c = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "FmtC",
      });

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
      const _result = entities.create({
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
      entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "Sess1",
      });
      entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "Sess2",
      });

      const result = entities.entitiesForSession(PROJECT, 30);
      expect(result.length).toBe(2);
    });

    test("returns empty when maxInject is 0", () => {
      entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "Zero1",
      });
      const result = entities.entitiesForSession(PROJECT, 0);
      expect(result.length).toBe(0);
    });

    test("self entity always included when over cap", () => {
      const _self = entities.create({
        projectPath: PROJECT,
        entityType: "self",
        canonicalName: "CapSelf",
      });
      // Create enough entities to exceed cap of 2
      entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "Cap1",
      });
      entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "Cap2",
      });
      entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "Cap3",
      });

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
      entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "PriOther1",
      });
      entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "PriOther2",
      });

      entities.addRelation(self.id, friend.id, "friend");

      const result = entities.entitiesForSession(PROJECT, 2);
      expect(result.length).toBe(2);
      const ids = result.map((e) => e.id);
      expect(ids).toContain(self.id);
      expect(ids).toContain(friend.id);
    });
  });

  // ---------------------------------------------------------------------------
  // searchCrossProjectRepos — cross-project repo discovery
  // ---------------------------------------------------------------------------

  describe("searchCrossProjectRepos", () => {
    const OTHER = "/test/entities/other-project";

    test("finds a repo owned by another project", () => {
      const repo = entities.create({
        projectPath: OTHER,
        entityType: "repo",
        canonicalName: "sentry-cli-typescript",
      });
      const results = entities.searchCrossProjectRepos({
        query: "sentry-cli-typescript",
        excludeProjectPath: PROJECT,
      });
      expect(results.map((e) => e.id)).toContain(repo.id);
    });

    test("excludes the excluded project's own repos", () => {
      const own = entities.create({
        projectPath: PROJECT,
        entityType: "repo",
        canonicalName: "homerepo",
      });
      const results = entities.searchCrossProjectRepos({
        query: "homerepo",
        excludeProjectPath: PROJECT,
      });
      expect(results.map((e) => e.id)).not.toContain(own.id);
    });

    test("excludes infra entities from other projects", () => {
      entities.create({
        projectPath: OTHER,
        entityType: "infra",
        canonicalName: "prod-database",
      });
      const results = entities.searchCrossProjectRepos({
        query: "prod-database",
        excludeProjectPath: PROJECT,
      });
      expect(results.length).toBe(0);
    });

    test("excludes non-repo entities (person) from other projects", () => {
      entities.create({
        projectPath: OTHER,
        entityType: "person",
        canonicalName: "Zelda",
      });
      const results = entities.searchCrossProjectRepos({
        query: "Zelda",
        excludeProjectPath: PROJECT,
      });
      expect(results.length).toBe(0);
    });

    test("matches a repo by alias too", () => {
      const repo = entities.create({
        projectPath: OTHER,
        entityType: "repo",
        canonicalName: "Backend Monorepo",
        aliases: [{ type: "name", value: "backend-mono" }],
      });
      const results = entities.searchCrossProjectRepos({
        query: "backend-mono",
        excludeProjectPath: PROJECT,
      });
      expect(results.map((e) => e.id)).toContain(repo.id);
    });

    test("excludes global repo entities (project_id IS NULL)", () => {
      // Global entities are already returned by the standard search() via its
      // project_id IS NULL predicate — searchCrossProjectRepos must NOT
      // double-surface them.
      entities.create({
        // no projectPath → project_id IS NULL
        entityType: "repo",
        canonicalName: "global-shared-repo",
      });
      const results = entities.searchCrossProjectRepos({
        query: "global-shared-repo",
        excludeProjectPath: PROJECT,
      });
      expect(results.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Curator integration: parseResponse + applyOps
  // ---------------------------------------------------------------------------

  describe("curator integration", () => {
    test("parseResponse handles entities with metadata", () => {
      const response = parseResponse(
        JSON.stringify({
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
        }),
      );
      expect(response.entities.length).toBe(1);
      expect(response.entities[0].metadata).toEqual({
        role: "reviewer",
        description: "code reviewer",
      });
    });

    test("parseResponse filters invalid metadata values", () => {
      const response = parseResponse(
        JSON.stringify({
          ops: [],
          entities: [
            {
              type: "person",
              canonical_name: "FilterPerson",
              metadata: {
                role: "valid",
                bad: 123,
                empty: "",
                toolong: "x".repeat(501),
              },
            },
          ],
          relations: [],
        }),
      );
      expect(response.entities[0].metadata).toEqual({ role: "valid" });
    });

    test("parseResponse handles relations", () => {
      const response = parseResponse(
        JSON.stringify({
          ops: [],
          entities: [],
          relations: [
            { entity_a: "Alice", entity_b: "Bob", relation: "friend" },
            { entity_a: "Alice", entity_b: "Bob", relation: "invalid_type" }, // filtered
          ],
        }),
      );
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
      if (!resolved?.metadata) throw new Error("expected resolved metadata");
      const meta = JSON.parse(resolved.metadata);
      expect(meta.description).toBe("CI/CD platform");
    });

    test("applyOps creates relations between known entities", () => {
      const a = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "OpRelA",
      });
      const b = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "OpRelB",
      });

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
      entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "KnownPerson",
      });

      const result = applyOps([], {
        projectPath: PROJECT,
        detectedRelations: [
          {
            entity_a: "KnownPerson",
            entity_b: "UnknownPerson",
            relation: "friend",
          },
        ],
      });
      expect(result.relationsCreated).toBe(0);
    });

    test("legacy array format still works", () => {
      const response = parseResponse(
        JSON.stringify([
          {
            op: "create",
            category: "decision",
            title: "test",
            content: "test content",
            scope: "project",
          },
        ]),
      );
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
      const target = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "MergeTarget",
      });
      const source = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "MergeSource",
      });
      const other = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "MergeOther",
      });

      entities.addRelation(source.id, other.id, "friend");
      entities.merge(target.id, source.id);

      // Source is deleted
      expect(entities.get(source.id)).toBeNull();
      // Relation moved to target
      const rels = entities.relationsFor(target.id);
      expect(rels.length).toBe(1);
      expect(rels[0].other_name).toBe("MergeOther");
    });

    test("merge transfers non-overlapping aliases from source to target", () => {
      const target = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "TargetPerson",
        aliases: [
          { type: "email", value: "target@example.com", source: "auto" },
        ],
      });
      const source = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "SourcePerson",
        aliases: [
          { type: "github", value: "source-gh", source: "curator" },
          { type: "slack", value: "source-slack", source: "curator" },
        ],
      });

      entities.merge(target.id, source.id);

      expect(entities.get(source.id)).toBeNull();
      // biome-ignore lint/style/noNonNullAssertion: getWithAliases() returns null for missing entities
      const updated = entities.getWithAliases(target.id)!;
      const aliasValues = updated.aliases.map((a) => a.alias_value);
      // Original target aliases preserved
      expect(aliasValues).toContain("TargetPerson");
      expect(aliasValues).toContain("target@example.com");
      // Source aliases transferred
      expect(aliasValues).toContain("source-gh");
      expect(aliasValues).toContain("source-slack");
      expect(aliasValues).toContain("SourcePerson");
    });

    test("merge handles overlapping alias (same type+value) without data loss", () => {
      const target = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "TargetDup",
        aliases: [{ type: "github", value: "shared-handle", source: "auto" }],
      });
      const source = entities.create({
        projectPath: PROJECT,
        entityType: "person",
        canonicalName: "SourceDup",
        aliases: [
          { type: "github", value: "shared-handle", source: "curator" },
          { type: "slack", value: "unique-slack", source: "curator" },
        ],
      });

      entities.merge(target.id, source.id);

      expect(entities.get(source.id)).toBeNull();
      // biome-ignore lint/style/noNonNullAssertion: getWithAliases() returns null for missing entities
      const updated = entities.getWithAliases(target.id)!;
      const aliasValues = updated.aliases.map((a) => a.alias_value);
      // Shared alias preserved (not duplicated, not lost)
      expect(aliasValues).toContain("shared-handle");
      // Unique source alias transferred
      expect(aliasValues).toContain("unique-slack");
      expect(aliasValues).toContain("SourceDup");
      // No duplicate github:shared-handle entries
      const githubAliases = updated.aliases.filter(
        (a) => a.alias_type === "github" && a.alias_value === "shared-handle",
      );
      expect(githubAliases.length).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // mergeSelfPersonDuplicates
  // ---------------------------------------------------------------------------

  describe("mergeSelfPersonDuplicates", () => {
    // Helper: insert a person entity directly via SQL to bypass create()'s
    // canonical-name dedup (which would merge into the existing self entity).
    // This simulates the real scenario where the curator creates a person
    // before the self entity exists, or with a name variant that differs.
    // In the real world, the curator creates a "person" entity for the user
    // (often with a different name variant) before or alongside the self entity.
    // create() deduplicates by canonical_name (case-insensitive) regardless of
    // entity_type, so same-name entities are already handled at creation time.
    // mergeSelfPersonDuplicates() catches the cases where names differ but
    // aliases overlap (e.g., same email) or the person's canonical name matches
    // one of the self entity's alias values.

    test("merges person whose canonical name matches a self alias", () => {
      // Curator created "person" with a name variant
      const person = entities.create({
        entityType: "person",
        canonicalName: "Alice",
        crossProject: true,
      });
      // Self entity has full name but "Alice" as a nickname alias
      const self = entities.create({
        entityType: "self",
        canonicalName: "Alice Smith",
        aliases: [{ type: "nickname", value: "Alice", source: "config" }],
        crossProject: true,
      });

      // biome-ignore lint/style/noNonNullAssertion: getWithAliases() returns null for missing entities
      const selfEntity = entities.getWithAliases(self.id)!;
      const count = entities.mergeSelfPersonDuplicates(selfEntity);

      expect(count).toBe(1);
      expect(entities.get(person.id)).toBeNull(); // person absorbed
      expect(entities.get(self.id)).not.toBeNull(); // self preserved
    });

    test("merges person with overlapping alias value", () => {
      // Person created first — owns the github alias
      const person = entities.create({
        entityType: "person",
        canonicalName: "A. Smith",
        aliases: [{ type: "github", value: "alicesmith", source: "curator" }],
        crossProject: true,
      });
      // Self entity created later — also has the same github handle
      const self = entities.create({
        entityType: "self",
        canonicalName: "Alice Smith",
        aliases: [{ type: "nickname", value: "alicesmith", source: "config" }],
        crossProject: true,
      });

      // biome-ignore lint/style/noNonNullAssertion: getWithAliases() returns null for missing entities
      const selfEntity = entities.getWithAliases(self.id)!;
      const count = entities.mergeSelfPersonDuplicates(selfEntity);

      expect(count).toBe(1);
      expect(entities.get(person.id)).toBeNull();
    });

    test("does not merge unrelated person entities", () => {
      const person = entities.create({
        entityType: "person",
        canonicalName: "Bob",
        crossProject: true,
      });
      const self = entities.create({
        entityType: "self",
        canonicalName: "Alice",
        crossProject: true,
      });

      // biome-ignore lint/style/noNonNullAssertion: getWithAliases() returns null for missing entities
      const selfEntity = entities.getWithAliases(self.id)!;
      const count = entities.mergeSelfPersonDuplicates(selfEntity);

      expect(count).toBe(0);
      expect(entities.get(person.id)).not.toBeNull(); // Bob still exists
    });

    test("merges multiple matching person entities", () => {
      // Person matching by canonical name → self nickname alias
      const person1 = entities.create({
        entityType: "person",
        canonicalName: "Ali",
        crossProject: true,
      });
      // Person matching by github alias → self nickname alias
      const person2 = entities.create({
        entityType: "person",
        canonicalName: "A. Smith",
        aliases: [{ type: "github", value: "asmith42", source: "curator" }],
        crossProject: true,
      });
      // Unrelated person — should NOT be merged
      const bob = entities.create({
        entityType: "person",
        canonicalName: "Bob",
        crossProject: true,
      });
      // Self entity with aliases matching both persons
      const self = entities.create({
        entityType: "self",
        canonicalName: "Alice Smith",
        aliases: [
          { type: "nickname", value: "Ali", source: "config" },
          { type: "nickname", value: "asmith42", source: "config" },
        ],
        crossProject: true,
      });

      // biome-ignore lint/style/noNonNullAssertion: getWithAliases() returns null for missing entities
      const selfEntity = entities.getWithAliases(self.id)!;
      const count = entities.mergeSelfPersonDuplicates(selfEntity);

      expect(count).toBe(2);
      expect(entities.get(person1.id)).toBeNull();
      expect(entities.get(person2.id)).toBeNull();
      expect(entities.get(bob.id)).not.toBeNull(); // Bob untouched
    });

    test("preserves aliases from absorbed person entity", () => {
      // Person with extra aliases
      const person = entities.create({
        entityType: "person",
        canonicalName: "Ali",
        aliases: [
          { type: "github", value: "alice-gh", source: "curator" },
          { type: "slack", value: "alice-slack", source: "curator" },
        ],
        crossProject: true,
      });
      // Self entity — "Ali" nickname matches person's canonical name
      const self = entities.create({
        entityType: "self",
        canonicalName: "Alice Smith",
        aliases: [{ type: "nickname", value: "Ali", source: "config" }],
        crossProject: true,
      });

      // Verify person was actually created separately
      expect(person.created).toBe(true);
      expect(entities.get(person.id)).not.toBeNull();
      // biome-ignore lint/style/noNonNullAssertion: entity was just created above
      const personAliases = entities.getWithAliases(person.id)!.aliases;
      expect(personAliases.map((a) => a.alias_value)).toContain("alice-gh");

      // biome-ignore lint/style/noNonNullAssertion: getWithAliases() returns null for missing entities
      const selfEntity = entities.getWithAliases(self.id)!;
      const count = entities.mergeSelfPersonDuplicates(selfEntity);
      expect(count).toBe(1);

      // Person should be deleted
      expect(entities.get(person.id)).toBeNull();

      // Re-fetch self with aliases
      // biome-ignore lint/style/noNonNullAssertion: getWithAliases() returns null for missing entities
      const updated = entities.getWithAliases(self.id)!;
      const aliasValues = updated.aliases.map((a) => a.alias_value);
      expect(aliasValues).toContain("alice-gh");
      expect(aliasValues).toContain("alice-slack");
    });

    test("does NOT merge a colleague sharing only a non-identity (url/domain) alias", () => {
      // Reproduces the over-merge bug: a colleague who merely shares the
      // company domain/repo URL with the user must NOT be absorbed into self.
      // The literal value "acme.io" is shared across different alias TYPES,
      // which is allowed by the table-wide UNIQUE(alias_type, alias_value).
      const colleague = entities.create({
        entityType: "person",
        canonicalName: "Carol",
        aliases: [{ type: "url", value: "acme.io", source: "curator" }],
        crossProject: true,
      });
      const self = entities.create({
        entityType: "self",
        canonicalName: "Alice Smith",
        aliases: [
          { type: "email", value: "alice@acme.io", source: "auto" },
          { type: "domain", value: "acme.io", source: "auto" },
        ],
        crossProject: true,
      });

      // biome-ignore lint/style/noNonNullAssertion: getWithAliases() returns null for missing entities
      const selfEntity = entities.getWithAliases(self.id)!;
      const count = entities.mergeSelfPersonDuplicates(selfEntity);

      expect(count).toBe(0);
      expect(entities.get(colleague.id)).not.toBeNull(); // colleague preserved
    });

    test("records a self_merge audit row in dedup_feedback on absorb", () => {
      const person = entities.create({
        entityType: "person",
        canonicalName: "Ali",
        crossProject: true,
      });
      const self = entities.create({
        entityType: "self",
        canonicalName: "Alice Smith",
        aliases: [{ type: "nickname", value: "Ali", source: "config" }],
        crossProject: true,
      });

      // biome-ignore lint/style/noNonNullAssertion: getWithAliases() returns null for missing entities
      const selfEntity = entities.getWithAliases(self.id)!;
      const count = entities.mergeSelfPersonDuplicates(selfEntity);
      expect(count).toBe(1);
      expect(entities.get(person.id)).toBeNull();

      const rows = db()
        .query(
          "SELECT entry_a_title, entry_b_title, source, accepted, similarity FROM dedup_feedback WHERE kind = 'entity' AND source = 'self_merge'",
        )
        .all() as Array<{
        entry_a_title: string;
        entry_b_title: string;
        source: string;
        accepted: number;
        similarity: number;
      }>;
      expect(rows.length).toBe(1);
      expect(rows[0].entry_a_title).toBe("Alice Smith");
      expect(rows[0].entry_b_title).toBe("Ali");
      expect(rows[0].accepted).toBe(1);
      expect(rows[0].similarity).toBe(1.0);

      // Audit rows must NOT count toward dedup threshold calibration.
      expect(entities.getEntityDedupFeedbackCount(null)).toBe(0);
    });
  });
});

describe("entities.sync_rank (ref-count) maintenance (#1191b PR2b)", () => {
  const P = "/test/entities/sync-rank";
  beforeEach(() => {
    const d = db();
    d.exec("DELETE FROM knowledge_entity_refs");
    d.exec("DELETE FROM entities");
    d.exec("DELETE FROM knowledge");
    ensureProject(P);
  });

  const rankOf = (id: string): number =>
    (
      db().query("SELECT sync_rank FROM entities WHERE id = ?").get(id) as {
        sync_rank: number;
      }
    ).sync_rank;

  const mkKnowledge = (title: string, content: string): string =>
    ltm.create({
      projectPath: P,
      category: "decision",
      title,
      content,
      scope: "project",
    });

  test("linkKnowledge / unlinkKnowledge keep sync_rank = ref-count", () => {
    const e = entities.create({
      projectPath: P,
      entityType: "tool",
      canonicalName: "Widget",
    });
    expect(rankOf(e.id)).toBe(0); // fresh entity has no refs
    const k1 = mkKnowledge("K1", "first body");
    const k2 = mkKnowledge("K2", "second body");
    entities.linkKnowledge(k1, e.id);
    expect(rankOf(e.id)).toBe(1);
    entities.linkKnowledge(k2, e.id);
    expect(rankOf(e.id)).toBe(2);
    entities.linkKnowledge(k2, e.id); // INSERT OR IGNORE → no double count
    expect(rankOf(e.id)).toBe(2);
    entities.unlinkKnowledge(k1, e.id);
    expect(rankOf(e.id)).toBe(1);
  });

  test("syncEntityRefs recomputes sync_rank for entities that gain AND lose refs", () => {
    const e = entities.create({
      projectPath: P,
      entityType: "tool",
      canonicalName: "Postgres",
    });
    const k = mkKnowledge("DB", "We use Postgres for storage");
    entities.syncEntityRefs(k, "We use Postgres for storage"); // matches canonical name
    expect(rankOf(e.id)).toBe(1);
    // Re-sync with content that no longer mentions the entity → ref dropped, rank → 0.
    // Exercises the before∪after affected-set recompute (the entity is in the BEFORE set).
    entities.syncEntityRefs(k, "We switched to a different database");
    expect(rankOf(e.id)).toBe(0);
  });

  test("ltm.remove(knowledge) recomputes sync_rank of entities that lose the ref (F-1)", () => {
    const e = entities.create({
      projectPath: P,
      entityType: "tool",
      canonicalName: "Redis",
    });
    const k1 = mkKnowledge("K1", "first body");
    const k2 = mkKnowledge("K2", "second body");
    entities.linkKnowledge(k1, e.id);
    entities.linkKnowledge(k2, e.id);
    expect(rankOf(e.id)).toBe(2);
    ltm.remove(k1); // death-cert + explicit ref delete → e loses one ref
    expect(rankOf(e.id)).toBe(1); // not stale-high
  });

  test("resyncStaleEntityRanks repairs drift left by a bulk FK-cascade purge (F-1)", () => {
    const e = entities.create({
      projectPath: P,
      entityType: "tool",
      canonicalName: "Kafka",
    });
    const k = mkKnowledge("K", "body");
    entities.linkKnowledge(k, e.id);
    expect(rankOf(e.id)).toBe(1);
    // Simulate a bulk cascade purge that removes refs WITHOUT the per-entity recompute
    // (what clearProject/deleteProject/clearKnowledge trigger via FK ON DELETE CASCADE).
    db().exec("DELETE FROM knowledge_entity_refs");
    expect(rankOf(e.id)).toBe(1); // stale-high until repaired
    entities.resyncStaleEntityRanks();
    expect(rankOf(e.id)).toBe(0); // repaired to the live ref-count
  });
});
