import { uuidv7 } from "uuidv7";
import { describe, expect, test } from "vitest";
import { db, ensureProject } from "../src/db";
import * as entities from "../src/entities";
import { create as createKnowledge } from "../src/ltm";
import { runRecallWithMetadata } from "../src/recall";

function seedDetailFixture() {
  const currentProjectPath = `/test/recall-detail-scope/${crypto.randomUUID()}`;
  const otherProjectPath = `/test/recall-detail-scope/${crypto.randomUUID()}`;
  const currentProjectId = ensureProject(currentProjectPath);
  const otherProjectId = ensureProject(otherProjectPath);
  const ids = {
    currentDistillation: uuidv7(),
    otherSessionDistillation: uuidv7(),
    foreignDistillation: uuidv7(),
    currentTemporal: uuidv7(),
    otherSessionTemporal: uuidv7(),
    foreignTemporal: uuidv7(),
    currentLat: uuidv7(),
    foreignLat: uuidv7(),
  };
  const distillation = db().query(
    `INSERT INTO distillations
       (id, project_id, session_id, narrative, facts, observations, source_ids,
        generation, token_count, archived, created_at)
     VALUES (?, ?, ?, '', '[]', ?, '[]', 0, 1, 0, ?)`,
  );
  const now = Date.now();
  distillation.run(
    ids.currentDistillation,
    currentProjectId,
    "current-session",
    "current-project distillation secret",
    now,
  );
  distillation.run(
    ids.otherSessionDistillation,
    currentProjectId,
    "other-session",
    "other-session distillation secret",
    now,
  );
  distillation.run(
    ids.foreignDistillation,
    otherProjectId,
    "current-session",
    "foreign-project distillation secret",
    now,
  );
  db()
    .query("UPDATE distillations SET source_ids = ? WHERE id = ?")
    .run(JSON.stringify([ids.currentTemporal]), ids.currentDistillation);

  const temporal = db().query(
    `INSERT INTO temporal_messages
       (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
     VALUES (?, ?, ?, 'user', ?, 1, 0, ?, '{}')`,
  );
  temporal.run(
    ids.currentTemporal,
    currentProjectId,
    "current-session",
    "current-project temporal secret",
    now,
  );
  temporal.run(
    ids.otherSessionTemporal,
    currentProjectId,
    "other-session",
    "other-session temporal secret",
    now,
  );
  temporal.run(
    ids.foreignTemporal,
    otherProjectId,
    "current-session",
    "foreign-project temporal secret",
    now,
  );

  const lat = db().query(
    `INSERT INTO lat_sections
       (id, project_id, file, heading, depth, content, content_hash, updated_at)
     VALUES (?, ?, 'rules.md', 'Build rule', 1, ?, ?, ?)`,
  );
  lat.run(
    ids.currentLat,
    currentProjectId,
    "current-project LAT secret",
    "current-lat-hash",
    now,
  );
  lat.run(
    ids.foreignLat,
    otherProjectId,
    "foreign-project LAT secret",
    "foreign-lat-hash",
    now,
  );

  return { currentProjectPath, otherProjectPath, ids };
}

