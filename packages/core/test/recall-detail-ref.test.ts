import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { config } from "../src/config";
import { create as createKnowledge, setFileRefs } from "../src/ltm";
import { ensureProject, projectId, db } from "../src/db";
import { registerSink, type LogSink } from "../src/log";
import * as entities from "../src/entities";
import {
  createRecallToolExecutor,
  type RecallToolRunner,
} from "../src/recall-tool";
import { runRecallWithMetadata } from "../src/recall";

const passThroughLogSink: LogSink = {
  info() {},
  warn() {},
  error() {},
  captureException() {},
};

describe("recall detail references", () => {
  test("lets the caller fetch truncated detail without exposing its source ID", async () => {
    const projectPath = `/test/recall-detail-ref/${randomUUID()}`;
    const otherProjectPath = `/test/recall-detail-ref/${randomUUID()}`;
    const sessionID = randomUUID();
    const marker = `detail-ref-body-${randomUUID()}`;
    const title = `detail-ref-title-${randomUUID()}`;
    const content = Array.from({ length: 100 }, () => `${marker}.`).join(" ");
    const sourceId = createKnowledge({
      projectPath,
      category: "gotcha",
      title,
      content,
      scope: "project",
    });

    const baseConfig = config();
    const runner: RecallToolRunner = (input) =>
      runRecallWithMetadata({
        ...input,
        searchConfig: {
          ...baseConfig.search,
          queryExpansion: false,
          embeddings: { ...baseConfig.search.embeddings, enabled: false },
        },
      }).then((result) => result.result);
    const execute = createRecallToolExecutor(runner, () => baseConfig);
    const context = { projectPath, sessionID };
    const noSessionPreview = await execute(
      { query: title, scope: "project" },
      {
        projectPath,
      },
    );
    expect(noSessionPreview).not.toContain("detail ref:");
    expect(noSessionPreview).not.toContain(sourceId);

    const directNoSession = await runRecallWithMetadata({
      query: title,
      projectPath,
      scope: "project",
      detailRefs: true,
      searchConfig: {
        ...baseConfig.search,
        queryExpansion: false,
        embeddings: { ...baseConfig.search.embeddings, enabled: false },
      },
    });
    expect(directNoSession.result).not.toContain("detail ref:");

    const preview = await execute({ query: title, scope: "project" }, context);
    const detailRef = preview.match(/detail ref: `([^`]+)`/)?.[1];

    expect(detailRef).toMatch(/^r:[0-9a-f-]{36}$/);
    expect(preview).not.toContain(sourceId);

    const detail = await execute({ id: detailRef }, context);
    expect(detail).toContain(marker);

    for (const scope of ["all", "project", "knowledge"] as const) {
      const scopedPreview = await execute({ query: title, scope }, context);
      const scopedRef = scopedPreview.match(/detail ref: `([^`]+)`/)?.[1];
      expect(scopedRef).toMatch(/^r:[0-9a-f-]{36}$/);

      const wrongSession = await execute(
        { id: scopedRef, scope },
        { projectPath, sessionID: randomUUID() },
      );
      expect(wrongSession).not.toContain(marker);
    }

    const wrongProject = await execute(
      { id: detailRef, scope: "project" },
      { projectPath: otherProjectPath, sessionID },
    );
    expect(wrongProject).not.toContain(marker);

    const unknownProjectPath = `/test/recall-detail-unknown/${randomUUID()}`;
    expect(projectId(unknownProjectPath)).toBeUndefined();
    const unknownProject = await execute(
      { id: detailRef, scope: "project" },
      { projectPath: unknownProjectPath, sessionID },
    );
    expect(unknownProject).not.toContain(marker);
    expect(projectId(unknownProjectPath)).toBeUndefined();

    const wrongScope = await execute(
      { id: detailRef, scope: "session" },
      context,
    );
    expect(wrongScope).not.toContain(marker);
  });

  test("does not emit a detail ref when only an oversized title exceeds budget", async () => {
    const projectPath = `/test/recall-detail-ref/${randomUUID()}`;
    const sessionID = randomUUID();
    const marker = `oversized-title-${randomUUID()}`;
    const title = `${marker} ${"title".repeat(48)}`;
    createKnowledge({
      projectPath,
      category: "gotcha",
      title,
      content: "Short body.",
      scope: "project",
    });

    const baseConfig = config();
    const result = await runRecallWithMetadata({
      query: marker,
      projectPath,
      sessionID,
      scope: "knowledge",
      detailRefs: true,
      searchConfig: {
        ...baseConfig.search,
        queryExpansion: false,
        embeddings: { ...baseConfig.search.embeddings, enabled: false },
        recall: { ...baseConfig.search.recall, charBudget: 80 },
      },
    });

    expect(result.result).toContain(`**${title}**`);
    expect(result.result).toContain("Short body.");
    expect(result.result).not.toContain("detail ref:");
    expect(result.result).toContain("*1 of 1 results shown.*");
  });

  test("keeps secondary detail paths on the same ownership snapshot", async () => {
    const projectPath = `/test/recall-detail-snapshot/${randomUUID()}`;
    const otherProjectPath = `/test/recall-detail-snapshot/${randomUUID()}`;
    const title = `detail-snapshot-title-${randomUUID()}`;
    const sourceId = createKnowledge({
      projectPath,
      category: "gotcha",
      title,
      content: `Visible before ownership changes: ${title}.`,
      scope: "project",
    });
    const logicalId = (
      db()
        .query("SELECT logical_id FROM knowledge WHERE id = ?")
        .get(sourceId) as { logical_id: string }
    ).logical_id;
    const localPath = "project-local/src/original.ts";
    const foreignPath = "foreign-private/src/secret.ts";
    const localAnchor = "project-local/src/original.ts:7";
    const foreignAnchor = "foreign-private/src/secret.ts:99";
    setFileRefs(logicalId, [localPath]);
    db()
      .query(
        "INSERT INTO knowledge_ref_anchor (logical_id, kind, anchor, updated_at) VALUES (?, 'file', ?, 1)",
      )
      .run(logicalId, localAnchor);
    const foreignProjectId = ensureProject(otherProjectPath);
    let ownershipChanged = false;

    registerSink({
      ...passThroughLogSink,
      withDbSpan<T>(sql: string, run: () => T): T {
        if (!ownershipChanged && sql.includes("FROM knowledge_ref_anchor a")) {
          ownershipChanged = true;
          const external = new DatabaseSync(process.env.LORE_DB_PATH!);
          try {
            external
              .prepare(
                "UPDATE knowledge SET project_id = ?, cross_project = 0 WHERE logical_id = ? AND is_current = 1 AND is_deleted = 0",
              )
              .run(foreignProjectId, logicalId);
            external
              .prepare(
                "UPDATE knowledge_file_refs SET paths_json = ? WHERE logical_id = ?",
              )
              .run(JSON.stringify([foreignPath]), logicalId);
            external
              .prepare(
                "UPDATE knowledge_ref_anchor SET anchor = ? WHERE logical_id = ? AND kind = 'file'",
              )
              .run(foreignAnchor, logicalId);
          } finally {
            external.close();
          }
        }
        return run();
      },
    });

    try {
      const result = await runRecallWithMetadata({
        query: title,
        id: `k:${sourceId}`,
        projectPath,
        scope: "project",
      });
      expect(ownershipChanged).toBe(true);
      expect(result.result).toContain(localAnchor);
      expect(result.result).toContain(localPath);
      expect(result.result).not.toContain(foreignAnchor);
      expect(result.result).not.toContain(foreignPath);
    } finally {
      registerSink(passThroughLogSink);
    }
  });

  test("keeps entity aliases on the same ownership snapshot", async () => {
    const projectPath = `/test/recall-detail-alias-snapshot/${randomUUID()}`;
    const otherProjectPath = `/test/recall-detail-alias-snapshot/${randomUUID()}`;
    const canonicalName = `snapshot entity ${randomUUID()}`;
    const localAlias = `local-alias-${randomUUID()}`;
    const foreignAlias = `foreign-alias-${randomUUID()}`;
    const entity = entities.create({
      projectPath,
      entityType: "infra",
      canonicalName,
      metadata: { note: "visible before ownership changes" },
    });
    entities.addAlias(entity.id, "nickname", localAlias);
    const foreignProjectId = ensureProject(otherProjectPath);
    let ownershipChanged = false;

    registerSink({
      ...passThroughLogSink,
      withDbSpan<T>(sql: string, run: () => T): T {
        if (!ownershipChanged && sql.includes("FROM entity_aliases ea")) {
          ownershipChanged = true;
          const external = new DatabaseSync(process.env.LORE_DB_PATH!);
          try {
            external
              .prepare(
                "UPDATE entities SET project_id = ?, cross_project = 0 WHERE id = ?",
              )
              .run(foreignProjectId, entity.id);
            external
              .prepare(
                "UPDATE entity_aliases SET alias_value = ? WHERE entity_id = ? AND alias_value = ?",
              )
              .run(foreignAlias, entity.id, localAlias);
          } finally {
            external.close();
          }
        }
        return run();
      },
    });

    try {
      const result = await runRecallWithMetadata({
        query: canonicalName,
        id: `e:${entity.id}`,
        projectPath,
        scope: "project",
      });
      expect(ownershipChanged).toBe(true);
      expect(result.result).toContain(`nickname:${localAlias}`);
      expect(result.result).not.toContain(foreignAlias);
    } finally {
      registerSink(passThroughLogSink);
    }
  });
});
