import { describe, expect, test } from "vitest";
import { uuidv7 } from "uuidv7";
import { db, ensureProject } from "../src/db";
import * as ltm from "../src/ltm";
import * as temporal from "../src/temporal";
import { listSessions } from "../src/data";
import {
  DEFAULT_KNOWLEDGE_SORT,
  formatKnowledgeSort,
  knowledgeKeysetMatchesSort,
  knowledgeVersionHistory,
  listAllKnowledgePage,
  listKnowledgePage,
  parseKnowledgeSort,
  listSessionsPage,
  searchKnowledgeRanked,
  searchSessionMessagesPage,
  sessionSearchTerms,
  type KnowledgeKeyset,
  type KnowledgeSort,
  type KnowledgeSortField,
} from "../src/list-query";
import type { KnowledgeEntry, KnowledgeVersion } from "../src/ltm";
import type { LoreMessage, LorePart } from "../src/types";
import { withTenant } from "../src/tenant";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let seq = 0;
function freshProject(tag: string): string {
  return `/test/list-query/${tag}/${++seq}`;
}

/** Pin the base row's timestamps so ordering does not depend on wall-clock
 *  resolution. `updated_at` / `created_at` on the version row are the sort
 *  columns; confidence lives on knowledge_meta. */
function pin(
  id: string,
  ts: { created?: number; updated?: number; confidence?: number },
) {
  if (ts.created !== undefined)
    db()
      .query("UPDATE knowledge SET created_at = ? WHERE id = ?")
      .run(ts.created, id);
  if (ts.updated !== undefined)
    db()
      .query("UPDATE knowledge SET updated_at = ? WHERE id = ?")
      .run(ts.updated, id);
  if (ts.confidence !== undefined)
    db()
      .query(
        "UPDATE knowledge_meta SET confidence = ?, base_confidence = ? WHERE logical_id = ?",
      )
      .run(ts.confidence, ts.confidence, ltm.logicalIdOf(id));
}

/** Insert in deliberately scrambled order (REVIEW.md adversarial-order): the
 *  dataset has equal sort keys on every column so a naive single-key ORDER BY
 *  would page nondeterministically. */
function seedKnowledge(projectPath: string): string[] {
  const rows = [
    { title: "Delta", created: 1000, updated: 5000, confidence: 0.9 },
    { title: "Alpha", created: 3000, updated: 5000, confidence: 0.9 },
    { title: "Echo", created: 3000, updated: 7000, confidence: 0.5 },
    { title: "Bravo", created: 1000, updated: 7000, confidence: 0.5 },
    { title: "Charlie", created: 2000, updated: 6000, confidence: 0.9 },
    { title: "Alpha", created: 2000, updated: 6000, confidence: 0.5 }, // duplicate title
    { title: "Foxtrot", created: 4000, updated: 5000, confidence: 0.7 },
  ];
  const ids: string[] = [];
  for (const r of rows) {
    const id = ltm.create({
      id: uuidv7(),
      projectPath,
      scope: "project",
      category: "decision",
      title: r.title,
      content: `content for ${r.title}`,
      confidence: r.confidence,
    });
    pin(id, r);
    ids.push(id);
  }
  return ids;
}

const SORT_FIELDS: KnowledgeSortField[] = [
  "updated_at",
  "created_at",
  "confidence",
  "title",
];

function allSorts(): KnowledgeSort[] {
  const sorts: KnowledgeSort[] = [];
  function visit(fields: KnowledgeSortField[]) {
    if (fields.length) {
      for (let mask = 0; mask < 2 ** fields.length; mask++) {
        sorts.push(
          fields.map((field, index) => ({
            field,
            dir: mask & (1 << index) ? "asc" : "desc",
          })),
        );
      }
    }
    if (fields.length === 3) return;
    for (const field of SORT_FIELDS) {
      if (!fields.includes(field)) visit([...fields, field]);
    }
  }
  visit([]);
  return sorts;
}

const KNOWLEDGE_SORTS = allSorts();
const REPRESENTATIVE_SORTS: KnowledgeSort[] = [
  [{ field: "updated_at", dir: "desc" }],
  [{ field: "created_at", dir: "asc" }],
  [{ field: "confidence", dir: "desc" }],
  [{ field: "title", dir: "asc" }],
  [
    { field: "updated_at", dir: "desc" },
    { field: "confidence", dir: "asc" },
  ],
  [
    { field: "title", dir: "asc" },
    { field: "created_at", dir: "desc" },
    { field: "updated_at", dir: "asc" },
  ],
];

/** Reference ordering computed in JS with the same ordered key stack. */
function expectedOrder(
  entries: KnowledgeEntry[],
  sort: KnowledgeSort,
): string[] {
  return [...entries]
    .sort((a, b) => {
      for (const { field, dir } of sort) {
        const sign = dir === "asc" ? 1 : -1;
        const ka = a[field];
        const kb = b[field];
        const comparison =
          typeof ka === "number" && typeof kb === "number"
            ? ka < kb
              ? -1
              : ka > kb
                ? 1
                : 0
            : typeof ka === "string" && typeof kb === "string"
              ? ka < kb
                ? -1
                : ka > kb
                  ? 1
                  : 0
              : 0;
        if (comparison !== 0) return comparison * sign;
      }
      const sign = sort[0].dir === "asc" ? 1 : -1;
      if (a.id < b.id) return -sign;
      if (a.id > b.id) return sign;
      return 0;
    })
    .map((e) => e.id);
}

function seedAdversarialSortRows(projectPath: string, marker: string): void {
  const rows = [
    { title: "Charlie", created: 2000, updated: 3000, confidence: 0.7 },
    { title: "Alpha", created: 1000, updated: 1000, confidence: 0.4 },
    { title: "Bravo", created: 3000, updated: 2000, confidence: 0.9 },
    { title: "Alpha", created: 2000, updated: 1000, confidence: 0.7 },
    { title: "Charlie", created: 3000, updated: 3000, confidence: 0.4 },
    { title: "Bravo", created: 1000, updated: 2000, confidence: 0.7 },
    { title: "Alpha", created: 3000, updated: 1000, confidence: 0.9 },
    { title: "Charlie", created: 1000, updated: 2000, confidence: 0.7 },
    { title: "Bravo", created: 2000, updated: 3000, confidence: 0.4 },
    { title: "Alpha", created: 1000, updated: 3000, confidence: 0.7 },
    { title: "Charlie", created: 2000, updated: 1000, confidence: 0.9 },
    { title: "Bravo", created: 3000, updated: 2000, confidence: 0.4 },
  ];
  for (const [index, row] of rows.entries()) {
    const id = ltm.create({
      id: uuidv7(),
      projectPath,
      scope: "project",
      category: "decision",
      title: row.title,
      content: `adversarial ${marker} sort row ${index}`,
      confidence: row.confidence,
    });
    pin(id, {
      created: row.created,
      updated: row.updated,
      confidence: row.confidence,
    });
  }
}

