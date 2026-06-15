import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { dedupePreferenceCreates } from "../src/curator";
import type { CuratorOp } from "../src/curator";
import { db, ensureProject } from "../src/db";
import * as ltm from "../src/ltm";
import * as embedding from "../src/embedding";

/**
 * The curator re-observes the same behavioral rule each session and re-phrases
 * it, producing paraphrased `preference` creates that ltm.create()'s title-only
 * dedup misses. dedupePreferenceCreates() collapses such near-duplicate creates
 * into updates against the existing entry (embedding similarity at the looser
 * preference threshold), preventing system[1] preference bloat.
 */
describe("curator dedupePreferenceCreates", () => {
  const PROJ = "/test/curator/pref-dedup";
  let availableSpy: ReturnType<typeof vi.spyOn>;
  let embedSpy: ReturnType<typeof vi.spyOn>;
  let vectorSpy: ReturnType<typeof vi.spyOn>;
  let existingId = "";

  beforeEach(() => {
    const pid = ensureProject(PROJ);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
    existingId = ltm.create({
      projectPath: PROJ,
      category: "preference",
      title: "Always document invariants as code comments",
      content: "Document load-bearing invariants inline in source.",
      scope: "project",
    });
    availableSpy = vi.spyOn(embedding, "isAvailable").mockReturnValue(true);
    embedSpy = vi
      .spyOn(embedding, "embed")
      .mockResolvedValue([new Float32Array([1, 0, 0])]);
    // 0.90: a near-duplicate preference — above the 0.88 preference threshold,
    // below the global 0.935.
    vectorSpy = vi
      .spyOn(embedding, "vectorSearch")
      .mockImplementation(() => [{ id: existingId, similarity: 0.9 }]);
  });

  afterEach(() => {
    availableSpy.mockRestore();
    embedSpy.mockRestore();
    vectorSpy.mockRestore();
  });

  test("rewrites a near-duplicate preference create into an update; adopts new content when it is at least as long", async () => {
    const longerContent =
      "Document load-bearing invariants and design rationale inline in the source, with examples.";
    const ops: CuratorOp[] = [
      {
        op: "create",
        category: "preference",
        title: "Always write invariants as inline code comments",
        content: longerContent, // longer than the existing entry's content
        scope: "project",
        confidence: 0.9,
      },
    ];
    const out = await dedupePreferenceCreates(ops, PROJ);
    expect(out).toHaveLength(1);
    expect(out[0].op).toBe("update");
    // The existing entry is refreshed in place — no new entry minted.
    expect(out[0]).toMatchObject({
      op: "update",
      id: existingId,
      content: longerContent,
      confidence: 0.9,
    });
  });

  test("does NOT overwrite richer existing content with a terser paraphrase (refreshes confidence only)", async () => {
    const ops: CuratorOp[] = [
      {
        op: "create",
        category: "preference",
        title: "Always write invariants as inline code comments",
        content: "Terser.", // shorter than the existing entry's content
        scope: "project",
        confidence: 0.95,
      },
    ];
    const out = await dedupePreferenceCreates(ops, PROJ);
    expect(out).toHaveLength(1);
    expect(out[0].op).toBe("update");
    expect(out[0]).toMatchObject({
      op: "update",
      id: existingId,
      confidence: 0.95,
    });
    // content must NOT be present — the richer existing content is preserved.
    expect((out[0] as { content?: string }).content).toBeUndefined();
  });

  test("project-scoped create does NOT mutate a globally-shared preference (falls through as create)", async () => {
    // Replace the project entry with a CROSS-PROJECT (global) match.
    db()
      .query("DELETE FROM knowledge WHERE project_id = ?")
      .run(ensureProject(PROJ));
    const globalId = ltm.create({
      category: "preference",
      title: "Always document invariants as code comments",
      content: "Global preference shared across all projects.",
      scope: "global",
      crossProject: true,
    });
    vectorSpy.mockImplementation(() => [{ id: globalId, similarity: 0.9 }]);
    const ops: CuratorOp[] = [
      {
        op: "create",
        category: "preference",
        title: "Always write invariants as inline code comments",
        content:
          "Project-local phrasing that must not clobber the global entry.",
        scope: "project",
        confidence: 0.9,
      },
    ];
    const out = await dedupePreferenceCreates(ops, PROJ);
    expect(out).toHaveLength(1);
    // Must remain a create — a project create may not overwrite a global entry.
    expect(out[0].op).toBe("create");
    db().query("DELETE FROM knowledge WHERE id = ?").run(globalId);
  });

  test("passes NON-preference creates through unchanged (no dedup applied)", async () => {
    const ops: CuratorOp[] = [
      {
        op: "create",
        category: "architecture",
        title: "Some architecture fact",
        content: "Distinct architectural detail.",
        scope: "project",
      },
    ];
    const out = await dedupePreferenceCreates(ops, PROJ);
    expect(out).toEqual(ops);
  });

  test("passes a preference create through when there is no semantic duplicate", async () => {
    vectorSpy.mockImplementation(() => []); // no neighbors
    const ops: CuratorOp[] = [
      {
        op: "create",
        category: "preference",
        title: "A genuinely new preference",
        content: "Unrelated rule.",
        scope: "project",
        confidence: 0.8,
      },
    ];
    const out = await dedupePreferenceCreates(ops, PROJ);
    expect(out).toHaveLength(1);
    expect(out[0].op).toBe("create");
  });

  test("two paraphrases in the SAME batch don't both redirect onto one entry", async () => {
    // Only the first should collapse; the second falls through as a create so
    // it doesn't clobber the first's update content.
    const ops: CuratorOp[] = [
      {
        op: "create",
        category: "preference",
        title: "Paraphrase one of the rule",
        content: "First paraphrase.",
        scope: "project",
        confidence: 0.9,
      },
      {
        op: "create",
        category: "preference",
        title: "Paraphrase two of the rule",
        content: "Second paraphrase.",
        scope: "project",
        confidence: 0.9,
      },
    ];
    const out = await dedupePreferenceCreates(ops, PROJ);
    expect(out).toHaveLength(2);
    expect(out[0].op).toBe("update");
    expect(out[1].op).toBe("create");
  });

  test("no-ops when embeddings are unavailable", async () => {
    availableSpy.mockReturnValue(false);
    const ops: CuratorOp[] = [
      {
        op: "create",
        category: "preference",
        title: "Always write invariants as inline code comments",
        content: "Same rule, no embeddings available.",
        scope: "project",
        confidence: 0.9,
      },
    ];
    const out = await dedupePreferenceCreates(ops, PROJ);
    expect(out).toEqual(ops);
  });
});
