import { beforeEach, describe, expect, test } from "vitest";
import { db, ensureProject } from "../src/db";
import * as entities from "../src/entities";
import * as ltm from "../src/ltm";
import { recallById, runRecall, searchRecall } from "../src/recall";

describe("recallById('k:..') — append-only logical_id resolution (A2, #823)", () => {
  const PROJECT = "/test/recall/k-a2";
  beforeEach(() => {
    const pid = ensureProject(PROJECT);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
  });

  test("resolves a logical_id whose current version has a different row id", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "RecallA2",
      content: "v1 detail body",
    });
    ltm.update(id, { content: "v2 detail body" }); // appends → id is now superseded
    // id is the stable logical_id; without the getByLogical fallback this returns
    // "No entry found" because get(id) misses the superseded v1 row.
    const detail = recallById(`k:${id}`);
    expect(detail).not.toContain("No entry found");
    expect(detail).toContain("v2 detail body"); // current version content
  });

  test("returns not-found for an unknown knowledge id", () => {
    expect(recallById("k:019eac47-0000-0000-0000-000000000000")).toContain(
      "No entry found",
    );
  });
});

const PROJECT = "/test/recall-entity/project";

function cleanup() {
  const d = db();
  d.exec("DELETE FROM entity_relations");
  d.exec("DELETE FROM knowledge_entity_refs");
  d.exec("DELETE FROM entity_aliases");
  d.exec("DELETE FROM entities");
}

/** Seed a self entity + a "person" with aliases and a partner relation. */
function seedPeople() {
  const self = entities.create({
    entityType: "self",
    canonicalName: "Burak Yigit Kaya",
    crossProject: true,
  });
  const wife = entities.create({
    entityType: "person",
    canonicalName: "Seylan Çinar Kaya",
    aliases: [
      { type: "email", value: "seylan@withlore.ai" },
      { type: "nickname", value: "Seylan" },
    ],
    crossProject: true,
  });
  entities.addRelation(self.id, wife.id, "partner", { source: "test" });
  return { selfId: self.id, wifeId: wife.id };
}

describe("recall — entity source", () => {
  beforeEach(() => {
    cleanup();
    ensureProject(PROJECT);
  });

  test("surfaces a matching entity as a recall result", async () => {
    const { wifeId } = seedPeople();
    const results = await searchRecall({
      query: "Seylan",
      projectPath: PROJECT,
      scope: "all",
    });
    const r = results.find((x) => x.item.source === "entity");
    expect(r).toBeDefined();
    if (r && r.item.source === "entity") {
      expect(r.item.item.id).toBe(wifeId);
    }
  });

  test("matches by alias too (email)", async () => {
    seedPeople();
    const results = await searchRecall({
      query: "seylan@withlore.ai",
      projectPath: PROJECT,
      scope: "all",
    });
    expect(results.some((x) => x.item.source === "entity")).toBe(true);
  });

  test("runRecall renders the entity with its relation and header", async () => {
    seedPeople();
    const md = await runRecall({
      query: "Seylan",
      projectPath: PROJECT,
      scope: "all",
    });
    expect(md).toContain("People & Entities");
    expect(md).toContain("Seylan Çinar Kaya");
    expect(md).toContain("partner of Burak Yigit Kaya");
  });

  test("recallById('e:..') returns full detail including relations", () => {
    const { wifeId } = seedPeople();
    const detail = recallById(`e:${wifeId}`);
    expect(detail).toContain("Recall Detail");
    expect(detail).toContain("Seylan Çinar Kaya");
    // Drill-down must not be less informative than the summary line.
    expect(detail).toContain("partner of Burak Yigit Kaya");
  });

  test("recallById returns not-found for a missing entity id", () => {
    const detail = recallById("e:019eac47-0000-0000-0000-000000000000");
    expect(detail).toContain("No entry found");
  });

  test("does not leak another project's project-scoped infra entity", async () => {
    // `infra` entities (servers, queues, buckets) are project-specific and stay
    // project-scoped (cross_project = 0) even in "all" scope — they must never
    // surface across projects.
    const OTHER_PROJECT = "/test/recall-entity/other";
    ensureProject(OTHER_PROJECT);
    entities.create({
      projectPath: OTHER_PROJECT,
      entityType: "infra",
      canonicalName: "secretserver",
    });

    const results = await searchRecall({
      query: "secretserver",
      projectPath: PROJECT,
      scope: "all",
    });
    expect(results.some((x) => x.item.source === "entity")).toBe(false);
  });

  test("surfaces another project's repo entity in 'all' scope only", async () => {
    // `repo` entities default to project-scoped, but a repo the user references
    // by name from another project must be discoverable via recall in the
    // default "all" scope (cross-project repo discovery). Narrower scopes keep
    // the project-scoped visibility guard.
    const OTHER_PROJECT = "/test/recall-entity/other-repo";
    ensureProject(OTHER_PROJECT);
    const repo = entities.create({
      projectPath: OTHER_PROJECT,
      entityType: "repo",
      canonicalName: "sentry-cli-typescript",
    });

    const all = await searchRecall({
      query: "sentry-cli-typescript",
      projectPath: PROJECT,
      scope: "all",
    });
    const hit = all.find((x) => x.item.source === "entity");
    expect(hit).toBeDefined();
    if (hit && hit.item.source === "entity") {
      expect(hit.item.item.id).toBe(repo.id);
    }

    // "project" scope must NOT surface another project's repo.
    const proj = await searchRecall({
      query: "sentry-cli-typescript",
      projectPath: PROJECT,
      scope: "project",
    });
    expect(proj.some((x) => x.item.source === "entity")).toBe(false);
  });

  test("excludes entities from 'knowledge' and 'session' scopes", async () => {
    seedPeople();
    const kn = await searchRecall({
      query: "Seylan",
      projectPath: PROJECT,
      scope: "knowledge",
    });
    expect(kn.some((x) => x.item.source === "entity")).toBe(false);

    const ses = await searchRecall({
      query: "Seylan",
      projectPath: PROJECT,
      scope: "session",
      sessionID: "test-session",
    });
    expect(ses.some((x) => x.item.source === "entity")).toBe(false);
  });
});