function pageAll(
  projectPath: string,
  marker: string,
  sort: KnowledgeSort,
  limit: number,
  listKind: "project" | "all",
): string[] {
  const out: string[] = [];
  let after: KnowledgeKeyset | undefined;
  for (;;) {
    const page =
      listKind === "project"
        ? listKnowledgePage(projectPath, {
            scope: "project",
            q: marker,
            sort,
            limit,
            after,
          })
        : listAllKnowledgePage({
            q: marker,
            scope: "project",
            sort,
            limit,
            after,
          });
    expect(page.items.length).toBeLessThanOrEqual(limit);
    out.push(...page.items.map((e) => e.id));
    if (!page.next) break;
    after = page.next;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Knowledge: sort + keyset
// ---------------------------------------------------------------------------

describe("listKnowledgePage — deterministic keyset pagination", () => {
  test("pages every ordered 1–3-key sort stack without gaps or duplicates", () => {
    const project = freshProject("stacked-sort");
    const marker = `sortstack${++seq}`;
    seedAdversarialSortRows(project, marker);
    const entries = listKnowledgePage(project, {
      scope: "project",
      q: marker,
      limit: 100,
    }).items;
    expect(entries).toHaveLength(12);

    for (const sort of KNOWLEDGE_SORTS) {
      const expected = expectedOrder(entries, sort);
      const all = listKnowledgePage(project, {
        scope: "project",
        q: marker,
        sort,
        limit: 100,
      }).items.map((entry) => entry.id);
      expect(all, formatKnowledgeSort(sort)).toEqual(expected);
      for (const limit of [1, 2, 3]) {
        for (const listKind of ["project", "all"] as const) {
          const paged = pageAll(project, marker, sort, limit, listKind);
          expect(
            paged,
            `${listKind} ${formatKnowledgeSort(sort)} limit=${limit}`,
          ).toEqual(expected);
          expect(new Set(paged).size).toBe(entries.length);
          expect([...paged].sort()).toEqual([...expected].sort());
        }
      }
    }
  });

  test("parses and formats only canonical, distinct sort stacks", () => {
    for (const sort of KNOWLEDGE_SORTS) {
      expect(parseKnowledgeSort(formatKnowledgeSort(sort))).toEqual(sort);
    }
    for (const raw of [
      "",
      "updated_at",
      "updated_at:up",
      "updated_at:desc,updated_at:asc",
      "updated_at:desc,created_at:desc,confidence:desc,title:asc",
      " updated_at:desc",
      "updated_at:desc ",
      "updated_at:desc,,title:asc",
      "unknown:asc",
      "updated_desc",
    ]) {
      expect(parseKnowledgeSort(raw), raw).toBeNull();
    }
  });

  test("validates keyset length and value types against the full sort stack", () => {
    const sort: KnowledgeSort = [
      { field: "updated_at", dir: "desc" },
      { field: "title", dir: "asc" },
      { field: "confidence", dir: "desc" },
    ];
    const keyset = { keys: [1000, "Alpha", 0.8], id: "entry-1" };
    expect(knowledgeKeysetMatchesSort(keyset, sort)).toBe(true);
    expect(
      knowledgeKeysetMatchesSort(
        { keys: [1000, "Alpha"], id: "entry-1" },
        sort,
      ),
    ).toBe(false);
    expect(
      knowledgeKeysetMatchesSort(
        { keys: [1000, 42, 0.8], id: "entry-1" },
        sort,
      ),
    ).toBe(false);
    expect(
      knowledgeKeysetMatchesSort(
        { keys: [Number.POSITIVE_INFINITY, "Alpha", 0.8], id: "entry-1" },
        sort,
      ),
    ).toBe(false);
  });

  test("default sort is updated_at descending", () => {
    const project = freshProject("default-sort");
    seedKnowledge(project);
    const a = listKnowledgePage(project, { limit: 10 }).items.map((e) => e.id);
    const b = listKnowledgePage(project, {
      sort: DEFAULT_KNOWLEDGE_SORT,
      limit: 10,
    }).items.map((e) => e.id);
    expect(a).toEqual(b);
  });

  test("next is null on the final page and absent when the set fits one page", () => {
    const project = freshProject("last-page");
    seedKnowledge(project);
    const one = listKnowledgePage(project, { limit: 7 });
    expect(one.items).toHaveLength(7);
    expect(one.next).toBeNull();
    const first = listKnowledgePage(project, { limit: 3 });
    expect(first.next).not.toBeNull();
  });

  test("a row inserted between pages that sorts BEFORE the cursor is not surfaced; one AFTER is", () => {
    const project = freshProject("mutate-insert");
    seedKnowledge(project);
    const sort: KnowledgeSort = [{ field: "updated_at", dir: "desc" }];
    const p1 = listKnowledgePage(project, { sort, limit: 3 });
    expect(p1.next).not.toBeNull();
    // Newest row (updated_at way in the future) lands before the cursor.
    const newer = ltm.create({
      id: uuidv7(),
      projectPath: project,
      scope: "project",
      category: "decision",
      title: "Zulu newer",
      content: "inserted mid-pagination",
    });
    pin(newer, { updated: 99_000 });
    // Oldest row lands after the cursor and must appear in a later page.
    const older = ltm.create({
      id: uuidv7(),
      projectPath: project,
      scope: "project",
      category: "decision",
      title: "Yankee older",
      content: "inserted mid-pagination",
    });
    pin(older, { updated: 1 });
    const rest: string[] = [];
    let after = p1.next ?? undefined;
    while (after) {
      const p = listKnowledgePage(project, { sort, limit: 3, after });
      rest.push(...p.items.map((e) => e.id));
      after = p.next ?? undefined;
    }
    const seen = [...p1.items.map((e) => e.id), ...rest];
    expect(seen).not.toContain(newer);
    expect(seen).toContain(older);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(8);
  });

  test("a row deleted between pages disappears without shifting the others (no offset drift)", () => {
    const project = freshProject("mutate-delete");
    const ids = seedKnowledge(project);
    const sort: KnowledgeSort = [{ field: "title", dir: "asc" }];
    const p1 = listKnowledgePage(project, { sort, limit: 2 });
    const remaining = new Set(ids);
    // Delete one row from page 1 (already served) and one row not yet served.
    ltm.remove(p1.items[0].id);
    remaining.delete(p1.items[0].id);
    const unserved = ids.find((id) => !p1.items.some((e) => e.id === id))!;
    ltm.remove(unserved);
    remaining.delete(unserved);
    const rest: string[] = [];
    let after = p1.next ?? undefined;
    while (after) {
      const p = listKnowledgePage(project, { sort, limit: 2, after });
      rest.push(...p.items.map((e) => e.id));
      after = p.next ?? undefined;
    }
    const all = [...p1.items.map((e) => e.id), ...rest];
    expect(new Set(all).size).toBe(all.length);
    expect(rest).not.toContain(unserved);
    // Everything still live and not on page 1 shows up exactly once.
    for (const id of remaining) {
      if (!p1.items.some((e) => e.id === id)) expect(rest).toContain(id);
    }
  });

  test("an update between pages moves the row to its new sort position (may be re-served)", () => {
    const project = freshProject("mutate-update");
    seedKnowledge(project);
    const sort: KnowledgeSort = [{ field: "updated_at", dir: "desc" }];
    const p1 = listKnowledgePage(project, { sort, limit: 2 });
    const victim = p1.items[1];
    // Bump updated_at far into the past: the (now superseded) entry's new
    // version sorts after the cursor and is served again under its new id.
    const newId = ltm.appendVersion(victim.logical_id, { title: "moved" })!;
    pin(newId, { updated: 1 });
    const p2 = listKnowledgePage(project, {
      sort,
      limit: 100,
      after: p1.next!,
    });
    const ids = p2.items.map((e) => e.id);
    expect(ids).not.toContain(victim.id);
    expect(ids[ids.length - 1]).toBe(newId);
  });

  test("respects the legacy confidence > 0.2 gate", () => {
    const project = freshProject("confidence-gate");
    const id = ltm.create({
      id: uuidv7(),
      projectPath: project,
      scope: "project",
      category: "gotcha",
      title: "hidden",
      content: "low confidence",
      confidence: 0.1,
    });
    pin(id, { confidence: 0.1 });
    expect(listKnowledgePage(project, { limit: 10 }).items).toHaveLength(0);
    expect(ltm.forProject(project, false)).toHaveLength(0);
  });
});

describe("listAllKnowledgePage — cross-project keyset pagination", () => {
  test("pages adversarially seeded tenant rows once in every sort order", () => {
    const projectA = freshProject("cross-page-a");
    const projectB = freshProject("cross-page-b");
    const projectAId = ensureProject(projectA);
    const projectBId = ensureProject(projectB);
    db().query("UPDATE projects SET name = '' WHERE id = ?").run(projectAId);
    db()
      .query("UPDATE projects SET name = ? WHERE id = ?")
      .run("Named project B", projectBId);
    const marker = `crosspage${++seq}`;
    const rows = [
      {
        projectPath: projectB,
        title: "Shared title",
        category: "pattern",
        scope: "project" as const,
        crossProject: true,
      },
      {
        projectPath: projectA,
        title: "Shared title",
        category: "decision",
        scope: "project" as const,
      },
      {
        projectPath: projectB,
        title: "Zulu title",
        category: "gotcha",
        scope: "project" as const,
      },
      {
        projectPath: projectA,
        title: "Alpha title",
        category: "preference",
        scope: "project" as const,
      },
      {
        title: "Global title",
        category: "architecture",
        scope: "global" as const,
      },
    ];
    const ids = rows.map((row) => {
      const id = ltm.create({
        id: uuidv7(),
        ...row,
        content: `content ${marker}`,
      });
      pin(id, { created: 4000, updated: 7000, confidence: 0.8 });
      return id;
    });
    db()
      .query("UPDATE knowledge SET cross_project = NULL WHERE id = ?")
      .run(ids[1]);
    const lowConfidenceId = ltm.create({
      id: uuidv7(),
      projectPath: projectA,
      scope: "project",
      category: "decision",
      title: "Low confidence",
      content: `content ${marker}`,
      confidence: 0.2,
    });
    const updatedId = ltm.create({
      id: uuidv7(),
      projectPath: projectA,
      scope: "project",
      category: "decision",
      title: "Updated entry",
      content: `old ${marker}`,
    });
    const oldVersionId = updatedId;
    ltm.update(updatedId, { content: `current ${marker}` });
    const currentVersionId = (
      db()
        .query("SELECT id FROM knowledge_current WHERE logical_id = ?")
        .get(updatedId) as { id: string }
    ).id;
    pin(currentVersionId, { created: 4000, updated: 7000, confidence: 0.8 });
    const removedId = ltm.create({
      id: uuidv7(),
      projectPath: projectB,
      scope: "project",
      category: "gotcha",
      title: "Removed entry",
      content: `removed ${marker}`,
    });
    ltm.remove(removedId);

    const otherTenantId = withTenant("cross-page-other-tenant", () =>
      ltm.create({
        id: uuidv7(),
        scope: "global",
        category: "decision",
        title: "Other tenant",
        content: `content ${marker}`,
      }),
    );

    for (const sort of REPRESENTATIVE_SORTS) {
      const all = listAllKnowledgePage({
        q: marker,
        sort,
        limit: 100,
      }).items;
      const expected = expectedOrder(all, sort);
      const paged: string[] = [];
      let after: KnowledgeKeyset | undefined;
      for (;;) {
        const page = listAllKnowledgePage({
          q: marker,
          sort,
          limit: 2,
          after,
        });
        paged.push(...page.items.map((entry) => entry.id));
        if (!page.next) break;
        after = page.next;
      }
      expect(paged).toEqual(expected);
      expect(new Set(paged).size).toBe(paged.length);
      expect(paged).not.toContain(lowConfidenceId);
      expect(paged).not.toContain(oldVersionId);
      expect(paged).not.toContain(removedId);
      expect(all.map((entry) => entry.logical_id)).not.toContain(removedId);
      expect(
        all.filter((entry) => entry.logical_id === updatedId),
      ).toHaveLength(1);
      expect(all.map((entry) => entry.logical_id)).not.toContain(otherTenantId);
    }

    const all = listAllKnowledgePage({ q: marker, limit: 100 }).items;
    expect(
      all.find((entry) => entry.project_id === projectAId)?.project_name,
    ).toBe(projectA);
    expect(
      all.find((entry) => entry.project_id === projectBId)?.project_name,
    ).toBe("Named project B");
    expect(
      all.find((entry) => entry.project_id === null)?.project_name,
    ).toBeNull();
    expect(all.map((entry) => entry.logical_id)).toEqual(
      expect.arrayContaining([...ids, updatedId]),
    );
    expect(
      listAllKnowledgePage({ q: marker, limit: 100 }).items.map(
        (entry) => entry.id,
      ),
    ).toEqual(all.map((entry) => entry.id));

    const shared = listAllKnowledgePage({
      q: marker,
      scope: "shared",
      limit: 100,
    }).items;
    expect(shared.length).toBeGreaterThan(0);
    expect(
      shared.every(
        (entry) => entry.project_id === null || entry.cross_project === 1,
      ),
    ).toBe(true);
    const project = listAllKnowledgePage({
      q: marker,
      scope: "project",
      limit: 100,
    }).items;
    expect(project.length).toBeGreaterThan(0);
    expect(
      project.every(
        (entry) =>
          entry.project_id !== null &&
          (entry.cross_project === null || entry.cross_project === 0),
      ),
    ).toBe(true);
    const allIds = new Set(all.map((entry) => entry.id));
    const projectIds = new Set(project.map((entry) => entry.id));
    const sharedIds = new Set(shared.map((entry) => entry.id));
    expect(new Set([...projectIds, ...sharedIds])).toEqual(allIds);
    expect([...projectIds].some((id) => sharedIds.has(id))).toBe(false);
    expect(all.length).toBeGreaterThan(project.length);

    const filteredAll = new Set(
      listAllKnowledgePage({
        projectId: projectAId,
        q: marker,
        scope: "all",
        limit: 100,
      }).items.map((entry) => entry.id),
    );
    const filteredProject = new Set(
      listAllKnowledgePage({
        projectId: projectAId,
        q: marker,
        scope: "project",
        limit: 100,
      }).items.map((entry) => entry.id),
    );
    const filteredShared = new Set(
      listAllKnowledgePage({
        projectId: projectAId,
        q: marker,
        scope: "shared",
        limit: 100,
      }).items.map((entry) => entry.id),
    );
    expect(new Set([...filteredProject, ...filteredShared])).toEqual(
      filteredAll,
    );
    expect([...filteredProject].some((id) => filteredShared.has(id))).toBe(
      false,
    );
    expect(filteredShared).toContain(ids[0]);
    expect(filteredShared).not.toContain(ids[2]);

    for (const scope of ["project", "shared", "all"] as const) {
      for (const sort of REPRESENTATIVE_SORTS) {
        const crossProjectIds = listAllKnowledgePage({
          projectId: projectAId,
          q: marker,
          scope,
          sort,
          limit: 100,
        }).items.map((entry) => entry.id);
        const projectIds = listKnowledgePage(projectA, {
          q: marker,
          scope,
          sort,
          limit: 100,
        }).items.map((entry) => entry.id);
        expect(crossProjectIds).toEqual(projectIds);
      }
    }

    expect(
      listAllKnowledgePage({
        q: marker,
        category: "decision",
        limit: 100,
      }).items.every((entry) => entry.category === "decision"),
    ).toBe(true);
    expect(
      listAllKnowledgePage({
        q: marker,
        category: "decision",
        limit: 100,
      }).items.map((entry) => entry.logical_id),
    ).toContain(ids[1]);
  });
});

describe("searchKnowledgeRanked — cross-project search", () => {
  test("ranks title hits, counts beyond the top-N, and only returns current live rows", () => {
    const projectA = freshProject("ranked-a");
    const projectB = freshProject("ranked-b");
    const marker = `rankterm${++seq}`;
    const titleHit = ltm.create({
      id: uuidv7(),
      projectPath: projectA,
      scope: "project",
      category: "decision",
      title: `${marker} in title`,
      content: "A title match.",
    });
    const contentHit = ltm.create({
      id: uuidv7(),
      projectPath: projectB,
      scope: "project",
      category: "pattern",
      title: "Plain note",
      content: `Only the body contains ${marker}.`,
    });
    const globalHit = ltm.create({
      id: uuidv7(),
      scope: "global",
      category: "preference",
      title: "Another title match",
      content: `${marker} also appears in this body.`,
    });
    const crossProjectHit = ltm.create({
      id: uuidv7(),
      projectPath: projectB,
      scope: "project",
      crossProject: true,
      category: "pattern",
      title: "Shared title match",
      content: `shared ${marker} entry`,
    });
    const updatedId = ltm.create({
      id: uuidv7(),
      projectPath: projectA,
      scope: "project",
      category: "decision",
      title: "Current searchable title",
      content: `old ${marker}`,
    });
    ltm.update(updatedId, { content: `new ${marker}` });
    const removedId = ltm.create({
      id: uuidv7(),
      projectPath: projectB,
      scope: "project",
      category: "gotcha",
      title: "Removed searchable entry",
      content: marker,
    });
    ltm.remove(removedId);

    const page = searchKnowledgeRanked({ q: marker, limit: 1 });
    expect(page.mode).toBe("fts");
    expect(page.total).toBeGreaterThan(page.items.length);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].logical_id).toBe(titleHit);
    const all = searchKnowledgeRanked({ q: marker, limit: 100 });
    expect(
      all.items.find((entry) => entry.logical_id === titleHit)?.rank,
    ).toBeLessThan(
      all.items.find((entry) => entry.logical_id === contentHit)!.rank!,
    );
    expect(
      all.items.filter((entry) => entry.logical_id === updatedId),
    ).toHaveLength(1);
    expect(all.items.map((entry) => entry.logical_id)).not.toContain(removedId);
    expect(all.total).toBe(all.items.length);

    const projectScope = searchKnowledgeRanked({
      q: marker,
      limit: 100,
      scope: "project",
    });
    const sharedScope = searchKnowledgeRanked({
      q: marker,
      limit: 100,
      scope: "shared",
    });
    const allIds = new Set(all.items.map((entry) => entry.logical_id));
    const projectIds = new Set(
      projectScope.items.map((entry) => entry.logical_id),
    );
    const sharedIds = new Set(
      sharedScope.items.map((entry) => entry.logical_id),
    );
    expect(projectIds).toContain(contentHit);
    expect(sharedIds).toEqual(new Set([globalHit, crossProjectHit]));
    expect(new Set([...projectIds, ...sharedIds])).toEqual(allIds);
    expect([...projectIds].some((id) => sharedIds.has(id))).toBe(false);

    const projectFiltered = searchKnowledgeRanked({
      q: marker,
      limit: 100,
      projectId: ensureProject(projectA),
      scope: "project",
    });
    expect(projectFiltered.items.map((entry) => entry.logical_id)).toEqual(
      expect.arrayContaining([titleHit, updatedId]),
    );
    expect(
      projectFiltered.items.map((entry) => entry.logical_id),
    ).not.toContain(contentHit);
    expect(
      projectFiltered.items.map((entry) => entry.logical_id),
    ).not.toContain(crossProjectHit);
    const sharedFiltered = searchKnowledgeRanked({
      q: marker,
      limit: 100,
      projectId: ensureProject(projectA),
      scope: "shared",
    });
    expect(
      new Set(sharedFiltered.items.map((entry) => entry.logical_id)),
    ).toEqual(new Set([globalHit, crossProjectHit]));
    const allFiltered = searchKnowledgeRanked({
      q: marker,
      limit: 100,
      projectId: ensureProject(projectA),
      scope: "all",
    });
    expect(
      new Set([
        ...projectFiltered.items.map((entry) => entry.logical_id),
        ...sharedFiltered.items.map((entry) => entry.logical_id),
      ]),
    ).toEqual(new Set(allFiltered.items.map((entry) => entry.logical_id)));
    expect(
      projectFiltered.items.some((entry) =>
        sharedFiltered.items.some(
          (sharedEntry) => sharedEntry.logical_id === entry.logical_id,
        ),
      ),
    ).toBe(false);
    const categoryFiltered = searchKnowledgeRanked({
      q: marker,
      limit: 100,
      category: "pattern",
      scope: "project",
    });
    expect(categoryFiltered.items.map((entry) => entry.logical_id)).toEqual([
      contentHit,
    ]);
  });

  test("uses LIKE for stop-word-only input and none when there are no long terms", () => {
    const likeId = ltm.create({
      id: uuidv7(),
      scope: "global",
      category: "preference",
      title: "Fallback note",
      content: "the fallback contains the searchable stop word",
    });
    const like = searchKnowledgeRanked({ q: "the", limit: 1000 });
    expect(like.mode).toBe("like");
    expect(like.total).toBeGreaterThan(0);
    expect(like.items.map((entry) => entry.logical_id)).toContain(likeId);
    expect(like.items.every((entry) => entry.rank === null)).toBe(true);
    expect(searchKnowledgeRanked({ q: "x y", limit: 10 })).toEqual({
      items: [],
      total: 0,
      mode: "none",
    });
  });
});

