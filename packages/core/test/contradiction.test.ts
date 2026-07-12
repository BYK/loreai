import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as data from "../src/data";
import { db, ensureProject } from "../src/db";
import { storeEmbedding } from "../src/db/vec-store";
import * as embedding from "../src/embedding";
import * as ltm from "../src/ltm";
import {
  candidatePairs,
  detectContradictions,
  parseContradictionVerdict,
  type PairItem,
} from "../src/contradiction";
import type { LLMClient } from "../src/types";

function v(...xs: number[]): Float32Array {
  return new Float32Array(xs);
}

/** Create an entry and force a deterministic stored embedding, bypassing ONNX.
 *  settleDocumentEmbeds() drains the fire-and-forget embed from create() first,
 *  so our explicit vector is the final one. */
async function seed(
  projectPath: string,
  title: string,
  content: string,
  vec: Float32Array,
): Promise<string> {
  const id = ltm.create({
    projectPath,
    category: "preference",
    title,
    content,
    scope: "project",
    confidence: 0.9,
  });
  await embedding.settleDocumentEmbeds();
  storeEmbedding(db(), "knowledge", id, vec);
  return id;
}

function stubLLM(response: string | null): {
  llm: LLMClient;
  prompt: ReturnType<typeof vi.fn>;
} {
  const prompt = vi.fn().mockResolvedValue(response);
  return { llm: { prompt }, prompt };
}