describe("recall detail scope", () => {
  test.each([
    ["d", "currentDistillation", "foreignDistillation", "distillation"],
    ["t", "currentTemporal", "foreignTemporal", "temporal"],
    ["lat", "currentLat", "foreignLat", "LAT"],
  ] as const)(
    "keeps %s detail within the current project",
    async (prefix, currentKey, foreignKey, sourceName) => {
      const fixture = seedDetailFixture();
      const current = await runRecallWithMetadata({
        query: "detail",
        id: `${prefix}:${fixture.ids[currentKey]}`,
        scope: "project",
        projectPath: fixture.currentProjectPath,
      });
      const foreign = await runRecallWithMetadata({
        query: "detail",
        id: `${prefix}:${fixture.ids[foreignKey]}`,
        scope: "project",
        projectPath: fixture.currentProjectPath,
      });

      expect(current.result).toContain(`current-project ${sourceName} secret`);
      expect(foreign.result).not.toContain(
        `foreign-project ${sourceName} secret`,
      );
      expect(foreign.coverage).toEqual([]);
    },
  );

  test.each([
    ["d", "currentDistillation", "otherSessionDistillation", "distillation"],
    ["t", "currentTemporal", "otherSessionTemporal", "temporal"],
  ] as const)(
    "keeps %s detail within the requested session",
    async (prefix, currentKey, otherSessionKey, sourceName) => {
      const fixture = seedDetailFixture();
      const current = await runRecallWithMetadata({
        query: "detail",
        id: `${prefix}:${fixture.ids[currentKey]}`,
        scope: "session",
        projectPath: fixture.currentProjectPath,
        sessionID: "current-session",
      });
      const otherSession = await runRecallWithMetadata({
        query: "detail",
        id: `${prefix}:${fixture.ids[otherSessionKey]}`,
        scope: "session",
        projectPath: fixture.currentProjectPath,
        sessionID: "current-session",
      });

      expect(current.result).toContain(`current-project ${sourceName} secret`);
      expect(otherSession.result).not.toContain(
        `other-session ${sourceName} secret`,
      );
      expect(otherSession.coverage).toEqual([]);
    },
  );

  test("requires a session ID for session searches and detail reads", async () => {
    const fixture = seedDetailFixture();

    await expect(
      runRecallWithMetadata({
        query: "session secret",
        scope: "session",
        projectPath: fixture.currentProjectPath,
      }),
    ).rejects.toThrow("Recall session scope requires a session ID");
    await expect(
      runRecallWithMetadata({
        query: "detail",
        id: `t:${fixture.ids.currentTemporal}`,
        scope: "session",
        projectPath: fixture.currentProjectPath,
      }),
    ).rejects.toThrow("Recall session scope requires a session ID");
  });

  test("does not let detail IDs bypass source-scope restrictions", async () => {
    const fixture = seedDetailFixture();
    const knowledgeId = createKnowledge({
      projectPath: fixture.currentProjectPath,
      category: "gotcha",
      title: `recall detail scope ${crypto.randomUUID()}`,
      content: "knowledge detail secret",
      scope: "project",
    });

    const sessionKnowledge = await runRecallWithMetadata({
      query: "detail",
      id: `k:${knowledgeId}`,
      scope: "session",
      projectPath: fixture.currentProjectPath,
      sessionID: "current-session",
    });
    const knowledgeDistillation = await runRecallWithMetadata({
      query: "detail",
      id: `d:${fixture.ids.currentDistillation}`,
      scope: "knowledge",
      projectPath: fixture.currentProjectPath,
    });
    const disabledKnowledge = await runRecallWithMetadata({
      query: "detail",
      id: `k:${knowledgeId}`,
      scope: "project",
      projectPath: fixture.currentProjectPath,
      knowledgeEnabled: false,
    });
    const sessionLat = await runRecallWithMetadata({
      query: "detail",
      id: `lat:${fixture.ids.currentLat}`,
      scope: "session",
      projectPath: fixture.currentProjectPath,
      sessionID: "current-session",
    });
    const knowledgeEntity = await runRecallWithMetadata({
      query: "detail",
      id: `e:${
        entities.create({
          projectPath: fixture.currentProjectPath,
          entityType: "infra",
          canonicalName: `scope entity ${crypto.randomUUID()}`,
        }).id
      }`,
      scope: "knowledge",
      projectPath: fixture.currentProjectPath,
    });
    const knowledgeLat = await runRecallWithMetadata({
      query: "detail",
      id: `lat:${fixture.ids.currentLat}`,
      scope: "knowledge",
      projectPath: fixture.currentProjectPath,
    });

    expect(sessionKnowledge.result).not.toContain("knowledge detail secret");
    expect(sessionKnowledge.coverage).toEqual([]);
    expect(knowledgeDistillation.result).not.toContain(
      "current-project distillation secret",
    );
    expect(knowledgeDistillation.coverage).toEqual([]);
    expect(disabledKnowledge.result).not.toContain("knowledge detail secret");
    expect(disabledKnowledge.coverage).toEqual([]);
    expect(sessionLat.result).not.toContain("current-project LAT secret");
    expect(sessionLat.coverage).toEqual([]);
    expect(knowledgeEntity.coverage).toEqual([]);
    expect(knowledgeLat.result).toContain("current-project LAT secret");
  });

  test("keeps foreign knowledge and entities behind their recall scopes", async () => {
    const fixture = seedDetailFixture();
    const foreignKnowledgeId = createKnowledge({
      projectPath: fixture.otherProjectPath,
      category: "gotcha",
      title: `foreign detail ${crypto.randomUUID()}`,
      content: "foreign knowledge secret",
      scope: "project",
    });
    const foreignInfra = entities.create({
      projectPath: fixture.otherProjectPath,
      entityType: "infra",
      canonicalName: `foreign infra ${crypto.randomUUID()}`,
      metadata: { note: "foreign entity secret" },
    });
    const foreignRepo = entities.create({
      projectPath: fixture.otherProjectPath,
      entityType: "repo",
      canonicalName: `foreign repo ${crypto.randomUUID()}`,
      metadata: { note: "foreign repo detail" },
    });

    const projectKnowledge = await runRecallWithMetadata({
      query: "detail",
      id: `k:${foreignKnowledgeId}`,
      scope: "project",
      projectPath: fixture.currentProjectPath,
    });
    const projectCrossKnowledge = await runRecallWithMetadata({
      query: "detail",
      id: `xk:${foreignKnowledgeId}`,
      scope: "project",
      projectPath: fixture.currentProjectPath,
    });
    const allCrossKnowledge = await runRecallWithMetadata({
      query: "detail",
      id: `xk:${foreignKnowledgeId}`,
      scope: "all",
      projectPath: fixture.currentProjectPath,
    });
    const allForeignInfra = await runRecallWithMetadata({
      query: "detail",
      id: `e:${foreignInfra.id}`,
      scope: "all",
      projectPath: fixture.currentProjectPath,
    });
    const allForeignRepo = await runRecallWithMetadata({
      query: "detail",
      id: `e:${foreignRepo.id}`,
      scope: "all",
      projectPath: fixture.currentProjectPath,
    });

    expect(projectKnowledge.coverage).toEqual([]);
    expect(projectCrossKnowledge.coverage).toEqual([]);
    expect(allCrossKnowledge.result).toContain("foreign knowledge secret");
    expect(allForeignInfra.result).not.toContain("foreign entity secret");
    expect(allForeignInfra.coverage).toEqual([]);
    expect(allForeignRepo.result).toContain("foreign repo detail");
  });

  test("does not render requested IDs or private coverage metadata", async () => {
    const fixture = seedDetailFixture();
    const id = `t:${fixture.ids.currentTemporal}`;
    const recall = await runRecallWithMetadata({
      query: "detail",
      id,
      projectPath: fixture.currentProjectPath,
    });

    expect(recall.result).toContain("current-project temporal secret");
    expect(recall.result).not.toContain(id);
    expect(recall.result).not.toContain(fixture.ids.currentTemporal);
    expect(recall.result).not.toContain("revision");
    expect(recall.result).not.toContain("coverage");
    expect(recall.coverage).toMatchObject([{ identity: id }]);
  });

  test("does not render source IDs when searching distillations", async () => {
    const fixture = seedDetailFixture();
    const recall = await runRecallWithMetadata({
      query: "distillation secret",
      scope: "project",
      projectPath: fixture.currentProjectPath,
    });

    expect(recall.result).toContain("current-project distillation secret");
    expect(recall.result).not.toContain(fixture.ids.currentDistillation);
    expect(recall.result).not.toContain(`t:${fixture.ids.currentTemporal}`);
    expect(recall.result).not.toContain("source_ids");
  });
});