// ---------------------------------------------------------------------------
// Knowledge: filters
// ---------------------------------------------------------------------------

describe("listKnowledgePage — filters", () => {
  function seedFilters(project: string, marker?: string) {
    const other = `${project}-other`;
    const tagged = (value: string) => (marker ? `${value} ${marker}` : value);
    const own = ltm.create({
      id: uuidv7(),
      projectPath: project,
      scope: "project",
      category: "decision",
      title: tagged("Use PostgreSQL for billing"),
      content: tagged("billing database choice"),
    });
    const gotcha = ltm.create({
      id: uuidv7(),
      projectPath: project,
      scope: "project",
      category: "gotcha",
      title: tagged("SQLite WAL needs checkpoint"),
      content: tagged("wal checkpoints for postgresql migration parity"),
    });
    const global = ltm.create({
      id: uuidv7(),
      scope: "global",
      category: "preference",
      title: tagged("Prefer tabs"),
      content: tagged("global preference"),
    });
    const cross = ltm.create({
      id: uuidv7(),
      projectPath: other,
      scope: "project",
      crossProject: true,
      category: "pattern",
      title: tagged("Shared retry pattern"),
      content: tagged("cross project pattern"),
    });
    const foreign = ltm.create({
      id: uuidv7(),
      projectPath: other,
      scope: "project",
      category: "decision",
      title: tagged("Foreign decision"),
      content: tagged("belongs to another project"),
    });
    return { own, gotcha, global, cross, foreign };
  }

  test("category narrows to exactly that category", () => {
    const project = freshProject("category");
    const s = seedFilters(project);
    const ids = listKnowledgePage(project, {
      category: "gotcha",
      scope: "project",
      limit: 10,
    }).items.map((e) => e.id);
    expect(ids).toEqual([s.gotcha]);
    expect(
      listKnowledgePage(project, {
        category: "architecture",
        scope: "project",
        limit: 10,
      }).items,
    ).toHaveLength(0);
  });

  test("shared and project scopes partition the all-scope project list", () => {
    const project = freshProject("scope");
    const marker = `scopepartition${++seq}`;
    const s = seedFilters(project, marker);
    db()
      .query("UPDATE knowledge SET cross_project = NULL WHERE id = ?")
      .run(s.own);
    const defaultScope = new Set(
      listKnowledgePage(project, { q: marker, limit: 100 }).items.map(
        (e) => e.id,
      ),
    );
    const projectOnly = new Set(
      listKnowledgePage(project, {
        scope: "project",
        q: marker,
        limit: 100,
      }).items.map((e) => e.id),
    );
    const shared = new Set(
      listKnowledgePage(project, {
        scope: "shared",
        q: marker,
        limit: 100,
      }).items.map((e) => e.id),
    );
    const all = new Set(
      listKnowledgePage(project, {
        scope: "all",
        q: marker,
        limit: 100,
      }).items.map((e) => e.id),
    );
    expect(projectOnly).toEqual(new Set([s.own, s.gotcha]));
    expect(shared).toEqual(new Set([s.global, s.cross]));
    expect(new Set([...projectOnly, ...shared])).toEqual(all);
    expect([...projectOnly].some((id) => shared.has(id))).toBe(false);
    expect(defaultScope).toEqual(projectOnly);
    expect(all.has(s.foreign)).toBe(false);
  });

  test("omitted scope with a project stays project-local across list and search", () => {
    const project = freshProject("default-scope");
    const otherProject = freshProject("default-scope-other");
    const marker = `defaultscope${++seq}`;
    const ownCross = ltm.create({
      id: uuidv7(),
      projectPath: project,
      scope: "project",
      crossProject: true,
      category: "pattern",
      title: `Own shared entry ${marker}`,
      content: marker,
    });
    const otherCross = ltm.create({
      id: uuidv7(),
      projectPath: otherProject,
      scope: "project",
      crossProject: true,
      category: "pattern",
      title: `Other shared entry ${marker}`,
      content: marker,
    });
    const projectless = ltm.create({
      id: uuidv7(),
      scope: "global",
      category: "preference",
      title: `Projectless entry ${marker}`,
      content: marker,
    });

    const projectId = ensureProject(project);
    const resultSets = [
      listKnowledgePage(project, { q: marker, limit: 100 }).items.map(
        (entry) => entry.logical_id,
      ),
      listAllKnowledgePage({
        q: marker,
        limit: 100,
        projectId,
      }).items.map((entry) => entry.logical_id),
      searchKnowledgeRanked({
        q: marker,
        limit: 100,
        projectId,
      }).items.map((entry) => entry.logical_id),
    ];
    for (const ids of resultSets) {
      expect(ids).toContain(ownCross);
      expect(ids).not.toContain(otherCross);
      expect(ids).not.toContain(projectless);
    }
  });

  test("q matches title and content via FTS (prefix, AND) and never leaks other projects", () => {
    const project = freshProject("q");
    const s = seedFilters(project);
    const byTitle = listKnowledgePage(project, {
      q: "billing",
      limit: 10,
    }).items.map((e) => e.id);
    expect(byTitle).toEqual([s.own]);
    // Term appears in both entries' title/content → both, AND across terms narrows.
    const both = new Set(
      listKnowledgePage(project, { q: "postgresql", limit: 10 }).items.map(
        (e) => e.id,
      ),
    );
    expect(both).toEqual(new Set([s.own, s.gotcha]));
    const narrowed = listKnowledgePage(project, {
      q: "postgresql checkpoint",
      limit: 10,
    }).items.map((e) => e.id);
    expect(narrowed).toEqual([s.gotcha]);
    // Foreign project content is invisible even when it matches.
    expect(
      listKnowledgePage(project, { q: "foreign", limit: 10 }).items,
    ).toHaveLength(0);
    // Blank / whitespace q is a no-op filter.
    const defaultScope = listKnowledgePage(project, {
      q: "  ",
      limit: 10,
    }).items.map((entry) => entry.id);
    expect(defaultScope).toEqual(expect.arrayContaining([s.own, s.gotcha]));
    expect(defaultScope).not.toContain(s.global);
    expect(defaultScope).not.toContain(s.cross);
    const allScope = listKnowledgePage(project, {
      q: "  ",
      scope: "all",
      limit: 10,
    }).items.map((entry) => entry.id);
    expect(allScope).toEqual(
      expect.arrayContaining([s.own, s.gotcha, s.global, s.cross]),
    );
  });

  test("q with only short tokens matches nothing, like ltm.search()'s LIKE fallback", () => {
    const project = freshProject("q-like");
    ltm.create({
      id: uuidv7(),
      projectPath: project,
      scope: "project",
      category: "decision",
      title: "X",
      content: "single-letter title",
    });
    ltm.create({
      id: uuidv7(),
      projectPath: project,
      scope: "project",
      category: "decision",
      title: "Y",
      content: "other",
    });
    // "x" / "is a" have no FTS-indexable and no LIKE-able (>2 chars) term:
    // searchLike() returns [] for these, so the list filter must too rather
    // than broad-matching the raw string.
    for (const q of ["x", "is a", "to"]) {
      expect(listKnowledgePage(project, { q, limit: 10 }).items).toEqual([]);
      expect(ltm.search({ query: q, projectPath: project, limit: 10 })).toEqual(
        [],
      );
    }
    // A 3+ char token that FTS can't index still hits the LIKE path.
    expect(
      listKnowledgePage(project, { q: "single-letter", limit: 10 }).items.map(
        (e) => e.title,
      ),
    ).toEqual(["X"]);
  });

  test("q + sort + keyset compose: filtered set pages deterministically", () => {
    const project = freshProject("q-paged");
    for (let i = 0; i < 5; i++) {
      const id = ltm.create({
        id: uuidv7(),
        projectPath: project,
        scope: "project",
        category: "pattern",
        title: `needle ${i}`,
        content: "haystack",
      });
      pin(id, { updated: 1000 }); // all equal → id tiebreak
    }
    ltm.create({
      id: uuidv7(),
      projectPath: project,
      scope: "project",
      category: "pattern",
      title: "unrelated",
      content: "nothing here",
    });
    const out: string[] = [];
    let after: KnowledgeKeyset | undefined;
    for (;;) {
      const p = listKnowledgePage(project, {
        q: "needle",
        sort: [{ field: "updated_at", dir: "desc" }],
        limit: 2,
        after,
      });
      out.push(...p.items.map((e) => e.title));
      if (!p.next) break;
      after = p.next;
    }
    expect(out).toHaveLength(5);
    expect(new Set(out).size).toBe(5);
    expect(out.every((t) => t.startsWith("needle"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function msg(sessionID: string, id: string, created: number): LoreMessage {
  return {
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "build",
    model: { providerID: "anthropic", modelID: "m" },
  };
}
function parts(sessionID: string, messageID: string): LorePart[] {
  return [
    {
      id: `part-${messageID}`,
      sessionID,
      messageID,
      type: "text",
      text: `text ${messageID}`,
      time: { start: 0, end: 0 },
    },
  ];
}

describe("listSessionsPage", () => {
  test("pages by (last_message_at DESC, session_id DESC) across ≥3 pages with ties", () => {
    const project = freshProject("sessions");
    // Scrambled insert order; sessions b/d/f share last_message_at=5000.
    const plan: Array<[string, number[]]> = [
      ["s-d", [100, 5000]],
      ["s-a", [7000]],
      ["s-f", [5000]],
      ["s-c", [200, 6000]],
      ["s-b", [5000, 50]],
      ["s-e", [4000]],
      ["s-g", [3000, 1000]],
    ];
    for (const [sid, times] of plan) {
      times.forEach((t, i) =>
        temporal.store({
          projectPath: project,
          info: msg(sid, `${sid}-m${i}`, t),
          parts: parts(sid, `${sid}-m${i}`),
        }),
      );
    }
    const expected = ["s-a", "s-c", "s-f", "s-d", "s-b", "s-e", "s-g"];
    const all = listSessionsPage(project, { limit: 100 });
    expect(all.items.map((s) => s.session_id)).toEqual(expected);
    expect(all.next).toBeNull();

    const paged: string[] = [];
    let after: ReturnType<typeof listSessionsPage>["next"] = null;
    let pages = 0;
    for (;;) {
      const p = listSessionsPage(project, {
        limit: 2,
        after: after ?? undefined,
      });
      paged.push(...p.items.map((s) => s.session_id));
      pages++;
      if (!p.next) break;
      after = p.next;
    }
    expect(pages).toBe(4);
    expect(paged).toEqual(expected);

    // Same aggregates as the legacy reader (which has no tiebreaker, so
    // compare order-insensitively).
    const bySid = (rows: { session_id: string }[]) =>
      [...rows].sort((a, b) => a.session_id.localeCompare(b.session_id));
    // `match` is a per-query flag (#1948) the legacy reader does not carry.
    const stripped = all.items.map(({ match: _match, ...rest }) => rest);
    expect(bySid(stripped)).toEqual(bySid(listSessions(project, 100)));
  });

  test("a message appended to an already-served session between pages does not duplicate it", () => {
    const project = freshProject("sessions-mutate");
    for (const [sid, t] of [
      ["x1", 1000],
      ["x2", 2000],
      ["x3", 3000],
      ["x4", 4000],
    ] as Array<[string, number]>) {
      temporal.store({
        projectPath: project,
        info: msg(sid, `${sid}-m`, t),
        parts: parts(sid, `${sid}-m`),
      });
    }
    const p1 = listSessionsPage(project, { limit: 2 });
    expect(p1.items.map((s) => s.session_id)).toEqual(["x4", "x3"]);
    // x4 gets a new message → its key moves to the front, before the cursor.
    temporal.store({
      projectPath: project,
      info: msg("x4", "x4-late", 9000),
      parts: parts("x4", "x4-late"),
    });
    const p2 = listSessionsPage(project, { limit: 2, after: p1.next! });
    expect(p2.items.map((s) => s.session_id)).toEqual(["x2", "x1"]);
    expect(p2.next).toBeNull();
  });

  test("every item carries a derived title and title_source (#1921)", () => {
    const project = freshProject("sessions-titles");
    temporal.store({
      projectPath: project,
      info: msg("s-t", "s-t-m", 1000),
      parts: [
        {
          id: "part-s-t-m",
          sessionID: "s-t",
          messageID: "s-t-m",
          type: "text",
          text: "Title-worthy first message",
          time: { start: 0, end: 0 },
        },
      ],
    });
    const page = listSessionsPage(project, { limit: 10 });
    expect(page.items[0]).toMatchObject({
      title: "Title-worthy first message",
      title_source: "first_message",
    });
  });

  test("q filters by title/id and keeps the keyset order", () => {
    const project = freshProject("sessions-q");
    const plan: Array<[string, number, string]> = [
      ["s-n2", 2000, "needle two"],
      ["s-n1", 1000, "needle one"],
      ["s-x", 3000, "haystack"],
    ];
    for (const [sid, t, text] of plan) {
      temporal.store({
        projectPath: project,
        info: msg(sid, `${sid}-m`, t),
        parts: [
          {
            id: `part-${sid}`,
            sessionID: sid,
            messageID: `${sid}-m`,
            type: "text",
            text,
            time: { start: 0, end: 0 },
          },
        ],
      });
    }
    const page = listSessionsPage(project, { limit: 10, q: "needle" });
    expect(page.items.map((s) => s.session_id)).toEqual(["s-n2", "s-n1"]);
    expect(page.next).toBeNull();
    const byPrefix = listSessionsPage(project, { limit: 10, q: "s-x" });
    // The exact prefix hit leads; s-n1/s-n2 are legitimate fuzzy tail hits on
    // the session-id key (#1948).
    expect(byPrefix.items.map((s) => [s.session_id, s.match])).toEqual([
      ["s-x", "exact"],
      ["s-n1", "fuzzy"],
      ["s-n2", "fuzzy"],
    ]);
  });

  function titledSession(
    project: string,
    sid: string,
    created: number,
    title: string,
  ) {
    temporal.store({
      projectPath: project,
      info: msg(sid, `${sid}-m`, created),
      parts: [
        {
          id: `part-${sid}`,
          sessionID: sid,
          messageID: `${sid}-m`,
          type: "text",
          text: title,
          time: { start: 0, end: 0 },
        },
      ],
    });
  }

  test("a typo q returns the fuzzy tail flagged fuzzy, after exact hits (#1948)", () => {
    const project = freshProject("sessions-fuzzy");
    titledSession(project, "s-st", 3000, "Session title search");
    titledSession(project, "s-kt", 2000, "Knowledge table sorting");
    titledSession(project, "s-uq", 1000, "Unrelated zqq");

    // No exact hit: the whole page is the fuzzy tail, next stays null.
    const page = listSessionsPage(project, { limit: 10, q: "sesion titl" });
    expect(page.next).toBeNull();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      session_id: "s-st",
      match: "fuzzy",
    });
    expect(page.items[0]?.title).toBe("Session title search");
  });

  test("exact hits rank first flagged exact, then fuzzy rows, no duplicates", () => {
    const project = freshProject("sessions-fuzzy-mix");
    titledSession(project, "s-na", 1000, "needle alpha");
    titledSession(project, "s-nb", 2000, "needle beta");
    titledSession(project, "s-fz", 3000, "nedle report");

    const page = listSessionsPage(project, { limit: 10, q: "needle" });
    expect(page.next).toBeNull();
    expect(page.items.map((s) => [s.session_id, s.match])).toEqual([
      ["s-nb", "exact"],
      ["s-na", "exact"],
      ["s-fz", "fuzzy"],
    ]);
    expect(new Set(page.items.map((s) => s.session_id)).size).toBe(3);
  });

  test("the fuzzy tail lands only on the final page", () => {
    const project = freshProject("sessions-fuzzy-paged");
    titledSession(project, "s-e1", 1000, "needle one");
    titledSession(project, "s-e2", 2000, "needle two");
    titledSession(project, "s-e3", 3000, "needle three");
    titledSession(project, "s-fz", 4000, "nedle four");

    const p1 = listSessionsPage(project, { limit: 2, q: "needle" });
    expect(p1.items.map((s) => s.match)).toEqual(["exact", "exact"]);
    expect(p1.next).not.toBeNull();

    const p2 = listSessionsPage(project, {
      limit: 2,
      q: "needle",
      after: p1.next!,
    });
    expect(p2.next).toBeNull();
    expect(p2.items.map((s) => [s.session_id, s.match])).toEqual([
      ["s-e1", "exact"],
      ["s-fz", "fuzzy"],
    ]);
  });

  test("another project's sessions never appear in the fuzzy tail", () => {
    const project = freshProject("sessions-fuzzy-a");
    const other = freshProject("sessions-fuzzy-b");
    titledSession(project, "s-own", 1000, "haystack entry");
    titledSession(other, "s-other", 2000, "Session title search");

    const page = listSessionsPage(project, { limit: 10, q: "sesion titl" });
    expect(page.items.map((s) => s.session_id)).toEqual([]);
  });

  test("a ≤2-char q gets no fuzzy tail, and no q flags everything exact", () => {
    const project = freshProject("sessions-fuzzy-short");
    titledSession(project, "s-st", 3000, "Session title search");

    const short = listSessionsPage(project, { limit: 10, q: "kn" });
    expect(short.items.every((s) => s.match === "exact")).toBe(true);

    const plain = listSessionsPage(project, { limit: 10 });
    expect(plain.items.map((s) => s.match)).toEqual(["exact"]);
  });
});

// ---------------------------------------------------------------------------
// Session search
// ---------------------------------------------------------------------------

describe("sessionSearchTerms", () => {
  test("tokenises like unicode61: letters/digits only, lower-cased, keeps short tokens and stop words", () => {
    expect(sessionSearchTerms("Needle-5")).toEqual(["needle", "5"]);
    expect(sessionSearchTerms("the store")).toEqual(["the", "store"]);
    expect(sessionSearchTerms('a "quoted" NEAR(x) term* -not')).toEqual([
      "a",
      "quoted",
      "near",
      "x",
      "term",
      "not",
    ]);
    expect(sessionSearchTerms("  \t\n")).toEqual([]);
    expect(sessionSearchTerms('*** "" ---')).toEqual([]);
    expect(sessionSearchTerms("café Ünïcode 日本語")).toEqual([
      "café",
      "ünïcode",
      "日本語",
    ]);
    expect(sessionSearchTerms("snake_case")).toEqual(["snake", "case"]);
  });

  test("caps the number of terms", () => {
    const many = Array.from({ length: 50 }, (_, i) => `t${i}`).join(" ");
    expect(sessionSearchTerms(many)).toHaveLength(32);
  });
});

describe("searchSessionMessagesPage", () => {
  function seedSearch(tag: string) {
    const project = freshProject(`search-${tag}`);
    const other = freshProject(`search-other-${tag}`);
    const texts: Array<[string, number, string]> = [
      ["k3", 3000, "the third message mentions needle-3 and SQLite stays"],
      ["k1", 1000, "first: needle-1 lives here"],
      ["k5", 3000, "a tie at 3000 with needle-5 and the store"],
      ["k2", 2000, "second, needle-2; portability is a requirement"],
      ["k4", 3000, "another tie at 3000: needle-4, sqlite stays the store"],
      ["k6", 6000, "needle-6 has \u001fmultiple\u001f parts and the store"],
      ["k7", 7000, "fifty is 50; the shop closes"],
    ];
    for (const [id, t, text] of texts) {
      temporal.store({
        projectPath: project,
        info: msg("s", id, t),
        parts: [
          {
            id: `part-${id}`,
            sessionID: "s",
            messageID: id,
            type: "text",
            text,
            time: { start: 0, end: 0 },
          },
        ],
      });
    }
    // Same words in another session of the project and in another project.
    temporal.store({
      projectPath: project,
      info: msg("s2", "z1", 5000),
      parts: [
        {
          id: "part-z1",
          sessionID: "s2",
          messageID: "z1",
          type: "text",
          text: "needle-3 in a different session, sqlite stays",
          time: { start: 0, end: 0 },
        },
      ],
    });
    temporal.store({
      projectPath: other,
      info: msg("s", "o1", 5000),
      parts: [
        {
          id: "part-o1",
          sessionID: "s",
          messageID: "o1",
          type: "text",
          text: "needle-3 in a different project, sqlite stays",
          time: { start: 0, end: 0 },
        },
      ],
    });
    // stored row id → the source message id the seed used above.
    const stored = new Map<string, string>();
    for (const m of temporal.bySession(project, "s")) {
      if (m.source_id) stored.set(m.id, m.source_id);
    }
    return { project, stored };
  }
  const sources = (items: { id: string }[], stored: Map<string, string>) =>
    items.map((h) => stored.get(h.id));
  const sorted = (xs: (string | undefined)[]) =>
    [...xs].sort((a, b) => (a ?? "").localeCompare(b ?? ""));

  test("a literal phrase with a short token and a stop word finds exactly its message, scoped to the session", () => {
    const { project, stored } = seedSearch("phrase");
    const page = searchSessionMessagesPage(project, "s", {
      query: "Needle-3",
      limit: 10,
    });
    expect(page.terms).toEqual(["needle", "3"]);
    expect(page.mode).toBe("phrase");
    expect(page.total).toBe(1);
    expect(sources(page.items, stored)).toEqual(["k3"]);
    expect(page.items[0].role).toBe("user");
    expect(page.items[0].created_at).toBe(3000);
    expect(page.items[0].snippet).toContain("needle-3");
    expect(typeof page.items[0].rank).toBe("number");
    expect(page.next).toBeNull();

    const stop = searchSessionMessagesPage(project, "s", {
      query: "the store",
      limit: 10,
    });
    expect(stop.mode).toBe("phrase");
    expect(sorted(sources(stop.items, stored))).toEqual(["k4", "k5", "k6"]);
  });

  test("phrase order, prefix on the last term only, case/separator-insensitive", () => {
    const { project, stored } = seedSearch("prefix");
    // "sqlite stays" is a phrase in k3, k4; "stays sqlite" is not.
    expect(
      sorted(
        sources(
          searchSessionMessagesPage(project, "s", {
            query: "SQLITE  stays",
            limit: 10,
          }).items,
          stored,
        ),
      ),
    ).toEqual(["k3", "k4"]);
    // Last term is a prefix: "sqlite sta" → same two; "sql stays" is not.
    expect(
      searchSessionMessagesPage(project, "s", {
        query: "sqlite sta",
        limit: 10,
      }).total,
    ).toBe(2);
    const notPrefix = searchSessionMessagesPage(project, "s", {
      query: "stays sql",
      limit: 10,
    });
    // No phrase → falls back to every term anywhere, still with only the
    // last term a prefix ("sql"* matches sqlite).
    expect(notPrefix.mode).toBe("terms");
    expect(sorted(sources(notPrefix.items, stored))).toEqual(["k3", "k4"]);
    const innerNotPrefix = searchSessionMessagesPage(project, "s", {
      query: "sql stays",
      limit: 10,
    });
    expect(innerNotPrefix.mode).toBe("terms");
    expect(innerNotPrefix.total).toBe(0);
  });

  test("a short token is a whole token unless it is the last term (`5` is not every `50`)", () => {
    const { project, stored } = seedSearch("short");
    // As the last term `5`* is a prefix, like a finder matching what was
    // typed so far: k7 ("50").
    const trailing = searchSessionMessagesPage(project, "s", {
      query: "shop 5",
      limit: 10,
    });
    expect(trailing.mode).toBe("terms");
    expect(sources(trailing.items, stored)).toEqual(["k7"]);
    // As an inner term `5` must be the token `5`; `50` does not count.
    const inner = searchSessionMessagesPage(project, "s", {
      query: "5 shop",
      limit: 10,
    });
    expect(inner.mode).toBe("terms");
    expect(inner.total).toBe(0);
    // In a phrase it is adjacency that bounds it: only needle-5, never
    // needle-1 … needle-6 or the 50.
    const phrase = searchSessionMessagesPage(project, "s", {
      query: "needle-5",
      limit: 10,
    });
    expect(phrase.mode).toBe("phrase");
    expect(sources(phrase.items, stored)).toEqual(["k5"]);
  });

  test("falls back to all-terms-anywhere only for multi-term queries, and says so", () => {
    const { project, stored } = seedSearch("terms");
    const p = searchSessionMessagesPage(project, "s", {
      query: "store needle",
      limit: 10,
    });
    expect(p.mode).toBe("terms");
    expect(p.total).toBe(3);
    expect(sorted(sources(p.items, stored))).toEqual(["k4", "k5", "k6"]);

    const none = searchSessionMessagesPage(project, "s", {
      query: "zzzz",
      limit: 10,
    });
    expect(none).toEqual({
      terms: ["zzzz"],
      mode: "phrase",
      items: [],
      next: null,
      total: 0,
    });
    const noneMulti = searchSessionMessagesPage(project, "s", {
      query: "needle zzzz",
      limit: 10,
    });
    expect(noneMulti.mode).toBe("terms");
    expect(noneMulti.total).toBe(0);
  });

  test("FTS5 syntax in the query is literal, never an operator, and never throws", () => {
    const { project } = seedSearch("syntax");
    for (const q of [
      'needle-3 OR "needle-1"',
      "needle NEAR(3)",
      "needle* -3",
      "needle:3",
      '""""',
      "(needle) AND {3}",
      "^needle",
    ]) {
      expect(() =>
        searchSessionMessagesPage(project, "s", { query: q, limit: 10 }),
      ).not.toThrow();
    }
    // `OR` is just another word: as a phrase it matches nothing, as terms
    // "or" is absent from every message → 0, not a boolean union.
    const or = searchSessionMessagesPage(project, "s", {
      query: "needle-3 OR needle-1",
      limit: 10,
    });
    expect(or.mode).toBe("terms");
    expect(or.total).toBe(0);
    // Operator-only input is unsearchable, not an error.
    expect(
      searchSessionMessagesPage(project, "s", {
        query: '* " ( ) -',
        limit: 10,
      }),
    ).toEqual({ terms: [], mode: "phrase", items: [], next: null, total: 0 });
    // "near" as a word.
    expect(
      searchSessionMessagesPage(project, "s", { query: "NEAR", limit: 10 })
        .total,
    ).toBe(0);
  });

  test("pages newest-first with (created_at, id) keyset through a tie, chronological within a page, and pins the mode", () => {
    const { project, stored } = seedSearch("paging");
    // "needle" alone matches all six; ties k3/k4/k5 at 3000.
    const walk = (mode?: "phrase" | "terms") => {
      const out: string[][] = [];
      let before: { created_at: number; id: string } | undefined;
      for (;;) {
        const p = searchSessionMessagesPage(project, "s", {
          query: "needle",
          limit: 2,
          before,
          mode,
        });
        expect(p.total).toBe(6);
        out.push(sources(p.items, stored).map((src) => src ?? "?"));
        if (!p.next) break;
        before = p.next;
      }
      return out;
    };
    const pages = walk();
    expect(pages.flat()).toHaveLength(6);
    expect(new Set(pages.flat()).size).toBe(6);
    expect(pages[0]).toHaveLength(2);
    expect(pages[0][1]).toBe("k6");
    // Chronological within each page: created_at never decreases.
    for (const page of pages) {
      const ts = page.map(
        (src) =>
          temporal.bySession(project, "s").find((m) => m.source_id === src)!
            .created_at,
      );
      expect(ts).toEqual([...ts].sort((a, b) => a - b));
    }
    // The oldest is served last.
    expect(pages.at(-1)?.[0]).toBe("k1");
    // A pinned mode is honoured even where the first page would pick phrase.
    const pinned = searchSessionMessagesPage(project, "s", {
      query: "needle 6",
      limit: 10,
      mode: "terms",
    });
    expect(pinned.mode).toBe("terms");
    expect(pinned.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Version history
// ---------------------------------------------------------------------------

describe("knowledgeVersionHistory", () => {
  test("orders versions, marks the head, computes superseded_at, includes a historical delete", () => {
    const project = freshProject("versions");
    const v1 = ltm.create({
      id: uuidv7(),
      projectPath: project,
      scope: "project",
      category: "decision",
      title: "v1 title",
      content: "v1 content",
      session: "sess-origin",
    });
    const v2 = ltm.appendVersion(v1, { title: "v2 title" })!;
    const v3 = ltm.appendVersion(v1, { isDeleted: true })!; // death cert
    // Deleted head is invisible, same as GET /knowledge/:id.
    expect(knowledgeVersionHistory(v1)).toBeNull();
    expect(knowledgeVersionHistory(v1, { includeDeleted: false })).toBeNull();
    expect(ltm.getByLogical(v1)).toBeNull();
    // ...unless the caller opts in: the tombstone is then the current version.
    const tomb = knowledgeVersionHistory(v3, { includeDeleted: true })!;
    expect(tomb.id).toBe(v1);
    expect(tomb.current_version_id).toBe(v3);
    expect(
      tomb.versions.map((v) => [v.version_id, v.is_deleted, v.is_current]),
    ).toEqual([
      [v1, false, false],
      [v2, false, false],
      [v3, true, true],
    ]);
    expect(tomb.versions[2].superseded_at).toBeNull();
    expect(
      knowledgeVersionHistory("00000000-0000-0000-0000-000000000000", {
        includeDeleted: true,
      }),
    ).toBeNull();
    // Re-append resurrects; the death cert stays in the history.
    const v4 = ltm.appendVersion(v1, {
      content: "v4 content",
      category: "gotcha",
    })!;
    db().query("UPDATE knowledge SET updated_at = ? WHERE id = ?").run(10, v1);
    db().query("UPDATE knowledge SET updated_at = ? WHERE id = ?").run(20, v2);
    db().query("UPDATE knowledge SET updated_at = ? WHERE id = ?").run(30, v3);
    db().query("UPDATE knowledge SET updated_at = ? WHERE id = ?").run(40, v4);

    for (const lookup of [v1, v2, v3, v4]) {
      const h = knowledgeVersionHistory(lookup)!;
      expect(h).not.toBeNull();
      expect(h.id).toBe(v1);
      expect(h.current_version_id).toBe(v4);
      expect(h.versions.map((v) => v.version_id)).toEqual([v1, v2, v3, v4]);
      expect(h.versions.map((v) => v.version)).toEqual([1, 2, 3, 4]);
      expect(h.versions.map((v) => v.created_at)).toEqual([10, 20, 30, 40]);
      expect(h.versions.map((v) => v.superseded_at)).toEqual([
        20,
        30,
        40,
        null,
      ]);
      expect(h.versions.map((v) => v.is_current)).toEqual([
        false,
        false,
        false,
        true,
      ]);
      expect(h.versions.map((v) => v.is_deleted)).toEqual([
        false,
        false,
        true,
        false,
      ]);
      expect(h.versions.map((v) => v.title)).toEqual([
        "v1 title",
        "v2 title",
        "v2 title",
        "v2 title",
      ]);
      expect(h.versions[3].content).toBe("v4 content");
      expect(h.versions[3].category).toBe("gotcha");
      expect(h.versions[0].category).toBe("decision");
      expect(h.versions.every((v) => v.scope === "project")).toBe(true);
      expect(
        h.versions.every((v) => v.source_refs.session_id === "sess-origin"),
      ).toBe(true);
      expect(h.versions.every((v) => v.confidence === 1)).toBe(true);
    }
    // Same underlying rows as ltm.versionHistory().
    const raw: KnowledgeVersion[] = ltm.versionHistory(v1);
    expect(raw.map((r) => r.id)).toEqual([v1, v2, v3, v4]);
  });

  test("unknown id → null; shared entries report scope=shared", () => {
    expect(
      knowledgeVersionHistory("00000000-0000-0000-0000-000000000000"),
    ).toBeNull();
    const g = ltm.create({
      id: uuidv7(),
      scope: "global",
      category: "preference",
      title: "global pref",
      content: "c",
    });
    const h = knowledgeVersionHistory(g)!;
    expect(h.versions).toHaveLength(1);
    expect(h.versions[0].scope).toBe("shared");
    expect(h.versions[0].superseded_at).toBeNull();
    expect(h.versions[0].is_current).toBe(true);
    const cross = ltm.create({
      id: uuidv7(),
      projectPath: freshProject("version-shared"),
      scope: "project",
      crossProject: true,
      category: "pattern",
      title: "cross-project",
      content: "c",
    });
    expect(knowledgeVersionHistory(cross)?.versions[0]?.scope).toBe("shared");
  });

  test("lookup by a version id returns only that logical entry's history", () => {
    const project = freshProject("versions-isolated");
    const a = ltm.create({
      id: uuidv7(),
      projectPath: project,
      scope: "project",
      category: "decision",
      title: "A",
      content: "a",
    });
    const b = ltm.create({
      id: uuidv7(),
      projectPath: project,
      scope: "project",
      category: "decision",
      title: "B",
      content: "b",
    });
    const a2 = ltm.appendVersion(a, { content: "a2" })!;
    expect(
      knowledgeVersionHistory(a2)!.versions.map((v) => v.version_id),
    ).toEqual([a, a2]);
    expect(
      knowledgeVersionHistory(b)!.versions.map((v) => v.version_id),
    ).toEqual([b]);
  });
});
