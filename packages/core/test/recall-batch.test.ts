import { beforeEach, describe, expect, test, vi } from "vitest";
import { db, ensureProject } from "../src/db";
import * as entities from "../src/entities";
import * as ltm from "../src/ltm";
import {
  MAX_RECALL_BATCH_IDS,
  MAX_RECALL_ID_CHARS,
  recallById,
  runRecall,
  runRecallWithMetadata,
} from "../src/recall";

const PROJECT = "/test/recall-batch/project";

function seed(title: string, content: string): string {
  return ltm.create({
    projectPath: PROJECT,
    scope: "project",
    crossProject: false,
    category: "gotcha",
    title,
    content,
  });
}

function knowledge(id: string) {
  const entry = ltm.get(id);
  if (!entry) throw new Error(`missing seeded knowledge entry: ${id}`);
  return entry;
}

describe("recall detail batches", () => {
  beforeEach(() => {
    db().exec("DELETE FROM knowledge");
    ensureProject(PROJECT);
  });

  test("returns each unique source in first-request order with source coverage", async () => {
    const first = seed("First source", "first full detail");
    const second = seed("Second source", "second full detail");
    const firstLogical = knowledge(first).logical_id;

    const result = await runRecallWithMetadata({
      query: "",
      ids: [`k:${second}`, `k:${first}`, `k:${first}`, `k:${firstLogical}`],
      projectPath: PROJECT,
    });

    expect(result.result).toContain("## Recall Details");
    expect(result.result.indexOf("Second source")).toBeLessThan(
      result.result.indexOf("First source"),
    );
    expect(result.result.match(/First source/g)).toHaveLength(1);
    expect(result.coverage).toHaveLength(2);
    expect(result.coverage.map((coverage) => coverage.identity)).toEqual([
      `k:${knowledge(second).logical_id}`,
      `k:${firstLogical}`,
    ]);
  });

  test("labels missing IDs and respects the fixed batch bound", async () => {
    const ids = Array.from(
      { length: MAX_RECALL_BATCH_IDS + 1 },
      (_, index) => `k:missing-${index}`,
    );

    await expect(
      runRecall({ query: "", ids, projectPath: PROJECT }),
    ).rejects.toThrow(`at most ${MAX_RECALL_BATCH_IDS}`);

    const result = await runRecall({
      query: "",
      ids: ["k:missing"],
      projectPath: PROJECT,
    });
    expect(result).toContain("Outcome: unavailable");
    expect(result).toContain("No entry found for id: k:missing");
  });

  test("reports bounded partial detail with an offset for the remaining range", async () => {
    const id = seed("Large source", "x".repeat(20_000));

    const first = await runRecallWithMetadata({
      query: "",
      id: `k:${id}`,
      detailLimit: 400,
      projectPath: PROJECT,
    });
    expect(first.result).toContain("Detail truncated");
    expect(first.coverage).toMatchObject([
      { identity: `k:${knowledge(id).logical_id}`, offset: 0, complete: false },
    ]);

    const second = await runRecallWithMetadata({
      query: "",
      id: `k:${id}`,
      detailOffset: 400,
      detailLimit: 400,
      projectPath: PROJECT,
    });
    expect(second.coverage).toMatchObject([
      { identity: `k:${knowledge(id).logical_id}`, offset: 400 },
    ]);
    expect(second.result).not.toEqual(first.result);
  });

  test("paginates astral Unicode without skipping a trailing character", async () => {
    const id = seed("Unicode source", "x😀z");

    const first = await runRecallWithMetadata({
      query: "",
      id: `k:${id}`,
      detailLimit: 2,
      projectPath: PROJECT,
    });
    expect(first.result).toContain("x😀");
    expect(first.coverage).toMatchObject([
      { offset: 0, length: 2, complete: false },
    ]);

    const second = await runRecallWithMetadata({
      query: "",
      id: `k:${id}`,
      detailOffset: 2,
      detailLimit: 2,
      projectPath: PROJECT,
    });
    expect(second.result).toContain("z");
    expect(second.coverage).toMatchObject([
      { offset: 2, length: 1, complete: true },
    ]);
  });

  test("counts astral Unicode in batch output budgets by code point", async () => {
    const emoji = seed("Emoji budget source", "😀".repeat(12_000));
    const second = seed("Second budget source", "x".repeat(10_000));
    const third = seed("Third budget source", "third source remains available");

    const result = await runRecallWithMetadata({
      query: "",
      ids: [`k:${emoji}`, `k:${second}`, `k:${third}`],
      projectPath: PROJECT,
    });

    expect(result.result).toContain("Third budget source");
    expect(result.result).not.toContain("batch output limit reached");
    expect(result.coverage).toHaveLength(3);
  });

  test("renders a detail page without hydrating the full knowledge entry", async () => {
    const id = seed("Paged source", "x".repeat(20_000));
    const get = vi.spyOn(ltm, "get").mockImplementation(() => {
      throw new Error("full knowledge hydration must not occur for a page");
    });

    try {
      const page = await runRecallWithMetadata({
        query: "",
        id: `k:${id}`,
        detailLimit: 400,
        projectPath: PROJECT,
      });
      expect(page.result).toContain("Paged source");
      expect(page.coverage).toMatchObject([{ length: 400, complete: false }]);
      expect(get).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
    }
  });

  test("rejects oversized IDs without echoing them into a recall result", async () => {
    const oversized = `k:${"x".repeat(MAX_RECALL_ID_CHARS)}`;

    await expect(
      runRecall({ query: "", id: oversized, projectPath: PROJECT }),
    ).rejects.toThrow(`no longer than ${MAX_RECALL_ID_CHARS}`);
    await expect(
      runRecall({ query: "", ids: [oversized], projectPath: PROJECT }),
    ).rejects.toThrow(`no longer than ${MAX_RECALL_ID_CHARS}`);
    expect(recallById(oversized)).toBe("Invalid recall id.");
  });

  test("distinguishes a search preview from a subsequent full detail", async () => {
    const id = seed("Coverage source", "coverage evidence for a later detail");
    const logicalId = knowledge(id).logical_id;
    const preview = await runRecallWithMetadata({
      query: "coverage evidence",
      projectPath: PROJECT,
    });
    const detail = await runRecallWithMetadata({
      query: "",
      id: `k:${id}`,
      projectPath: PROJECT,
    });

    expect(preview.coverage).toContainEqual(
      expect.objectContaining({ identity: `k:${logicalId}`, kind: "preview" }),
    );
    expect(detail.coverage).toMatchObject([
      { identity: `k:${logicalId}`, kind: "detail", complete: true },
    ]);
  });

  test("preserves bounded aliases and relations in an entity detail", async () => {
    const person = entities.create({
      projectPath: PROJECT,
      entityType: "person",
      canonicalName: "Ada Lovelace",
      aliases: [{ type: "nickname", value: "Ada" }],
    });
    const partner = entities.create({
      projectPath: PROJECT,
      entityType: "person",
      canonicalName: "Charles Babbage",
    });
    entities.addRelation(person.id, partner.id, "partner");

    try {
      const result = await runRecall({
        query: "",
        id: `e:${person.id}`,
        projectPath: PROJECT,
      });
      expect(result).toContain("nickname:Ada");
      expect(result).toContain("Relations: partner of Charles Babbage");
    } finally {
      entities.remove(person.id);
      entities.remove(partner.id);
    }
  });

  test("advances entity detail coverage when aliases or relations change", async () => {
    const person = entities.create({
      projectPath: PROJECT,
      entityType: "person",
      canonicalName: "Ada Lovelace",
    });
    const partner = entities.create({
      projectPath: PROJECT,
      entityType: "person",
      canonicalName: "Charles Babbage",
    });
    const clock = vi.spyOn(Date, "now");

    try {
      const before = await runRecallWithMetadata({
        query: "",
        id: `e:${person.id}`,
        projectPath: PROJECT,
      });
      const now = Date.now();
      clock.mockReturnValue(now + 1);
      entities.addAlias(person.id, "nickname", "Ada");
      const afterAlias = await runRecallWithMetadata({
        query: "",
        id: `e:${person.id}`,
        projectPath: PROJECT,
      });
      clock.mockReturnValue(now + 2);
      entities.addRelation(person.id, partner.id, "partner");
      const afterRelation = await runRecallWithMetadata({
        query: "",
        id: `e:${person.id}`,
        projectPath: PROJECT,
      });

      expect(afterAlias.coverage[0].revision).not.toBe(
        before.coverage[0].revision,
      );
      expect(afterRelation.coverage[0].revision).not.toBe(
        afterAlias.coverage[0].revision,
      );
    } finally {
      clock.mockRestore();
      entities.remove(person.id);
      entities.remove(partner.id);
    }
  });
});
