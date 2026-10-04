/**
 * Fuzzy tail for knowledge reads (#1948): when the exact leg (FTS5/LIKE)
 * underfills a result set, remaining candidates are ranked by title with
 * `fuzzyRank` and appended flagged `match: "fuzzy"`. Covers the ranked search
 * and the keyset-paged lists.
 */
import { describe, expect, test } from "vitest";
import { uuidv7 } from "uuidv7";
import { ensureProject } from "../src/db";
import * as ltm from "../src/ltm";
import {
  listAllKnowledgePage,
  listKnowledgePage,
  searchKnowledgeRanked,
  type KnowledgeKeyset,
} from "../src/list-query";
import { withTenant } from "../src/tenant";

let seq = 0;
function freshProject(tag: string): string {
  return `/test/fuzzy-knowledge/${tag}/${++seq}`;
}

function entry(
  projectPath: string | undefined,
  title: string,
  opts: { category?: "decision" | "gotcha"; crossProject?: boolean } = {},
): string {
  return ltm.create({
    id: uuidv7(),
    projectPath,
    scope: "project",
    category: opts.category ?? "decision",
    title,
    content: `content for ${title}`,
    crossProject: opts.crossProject,
  });
}

// ---------------------------------------------------------------------------
// searchKnowledgeRanked
// ---------------------------------------------------------------------------

describe("searchKnowledgeRanked — fuzzy tail", () => {
  test("zero FTS hits returns fuzzy rows flagged fuzzy with exact total", () => {
    const project = freshProject("search-zero");
    const id = entry(project, "Knowledge table sorting");
    const result = searchKnowledgeRanked({
      q: "knwoledge",
      limit: 20,
      projectId: ensureProject(project),
      scope: "project",
    });
    expect(result.mode).toBe("fts");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].logical_id).toBe(id);
    expect(result.items[0].match).toBe("fuzzy");
    expect(result.items[0].rank).toBeNull();
    expect(result.total).toBe(result.items.length);
  });

  test("few FTS hits: exact rows first flagged exact, then fuzzy, no dupes", () => {
    const project = freshProject("search-few");
    const exactId = entry(project, "Deploy runbook");
    const fuzzyId = entry(project, "Deplpy checklist");
    const result = searchKnowledgeRanked({
      q: "deploy",
      limit: 20,
      projectId: ensureProject(project),
      scope: "project",
    });
    const exacts = result.items.filter((row) => row.match === "exact");
    const fuzzies = result.items.filter((row) => row.match === "fuzzy");
    expect(exacts.map((row) => row.logical_id)).toEqual([exactId]);
    expect(fuzzies.map((row) => row.logical_id)).toEqual([fuzzyId]);
    // Every exact hit precedes every fuzzy hit.
    expect(result.items[0].match).toBe("exact");
    expect(result.items[result.items.length - 1].match).toBe("fuzzy");
    expect(new Set(result.items.map((row) => row.id)).size).toBe(
      result.items.length,
    );
    expect(result.total).toBe(exacts.length + fuzzies.length);
  });

  test("fuzzy is never appended when the exact leg fills the limit", () => {
    const project = freshProject("search-limit");
    entry(project, "Deploy runbook one");
    entry(project, "Deploy runbook two");
    entry(project, "Deplpy checklist");
    const result = searchKnowledgeRanked({
      q: "deploy",
      limit: 2,
      projectId: ensureProject(project),
      scope: "project",
    });
    expect(result.items).toHaveLength(2);
    expect(result.items.every((row) => row.match === "exact")).toBe(true);
    expect(result.total).toBe(2);
  });

  test("category, scope and projectId predicates constrain the fuzzy leg", () => {
    const projectA = freshProject("search-scope-a");
    const projectB = freshProject("search-scope-b");
    entry(projectA, "Deplpy wrong category", { category: "gotcha" });
    entry(projectB, "Deplpy other project");
    const inScope = entry(projectA, "Deplpy right category");
    const result = searchKnowledgeRanked({
      q: "deploy",
      limit: 20,
      projectId: ensureProject(projectA),
      scope: "project",
      category: "decision",
    });
    expect(result.items.map((row) => row.logical_id)).toEqual([inScope]);
    expect(result.items[0].match).toBe("fuzzy");

    // scope=all on the same project lets the other project's entry through
    // only when it is cross-project — P2's is not, so still excluded.
    const widened = searchKnowledgeRanked({
      q: "deploy",
      limit: 20,
      projectId: ensureProject(projectA),
      scope: "all",
      category: "decision",
    });
    expect(widened.items.map((row) => row.logical_id)).toEqual([inScope]);
  });

  test("queries at or below the fuzzy minimum produce no fuzzy rows", () => {
    const project = freshProject("search-short");
    // `qy`/`zx` are below the fuzzy minimum and match no FTS prefix — nothing
    // may come back at all.
    entry(project, "Qwidget maker");
    for (const q of ["qy", "zx"]) {
      const result = searchKnowledgeRanked({
        q,
        limit: 20,
        projectId: ensureProject(project),
        scope: "project",
      });
      expect(result.items.every((row) => row.match === "exact")).toBe(true);
      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    }
  });

  test("other tenants' entries are never fuzzy candidates", () => {
    const project = freshProject("search-tenant");
    const foreignId = withTenant("fuzzy-other-tenant", () =>
      ltm.create({
        id: uuidv7(),
        scope: "global",
        category: "decision",
        title: "Knowledge table sorting",
        content: "foreign tenant",
      }),
    );
    const result = searchKnowledgeRanked({
      q: "knwoledge",
      limit: 20,
      projectId: ensureProject(project),
      scope: "all",
    });
    expect(result.items.map((row) => row.logical_id)).not.toContain(foreignId);
  });
});

