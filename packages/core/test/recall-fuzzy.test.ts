import { beforeEach, describe, expect, test, vi } from "vitest";
import { LoreConfig } from "../src/config";
import { db, ensureProject } from "../src/db";
import * as embedding from "../src/embedding";
import * as ltm from "../src/ltm";
import { runRecall, searchRecall } from "../src/recall";

// The fuzzy title leg (#1978): a gated, low-weight supplemental RRF list that
// rescues typo'd queries when the exact FTS + vector legs underfill
// `recallLimit`. `ltm.searchScored` itself stays exact-only.

const PROJECT = "/test/recall-fuzzy/project";
const OTHER = "/test/recall-fuzzy/other";

function cleanup() {
  db().exec("DELETE FROM knowledge");
  db().exec("DELETE FROM distillations");
  db().exec("DELETE FROM temporal_messages");
}

function seed(
  title: string,
  overrides: {
    projectPath?: string;
    crossProject?: boolean;
    confidence?: number;
  } = {},
): string {
  return ltm.create({
    projectPath: overrides.projectPath ?? PROJECT,
    scope: "project",
    crossProject: overrides.crossProject ?? false,
    confidence: overrides.confidence,
    category: "gotcha",
    title,
    content: `Content for ${title}`,
  });
}

type KnowledgeTagged = Extract<
  import("../src/recall").TaggedResult,
  { source: "knowledge" }
>;

const knowledgeItems = (results: Awaited<ReturnType<typeof searchRecall>>) =>
  results.filter(
    (r): r is { item: KnowledgeTagged; score: number } =>
      r.item.source === "knowledge",
  );

describe("recall — fuzzy title leg (#1978)", () => {
  beforeEach(() => {
    cleanup();
    ensureProject(PROJECT);
    ensureProject(OTHER);
    vi.restoreAllMocks();
    // The vector leg stays deterministic — these tests cover the
    // FTS-then-fuzzy cascade, not embeddings.
    vi.spyOn(embedding, "isAvailable").mockReturnValue(false);
  });

  test("typo'd query surfaces the entry flagged fuzzy and rendered approximate", async () => {
    const id = seed("Use cursor pagination for knowledge lists");
    const results = await searchRecall({
      query: "curosr paginaton",
      projectPath: PROJECT,
      scope: "project",
    });
    const hits = knowledgeItems(results);
    const fuzzy = hits.find((r) => r.item.item.logical_id === id);
    expect(fuzzy).toBeDefined();
    expect(fuzzy!.item.item.match).toBe("fuzzy");

    const rendered = await runRecall({
      query: "curosr paginaton",
      projectPath: PROJECT,
      scope: "project",
    });
    expect(rendered).toContain("Use cursor pagination");
    expect(rendered).toContain("approximate");
  });

  test("exact hits rank above fuzzy and carry no match flag", async () => {
    const exactId = seed("Cursor pagination edge cases");
    const fuzzyId = seed("Cursxor paginaton unrelated");
    const results = await searchRecall({
      query: "cursor pagination",
      projectPath: PROJECT,
      scope: "project",
    });
    const hits = knowledgeItems(results);
    const exact = hits.find((r) => r.item.item.logical_id === exactId);
    const fuzzy = hits.find((r) => r.item.item.logical_id === fuzzyId);
    expect(exact).toBeDefined();
    expect(exact!.item.item.match).toBeUndefined();
    if (fuzzy) {
      expect(fuzzy.item.item.match).toBe("fuzzy");
      expect(results.indexOf(exact!)).toBeLessThan(results.indexOf(fuzzy));
    }
  });

  test("the leg is skipped when exact results already fill recallLimit", async () => {
    const cfg = LoreConfig.parse({ search: { recallLimit: 2 } }).search;
    seed("Alpha beta gamma one");
    seed("Alpha beta gamma two");
    seed("Alpha beta gamma three");
    const spy = vi.spyOn(ltm, "fuzzyTitleCandidates");
    await searchRecall({
      query: "alpha beta gamma",
      projectPath: PROJECT,
      scope: "project",
      searchConfig: cfg,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  test("fuzzy-only output is capped at MAX_FUZZY_RECALL rows", async () => {
    for (let i = 0; i < 5; i++) seed(`Knwoledge sibling ${i}`);
    const results = await searchRecall({
      query: "knowledge sibling",
      projectPath: PROJECT,
      scope: "project",
    });
    const fuzzy = knowledgeItems(results).filter(
      (r) => r.item.item.match === "fuzzy",
    );
    expect(fuzzy.length).toBeLessThanOrEqual(2);
  });

  test("project visibility and confidence predicates constrain the leg", async () => {
    const outside = seed("Knwoledge faraway", { projectPath: OTHER });
    const lowConfidence = seed("Knwoledge murky", { confidence: 0.1 });
    const results = await searchRecall({
      query: "knowledge faraway",
      projectPath: PROJECT,
      scope: "project",
    });
    const ids = knowledgeItems(results).map((r) => r.item.item.logical_id);
    expect(ids).not.toContain(outside);
    expect(ids).not.toContain(lowConfidence);
  });

  test("search.fuzzyRecall = false disables the leg entirely", async () => {
    const cfg = LoreConfig.parse({ search: { fuzzyRecall: false } }).search;
    seed("Knwoledge gated out");
    const spy = vi.spyOn(ltm, "fuzzyTitleCandidates");
    const results = await searchRecall({
      query: "knowledge gated",
      projectPath: PROJECT,
      scope: "project",
      searchConfig: cfg,
    });
    expect(spy).not.toHaveBeenCalled();
    expect(
      knowledgeItems(results).some((r) => r.item.item.match === "fuzzy"),
    ).toBe(false);
  });

  test("ltm.searchScored stays exact-only for the typo'd query", async () => {
    seed("Use cursor pagination for knowledge lists");
    const results = await ltm.searchScored({
      query: "curosr paginaton",
      projectPath: PROJECT,
      limit: 10,
    });
    expect(results).toEqual([]);
  });
});

describe("ltm.fuzzyTitleCandidates", () => {
  beforeEach(() => {
    cleanup();
    ensureProject(PROJECT);
  });

  test("excludes seen ids and honours the limit", async () => {
    const a = seed("Knwoledge alpha");
    seed("Knwoledge beta");
    seed("Knwoledge gamma");
    const rows = await ltm.fuzzyTitleCandidates({
      query: "knowledge",
      projectPath: PROJECT,
      excludeIds: new Set([a]),
      limit: 1,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.logical_id).not.toBe(a);
    expect(rows[0]?.match).toBe("fuzzy");
  });

  test("returns [] for short queries and non-positive limits", async () => {
    seed("Knwoledge alpha");
    expect(
      await ltm.fuzzyTitleCandidates({
        query: "kw",
        projectPath: PROJECT,
        excludeIds: new Set(),
        limit: 5,
      }),
    ).toEqual([]);
    expect(
      await ltm.fuzzyTitleCandidates({
        query: "knowledge",
        projectPath: PROJECT,
        excludeIds: new Set(),
        limit: 0,
      }),
    ).toEqual([]);
  });
});