beforeEach(() => {
  // Deterministic, ONNX-free embedding for create()'s fire-and-forget embed;
  // seed() overwrites with an explicit vector afterwards.
  vi.spyOn(embedding, "embed").mockResolvedValue([v(0, 0, 1)]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe("candidatePairs", () => {
  it("returns only pairs at/above the threshold, most-similar first", () => {
    const items: PairItem[] = [
      { id: "a", logicalId: "a", vec: v(1, 0, 0) },
      { id: "b", logicalId: "b", vec: v(0.99, 0.01, 0) }, // ~1.0 sim with a
      { id: "c", logicalId: "c", vec: v(0, 1, 0) }, // orthogonal to a/b
    ];
    const pairs = candidatePairs(items, 0.6);
    // a-b are near-identical (kept); a-c and b-c are orthogonal (dropped).
    expect(pairs).toHaveLength(1);
    expect(pairs[0].aIdx).toBe(0);
    expect(pairs[0].bIdx).toBe(1);
    expect(pairs[0].similarity).toBeGreaterThan(0.6);
  });

  it("sorts multiple qualifying pairs by descending similarity", () => {
    const items: PairItem[] = [
      { id: "a", logicalId: "a", vec: v(1, 0) },
      { id: "b", logicalId: "b", vec: v(1, 0) }, // sim 1.0 with a
      { id: "c", logicalId: "c", vec: v(0.8, 0.6) }, // sim 0.8 with a/b
    ];
    const pairs = candidatePairs(items, 0.6);
    expect(pairs.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < pairs.length; i++) {
      expect(pairs[i - 1].similarity).toBeGreaterThanOrEqual(
        pairs[i].similarity,
      );
    }
  });
});

describe("parseContradictionVerdict", () => {
  it("parses a plain JSON verdict", () => {
    expect(
      parseContradictionVerdict('{"contradict": true, "reason": "x"}'),
    ).toEqual({ contradict: true, reason: "x" });
  });
  it("strips ```json fences", () => {
    expect(
      parseContradictionVerdict('```json\n{"contradict": false}\n```'),
    ).toEqual({ contradict: false, reason: null });
  });
  it("returns null for junk / non-JSON / missing field", () => {
    expect(parseContradictionVerdict(null)).toBeNull();
    expect(parseContradictionVerdict("not json")).toBeNull();
    expect(parseContradictionVerdict('{"reason":"no verdict"}')).toBeNull();
  });
});

describe("contradiction store", () => {
  it("canonicalizes pair order and is idempotent", () => {
    const P = "/test/contra/store-canon";
    ensureProject(P);
    expect(
      ltm.recordContradiction({
        logicalIdA: "zzz",
        logicalIdB: "aaa",
        projectId: null,
        similarity: 0.9,
        rationale: "r",
      }),
    ).toBe(true);
    // Same pair, opposite order → no new row.
    expect(
      ltm.recordContradiction({
        logicalIdA: "aaa",
        logicalIdB: "zzz",
        projectId: null,
        similarity: 0.9,
        rationale: "r2",
      }),
    ).toBe(false);
    expect(ltm.contradictionExists("aaa", "zzz")).toBe(true);
    expect(ltm.contradictionExists("zzz", "aaa")).toBe(true);
  });

  it("never re-opens a dismissed pair; dismiss removes it from the open list", async () => {
    const P = "/test/contra/store-dismiss";
    const a = await seed(P, "Always use tabs", "tabs everywhere", v(1, 0, 0));
    const b = await seed(
      P,
      "Always use spaces",
      "spaces everywhere",
      v(1, 0, 0),
    );
    ltm.recordContradiction({
      logicalIdA: a,
      logicalIdB: b,
      projectId: ensureProject(P),
      similarity: 0.99,
      rationale: "tabs vs spaces",
    });
    expect(ltm.listOpenContradictions(P)).toHaveLength(1);

    ltm.setContradictionStatus(a, b, "dismissed");
    expect(ltm.listOpenContradictions(P)).toHaveLength(0);
    // A dismissed pair still "exists" so the detector never re-judges/re-surfaces it.
    expect(ltm.contradictionExists(a, b)).toBe(true);
    // INSERT OR IGNORE must not resurrect it as 'open'.
    ltm.recordContradiction({
      logicalIdA: a,
      logicalIdB: b,
      projectId: ensureProject(P),
      similarity: 0.99,
      rationale: "again",
    });
    expect(ltm.listOpenContradictions(P)).toHaveLength(0);
  });

  it("cleared pairs are recorded but never surfaced", () => {
    ltm.recordContradictionCleared({
      logicalIdA: "c1",
      logicalIdB: "c2",
      projectId: null,
      similarity: 0.7,
    });
    expect(ltm.contradictionExists("c1", "c2")).toBe(true);
    expect(
      ltm
        .listOpenContradictions()
        .some((c) => c.logicalIdA === "c1" || c.logicalIdB === "c1"),
    ).toBe(false);
  });

  it("excludes pairs whose entries no longer exist (stale JOIN guard)", () => {
    // Record a pair referencing logical_ids that were never created.
    ltm.recordContradiction({
      logicalIdA: "ghost-1",
      logicalIdB: "ghost-2",
      projectId: null,
      similarity: 0.9,
      rationale: "stale",
    });
    expect(
      ltm.listOpenContradictions().some((c) => c.logicalIdA === "ghost-1"),
    ).toBe(false);
  });

  it("remove() purges any contradiction pair touching the deleted entry", async () => {
    const P = "/test/contra/store-remove";
    const a = await seed(P, "Deploy from main only", "main branch", v(1, 0, 0));
    const b = await seed(
      P,
      "Deploy from release only",
      "release branch",
      v(1, 0, 0),
    );
    ltm.recordContradiction({
      logicalIdA: a,
      logicalIdB: b,
      projectId: ensureProject(P),
      similarity: 0.95,
      rationale: "branch conflict",
    });
    expect(ltm.contradictionExists(a, b)).toBe(true);

    ltm.remove(a);
    // Row physically purged, not just hidden by the JOIN.
    expect(ltm.contradictionExists(a, b)).toBe(false);
    expect(ltm.listOpenContradictions(P)).toHaveLength(0);
  });

  it("bulk clearKnowledge() purges contradiction rows (no orphans)", async () => {
    const P = "/test/contra/store-clear";
    const a = await seed(P, "X is required", "always x", v(1, 0, 0));
    const b = await seed(P, "X is forbidden", "never x", v(1, 0, 0));
    ltm.recordContradiction({
      logicalIdA: a,
      logicalIdB: b,
      projectId: ensureProject(P),
      similarity: 0.95,
      rationale: "r",
    });
    expect(ltm.contradictionExists(a, b)).toBe(true);

    // Bulk delete goes straight to DELETE FROM knowledge (not through remove()),
    // so it must clean up knowledge_contradictions itself or leave orphans.
    data.clearKnowledge(P);
    expect(ltm.contradictionExists(a, b)).toBe(false);
  });
});

describe("detectContradictions", () => {
  it("records a contradiction when the judge says the pair conflicts", async () => {
    const P = "/test/contra/detect-true";
    await seed(P, "Always use tabs", "tabs for indentation", v(1, 0, 0));
    await seed(P, "Always use spaces", "spaces for indentation", v(1, 0, 0));
    const { llm, prompt } = stubLLM(
      JSON.stringify({ contradict: true, reason: "tabs vs spaces" }),
    );

    const res = await detectContradictions({
      projectPath: P,
      sessionID: "s",
      llm,
    });

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ judged: 1, found: 1 });
    const open = ltm.listOpenContradictions(P);
    expect(open).toHaveLength(1);
    expect([open[0].titleA, open[0].titleB].sort()).toEqual([
      "Always use spaces",
      "Always use tabs",
    ]);
    expect(open[0].rationale).toBe("tabs vs spaces");
  });

  it("records NO contradiction (and clears the pair) when the judge says no conflict", async () => {
    const P = "/test/contra/detect-false";
    const a = await seed(
      P,
      "Add tests after a feature",
      "write tests",
      v(1, 0, 0),
    );
    const b = await seed(P, "Run the linter before commit", "lint", v(1, 0, 0));
    const { llm, prompt } = stubLLM(
      JSON.stringify({ contradict: false, reason: "complementary" }),
    );

    const res = await detectContradictions({
      projectPath: P,
      sessionID: "s",
      llm,
    });

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ judged: 1, found: 0 });
    expect(ltm.listOpenContradictions(P)).toHaveLength(0);
    // The pair was recorded as 'cleared' so it is never judged again.
    expect(ltm.contradictionExists(a, b)).toBe(true);
  });

  it("judges each candidate pair at most once across passes (cost bound)", async () => {
    const P = "/test/contra/detect-once";
    await seed(P, "Never force-push", "no force push", v(1, 0, 0));
    await seed(P, "Always force-push your branch", "force push", v(1, 0, 0));
    const { llm, prompt } = stubLLM(
      JSON.stringify({ contradict: true, reason: "opposed" }),
    );

    const first = await detectContradictions({
      projectPath: P,
      sessionID: "s",
      llm,
    });
    expect(first).toEqual({ judged: 1, found: 1 });

    // Second pass: the pair is already recorded → skipped, no LLM call.
    const second = await detectContradictions({
      projectPath: P,
      sessionID: "s",
      llm,
    });
    expect(second).toEqual({ judged: 0, found: 0 });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(ltm.listOpenContradictions(P)).toHaveLength(1);
  });

  it("does nothing with fewer than two embedded entries", async () => {
    const P = "/test/contra/detect-single";
    await seed(P, "Only rule here", "solo", v(1, 0, 0));
    const { llm, prompt } = stubLLM(
      JSON.stringify({ contradict: true, reason: "x" }),
    );
    const res = await detectContradictions({
      projectPath: P,
      sessionID: "s",
      llm,
    });
    expect(res).toEqual({ judged: 0, found: 0 });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("skips a corrupted embedding blob instead of aborting the whole pass", async () => {
    const P = "/test/contra/corrupt-blob";
    // Two valid, contradicting entries + one whose embedding blob is corrupt.
    await seed(P, "Always cache aggressively", "cache it", v(1, 0, 0));
    await seed(P, "Never cache anything", "no caching", v(1, 0, 0));
    const bad = await seed(P, "Unrelated corrupt entry", "x", v(0, 1, 0));
    // Overwrite the bad entry with a truncated blob (3 bytes) and make fromBlob
    // throw for it, delegating to the real impl for the two valid entries.
    db()
      .query("UPDATE knowledge SET embedding = ? WHERE id = ?")
      .run(Buffer.from([9, 9, 9]), bad);
    const realFromBlob = embedding.fromBlob;
    vi.spyOn(embedding, "fromBlob").mockImplementation((blob) => {
      if ((blob as Buffer).length === 3) throw new Error("corrupt blob");
      return realFromBlob(blob);
    });
    const { llm, prompt } = stubLLM(
      JSON.stringify({ contradict: true, reason: "opposed" }),
    );

    // Must NOT throw; the two valid entries are still judged and the
    // contradiction is still found.
    const res = await detectContradictions({
      projectPath: P,
      sessionID: "s",
      llm,
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ judged: 1, found: 1 });
    expect(ltm.listOpenContradictions(P)).toHaveLength(1);
  });

  it("does not judge topically-unrelated pairs (below the similarity floor)", async () => {
    const P = "/test/contra/detect-unrelated";
    // Orthogonal embeddings → cosine 0 → never a candidate → judge never runs.
    await seed(P, "Rule about auth", "auth stuff", v(1, 0, 0));
    await seed(P, "Rule about styling", "css stuff", v(0, 1, 0));
    const { llm, prompt } = stubLLM(
      JSON.stringify({ contradict: true, reason: "x" }),
    );
    const res = await detectContradictions({
      projectPath: P,
      sessionID: "s",
      llm,
    });
    expect(res).toEqual({ judged: 0, found: 0 });
    expect(prompt).not.toHaveBeenCalled();
  });
});