// ---------------------------------------------------------------------------
// Paged lists
// ---------------------------------------------------------------------------

describe("listKnowledgePage — fuzzy tail on the final page", () => {
  test("fuzzy row lands only on the last page, filling up to limit", () => {
    const project = freshProject("page-tail");
    const exactIds = [
      entry(project, "Pager one"),
      entry(project, "Pager two"),
      entry(project, "Pager three"),
    ];
    const fuzzyId = entry(project, "Pagre tail");

    const page1 = listKnowledgePage(project, { q: "pager", limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.items.every((row) => row.match === "exact")).toBe(true);
    expect(page1.items.map((row) => row.logical_id)).toEqual(
      expect.arrayContaining(
        exactIds.slice(0, 2).map(() => expect.any(String)),
      ),
    );
    expect(page1.next).not.toBeNull();

    const page2 = listKnowledgePage(project, {
      q: "pager",
      limit: 2,
      after: page1.next as KnowledgeKeyset,
    });
    expect(page2.next).toBeNull();
    expect(page2.items).toHaveLength(2);
    expect(page2.items[0].match).toBe("exact");
    expect(page2.items[1].match).toBe("fuzzy");
    expect(page2.items[1].logical_id).toBe(fuzzyId);
    // The third exact hit is on this page and never repeats as fuzzy.
    const allIds = [...page1.items, ...page2.items].map((row) => row.id);
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  test("no exact hits: page one carries only fuzzy rows and next is null", () => {
    const project = freshProject("page-none");
    const fuzzyId = entry(project, "Pager tail");
    // `pagerr` FTS-matches nothing but fuzzy-scores "pager tail" ~0.83.
    const page = listKnowledgePage(project, { q: "pagerr", limit: 10 });
    expect(page.next).toBeNull();
    const fuzzy = page.items.filter((row) => row.match === "fuzzy");
    expect(fuzzy.map((row) => row.logical_id)).toContain(fuzzyId);
    expect(page.items.every((row) => row.match === "fuzzy")).toBe(true);
  });

  test("without q every row is exact and no tail is appended", () => {
    const project = freshProject("page-noq");
    entry(project, "Pagre tail");
    const page = listKnowledgePage(project, { limit: 10 });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((row) => row.match === "exact")).toBe(true);
  });

  test("listAllKnowledgePage appends the fuzzy tail too", () => {
    const project = freshProject("page-all");
    const fuzzyId = entry(project, "Pager tail");
    const page = listAllKnowledgePage({
      q: "pagerr",
      limit: 10,
      projectId: ensureProject(project),
      scope: "project",
    });
    expect(page.next).toBeNull();
    const fuzzy = page.items.find((row) => row.match === "fuzzy");
    expect(fuzzy?.logical_id).toBe(fuzzyId);
    expect(fuzzy?.project_name).toBeDefined();
  });
});
