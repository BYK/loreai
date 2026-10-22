import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { config } from "../src/config";
import { create as createKnowledge } from "../src/ltm";
import { projectId } from "../src/db";
import {
  createRecallToolExecutor,
  type RecallToolRunner,
} from "../src/recall-tool";
import { runRecallWithMetadata } from "../src/recall";

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
});
