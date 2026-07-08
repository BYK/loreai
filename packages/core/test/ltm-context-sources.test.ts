import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { uuidv7 } from "uuidv7";
import { db, ensureProject } from "../src/db";
import * as ltm from "../src/ltm";
import * as embedding from "../src/embedding";

/**
 * forSession `includeContextSources`: relevance-ranked distillation + temporal
 * memory is folded into the context-bound (system[2]) selection so in-session
 * facts are "just there" without the recall tool — while staying cache-stable
 * (same stickyIds hysteresis + deterministic packing as knowledge).
 */
describe("ltm.forSession — context sources (distillation + temporal)", () => {
  const PROJ = "/test/ltm/context-sources";
  const HINT =
    "what exact hex color and how many hashing tests were used earlier";
  const DIST_FACT = "the chat panel frame used hex color #1164a3 in v45";
  const TEMP_FACT = "19 xxHash64 unit tests pass on the branch";

  let pid = "";
  let distId = "";
  let tempId = "";
  let knowledgeId = "";
  let spies: Array<{ mockRestore: () => void }> = [];

  beforeEach(() => {
    pid = ensureProject(PROJ);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
    db().query("DELETE FROM distillations WHERE project_id = ?").run(pid);
    db().query("DELETE FROM temporal_messages WHERE project_id = ?").run(pid);

    knowledgeId = ltm.create({
      projectPath: PROJ,
      category: "architecture",
      title: "Gateway overview",
      content: "The gateway proxies model requests and injects memory.",
      scope: "project",
    });

    distId = uuidv7();
    db()
      .query(
        `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, archived, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        distId,
        pid,
        "sess-old",
        "",
        "",
        DIST_FACT,
        "[]",
        0,
        20,
        0,
        Date.now() - 100_000,
      );

    tempId = uuidv7();
    db()
      .query(
        `INSERT INTO temporal_messages (id, project_id, session_id, role, content, tokens, distilled, created_at, metadata)
         VALUES (?, ?, ?, 'assistant', ?, 12, 0, ?, '{}')`,
      )
      .run(tempId, pid, "sess-old", TEMP_FACT, Date.now() - 90_000);

    spies = [];
    spies.push(vi.spyOn(embedding, "isAvailable").mockReturnValue(true));
    spies.push(
      vi
        .spyOn(embedding, "embed")
        .mockResolvedValue([new Float32Array([1, 0, 0])]),
    );
    spies.push(
      vi
        .spyOn(embedding, "vectorSearch")
        .mockResolvedValue([{ id: knowledgeId, similarity: 0.6 }]),
    );
    spies.push(
      vi
        .spyOn(embedding, "vectorSearchDistillations")
        .mockResolvedValue([{ id: distId, similarity: 0.92 }]),
    );
    spies.push(
      vi
        .spyOn(embedding, "vectorSearchTemporal")
        // temporal_vec is chunk-keyed (`<id>#<n>`) — exercise the strip path.
        .mockResolvedValue([{ id: `${tempId}#0`, similarity: 0.88 }]),
    );
  });

  afterEach(() => {
    for (const s of spies) s.mockRestore();
  });

  test("folds relevance-ranked distillation + temporal facts into the selection", async () => {
    const result = await ltm.forSession(PROJ, undefined, 4000, {
      excludeCategories: ["preference"],
      contextHint: HINT,
      includeContextSources: ["distillation", "temporal"],
    });

    const byId = new Map(result.map((e) => [e.id, e]));
    // Recall-id form so non-selected ones stay recallable via the overflow ToC.
    expect(byId.has(`d:${distId}`)).toBe(true);
    expect(byId.has(`t:${tempId}`)).toBe(true);
    expect(byId.get(`d:${distId}`)?.content).toContain("#1164a3");
    expect(byId.get(`t:${tempId}`)?.content).toContain("xxHash64");
    // Synthetic entries carry the recalled-context category tag.
    expect(byId.get(`d:${distId}`)?.category).toBe(
      ltm.RECALLED_CONTEXT_CATEGORY,
    );
    // Knowledge is still present alongside them.
    expect(byId.has(knowledgeId)).toBe(true);
  });

  test("VACUITY: without includeContextSources, the facts are NOT injected", async () => {
    const result = await ltm.forSession(PROJ, undefined, 4000, {
      excludeCategories: ["preference"],
      contextHint: HINT,
    });
    const ids = new Set(result.map((e) => e.id));
    expect(ids.has(`d:${distId}`)).toBe(false);
    expect(ids.has(`t:${tempId}`)).toBe(false);
    // The fold is the ONLY thing that surfaces them — knowledge still present.
    expect(ids.has(knowledgeId)).toBe(true);
  });

  test("cache-stable: stickyIds keeps a folded synthetic selected when a knowledge entry would otherwise displace it", async () => {
    // Budget fits exactly ONE non-arch entry, so a distillation synthetic
    // (d:distId) and a knowledge entry (k2) compete for that single slot.
    // Turn 2 flips the raw cosine scores so k2 outranks the synthetic — only
    // the stickyIds hysteresis keeps the SAME entry selected (no set change =>
    // no system[2] cache bust). Remove the sticky bonus (STICKY_RELEVANCE_BONUS)
    // and this test goes red — verified by mutation (M4).
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid); // drop arch entry
    const pad = "x".repeat(300);
    db()
      .query("UPDATE distillations SET observations = ? WHERE id = ?")
      .run(`distillation body ${pad}`, distId);
    const k2 = ltm.create({
      projectPath: PROJ,
      category: "gotcha",
      title: "K2",
      content: `knowledge body ${pad}`,
      scope: "project",
    });
    vi.spyOn(embedding, "vectorSearchTemporal").mockResolvedValue([]);
    const kSpy = vi.spyOn(embedding, "vectorSearch");
    const dSpy = vi.spyOn(embedding, "vectorSearchDistillations");
    const BUDGET = 180; // fits header(15) + exactly one ~118-token entry
    const base = {
      excludeCategories: ["preference"] as string[],
      contextHint: HINT,
      includeContextSources: ["distillation"] as ltm.ContextSource[],
    };

    // Turn 1: synthetic (0.60) beats knowledge (0.55) → synthetic selected.
    kSpy.mockResolvedValue([{ id: k2, similarity: 0.55 }]);
    dSpy.mockResolvedValue([{ id: distId, similarity: 0.6 }]);
    const t1 = new Set(
      (await ltm.forSession(PROJ, undefined, BUDGET, base)).map((e) => e.id),
    );
    expect(t1.has(`d:${distId}`)).toBe(true);
    expect(t1.has(k2)).toBe(false);

    // Turn 2: raw scores flip — knowledge (0.62) now outranks synthetic (0.60).
    kSpy.mockResolvedValue([{ id: k2, similarity: 0.62 }]);
    dSpy.mockResolvedValue([{ id: distId, similarity: 0.6 }]);

    // Control (NO stickyIds): knowledge displaces the synthetic — proves the
    // scenario is discriminating (the set genuinely changes without hysteresis).
    const t2free = new Set(
      (await ltm.forSession(PROJ, undefined, BUDGET, base)).map((e) => e.id),
    );
    expect(t2free.has(k2)).toBe(true);
    expect(t2free.has(`d:${distId}`)).toBe(false);

    // WITH stickyIds: synthetic stays (0.60*1.25 > 0.62) → set identical to
    // turn 1 => cache stays warm.
    const t2 = new Set(
      (
        await ltm.forSession(PROJ, undefined, BUDGET, {
          ...base,
          stickyIds: new Set([`d:${distId}`]),
        })
      ).map((e) => e.id),
    );
    expect(t2).toEqual(t1);
  });

  test("SECURITY: distillation hits from OTHER projects are not injected", async () => {
    // vectorSearchDistillations is not project-scoped; a foreign hit must be
    // dropped in hydration (project_id filter) — no cross-project leak.
    const otherPid = ensureProject("/test/ltm/context-sources-OTHER");
    const otherDistId = uuidv7();
    db()
      .query(
        `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, archived, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        otherDistId,
        otherPid,
        "sess-foreign",
        "",
        "",
        "SECRET foreign-project fact hex #deadbeef",
        "[]",
        0,
        20,
        0,
        Date.now(),
      );
    // Foreign hit ranked ABOVE our own — only the project filter should save us.
    vi.spyOn(embedding, "vectorSearchDistillations").mockResolvedValue([
      { id: otherDistId, similarity: 0.99 },
      { id: distId, similarity: 0.9 },
    ]);

    const result = await ltm.forSession(PROJ, undefined, 4000, {
      excludeCategories: ["preference"],
      contextHint: HINT,
      includeContextSources: ["distillation"],
    });
    const ids = new Set(result.map((e) => e.id));
    expect(ids.has(`d:${otherDistId}`)).toBe(false);
    expect(ids.has(`d:${distId}`)).toBe(true);
    expect(result.every((e) => !e.content.includes("deadbeef"))).toBe(true);

    db().query("DELETE FROM distillations WHERE project_id = ?").run(otherPid);
  });

  test("context-source synthetics are excluded from the overflow ToC (guard exercised)", async () => {
    // Budget fits exactly ONE entry so k1 is selected while BOTH a knowledge
    // entry (k2) and the synthetic (d:distId) are scored-but-unpacked. The
    // knowledge entry MUST land in the overflow ToC; the synthetic MUST NOT.
    // Delete the guard (ltm.ts `if (entry.category === RECALLED_CONTEXT_CATEGORY)
    // continue;`) and this test goes red — verified by mutation (M3).
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid); // drop arch entry
    const pad = "x".repeat(300);
    db()
      .query("UPDATE distillations SET observations = ? WHERE id = ?")
      .run(`distillation body ${pad}`, distId);
    const k1 = ltm.create({
      projectPath: PROJ,
      category: "gotcha",
      title: "K1",
      content: `k1 body ${pad}`,
      scope: "project",
    });
    const k2 = ltm.create({
      projectPath: PROJ,
      category: "gotcha",
      title: "K2",
      content: `k2 body ${pad}`,
      scope: "project",
    });
    vi.spyOn(embedding, "vectorSearchTemporal").mockResolvedValue([]);
    vi.spyOn(embedding, "vectorSearch").mockResolvedValue([
      { id: k1, similarity: 0.9 }, // selected
      { id: k2, similarity: 0.7 }, // overflow (knowledge)
    ]);
    vi.spyOn(embedding, "vectorSearchDistillations").mockResolvedValue([
      { id: distId, similarity: 0.6 }, // scored, unpacked, MUST NOT overflow
    ]);

    const overflowSink: ltm.KnowledgeEntry[] = [];
    const result = await ltm.forSession(PROJ, undefined, 180, {
      excludeCategories: ["preference"],
      contextHint: HINT,
      includeContextSources: ["distillation"],
      overflowSink,
    });
    // Sanity: exactly the top-ranked entry is packed.
    expect(new Set(result.map((e) => e.id)).has(k1)).toBe(true);
    const overflowIds = new Set(overflowSink.map((e) => e.id));
    // The knowledge entry lands in the ToC (proves the sink is non-empty here)…
    expect(overflowIds.has(k2)).toBe(true);
    // …but the unpacked synthetic is excluded (the load-bearing guard).
    expect(overflowIds.has(`d:${distId}`)).toBe(false);
    expect(
      overflowSink.every((e) => e.category !== ltm.RECALLED_CONTEXT_CATEGORY),
    ).toBe(true);
  });
});
